"use strict";

const cloudbase = require("@cloudbase/node-sdk");
// 仅在云函数环境中使用的 Server API Key，会映射为 service_role 并绕过 RLS。
// 它绝不能写入前端或返回给浏览器；浏览器仍须先登录，且本函数继续校验业务角色。
const SERVER_API_KEY = String(process.env.CLOUDBASE_APIKEY || "").trim();
const app = cloudbase.init({
  env: cloudbase.SYMBOL_CURRENT_ENV,
  ...(SERVER_API_KEY ? { accessKey: SERVER_API_KEY } : {}),
});
// CloudBase RDB 默认会将环境 ID 当作 database/schema 名；本环境的 PostgreSQL
// 实际业务 Schema 是控制台显示的 public，必须显式指定。
const db = app.rdb({ database: "public" });
const OWNER_EMAIL = String(process.env.WAREHOUSE_OWNER_EMAIL || "1991412002@qq.com").trim().toLowerCase();
// CloudBase 身份认证后台显示的“用户 ID”。可通过环境变量覆盖，避免依赖不可用的详情查询接口。
const OWNER_UID = String(process.env.WAREHOUSE_OWNER_UID || "2093394525082103809").trim();
const USERS = "warehouse_users";
const STATE = "warehouse_state";
const STATE_ID = "main";
const ROLES = new Set(["owner", "admin", "operator", "viewer", "pending"]);
const DEFAULT_STATUSES = [
  { id: "normal", label: "正常供货", color: "#21875A" }, { id: "ordered", label: "补货已下单", color: "#B88900" },
  { id: "price_changed", label: "价格有变动", color: "#C56A16" }, { id: "alternate", label: "启用替代供货", color: "#3377C8" },
  { id: "paused", label: "暂停采购", color: "#C74C4C" }, { id: "pending_stocktake", label: "新增待盘点", color: "#655BC7", system: true },
];

