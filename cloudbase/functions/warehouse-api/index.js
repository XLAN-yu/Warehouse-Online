"use strict";

const cloudbase = require("@cloudbase/node-sdk");

const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });
const db = app.database();
const OWNER_EMAIL = String(process.env.WAREHOUSE_OWNER_EMAIL || "1991412002@qq.com").trim().toLowerCase();
const USER_COLLECTION = "warehouse_users";

const ROLES = new Set(["owner", "admin", "operator", "viewer", "pending"]);

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function identityFromContext(event, context) {
  const info = (context && (context.USER_INFO || context.userInfo || context.user_info)) ||
    (event && (event.USER_INFO || event.userInfo || event.user_info)) || {};
  const uid = cleanText(info.uid || info.userId || info.user_id || info.openId || info.openid, 160);
  const email = cleanText(info.email || info.emailAddress || info.email_address, 160).toLowerCase();
  const displayName = cleanText(info.nickName || info.nickname || info.name || email.split("@")[0], 80) || "仓储台用户";
  if (!uid || !email) throw new Error("未读取到登录身份。请使用 CloudBase 邮箱账号登录后重试。");
  return { uid, email, displayName };
}

async function getOrCreateUser(identity) {
  const ref = db.collection(USER_COLLECTION).doc(identity.uid);
  const existing = await ref.get();
  if (existing.data && existing.data.length) {
    const user = existing.data[0];
    const role = ROLES.has(user.role) ? user.role : "pending";
    await ref.update({ data: { email: identity.email, displayName: identity.displayName, lastSeenAt: new Date().toISOString() } });
    return { id: identity.uid, email: identity.email, displayName: identity.displayName, role };
  }

  const role = identity.email === OWNER_EMAIL ? "owner" : "pending";
  const now = new Date().toISOString();
  const user = { _id: identity.uid, email: identity.email, displayName: identity.displayName, role, createdAt: now, lastSeenAt: now };
  await ref.set({ data: user });
  return { id: identity.uid, email: identity.email, displayName: identity.displayName, role };
}

async function listUsers() {
  const result = await db.collection(USER_COLLECTION).limit(500).get();
  return (result.data || []).map((user) => ({
    id: user._id,
    email: user.email,
    displayName: user.displayName,
    role: ROLES.has(user.role) ? user.role : "pending",
    createdAt: user.createdAt,
    lastSeenAt: user.lastSeenAt,
  }));
}

function ensureOwner(user) {
  if (user.role !== "owner") throw new Error("只有最高管理员可以管理管理员和用户角色。");
}

exports.main = async (event = {}, context = {}) => {
  try {
    const action = cleanText(event.action || "bootstrap", 40);
    if (action === "health") return { ok: true, environment: process.env.TCB_ENV || "current", ownerEmail: OWNER_EMAIL };

    const currentUser = await getOrCreateUser(identityFromContext(event, context));
    if (action === "bootstrap") {
      return {
        ok: true,
        currentUser,
        users: ["owner", "admin"].includes(currentUser.role) ? await listUsers() : [],
      };
    }

    if (action === "set-role") {
      ensureOwner(currentUser);
      const userId = cleanText(event.userId, 160);
      const role = cleanText(event.role, 20);
      if (!userId || !ROLES.has(role) || role === "owner") throw new Error("用户或角色参数无效。");
      await db.collection(USER_COLLECTION).doc(userId).update({ data: { role, updatedAt: new Date().toISOString(), updatedBy: currentUser.id } });
      return { ok: true, users: await listUsers() };
    }

    throw new Error("暂不支持的 CloudBase 后端操作：" + action);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "云函数执行失败。" };
  }
};
