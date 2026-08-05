import { env } from "cloudflare:workers";

export const dynamic = "force-dynamic";

type Role = "admin" | "viewer";
type DocumentType = "inbound" | "outbound" | "stocktake";

type CurrentUser = {
  id: string;
  email: string;
  display_name: string;
  role: Role;
};

type ProductRow = {
  id: string;
  code: string;
  name: string;
  unit: string;
  status: string;
  min_stock: number;
  current_stock: number;
  average_cost_cents?: number;
  default_supplier_id: string | null;
  default_supplier_name?: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

type StoredDocument = {
  id: string;
  document_no: string;
  type: DocumentType;
  purpose: string;
  supplier_id: string | null;
  supplier_name?: string | null;
  external_ref: string;
  status: "active" | "voided" | "replaced";
  revision_of: string | null;
  operator_user_id: string;
  operator_name?: string | null;
  effective_at: string;
  created_at: string;
  updated_at: string;
};

type StoredItem = {
  id: string;
  document_id: string;
  product_id: string;
  product_code?: string;
  product_name?: string;
  product_unit?: string;
  quantity: number;
  counted_quantity: number | null;
  unit_price_cents?: number;
  unit_cost_cents?: number;
  before_quantity: number;
  after_quantity: number;
};

type IncomingItem = {
  productId?: string;
  quantity?: number;
  unitPrice?: number;
  countedQuantity?: number;
};

type ReplayDocument = StoredDocument & { items: StoredItem[] };

function getDatabase() {
  if (!env.DB) throw new Error("库存数据库暂不可用，请稍后重试。");
  return env.DB;
}

function jsonError(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value: unknown, max = 120) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function cents(value: unknown) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return -1;
  return Math.round(amount * 100);
}

function positiveInteger(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : -1;
}

function nonNegativeInteger(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : -1;
}

function decodeDisplayName(request: Request, fallback: string) {
  const value = request.headers.get("oai-authenticated-user-full-name");
  const encoding = request.headers.get("oai-authenticated-user-full-name-encoding");
  if (!value || encoding !== "percent-encoded-utf-8") return fallback;
  try {
    return decodeURIComponent(value).slice(0, 80);
  } catch {
    return fallback;
  }
}

