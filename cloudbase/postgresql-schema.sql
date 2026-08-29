-- 仓储台 CloudBase PostgreSQL 初始化脚本。
-- 在 CloudBase 控制台：SQL 型数据库 → SQL 编辑器 → 粘贴并执行。
-- 本脚本不包含任何初始商品或单据数据。

CREATE TABLE IF NOT EXISTS public.warehouse_users (
  id            text PRIMARY KEY,
  email         text NOT NULL,
  display_name  text NOT NULL,
  role          text NOT NULL DEFAULT 'pending'
                CHECK (role IN ('owner', 'admin', 'operator', 'viewer', 'pending')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz,
  updated_by    text
);

CREATE TABLE IF NOT EXISTS public.warehouse_state (
  id            text PRIMARY KEY,
  data          jsonb NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- 前端不会直连这两张表；所有访问都通过已登录用户才能调用的云函数。
-- 显式开启 RLS，避免以后误接入 REST API 时泄露仓储数据。
ALTER TABLE public.warehouse_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.warehouse_state ENABLE ROW LEVEL SECURITY;
