"use client";

import cloudbase from "@cloudbase/js-sdk";

// 环境 ID 可以公开写在前端；它不是 SecretId、SecretKey 或数据库密码。
export const CLOUDBASE_ENV_ID = "warehouse-d0g4dqtmd88ca81c0";

let app: ReturnType<typeof cloudbase.init> | null = null;

export function getCloudbaseApp() {
  if (!app) app = cloudbase.init({ env: CLOUDBASE_ENV_ID });
  return app;
}

export async function cloudbaseBootstrap() {
  const response = await getCloudbaseApp().callFunction({
    name: "warehouse-api",
    data: { action: "bootstrap" },
    parse: true,
  });
  return response.result as {
    ok: boolean;
    error?: string;
    currentUser?: { id: string; email: string; displayName: string; role: string };
  };
}

export async function cloudbaseApi(payload: Record<string, unknown>) {
  const response = await getCloudbaseApp().callFunction({ name: "warehouse-api", data: payload, parse: true });
  const result = response.result as Record<string, unknown> & { ok?: boolean; error?: string };
  if (!result.ok) throw new Error(result.error || "云端仓库操作失败。");
  return result;
}

export async function loadCloudbaseWarehouse() {
  const result = await cloudbaseApi({ action: "load" });
  return result.data;
}

export async function signInWithCloudbaseEmail(email: string, password: string) {
  // 使用 CloudBase Web SDK 3.x 的正式邮箱密码接口。该接口不会总是抛异常，
  // 因此必须检查返回的 error，避免把真实登录错误误当作后续接口错误。
  const signedIn = await getCloudbaseApp().auth().signInWithPassword({ email, password });
  if (signedIn.error) {
    throw new Error(signedIn.error.message || "CloudBase 邮箱登录失败。");
  }
  const result = await cloudbaseBootstrap();
  if (!result.ok) throw new Error(result.error || "云端身份初始化失败。");
  return result;
}

export async function signOutOfCloudbase() {
  await getCloudbaseApp().auth().signOut();
}
