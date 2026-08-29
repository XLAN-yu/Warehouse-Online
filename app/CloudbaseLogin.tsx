"use client";

import { FormEvent, useState } from "react";
import {
  requestCloudbaseEmailCode,
  signInWithCloudbaseUsername,
  verifyCloudbaseEmailCode,
} from "./cloudbase-client";

type CloudbaseUser = { id: string; email: string; displayName: string; role: string };

function readableError(reason: unknown) {
  if (reason instanceof Error) return reason.message;
  if (reason && typeof reason === "object") {
    const value = reason as { message?: unknown; msg?: unknown; error?: unknown; code?: unknown };
    if (typeof value.message === "string") return value.message;
    if (typeof value.msg === "string") return value.msg;
    if (typeof value.error === "string") return value.error;
    try { return JSON.stringify(reason); } catch { /* use fallback below */ }
  }
  return "登录未完成，请稍后再试。";
}

export function CloudbaseLogin({ onSuccess }: { onSuccess: (user: CloudbaseUser) => void }) {
  const [mode, setMode] = useState<"username" | "email-code">("username");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [verifyOtp, setVerifyOtp] = useState<null | ((params: { token: string }) => Promise<{ error: { message?: string } | null }>)>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSaving(true);
    try {
      const result = mode === "username"
        ? await signInWithCloudbaseUsername(username.trim(), password)
        : verifyOtp
          ? await verifyCloudbaseEmailCode(verifyOtp, code.trim())
          : (() => { throw new Error("请先获取邮箱验证码。"); })();
      if (!result.currentUser) throw new Error("未读取到当前用户信息。");
      onSuccess(result.currentUser);
    } catch (reason) {
      setError(readableError(reason));
    } finally {
      setSaving(false);
    }
  }

  async function sendCode() {
    setError("");
    setSaving(true);
    try {
      // React 对函数形式的 state setter 会将其视为“更新器”；用外层函数保存 SDK 回调本身。
      const callback = await requestCloudbaseEmailCode(email.trim());
      setVerifyOtp(() => callback);
    } catch (reason) {
      setError(readableError(reason));
    } finally {
      setSaving(false);
    }
  }

  return <main className="cloudbase-login-screen"><form className="cloudbase-login-card" onSubmit={submit}>
    <span className="cloudbase-login-mark">仓</span>
    <p className="eyebrow">腾讯云 CloudBase</p>
    <h1>登录仓储台</h1>
    <p>请选择与你的 CloudBase 身份认证配置一致的登录方式。</p>
    <div className="login-mode-tabs">
      <button type="button" className={mode === "username" ? "selected" : ""} onClick={() => { setMode("username"); setError(""); }}>用户名密码</button>
      <button type="button" className={mode === "email-code" ? "selected" : ""} onClick={() => { setMode("email-code"); setError(""); }}>邮箱验证码</button>
    </div>
    {mode === "username" ? <>
      <label><span>用户名</span><input autoComplete="username" required value={username} onChange={(event) => setUsername(event.target.value)} placeholder="输入 CloudBase 用户名" /></label>
      <label><span>密码</span><input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} placeholder="输入密码" /></label>
    </> : <>
      <label><span>邮箱</span><input type="email" autoComplete="email" required value={email} onChange={(event) => { setEmail(event.target.value); setVerifyOtp(null); }} placeholder="name@example.com" /></label>
      <button type="button" className="secondary-button" disabled={saving || !email.trim()} onClick={sendCode}>{verifyOtp ? "重新获取验证码" : "获取邮箱验证码"}</button>
      {verifyOtp && <label><span>验证码</span><input inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(event) => setCode(event.target.value)} placeholder="输入邮箱收到的验证码" /></label>}
    </>}
    {error && <div className="form-error"><span>!</span>{error}</div>}
    <button className="primary-button" disabled={saving || (mode === "email-code" && !verifyOtp)}>{saving ? "正在登录…" : "登录并进入仓库"}</button>
  </form></main>;
}