async function ensureCurrentUser(request: Request): Promise<CurrentUser> {
  const db = getDatabase();
  const userId = request.headers.get("oai-authenticated-user-id") || "local-admin";
  const email = request.headers.get("oai-authenticated-user-email") || "admin@local.test";
  const fallbackName = email.split("@")[0] || "仓库用户";
  const displayName = decodeDisplayName(request, fallbackName);
  const existing = await db
    .prepare("SELECT id, email, display_name, role FROM users WHERE id = ?")
    .bind(userId)
    .first<CurrentUser>();

  if (!existing) {
    const count = await db.prepare("SELECT COUNT(*) AS total FROM users").first<{ total: number }>();
    const role: Role = userId === "local-admin" || Number(count?.total ?? 0) === 0 ? "admin" : "viewer";
    await db
      .prepare(
        "INSERT OR IGNORE INTO users (id, email, display_name, role, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(userId, email, displayName, role, nowIso(), nowIso())
      .run();
  } else {
    await db
      .prepare("UPDATE users SET email = ?, display_name = ?, last_seen_at = ? WHERE id = ?")
      .bind(email, displayName, nowIso(), userId)
      .run();
  }

  const user = await db
    .prepare("SELECT id, email, display_name, role FROM users WHERE id = ?")
    .bind(userId)
    .first<CurrentUser>();
  if (!user) throw new Error("无法识别当前账号。");
  return user;
}

function requireAdmin(user: CurrentUser) {
  if (user.role !== "admin") throw new Error("当前账号是查看者，不能执行此操作。");
}

async function resolveSupplier(name: string) {
  if (!name) return null;
  const db = getDatabase();
  const id = crypto.randomUUID();
  await db.prepare("INSERT OR IGNORE INTO suppliers (id, name) VALUES (?, ?)").bind(id, name).run();
  const row = await db
    .prepare("SELECT id FROM suppliers WHERE name = ?")
    .bind(name)
    .first<{ id: string }>();
  return row?.id ?? null;
}

async function nextProductCode() {
  const db = getDatabase();
  const row = await db
    .prepare("SELECT code FROM products WHERE code GLOB 'SKU-[0-9]*' ORDER BY code DESC LIMIT 1")
    .first<{ code: string }>();
  const current = row?.code ? Number(row.code.replace("SKU-", "")) || 0 : 0;
  return `SKU-${String(current + 1).padStart(6, "0")}`;
}

function documentNumber(type: DocumentType) {
  const prefix = type === "inbound" ? "RK" : type === "outbound" ? "CK" : "PD";
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase();
  return `${prefix}-${date}-${suffix}`;
}

async function loadReplayDocuments(excludeId?: string) {
  const db = getDatabase();
  const documentsResult = await db
    .prepare(
      "SELECT * FROM documents WHERE status = 'active' ORDER BY effective_at ASC, created_at ASC, id ASC",
    )
    .all<StoredDocument>();
  const itemsResult = await db.prepare("SELECT * FROM document_items").all<StoredItem>();
  const itemsByDocument = new Map<string, StoredItem[]>();
  for (const item of itemsResult.results) {
    const list = itemsByDocument.get(item.document_id) ?? [];
    list.push(item);
    itemsByDocument.set(item.document_id, list);
  }
  return documentsResult.results
    .filter((document) => document.id !== excludeId)
    .map((document) => ({ ...document, items: itemsByDocument.get(document.id) ?? [] }));
}

function replayInventory(documents: ReplayDocument[], products: ProductRow[]) {
  const states = new Map(products.map((product) => [product.id, { quantity: 0, averageCost: 0 }]));
  const itemUpdates: Array<{
    id: string;
    quantity: number;
    unitCost: number;
    before: number;
    after: number;
  }> = [];

  const ordered = [...documents].sort(
    (a, b) =>
      a.effective_at.localeCompare(b.effective_at) ||
      a.created_at.localeCompare(b.created_at) ||
      a.id.localeCompare(b.id),
  );

  for (const document of ordered) {
    for (const item of document.items) {
      const product = products.find((entry) => entry.id === item.product_id);
      if (!product) throw new Error("单据中包含不存在的商品，无法重新计算库存。");
      const state = states.get(item.product_id)!;
      const before = state.quantity;

      if (document.type === "inbound") {
        const unitPrice = item.unit_price_cents ?? 0;
        const after = before + item.quantity;
        const totalValue = before * state.averageCost + item.quantity * unitPrice;
        state.quantity = after;
        state.averageCost = after > 0 ? Math.round(totalValue / after) : 0;
        itemUpdates.push({ id: item.id, quantity: item.quantity, unitCost: unitPrice, before, after });
      } else if (document.type === "outbound") {
        if (item.quantity > before) {
          throw new Error(
            `${product.name}库存只有 ${before}${product.unit}，最大可出库 ${before}${product.unit}。`,
          );
        }
        const after = before - item.quantity;
        itemUpdates.push({
          id: item.id,
          quantity: item.quantity,
          unitCost: state.averageCost,
          before,
          after,
        });
        state.quantity = after;
        if (after === 0) state.averageCost = 0;
      } else {
        const counted = item.counted_quantity ?? 0;
        if (counted < 0) throw new Error(`${product.name}的盘点数量不能小于 0。`);
        const difference = counted - before;
        itemUpdates.push({
          id: item.id,
          quantity: difference,
          unitCost: state.averageCost,
          before,
          after: counted,
        });
        state.quantity = counted;
      }
    }
  }

  return { states, itemUpdates };
}

async function nextInventoryRevision() {
  const row = await getDatabase()
    .prepare("SELECT COALESCE(MAX(revision), 0) AS revision FROM inventory_revisions")
    .first<{ revision: number }>();
  return Number(row?.revision ?? 0) + 1;
}

async function listBootstrap(user: CurrentUser) {
  const db = getDatabase();
  const [productResult, supplierResult, documentResult, itemResult, userResult, auditResult] =
    await Promise.all([
      db
        .prepare(
          `SELECT p.*, s.name AS default_supplier_name
           FROM products p LEFT JOIN suppliers s ON s.id = p.default_supplier_id
           WHERE p.archived_at IS NULL ORDER BY p.name ASC`,
        )
        .all<ProductRow>(),
      db.prepare("SELECT id, name, created_at FROM suppliers ORDER BY name ASC").all(),
      db
        .prepare(
          `SELECT d.*, s.name AS supplier_name, u.display_name AS operator_name
           FROM documents d
           LEFT JOIN suppliers s ON s.id = d.supplier_id
           LEFT JOIN users u ON u.id = d.operator_user_id
           ORDER BY d.effective_at DESC, d.created_at DESC LIMIT 500`,
        )
        .all<StoredDocument>(),
      db
        .prepare(
          `SELECT i.*, p.code AS product_code, p.name AS product_name, p.unit AS product_unit
           FROM document_items i JOIN products p ON p.id = i.product_id`,
        )
        .all<StoredItem>(),
      user.role === "admin"
        ? db.prepare("SELECT id, email, display_name, role, created_at, last_seen_at FROM users ORDER BY created_at ASC").all()
        : Promise.resolve({ results: [] }),
      user.role === "admin"
        ? db.prepare("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100").all()
        : Promise.resolve({ results: [] }),
    ]);

  const itemsByDocument = new Map<string, StoredItem[]>();
  for (const item of itemResult.results) {
    const safeItem = { ...item };
    if (user.role === "viewer") {
      delete safeItem.unit_price_cents;
      delete safeItem.unit_cost_cents;
    }
    const list = itemsByDocument.get(item.document_id) ?? [];
    list.push(safeItem as StoredItem);
    itemsByDocument.set(item.document_id, list);
  }

  const products = productResult.results.map((product) => {
    if (user.role === "admin") return product;
    const safe = { ...product };
    delete safe.average_cost_cents;
    return safe;
  });

  return {
    currentUser: user,
    products,
    suppliers: supplierResult.results,
    documents: documentResult.results.map((document) => ({
      ...document,
      items: itemsByDocument.get(document.id) ?? [],
    })),
    users: userResult.results,
    auditLogs: auditResult.results,
    backupPolicy: { intervalDays: 7, retentionDays: 30, location: "local-folder" },
  };
}

async function createOrReplaceDocument(
  user: CurrentUser,
  payload: Record<string, unknown>,
) {
  requireAdmin(user);
  const db = getDatabase();
  const type = payload.type as DocumentType;
  if (!(["inbound", "outbound"] as string[]).includes(type)) {
    throw new Error("不支持的单据类型。");
  }

  const rawItems = Array.isArray(payload.items) ? (payload.items as IncomingItem[]) : [];
  if (!rawItems.length) throw new Error("请至少添加一种商品。");
  const seen = new Set<string>();
  const items: StoredItem[] = [];
  for (const raw of rawItems) {
    const productId = cleanText(raw.productId, 80);
    const quantity = positiveInteger(raw.quantity);
    const unitPrice = type === "inbound" ? cents(raw.unitPrice) : 0;
    if (!productId || quantity < 1) throw new Error("商品和数量填写不完整。");
    if (type === "inbound" && unitPrice < 0) throw new Error("入库单价不能小于 0。");
    if (seen.has(productId)) throw new Error("同一张单据中不能重复添加同一种商品。");
    seen.add(productId);
    items.push({
      id: crypto.randomUUID(),
      document_id: "",
      product_id: productId,
      quantity,
      counted_quantity: null,
      unit_price_cents: unitPrice,
      unit_cost_cents: 0,
      before_quantity: 0,
      after_quantity: 0,
    });
  }

  const productsResult = await db.prepare("SELECT * FROM products WHERE archived_at IS NULL").all<ProductRow>();
  for (const item of items) {
    if (!productsResult.results.some((product) => product.id === item.product_id)) {
      throw new Error("选择的商品已不存在，请刷新后重试。");
    }
  }

  const revisionOf = cleanText(payload.revisionOf, 80) || null;
  let original: StoredDocument | null = null;
  if (revisionOf) {
    original = await db
      .prepare("SELECT * FROM documents WHERE id = ?")
      .bind(revisionOf)
      .first<StoredDocument>();
    if (!original || original.status !== "active") throw new Error("原单据已经修改或撤销，不能再次修改。");
    if (original.type !== type) throw new Error("修改时不能改变入库或出库类型。");
  }

  const supplierName = cleanText(payload.supplierName, 100);
  const supplierId = type === "inbound" ? await resolveSupplier(supplierName) : null;
  const timestamp = nowIso();
  const document: ReplayDocument = {
    id: crypto.randomUUID(),
    document_no: documentNumber(type),
    type,
    purpose: cleanText(payload.purpose, 160),
    supplier_id: supplierId,
    external_ref: cleanText(payload.externalRef, 100),
    status: "active",
    revision_of: revisionOf,
    operator_user_id: user.id,
    effective_at: original?.effective_at ?? timestamp,
    created_at: timestamp,
    updated_at: timestamp,
    items,
  };
  for (const item of items) item.document_id = document.id;

  const replayDocuments = await loadReplayDocuments(revisionOf ?? undefined);
  replayDocuments.push(document);
  const replay = replayInventory(replayDocuments, productsResult.results);
  const revision = await nextInventoryRevision();
  const statements = [
    db
      .prepare("INSERT INTO inventory_revisions (revision, created_at) VALUES (?, ?)")
      .bind(revision, timestamp),
  ];
  if (original) {
    statements.push(
      db
        .prepare("UPDATE documents SET status = 'replaced', updated_at = ? WHERE id = ? AND status = 'active'")
        .bind(timestamp, original.id),
    );
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO documents
         (id, document_no, type, purpose, supplier_id, external_ref, status, revision_of, operator_user_id, effective_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
      )
      .bind(
        document.id,
        document.document_no,
        type,
        document.purpose,
        supplierId,
        document.external_ref,
        revisionOf,
        user.id,
        document.effective_at,
        timestamp,
        timestamp,
      ),
  );
  for (const item of items) {
    statements.push(
      db
        .prepare(
          `INSERT INTO document_items
           (id, document_id, product_id, quantity, counted_quantity, unit_price_cents, unit_cost_cents, before_quantity, after_quantity)
           VALUES (?, ?, ?, ?, NULL, ?, 0, 0, 0)`,
        )
        .bind(item.id, document.id, item.product_id, item.quantity, item.unit_price_cents ?? 0),
    );
  }
  for (const product of productsResult.results) {
    const state = replay.states.get(product.id)!;
    statements.push(
      db
        .prepare(
          "UPDATE products SET current_stock = ?, average_cost_cents = ?, updated_at = ? WHERE id = ?",
        )
        .bind(state.quantity, state.averageCost, timestamp, product.id),
    );
  }
  for (const update of replay.itemUpdates) {
    statements.push(
      db
        .prepare(
          "UPDATE document_items SET quantity = ?, unit_cost_cents = ?, before_quantity = ?, after_quantity = ? WHERE id = ?",
        )
        .bind(update.quantity, update.unitCost, update.before, update.after, update.id),
    );
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO audit_logs
         (id, entity_type, entity_id, action, before_json, after_json, operator_user_id, created_at)
         VALUES (?, 'document', ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        document.id,
        original ? "replace" : "create",
        original ? JSON.stringify(original) : "",
        JSON.stringify({ ...document, items }),
        user.id,
        timestamp,
      ),
  );
  try {
    await db.batch(statements);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("UNIQUE") || message.includes("constraint")) {
      throw new Error("库存刚刚被其他人更新，请刷新后重新提交。");
    }
    throw error;
  }
  return { documentNo: document.document_no };
}

