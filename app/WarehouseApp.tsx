"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CloudbaseLogin } from "./CloudbaseLogin";
import { cloudbaseApi, loadCloudbaseWarehouse, signOutOfCloudbase } from "./cloudbase-client";

type Role = "admin" | "viewer" | "guest" | "pending";
type Page =
  | "home"
  | "search"
  | "product-history"
  | "inbound"
  | "outbound"
  | "inventory"
  | "stocktake"
  | "reports"
  | "replenishment"
  | "records"
  | "products"
  | "recipes"
  | "settings"
  | "users"
  | "backup";

type Product = {
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
};

type Supplier = { id: string; name: string };
type DocumentItem = {
  id: string;
  product_id: string;
  product_code: string;
  product_name: string;
  product_unit: string;
  quantity: number;
  counted_quantity: number | null;
  unit_price_cents?: number;
  unit_cost_cents?: number;
  remark?: string;
  before_quantity: number;
  after_quantity: number;
};
type WarehouseDocument = {
  id: string;
  document_no: string;
  type: "inbound" | "outbound" | "stocktake";
  purpose: string;
  supplier_id: string | null;
  supplier_name?: string | null;
  external_ref: string;
  customer?: string;
  contact?: string;
  remark?: string;
  status: "active" | "voided" | "replaced";
  revision_of: string | null;
  operator_name?: string | null;
  effective_at: string;
  created_at: string;
  items: DocumentItem[];
};
type WarehouseUser = {
  id: string;
  email: string;
  display_name: string;
  role: Role;
  last_seen_at?: string;
};
type AuditLog = {
  id: string;
  entity_type: string;
  action: string;
  created_at: string;
  operator_user_id: string;
};
type AppData = {
  guest?: boolean;
  pendingApproval?: boolean;
  currentUser: WarehouseUser;
  products: Product[];
  suppliers: Supplier[];
  documents: WarehouseDocument[];
  users: WarehouseUser[];
  auditLogs: AuditLog[];
  statusDefinitions: StatusDefinition[];
  recipes: Recipe[];
  preferences?: WarehousePreferences;
};

type CostMethod = "weighted" | "fifo" | "lastInbound";
type WarehousePreferences = { productCodePrefix: string; outboundCostMethod: CostMethod };
const DEFAULT_PREFERENCES: WarehousePreferences = { productCodePrefix: "ZERO", outboundCostMethod: "weighted" };

type StatusDefinition = { id: string; label: string; color: string; system?: boolean };
type RecipeComponent = { productId: string; quantity: number; shelfLocation: string; supplier: string; remark: string };
type Recipe = { id: string; name: string; components: RecipeComponent[]; createdAt: string; updatedAt: string };

type FormLine = { key: string; productId: string; quantity: string; unitPrice: string; remark: string };
type GuestDocumentPayload = {
  type: "inbound" | "outbound";
  purpose: string;
  supplierName: string;
  externalRef: string;
  customer?: string;
  contact?: string;
  remark?: string;
  items: Array<{ productId: string; quantity: number; unitPrice: number; remark?: string }>;
};
type GuestStocktakePayload = {
  purpose: string;
  items: Array<{ productId: string; countedQuantity: number }>;
};

const DEFAULT_STATUS_DEFINITIONS: StatusDefinition[] = [
  { id: "normal", label: "正常供货", color: "#21875A" },
  { id: "ordered", label: "补货已下单", color: "#B88900" },
  { id: "price_changed", label: "价格有变动", color: "#C56A16" },
  { id: "alternate", label: "启用替代供货", color: "#3377C8" },
  { id: "paused", label: "暂停采购", color: "#C74C4C" },
  { id: "pending_stocktake", label: "新增待盘点", color: "#655BC7", system: true },
];

// Keep search behaviour consistent with the offline package: Chinese product
// and supplier names can also be found by their pinyin initials (例如“语文”→“yw”).
const PINYIN_INITIAL_BOUNDS: Array<[string, string]> = [
  ["a", "阿"], ["b", "芭"], ["c", "擦"], ["d", "搭"], ["e", "蛾"], ["f", "发"], ["g", "噶"], ["h", "哈"],
  ["j", "击"], ["k", "喀"], ["l", "垃"], ["m", "妈"], ["n", "拿"], ["o", "哦"], ["p", "啪"], ["q", "期"],
  ["r", "然"], ["s", "撒"], ["t", "塌"], ["w", "挖"], ["x", "昔"], ["y", "压"], ["z", "匝"],
];
const pinyinCollator = typeof Intl !== "undefined" && Intl.Collator ? new Intl.Collator("zh-Hans-CN-u-co-pinyin") : null;

function pinyinInitials(value: string | null | undefined) {
  return Array.from(value ?? "").map((character) => {
    if (/[A-Za-z0-9]/.test(character)) return character.toLowerCase();
    if (!pinyinCollator || !/[\u3400-\u9fff]/.test(character)) return "";
    for (let index = PINYIN_INITIAL_BOUNDS.length - 1; index >= 0; index -= 1) {
      if (pinyinCollator.compare(character, PINYIN_INITIAL_BOUNDS[index][1]) >= 0) return PINYIN_INITIAL_BOUNDS[index][0];
    }
    return "";
  }).join("");
}

function productSearchText(product: Product) {
  return [product.code, product.name, product.default_supplier_name ?? "", pinyinInitials(product.name), pinyinInitials(product.default_supplier_name)].join(" ").toLowerCase();
}

function statusDefinition(status: string, definitions: StatusDefinition[]) {
  return definitions.find((item) => item.id === status) ?? definitions.find((item) => item.id === "normal") ?? definitions[0] ?? DEFAULT_STATUS_DEFINITIONS[0];
}

function statusFill(color: string) {
  const hex = color.replace("#", "");
  const values = [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6)].map((part) => Number.parseInt(part, 16));
  return `#${values.map((value) => Math.round(255 * 0.88 + value * 0.12).toString(16).padStart(2, "0")).join("")}`;
}

function withStatusDefinitions(data: AppData): AppData {
  return {
    ...data,
    statusDefinitions: Array.isArray(data.statusDefinitions) && data.statusDefinitions.length ? data.statusDefinitions : DEFAULT_STATUS_DEFINITIONS,
    recipes: Array.isArray(data.recipes) ? data.recipes : [],
    preferences: { ...DEFAULT_PREFERENCES, ...(data.preferences ?? {}) },
  };
}

const NAV_ITEMS: Array<{ page: Page; label: string; glyph: string; adminOnly?: boolean; guestAllowed?: boolean }> = [
  { page: "home", label: "工作台", glyph: "⌂" },
  { page: "products", label: "商品资料", glyph: "◇", adminOnly: true },
  { page: "inbound", label: "入库登记", glyph: "↘", adminOnly: true, guestAllowed: true },
  { page: "outbound", label: "出库登记", glyph: "↗", adminOnly: true, guestAllowed: true },
  { page: "inventory", label: "查看库存", glyph: "▦" },
  { page: "recipes", label: "一键配料", glyph: "⊞" },
  { page: "replenishment", label: "补货提醒", glyph: "＋" },
  { page: "settings", label: "设置", glyph: "⚙", adminOnly: true },
  { page: "users", label: "用户权限", glyph: "◎", adminOnly: true },
  { page: "backup", label: "备份与恢复", glyph: "↻", adminOnly: true },
];

function money(cents = 0) {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

function number(value: number) {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function dateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function fullDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

function typeLabel(type: WarehouseDocument["type"]) {
  return type === "inbound" ? "入库" : type === "outbound" ? "出库" : "盘点";
}

function pageTitle(page: Page) {
  return page === "search" ? "全局搜索" : NAV_ITEMS.find((item) => item.page === page)?.label ?? "工作台";
}

async function apiPost(body: Record<string, unknown>) {
  return cloudbaseApi(body);
}

function escapeXml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function exportExcel(
  products: Product[],
  documents: WarehouseDocument[],
  includeMoney: boolean,
  filename: string,
  statusDefinitions: StatusDefinition[] = DEFAULT_STATUS_DEFINITIONS,
) {
  const inventoryHeaders = ["商品编号", "品名", "单位", "当前库存", "最低库存", "状态", "默认供应商"];
  if (includeMoney) inventoryHeaders.push("移动平均价", "库存金额");
  const inventoryRows = products.map((product) => {
    const row: Array<string | number> = [
      product.code,
      product.name,
      product.unit,
      product.current_stock,
      product.min_stock,
      statusDefinition(product.status, statusDefinitions).label,
      product.default_supplier_name ?? "",
    ];
    if (includeMoney) {
      row.push((product.average_cost_cents ?? 0) / 100);
      row.push(((product.average_cost_cents ?? 0) * product.current_stock) / 100);
    }
    return row;
  });

  const movementHeaders = ["日期", "单号", "类型", "状态", "商品编号", "品名", "数量", "单位", "用途", "操作人"];
  if (includeMoney) movementHeaders.push("单价/成本", "金额");
  const movementRows: Array<Array<string | number>> = [];
  for (const document of documents) {
    for (const item of document.items) {
      const row: Array<string | number> = [
        document.effective_at.slice(0, 10),
        document.document_no,
        typeLabel(document.type),
        document.status === "active" ? "有效" : document.status === "voided" ? "已撤销" : "已修改",
        item.product_code,
        item.product_name,
        document.type === "stocktake" ? item.counted_quantity ?? item.after_quantity : item.quantity,
        item.product_unit,
        document.purpose,
        document.operator_name ?? "",
      ];
      if (includeMoney) {
        const unitCost = document.type === "inbound" ? item.unit_price_cents ?? 0 : item.unit_cost_cents ?? 0;
        row.push(unitCost / 100, (unitCost * Math.abs(item.quantity)) / 100);
      }
      movementRows.push(row);
    }
  }

  const worksheet = (name: string, headers: string[], rows: Array<Array<string | number>>) => {
    const rowXml = [headers, ...rows]
      .map(
        (row) =>
          `<Row>${row
            .map((cell) => {
              const numeric = typeof cell === "number";
              return `<Cell><Data ss:Type="${numeric ? "Number" : "String"}">${escapeXml(cell)}</Data></Cell>`;
            })
            .join("")}</Row>`,
      )
      .join("");
    return `<Worksheet ss:Name="${escapeXml(name)}"><Table>${rowXml}</Table></Worksheet>`;
  };
  const xml = `<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">${worksheet("库存", inventoryHeaders, inventoryRows)}${worksheet("流水", movementHeaders, movementRows)}</Workbook>`;
  const blob = new Blob(["\ufeff", xml], { type: "application/vnd.ms-excel" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function downloadCsv(filename: string, rows: Array<Array<string | number>>) {
  const encode = (value: string | number) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const blob = new Blob(["\ufeff", rows.map((row) => row.map(encode).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename; anchor.click();
  URL.revokeObjectURL(url);
}

function downloadTemplate(filename: string) {
  const anchor = document.createElement("a");
  anchor.href = `/templates/${encodeURIComponent(filename)}`; anchor.download = filename; anchor.click();
}

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = []; let cell = ""; let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') { if (quoted && text[index + 1] === '"') { cell += '"'; index += 1; } else quoted = !quoted; }
    else if (character === "," && !quoted) { row.push(cell.trim()); cell = ""; }
    else if ((character === "\n" || character === "\r") && !quoted) { if (character === "\r" && text[index + 1] === "\n") index += 1; row.push(cell.trim()); if (row.some(Boolean)) rows.push(row); row = []; cell = ""; }
    else cell += character;
  }
  row.push(cell.trim()); if (row.some(Boolean)) rows.push(row);
  return rows;
}

type FflateWindow = Window & { fflate?: { unzipSync: (bytes: Uint8Array) => Record<string, Uint8Array> } };
let fflateLoader: Promise<void> | null = null;
async function loadFflate() {
  if ((window as FflateWindow).fflate) return;
  fflateLoader ??= new Promise<void>((resolve, reject) => { const script = document.createElement("script"); script.src = "/fflate.min.js"; script.onload = () => resolve(); script.onerror = () => reject(new Error("Excel 解析组件加载失败。")); document.head.appendChild(script); });
  await fflateLoader;
}
function xmlText(value: string) { return value.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code))); }
function columnIndex(reference: string) { return reference.split("").reduce((result, character) => result * 26 + character.charCodeAt(0) - 64, 0) - 1; }
async function parseXlsxRows(file: File, sheetNumber: number) {
  await loadFflate();
  const files = (window as FflateWindow).fflate!.unzipSync(new Uint8Array(await file.arrayBuffer()));
  const decode = (path: string) => files[path] ? new TextDecoder().decode(files[path]) : "";
  const shared = [...decode("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((entry) => xmlText(entry[1]));
  const worksheet = decode(`xl/worksheets/sheet${sheetNumber}.xml`);
  if (!worksheet) throw new Error("未找到模板数据页，请使用下载的仓储台模板。");
  return [...worksheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((entry) => {
    const values: string[] = [];
    for (const cell of entry[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const ref = /r="([A-Z]+)\d+"/.exec(cell[1])?.[1]; if (!ref) continue;
      const raw = /<v>([\s\S]*?)<\/v>/.exec(cell[2])?.[1] ?? /<t[^>]*>([\s\S]*?)<\/t>/.exec(cell[2])?.[1] ?? "";
      const sharedIndex = /t="s"/.test(cell[1]); values[columnIndex(ref)] = sharedIndex ? (shared[Number(raw)] ?? "") : xmlText(raw);
    }
    return values;
  }).filter((row) => row.some(Boolean));
}

function StatusBadge({ status, definitions }: { status: string; definitions: StatusDefinition[] }) {
  const item = statusDefinition(status, definitions);
  return <span className="status-badge dynamic-status" style={{ "--status-color": item.color, "--status-fill": statusFill(item.color) } as React.CSSProperties}>{item.label}</span>;
}

function ProductAutocomplete({
  products,
  value,
  onChange,
  onCreate,
  disabled,
}: {
  products: Product[];
  value: string;
  onChange: (id: string) => void;
  onCreate?: (name: string) => void;
  disabled?: boolean;
}) {
  const chosen = products.find((product) => product.id === value);
  const [query, setQuery] = useState(chosen ? `${chosen.code} · ${chosen.name}` : "");
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const current = products.find((product) => product.id === value);
    if (current) setQuery(`${current.code} · ${current.name}`);
    else if (!value) setQuery("");
  }, [value, products]);
  const suggestions = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return products.slice(0, 6);
    return products
      .filter((product) => productSearchText(product).includes(term))
      .slice(0, 6);
  }, [products, query]);
  return (
    <div className="autocomplete">
      <input
        value={query}
        disabled={disabled}
        placeholder="输入品名或编号查找"
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onChange={(event) => {
          setQuery(event.target.value);
          onChange("");
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || chosen || !query.trim() || suggestions.length) return;
          event.preventDefault();
          setOpen(false);
          onCreate?.(query.trim());
        }}
        aria-label="搜索商品"
      />
      {open && !disabled && (
        <div className="suggestion-list">
          {suggestions.length ? (
            suggestions.map((product) => (
              <button
                type="button"
                key={product.id}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onChange(product.id);
                  setQuery(`${product.code} · ${product.name}`);
                  setOpen(false);
                }}
              >
                <span><b>{product.name}</b><small>{product.code} · 库存 {product.current_stock}{product.unit}</small></span>
                {product.current_stock <= product.min_stock && <em>库存预警</em>}
              </button>
            ))
          ) : (
            <p>没有找到匹配商品</p>
          )}
        </div>
      )}
    </div>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty-state">
      <span>□</span>
      <h3>{title}</h3>
      <p>{detail}</p>
    </div>
  );
}

