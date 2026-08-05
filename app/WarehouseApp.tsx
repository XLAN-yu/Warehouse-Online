"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Role = "admin" | "viewer";
type Page =
  | "home"
  | "inbound"
  | "outbound"
  | "inventory"
  | "stocktake"
  | "reports"
  | "records"
  | "products"
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
  last_seen_at: string;
};
type AuditLog = {
  id: string;
  entity_type: string;
  action: string;
  created_at: string;
  operator_user_id: string;
};
type AppData = {
  currentUser: WarehouseUser;
  products: Product[];
  suppliers: Supplier[];
  documents: WarehouseDocument[];
  users: WarehouseUser[];
  auditLogs: AuditLog[];
};

type FormLine = { key: string; productId: string; quantity: string; unitPrice: string };

const PRODUCT_STATUS: Record<string, { label: string; tone: string }> = {
  normal: { label: "正常供货", tone: "green" },
  ordered: { label: "补货已下单", tone: "blue" },
  price_changed: { label: "价格有变动", tone: "orange" },
  alternate: { label: "启用替代供货", tone: "violet" },
  paused: { label: "暂停采购", tone: "gray" },
};

const NAV_ITEMS: Array<{ page: Page; label: string; glyph: string; adminOnly?: boolean }> = [
  { page: "home", label: "工作台", glyph: "⌂" },
  { page: "inbound", label: "入库登记", glyph: "↘", adminOnly: true },
  { page: "outbound", label: "出库登记", glyph: "↗", adminOnly: true },
  { page: "inventory", label: "查看库存", glyph: "▦" },
  { page: "stocktake", label: "库存盘点", glyph: "✓", adminOnly: true },
  { page: "reports", label: "库存报表", glyph: "▤" },
  { page: "records", label: "流水记录", glyph: "≡" },
  { page: "products", label: "商品资料", glyph: "◇", adminOnly: true },
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
  return NAV_ITEMS.find((item) => item.page === page)?.label ?? "工作台";
}