async function createStocktake(user: CurrentUser, payload: Record<string, unknown>) {
  requireAdmin(user);
  const db = getDatabase();
  const rawItems = Array.isArray(payload.items) ? (payload.items as IncomingItem[]) : [];
  if (!rawItems.length) throw new Error("请至少填写一种商品的实盘数量。");
  const items: StoredItem[] = [];
  const seen = new Set<string>();
  for (const raw of rawItems) {
    const productId = cleanText(raw.productId, 80);
    const countedQuantity = nonNegativeInteger(raw.countedQuantity);
    if (!productId || countedQuantity < 0) throw new Error("实盘数量必须是大于或等于 0 的整数。");
    if (seen.has(productId)) throw new Error("盘点单中不能重复添加同一种商品。");
    seen.add(productId);
    items.push({
      id: crypto.randomUUID(),
      document_id: "",
      product_id: productId,
      quantity: 0,
      counted_quantity: countedQuantity,
      unit_price_cents: 0,
      unit_cost_cents: 0,
      before_quantity: 0,
      after_quantity: 0,
    });
  }

  const productsResult = await db.prepare("SELECT * FROM products WHERE archived_at IS NULL").all<ProductRow>();
  const timestamp = nowIso();
  const document: ReplayDocument = {
    id: crypto.randomUUID(),
    document_no: documentNumber("stocktake"),
    type: "stocktake",
    purpose: cleanText(payload.purpose, 160) || "库存盘点",
    supplier_id: null,
    external_ref: "",
    status: "active",
    revision_of: null,
    operator_user_id: user.id,
    effective_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp,
    items,
  };
  for (const item of items) item.document_id = document.id;
  const replayDocuments = await loadReplayDocuments();
  replayDocuments.push(document);
  const replay = replayInventory(replayDocuments, productsResult.results);
  const revision = await nextInventoryRevision();
  const statements = [
    db.prepare("INSERT INTO inventory_revisions (revision, created_at) VALUES (?, ?)").bind(revision, timestamp),
    db
      .prepare(
        `INSERT INTO documents
         (id, document_no, type, purpose, supplier_id, external_ref, status, revision_of, operator_user_id, effective_at, created_at, updated_at)
         VALUES (?, ?, 'stocktake', ?, NULL, '', 'active', NULL, ?, ?, ?, ?)`,
      )
      .bind(document.id, document.document_no, document.purpose, user.id, timestamp, timestamp, timestamp),
  ];
  for (const item of items) {
    statements.push(
      db
        .prepare(
          `INSERT INTO document_items
           (id, document_id, product_id, quantity, counted_quantity, unit_price_cents, unit_cost_cents, before_quantity, after_quantity)
           VALUES (?, ?, ?, 0, ?, 0, 0, 0, 0)`,
        )
        .bind(item.id, document.id, item.product_id, item.counted_quantity),
    );
  }
  for (const product of productsResult.results) {
    const state = replay.states.get(product.id)!;
    statements.push(
      db
        .prepare("UPDATE products SET current_stock = ?, average_cost_cents = ?, updated_at = ? WHERE id = ?")
        .bind(state.quantity, state.averageCost, timestamp, product.id),
    );
  }
  for (const update of replay.itemUpdates) {
    statements.push(
      db
        .prepare(
          "UPDATE document_items SET quantity = ?, unit_cost_cents = ?, before_quantity = ?, after_quantity = ? WHERE id = ?",
        )
        .bind(update.quantity, update.unitCost, update.before, update.after, update.id),
    );
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO audit_logs
         (id, entity_type, entity_id, action, before_json, after_json, operator_user_id, created_at)
         VALUES (?, 'document', ?, 'stocktake', '', ?, ?, ?)`,
      )
      .bind(crypto.randomUUID(), document.id, JSON.stringify(document), user.id, timestamp),
  );
  await db.batch(statements);
  return { documentNo: document.document_no };
}

async function voidDocument(user: CurrentUser, documentId: string) {
  requireAdmin(user);
  const db = getDatabase();
  const original = await db
    .prepare("SELECT * FROM documents WHERE id = ?")
    .bind(documentId)
    .first<StoredDocument>();
  if (!original || original.status !== "active") throw new Error("该单据已经修改或撤销。");
  const productsResult = await db.prepare("SELECT * FROM products WHERE archived_at IS NULL").all<ProductRow>();
  const replayDocuments = await loadReplayDocuments(documentId);
  const replay = replayInventory(replayDocuments, productsResult.results);
  const timestamp = nowIso();
  const revision = await nextInventoryRevision();
  const statements = [
    db.prepare("INSERT INTO inventory_revisions (revision, created_at) VALUES (?, ?)").bind(revision, timestamp),
    db
      .prepare("UPDATE documents SET status = 'voided', updated_at = ? WHERE id = ? AND status = 'active'")
      .bind(timestamp, documentId),
  ];
  for (const product of productsResult.results) {
    const state = replay.states.get(product.id)!;
    statements.push(
      db
        .prepare("UPDATE products SET current_stock = ?, average_cost_cents = ?, updated_at = ? WHERE id = ?")
        .bind(state.quantity, state.averageCost, timestamp, product.id),
    );
  }
  for (const update of replay.itemUpdates) {
    statements.push(
      db
        .prepare(
          "UPDATE document_items SET quantity = ?, unit_cost_cents = ?, before_quantity = ?, after_quantity = ? WHERE id = ?",
        )
        .bind(update.quantity, update.unitCost, update.before, update.after, update.id),
    );
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO audit_logs
         (id, entity_type, entity_id, action, before_json, after_json, operator_user_id, created_at)
         VALUES (?, 'document', ?, 'void', ?, '', ?, ?)`,
      )
      .bind(crypto.randomUUID(), documentId, JSON.stringify(original), user.id, timestamp),
  );
  await db.batch(statements);
  return { ok: true };
}

