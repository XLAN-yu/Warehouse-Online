"use client";

import { FormEvent, useState } from "react";
import { signInWithCloudbaseEmail } from "./cloudbase-client";

type CloudbaseUser = { id: string; email: string; displayName: string; role: string };

export function CloudbaseLogin({ onSuccess }: { onSuccess: (user: CloudbaseUser) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSaving(true);
    try {
      const result = await signInWithCloudbaseEmail(email.trim(), password);
      if (!result.currentUser) throw new Error("未读取到当前用户信息。");
      onSuccess(result.currentUser);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "登录失败，请检查邮箱和密码。");
    } finally {
      setSaving(false);
    }
  }

  return <main className="cloudbase-login-screen"><form className="cloudbase-login-card" onSubmit={submit}>
    <span className="cloudbase-login-mark">仓</span>
    <p className="eyebrow">腾讯云 CloudBase</p>
    <h1>登录仓储台</h1>
    <p>登录后才能访问共享仓库数据。首次使用请先在 CloudBase 身份认证中创建邮箱账号。</p>
    <label><span>邮箱</span><input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" /></label>
    <label><span>密码</span><input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} placeholder="输入密码" /></label>
    {error && <div className="form-error"><span>!</span>{error}</div>}
    <button className="primary-button" disabled={saving}>{saving ? "正在登录…" : "登录并进入仓库"}</button>
  </form></main>;
}
