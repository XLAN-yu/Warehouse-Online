import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    role: text("role", { enum: ["admin", "viewer"] }).notNull().default("viewer"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    lastSeenAt: text("last_seen_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("users_email_unique").on(table.email),
    index("idx_users_role").on(table.role),
  ],
);

export const suppliers = sqliteTable(
  "suppliers",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [uniqueIndex("suppliers_name_unique").on(table.name)],
);

export const products = sqliteTable(
  "products",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull(),
    codeSource: text("code_source", { enum: ["manual", "auto"] })
      .notNull()
      .default("auto"),
    name: text("name").notNull(),
    unit: text("unit").notNull().default("件"),
    status: text("status").notNull().default("normal"),
    minStock: integer("min_stock").notNull().default(0),
    currentStock: integer("current_stock").notNull().default(0),
    averageCostCents: integer("average_cost_cents").notNull().default(0),
    defaultSupplierId: text("default_supplier_id").references(() => suppliers.id),
    archivedAt: text("archived_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("products_code_unique").on(table.code),
    index("idx_products_archived_name").on(table.archivedAt, table.name),
    check("products_current_stock_nonnegative", sql`${table.currentStock} >= 0`),
    check("products_min_stock_nonnegative", sql`${table.minStock} >= 0`),
  ],
);

export const productSuppliers = sqliteTable(
  "product_suppliers",
  {
    productId: text("product_id")
      .notNull()
      .references(() => products.id),
    supplierId: text("supplier_id")
      .notNull()
      .references(() => suppliers.id),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [primaryKey({ columns: [table.productId, table.supplierId] })],
);

export const documents = sqliteTable(
  "documents",
  {
    id: text("id").primaryKey(),
    documentNo: text("document_no").notNull(),
    type: text("type", { enum: ["inbound", "outbound", "stocktake"] }).notNull(),
    purpose: text("purpose").notNull().default(""),
    supplierId: text("supplier_id").references(() => suppliers.id),
    externalRef: text("external_ref").notNull().default(""),
    status: text("status", { enum: ["active", "voided", "replaced"] })
      .notNull()
      .default("active"),
    revisionOf: text("revision_of"),
    operatorUserId: text("operator_user_id")
      .notNull()
      .references(() => users.id),
    effectiveAt: text("effective_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("documents_document_no_unique").on(table.documentNo),
    index("idx_documents_status_effective_at").on(table.status, table.effectiveAt),
  ],
);

export const documentItems = sqliteTable(
  "document_items",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id),
    productId: text("product_id")
      .notNull()
      .references(() => products.id),
    quantity: integer("quantity").notNull(),
    countedQuantity: integer("counted_quantity"),
    unitPriceCents: integer("unit_price_cents").notNull().default(0),
    unitCostCents: integer("unit_cost_cents").notNull().default(0),
    beforeQuantity: integer("before_quantity").notNull().default(0),
    afterQuantity: integer("after_quantity").notNull().default(0),
  },
  (table) => [
    index("idx_document_items_document_id").on(table.documentId),
    index("idx_document_items_product_id").on(table.productId),
  ],
);

export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: text("id").primaryKey(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    action: text("action").notNull(),
    beforeJson: text("before_json").notNull().default(""),
    afterJson: text("after_json").notNull().default(""),
    operatorUserId: text("operator_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_audit_logs_created_at").on(table.createdAt)],
);

export const systemSettings = sqliteTable("system_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// 每次库存重算先占用一个唯一版本号；并发提交使用同一版本时，整批写入会回滚。
export const inventoryRevisions = sqliteTable("inventory_revisions", {
  revision: integer("revision").primaryKey(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