async function addProduct(user: CurrentUser, payload: Record<string, unknown>) {
  requireAdmin(user);
  const db = getDatabase();
  const name = cleanText(payload.name, 100);
  if (!name) throw new Error("请填写商品名称。");
  const manualCode = cleanText(payload.code, 40).toUpperCase();
  const code = manualCode || (await nextProductCode());
  const unit = cleanText(payload.unit, 16) || "件";
  const minStock = nonNegativeInteger(payload.minStock);
  if (minStock < 0) throw new Error("最低库存必须是大于或等于 0 的整数。");
  const defaultSupplierName = cleanText(payload.defaultSupplierName, 100);
  const defaultSupplierId = await resolveSupplier(defaultSupplierName);
  const alternateNames = Array.isArray(payload.alternateSuppliers)
    ? (payload.alternateSuppliers as unknown[]).map((value) => cleanText(value, 100)).filter(Boolean)
    : [];
  const id = crypto.randomUUID();
  const timestamp = nowIso();
  const statements = [
    db
      .prepare(
        `INSERT INTO products
         (id, code, code_source, name, unit, status, min_stock, current_stock, average_cost_cents, default_supplier_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
      )
      .bind(
        id,
        code,
        manualCode ? "manual" : "auto",
        name,
        unit,
        cleanText(payload.status, 40) || "normal",
        minStock,
        defaultSupplierId,
        timestamp,
        timestamp,
      ),
  ];
  if (defaultSupplierId) {
    statements.push(
      db
        .prepare("INSERT OR IGNORE INTO product_suppliers (product_id, supplier_id, is_default) VALUES (?, ?, 1)")
        .bind(id, defaultSupplierId),
    );
  }
  for (const supplierName of alternateNames) {
    const supplierId = await resolveSupplier(supplierName);
    if (supplierId) {
      statements.push(
        db
          .prepare("INSERT OR IGNORE INTO product_suppliers (product_id, supplier_id, is_default) VALUES (?, ?, 0)")
          .bind(id, supplierId),
      );
    }
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO audit_logs
         (id, entity_type, entity_id, action, before_json, after_json, operator_user_id, created_at)
         VALUES (?, 'product', ?, 'create', '', ?, ?, ?)`,
      )
      .bind(crypto.randomUUID(), id, JSON.stringify({ code, name, unit, minStock }), user.id, timestamp),
  );
  try {
    await db.batch(statements);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("UNIQUE")) throw new Error(`商品编号 ${code} 已存在，请更换编号。`);
    throw error;
  }
  return { code };
}

