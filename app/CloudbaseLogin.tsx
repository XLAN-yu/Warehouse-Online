"use client";

import { FormEvent, useState } from "react";
import {
  registerCloudbaseUser,
  requestCloudbaseEmailCode,
  requestCloudbaseRegistrationCode,
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
  const [mode, setMode] = useState<"username" | "email-code" | "register">("username");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [verifyOtp, setVerifyOtp] = useState<null | ((params: { token: string }) => Promise<{ error: { message?: string } | null }>)>(null);
  const [registrationEmail, setRegistrationEmail] = useState("");
  const [registrationUsername, setRegistrationUsername] = useState("");
  const [registrationPassword, setRegistrationPassword] = useState("");
  const [registrationCode, setRegistrationCode] = useState("");
  const [registrationVerificationId, setRegistrationVerificationId] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSaving(true);
    try {
      const result = mode === "username"
        ? await signInWithCloudbaseUsername(username.trim(), password)
        : mode === "email-code"
          ? verifyOtp
            ? await verifyCloudbaseEmailCode(verifyOtp, code.trim())
            : (() => { throw new Error("请先获取邮箱验证码。"); })()
          : registrationVerificationId
            ? await registerCloudbaseUser({ email: registrationEmail.trim(), username: registrationUsername.trim(), password: registrationPassword, verificationId: registrationVerificationId, code: registrationCode.trim() })
            : (() => { throw new Error("请先获取注册验证码。"); })();
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

  async function sendRegistrationCode() {
    setError("");
    setSaving(true);
    try {
      const id = await requestCloudbaseRegistrationCode(registrationEmail.trim());
      setRegistrationVerificationId(id);
    } catch (reason) {
      setError(readableError(reason));
    } finally {
      setSaving(false);
    }
  }

  return <main className="cloudbase-login-screen"><form className="cloudbase-login-card" onSubmit={submit}>
    <span className="cloudbase-login-mark">仓</span>
    <p className="eyebrow">腾讯云 CloudBase</p>
    <h1>{mode === "register" ? "注册仓储台" : "登录仓储台"}</h1>
    <p>{mode === "register" ? "注册后即可进入共享仓库，最高管理员可进一步管理你的权限。" : "请选择与你的 CloudBase 身份认证配置一致的登录方式。"}</p>
    <div className="login-mode-tabs">
      <button type="button" className={mode === "username" ? "selected" : ""} onClick={() => { setMode("username"); setError(""); }}>用户名密码</button>
      <button type="button" className={mode === "email-code" ? "selected" : ""} onClick={() => { setMode("email-code"); setError(""); }}>邮箱验证码</button>
      <button type="button" className={mode === "register" ? "selected" : ""} onClick={() => { setMode("register"); setError(""); }}>注册账号</button>
    </div>
    {mode === "username" ? <>
      <label><span>用户名</span><input autoComplete="username" required value={username} onChange={(event) => setUsername(event.target.value)} placeholder="输入 CloudBase 用户名" /></label>
      <label><span>密码</span><input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} placeholder="输入密码" /></label>
    </> : mode === "email-code" ? <>
      <label><span>邮箱</span><input type="email" autoComplete="email" required value={email} onChange={(event) => { setEmail(event.target.value); setVerifyOtp(null); }} placeholder="name@example.com" /></label>
      <button type="button" className="secondary-button" disabled={saving || !email.trim()} onClick={sendCode}>{verifyOtp ? "重新获取验证码" : "获取邮箱验证码"}</button>
      {verifyOtp && <label><span>验证码</span><input inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(event) => setCode(event.target.value)} placeholder="输入邮箱收到的验证码" /></label>}
    </> : <>
      <label><span>用户名</span><input autoComplete="username" required minLength={5} maxLength={24} value={registrationUsername} onChange={(event) => setRegistrationUsername(event.target.value)} placeholder="5–24 位英文、数字或 - _" /></label>
      <label><span>邮箱</span><input type="email" autoComplete="email" required value={registrationEmail} onChange={(event) => { setRegistrationEmail(event.target.value); setRegistrationVerificationId(""); }} placeholder="name@example.com" /></label>
      <label><span>设置密码</span><input type="password" autoComplete="new-password" required minLength={8} maxLength={32} value={registrationPassword} onChange={(event) => setRegistrationPassword(event.target.value)} placeholder="8–32 位，需包含字母和数字" /></label>
      <button type="button" className="secondary-button" disabled={saving || !registrationEmail.trim() || !registrationUsername.trim() || registrationPassword.length < 8} onClick={sendRegistrationCode}>{registrationVerificationId ? "重新获取注册验证码" : "获取注册验证码"}</button>
      {registrationVerificationId && <label><span>邮箱验证码</span><input inputMode="numeric" autoComplete="one-time-code" required value={registrationCode} onChange={(event) => setRegistrationCode(event.target.value)} placeholder="输入邮箱收到的验证码" /></label>}
    </>}
    {error && <div className="form-error"><span>!</span>{error}</div>}
    <button className="primary-button" disabled={saving || (mode === "email-code" && !verifyOtp) || (mode === "register" && !registrationVerificationId)}>{saving ? (mode === "register" ? "正在注册…" : "正在登录…") : mode === "register" ? "注册并进入仓库" : "登录并进入仓库"}</button>
  </form></main>;
}