function Dashboard({
  data,
  onNavigate,
}: {
  data: AppData;
  onNavigate: (page: Page) => void;
}) {
  const { products, documents, currentUser } = data;
  const canOperate = currentUser.role === "admin" || currentUser.role === "guest";
  const today = new Date().toISOString().slice(0, 10);
  const activeToday = documents.filter(
    (document) => document.status === "active" && document.effective_at.startsWith(today),
  );
  const lowStock = products.filter((product) => product.current_stock <= product.min_stock);
  const inboundToday = activeToday
    .filter((document) => document.type === "inbound")
    .reduce((sum, document) => sum + document.items.reduce((itemSum, item) => itemSum + item.quantity, 0), 0);
  const outboundToday = activeToday
    .filter((document) => document.type === "outbound")
    .reduce((sum, document) => sum + document.items.reduce((itemSum, item) => itemSum + item.quantity, 0), 0);

  return (
    <div className="page-stack">
      <section className="welcome-panel dashboard-hero">
        <div className="today-block"><span>{new Date().getDate()}</span><small>{new Intl.DateTimeFormat("zh-CN", { month: "long" }).format(new Date())}</small><b>{new Intl.DateTimeFormat("zh-CN", { weekday: "short", year: "numeric" }).format(new Date())}</b></div>
        <button className="hero-search-button" onClick={() => onNavigate("search")}><span>⌕</span><strong>全局搜索</strong></button>
      </section>

      <section className="quick-grid">
        <button className="quick-card product" onClick={() => onNavigate(canOperate ? "products" : "inventory")}><span className="quick-icon">◇</span><div><strong>{canOperate ? "商品资料" : "查看库存"}</strong></div><i>→</i></button>
        <button className="quick-card inbound" onClick={() => onNavigate(canOperate ? "inbound" : "inventory")}><span className="quick-icon">↘</span><div><strong>{canOperate ? "商品入库" : "查看库存"}</strong></div><i>→</i></button>
        <button className="quick-card outbound" onClick={() => onNavigate(canOperate ? "outbound" : "reports")}><span className="quick-icon">↗</span><div><strong>{canOperate ? "商品出库" : "库存报表"}</strong></div><i>→</i></button>
        <button className="quick-card recipe" onClick={() => onNavigate("recipes")}><span className="quick-icon">⊞</span><div><strong>一键配料</strong></div><i>→</i></button>
      </section>

      <section className="metric-grid dashboard-metrics">
        <button className="metric-link" onClick={() => onNavigate("inventory")}><div className="metric-heading"><span className="dot green-dot" />库存商品</div><strong>{number(products.length)}<small> 种</small></strong><p>{products.reduce((sum, product) => sum + product.current_stock, 0)} 件在库</p></button>
        <button className="metric-link" onClick={() => onNavigate("reports")}><div className="metric-heading"><span className="dot blue-dot" />今日出入库</div><strong>入 {number(inboundToday)} · 出 {number(outboundToday)}</strong><p>点击查看库存报表</p></button>
      </section>

      <section className="dashboard-grid">
        <article className="panel recent-panel">
          <div className="panel-heading"><div><p className="eyebrow">最近动态</p><h2>出入库流水</h2></div><button className="text-button" onClick={() => onNavigate("records")}>查看全部 →</button></div>
          {documents.length ? (
            <div className="activity-list">
              {documents.slice(0, 6).map((document) => (
                <div className="activity-row" key={document.id}>
                  <span className={`activity-icon ${document.type}`}>{document.type === "inbound" ? "↘" : document.type === "outbound" ? "↗" : "✓"}</span>
                  <div><strong>{typeLabel(document.type)} · {document.items[0]?.product_name ?? "库存调整"}{document.items.length > 1 ? ` 等${document.items.length}种` : ""}</strong><p>{document.document_no} · {document.operator_name}</p></div>
                  <div className="activity-value"><b>{document.type === "outbound" ? "−" : document.type === "inbound" ? "+" : ""}{document.items.reduce((sum, item) => sum + Math.abs(item.quantity), 0)}</b><small>{dateTime(document.effective_at)}</small></div>
                </div>
              ))}
            </div>
          ) : <EmptyState title="还没有库存流水" detail="首次入库后，最新动态会显示在这里。" />}
        </article>
        <article className="panel warning-panel">
          <div className="panel-heading"><div><p className="eyebrow">需要关注</p><h2>低库存商品</h2></div><span className="count-pill">{lowStock.length}</span></div>
          {lowStock.length ? (
            <div className="warning-list">
              {lowStock.slice(0, 5).map((product) => {
                const denominator = Math.max(product.min_stock, 1);
                const percent = Math.max(0, Math.min(100, (product.current_stock / denominator) * 100));
                return <button key={product.id} onClick={() => onNavigate("inventory")}><div><strong>{product.name}</strong><span>{product.code}</span></div><b>{product.current_stock}<small> / {product.min_stock}{product.unit}</small></b><i><span style={{ width: `${percent}%` }} /></i></button>;
              })}
            </div>
          ) : <EmptyState title="库存状态良好" detail="没有低于最低库存的商品。" />}
        </article>
      </section>
    </div>
  );
}

function OcrDialog({
  products,
  onApply,
  onClose,
}: {
  products: Product[];
  onApply: (result: { supplier: string; reference: string; items: FormLine[] }) => void;
  onClose: () => void;
}) {
  const [status, setStatus] = useState("请选择送货单或订单截图");
  const [progress, setProgress] = useState(0);
  const [preview, setPreview] = useState("");
  const [result, setResult] = useState<{ supplier: string; reference: string; items: FormLine[] } | null>(null);
  const [rawText, setRawText] = useState("");

  async function recognize(file: File) {
    setPreview(URL.createObjectURL(file));
    setStatus("正在准备本机识别…");
    setProgress(2);
    try {
      const win = window as typeof window & {
        Tesseract?: {
          recognize: (
            file: File,
            languages: string,
            options: { logger: (message: { status: string; progress?: number }) => void },
          ) => Promise<{ data: { text: string } }>;
        };
      };
      if (!win.Tesseract) {
        await new Promise<void>((resolve, reject) => {
          const script = document.createElement("script");
          script.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
          script.async = true;
          script.onload = () => resolve();
          script.onerror = () => reject(new Error("识别组件加载失败，请检查网络后重试。"));
          document.head.appendChild(script);
        });
      }
      if (!win.Tesseract) throw new Error("识别组件未能启动。");
      const response = await win.Tesseract.recognize(file, "chi_sim+eng", {
        logger: (message) => {
          if (typeof message.progress === "number") setProgress(Math.round(message.progress * 100));
          setStatus(message.status.includes("recognizing") ? "正在识别截图文字…" : "正在加载识别模型…");
        },
      });
      const text = response.data.text;
      setRawText(text);
      const supplierMatch = text.match(/(?:供应商|供货单位|销售方)\s*[:：]?\s*([^\n]{2,40})/);
      const referenceMatch = text.match(/(?:送货单号|订单号|单据编号|单号)\s*[:：]?\s*([A-Za-z0-9_-]{3,40})/i);
      const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const recognizedItems: FormLine[] = [];
      for (const product of products) {
        const line = lines.find((entry) => entry.includes(product.name) || entry.toLowerCase().includes(product.code.toLowerCase()));
        if (!line) continue;
        const trailing = line.slice(Math.max(line.indexOf(product.name) + product.name.length, line.toLowerCase().indexOf(product.code.toLowerCase()) + product.code.length));
        const values = trailing.match(/\d+(?:\.\d+)?/g) ?? line.match(/\d+(?:\.\d+)?/g) ?? [];
        const filtered = values.filter((entry) => !product.code.includes(entry));
        recognizedItems.push({
          key: crypto.randomUUID(),
          productId: product.id,
          quantity: filtered[0] ?? "1",
          unitPrice: filtered[1] ?? "",
          remark: "",
        });
      }
      const parsed = {
        supplier: supplierMatch?.[1]?.trim() ?? "",
        reference: referenceMatch?.[1]?.trim() ?? "",
        items: recognizedItems,
      };
      setResult(parsed);
      setStatus(recognizedItems.length ? `识别到 ${recognizedItems.length} 种库存商品，请确认后填入` : "已识别文字，但未匹配到现有商品");
      setProgress(100);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "识别失败，请改用清晰截图。 ");
      setProgress(0);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="图片识别">
      <div className="modal-card ocr-modal">
        <div className="modal-heading"><div><p className="eyebrow">图片 OCR</p><h2>从截图提取入库信息</h2></div><button className="close-button" onClick={onClose}>×</button></div>
        <div className="privacy-note"><span>▣</span><p><strong>图片仅在当前浏览器中识别</strong><br />原图不会上传到仓库系统，也不会保存。</p></div>
        <label className="upload-zone">
          {preview ? <img src={preview} alt="待识别截图预览" /> : <span className="upload-symbol">＋</span>}
          <strong>{preview ? "更换截图" : "选择或拖入截图"}</strong>
          <small>支持 PNG、JPG，建议文字清晰且画面端正</small>
          <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) void recognize(file); }} />
        </label>
        <div className="ocr-progress"><div><span style={{ width: `${progress}%` }} /></div><p>{status}</p></div>
        {rawText && <details className="ocr-raw"><summary>查看识别原文</summary><pre>{rawText}</pre></details>}
        <div className="modal-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!result} onClick={() => result && onApply(result)}>确认并填入</button></div>
      </div>
    </div>
  );
}