async function updateProduct(user: CurrentUser, payload: Record<string, unknown>) {
  requireAdmin(user);
  const db = getDatabase();
  const id = cleanText(payload.id, 80);
  const before = await db.prepare("SELECT * FROM products WHERE id = ?").bind(id).first<ProductRow>();
  if (!before) throw new Error("商品不存在。");
  const status = cleanText(payload.status, 40) || before.status;
  const minStock = nonNegativeInteger(payload.minStock);
  if (minStock < 0) throw new Error("最低库存必须是大于或等于 0 的整数。");
  const supplierName = cleanText(payload.defaultSupplierName, 100);
  const supplierId = supplierName ? await resolveSupplier(supplierName) : before.default_supplier_id;
  const timestamp = nowIso();
  const after = { ...before, status, min_stock: minStock, default_supplier_id: supplierId };
  await db.batch([
    db
      .prepare("UPDATE products SET status = ?, min_stock = ?, default_supplier_id = ?, updated_at = ? WHERE id = ?")
      .bind(status, minStock, supplierId, timestamp, id),
    db
      .prepare(
        `INSERT INTO audit_logs
         (id, entity_type, entity_id, action, before_json, after_json, operator_user_id, created_at)
         VALUES (?, 'product', ?, 'update', ?, ?, ?, ?)`,
      )
      .bind(crypto.randomUUID(), id, JSON.stringify(before), JSON.stringify(after), user.id, timestamp),
  ]);
  return { ok: true };
}