async function apiPost(body: Record<string, unknown>) {
  const response = await fetch("/api/warehouse", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json()) as { error?: string } & Record<string, unknown>;
  if (!response.ok) throw new Error(data.error || "提交失败，请重试。");
  return data;
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
      PRODUCT_STATUS[product.status]?.label ?? product.status,
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

function StatusBadge({ status }: { status: string }) {
  const item = PRODUCT_STATUS[status] ?? { label: status, tone: "gray" };
  return <span className={`status-badge ${item.tone}`}>{item.label}</span>;
}

function ProductAutocomplete({
  products,
  value,
  onChange,
  disabled,
}: {
  products: Product[];
  value: string;
  onChange: (id: string) => void;
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
      .filter((product) => `${product.code} ${product.name}`.toLowerCase().includes(term))
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
  const isAdmin = currentUser.role === "admin";
  const today = new Date().toISOString().slice(0, 10);
  const activeToday = documents.filter(
    (document) => document.status === "active" && document.effective_at.startsWith(today),
  );
  const lowStock = products.filter((product) => product.current_stock <= product.min_stock);
  const inventoryValue = products.reduce(
    (sum, product) => sum + product.current_stock * (product.average_cost_cents ?? 0),
    0,
  );
  const inboundToday = activeToday
    .filter((document) => document.type === "inbound")
    .reduce((sum, document) => sum + document.items.reduce((itemSum, item) => itemSum + item.quantity, 0), 0);
  const outboundToday = activeToday
    .filter((document) => document.type === "outbound")
    .reduce((sum, document) => sum + document.items.reduce((itemSum, item) => itemSum + item.quantity, 0), 0);

  return (
    <div className="page-stack">
      <section className="welcome-panel">
        <div>
          <p className="eyebrow">今日仓库概览</p>
          <h1>库存清楚，出入有据。</h1>
          <p>从登记、盘点到报表，每一次变动都由当前账号自动留痕。</p>
        </div>
        <div className="today-block"><span>{new Date().getDate()}</span><small>{new Intl.DateTimeFormat("zh-CN", { month: "long", weekday: "short" }).format(new Date())}</small></div>
      </section>

      <section className="quick-grid">
        <button className="quick-card inbound" onClick={() => onNavigate(isAdmin ? "inbound" : "inventory")}>
          <span className="quick-icon">↘</span>
          <div><small>{isAdmin ? "快速登记" : "实时查看"}</small><strong>{isAdmin ? "商品入库" : "查看库存"}</strong><p>{isAdmin ? "支持多商品与图片识别" : "金额信息已按权限隐藏"}</p></div>
          <i>→</i>
        </button>
        <button className="quick-card outbound" onClick={() => onNavigate(isAdmin ? "outbound" : "reports")}>
          <span className="quick-icon">↗</span>
          <div><small>{isAdmin ? "库存校验" : "数据汇总"}</small><strong>{isAdmin ? "商品出库" : "库存报表"}</strong><p>{isAdmin ? "库存不足时立即拦截" : "日报、月报、年报"}</p></div>
          <i>→</i>
        </button>
        <button className="quick-card stock" onClick={() => onNavigate(isAdmin ? "stocktake" : "records")}>
          <span className="quick-icon">✓</span>
          <div><small>{isAdmin ? "实盘修正" : "变动追踪"}</small><strong>{isAdmin ? "开始盘点" : "流水记录"}</strong><p>{isAdmin ? "自动生成盘盈盘亏" : "查看所有历史单据"}</p></div>
          <i>→</i>
        </button>
      </section>

      <section className="metric-grid">
        <article><div className="metric-heading"><span className="dot green-dot" />库存商品</div><strong>{number(products.length)}<small> 种</small></strong><p>{products.reduce((sum, product) => sum + product.current_stock, 0)} 件在库</p></article>
        <article><div className="metric-heading"><span className="dot blue-dot" />今日入库</div><strong>{number(inboundToday)}<small> 件</small></strong><p>{activeToday.filter((document) => document.type === "inbound").length} 张入库单</p></article>
        <article><div className="metric-heading"><span className="dot orange-dot" />今日出库</div><strong>{number(outboundToday)}<small> 件</small></strong><p>{activeToday.filter((document) => document.type === "outbound").length} 张出库单</p></article>
        <article className={lowStock.length ? "alert-metric" : ""}><div className="metric-heading"><span className="dot red-dot" />库存预警</div><strong>{number(lowStock.length)}<small> 种</small></strong><p>{lowStock.length ? "需要及时处理" : "当前库存充足"}</p></article>
        {isAdmin && <article><div className="metric-heading"><span className="dot violet-dot" />库存金额</div><strong className="money-metric">{money(inventoryValue)}</strong><p>按移动加权平均价</p></article>}
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
  onSaved,
  onCancelEdit,
}: {
  type: "inbound" | "outbound";
  data: AppData;
  editing: WarehouseDocument | null;
  onSaved: (message: string) => Promise<void>;
  onCancelEdit: () => void;
}) {
  const firstLines = () =>
    editing?.items.map((item) => ({
      key: crypto.randomUUID(),
      productId: item.product_id,
      quantity: String(item.quantity),
      unitPrice: type === "inbound" ? String((item.unit_price_cents ?? 0) / 100) : "",
    })) ?? [{ key: crypto.randomUUID(), productId: "", quantity: "", unitPrice: "" }];
  const [lines, setLines] = useState<FormLine[]>(firstLines);
  const [purpose, setPurpose] = useState(editing?.purpose ?? "");
  const [supplier, setSupplier] = useState(editing?.supplier_name ?? "");
  const [reference, setReference] = useState(editing?.external_ref ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [showOcr, setShowOcr] = useState(false);

  useEffect(() => {
    setLines(firstLines());
    setPurpose(editing?.purpose ?? "");
    setSupplier(editing?.supplier_name ?? "");
    setReference(editing?.external_ref ?? "");
    setError("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.id, type]);

  const totalQuantity = lines.reduce((sum, line) => sum + (Number(line.quantity) || 0), 0);
  const totalAmount = lines.reduce((sum, line) => sum + (Number(line.quantity) || 0) * (Number(line.unitPrice) || 0), 0);

  function updateLine(key: string, patch: Partial<FormLine>) {
    setLines((current) => current.map((line) => line.key === key ? { ...line, ...patch } : line));
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
      const result = await apiPost({
        action: "create-document",
        type,
        purpose,
        supplierName: type === "inbound" ? supplier : "",
        externalRef: type === "inbound" ? reference : "",
        revisionOf: editing?.id,
        items: validLines.map((line) => ({ productId: line.productId, quantity: Number(line.quantity), unitPrice: Number(line.unitPrice || 0) })),
      });
      setLines([{ key: crypto.randomUUID(), productId: "", quantity: "", unitPrice: "" }]);
      setPurpose(""); setSupplier(""); setReference("");
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
        <div className="form-section-heading"><div><span>01</span><div><h2>单据信息</h2><p>操作人将自动记录为 {data.currentUser.display_name}</p></div></div>{editing && <button type="button" className="text-button" onClick={onCancelEdit}>退出修改</button>}</div>
        <div className={`document-meta-grid ${type}`}>
          {type === "inbound" && <label><span>本次实际供应商</span><input list="supplier-options" value={supplier} onChange={(event) => setSupplier(event.target.value)} placeholder="选择或输入供应商" /><datalist id="supplier-options">{data.suppliers.map((item) => <option key={item.id} value={item.name} />)}</datalist></label>}
          <label><span>用途 <em>{type === "inbound" ? "选填" : "必填"}</em></span><input value={purpose} required={type === "outbound"} onChange={(event) => setPurpose(event.target.value)} placeholder={type === "inbound" ? "例如：常规补货" : "例如：生产领用 / 客户发货"} /></label>
          {type === "inbound" && <label><span>供应商单号 <em>选填</em></span><input value={reference} onChange={(event) => setReference(event.target.value)} placeholder="送货单号或订单号" /></label>}
        </div>
        <div className="form-divider" />
        <div className="form-section-heading"><div><span>02</span><div><h2>商品明细</h2><p>输入部分品名或编号即可联想查找</p></div></div><button type="button" className="small-add-button" onClick={() => setLines((current) => [...current, { key: crypto.randomUUID(), productId: "", quantity: "", unitPrice: "" }])}>＋ 添加一行</button></div>
        <div className="line-table">
          <div className={`line-head ${type}`}><span>商品</span><span>当前库存</span><span>数量</span>{type === "inbound" ? <span>实际单价</span> : <span>计价方式</span>}<span /> </div>
          {lines.map((line, index) => {
            const product = data.products.find((item) => item.id === line.productId);
            return <div className={`line-row ${type}`} key={line.key}>
              <div className="line-product"><small>{String(index + 1).padStart(2, "0")}</small><ProductAutocomplete products={data.products} value={line.productId} onChange={(productId) => updateLine(line.key, { productId })} /></div>
              <div className={`stock-cell ${product && Number(line.quantity) > product.current_stock && type === "outbound" ? "danger" : ""}`}>{product ? <><b>{product.current_stock}</b><small>{product.unit}</small></> : "—"}</div>
              <label className="number-input"><input inputMode="numeric" min="1" step="1" value={line.quantity} onChange={(event) => updateLine(line.key, { quantity: event.target.value })} placeholder="0" /><span>{product?.unit ?? "件"}</span></label>
              {type === "inbound" ? <label className="number-input price-input"><span>¥</span><input inputMode="decimal" min="0" step="0.01" value={line.unitPrice} onChange={(event) => updateLine(line.key, { unitPrice: event.target.value })} placeholder="0.00" /></label> : <div className="cost-rule"><strong>移动平均价</strong>{data.currentUser.role === "admin" && product ? <small>当前 {money(product.average_cost_cents)}</small> : <small>提交时自动计算</small>}</div>}
              <button type="button" className="remove-line" disabled={lines.length === 1} onClick={() => setLines((current) => current.filter((item) => item.key !== line.key))}>×</button>
            </div>;
          })}
        </div>
        {error && <div className="form-error"><span>!</span>{error}</div>}
        <div className="document-footer"><div className="document-summary"><span>共 <b>{lines.filter((line) => line.productId).length}</b> 种商品</span><span>合计数量 <b>{totalQuantity}</b></span>{type === "inbound" && <span>入库金额 <strong>{money(Math.round(totalAmount * 100))}</strong></span>}</div><button className={`submit-document ${type}`} disabled={saving}>{saving ? "正在校验并保存…" : editing ? "确认修改" : type === "inbound" ? "确认入库" : "确认出库"}<span>→</span></button></div>
      </form>
      {showOcr && <OcrDialog products={data.products} onClose={() => setShowOcr(false)} onApply={(ocr) => { if (ocr.supplier) setSupplier(ocr.supplier); if (ocr.reference) setReference(ocr.reference); if (ocr.items.length) setLines(ocr.items); setShowOcr(false); }} />}
    </div>
  );
}

function InventoryView({ data }: { data: AppData }) {
  const [query, setQuery] = useState("");
  const [onlyLow, setOnlyLow] = useState(false);
  const filtered = data.products.filter((product) => {
    const matches = `${product.code} ${product.name}`.toLowerCase().includes(query.toLowerCase());
    return matches && (!onlyLow || product.current_stock <= product.min_stock);
  });
  return (
    <div className="page-stack">
      <section className="page-heading"><div><p className="eyebrow">实时库存</p><h1>查看库存</h1><p>库存低于或等于最低库存时自动标记提醒。</p></div><div className="heading-stats"><span><small>商品种类</small><b>{data.products.length}</b></span><span><small>库存总数</small><b>{data.products.reduce((sum, item) => sum + item.current_stock, 0)}</b></span></div></section>
      <section className="panel data-panel">
        <div className="table-toolbar"><label className="search-box"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索品名或商品编号" /></label><label className="check-filter"><input type="checkbox" checked={onlyLow} onChange={(event) => setOnlyLow(event.target.checked)} />只看库存预警</label><span className="result-count">{filtered.length} 条结果</span></div>
        {filtered.length ? <div className={`data-table inventory-table ${data.currentUser.role === "viewer" ? "viewer" : ""}`}>
          <div className="table-head"><span>商品信息</span><span>状态</span><span>当前库存</span><span>最低库存</span><span>默认供应商</span>{data.currentUser.role === "admin" && <><span>平均成本</span><span>库存金额</span></>}</div>
          {filtered.map((product) => {
            const low = product.current_stock <= product.min_stock;
            return <div className={`table-row ${low ? "low-row" : ""}`} key={product.id}>
              <div className="product-identity"><span>{product.name.slice(0, 1)}</span><div><strong>{product.name}</strong><small>{product.code} · {product.unit}</small></div></div>
              <div><StatusBadge status={product.status} /></div>
              <div className="quantity-cell"><strong>{number(product.current_stock)}</strong><small>{product.unit}</small>{low && <em>低库存</em>}</div>
              <div>{product.min_stock} {product.unit}</div>
              <div>{product.default_supplier_name ?? "—"}</div>
              {data.currentUser.role === "admin" && <><div>{money(product.average_cost_cents)}</div><div className="money-cell">{money((product.average_cost_cents ?? 0) * product.current_stock)}</div></>}
            </div>;
          })}
        </div> : <EmptyState title="没有匹配的商品" detail="请更换搜索词或筛选条件。" />}
      </section>
    </div>
  );
}

function StocktakeView({ data, onSaved }: { data: AppData; onSaved: (message: string) => Promise<void> }) {
  const [query, setQuery] = useState("");
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [purpose, setPurpose] = useState("定期盘点");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const filtered = data.products.filter((product) => `${product.code} ${product.name}`.toLowerCase().includes(query.toLowerCase()));
  const changed = data.products.filter((product) => counts[product.id] !== undefined && counts[product.id] !== "" && Number(counts[product.id]) !== product.current_stock);
  async function submit() {
    if (!changed.length) return setError("请至少填写一项与账面库存不同的实盘数量。");
    if (changed.some((product) => !Number.isInteger(Number(counts[product.id])) || Number(counts[product.id]) < 0)) return setError("实盘数量必须是大于或等于 0 的整数。");
    setSaving(true); setError("");
    try {
      const result = await apiPost({ action: "stocktake", purpose, items: changed.map((product) => ({ productId: product.id, countedQuantity: Number(counts[product.id]) })) });
      setCounts({});
      await onSaved(`盘点完成：${String(result.documentNo)}`);
    } catch (submitError) { setError(submitError instanceof Error ? submitError.message : "盘点提交失败。"); }
    finally { setSaving(false); }
  }
  return (
    <div className="page-stack">
      <section className="page-hero compact stocktake"><div><p className="eyebrow">账实核对 · 自动留痕</p><h1>库存盘点</h1><p>填写实盘数量，系统自动生成盘盈盘亏记录；不会直接覆盖历史。</p></div><div className="stocktake-counter"><small>待调整</small><strong>{changed.length}</strong><span>种商品</span></div></section>
      <section className="panel data-panel">
        <div className="table-toolbar stocktake-toolbar"><label className="search-box"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索需要盘点的商品" /></label><label className="purpose-field"><span>盘点说明</span><input value={purpose} onChange={(event) => setPurpose(event.target.value)} /></label></div>
        <div className="stocktake-table">
          <div className="table-head"><span>商品</span><span>账面数量</span><span>实盘数量</span><span>盘盈 / 盘亏</span></div>
          {filtered.map((product) => {
            const current = counts[product.id];
            const difference = current === undefined || current === "" ? 0 : Number(current) - product.current_stock;
            return <div className="table-row" key={product.id}><div className="product-identity"><span>{product.name.slice(0, 1)}</span><div><strong>{product.name}</strong><small>{product.code}</small></div></div><div className="book-quantity"><b>{product.current_stock}</b> {product.unit}</div><label className="count-input"><input min="0" step="1" inputMode="numeric" value={current ?? ""} onChange={(event) => { setCounts((values) => ({ ...values, [product.id]: event.target.value })); setError(""); }} placeholder={String(product.current_stock)} /><span>{product.unit}</span></label><div className={`difference ${difference > 0 ? "positive" : difference < 0 ? "negative" : ""}`}>{difference === 0 ? "—" : `${difference > 0 ? "+" : ""}${difference} ${product.unit}`}</div></div>;
          })}
        </div>
        {error && <div className="form-error"><span>!</span>{error}</div>}
        <div className="stocktake-footer"><p>只会提交已填写且与账面数量不同的商品。</p><button className="primary-button" disabled={saving} onClick={() => void submit()}>{saving ? "正在生成盘点单…" : `提交盘点（${changed.length}项）`}</button></div>
      </section>
    </div>
  );
}

function ReportsView({ data }: { data: AppData }) {
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
      <section className="page-heading report-heading"><div><p className="eyebrow">库存汇总</p><h1>库存报表</h1><p>按当前日期快速生成日报、月报或年报。</p></div><button className="export-button" onClick={() => exportExcel(data.products, filtered, data.currentUser.role === "admin", `库存${labels[period]}-${new Date().toISOString().slice(0, 10)}.xls`)}>⇩ 导出 Excel</button></section>
      <div className="period-tabs">{(["day", "month", "year"] as const).map((item) => <button key={item} className={period === item ? "active" : ""} onClick={() => setPeriod(item)}>{labels[item]}</button>)}</div>
      <section className="report-cards">
        <article><span className="report-icon inbound">↘</span><div><small>入库数量</small><strong>{number(inQty)} <em>件</em></strong><p>{inbound.length} 张入库单</p></div>{data.currentUser.role === "admin" && <b>{money(inValue)}</b>}</article>
        <article><span className="report-icon outbound">↗</span><div><small>出库数量</small><strong>{number(outQty)} <em>件</em></strong><p>{outbound.length} 张出库单</p></div>{data.currentUser.role === "admin" && <b>{money(outValue)}</b>}</article>
        <article><span className="report-icon stocktake">✓</span><div><small>盘点调整</small><strong>{stocktakes.length} <em>次</em></strong><p>{stocktakes.reduce((sum, document) => sum + document.items.length, 0)} 项盘盈盘亏</p></div></article>
      </section>
      <section className="panel data-panel">
        <div className="panel-heading"><div><p className="eyebrow">{labels[period]}明细</p><h2>{fullDate(new Date().toISOString())}</h2></div><span className="count-pill">{filtered.length}</span></div>
        {filtered.length ? <div className="report-list">{filtered.map((document) => <div key={document.id}><span className={`activity-icon ${document.type}`}>{document.type === "inbound" ? "↘" : document.type === "outbound" ? "↗" : "✓"}</span><div><strong>{document.document_no}</strong><p>{document.items.map((item) => item.product_name).slice(0, 2).join("、")}{document.items.length > 2 ? "等" : ""}</p></div><span>{document.items.reduce((sum, item) => sum + Math.abs(item.quantity), 0)} 件</span>{data.currentUser.role === "admin" && <b>{document.type === "inbound" ? money(document.items.reduce((sum, item) => sum + item.quantity * (item.unit_price_cents ?? 0), 0)) : document.type === "outbound" ? money(document.items.reduce((sum, item) => sum + item.quantity * (item.unit_cost_cents ?? 0), 0)) : "—"}</b>}<small>{dateTime(document.effective_at)}</small></div>)}</div> : <EmptyState title={`暂无${labels[period]}数据`} detail="该时间范围内还没有有效的出入库或盘点单据。" />}
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
  const [query, setQuery] = useState("");
  const [savingId, setSavingId] = useState("");
  const [drafts, setDrafts] = useState<Record<string, { status: string; minStock: string; supplier: string }>>({});
  const filtered = data.products.filter((product) => `${product.code} ${product.name}`.toLowerCase().includes(query.toLowerCase()));
  function draft(product: Product) { return drafts[product.id] ?? { status: product.status, minStock: String(product.min_stock), supplier: product.default_supplier_name ?? "" }; }
  async function saveProduct(product: Product) {
    const values = draft(product); setSavingId(product.id);
    try { await apiPost({ action: "update-product", id: product.id, status: values.status, minStock: Number(values.minStock), defaultSupplierName: values.supplier }); await onRefresh(`${product.name}的资料已更新。`); }
    catch (error) { window.alert(error instanceof Error ? error.message : "更新失败。"); }
    finally { setSavingId(""); }
  }
  return (
    <div className="page-stack">
      <section className="page-heading"><div><p className="eyebrow">商品主数据</p><h1>商品资料</h1><p>编号可人工填写或由系统生成；默认供应商可随时调整。</p></div><button className="primary-button" onClick={() => setShowCreate(true)}>＋ 新增商品</button></section>
      <section className="panel data-panel">
        <div className="table-toolbar"><label className="search-box"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索商品" /></label><span className="result-count">{filtered.length} 种商品</span></div>
        {filtered.length ? <div className="product-admin-list">{filtered.map((product) => { const values = draft(product); const changed = values.status !== product.status || values.minStock !== String(product.min_stock) || values.supplier !== (product.default_supplier_name ?? ""); return <article key={product.id}>
          <div className="product-identity"><span>{product.name.slice(0, 1)}</span><div><strong>{product.name}</strong><small>{product.code} · {product.unit} · 库存 {product.current_stock}</small></div></div>
          <label><small>供应状态</small><select value={values.status} onChange={(event) => setDrafts((current) => ({ ...current, [product.id]: { ...values, status: event.target.value } }))}>{Object.entries(PRODUCT_STATUS).map(([key, value]) => <option value={key} key={key}>{value.label}</option>)}</select></label>
          <label><small>最低库存</small><input type="number" min="0" step="1" value={values.minStock} onChange={(event) => setDrafts((current) => ({ ...current, [product.id]: { ...values, minStock: event.target.value } }))} /></label>
          <label><small>默认供应商</small><input list="supplier-options-product" value={values.supplier} onChange={(event) => setDrafts((current) => ({ ...current, [product.id]: { ...values, supplier: event.target.value } }))} /></label>
          <button className="save-inline" disabled={!changed || savingId === product.id} onClick={() => void saveProduct(product)}>{savingId === product.id ? "保存中" : "保存"}</button>
        </article>; })}<datalist id="supplier-options-product">{data.suppliers.map((supplier) => <option value={supplier.name} key={supplier.id} />)}</datalist></div> : <EmptyState title="还没有商品资料" detail="新增第一个商品后即可开始入库。" />}
      </section>
      {showCreate && <CreateProductModal suppliers={data.suppliers} onClose={() => setShowCreate(false)} onCreated={async (message) => { setShowCreate(false); await onRefresh(message); }} />}
    </div>
  );
}

function CreateProductModal({ suppliers, onClose, onCreated }: { suppliers: Supplier[]; onClose: () => void; onCreated: (message: string) => Promise<void> }) {
  const [form, setForm] = useState({ codeMode: "auto", code: "", name: "", unit: "件", minStock: "0", status: "normal", defaultSupplier: "", alternates: "" });
  const [saving, setSaving] = useState(false); const [error, setError] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setError("");
    try { const result = await apiPost({ action: "add-product", name: form.name, code: form.codeMode === "manual" ? form.code : "", unit: form.unit, minStock: Number(form.minStock), status: form.status, defaultSupplierName: form.defaultSupplier, alternateSuppliers: form.alternates.split(/[，,]/).map((item) => item.trim()).filter(Boolean) }); await onCreated(`商品已建立：${form.name}（${String(result.code)}）`); }
    catch (submitError) { setError(submitError instanceof Error ? submitError.message : "新增失败。"); }
    finally { setSaving(false); }
  }
  return <div className="modal-backdrop" role="dialog" aria-modal="true"><form className="modal-card product-modal" onSubmit={submit}><div className="modal-heading"><div><p className="eyebrow">商品主数据</p><h2>新增商品</h2></div><button type="button" className="close-button" onClick={onClose}>×</button></div>
    <div className="code-mode"><button type="button" className={form.codeMode === "auto" ? "active" : ""} onClick={() => setForm({ ...form, codeMode: "auto" })}><b>系统生成</b><span>例如 SKU-000001</span></button><button type="button" className={form.codeMode === "manual" ? "active" : ""} onClick={() => setForm({ ...form, codeMode: "manual" })}><b>人工填写</b><span>重复编号会被拦截</span></button></div>
    <div className="modal-form-grid">{form.codeMode === "manual" && <label><span>商品编号</span><input required value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} placeholder="例如 WL-2026-001" /></label>}<label className={form.codeMode === "auto" ? "wide" : ""}><span>商品名称</span><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="输入品名" /></label><label><span>单位</span><input required value={form.unit} onChange={(event) => setForm({ ...form, unit: event.target.value })} /></label><label><span>最低库存</span><input required type="number" min="0" step="1" value={form.minStock} onChange={(event) => setForm({ ...form, minStock: event.target.value })} /></label><label><span>供应状态</span><select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}>{Object.entries(PRODUCT_STATUS).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}</select></label><label><span>默认供应商</span><input list="new-product-suppliers" value={form.defaultSupplier} onChange={(event) => setForm({ ...form, defaultSupplier: event.target.value })} placeholder="选择或新建" /></label><label className="wide"><span>替代供应商 <em>多个名称用逗号分隔</em></span><input value={form.alternates} onChange={(event) => setForm({ ...form, alternates: event.target.value })} placeholder="例如：华东备选供应、同城急送" /></label><datalist id="new-product-suppliers">{suppliers.map((item) => <option value={item.name} key={item.id} />)}</datalist></div>
    {error && <div className="form-error"><span>!</span>{error}</div>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving}>{saving ? "正在保存…" : "建立商品"}</button></div>
  </form></div>;
}

function UsersView({ data, onRefresh }: { data: AppData; onRefresh: (message: string) => Promise<void> }) {
  const [busy, setBusy] = useState("");
  async function change(user: WarehouseUser, role: Role) {
    setBusy(user.id);
    try { await apiPost({ action: "set-role", userId: user.id, role }); await onRefresh(`${user.display_name}已设为${role === "admin" ? "管理员" : "查看者"}。`); }
    catch (error) { window.alert(error instanceof Error ? error.message : "权限修改失败。"); }
    finally { setBusy(""); }
  }
  return <div className="page-stack"><section className="page-heading"><div><p className="eyebrow">账号与可见范围</p><h1>用户权限</h1><p>管理员可操作全部业务；查看者不能执行变动，也无法通过接口或导出查看金额。</p></div></section><section className="role-explainer"><article><span>管</span><div><strong>管理员</strong><p>商品、出入库、盘点、金额、备份与权限管理</p></div></article><article><span>看</span><div><strong>查看者</strong><p>仅查看库存数量、无金额报表与流水记录</p></div></article></section><section className="panel user-list">{data.users.map((user) => <article key={user.id}><div className="avatar">{user.display_name.slice(0, 1).toUpperCase()}</div><div><strong>{user.display_name}{user.id === data.currentUser.id && <em>当前账号</em>}</strong><p>{user.email} · 最近登录 {dateTime(user.last_seen_at)}</p></div><select disabled={busy === user.id} value={user.role} onChange={(event) => void change(user, event.target.value as Role)}><option value="admin">管理员</option><option value="viewer">查看者</option></select></article>)}</section></div>;
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
  const response = await fetch("/api/warehouse?view=backup");
  const backup = await response.json();
  if (!response.ok) throw new Error(backup.error || "生成备份失败。");
  return backup;
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
  return <div className="page-stack"><section className="page-heading"><div><p className="eyebrow">数据安全</p><h1>备份与恢复</h1><p>每周保存到你选择的 Windows 文件夹，并自动清理超过 30 天的旧备份。</p></div></section><section className="backup-grid"><article className="backup-card featured"><span className="backup-icon">↻</span><div><small>每周自动备份</small><h2>{folder ? "本机文件夹已连接" : "连接本机备份文件夹"}</h2><p>{folder ? `保存位置：${folder}。浏览器打开网站时会检查并执行到期备份。` : "首次选择文件夹并授权后，网站才能定期写入备份文件。"}</p>{lastBackup && <em>上次备份：{dateTime(lastBackup)}</em>}</div><button disabled={!supportsFolder || busy === "folder"} onClick={() => void connectFolder()}>{busy === "folder" ? "正在连接…" : folder ? "更换文件夹" : supportsFolder ? "选择文件夹" : "当前浏览器不支持"}</button></article><article className="backup-card"><span className="backup-icon">⇩</span><div><small>立即保存</small><h2>手动下载备份</h2><p>下载完整 JSON 备份到当前电脑，可用于恢复。</p></div><button disabled={busy === "backup"} onClick={() => void manualBackup()}>{busy === "backup" ? "正在生成…" : "下载备份"}</button></article><article className="backup-card"><span className="backup-icon">▤</span><div><small>业务数据</small><h2>全量 Excel 导出</h2><p>包含全部库存和流水；金额仅管理员可导出。</p></div><button onClick={() => exportExcel(data.products, data.documents, true, `仓库全量数据-${new Date().toISOString().slice(0, 10)}.xls`)}>导出 Excel</button></article><article className="backup-card warning"><span className="backup-icon">↑</span><div><small>谨慎操作</small><h2>从备份恢复</h2><p>恢复前会再次确认，现有历史不会被无提示覆盖。</p></div><button disabled={busy === "restore"} onClick={() => restoreInput.current?.click()}>{busy === "restore" ? "正在恢复…" : "选择备份文件"}</button><input ref={restoreInput} hidden type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void restore(file); }} /></article></section><section className="retention-note"><span>i</span><div><strong>备份策略</strong><p>自动备份间隔 7 天，保留最近 30 天；手动下载的文件由你自行保管。建议使用 Edge 或 Chrome 并保持文件夹授权。</p></div></section></div>;
}

export function WarehouseApp() {
  const [data, setData] = useState<AppData | null>(null);
  const [page, setPage] = useState<Page>("home");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [toast, setToast] = useState("");
  const [navOpen, setNavOpen] = useState(false);
  const [editing, setEditing] = useState<WarehouseDocument | null>(null);

  const refresh = useCallback(async (message?: string) => {
    const response = await fetch("/api/warehouse", { cache: "no-store" });
    const result = (await response.json()) as AppData & { error?: string };
    if (!response.ok) throw new Error(result.error || "数据加载失败。");
    setData(result);
    if (message) { setToast(message); window.setTimeout(() => setToast(""), 3600); }
  }, []);

  useEffect(() => {
    refresh().catch((error) => setLoadError(error instanceof Error ? error.message : "数据加载失败。" )).finally(() => setLoading(false));
  }, [refresh]);

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
    if (data?.currentUser.role === "viewer" && NAV_ITEMS.find((item) => item.page === next)?.adminOnly) return;
    setPage(next); setNavOpen(false);
    if (next !== "inbound" && next !== "outbound") setEditing(null);
  }

  if (loading) return <main className="loading-screen"><div className="loading-mark"><span /><span /><span /></div><h1>仓储台</h1><p>正在核对库存数据…</p></main>;
  if (loadError || !data) return <main className="error-screen"><span>!</span><h1>暂时无法打开仓库</h1><p>{loadError}</p><button onClick={() => window.location.reload()}>重新加载</button></main>;
  const visibleNav = NAV_ITEMS.filter((item) => !(item.adminOnly && data.currentUser.role === "viewer"));

  return (
    <main className="app-shell">
      <aside className={navOpen ? "open" : ""}>
        <div className="brand"><span className="brand-box">仓</span><div><strong>仓储台</strong><small>库存管理系统</small></div></div>
        <nav>{visibleNav.map((item) => <button key={item.page} className={page === item.page ? "active" : ""} onClick={() => navigate(item.page)}><span>{item.glyph}</span>{item.label}{item.page === "inventory" && data.products.filter((product) => product.current_stock <= product.min_stock).length > 0 && <em>{data.products.filter((product) => product.current_stock <= product.min_stock).length}</em>}</button>)}</nav>
        <div className="sidebar-footer"><div className="user-mini"><span>{data.currentUser.display_name.slice(0, 1).toUpperCase()}</span><div><strong>{data.currentUser.display_name}</strong><small>{data.currentUser.role === "admin" ? "管理员" : "查看者"}</small></div></div><div className="system-state"><i />数据已连接</div></div>
      </aside>
      {navOpen && <button className="mobile-overlay" aria-label="关闭菜单" onClick={() => setNavOpen(false)} />}
      <section className="main-area">
        <header className="top-header"><button className="menu-button" onClick={() => setNavOpen(true)}>☰</button><div><small>仓库管理 /</small><strong>{pageTitle(page)}</strong></div><div className="header-actions"><span className="role-pill">{data.currentUser.role === "admin" ? "全部权限" : "金额已隐藏"}</span><button className="header-alert" onClick={() => navigate("inventory")}><span>!</span>{data.products.filter((product) => product.current_stock <= product.min_stock).length > 0 && <em>{data.products.filter((product) => product.current_stock <= product.min_stock).length}</em>}</button></div></header>
        <div className="content-area">
          {page === "home" && <Dashboard data={data} onNavigate={navigate} />}
          {page === "inbound" && <DocumentForm key={`in-${editing?.id ?? "new"}`} type="inbound" data={data} editing={editing} onCancelEdit={() => { setEditing(null); navigate("records"); }} onSaved={async (message) => { setEditing(null); await refresh(message); navigate("records"); }} />}
          {page === "outbound" && <DocumentForm key={`out-${editing?.id ?? "new"}`} type="outbound" data={data} editing={editing} onCancelEdit={() => { setEditing(null); navigate("records"); }} onSaved={async (message) => { setEditing(null); await refresh(message); navigate("records"); }} />}
          {page === "inventory" && <InventoryView data={data} />}
          {page === "stocktake" && <StocktakeView data={data} onSaved={refresh} />}
          {page === "reports" && <ReportsView data={data} />}
          {page === "records" && <RecordsView data={data} onRefresh={refresh} onEdit={(document) => { setEditing(document); navigate(document.type === "inbound" ? "inbound" : "outbound"); }} />}
          {page === "products" && <ProductsView data={data} onRefresh={refresh} />}
          {page === "users" && <UsersView data={data} onRefresh={refresh} />}
          {page === "backup" && <BackupView data={data} onRefresh={refresh} />}
        </div>
      </section>
      {toast && <div className="toast"><span>✓</span>{toast}</div>}
    </main>
  );
}