function DocumentForm({
  type,
  data,
  editing,
  initialProductId,
  onSaved,
  onRefresh,
  onCancelEdit,
  onGuestDocument,
}: {
  type: "inbound" | "outbound";
  data: AppData;
  editing: WarehouseDocument | null;
  initialProductId?: string;
  onSaved: (message: string) => Promise<void>;
  onRefresh: (message?: string) => Promise<void>;
  onCancelEdit: () => void;
  onGuestDocument: (payload: GuestDocumentPayload) => Promise<{ documentNo: string }>;
}) {
  const firstLines = () =>
    editing?.items.map((item) => ({
      key: crypto.randomUUID(),
      productId: item.product_id,
      quantity: String(item.quantity),
      unitPrice: type === "inbound" ? String((item.unit_price_cents ?? 0) / 100) : "",
      remark: item.remark ?? "",
    })) ?? [{ key: crypto.randomUUID(), productId: initialProductId ?? "", quantity: "", unitPrice: "", remark: "" }];
  const [lines, setLines] = useState<FormLine[]>(firstLines);
  const [purpose, setPurpose] = useState(editing?.purpose ?? "");
  const [supplier, setSupplier] = useState(editing?.supplier_name ?? "");
  const [reference, setReference] = useState(editing?.external_ref ?? "");
  const [customer, setCustomer] = useState(editing?.customer ?? "");
  const [contact, setContact] = useState(editing?.contact ?? "");
  const [remark, setRemark] = useState(editing?.remark ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [showOcr, setShowOcr] = useState(false);
  const [newProductName, setNewProductName] = useState("");
  const [pendingNewProductCode, setPendingNewProductCode] = useState("");
  const costMethod = data.preferences?.outboundCostMethod ?? "weighted";
  const costMethodLabel = costMethod === "fifo" ? "先进先出" : costMethod === "lastInbound" ? "最近入库价" : "移动加权平均";

  useEffect(() => {
    setLines(firstLines());
    setPurpose(editing?.purpose ?? "");
    setSupplier(editing?.supplier_name ?? "");
    setReference(editing?.external_ref ?? "");
    setCustomer(editing?.customer ?? ""); setContact(editing?.contact ?? ""); setRemark(editing?.remark ?? "");
    setError("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.id, type, initialProductId]);

  useEffect(() => {
    if (editing || !initialProductId) return;
    const product = data.products.find((item) => item.id === initialProductId);
    if (!product) return;
    setLines([{ key: crypto.randomUUID(), productId: product.id, quantity: "", unitPrice: type === "inbound" ? lastInboundPrice(product.id) : "", remark: "" }]);
    if (type === "inbound" && product.default_supplier_name) setSupplier(product.default_supplier_name);
    // initial product is consumed by this screen instance; subsequent user input stays untouched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, initialProductId, type]);

  const totalQuantity = lines.reduce((sum, line) => sum + (Number(line.quantity) || 0), 0);
  const totalAmount = lines.reduce((sum, line) => sum + (Number(line.quantity) || 0) * (Number(line.unitPrice) || 0), 0);

  function lastInboundPrice(productId: string) {
    const document = data.documents.find((item) => item.type === "inbound" && item.status === "active" && item.items.some((line) => line.product_id === productId));
    const item = document?.items.find((line) => line.product_id === productId);
    return item?.unit_price_cents == null ? "" : String(item.unit_price_cents / 100);
  }

  useEffect(() => {
    if (!pendingNewProductCode) return;
    const product = data.products.find((item) => item.code === pendingNewProductCode);
    if (!product) return;
    setLines((current) => current.map((line, index) => index === 0 ? { ...line, productId: product.id, unitPrice: type === "inbound" ? lastInboundPrice(product.id) : line.unitPrice } : line));
    if (type === "inbound" && product.default_supplier_name) setSupplier(product.default_supplier_name);
    setPendingNewProductCode("");
  }, [data.products, pendingNewProductCode, type]);

  function updateLine(key: string, patch: Partial<FormLine>) {
    if (type === "inbound" && patch.productId) {
      const product = data.products.find((item) => item.id === patch.productId);
      if (product?.default_supplier_name && !supplier.trim()) setSupplier(product.default_supplier_name);
    }
    setLines((current) => current.map((line) => {
      if (line.key !== key) return line;
      const next = { ...line, ...patch };
      if (type === "inbound" && patch.productId && !line.unitPrice) next.unitPrice = lastInboundPrice(patch.productId);
      return next;
    }));
    setError("");
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    const validLines = lines.filter((line) => line.productId || line.quantity || line.unitPrice);
    if (!validLines.length) return setError("请至少添加一种商品。");
    for (const line of validLines) {
      const product = data.products.find((item) => item.id === line.productId);
      const quantity = Number(line.quantity);
      if (!product || !Number.isInteger(quantity) || quantity <= 0) return setError("请完整选择商品并填写正整数数量。");
      if (type === "inbound" && (!Number.isFinite(Number(line.unitPrice)) || Number(line.unitPrice) < 0)) return setError("请填写正确的入库单价。");
      if (type === "outbound" && quantity > product.current_stock) return setError(`${product.name}库存只有 ${product.current_stock}${product.unit}，最大可出库 ${product.current_stock}${product.unit}。`);
    }
    setSaving(true);
    try {
      const requestPayload: GuestDocumentPayload = {
        type,
        purpose,
        supplierName: type === "inbound" ? supplier : "",
        externalRef: type === "inbound" ? reference : "",
        customer: type === "outbound" ? customer : "",
        contact: type === "outbound" ? contact : "",
        remark,
        items: validLines.map((line) => ({ productId: line.productId, quantity: Number(line.quantity), unitPrice: Number(line.unitPrice || 0), remark: line.remark })),
      };
      const result = data.currentUser.role === "guest"
        ? await onGuestDocument(requestPayload)
        : await apiPost({ action: "create-document", ...requestPayload, costMethod, revisionOf: editing?.id });
      setLines([{ key: crypto.randomUUID(), productId: "", quantity: "", unitPrice: "", remark: "" }]);
      setPurpose(""); setSupplier(""); setReference(""); setCustomer(""); setContact(""); setRemark("");
      await onSaved(`${editing ? "单据已修改" : type === "inbound" ? "入库成功" : "出库成功"}：${String(result.documentNo)}`);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "提交失败。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page-stack document-page">
      <section className={`page-hero compact ${type}`}>
        <div><p className="eyebrow">{editing ? "保留原单并生成修订记录" : type === "inbound" ? "采购到货 · 库存增加" : "领用发货 · 库存减少"}</p><h1>{editing ? `修改${typeLabel(type)}单` : type === "inbound" ? "新建入库单" : "新建出库单"}</h1><p>{type === "inbound" ? "一次可登记多种商品，实际单价将参与移动加权平均。" : "出库成本由系统自动计算；任何情况下都不允许负库存。"}</p></div>
        {type === "inbound" && <button className="ocr-button" onClick={() => setShowOcr(true)}><span>▣</span><div><strong>图片识别填单</strong><small>截图自动提取</small></div></button>}
      </section>
      <form className="panel document-form" onSubmit={submit}>
        <div className="form-section-heading document-info-heading"><div><span>02</span><div><h2>单据信息</h2><p>操作人将自动记录为 {data.currentUser.display_name}</p></div></div>{editing && <button type="button" className="text-button" onClick={onCancelEdit}>退出修改</button>}</div>
        {type === "inbound" ? <details className="document-details"><summary><span><b>供应商信息</b><small>选填 · 点击展开</small></span><b aria-hidden="true">⌄</b></summary><div className="document-meta-grid inbound"><label><span>本次实际供应商</span><input list="supplier-options" value={supplier} onChange={(event) => setSupplier(event.target.value)} placeholder="选择或输入供应商" /><datalist id="supplier-options">{data.suppliers.map((item) => <option key={item.id} value={item.name} />)}</datalist></label><label><span>供应商单号 <em>选填</em></span><input value={reference} onChange={(event) => setReference(event.target.value)} placeholder="送货单号或订单号" /></label></div></details> : <><div className="document-meta-grid outbound"><label><span>客户 <em>选填</em></span><input value={customer} onChange={(event) => setCustomer(event.target.value)} placeholder="客户名称" /></label><label><span>联系方式 <em>选填</em></span><input value={contact} onChange={(event) => setContact(event.target.value)} placeholder="电话或联系人" /></label></div><details className="document-details"><summary><span><b>用途及备注</b><small>选填 · 点击展开</small></span><b aria-hidden="true">⌄</b></summary><div className="document-meta-grid outbound"><label><span>用途</span><input value={purpose} onChange={(event) => setPurpose(event.target.value)} placeholder="例如：生产领用 / 客户发货" /></label><label><span>单据备注 <em>选填</em></span><input value={remark} onChange={(event) => setRemark(event.target.value)} placeholder="补充说明" /></label></div></details></>}
        <div className="form-divider" />
        <div className="form-section-heading product-lines-heading"><div><span>01</span><div><h2>商品明细</h2><p>输入部分品名或编号即可联想查找</p></div></div><button type="button" className="small-add-button" onClick={() => setLines((current) => [...current, { key: crypto.randomUUID(), productId: "", quantity: "", unitPrice: "", remark: "" }])}>＋ 添加一行</button></div>
        <div className="line-table">
          <div className={`line-head ${type}`}><span>商品</span><span>当前库存</span><span>数量</span>{type === "inbound" ? <span>实际单价</span> : <span>计价方式</span>}<span>备注</span><span /> </div>
          {lines.map((line, index) => {
            const product = data.products.find((item) => item.id === line.productId);
            return <div className={`line-row ${type}`} key={line.key}>
              <div className="line-product"><small>{String(index + 1).padStart(2, "0")}</small><ProductAutocomplete products={data.products} value={line.productId} onChange={(productId) => updateLine(line.key, { productId })} onCreate={type === "inbound" ? (name) => setNewProductName(name) : undefined} /></div>
              <div className={`stock-cell ${product && Number(line.quantity) > product.current_stock && type === "outbound" ? "danger" : ""}`}>{product ? <><b>{product.current_stock}</b><small>{product.unit}</small></> : "—"}</div>
              <label className="number-input"><input inputMode="numeric" min="1" step="1" value={line.quantity} onChange={(event) => updateLine(line.key, { quantity: event.target.value })} placeholder="0" /><span>{product?.unit ?? "件"}</span></label>
              {type === "inbound" ? <label className="number-input price-input"><span>¥</span><input inputMode="decimal" min="0" step="0.01" value={line.unitPrice} onChange={(event) => updateLine(line.key, { unitPrice: event.target.value })} placeholder="0.00" /></label> : <div className="cost-rule"><strong>{costMethodLabel}</strong>{data.currentUser.role !== "viewer" && product ? <small>当前 {money(product.average_cost_cents)}</small> : <small>提交时自动计算</small>}</div>}
              <input className="line-remark" value={line.remark} onChange={(event) => updateLine(line.key, { remark: event.target.value })} placeholder="选填备注" />
              <button type="button" className="remove-line" disabled={lines.length === 1} onClick={() => setLines((current) => current.filter((item) => item.key !== line.key))}>×</button>
            </div>;
          })}
        </div>
        {error && <div className="form-error"><span>!</span>{error}</div>}
        <div className="document-footer"><div className="document-summary"><span>共 <b>{lines.filter((line) => line.productId).length}</b> 种商品</span><span>合计数量 <b>{totalQuantity}</b></span>{type === "inbound" && <span>入库金额 <strong>{money(Math.round(totalAmount * 100))}</strong></span>}</div><button className={`submit-document ${type}`} disabled={saving}>{saving ? "正在校验并保存…" : editing ? "确认修改" : type === "inbound" ? "确认入库" : "确认出库"}<span>→</span></button></div>
      </form>
      {showOcr && <OcrDialog products={data.products} onClose={() => setShowOcr(false)} onApply={(ocr) => { if (ocr.supplier) setSupplier(ocr.supplier); if (ocr.reference) setReference(ocr.reference); if (ocr.items.length) setLines(ocr.items); setShowOcr(false); }} />}
      {newProductName && <CreateProductModal suppliers={data.suppliers} statusDefinitions={data.statusDefinitions} preferences={data.preferences ?? DEFAULT_PREFERENCES} initialName={newProductName} initialSupplier={supplier} onClose={() => setNewProductName("")} onCreated={async (message, code) => { setNewProductName(""); setPendingNewProductCode(code); await onRefresh(message); }} />}
    </div>
  );
}

function InventoryView({ data, onOpenProduct, onStartStocktake, onNavigate }: { data: AppData; onOpenProduct: (productId: string) => void; onStartStocktake: (productId: string) => void; onNavigate: (page: Page) => void }) {
  const [query, setQuery] = useState("");
  const [groupBySupplier, setGroupBySupplier] = useState(() => typeof window !== "undefined" && localStorage.getItem("warehouse-inventory-group-by-supplier") === "true");
  const [selectedSupplier, setSelectedSupplier] = useState<string | null>(null);
  const grouped = data.products.reduce<Record<string, Product[]>>((result, product) => {
    const supplier = product.default_supplier_name || "未设置供应商";
    (result[supplier] ??= []).push(product); return result;
  }, {});
  const source = selectedSupplier ? (grouped[selectedSupplier] ?? []) : data.products;
  const filtered = source.filter((product) => productSearchText(product).includes(query.toLowerCase()));
  function toggleGrouping() {
    const next = !groupBySupplier;
    setGroupBySupplier(next); localStorage.setItem("warehouse-inventory-group-by-supplier", String(next));
    if (!next) setSelectedSupplier(null);
  }
  return (
    <div className="page-stack">
      <section className="page-heading inventory-heading"><div>{selectedSupplier && <button className="secondary-button product-back" onClick={() => setSelectedSupplier(null)}>← 返回供应商分类</button>}<p className="eyebrow">实时库存</p><h1>{selectedSupplier ?? "查看库存"}</h1><p>{selectedSupplier ? `该供应商下共有 ${source.length} 种库存商品。` : `当前共有 ${data.products.length} 种库存商品。`}</p></div><label className="search-box inventory-header-search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索品名、编号或供应商" /></label><div className="inventory-actions"><button className="export-button" onClick={() => exportExcel(filtered, data.documents, data.currentUser.role !== "viewer", `库存清单-${new Date().toISOString().slice(0, 10)}.xls`, data.statusDefinitions)}>⇩ 导出 Excel</button></div></section>
      {!selectedSupplier && <section className="inventory-shortcuts"><button onClick={() => onNavigate("stocktake")}><span>✓</span><strong>库存盘点</strong><i>→</i></button><button onClick={() => onNavigate("reports")}><span>▤</span><strong>库存报表</strong><i>→</i></button></section>}
      <section className="panel data-panel">
        <div className="table-toolbar inventory-toolbar"><button className={`secondary-button ${groupBySupplier ? "active-toggle" : ""}`} onClick={toggleGrouping}>按供应商分类：{groupBySupplier ? "已开启" : "已关闭"}</button><span className="result-count">{groupBySupplier && !selectedSupplier && !query ? `共 ${data.products.length} 种库存商品，按默认供应商分类` : `${filtered.length} 条结果`}</span></div>
        {groupBySupplier && !selectedSupplier && !query ? <div className="supplier-group-list inventory-supplier-list">{Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b, "zh-CN")).map(([supplier, products]) => <button className="supplier-group-card" key={supplier} onClick={() => setSelectedSupplier(supplier)}><div><strong>{supplier}</strong></div><span><small>库存商品</small><b>{products.length} 种 · {products.reduce((total, product) => total + product.current_stock, 0)} 件</b></span></button>)}</div> : filtered.length ? <div className={`data-table inventory-table ${data.currentUser.role === "viewer" ? "viewer" : ""}`}>
           <div className="table-head"><span>商品信息</span><span>状态</span><span>当前库存</span><span>最低库存</span><span>默认供应商</span>{data.currentUser.role !== "viewer" && <><span>平均成本</span><span>库存金额</span></>}</div>
          {filtered.map((product) => {
            return <div className={`table-row ${product.status === "pending_stocktake" ? "pending-stocktake-row" : ""}`} key={product.id} onClick={() => product.status === "pending_stocktake" && onStartStocktake(product.id)}>
              <div className="product-identity"><button className="product-history-link" onClick={(event) => { event.stopPropagation(); onOpenProduct(product.id); }}><strong>{product.name}</strong></button></div>
              <div>{product.status === "pending_stocktake" ? <button className="status-stocktake-link" onClick={(event) => { event.stopPropagation(); onStartStocktake(product.id); }}><StatusBadge status={product.status} definitions={data.statusDefinitions} /></button> : <StatusBadge status={product.status} definitions={data.statusDefinitions} />}</div>
              <div className="quantity-cell"><strong>{number(product.current_stock)}</strong><small>{product.unit}</small></div>
              <div>{product.min_stock} {product.unit}</div>
              <div>{product.default_supplier_name ?? "—"}</div>
              {data.currentUser.role !== "viewer" && <><div>{money(product.average_cost_cents)}</div><div className="money-cell">{money((product.average_cost_cents ?? 0) * product.current_stock)}</div></>}
            </div>;
          })}
        </div> : <EmptyState title="没有匹配的商品" detail="请更换搜索词或筛选条件。" />}
      </section>
    </div>
  );
}

function GlobalSearchView({ data, onNavigate, onStartDocument }: { data: AppData; onNavigate: (page: Page) => void; onStartDocument: (type: "inbound" | "outbound", productId: string) => void }) {
  const [query, setQuery] = useState("");
  const term = query.trim().toLowerCase();
  const matches = data.products.filter((product) => productSearchText(product).includes(term));
  return <div className="page-stack"><section className="page-heading"><div><p className="eyebrow">跨商品检索</p><h1>全局搜索</h1><p>支持供应商、商品编号、品名及拼音首字母查询。</p></div><button className="secondary-button" onClick={() => onNavigate("home")}>返回工作台</button></section><section className="panel global-search-panel"><label className="global-search-box"><span>⌕</span><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入品名、供应商、商品编号或拼音首字母" /><button type="button" onClick={() => setQuery("")}>×</button></label>{!term ? <EmptyState title="输入供应商、商品编号或品名" detail="例如输入“yw”可找到“语文”；结果会显示库存、价格和快捷操作。" /> : matches.length ? <div className="search-result-list"><div className="table-head"><span>商品名称</span><span>商品编号</span><span>默认供应商</span><span>当前库存</span><span>计价单价</span><span>状态</span><span>操作</span></div>{matches.map((product) => <article key={product.id}><strong>{product.name}</strong><b>{product.code}</b><b>{product.default_supplier_name ?? "未设置供应商"}</b><b>{product.current_stock}{product.unit}</b><b>{data.currentUser.role === "viewer" ? "—" : money(product.average_cost_cents)}</b><StatusBadge status={product.status} definitions={data.statusDefinitions} /><span><button className="primary-button" onClick={() => onStartDocument("inbound", product.id)}>商品入库</button><button className="secondary-button" onClick={() => onStartDocument("outbound", product.id)}>商品出库</button></span></article>)}</div> : <EmptyState title="没有找到匹配商品" detail="可尝试输入更短的品名、编号、供应商或拼音首字母。" />}</section></div>;
}

function ProductHistoryView({ data, product, onBack }: { data: AppData; product: Product; onBack: () => void }) {
  const movements = data.documents
    .flatMap((document) => document.items.filter((item) => item.product_id === product.id).map((item) => ({ document, item })))
    .sort((a, b) => new Date(b.document.effective_at).getTime() - new Date(a.document.effective_at).getTime());
  const canSeeMoney = data.currentUser.role !== "viewer";
  return <div className="page-stack">
    <section className="page-heading product-history-heading"><div><button className="secondary-button product-back" onClick={onBack}>← 返回库存</button><p className="eyebrow">商品全周期</p><h1>{product.name}</h1><p>{product.code}{product.default_supplier_name ? ` · ${product.default_supplier_name}` : ""}</p></div><button className="export-button" onClick={() => exportExcel([product], movements.map(({ document }) => document), canSeeMoney, `${product.name}-商品全周期-${new Date().toISOString().slice(0, 10)}.xls`, data.statusDefinitions)}>⇩ 导出 Excel</button></section>
    <section className="history-summary-grid"><article><small>当前库存</small><strong>{number(product.current_stock)} <em>{product.unit}</em></strong></article>{canSeeMoney && <article><small>当前计价单价</small><strong>{money(product.average_cost_cents)}</strong></article>}<article><small>供货状态</small><StatusBadge status={product.status} definitions={data.statusDefinitions} /></article><article><small>建库时间</small><strong>{movements.length ? fullDate(movements[movements.length - 1].document.created_at) : "—"}</strong></article></section>
    <section className="panel data-panel product-history-table"><div className="panel-heading"><div><p className="eyebrow">完整流水</p><h2>共 {movements.length} 条</h2></div></div>{movements.length ? <div className={`data-table ${canSeeMoney ? "" : "viewer"}`}><div className="table-head"><span>时间</span><span>类型</span><span>单号</span><span>数量</span>{canSeeMoney && <span>单价 / 成本</span>}<span>库存变化</span><span>备注</span><span>供应商 / 用途</span></div>{movements.map(({ document, item }) => <div className="table-row" key={item.id}><div>{fullDate(document.effective_at)}</div><div><span className={`record-status ${document.status}`}>{typeLabel(document.type)}</span></div><div><strong>{document.document_no}</strong></div><div className={document.type === "outbound" ? "negative-quantity" : "positive-quantity"}><strong>{document.type === "outbound" ? "−" : "+"}{Math.abs(item.quantity)}{item.product_unit}</strong></div>{canSeeMoney && <div>{document.type === "inbound" ? money(item.unit_price_cents) : document.type === "outbound" ? money(item.unit_cost_cents) : "—"}</div>}<div>{item.before_quantity} → {item.after_quantity}{item.product_unit}</div><div className="history-remark">{item.remark || document.remark || "—"}</div><div>{document.type === "inbound" ? (document.supplier_name || "未填写供应商") : (document.purpose || "未填写用途")}</div></div>)}</div> : <EmptyState title="暂时没有流水" detail="该商品还没有出入库或盘点记录。" />}</section>
  </div>;
}

function ReplenishmentView({ data }: { data: AppData }) {
  const suggestions = data.products
    .filter((product) => product.current_stock <= product.min_stock)
    .sort((a, b) => a.current_stock - b.current_stock);
  return <div className="page-stack">
    <section className="page-heading"><div><p className="eyebrow">采购辅助</p><h1>补货提醒</h1><p>库存低于或等于最低库存时提醒；采购数量由你按实际需要决定。</p></div><div className="inventory-actions"><span className="heading-number">待补货 {suggestions.length} 种</span><button className="export-button" onClick={() => exportExcel(suggestions, [], data.currentUser.role !== "viewer", `待补货清单-${new Date().toISOString().slice(0, 10)}.xls`, data.statusDefinitions)}>⇩ 导出待补货清单</button></div></section>
    <section className="panel data-panel">
      {suggestions.length ? <div className="data-table replenishment-table"><div className="table-head"><span>商品信息</span><span>默认供应商</span><span>供货状态</span><span>当前库存</span><span>最低库存</span><span>提醒</span></div>{suggestions.map((product) => <div className="table-row" key={product.id}><div className="product-identity"><span>{product.name.slice(0, 1)}</span><div><strong>{product.name}</strong><small>{product.code} · {product.unit}</small></div></div><div>{product.default_supplier_name ?? "—"}</div><div><StatusBadge status={product.status} definitions={data.statusDefinitions} /></div><div className="quantity-cell"><strong>{product.current_stock}</strong><small>{product.unit}</small></div><div>{product.min_stock} {product.unit}</div><div className="replenish-quantity">需要补货</div></div>)}</div> : <EmptyState title="当前无需补货" detail="所有商品均高于最低库存。" />}
    </section>
  </div>;
}

function StocktakeView({ data, initialProductId, onSaved, onGuestStocktake, onBack }: { data: AppData; initialProductId?: string; onSaved: (message: string) => Promise<void>; onGuestStocktake: (payload: GuestStocktakePayload) => Promise<{ documentNo: string }>; onBack: () => void }) {
  const [query, setQuery] = useState("");
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [purpose, setPurpose] = useState("定期盘点");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [selectedProductId, setSelectedProductId] = useState(initialProductId ?? "");
  useEffect(() => {
    setSelectedProductId(initialProductId ?? "");
  }, [initialProductId]);
  const filtered = data.products.filter((product) => `${product.code} ${product.name}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => Number(b.status === "pending_stocktake") - Number(a.status === "pending_stocktake"));
  // A newly imported "待盘点" item also needs a confirmation record when its
  // counted quantity happens to equal the initial value.
  const changed = data.products.filter((product) => counts[product.id] !== undefined && counts[product.id] !== "" && (Number(counts[product.id]) !== product.current_stock || product.status === "pending_stocktake"));
  async function submit() {
    if (!changed.length) return setError("请至少填写一项与账面库存不同的实盘数量。");
    if (changed.some((product) => !Number.isInteger(Number(counts[product.id])) || Number(counts[product.id]) < 0)) return setError("实盘数量必须是大于或等于 0 的整数。");
    setSaving(true); setError("");
    try {
      const requestPayload: GuestStocktakePayload = { purpose, items: changed.map((product) => ({ productId: product.id, countedQuantity: Number(counts[product.id]) })) };
      const result = data.currentUser.role === "guest"
        ? await onGuestStocktake(requestPayload)
        : await apiPost({ action: "stocktake", ...requestPayload });
      setCounts({});
      await onSaved(`盘点完成：${String(result.documentNo)}`);
    } catch (submitError) { setError(submitError instanceof Error ? submitError.message : "盘点提交失败。"); }
    finally { setSaving(false); }
  }
  return (
    <div className="page-stack">
      <button className="secondary-button product-back page-back" onClick={onBack}>← 返回查看库存</button>
      <section className="page-hero compact stocktake"><div><p className="eyebrow">账实核对 · 自动留痕</p><h1>库存盘点</h1><p>点击任意商品行即可定位并填写实盘数量；新增待盘点商品排在前面。</p></div><div className="stocktake-counter"><small>待调整</small><strong>{changed.length}</strong><span>种商品</span></div></section>
      <section className="panel data-panel">
        <div className="table-toolbar stocktake-toolbar"><label className="search-box"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索需要盘点的商品" /></label><label className="purpose-field"><span>盘点说明</span><input value={purpose} onChange={(event) => setPurpose(event.target.value)} /></label></div>
        <div className="stocktake-table">
          <div className="table-head"><span>商品</span><span>账面数量</span><span>实盘数量</span><span>盘盈 / 盘亏</span></div>
          {filtered.map((product) => {
            const current = counts[product.id];
            const difference = current === undefined || current === "" ? 0 : Number(current) - product.current_stock;
            return <div className={`table-row ${product.id === selectedProductId ? "selected" : ""}`} key={product.id} onClick={() => setSelectedProductId(product.id)}><div className="product-identity"><span>{product.name.slice(0, 1)}</span><div><strong>{product.name}</strong><small>{product.code}</small></div></div><div className="book-quantity"><b>{product.current_stock}</b> {product.unit}</div><label className="count-input" onClick={(event) => event.stopPropagation()}><input autoFocus={product.id === selectedProductId} min="0" step="1" inputMode="numeric" value={current ?? ""} onChange={(event) => { setCounts((values) => ({ ...values, [product.id]: event.target.value })); setError(""); }} placeholder={String(product.current_stock)} /><span>{product.unit}</span></label><div className={`difference ${difference > 0 ? "positive" : difference < 0 ? "negative" : ""}`}>{difference === 0 ? "—" : `${difference > 0 ? "+" : ""}${difference} ${product.unit}`}</div></div>;
          })}
        </div>
        {error && <div className="form-error"><span>!</span>{error}</div>}
        <div className="stocktake-footer"><p>会提交数量有差异的商品，以及已填写的“新增待盘点”商品。</p><button className="primary-button" disabled={saving} onClick={() => void submit()}>{saving ? "正在生成盘点单…" : `提交盘点（${changed.length}项）`}</button></div>
      </section>
    </div>
  );
}

function ReportsView({ data, onBack }: { data: AppData; onBack: () => void }) {
  const [period, setPeriod] = useState<"day" | "month" | "year">("day");
  const active = data.documents.filter((document) => document.status === "active");
  const today = new Date();
  const filtered = active.filter((document) => {
    const value = new Date(document.effective_at);
    if (period === "day") return value.toDateString() === today.toDateString();
    if (period === "month") return value.getFullYear() === today.getFullYear() && value.getMonth() === today.getMonth();
    return value.getFullYear() === today.getFullYear();
  });
  const inbound = filtered.filter((document) => document.type === "inbound");
  const outbound = filtered.filter((document) => document.type === "outbound");
  const stocktakes = filtered.filter((document) => document.type === "stocktake");
  const inQty = inbound.reduce((sum, document) => sum + document.items.reduce((inner, item) => inner + item.quantity, 0), 0);
  const outQty = outbound.reduce((sum, document) => sum + document.items.reduce((inner, item) => inner + item.quantity, 0), 0);
  const inValue = inbound.reduce((sum, document) => sum + document.items.reduce((inner, item) => inner + item.quantity * (item.unit_price_cents ?? 0), 0), 0);
  const outValue = outbound.reduce((sum, document) => sum + document.items.reduce((inner, item) => inner + item.quantity * (item.unit_cost_cents ?? 0), 0), 0);
  const labels = { day: "日报", month: "月报", year: "年报" };
  return (
    <div className="page-stack">
      <section className="page-heading report-heading"><div><button className="secondary-button product-back page-back" onClick={onBack}>← 返回查看库存</button><p className="eyebrow">库存汇总</p><h1>库存报表</h1><p>按当前日期快速生成日报、月报或年报。</p></div><button className="export-button" onClick={() => exportExcel(data.products, filtered, data.currentUser.role !== "viewer", `库存${labels[period]}-${new Date().toISOString().slice(0, 10)}.xls`, data.statusDefinitions)}>⇩ 导出 Excel</button></section>
      <div className="period-tabs">{(["day", "month", "year"] as const).map((item) => <button key={item} className={period === item ? "active" : ""} onClick={() => setPeriod(item)}>{labels[item]}</button>)}</div>
      <section className="report-cards">
        <article><span className="report-icon inbound">↘</span><div><small>入库数量</small><strong>{number(inQty)} <em>件</em></strong><p>{inbound.length} 张入库单</p></div>{data.currentUser.role !== "viewer" && <b>{money(inValue)}</b>}</article>
        <article><span className="report-icon outbound">↗</span><div><small>出库数量</small><strong>{number(outQty)} <em>件</em></strong><p>{outbound.length} 张出库单</p></div>{data.currentUser.role !== "viewer" && <b>{money(outValue)}</b>}</article>
        <article><span className="report-icon stocktake">✓</span><div><small>盘点调整</small><strong>{stocktakes.length} <em>次</em></strong><p>{stocktakes.reduce((sum, document) => sum + document.items.length, 0)} 项盘盈盘亏</p></div></article>
      </section>
      <section className="panel data-panel">
        <div className="panel-heading"><div><p className="eyebrow">{labels[period]}明细</p><h2>{fullDate(new Date().toISOString())}</h2></div><span className="count-pill">{filtered.length}</span></div>
        {filtered.length ? <div className="report-list">{filtered.map((document) => <div key={document.id}><span className={`activity-icon ${document.type}`}>{document.type === "inbound" ? "↘" : document.type === "outbound" ? "↗" : "✓"}</span><div><strong>{document.document_no}</strong><p>{document.items.map((item) => item.product_name).slice(0, 2).join("、")}{document.items.length > 2 ? "等" : ""}</p></div><span>{document.items.reduce((sum, item) => sum + Math.abs(item.quantity), 0)} 件</span>{data.currentUser.role !== "viewer" && <b>{document.type === "inbound" ? money(document.items.reduce((sum, item) => sum + item.quantity * (item.unit_price_cents ?? 0), 0)) : document.type === "outbound" ? money(document.items.reduce((sum, item) => sum + item.quantity * (item.unit_cost_cents ?? 0), 0)) : "—"}</b>}<small>{dateTime(document.effective_at)}</small></div>)}</div> : <EmptyState title={`暂无${labels[period]}数据`} detail="该时间范围内还没有有效的出入库或盘点单据。" />}
      </section>
    </div>
  );
}

function RecordsView({
  data,
  onRefresh,
  onEdit,
}: {
  data: AppData;
  onRefresh: (message: string) => Promise<void>;
  onEdit: (document: WarehouseDocument) => void;
}) {
  const [filter, setFilter] = useState<"all" | WarehouseDocument["type"]>("all");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState("");
  const visible = data.documents.filter((document) => {
    const matchesType = filter === "all" || document.type === filter;
    const haystack = `${document.document_no} ${document.purpose} ${document.items.map((item) => `${item.product_code} ${item.product_name}`).join(" ")}`.toLowerCase();
    return matchesType && haystack.includes(query.toLowerCase());
  });
  async function voidRecord(document: WarehouseDocument) {
    if (!window.confirm(`确认撤销 ${document.document_no}？\n系统会保留原记录并重新计算全部后续库存。`)) return;
    setBusy(document.id);
    try { await apiPost({ action: "void-document", documentId: document.id }); await onRefresh(`已撤销 ${document.document_no}，库存已重新计算。`); }
    catch (error) { window.alert(error instanceof Error ? error.message : "撤销失败。"); }
    finally { setBusy(""); }
  }
  return (
    <div className="page-stack">
      <section className="page-heading"><div><p className="eyebrow">完整追溯</p><h1>流水记录</h1><p>原单据不会彻底删除，修改前后内容、操作账号和时间均会保留。</p></div></section>
      <section className="panel data-panel">
        <div className="table-toolbar records-toolbar"><div className="filter-tabs">{(["all", "inbound", "outbound", "stocktake"] as const).map((item) => <button key={item} className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>{item === "all" ? "全部" : typeLabel(item)}</button>)}</div><label className="search-box"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索单号、商品或用途" /></label></div>
        {visible.length ? <div className="record-list">{visible.map((document) => <article key={document.id} className={document.status !== "active" ? "inactive" : ""}>
          <div className="record-main"><span className={`activity-icon ${document.type}`}>{document.type === "inbound" ? "↘" : document.type === "outbound" ? "↗" : "✓"}</span><div><div className="record-title"><strong>{document.document_no}</strong><span className={`record-status ${document.status}`}>{document.status === "active" ? "有效" : document.status === "voided" ? "已撤销" : "已修改"}</span></div><p>{typeLabel(document.type)} · {document.purpose || "未填写用途"} · {document.operator_name}</p></div></div>
          <div className="record-items">{document.items.slice(0, 3).map((item) => <span key={item.id}>{item.product_name} <b>{document.type === "outbound" ? "−" : document.type === "inbound" ? "+" : ""}{Math.abs(item.quantity)}{item.product_unit}</b></span>)}{document.items.length > 3 && <em>另 {document.items.length - 3} 种</em>}</div>
          <div className="record-meta"><span>{dateTime(document.effective_at)}</span>{data.currentUser.role === "admin" && document.status === "active" && <div><button onClick={() => onEdit(document)} disabled={document.type === "stocktake"}>修改</button><button className="danger-text" disabled={busy === document.id} onClick={() => void voidRecord(document)}>{busy === document.id ? "处理中" : "撤销"}</button></div>}</div>
        </article>)}</div> : <EmptyState title="没有匹配的流水" detail="请调整类型或搜索条件。" />}
      </section>
    </div>
  );
}

function ProductsView({ data, onRefresh }: { data: AppData; onRefresh: (message: string) => Promise<void> }) {
  const [showCreate, setShowCreate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [query, setQuery] = useState("");
  const [savingId, setSavingId] = useState("");
  const [groupBySupplier, setGroupBySupplier] = useState(() => typeof window !== "undefined" && localStorage.getItem("warehouse-products-group-by-supplier") === "true");
  const [selectedSupplier, setSelectedSupplier] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { status: string; minStock: string; supplier: string }>>({});
  const filtered = data.products.filter((product) => `${product.code} ${product.name}`.toLowerCase().includes(query.toLowerCase()));
  function draft(product: Product) { return drafts[product.id] ?? { status: product.status, minStock: String(product.min_stock), supplier: product.default_supplier_name ?? "" }; }
  function toggleGrouping() {
    const next = !groupBySupplier;
    setGroupBySupplier(next); localStorage.setItem("warehouse-products-group-by-supplier", String(next));
    if (!next) setSelectedSupplier(null);
  }
  async function saveProduct(product: Product) {
    const values = draft(product); setSavingId(product.id);
    try { await apiPost({ action: "update-product", id: product.id, status: values.status, minStock: Number(values.minStock), defaultSupplierName: values.supplier }); await onRefresh(`${product.name}的资料已更新。`); }
    catch (error) { window.alert(error instanceof Error ? error.message : "更新失败。"); }
    finally { setSavingId(""); }
  }
  const grouped = filtered.reduce<Record<string, Product[]>>((result, product) => {
    const supplier = product.default_supplier_name || "未设置供应商";
    (result[supplier] ??= []).push(product); return result;
  }, {});
  const displayed = selectedSupplier ? (grouped[selectedSupplier] ?? []) : filtered;
  return (
    <div className="page-stack">
      <section className="page-heading"><div>{selectedSupplier && <button className="secondary-button product-back" onClick={() => setSelectedSupplier(null)}>← 返回供应商分类</button>}<p className="eyebrow">{selectedSupplier ? "供应商商品资料" : "商品主数据"}</p><h1>{selectedSupplier ?? "商品资料"}</h1><p>{selectedSupplier ? `该供应商下共 ${displayed.length} 种商品。` : "编号可人工填写或由系统生成；默认供应商可随时调整。"}</p></div><div className="heading-stats product-heading-actions"><button className={`secondary-button ${groupBySupplier ? "active-toggle" : ""}`} onClick={toggleGrouping}>按供应商分类：{groupBySupplier ? "已开启" : "已关闭"}</button><button className="secondary-button" onClick={() => downloadTemplate("仓储台-商品批量导入模板.xlsx")}>下载导入模板</button><button className="import-button" onClick={() => setShowImport(true)}>Excel 批量导入</button><button className="primary-button" onClick={() => setShowCreate(true)}>＋ 新增商品</button></div></section>
      <section className="panel data-panel">
        {!selectedSupplier && <div className="table-toolbar"><label className="search-box"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索商品" /></label><span className="result-count">{filtered.length} 种商品</span></div>}
        {groupBySupplier && !selectedSupplier ? <div className="supplier-group-list product-supplier-list">{Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b, "zh-CN")).map(([supplier, products]) => <button className="supplier-group-card" key={supplier} onClick={() => setSelectedSupplier(supplier)}><strong>{supplier}</strong><span><small>商品种类</small><b>{products.length} 种</b></span></button>)}</div> : displayed.length ? <div className="data-table product-master-table"><div className="table-head"><span>商品编号</span><span>商品名称</span><span>默认供应商</span><span>状态</span><span>最低库存</span><span>操作</span></div>{displayed.map((product) => { const values = draft(product); const changed = values.status !== product.status || values.minStock !== String(product.min_stock) || values.supplier !== (product.default_supplier_name ?? ""); return <div className="table-row product-master-main" key={product.id}>
          <div className="master-code"><strong>{product.code}</strong></div><div className="master-name"><strong>{product.name}</strong></div><label className="master-supplier"><input list="supplier-options-product" value={values.supplier} onChange={(event) => setDrafts((current) => ({ ...current, [product.id]: { ...values, supplier: event.target.value } }))} placeholder="未设置供应商" /></label>
          <select className="master-status" value={values.status} onChange={(event) => setDrafts((current) => ({ ...current, [product.id]: { ...values, status: event.target.value } }))}>{data.statusDefinitions.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}</select>
          <label className="master-min"><input type="number" min="0" step="1" value={values.minStock} onChange={(event) => setDrafts((current) => ({ ...current, [product.id]: { ...values, minStock: event.target.value } }))} /></label>
          <button className="save-inline" disabled={!changed || savingId === product.id} onClick={() => void saveProduct(product)}>{savingId === product.id ? "保存中" : "保存"}</button>
        </div>; })}<datalist id="supplier-options-product">{data.suppliers.map((supplier) => <option value={supplier.name} key={supplier.id} />)}</datalist></div> : <EmptyState title={selectedSupplier ? "该供应商暂无商品" : "还没有商品资料"} detail={selectedSupplier ? "请返回供应商分类后选择其他供应商。" : "新增第一个商品后即可开始入库。"} />}
      </section>
      {showCreate && <CreateProductModal suppliers={data.suppliers} statusDefinitions={data.statusDefinitions} preferences={data.preferences ?? DEFAULT_PREFERENCES} onClose={() => setShowCreate(false)} onCreated={async (message) => { setShowCreate(false); await onRefresh(message); }} />}
      {showImport && <ProductImportDialog onClose={() => setShowImport(false)} onImported={async (message) => { setShowImport(false); await onRefresh(message); }} />}
    </div>
  );
}

function CreateProductModal({ suppliers, statusDefinitions, preferences, initialName = "", initialSupplier = "", onClose, onCreated }: { suppliers: Supplier[]; statusDefinitions: StatusDefinition[]; preferences: WarehousePreferences; initialName?: string; initialSupplier?: string; onClose: () => void; onCreated: (message: string, code: string) => Promise<void> }) {
  const [form, setForm] = useState({ codeMode: "auto", code: "", name: initialName, unit: "件", minStock: "0", initialStock: "0", status: statusDefinitions.find((item) => item.id === "normal")?.id ?? statusDefinitions[0]?.id ?? "normal", defaultSupplier: initialSupplier, alternates: "" });
  const [saving, setSaving] = useState(false); const [error, setError] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setError("");
    try { const result = await apiPost({ action: "add-product", name: form.name, code: form.codeMode === "manual" ? form.code : "", codePrefix: preferences.productCodePrefix, unit: form.unit, minStock: Number(form.minStock), initialStock: Number(form.initialStock), status: form.status, defaultSupplierName: form.defaultSupplier, alternateSuppliers: form.alternates.split(/[，,]/).map((item) => item.trim()).filter(Boolean) }); await onCreated(`商品已建立：${form.name}（${String(result.code)}）`, String(result.code)); }
    catch (submitError) { setError(submitError instanceof Error ? submitError.message : "新增失败。"); }
    finally { setSaving(false); }
  }
  return <div className="modal-backdrop" role="dialog" aria-modal="true"><form className="modal-card product-modal" onSubmit={submit}><div className="modal-heading"><div><p className="eyebrow">商品主数据</p><h2>新增商品</h2></div><button type="button" className="close-button" onClick={onClose}>×</button></div>
    <div className="code-mode"><button type="button" className={form.codeMode === "auto" ? "active" : ""} onClick={() => setForm({ ...form, codeMode: "auto" })}><b>系统生成</b><span>例如 {(preferences.productCodePrefix ? `${preferences.productCodePrefix}-` : "")}000001</span></button><button type="button" className={form.codeMode === "manual" ? "active" : ""} onClick={() => setForm({ ...form, codeMode: "manual" })}><b>人工填写</b><span>重复编号会被拦截</span></button></div>
    <div className="modal-form-grid">{form.codeMode === "manual" && <label><span>商品编号</span><input required value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} placeholder="例如 WL-2026-001" /></label>}<label className={form.codeMode === "auto" ? "wide" : ""}><span>商品名称</span><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="输入品名" /></label><label><span>默认供应商</span><input list="new-product-suppliers" value={form.defaultSupplier} onChange={(event) => setForm({ ...form, defaultSupplier: event.target.value })} placeholder="选择或新建" /></label><label><span>供应状态</span><select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}>{statusDefinitions.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label><label><span>最低库存</span><input required type="number" min="0" step="1" value={form.minStock} onChange={(event) => setForm({ ...form, minStock: event.target.value })} /></label><label><span>初始库存</span><input required type="number" min="0" step="1" value={form.initialStock} onChange={(event) => setForm({ ...form, initialStock: event.target.value })} /></label><label className="wide"><span>单位</span><input required value={form.unit} onChange={(event) => setForm({ ...form, unit: event.target.value })} /></label><label className="wide"><span>替代供应商 <em>多个名称用逗号分隔</em></span><input value={form.alternates} onChange={(event) => setForm({ ...form, alternates: event.target.value })} placeholder="例如：华东备选供应、同城急送" /></label><datalist id="new-product-suppliers">{suppliers.map((item) => <option value={item.name} key={item.id} />)}</datalist></div>
    {error && <div className="form-error"><span>!</span>{error}</div>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving}>{saving ? "正在保存…" : "建立商品"}</button></div>
  </form></div>;
}

function ProductImportDialog({ onClose, onImported }: { onClose: () => void; onImported: (message: string) => Promise<void> }) {
  const [rows, setRows] = useState<Array<Record<string, string>>>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  async function read(file: File) {
    const raw = /\.xlsx$/i.test(file.name) ? await parseXlsxRows(file, 2) : /\.csv$/i.test(file.name) ? parseCsv(await file.text()) : [];
    if (!raw.length) return setError("请选择商品导入模板的 .xlsx 或 CSV 文件。");
    const headers = raw.shift()?.map((value) => value.replace(/^\ufeff/, "")) ?? [];
    const required = ["商品名称", "最低库存", "初始库存"];
    if (!required.every((name) => headers.includes(name))) return setError("模板列不完整，请使用“下载导入模板”生成的文件。");
    const parsed = raw.map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""]))).filter((row) => row["商品名称"]);
    if (!parsed.length) return setError("没有读取到商品资料。");
    setRows(parsed); setError("");
  }

  async function submit() {
    if (!rows.length) return setError("请先选择导入文件。");
    setSaving(true); setError("");
    try {
      for (const row of rows) await apiPost({ action: "add-product", code: row["商品编号"], name: row["商品名称"], defaultSupplierName: row["默认供应商"], statusLabel: row["供货状态"] || row["供应状态"], minStock: Number(row["最低库存"] || 0), initialStock: Number(row["期初库存"] || row["初始库存"] || 0), unit: row["单位"] || "件" });
      await onImported(`已导入 ${rows.length} 种商品。`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "导入失败，请检查数据。"); }
    finally { setSaving(false); }
  }
  return <div className="modal-backdrop" role="dialog" aria-modal="true"><div className="modal-card import-dialog"><div className="modal-heading"><div><p className="eyebrow">导入前检查</p><h2>商品资料批量导入</h2></div><button className="close-button" onClick={onClose}>×</button></div><label className="upload-zone"><input type="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" onChange={(event) => { const file = event.target.files?.[0]; if (file) void read(file); }} /><strong>选择商品批量导入模板</strong><small>支持离线版同款 XLSX 模板；已有编号会被拦截，不会覆盖原商品。</small></label>{rows.length > 0 && <div className="import-preview-note">已检查 {rows.length} 行商品资料，确认后开始新增。</div>}{error && <div className="form-error"><span>!</span>{error}</div>}<div className="modal-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving || !rows.length} onClick={() => void submit()}>{saving ? "正在导入…" : "确认批量导入"}</button></div></div></div>;
}

function RecipesView({ data, onRefresh }: { data: AppData; onRefresh: (message: string) => Promise<void> }) {
  const [selectedId, setSelectedId] = useState("");
  const [showEditor, setShowEditor] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [busy, setBusy] = useState(false);
  const selected = data.recipes.find((item) => item.id === selectedId);
  const canEdit = data.currentUser.role === "admin";
  const productById = useMemo(() => new Map(data.products.map((product) => [product.id, product])), [data.products]);
  const maximum = (recipe: Recipe) => recipe.components.reduce((limit, component) => {
    const product = productById.get(component.productId);
    return Math.min(limit, product ? Math.floor(product.current_stock / component.quantity) : 0);
  }, Number.MAX_SAFE_INTEGER);

  async function order(quantity: number) {
    if (!selected || quantity < 1 || !Number.isInteger(quantity)) return;
    setBusy(true);
    try {
      const result = await apiPost({ action: "order-recipe", recipeId: selected.id, quantity });
      await onRefresh(`已完成一键配料：${selected.name} × ${quantity}（${String(result.documentNo)}）`);
    } catch (error) { window.alert(error instanceof Error ? error.message : "配料下单失败。 "); }
    finally { setBusy(false); }
  }

  async function save(recipe: Recipe) {
    const exists = data.recipes.some((item) => item.id === recipe.id);
    const recipes = exists ? data.recipes.map((item) => item.id === recipe.id ? recipe : item) : [...data.recipes, recipe];
    try { await apiPost({ action: "save-recipes", recipes }); setShowEditor(false); setSelectedId(recipe.id); await onRefresh(`产品配方已保存：${recipe.name}`); }
    catch (error) { window.alert(error instanceof Error ? error.message : "保存配方失败。 "); }
  }

  if (selected) {
    const canOrder = maximum(selected);
    return <div className="page-stack">
      <section className="page-heading"><div><button className="secondary-button product-back" onClick={() => setSelectedId("")}>← 返回一键配料</button><p className="eyebrow">产品配方详情</p><h1>{selected.name}</h1></div>{canEdit && <button className="export-button" onClick={() => setShowEditor(true)}>编辑配方</button>}</section>
      <section className="recipe-order-panel"><div><small>可下单数量</small><strong>{Number.isFinite(canOrder) ? canOrder : 0} 件</strong><p>由库存最少的配件决定</p></div>{canEdit && <RecipeOrderControl disabled={busy || canOrder < 1} onOrder={order} />}</section>
      <section className="panel recipe-detail-table"><div className="table-head"><span>配件品类</span><span>每件用量</span><span>货架位置</span><span>供应商</span><span>备注</span></div>{selected.components.map((component) => { const product = productById.get(component.productId); return <div className="table-row" key={component.productId}><strong>{product?.name ?? "配件已移除"}</strong><b>{component.quantity}</b><span>{component.shelfLocation || "—"}</span><span>{component.supplier || product?.default_supplier_name || "—"}</span><span>{component.remark || "—"}</span></div>; })}</section>
      {showEditor && <RecipeEditor products={data.products} recipe={selected} onClose={() => setShowEditor(false)} onSave={save} />}
    </div>;
  }

  return <div className="page-stack">
    <section className="page-heading"><div><p className="eyebrow">产品配方 · 自动扣料</p><h1>一键配料</h1><p>一个产品对应一份配方；下单时按每件用量自动扣减全部配件库存。</p></div>{canEdit && <div className="product-heading-actions"><button className="primary-button" onClick={() => setShowEditor(true)}>＋ 新增产品配方</button><button className="secondary-button" onClick={() => downloadTemplate("仓储台-一键配料导入模板.xlsx")}>下载配料模板</button><button className="export-button" onClick={() => setShowImport(true)}>导入产品配方</button></div>}</section>
    <section className="panel data-table recipe-list-table">{data.recipes.length ? <><div className="table-head"><span>产品名称</span><span>配件种类</span><span>可下单</span><span>操作</span></div>{data.recipes.map((recipe) => <button className="table-row" key={recipe.id} onClick={() => setSelectedId(recipe.id)}><strong>{recipe.name}</strong><b>{recipe.components.length} 种</b><b>{maximum(recipe)} 件</b><i>→</i></button>)}</> : <EmptyState title="还没有产品配方" detail={canEdit ? "新增产品配方后，即可按配方一键扣减配件库存。" : "请由管理员新增产品配方。"} />}</section>
    {showEditor && <RecipeEditor products={data.products} onClose={() => setShowEditor(false)} onSave={save} />}
    {showImport && <RecipeImportDialog data={data} onClose={() => setShowImport(false)} onImported={async (message) => { setShowImport(false); await onRefresh(message); }} />}
  </div>;
}

function RecipeImportDialog({ data, onClose, onImported }: { data: AppData; onClose: () => void; onImported: (message: string) => Promise<void> }) {
  const [rows, setRows] = useState<Array<Record<string, string>>>([]);
  const [error, setError] = useState(""); const [saving, setSaving] = useState(false);
  async function read(file: File) {
    const isXlsx = /\.xlsx$/i.test(file.name);
    const raw = isXlsx ? await parseXlsxRows(file, 2) : /\.csv$/i.test(file.name) ? parseCsv(await file.text()) : [];
    if (!raw.length) return setError("请选择配料导入模板的 .xlsx 或 CSV 文件。");
    const headers = raw.shift()?.map((value) => value.replace(/^\ufeff/, "")) ?? [];
    const productName = isXlsx ? (raw[2]?.[7] ?? "").trim() : "";
    if (isXlsx) raw.splice(2, 1);
    if (!["配件品类", "每件用量"].every((header) => headers.includes(header)) || (!isXlsx && !headers.includes("产品名称")) || (isXlsx && !productName)) return setError("模板内容不完整，请在配方导入页右侧第 4 行填写产品名称。");
    const parsed = raw.map((cells) => ({ ...Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""])), 产品名称: isXlsx ? productName : cells[headers.indexOf("产品名称")] ?? "" })).filter((row) => row["产品名称"] || row["配件品类"]);
    if (!parsed.length || parsed.some((row) => !row["产品名称"] || !row["配件品类"] || !Number.isInteger(Number(row["每件用量"])) || Number(row["每件用量"]) < 1)) return setError("每一行都必须填写产品名称、配件品类和正整数每件用量。");
    setRows(parsed); setError("");
  }
  async function submit() {
    if (!rows.length) return; setSaving(true); setError("");
    try {
      let latest = withStatusDefinitions(await loadCloudbaseWarehouse() as AppData);
      const known = new Map(latest.products.map((product) => [product.name.trim(), product]));
      for (const name of [...new Set(rows.map((row) => row["配件品类"].trim()))]) {
        if (!known.has(name)) await apiPost({ action: "add-product", name, unit: "件", minStock: 0, initialStock: 0, status: "pending_stocktake", defaultSupplierName: rows.find((row) => row["配件品类"].trim() === name)?.["供应商（选填）"] ?? "", codePrefix: latest.preferences?.productCodePrefix ?? "ZERO" });
      }
      latest = withStatusDefinitions(await loadCloudbaseWarehouse() as AppData);
      const byName = new Map(latest.products.map((product) => [product.name.trim(), product]));
      const imported = new Map<string, Recipe>();
      for (const row of rows) { const name = row["产品名称"].trim(); const recipe = imported.get(name) ?? { id: crypto.randomUUID(), name, components: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; const product = byName.get(row["配件品类"].trim()); if (!product) throw new Error(`找不到配件：${row["配件品类"]}`); recipe.components.push({ productId: product.id, quantity: Number(row["每件用量"]), shelfLocation: row["货架位置（选填）"] ?? "", supplier: row["供应商（选填）"] ?? "", remark: row["备注（选填）"] ?? "" }); imported.set(name, recipe); }
      const retained = latest.recipes.filter((recipe) => !imported.has(recipe.name));
      await apiPost({ action: "save-recipes", recipes: [...retained, ...imported.values()] });
      await onImported(`已导入 ${imported.size} 个产品配方。`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "导入失败，请检查内容。"); }
    finally { setSaving(false); }
  }
  return <div className="modal-backdrop" role="dialog" aria-modal="true"><div className="modal-card import-dialog"><div className="modal-heading"><div><p className="eyebrow">配方导入检查</p><h2>产品配件结构预览</h2></div><button className="close-button" onClick={onClose}>×</button></div><label className="upload-zone"><input type="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" onChange={(event) => { const file = event.target.files?.[0]; if (file) void read(file); }} /><strong>选择一键配料导入模板</strong><small>库存中没有的配件会自动新增为“新增待盘点”。</small></label>{rows.length > 0 && <><div className="import-preview-note">已读取 {rows.length} 行配件；请确认预览后导入。</div><div className="import-preview-table"><div><span>产品</span><span>配件品类</span><span>每件用量</span><span>货架位置</span><span>供应商</span><span>备注</span></div>{rows.map((row, index) => <div key={index}><b>{row["产品名称"]}</b><b>{row["配件品类"]}</b><b>{row["每件用量"]}</b><span>{row["货架位置（选填）"] || "—"}</span><span>{row["供应商（选填）"] || "—"}</span><span>{row["备注（选填）"] || "—"}</span></div>)}</div></>}{error && <div className="form-error"><span>!</span>{error}</div>}<div className="modal-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving || !rows.length} onClick={() => void submit()}>{saving ? "正在导入…" : "确认导入配方"}</button></div></div></div>;
}

function RecipeOrderControl({ disabled, onOrder }: { disabled: boolean; onOrder: (quantity: number) => Promise<void> }) {
  const [quantity, setQuantity] = useState("1");
  return <div className="recipe-order-control"><label><span>下单产品数量</span><input min="1" step="1" inputMode="numeric" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label><button className="primary-button" disabled={disabled} onClick={() => void onOrder(Number(quantity))}>确认下单并扣减配件</button></div>;
}

function RecipeEditor({ products, recipe, onClose, onSave }: { products: Product[]; recipe?: Recipe; onClose: () => void; onSave: (recipe: Recipe) => Promise<void> }) {
  const [name, setName] = useState(recipe?.name ?? "");
  const [components, setComponents] = useState<Array<{ productId: string; quantity: string; shelfLocation: string; supplier: string; remark: string }>>(recipe?.components.map((component) => ({ ...component, quantity: String(component.quantity) })) ?? [{ productId: "", quantity: "1", shelfLocation: "", supplier: "", remark: "" }]);
  const [error, setError] = useState("");
  const update = (index: number, patch: Partial<(typeof components)[number]>) => setComponents((current) => current.map((component, componentIndex) => componentIndex === index ? { ...component, ...patch } : component));
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const clean = components.map((component) => ({ ...component, productId: component.productId.trim(), quantity: Number(component.quantity) }));
    if (!name.trim() || clean.some((component) => !component.productId || !Number.isInteger(component.quantity) || component.quantity < 1)) return setError("请填写产品名称、配件品类和每件用量。 ");
    if (new Set(clean.map((component) => component.productId)).size !== clean.length) return setError("同一产品配方不能重复选择同一种配件。 ");
    await onSave({ id: recipe?.id ?? crypto.randomUUID(), name: name.trim(), components: clean, createdAt: recipe?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() });
  }
  return <div className="modal-backdrop" role="dialog" aria-modal="true"><form className="modal-card recipe-modal" onSubmit={submit}><div className="modal-heading"><div><p className="eyebrow">{recipe ? "修改产品配方" : "新建产品配方"}</p><h2>产品配件结构</h2></div><button type="button" className="close-button" onClick={onClose}>×</button></div><label className="recipe-name-field"><span>产品名称 *</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：成套焊机" /></label><div className="recipe-edit-head"><span>配件品类 *</span><span>每件用量 *</span><span>货架位置（选填）</span><span>供应商（选填）</span><span>备注（选填）</span><span /></div><div className="recipe-editor-list">{components.map((component, index) => <div key={index}><select value={component.productId} onChange={(event) => update(index, { productId: event.target.value })}><option value="">选择库存商品</option>{products.map((product) => <option key={product.id} value={product.id}>{product.name}（{product.code}）</option>)}</select><input type="number" min="1" step="1" value={component.quantity} onChange={(event) => update(index, { quantity: event.target.value })} /><input value={component.shelfLocation} onChange={(event) => update(index, { shelfLocation: event.target.value })} /><input value={component.supplier} onChange={(event) => update(index, { supplier: event.target.value })} /><input value={component.remark} onChange={(event) => update(index, { remark: event.target.value })} />{components.length > 1 ? <button type="button" onClick={() => setComponents((current) => current.filter((_, componentIndex) => componentIndex !== index))}>×</button> : <span />}</div>)}</div><button type="button" className="secondary-button recipe-add" onClick={() => setComponents((current) => [...current, { productId: "", quantity: "1", shelfLocation: "", supplier: "", remark: "" }])}>＋ 添加配件</button>{error && <div className="form-error"><span>!</span>{error}</div>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button">保存配方</button></div></form></div>;
}

function SettingsView({ data, onRefresh }: { data: AppData; onRefresh: (message: string) => Promise<void> }) {
  const [definitions, setDefinitions] = useState<StatusDefinition[]>(data.statusDefinitions.length ? data.statusDefinitions : DEFAULT_STATUS_DEFINITIONS);
  const [fontScale, setFontScale] = useState(() => typeof window === "undefined" ? "1" : localStorage.getItem("warehouse-online-font-scale") ?? "1");
  const [preferences, setPreferences] = useState<WarehousePreferences>(data.preferences ?? DEFAULT_PREFERENCES);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setDefinitions(data.statusDefinitions.length ? data.statusDefinitions : DEFAULT_STATUS_DEFINITIONS);
    setPreferences(data.preferences ?? DEFAULT_PREFERENCES);
  }, [data.statusDefinitions]);

  function applyFontScale(value: string) {
    setFontScale(value); localStorage.setItem("warehouse-online-font-scale", value);
    document.documentElement.style.setProperty("--warehouse-font-scale", value);
  }

  async function savePreferences() {
    setSaving(true); setError("");
    try { await apiPost({ action: "save-preferences", preferences }); await onRefresh("编号前缀和出库计价方式已保存。"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败，请重试。"); }
    finally { setSaving(false); }
  }

  function update(id: string, patch: Partial<StatusDefinition>) {
    setDefinitions((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  }

  function add() {
    const id = `custom_${Date.now().toString(36)}`;
    setDefinitions((current) => [...current, { id, label: "新状态", color: "#3377C8" }]);
  }

  function remove(id: string) {
    const item = definitions.find((entry) => entry.id === id);
    if (!item || item.system) return;
    setDefinitions((current) => current.filter((entry) => entry.id !== id));
  }

  async function save() {
    const names = definitions.map((item) => item.label.trim());
    if (!definitions.length || names.some((name) => !name)) return setError("请填写每个状态名称。");
    if (new Set(names).size !== names.length) return setError("状态名称不能重复。");
    setSaving(true); setError("");
    try {
      await apiPost({ action: "save-status-definitions", statusDefinitions: definitions.map((item) => ({ ...item, label: item.label.trim() })) });
      await onRefresh("商品状态设置已保存。");
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "保存失败，请重试。");
    } finally { setSaving(false); }
  }

  return <div className="page-stack">
    <section className="page-heading"><div><p className="eyebrow">业务规则</p><h1>设置</h1><p>可按业务需要新增、改名或移除商品状态，并为每种状态选择提示颜色。</p></div></section>
    <section className="panel settings-panel preference-panel"><div className="panel-heading"><div><p className="eyebrow">显示与计算</p><h2>全局显示、编号和出库计价</h2></div></div><div className="preference-grid"><div><b>全局字体大小</b><p>只调整右侧业务页面，左侧工具栏宽度保持不变。</p><div className="font-scale-options">{[["1", "标准", "100%"], ["1.2", "较大", "120%"], ["1.5", "特大", "150%"]].map(([value, label, note]) => <button key={value} className={fontScale === value ? "active" : ""} onClick={() => applyFontScale(value)}><strong>{label}</strong><span>{note}</span></button>)}</div></div><label><b>商品编号前缀</b><p>影响以后自动生成的商品编号；留空则不使用前缀。</p><input value={preferences.productCodePrefix} maxLength={20} onChange={(event) => setPreferences({ ...preferences, productCodePrefix: event.target.value })} placeholder="例如 ZERO" /><small>下一个编号示例：{preferences.productCodePrefix ? `${preferences.productCodePrefix}-` : ""}000001</small></label><div><b>出库计价方式</b><p>选择后，之后新建的出库单按该规则记录成本。</p><div className="cost-method-options">{[["weighted", "移动加权平均"], ["fifo", "先进先出"], ["lastInbound", "最近入库价"]].map(([value, label]) => <button key={value} className={preferences.outboundCostMethod === value ? "active" : ""} onClick={() => setPreferences({ ...preferences, outboundCostMethod: value as CostMethod })}>{label}</button>)}</div></div></div><div className="settings-actions"><button className="primary-button" disabled={saving} onClick={() => void savePreferences()}>{saving ? "正在保存…" : "保存显示与计价设置"}</button></div></section>
    <section className="panel settings-panel">
      <div className="panel-heading"><div><p className="eyebrow">商品状态</p><h2>状态与颜色</h2></div><button className="secondary-button" onClick={add}>＋ 新增状态</button></div>
      <div className="status-settings-list">
        {definitions.map((item) => <article key={item.id}>
          <span className="status-color-preview" style={{ backgroundColor: item.color }} />
          <label><small>状态名称</small><input value={item.label} maxLength={20} onChange={(event) => update(item.id, { label: event.target.value })} /></label>
          <label className="color-control"><small>显示颜色</small><span><input type="color" value={item.color} onChange={(event) => update(item.id, { color: event.target.value })} /><b>{item.color.toUpperCase()}</b></span></label>
          {item.system ? <em>系统状态</em> : <button className="danger-text" onClick={() => remove(item.id)}>移除</button>}
        </article>)}
      </div>
      {error && <div className="form-error"><span>!</span>{error}</div>}
      <div className="settings-actions"><p>“新增待盘点”是配方导入后自动使用的系统状态，不能移除。</p><button className="primary-button" disabled={saving} onClick={() => void save()}>{saving ? "正在保存…" : "保存状态设置"}</button></div>
    </section>
  </div>;
}

function UsersView({ data, onRefresh }: { data: AppData; onRefresh: (message: string) => Promise<void> }) {
  const [busy, setBusy] = useState("");
  async function change(user: WarehouseUser, role: Role) {
    setBusy(user.id);
    try { await apiPost({ action: "set-role", userId: user.id, role }); await onRefresh(`${user.display_name}已设为${role === "admin" ? "管理员" : "查看者"}。`); }
    catch (error) { window.alert(error instanceof Error ? error.message : "权限修改失败。"); }
    finally { setBusy(""); }
  }
  return <div className="page-stack"><section className="page-heading"><div><p className="eyebrow">账号与可见范围</p><h1>用户权限</h1><p>管理员可操作全部业务；查看者不能执行变动，也无法通过接口或导出查看金额。</p></div></section><section className="role-explainer"><article><span>管</span><div><strong>管理员</strong><p>商品、出入库、盘点、金额、备份与权限管理</p></div></article><article><span>看</span><div><strong>查看者</strong><p>仅查看库存数量、无金额报表与流水记录</p></div></article></section><section className="panel user-list">{data.users.map((user) => <article key={user.id}><div className="avatar">{user.display_name.slice(0, 1).toUpperCase()}</div><div><strong>{user.display_name}{user.id === data.currentUser.id && <em>当前账号</em>}</strong><p>{user.email} · 最近登录 {user.last_seen_at ? dateTime(user.last_seen_at) : "尚未进入真实仓库"}</p></div><select disabled={busy === user.id} value={user.role} onChange={(event) => void change(user, event.target.value as Role)}>{user.role === "pending" && <option value="pending" disabled>待审批</option>}<option value="admin">管理员</option><option value="viewer">查看者</option></select></article>)}</section></div>;
}

function openBackupDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("warehouse-local-backup", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("handles");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storeDirectoryHandle(handle: unknown) {
  const db = await openBackupDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("handles", "readwrite");
    transaction.objectStore("handles").put(handle, "backup-directory");
    transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

async function getDirectoryHandle() {
  const db = await openBackupDb();
  const handle = await new Promise<unknown>((resolve, reject) => {
    const request = db.transaction("handles", "readonly").objectStore("handles").get("backup-directory");
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  db.close(); return handle;
}

async function fetchBackup() {
  return cloudbaseApi({ action: "backup" });
}

async function writeBackupToDirectory(handle: any, askPermission: boolean) {
  const permission = await handle.queryPermission({ mode: "readwrite" });
  if (permission !== "granted") {
    if (!askPermission || (await handle.requestPermission({ mode: "readwrite" })) !== "granted") throw new Error("没有获得备份文件夹的写入权限。");
  }
  const backup = await fetchBackup();
  const today = new Date().toISOString().slice(0, 10);
  const fileHandle = await handle.getFileHandle(`仓库备份-${today}.json`, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(JSON.stringify(backup, null, 2));
  await writable.close();
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30);
  for await (const [name] of handle.entries()) {
    const match = /^仓库备份-(\d{4}-\d{2}-\d{2})\.json$/.exec(name);
    if (match && new Date(match[1]) < cutoff) await handle.removeEntry(name);
  }
  localStorage.setItem("warehouse-last-local-backup", new Date().toISOString());
  localStorage.setItem("warehouse-backup-folder", handle.name || "已选择文件夹");
  return handle.name || "已选择文件夹";
}

function BackupView({ data, onRefresh }: { data: AppData; onRefresh: (message: string) => Promise<void> }) {
  const [folder, setFolder] = useState(() => typeof window === "undefined" ? "" : localStorage.getItem("warehouse-backup-folder") || "");
  const [lastBackup, setLastBackup] = useState(() => typeof window === "undefined" ? "" : localStorage.getItem("warehouse-last-local-backup") || "");
  const [busy, setBusy] = useState("");
  const restoreInput = useRef<HTMLInputElement>(null);
  const supportsFolder = typeof window !== "undefined" && "showDirectoryPicker" in window;
  async function connectFolder() {
    setBusy("folder");
    try {
      const picker = (window as typeof window & { showDirectoryPicker: (options: { mode: string }) => Promise<any> }).showDirectoryPicker;
      const handle = await picker({ mode: "readwrite" });
      await storeDirectoryHandle(handle);
      const name = await writeBackupToDirectory(handle, true);
      setFolder(name); setLastBackup(localStorage.getItem("warehouse-last-local-backup") || "");
    } catch (error) { if ((error as { name?: string }).name !== "AbortError") window.alert(error instanceof Error ? error.message : "选择文件夹失败。"); }
    finally { setBusy(""); }
  }
  async function manualBackup() {
    setBusy("backup");
    try {
      const backup = await fetchBackup();
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `仓库备份-${new Date().toISOString().slice(0, 10)}.json`; anchor.click(); URL.revokeObjectURL(url);
      setLastBackup(new Date().toISOString());
    } catch (error) { window.alert(error instanceof Error ? error.message : "备份失败。"); }
    finally { setBusy(""); }
  }
  async function restore(file: File) {
    if (!window.confirm("恢复备份会用备份内容替换当前商品、单据和流水。现有账号权限会保留。确认继续吗？")) return;
    setBusy("restore");
    try { const backup = JSON.parse(await file.text()); const result = await apiPost({ action: "restore-backup", confirm: "RESTORE", backup }); await onRefresh(`恢复完成，共导入 ${String(result.restored)} 条记录。`); }
    catch (error) { window.alert(error instanceof Error ? error.message : "恢复失败，请检查备份文件。"); }
    finally { setBusy(""); if (restoreInput.current) restoreInput.current.value = ""; }
  }
  return <div className="page-stack"><section className="page-heading"><div><p className="eyebrow">数据安全</p><h1>备份与恢复</h1><p>每周保存到你选择的 Windows 文件夹，并自动清理超过 30 天的旧备份。</p></div></section><section className="backup-grid"><article className="backup-card featured"><span className="backup-icon">↻</span><div><small>每周自动备份</small><h2>{folder ? "本机文件夹已连接" : "连接本机备份文件夹"}</h2><p>{folder ? `保存位置：${folder}。浏览器打开网站时会检查并执行到期备份。` : "首次选择文件夹并授权后，网站才能定期写入备份文件。"}</p>{lastBackup && <em>上次备份：{dateTime(lastBackup)}</em>}</div><button disabled={!supportsFolder || busy === "folder"} onClick={() => void connectFolder()}>{busy === "folder" ? "正在连接…" : folder ? "更换文件夹" : supportsFolder ? "选择文件夹" : "当前浏览器不支持"}</button></article><article className="backup-card"><span className="backup-icon">⇩</span><div><small>立即保存</small><h2>手动下载备份</h2><p>下载完整 JSON 备份到当前电脑，可用于恢复。</p></div><button disabled={busy === "backup"} onClick={() => void manualBackup()}>{busy === "backup" ? "正在生成…" : "下载备份"}</button></article><article className="backup-card"><span className="backup-icon">▤</span><div><small>业务数据</small><h2>全量 Excel 导出</h2><p>包含全部库存和流水；金额仅管理员可导出。</p></div><button onClick={() => exportExcel(data.products, data.documents, true, `仓库全量数据-${new Date().toISOString().slice(0, 10)}.xls`, data.statusDefinitions)}>导出 Excel</button></article><article className="backup-card warning"><span className="backup-icon">↑</span><div><small>谨慎操作</small><h2>从备份恢复</h2><p>恢复前会再次确认，现有历史不会被无提示覆盖。</p></div><button disabled={busy === "restore"} onClick={() => restoreInput.current?.click()}>{busy === "restore" ? "正在恢复…" : "选择备份文件"}</button><input ref={restoreInput} hidden type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void restore(file); }} /></article></section><section className="retention-note"><span>i</span><div><strong>备份策略</strong><p>自动备份间隔 7 天，保留最近 30 天；手动下载的文件由你自行保管。建议使用 Edge 或 Chrome 并保持文件夹授权。</p></div></section></div>;
}

export function WarehouseApp() {
  const [cloudbaseUser, setCloudbaseUser] = useState<{ id: string; email: string; displayName: string; role: string } | null>(null);
  const [data, setData] = useState<AppData | null>(null);
  const [page, setPage] = useState<Page>("home");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [toast, setToast] = useState("");
  const [navOpen, setNavOpen] = useState(false);
  const [editing, setEditing] = useState<WarehouseDocument | null>(null);
  const [selectedProductId, setSelectedProductId] = useState("");
  const [prefillProductId, setPrefillProductId] = useState("");
  const [stocktakeProductId, setStocktakeProductId] = useState("");

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 10000);
  }, []);

  const saveGuestData = useCallback((next: AppData) => {
    const normalized = withStatusDefinitions(next);
    setData(normalized);
    localStorage.setItem("warehouse-guest-demo-v1", JSON.stringify(normalized));
  }, []);

  const refresh = useCallback(async (message?: string) => {
    const result = await loadCloudbaseWarehouse() as AppData;
    setData(withStatusDefinitions(result));
    if (message) showToast(message);
  }, [showToast]);

  async function completeAction(message: string) {
    setEditing(null);
    setPrefillProductId("");
    if (data?.guest) showToast(message);
    else await refresh(message);
    navigate("home");
  }

  function openProductHistory(productId: string) {
    setSelectedProductId(productId);
    navigate("product-history");
  }

  function startDocument(type: "inbound" | "outbound", productId: string) {
    setEditing(null);
    setPrefillProductId(productId);
    navigate(type);
  }

  function startStocktake(productId: string) {
    setStocktakeProductId(productId);
    navigate("stocktake");
  }

  async function simulateGuestDocument(payload: GuestDocumentPayload) {
    if (!data?.guest) throw new Error("当前不是访客演示模式。");
    const products = data.products.map((product) => ({ ...product }));
    const documentId = `guest-d-${crypto.randomUUID()}`;
    const documentItems: DocumentItem[] = [];
    for (const source of payload.items) {
      const product = products.find((entry) => entry.id === source.productId);
      if (!product) throw new Error("演示商品不存在，请重置演示数据后重试。");
      const before = product.current_stock;
      if (payload.type === "outbound" && source.quantity > before) {
        throw new Error(`${product.name}库存只有 ${before}${product.unit}，最大可出库 ${before}${product.unit}。`);
      }
      const priceCents = Math.round(source.unitPrice * 100);
      const oldAverage = product.average_cost_cents ?? 0;
      const after = payload.type === "inbound" ? before + source.quantity : before - source.quantity;
      if (payload.type === "inbound") {
        product.average_cost_cents = after > 0
          ? Math.round((before * oldAverage + source.quantity * priceCents) / after)
          : 0;
      } else if (after === 0) product.average_cost_cents = 0;
      product.current_stock = after;
      documentItems.push({
        id: `guest-i-${crypto.randomUUID()}`,
        product_id: product.id,
        product_code: product.code,
        product_name: product.name,
        product_unit: product.unit,
        quantity: source.quantity,
        counted_quantity: null,
        unit_price_cents: payload.type === "inbound" ? priceCents : 0,
        unit_cost_cents: payload.type === "inbound" ? priceCents : oldAverage,
        remark: source.remark ?? "",
        before_quantity: before,
        after_quantity: after,
      });
    }
    const timestamp = new Date().toISOString();
    const prefix = payload.type === "inbound" ? "RK" : "CK";
    const documentNo = `${prefix}-TRY-${String(data.documents.length + 1).padStart(4, "0")}`;
    const nextDocument: WarehouseDocument = {
      id: documentId,
      document_no: documentNo,
      type: payload.type,
      purpose: payload.purpose || "访客试用",
      supplier_id: null,
      supplier_name: payload.supplierName || null,
      external_ref: payload.externalRef,
      customer: payload.customer ?? "",
      contact: payload.contact ?? "",
      remark: payload.remark ?? "",
      status: "active",
      revision_of: null,
      operator_name: "访客（演示）",
      effective_at: timestamp,
      created_at: timestamp,
      items: documentItems,
    };
    saveGuestData({ ...data, products, documents: [nextDocument, ...data.documents] });
    return { documentNo };
  }

  async function simulateGuestStocktake(payload: GuestStocktakePayload) {
    if (!data?.guest) throw new Error("当前不是访客演示模式。");
    const products = data.products.map((product) => ({ ...product }));
    const documentId = `guest-d-${crypto.randomUUID()}`;
    const documentItems: DocumentItem[] = payload.items.map((source) => {
      const product = products.find((entry) => entry.id === source.productId);
      if (!product) throw new Error("演示商品不存在，请重置演示数据后重试。");
      const before = product.current_stock;
      const difference = source.countedQuantity - before;
      product.current_stock = source.countedQuantity;
      if (product.status === "pending_stocktake") product.status = "normal";
      return { id: `guest-i-${crypto.randomUUID()}`, product_id: product.id, product_code: product.code, product_name: product.name, product_unit: product.unit, quantity: difference, counted_quantity: source.countedQuantity, unit_price_cents: 0, unit_cost_cents: product.average_cost_cents ?? 0, before_quantity: before, after_quantity: source.countedQuantity };
    });
    const timestamp = new Date().toISOString();
    const documentNo = `PD-TRY-${String(data.documents.length + 1).padStart(4, "0")}`;
    const nextDocument: WarehouseDocument = { id: documentId, document_no: documentNo, type: "stocktake", purpose: payload.purpose || "访客试用盘点", supplier_id: null, supplier_name: null, external_ref: "", status: "active", revision_of: null, operator_name: "访客（演示）", effective_at: timestamp, created_at: timestamp, items: documentItems };
    saveGuestData({ ...data, products, documents: [nextDocument, ...data.documents] });
    return { documentNo };
  }

  useEffect(() => {
    if (!cloudbaseUser) return;
    setLoading(true);
    refresh().catch((error) => setLoadError(error instanceof Error ? error.message : "数据加载失败." )).finally(() => setLoading(false));
  }, [cloudbaseUser, refresh]);

  useEffect(() => {
    const scale = localStorage.getItem("warehouse-online-font-scale") ?? "1";
    document.documentElement.style.setProperty("--warehouse-font-scale", scale);
  }, []);

  useEffect(() => {
    if (!data || data.currentUser.role !== "admin") return;
    const last = localStorage.getItem("warehouse-last-local-backup");
    const due = !last || Date.now() - new Date(last).getTime() >= 7 * 24 * 60 * 60 * 1000;
    if (!due) return;
    getDirectoryHandle().then(async (handle: any) => {
      if (!handle) return;
      try { const name = await writeBackupToDirectory(handle, false); setToast(`每周自动备份已保存到 ${name}`); window.setTimeout(() => setToast(""), 3600); }
      catch { /* 浏览器需要用户重新授权时，由备份页继续处理。 */ }
    }).catch(() => undefined);
  }, [data]);

  function navigate(next: Page) {
    const item = NAV_ITEMS.find((entry) => entry.page === next);
    if (item?.adminOnly && data?.currentUser.role === "viewer") return;
    if (item?.adminOnly && data?.currentUser.role === "guest" && !item.guestAllowed) return;
    setPage(next); setNavOpen(false);
    if (next !== "inbound" && next !== "outbound") setEditing(null);
  }

  if (!cloudbaseUser) return <CloudbaseLogin onSuccess={setCloudbaseUser} />;

  if (loading) return <main className="loading-screen"><div className="loading-mark"><span /><span /><span /></div><h1>仓储台</h1><p>正在核对库存数据…</p></main>;
  if (loadError || !data) return <main className="error-screen"><span>!</span><h1>暂时无法打开仓库</h1><p>{loadError}</p><button onClick={() => window.location.reload()}>重新加载</button></main>;
  const visibleNav = NAV_ITEMS.filter((item) => {
    if (!item.adminOnly) return true;
    if (data.currentUser.role === "admin") return true;
    return data.currentUser.role === "guest" && Boolean(item.guestAllowed);
  });

  async function resetGuestDemo() {
    localStorage.removeItem("warehouse-guest-demo-v1");
    await refresh();
    setPage("home");
    showToast("演示数据已恢复到初始状态。");
  }

  return (
    <main className="app-shell">
      <aside className={navOpen ? "open" : ""}>
        <div className="brand"><span className="brand-box">仓</span><div><strong>仓储台</strong><small>库存管理系统</small></div></div>
        <div className="sidebar-undo-row"><button className="sidebar-undo" onClick={() => navigate("records")}><span>↶</span><div><strong>撤回上一步</strong><small>查看并撤销流水</small></div></button><button className="sidebar-more" title="查看可撤回的具体流水" aria-label="查看可撤回的具体流水" onClick={() => navigate("records")}>•••</button></div>
        <nav>{visibleNav.map((item) => <button key={item.page} className={page === item.page ? "active" : ""} onClick={() => navigate(item.page)}><span>{item.glyph}</span>{item.label}{item.page === "inventory" && data.products.filter((product) => product.current_stock <= product.min_stock).length > 0 && <em>{data.products.filter((product) => product.current_stock <= product.min_stock).length}</em>}</button>)}</nav>
        <div className="sidebar-footer"><div className="user-mini"><span>{cloudbaseUser.displayName.slice(0, 1).toUpperCase()}</span><div><strong>{cloudbaseUser.displayName}</strong><small>{cloudbaseUser.role === "owner" ? "最高管理员" : cloudbaseUser.role === "admin" ? "管理员" : "待审批用户"}</small></div></div><div className="system-state"><i />CloudBase 身份已连接</div><button className="sidebar-signout" onClick={() => void signOutOfCloudbase().finally(() => setCloudbaseUser(null))}>退出登录</button></div>
      </aside>
      {navOpen && <button className="mobile-overlay" aria-label="关闭菜单" onClick={() => setNavOpen(false)} />}
      <section className="main-area">
        <header className="top-header"><button className="menu-button" onClick={() => setNavOpen(true)}>☰</button><div><small>{data.guest ? "访客试用 /" : "仓库管理 /"}</small><strong>{pageTitle(page)}</strong></div><div className="header-actions"><span className={`role-pill ${data.guest ? "guest" : ""}`}>{data.currentUser.role === "admin" ? "全部权限" : data.guest ? "无需登录 · 演示沙箱" : "金额已隐藏"}</span><button className="header-alert" onClick={() => navigate("inventory")}><span>!</span>{data.products.filter((product) => product.current_stock <= product.min_stock).length > 0 && <em>{data.products.filter((product) => product.current_stock <= product.min_stock).length}</em>}</button></div></header>
        <div className="content-area">
          {data.guest && <section className="guest-banner"><span>试玩</span><div><strong>{data.pendingApproval ? "账号正在等待管理员审批，当前进入访客试用" : "你正在使用访客演示数据"}</strong><p>所有操作仅保存在这个浏览器中，不会读取或修改真实仓库。</p></div><button onClick={() => void resetGuestDemo()}>重置演示数据</button></section>}
          {page === "home" && <Dashboard data={data} onNavigate={navigate} />}
          {page === "search" && <GlobalSearchView data={data} onNavigate={navigate} onStartDocument={startDocument} />}
          {page === "product-history" && (() => {
            const product = data.products.find((item) => item.id === selectedProductId);
            return product ? <ProductHistoryView data={data} product={product} onBack={() => navigate("inventory")} /> : <EmptyState title="商品不存在" detail="该商品可能已被移除，请返回库存重新选择。" />;
          })()}
          {page === "inbound" && <DocumentForm key={`in-${editing?.id || prefillProductId || "new"}`} type="inbound" data={data} editing={editing} initialProductId={prefillProductId} onGuestDocument={simulateGuestDocument} onCancelEdit={() => { setEditing(null); setPrefillProductId(""); navigate("records"); }} onSaved={completeAction} onRefresh={refresh} />}
          {page === "outbound" && <DocumentForm key={`out-${editing?.id || prefillProductId || "new"}`} type="outbound" data={data} editing={editing} initialProductId={prefillProductId} onGuestDocument={simulateGuestDocument} onCancelEdit={() => { setEditing(null); setPrefillProductId(""); navigate("records"); }} onSaved={completeAction} onRefresh={refresh} />}
          {page === "inventory" && <InventoryView data={data} onOpenProduct={openProductHistory} onStartStocktake={startStocktake} onNavigate={navigate} />}
          {page === "replenishment" && <ReplenishmentView data={data} />}
          {page === "stocktake" && <StocktakeView data={data} initialProductId={stocktakeProductId} onSaved={async (message) => { setStocktakeProductId(""); if (data.guest) showToast(message); else await refresh(message); navigate("home"); }} onGuestStocktake={simulateGuestStocktake} onBack={() => navigate("inventory")} />}
          {page === "reports" && <ReportsView data={data} onBack={() => navigate("inventory")} />}
          {page === "records" && <RecordsView data={data} onRefresh={refresh} onEdit={(document) => { setEditing(document); navigate(document.type === "inbound" ? "inbound" : "outbound"); }} />}
          {page === "products" && <ProductsView data={data} onRefresh={refresh} />}
          {page === "recipes" && <RecipesView data={data} onRefresh={refresh} />}
          {page === "settings" && <SettingsView data={data} onRefresh={refresh} />}
          {page === "users" && <UsersView data={data} onRefresh={refresh} />}
          {page === "backup" && <BackupView data={data} onRefresh={refresh} />}
        </div>
      </section>
      {toast && <div className="toast"><span>✓</span>{toast}</div>}
    </main>
  );
}