async function setRole(user: CurrentUser, payload: Record<string, unknown>) {
  requireAdmin(user);
  const db = getDatabase();
  const targetId = cleanText(payload.userId, 100);
  const role = payload.role === "admin" ? "admin" : "viewer";
  const target = await db
    .prepare("SELECT id, email, display_name, role FROM users WHERE id = ?")
    .bind(targetId)
    .first<CurrentUser>();
  if (!target) throw new Error("用户不存在。");
  if (target.role === "admin" && role === "viewer") {
    const count = await db
      .prepare("SELECT COUNT(*) AS total FROM users WHERE role = 'admin'")
      .first<{ total: number }>();
    if (Number(count?.total ?? 0) <= 1) throw new Error("系统必须至少保留一名管理员。");
  }
  const timestamp = nowIso();
  await db.batch([
    db.prepare("UPDATE users SET role = ? WHERE id = ?").bind(role, targetId),
    db
      .prepare(
        `INSERT INTO audit_logs
         (id, entity_type, entity_id, action, before_json, after_json, operator_user_id, created_at)
         VALUES (?, 'user', ?, 'role-change', ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        targetId,
        JSON.stringify({ role: target.role }),
        JSON.stringify({ role }),
        user.id,
        timestamp,
      ),
  ]);
  return { ok: true };
}

async function createBackup(user: CurrentUser) {
  requireAdmin(user);
  const db = getDatabase();
  const tableNames = [
    "suppliers",
    "products",
    "product_suppliers",
    "documents",
    "document_items",
    "audit_logs",
    "system_settings",
  ];
  const data: Record<string, unknown[]> = {};
  for (const table of tableNames) {
    const result = await db.prepare(`SELECT * FROM ${table}`).all();
    data[table] = result.results;
  }
  return {
    format: "warehouse-backup",
    version: 1,
    createdAt: nowIso(),
    createdBy: user.email,
    data,
  };
}

function bindInsert(table: string, row: Record<string, unknown>) {
  const keys = Object.keys(row);
  if (!keys.length) throw new Error("备份记录格式错误。");
  const placeholders = keys.map(() => "?").join(", ");
  return getDatabase()
    .prepare(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${placeholders})`)
    .bind(...keys.map((key) => row[key] ?? null));
}

async function restoreBackup(user: CurrentUser, payload: Record<string, unknown>) {
  requireAdmin(user);
  if (payload.confirm !== "RESTORE") throw new Error("恢复确认信息不正确。");
  const backup = payload.backup as { format?: string; version?: number; data?: Record<string, unknown[]> };
  if (!backup || backup.format !== "warehouse-backup" || backup.version !== 1 || !backup.data) {
    throw new Error("这不是有效的仓库备份文件。");
  }
  const tableOrder = ["suppliers", "products", "product_suppliers", "documents", "document_items", "audit_logs", "system_settings"];
  const total = tableOrder.reduce(
    (sum, table) => sum + (Array.isArray(backup.data?.[table]) ? backup.data![table].length : 0),
    0,
  );
  if (total > 5000) throw new Error("备份记录超过 5000 条，请使用服务器维护工具恢复。");
  const db = getDatabase();
  const statements = [
    db.prepare("DELETE FROM document_items"),
    db.prepare("DELETE FROM documents"),
    db.prepare("DELETE FROM product_suppliers"),
    db.prepare("DELETE FROM products"),
    db.prepare("DELETE FROM suppliers"),
    db.prepare("DELETE FROM audit_logs"),
    db.prepare("DELETE FROM system_settings"),
  ];
  for (const table of tableOrder) {
    const rows = backup.data[table];
    if (!Array.isArray(rows)) throw new Error(`备份缺少 ${table} 数据。`);
    for (const row of rows) statements.push(bindInsert(table, row as Record<string, unknown>));
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO audit_logs
         (id, entity_type, entity_id, action, before_json, after_json, operator_user_id, created_at)
         VALUES (?, 'system', 'backup', 'restore', '', ?, ?, ?)`,
      )
      .bind(crypto.randomUUID(), JSON.stringify({ records: total }), user.id, nowIso()),
  );
  await db.batch(statements);
  return { restored: total };
}

export async function GET(request: Request) {
  try {
    const user = await ensureCurrentUser(request);
    const url = new URL(request.url);
    if (url.searchParams.get("view") === "backup") {
      return Response.json(await createBackup(user));
    }
    return Response.json(await listBootstrap(user));
  } catch (error) {
    const message = error instanceof Error ? error.message : "读取数据失败。";
    return jsonError(message, 500);
  }
}

export async function POST(request: Request) {
  try {
    const user = await ensureCurrentUser(request);
    const payload = (await request.json()) as Record<string, unknown>;
    const action = cleanText(payload.action, 40);
    let result: unknown;
    if (action === "add-product") result = await addProduct(user, payload);
    else if (action === "update-product") result = await updateProduct(user, payload);
    else if (action === "create-document") result = await createOrReplaceDocument(user, payload);
    else if (action === "stocktake") result = await createStocktake(user, payload);
    else if (action === "void-document") {
      result = await voidDocument(user, cleanText(payload.documentId, 80));
    } else if (action === "set-role") result = await setRole(user, payload);
    else if (action === "restore-backup") result = await restoreBackup(user, payload);
    else return jsonError("不支持的操作。", 404);
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "提交失败。";
    const status = message.includes("查看者") ? 403 : 400;
    return jsonError(message, status);
  }
}
