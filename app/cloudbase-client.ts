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

async function completeCloudbaseSignIn() {
  const result = await cloudbaseBootstrap();
  if (!result.ok) throw new Error(result.error || "云端身份初始化失败。");
  return result;
}

export async function signInWithCloudbaseUsername(username: string, password: string) {
  // 与控制台已启用的“用户名密码”方式一致。
  const signedIn = await getCloudbaseApp().auth().signInWithPassword({ username, password });
  if (signedIn.error) {
    throw new Error(signedIn.error.message || "CloudBase 用户名登录失败。");
  }
  return completeCloudbaseSignIn();
}

export async function requestCloudbaseEmailCode(email: string) {
  // 与控制台已启用的“邮箱验证码”方式一致；验证码发送后由返回的回调完成登录。
  const response = await getCloudbaseApp().auth().signInWithOtp({ email });
  if (response.error) throw new Error(response.error.message || "验证码发送失败。");
  if (!response.data.verifyOtp) throw new Error("CloudBase 未返回验证码校验步骤。");
  return response.data.verifyOtp;
}

export async function verifyCloudbaseEmailCode(
  verifyOtp: (params: { token: string }) => Promise<{ error: { message?: string } | null }>,
  code: string,
) {
  const verified = await verifyOtp({ token: code });
  if (verified.error) throw new Error(verified.error.message || "验证码不正确或已过期。");
  return completeCloudbaseSignIn();
}

export async function requestCloudbaseRegistrationCode(email: string) {
  const response = await getCloudbaseApp().auth().getVerification({ email });
  if (!response.verification_id) throw new Error("CloudBase 未返回注册验证码，请稍后重试。");
  if (response.is_user) throw new Error("该邮箱已注册，请直接登录。");
  return response.verification_id;
}

export async function registerCloudbaseUser({
  email,
  username,
  password,
  verificationId,
  code,
}: {
  email: string;
  username: string;
  password: string;
  verificationId: string;
  code: string;
}) {
  const auth = getCloudbaseApp().auth();
  const verified = await auth.verify({ verification_id: verificationId, verification_code: code });
  if (!verified.verification_token) throw new Error("验证码校验失败，请重新获取验证码。");
  const signedUp = await auth.signUp({
    email,
    verification_code: code,
    verification_token: verified.verification_token,
    password,
    name: username,
  });
  if (signedUp.error) throw new Error(signedUp.error.message || "注册失败，请稍后重试。");

  // CloudBase 要求先以邮箱完成验证后再绑定用户名，绑定完成后可使用“用户名密码”登录。
  const usernameAuth = auth as unknown as {
    isUsernameRegistered: (value: string) => Promise<boolean>;
    currentUser: { updateUsername: (value: string) => Promise<void> };
  };
  if (!(await usernameAuth.isUsernameRegistered(username))) await usernameAuth.currentUser.updateUsername(username);
  return completeCloudbaseSignIn();
}

export async function signOutOfCloudbase() {
  await getCloudbaseApp().auth().signOut();
}