const now = () => new Date().toISOString();
const uuid = () => (global.crypto && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
const text = (value, max = 120) => typeof value === "string" ? value.trim().slice(0, max) : "";
const positive = (value) => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : -1;
const nonNegative = (value) => Number.isInteger(Number(value)) && Number(value) >= 0 ? Number(value) : -1;
const money = (value) => Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.round(Number(value) * 100) : -1;
const clientRole = (role) => ["owner", "admin", "operator"].includes(role) ? "admin" : "viewer";

async function rows(query, resource) {
  const result = await query;
  if (result.error) throw new Error(`${resource}：${result.error.message || "数据库操作失败"}`);
  return result.data || [];
}

async function identity() {
  // 身份由 CloudBase 运行时注入，不能信任前端传来的邮箱或 uid。
  // 只使用运行时已注入的信息；部分环境的 getEndUserInfo 会返回 RESOURCE_NOT_FOUND。
  const auth = app.auth();
  const basic = auth.getUserInfo();
  const id = text(basic.uid || basic.userId || basic.user_id, 160);
  if (!id) throw new Error("未读取到 CloudBase 登录身份，请重新登录后再试。");
  const rawEmail = text(basic.email || basic.emailAddress || basic.email_address, 160).toLowerCase();
  const email = rawEmail || (id === OWNER_UID ? OWNER_EMAIL : `${id}@cloudbase-user.local`);
  const displayName = text(basic.username || basic.nickName || basic.nickname || basic.name || email.split("@")[0], 80) || "仓储台用户";
  return { id, email, displayName };
}

async function currentUser() {
  const person = await identity(); const found = await rows(db.from(USERS).select("*").eq("id", person.id), "读取用户角色失败");
  if (found.length) {
    const saved = found[0]; const isOwner = person.id === OWNER_UID || person.email === OWNER_EMAIL;
    const role = isOwner ? "owner" : (ROLES.has(saved.role) ? saved.role : "pending");
    await rows(db.from(USERS).update({ email: person.email, display_name: person.displayName, role, last_seen_at: now() }).eq("id", person.id), "更新用户角色失败");
    return { ...person, role };
  }
  const role = person.id === OWNER_UID || person.email === OWNER_EMAIL ? "owner" : "pending";
  await rows(db.from(USERS).insert({ id: person.id, email: person.email, display_name: person.displayName, role, created_at: now(), last_seen_at: now() }), "创建用户角色失败");
  return { ...person, role };
}

function emptyState() {
  return { _id: STATE_ID, schemaVersion: 1, products: [], suppliers: [], documents: [], recipes: [], auditLogs: [], statusDefinitions: DEFAULT_STATUSES, preferences: { productCodePrefix: "ZERO", outboundCostMethod: "weighted" }, createdAt: now(), updatedAt: now() };
}
async function state() {
  const found = await rows(db.from(STATE).select("data").eq("id", STATE_ID), "读取仓库数据失败");
  if (found.length && found[0].data) return found[0].data;
  const created = emptyState(); await rows(db.from(STATE).insert({ id: STATE_ID, data: created, updated_at: now() }), "创建仓库数据失败"); return created;
}
async function saveState(next) { next.updatedAt = now(); await rows(db.from(STATE).update({ data: next, updated_at: now() }).eq("id", STATE_ID), "保存仓库数据失败"); }
async function users() { return rows(db.from(USERS).select("*").limit(500), "读取用户列表失败"); }
function ensureEditor(user) { if (!["owner", "admin", "operator"].includes(user.role)) throw new Error("你没有修改仓库数据的权限。"); }
function ensureOwner(user) { if (user.role !== "owner") throw new Error("只有最高管理员可以管理管理员和用户角色。"); }
function addLog(next, user, action, entityType, entityId) { next.auditLogs.unshift({ id: uuid(), entity_type: entityType, entity_id: entityId, action, created_at: now(), operator_user_id: user.id }); next.auditLogs = next.auditLogs.slice(0, 1500); }
function publicData(next, user, allUsers) {
  return { currentUser: { id: user.id, email: user.email, display_name: user.displayName, role: clientRole(user.role) }, products: next.products || [], suppliers: next.suppliers || [], documents: next.documents || [], users: ["owner", "admin"].includes(user.role) ? allUsers.map((entry) => ({ id: entry.id, email: entry.email, display_name: entry.display_name || entry.email, role: clientRole(entry.role), last_seen_at: entry.last_seen_at || entry.lastSeenAt })) : [], auditLogs: next.auditLogs || [], statusDefinitions: next.statusDefinitions || DEFAULT_STATUSES, recipes: next.recipes || [], preferences: next.preferences || { productCodePrefix: "ZERO", outboundCostMethod: "weighted" } };
}
function supplier(next, name) { const clean = text(name, 100); if (!clean) return null; let item = next.suppliers.find((entry) => entry.name === clean); if (!item) { item = { id: uuid(), name: clean }; next.suppliers.push(item); } return item; }
function nextCode(next, prefix) { const numeric = (next.products || []).map((item) => Number((String(item.code).match(/(\d+)$/) || ["", "0"])[1])).reduce((max, value) => Math.max(max, value), 0) + 1; return `${prefix ? `${prefix}-` : ""}${String(numeric).padStart(6, "0")}`; }
function documentNo(next, type) { const prefix = type === "inbound" ? "RK" : type === "outbound" ? "CK" : "PD"; return `${prefix}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${String((next.documents || []).filter((item) => item.type === type).length + 1).padStart(4, "0")}`; }
function activeDocs(next) { return (next.documents || []).filter((doc) => doc.status === "active").sort((a, b) => String(a.effective_at).localeCompare(String(b.effective_at)) || String(a.created_at).localeCompare(String(b.created_at))); }
function rebuild(next) {
  const products = next.products || []; const byId = new Map(products.map((product) => [product.id, product]));
  products.forEach((product) => { product.current_stock = Number(product.base_stock || 0); product.average_cost_cents = Number(product.base_cost_cents || 0); });
  for (const doc of activeDocs(next)) for (const item of doc.items || []) {
    const product = byId.get(item.product_id); if (!product) continue; const before = product.current_stock;
    if (doc.type === "inbound") { const price = Number(item.unit_price_cents || 0); const quantity = Number(item.quantity || 0); const after = before + quantity; product.average_cost_cents = after ? Math.round((before * product.average_cost_cents + quantity * price) / after) : 0; product.current_stock = after; item.unit_cost_cents = price; item.before_quantity = before; item.after_quantity = after; }
    else if (doc.type === "outbound") { const quantity = Number(item.quantity || 0); if (quantity > before) throw new Error(`${product.name}库存不足，无法保存单据。`); const after = before - quantity; item.unit_cost_cents = Number(item.unit_cost_cents || product.average_cost_cents || 0); item.before_quantity = before; item.after_quantity = after; product.current_stock = after; if (!after) product.average_cost_cents = 0; }
    else { const counted = Number(item.counted_quantity); if (!Number.isInteger(counted) || counted < 0) throw new Error("实盘数量不正确。"); item.before_quantity = before; item.after_quantity = counted; item.quantity = counted - before; product.current_stock = counted; if (product.status === "pending_stocktake") product.status = "normal"; }
  }
}
function requireProduct(next, id) { const product = next.products.find((item) => item.id === id); if (!product) throw new Error("选择的商品不存在，请刷新后重试。"); return product; }

async function mutate(user, event) {
  ensureEditor(user); const next = await state(); const action = text(event.action, 40);
  if (action === "add-product") {
    const name = text(event.name, 100); if (!name) throw new Error("请填写商品名称。"); const manual = text(event.code, 40).toUpperCase(); const prefix = text(event.codePrefix || next.preferences.productCodePrefix, 20).replace(/[^\u4e00-\u9fffA-Za-z0-9_-]/g, ""); const code = manual || nextCode(next, prefix);
    if (next.products.some((item) => item.code === code)) throw new Error(`商品编号 ${code} 已存在，请更换编号。`);
    const min = nonNegative(event.minStock); const initial = nonNegative(event.initialStock); if (min < 0 || initial < 0) throw new Error("库存数量必须是大于或等于 0 的整数。");
    const status = (next.statusDefinitions || DEFAULT_STATUSES).find((entry) => entry.id === text(event.status, 40) || entry.label === text(event.statusLabel, 40))?.id || "normal"; const source = supplier(next, event.defaultSupplierName);
    const product = { id: uuid(), code, name, unit: text(event.unit, 16) || "件", status, min_stock: min, current_stock: initial, average_cost_cents: 0, base_stock: initial, base_cost_cents: 0, default_supplier_id: source ? source.id : null, default_supplier_name: source ? source.name : null };
    next.products.push(product); addLog(next, user, "create", "product", product.id); await saveState(next); return { code };
  }
  if (action === "update-product") { const product = requireProduct(next, text(event.id, 80)); const min = nonNegative(event.minStock); if (min < 0) throw new Error("最低库存必须是大于或等于 0 的整数。"); product.min_stock = min; if ((next.statusDefinitions || []).some((entry) => entry.id === text(event.status, 40))) product.status = text(event.status, 40); const source = supplier(next, event.defaultSupplierName); if (source) { product.default_supplier_id = source.id; product.default_supplier_name = source.name; } addLog(next, user, "update", "product", product.id); await saveState(next); return { ok: true }; }
  if (action === "create-document" || action === "stocktake") {
    const type = action === "stocktake" ? "stocktake" : text(event.type, 20); if (!["inbound", "outbound", "stocktake"].includes(type)) throw new Error("不支持的单据类型。"); const inputs = Array.isArray(event.items) ? event.items : []; if (!inputs.length) throw new Error("请至少添加一种商品。"); const seen = new Set();
    const items = inputs.map((raw) => { const id = text(raw.productId, 80); if (!id || seen.has(id)) throw new Error("商品填写不完整或有重复。"); seen.add(id); const product = requireProduct(next, id); const quantity = type === "stocktake" ? 0 : positive(raw.quantity); const counted = type === "stocktake" ? nonNegative(raw.countedQuantity) : null; if ((type !== "stocktake" && quantity < 1) || (type === "stocktake" && counted < 0)) throw new Error("数量填写不正确。"); const price = type === "inbound" ? money(raw.unitPrice) : 0; if (price < 0) throw new Error("入库单价不能小于 0。"); return { id: uuid(), product_id: id, product_code: product.code, product_name: product.name, product_unit: product.unit, quantity, counted_quantity: counted, unit_price_cents: price, unit_cost_cents: product.average_cost_cents || 0, remark: text(raw.remark, 240), before_quantity: 0, after_quantity: 0 }; });
    const revisionOf = text(event.revisionOf, 80); if (revisionOf) { const original = next.documents.find((doc) => doc.id === revisionOf && doc.status === "active"); if (!original) throw new Error("原单据已修改或撤销。"); original.status = "replaced"; }
    const source = type === "inbound" ? supplier(next, event.supplierName) : null; const time = now(); const doc = { id: uuid(), document_no: documentNo(next, type), type, purpose: text(event.purpose, 160) || (type === "stocktake" ? "库存盘点" : "常规登记"), supplier_id: source ? source.id : null, supplier_name: source ? source.name : null, external_ref: text(event.externalRef, 100), customer: type === "outbound" ? text(event.customer, 100) : "", contact: type === "outbound" ? text(event.contact, 100) : "", remark: text(event.remark, 240), status: "active", revision_of: revisionOf || null, operator_name: user.displayName, effective_at: time, created_at: time, items };
    next.documents.unshift(doc); rebuild(next); addLog(next, user, type === "stocktake" ? "stocktake" : "create", "document", doc.id); await saveState(next); return { documentNo: doc.document_no };
  }
  if (action === "void-document") { const doc = next.documents.find((entry) => entry.id === text(event.documentId, 80) && entry.status === "active"); if (!doc) throw new Error("该单据已经修改或撤销。"); doc.status = "voided"; rebuild(next); addLog(next, user, "void", "document", doc.id); await saveState(next); return { ok: true }; }
  if (action === "save-status-definitions") { const definitions = Array.isArray(event.statusDefinitions) ? event.statusDefinitions.map((raw) => ({ id: text(raw.id, 40).replace(/[^a-z0-9_-]/gi, ""), label: text(raw.label, 20), color: text(raw.color, 8), system: text(raw.id, 40) === "pending_stocktake" })).filter((item) => item.id && item.label && /^#[0-9a-f]{6}$/i.test(item.color)) : []; if (!definitions.length) throw new Error("请至少保留一个有效商品状态。"); if (!definitions.some((item) => item.id === "pending_stocktake")) definitions.push(DEFAULT_STATUSES[5]); next.statusDefinitions = definitions; const allowed = new Set(definitions.map((item) => item.id)); next.products.forEach((product) => { if (!allowed.has(product.status)) product.status = definitions[0].id; }); addLog(next, user, "update", "settings", "statusDefinitions"); await saveState(next); return { statusDefinitions: definitions }; }
  if (action === "save-preferences") { const pref = event.preferences || {}; next.preferences = { productCodePrefix: text(pref.productCodePrefix, 20).replace(/[^\u4e00-\u9fffA-Za-z0-9_-]/g, ""), outboundCostMethod: ["weighted", "fifo", "lastInbound"].includes(pref.outboundCostMethod) ? pref.outboundCostMethod : "weighted" }; addLog(next, user, "update", "settings", "preferences"); await saveState(next); return { preferences: next.preferences }; }
  if (action === "save-recipes") { const recipes = Array.isArray(event.recipes) ? event.recipes : []; const ids = new Set(next.products.map((item) => item.id)); if (recipes.some((recipe) => !text(recipe.name, 100) || !Array.isArray(recipe.components) || recipe.components.some((component) => !ids.has(text(component.productId, 80)) || positive(component.quantity) < 1))) throw new Error("配方名称或配件填写不正确。"); next.recipes = recipes; addLog(next, user, "save", "recipe", "all"); await saveState(next); return { recipes }; }
  if (action === "order-recipe") { const recipe = next.recipes.find((item) => item.id === text(event.recipeId, 80)); const count = positive(event.quantity); if (!recipe || count < 1) throw new Error("配方或下单数量不正确。"); return mutate(user, { action: "create-document", type: "outbound", purpose: `一键配料下单：${recipe.name} × ${count}`, remark: "按产品配方自动扣减配件库存", items: recipe.components.map((item) => ({ productId: item.productId, quantity: item.quantity * count, remark: item.remark })) }); }
  if (action === "restore-backup") { if (event.confirm !== "RESTORE" || !event.backup || event.backup.format !== "warehouse-cloudbase-backup") throw new Error("备份文件无效。"); const restored = event.backup.data; if (!Array.isArray(restored.products) || !Array.isArray(restored.documents)) throw new Error("备份缺少业务数据。"); Object.assign(next, restored, { _id: STATE_ID, updatedAt: now() }); rebuild(next); addLog(next, user, "restore", "system", "backup"); await saveState(next); return { restored: next.products.length + next.documents.length }; }
  throw new Error("不支持的仓库操作。");
}

exports.main = async (event = {}, context = {}) => {
  try {
    const action = text(event.action || "bootstrap", 40); if (action === "health") return { ok: true, environment: process.env.TCB_ENV || "current" };
    const user = await currentUser(); if (action === "set-role") { ensureOwner(user); const userId = text(event.userId, 160); const role = text(event.role, 20); if (!userId || !ROLES.has(role) || role === "owner") throw new Error("用户或角色参数无效。"); await rows(db.from(USERS).update({ role, updated_at: now(), updated_by: user.id }).eq("id", userId), "更新用户角色失败"); return { ok: true, users: await users() }; }
    const next = await state(); const allUsers = await users();
    if (action === "bootstrap" || action === "load") return { ok: true, currentUser: user, warehouseState: next, data: publicData(next, user, allUsers) };
    if (action === "backup") { ensureEditor(user); return { ok: true, format: "warehouse-cloudbase-backup", version: 1, createdAt: now(), createdBy: user.email, data: next }; }
    const result = await mutate(user, event); return { ok: true, ...result };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "云函数执行失败。" }; }
};
