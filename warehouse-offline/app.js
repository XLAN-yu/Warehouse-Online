(function () {
  "use strict";

  var page = "home";
  var period = "day";
  var documentType = "inbound";
  var draftLines = [{ product: "", quantity: "", price: "" }];
  var toastTimer = null;
  var dataReady = false;
  var saveQueue = Promise.resolve();

  function uid(prefix) {
    return prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  function now() { return new Date().toISOString(); }

  function initialData() {
    return {
      version: 1,
      products: [],
      documents: []
    };
  }

  function load() {
    fetch("/api/data", { cache: "no-store" })
      .then(function (response) {
        if (!response.ok) throw new Error("数据文件读取失败（" + response.status + "）");
        return response.json();
      })
      .then(function (parsed) {
        if (!parsed || !Array.isArray(parsed.products) || !Array.isArray(parsed.documents)) throw new Error("数据文件格式不正确");
        state = parsed;
        dataReady = true;
        render();
      })
      .catch(function (error) {
        var root = document.getElementById("app");
        root.innerHTML = '<main style="min-height:100vh;display:grid;place-items:center;background:#f3f6f2;padding:24px"><section style="max-width:620px;background:white;border:1px solid #dce5df;border-radius:24px;padding:36px;box-shadow:0 18px 50px rgba(28,54,43,.1)"><p style="color:#23845c;font-weight:700">启动方式不正确</p><h1 style="margin:8px 0 14px">请双击“启动仓储台.cmd”</h1><p style="line-height:1.8;color:#56645e">离线版需要由随包程序打开，才能把所有操作保存到 <b>data\\warehouse-data.json</b>。请关闭本页，回到解压后的文件夹并双击启动文件。</p><small style="color:#89948f">' + esc(error.message) + '</small></section></main>';
      });
  }

  var state = initialData();

  function save() {
    if (!dataReady) return;
    var snapshot = JSON.stringify(state);
    saveQueue = saveQueue.then(function () {
      return fetch("/api/data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: snapshot
      }).then(function (response) {
        if (!response.ok) throw new Error("保存失败（" + response.status + "）");
      });
    }).catch(function (error) {
      toast("数据文件保存失败：" + error.message);
    });
  }

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
    });
  }

  function money(cents) {
    return new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", minimumFractionDigits: 2 }).format((cents || 0) / 100);
  }

  function fmt(value) { return new Intl.NumberFormat("zh-CN").format(value || 0); }
  function dateTime(value) { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value)); }
  function typeLabel(type) { return type === "inbound" ? "入库" : type === "outbound" ? "出库" : "盘点"; }
  function icon(type) { return type === "inbound" ? "↘" : type === "outbound" ? "↗" : "✓"; }
  function productById(id) { return state.products.find(function (item) { return item.id === id; }); }
  function productFromText(text) {
    var term = String(text || "").trim().toLowerCase();
    if (!term) return;
    var exact = state.products.find(function (item) {
      return item.id === term || item.code.toLowerCase() === term || item.name.toLowerCase() === term || (item.code + " · " + item.name).toLowerCase() === term;
    });
    if (exact) return exact;
    var matches = state.products.filter(function (item) {
      return item.code.toLowerCase().indexOf(term) >= 0 || item.name.toLowerCase().indexOf(term) >= 0;
    });
    return matches.length === 1 ? matches[0] : undefined;
  }
  function pageTitle() {
    return { home: "工作台", inbound: "入库登记", outbound: "出库登记", inventory: "查看库存", stocktake: "库存盘点", reports: "库存报表", products: "商品资料", backup: "数据备份" }[page] || "工作台";
  }

  function navButton(id, label, glyph) {
    return '<button class="' + (page === id ? "active" : "") + '" onclick="Warehouse.go(\'' + id + '\')"><span>' + glyph + '</span>' + label + "</button>";
  }

  function render() {
    var root = document.getElementById("app");
    root.innerHTML =
      '<main class="shell">' +
        '<aside class="side">' +
          '<div class="brand"><span class="brand-mark">仓</span><div><strong>仓储台</strong><small>离线库存管理</small></div></div>' +
          '<nav class="nav">' +
            navButton("home", "工作台", "⌂") +
            navButton("inbound", "入库登记", "↘") +
            navButton("outbound", "出库登记", "↗") +
            navButton("inventory", "查看库存", "▦") +
            navButton("stocktake", "库存盘点", "✓") +
            navButton("reports", "库存报表", "▤") +
            navButton("products", "商品资料", "◇") +
            navButton("backup", "数据备份", "↻") +
          '</nav>' +
          '<div class="side-foot"><i></i>离线模式 · 数据保存到工程包</div>' +
        '</aside>' +
        '<section class="main">' +
          '<header class="top"><div><small>离线仓库 /</small><strong>' + pageTitle() + '</strong></div><span class="offline-pill">无需登录 · 无网络依赖</span></header>' +
          '<div class="content">' +
            '<section class="offline-banner"><span>离线</span><div><strong>业务数据自动写入 data 文件夹</strong><p>主数据位于 data\\warehouse-data.json，每周自动备份并保留最近 30 天。</p></div><button onclick="Warehouse.exportBackup()">立即备份</button></section>' +
            pageView() +
          '</div>' +
        '</section>' +
      '</main>';
  }

  function pageView() {
    if (page === "home") return homeView();
    if (page === "inbound" || page === "outbound") return documentView();
    if (page === "inventory") return inventoryView();
    if (page === "stocktake") return stocktakeView();
    if (page === "reports") return reportsView();
    if (page === "products") return productsView();
    if (page === "backup") return backupView();
    return homeView();
  }

  function homeView() {
    var today = new Date().toISOString().slice(0, 10);
    var todays = state.documents.filter(function (doc) { return doc.at.slice(0, 10) === today; });
    var inQty = sumQty(todays, "inbound");
    var outQty = sumQty(todays, "outbound");
    var low = state.products.filter(function (p) { return p.stock <= p.min; });
    var value = state.products.reduce(function (sum, p) { return sum + p.stock * p.avg; }, 0);
    return '<div class="stack">' +
      '<section class="hero"><div><p class="eyebrow">单机离线工作台</p><h1>库存清楚，出入有据。</h1><p>断网也能完成登记、盘点、报表和本机备份。</p></div><div class="hero-badge"><b>' + new Date().getDate() + '</b><small>' + esc(new Intl.DateTimeFormat("zh-CN", { month: "long", weekday: "short" }).format(new Date())) + '</small></div></section>' +
      '<section class="quick"><button onclick="Warehouse.go(\'inbound\')"><span class="qicon qin">↘</span><div><strong>商品入库</strong><small>多商品与移动平均价</small></div><em>→</em></button><button onclick="Warehouse.go(\'outbound\')"><span class="qicon qout">↗</span><div><strong>商品出库</strong><small>库存不足立即拦截</small></div><em>→</em></button><button onclick="Warehouse.go(\'stocktake\')"><span class="qicon qstock">✓</span><div><strong>库存盘点</strong><small>自动生成盘盈盘亏</small></div><em>→</em></button></section>' +
      '<section class="metrics"><article class="metric"><span>库存商品</span><strong>' + state.products.length + '<small> 种</small></strong><p>' + fmt(state.products.reduce(function (s, p) { return s + p.stock; }, 0)) + ' 件在库</p></article><article class="metric"><span>今日入库</span><strong>' + fmt(inQty) + '<small> 件</small></strong><p>离线实时汇总</p></article><article class="metric"><span>今日出库</span><strong>' + fmt(outQty) + '<small> 件</small></strong><p>严格库存校验</p></article><article class="metric"><span>库存预警</span><strong>' + low.length + '<small> 种</small></strong><p>低于或等于最低库存</p></article><article class="metric"><span>库存金额</span><strong style="font-size:19px">' + money(value) + '</strong><p>移动加权平均</p></article></section>' +
      '<section class="grid2"><article class="panel"><div class="panel-head"><h2>最近流水</h2><button class="export" onclick="Warehouse.go(\'reports\')">查看报表</button></div>' + activityRows(state.documents.slice(0, 6)) + '</article><article class="panel"><div class="panel-head"><h2>低库存商品</h2><span class="status">' + low.length + ' 种</span></div><div class="warnings">' + (low.length ? low.slice(0, 6).map(function (p) { return '<div><span><strong>' + esc(p.name) + '</strong><small>' + esc(p.code) + '</small></span><b>' + p.stock + ' / ' + p.min + esc(p.unit) + '</b></div>'; }).join("") : '<div class="empty"><strong>库存状态良好</strong></div>') + '</div></article></section>' +
    '</div>';
  }

  function activityRows(docs) {
    if (!docs.length) return '<div class="empty"><strong>还没有库存流水</strong><p>完成首次入库后会显示在这里。</p></div>';
    return '<div class="activity">' + docs.map(function (doc) {
      var names = doc.items.slice(0, 2).map(function (line) { var p = productById(line.productId); return p ? p.name : "未知商品"; }).join("、");
      var qty = doc.items.reduce(function (sum, line) { return sum + Math.abs(line.quantity); }, 0);
      return '<div class="activity-row ' + doc.type + '"><span class="aicon">' + icon(doc.type) + '</span><div><strong>' + esc(typeLabel(doc.type) + " · " + names) + '</strong><small>' + esc(doc.no + " · " + doc.purpose) + '</small></div><b>' + (doc.type === "outbound" ? "−" : doc.type === "inbound" ? "+" : "") + qty + '</b></div>';
    }).join("") + '</div>';
  }

  function inventoryView() {
    return '<div class="stack"><section class="heading"><div><p class="eyebrow">实时库存</p><h1>查看库存</h1><p>低于或等于最低库存时自动提醒。</p></div><button class="export" onclick="Warehouse.exportExcel()">⇩ 导出 Excel</button></section><section class="panel scroll"><div class="toolbar"><input id="inventorySearch" class="search" placeholder="搜索品名或编号" oninput="Warehouse.filterInventory(this.value)"><span class="result">' + state.products.length + ' 种商品</span></div><div id="inventoryTable">' + inventoryTable(state.products) + '</div></section></div>';
  }

  function inventoryTable(products) {
    return '<div class="table"><div class="thead"><span>商品</span><span>状态</span><span>当前库存</span><span>最低库存</span><span>平均成本</span><span>库存金额</span></div>' + products.map(function (p) {
      return '<div class="trow"><div class="product"><span>' + esc(p.name.slice(0, 1)) + '</span><div><strong>' + esc(p.name) + '</strong><small>' + esc(p.code + " · " + p.supplier) + '</small></div></div><div><span class="status">' + esc(p.status) + '</span></div><div class="qty"><strong>' + p.stock + '</strong> ' + esc(p.unit) + (p.stock <= p.min ? '<div class="low">低库存</div>' : "") + '</div><div>' + p.min + ' ' + esc(p.unit) + '</div><div>' + money(p.avg) + '</div><div>' + money(p.avg * p.stock) + '</div></div>';
    }).join("") + '</div>';
  }

  function collectDraftLines() {
    var rows = Array.prototype.slice.call(document.querySelectorAll(".doc-line"));
    if (!rows.length) return;
    draftLines = rows.map(function (row) {
      return {
        product: row.querySelector("[data-field=product]").value,
        quantity: row.querySelector("[data-field=quantity]").value,
        price: row.querySelector("[data-field=price]") ? row.querySelector("[data-field=price]").value : ""
      };
    });
  }

  function productOptions() {
    return state.products.map(function (p) { return '<option value="' + esc(p.code + " · " + p.name) + '"></option>'; }).join("");
  }

  function documentView() {
    documentType = page;
    var inbound = documentType === "inbound";
    return '<div class="stack"><section class="heading"><div><p class="eyebrow">' + (inbound ? "采购到货 · 库存增加" : "领用发货 · 库存减少") + '</p><h1>新建' + (inbound ? "入库" : "出库") + '单</h1><p>' + (inbound ? "一次可登记多种商品，实际单价参与移动加权平均。" : "任何情况下都不允许负库存，成本由系统自动计算。") + '</p></div></section><section class="panel form"><div class="form-section"><div><h2>单据信息</h2><p>操作人自动记录为离线管理员</p></div><button class="export" onclick="Warehouse.addLine()">＋ 添加一行</button></div><div class="meta ' + (inbound ? "inbound-meta" : "") + '">' + (inbound ? '<label>实际供应商<input id="docSupplier" placeholder="供应商名称"></label>' : '<label>用途<input id="docPurpose" placeholder="例如：生产领用"></label>') + (inbound ? '<label>供应商单号<input id="docRef" placeholder="选填"></label>' : "") + '</div><datalist id="productList">' + productOptions() + '</datalist><div class="lines"><div class="lhead"><span>商品</span><span>当前库存</span><span>数量</span><span>' + (inbound ? "实际单价" : "计价方式") + '</span><span></span></div>' + draftLines.map(function (line, index) { var p = productFromText(line.product); return '<div class="line doc-line" data-index="' + index + '"><input data-field="product" list="productList" value="' + esc(line.product) + '" placeholder="输入品名或编号" onchange="Warehouse.syncLine(this)"><span class="stock">' + (p ? p.stock + esc(p.unit) : "—") + '</span><input data-field="quantity" type="number" min="1" step="1" value="' + esc(line.quantity) + '" placeholder="0">' + (inbound ? '<input data-field="price" type="number" min="0" step="0.01" value="' + esc(line.price) + '" placeholder="¥ 0.00">' : '<span class="cost-method">移动平均价</span>') + '<button onclick="Warehouse.removeLine(' + index + ')">×</button></div>'; }).join("") + '</div><div id="docError"></div><div class="form-foot"><p>共 ' + draftLines.length + ' 行商品明细</p><button class="primary" onclick="Warehouse.submitDocument()">确认' + (inbound ? "入库" : "出库") + '</button></div></section></div>';
  }

  function stocktakeView() {
    return '<div class="stack"><section class="heading"><div><p class="eyebrow">账实核对 · 自动留痕</p><h1>库存盘点</h1><p>填写实盘数量，系统生成盘盈盘亏流水。</p></div></section><section class="panel scroll"><div class="toolbar"><input id="stocktakePurpose" class="search" value="定期盘点" placeholder="盘点说明"></div><div class="table"><div class="thead" style="grid-template-columns:minmax(260px,1.5fr) 130px 160px 130px"><span>商品</span><span>账面数量</span><span>实盘数量</span><span>差异</span></div>' + state.products.map(function (p) { return '<div class="trow stock-row" data-product="' + p.id + '" style="grid-template-columns:minmax(260px,1.5fr) 130px 160px 130px"><div class="product"><span>' + esc(p.name.slice(0, 1)) + '</span><div><strong>' + esc(p.name) + '</strong><small>' + esc(p.code) + '</small></div></div><div>' + p.stock + ' ' + esc(p.unit) + '</div><input class="search counted" type="number" min="0" step="1" placeholder="' + p.stock + '" oninput="Warehouse.stockDiff(this,' + p.stock + ',\'' + esc(p.unit) + '\')"><div class="diff">—</div></div>'; }).join("") + '</div><div id="stockError"></div><div class="form-foot"><p>只提交已填写且与账面数量不同的商品。</p><button class="primary" onclick="Warehouse.submitStocktake()">提交盘点</button></div></section></div>';
  }

  function reportsView() {
    var docs = filteredDocs();
    var inbound = docs.filter(function (d) { return d.type === "inbound"; });
    var outbound = docs.filter(function (d) { return d.type === "outbound"; });
    var stocktakes = docs.filter(function (d) { return d.type === "stocktake"; });
    var inQty = sumQty(docs, "inbound");
    var outQty = sumQty(docs, "outbound");
    var inValue = valueOf(inbound, true);
    var outValue = valueOf(outbound, false);
    return '<div class="stack"><section class="heading"><div><p class="eyebrow">离线库存汇总</p><h1>库存报表</h1><p>日报、月报和年报均可导出 Excel。</p></div><button class="export" onclick="Warehouse.exportExcel(true)">⇩ 导出当前报表</button></section><div class="tabs"><button class="' + (period === "day" ? "active" : "") + '" onclick="Warehouse.setPeriod(\'day\')">日报</button><button class="' + (period === "month" ? "active" : "") + '" onclick="Warehouse.setPeriod(\'month\')">月报</button><button class="' + (period === "year" ? "active" : "") + '" onclick="Warehouse.setPeriod(\'year\')">年报</button></div><section class="report-cards"><article><span>入库数量</span><strong>' + inQty + ' 件</strong><p>' + inbound.length + ' 张单 · ' + money(inValue) + '</p></article><article><span>出库数量</span><strong>' + outQty + ' 件</strong><p>' + outbound.length + ' 张单 · ' + money(outValue) + '</p></article><article><span>盘点调整</span><strong>' + stocktakes.length + ' 次</strong><p>' + stocktakes.reduce(function (s, d) { return s + d.items.length; }, 0) + ' 项盘盈盘亏</p></article></section><section class="panel"><div class="panel-head"><h2>单据明细</h2><span class="status">' + docs.length + ' 张</span></div>' + activityRows(docs) + '</section></div>';
  }

  function productsView() {
    return '<div class="stack"><section class="heading"><div><p class="eyebrow">商品主数据</p><h1>商品资料</h1><p>编号可人工填写或由系统自动生成，重复编号会被拦截。</p></div><button class="primary" onclick="Warehouse.productModal()">＋ 新增商品</button></section><section class="panel scroll">' + inventoryTable(state.products) + '</section><div id="modalHost"></div></div>';
  }

  function backupView() {
    return '<div class="stack"><section class="heading"><div><p class="eyebrow">本机数据安全</p><h1>数据备份</h1><p>系统每周自动备份一次，并删除超过 30 天的旧备份。</p></div></section><section class="backup-grid"><article class="backup-card"><h2>立即备份到文件夹</h2><p>完整备份将写入 data\\backups，可直接复制到其他磁盘保存。</p><button class="primary" onclick="Warehouse.exportBackup()">立即备份</button></article><article class="backup-card"><h2>从备份恢复</h2><p>选择 data\\backups 中的仓储台 JSON 备份，用其替换当前数据。</p><button class="secondary" onclick="document.getElementById(\'restoreFile\').click()">选择文件</button><input hidden id="restoreFile" type="file" accept=".json,application/json" onchange="Warehouse.restoreBackup(this.files[0])"></article><article class="backup-card"><h2>全量 Excel 导出</h2><p>生成库存与流水两个工作表，可直接使用 Microsoft Excel 打开。</p><button class="export" onclick="Warehouse.exportExcel()">导出 Excel</button></article><article class="backup-card"><h2>清空全部数据</h2><p>清除商品、库存和全部流水，恢复为空白系统。操作前请先备份。</p><button class="secondary" onclick="Warehouse.reset()">清空数据</button></article></section></div>';
  }

  function sumQty(docs, type) {
    return docs.filter(function (d) { return d.type === type; }).reduce(function (sum, d) { return sum + d.items.reduce(function (s, line) { return s + Math.abs(line.quantity); }, 0); }, 0);
  }
  function valueOf(docs, inbound) {
    return docs.reduce(function (sum, d) { return sum + d.items.reduce(function (s, line) { return s + Math.abs(line.quantity) * (inbound ? line.price : line.cost); }, 0); }, 0);
  }
  function filteredDocs() {
    var current = new Date();
    return state.documents.filter(function (doc) {
      var value = new Date(doc.at);
      if (period === "day") return value.toDateString() === current.toDateString();
      if (period === "month") return value.getFullYear() === current.getFullYear() && value.getMonth() === current.getMonth();
      return value.getFullYear() === current.getFullYear();
    });
  }

  function toast(message) {
    var old = document.querySelector(".success");
    if (old) old.remove();
    var node = document.createElement("div");
    node.className = "success";
    node.textContent = "✓ " + message;
    document.body.appendChild(node);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { node.remove(); }, 3500);
  }

  function errorAt(id, message) {
    var host = document.getElementById(id);
    if (host) host.innerHTML = '<div class="error">' + esc(message) + '</div>';
  }

  function download(name, content, type) {
    var blob = new Blob([content], { type: type });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
  }

  function xmlCell(value) {
    var numeric = typeof value === "number";
    return '<Cell><Data ss:Type="' + (numeric ? "Number" : "String") + '">' + esc(value) + '</Data></Cell>';
  }
  function xmlSheet(name, rows) {
    return '<Worksheet ss:Name="' + esc(name) + '"><Table>' + rows.map(function (row) { return "<Row>" + row.map(xmlCell).join("") + "</Row>"; }).join("") + "</Table></Worksheet>";
  }

  window.Warehouse = {
    go: function (next) {
      page = next;
      if (next === "inbound" || next === "outbound") {
        documentType = next;
        draftLines = [{ product: "", quantity: "", price: "" }];
      }
      render();
      window.scrollTo(0, 0);
    },
    filterInventory: function (query) {
      var term = String(query || "").toLowerCase();
      var filtered = state.products.filter(function (p) { return (p.code + " " + p.name + " " + p.supplier).toLowerCase().indexOf(term) >= 0; });
      document.getElementById("inventoryTable").innerHTML = inventoryTable(filtered);
    },
    addLine: function () {
      collectDraftLines();
      draftLines.push({ product: "", quantity: "", price: "" });
      render();
    },
    removeLine: function (index) {
      collectDraftLines();
      if (draftLines.length > 1) draftLines.splice(index, 1);
      render();
    },
    syncLine: function (input) {
      var p = productFromText(input.value);
      if (p) input.value = p.code + " · " + p.name;
      input.closest(".line").querySelector(".stock").textContent = p ? p.stock + p.unit : "—";
    },
    submitDocument: function () {
      collectDraftLines();
      var parsed = [];
      for (var i = 0; i < draftLines.length; i += 1) {
        var line = draftLines[i];
        var p = productFromText(line.product);
        var quantity = Number(line.quantity);
        var price = Math.round(Number(line.price || 0) * 100);
        if (!p) return errorAt("docError", "第 " + (i + 1) + " 行没有找到对应商品，请从联想列表选择，或输入唯一的品名/编号。");
        if (!Number.isInteger(quantity) || quantity <= 0) return errorAt("docError", "第 " + (i + 1) + " 行数量必须是大于 0 的整数。");
        if (documentType === "inbound" && (!Number.isFinite(price) || price < 0)) return errorAt("docError", "第 " + (i + 1) + " 行入库单价不正确。");
        if (documentType === "outbound" && quantity > p.stock) return errorAt("docError", p.name + "库存只有 " + p.stock + p.unit + "，最大可出库 " + p.stock + p.unit + "。");
        if (parsed.some(function (entry) { return entry.product.id === p.id; })) return errorAt("docError", "同一张单据不能重复添加同一种商品。");
        parsed.push({ product: p, quantity: quantity, price: price });
      }
      var docId = uid("d");
      var items = parsed.map(function (entry) {
        var p = entry.product;
        var before = p.stock;
        var oldAverage = p.avg;
        var after = documentType === "inbound" ? before + entry.quantity : before - entry.quantity;
        if (documentType === "inbound") p.avg = after ? Math.round((before * oldAverage + entry.quantity * entry.price) / after) : 0;
        else if (after === 0) p.avg = 0;
        p.stock = after;
        return { productId: p.id, quantity: entry.quantity, price: documentType === "inbound" ? entry.price : 0, cost: documentType === "inbound" ? entry.price : oldAverage, before: before, after: after };
      });
      var count = state.documents.length + 1;
      var no = (documentType === "inbound" ? "RK" : "CK") + "-OFF-" + String(count).padStart(4, "0");
      var purpose = documentType === "inbound" ? "采购入库" : (document.getElementById("docPurpose").value.trim() || "离线出库");
      state.documents.unshift({ id: docId, no: no, type: documentType, purpose: purpose, supplier: documentType === "inbound" ? document.getElementById("docSupplier").value.trim() : "", ref: documentType === "inbound" ? document.getElementById("docRef").value.trim() : "", at: now(), operator: "离线管理员", items: items });
      save();
      draftLines = [{ product: "", quantity: "", price: "" }];
      page = "home";
      render();
      toast((documentType === "inbound" ? "入库" : "出库") + "成功：" + no);
    },
    stockDiff: function (input, book, unit) {
      var diff = input.value === "" ? 0 : Number(input.value) - book;
      var host = input.closest(".stock-row").querySelector(".diff");
      host.textContent = diff === 0 ? "—" : (diff > 0 ? "+" : "") + diff + unit;
      host.style.color = diff > 0 ? "#217760" : diff < 0 ? "#c6554c" : "";
    },
    submitStocktake: function () {
      var rows = Array.prototype.slice.call(document.querySelectorAll(".stock-row"));
      var changed = [];
      for (var i = 0; i < rows.length; i += 1) {
        var input = rows[i].querySelector(".counted");
        if (input.value === "") continue;
        var counted = Number(input.value);
        if (!Number.isInteger(counted) || counted < 0) return errorAt("stockError", "实盘数量必须是大于或等于 0 的整数。");
        var p = productById(rows[i].dataset.product);
        if (counted !== p.stock) changed.push({ product: p, counted: counted });
      }
      if (!changed.length) return errorAt("stockError", "请至少填写一项与账面数量不同的实盘数量。");
      var items = changed.map(function (entry) { var before = entry.product.stock; entry.product.stock = entry.counted; return { productId: entry.product.id, quantity: entry.counted - before, counted: entry.counted, price: 0, cost: entry.product.avg, before: before, after: entry.counted }; });
      var no = "PD-OFF-" + String(state.documents.length + 1).padStart(4, "0");
      state.documents.unshift({ id: uid("d"), no: no, type: "stocktake", purpose: document.getElementById("stocktakePurpose").value.trim() || "离线盘点", supplier: "", ref: "", at: now(), operator: "离线管理员", items: items });
      save();
      page = "home";
      render();
      toast("盘点完成：" + no);
    },
    setPeriod: function (value) { period = value; render(); },
    productModal: function () {
      document.getElementById("modalHost").innerHTML = '<div class="modal"><div class="modal-card"><h2>新增商品</h2><div class="modal-grid"><label class="field">商品编号<input id="newCode" placeholder="留空则系统生成"></label><label class="field">商品名称<input id="newName" placeholder="必填"></label><label class="field">单位<input id="newUnit" value="件"></label><label class="field">最低库存<input id="newMin" type="number" min="0" step="1" value="0"></label><label class="field">供应状态<select id="newStatus"><option>正常供货</option><option>补货已下单</option><option>价格有变动</option><option>启用替代供货</option><option>暂停采购</option></select></label><label class="field">默认供应商<input id="newSupplier"></label></div><div id="productError"></div><div class="modal-actions"><button class="secondary" onclick="Warehouse.closeModal()">取消</button><button class="primary" onclick="Warehouse.addProduct()">建立商品</button></div></div></div>';
    },
    closeModal: function () { document.getElementById("modalHost").innerHTML = ""; },
    addProduct: function () {
      var name = document.getElementById("newName").value.trim();
      var code = document.getElementById("newCode").value.trim().toUpperCase();
      var min = Number(document.getElementById("newMin").value);
      if (!name) return errorAt("productError", "请填写商品名称。");
      if (!Number.isInteger(min) || min < 0) return errorAt("productError", "最低库存必须是非负整数。");
      if (!code) {
        var max = state.products.reduce(function (value, p) { var match = /^SKU-(\d+)$/.exec(p.code); return Math.max(value, match ? Number(match[1]) : 0); }, 0);
        code = "SKU-" + String(max + 1).padStart(6, "0");
      }
      if (state.products.some(function (p) { return p.code.toLowerCase() === code.toLowerCase(); })) return errorAt("productError", "商品编号 " + code + " 已存在。");
      state.products.push({ id: uid("p"), code: code, name: name, unit: document.getElementById("newUnit").value.trim() || "件", status: document.getElementById("newStatus").value, min: min, stock: 0, avg: 0, supplier: document.getElementById("newSupplier").value.trim() });
      save();
      render();
      toast("商品已建立：" + name + "（" + code + "）");
    },
    exportBackup: function () {
      fetch("/api/backup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state)
      }).then(function (response) {
        if (!response.ok) throw new Error("备份失败（" + response.status + "）");
        return response.json();
      }).then(function (result) {
        toast("备份已保存：data\\backups\\" + result.file);
      }).catch(function (error) {
        alert("无法备份：" + error.message);
      });
    },
    restoreBackup: function (file) {
      if (!file) return;
      if (!confirm("恢复备份会替换 data 文件夹中的全部库存和流水，确认继续吗？")) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var backup = JSON.parse(reader.result);
          if (!backup || backup.format !== "warehouse-offline-backup" || !backup.data || !Array.isArray(backup.data.products) || !Array.isArray(backup.data.documents)) throw new Error("文件格式不正确");
          state = backup.data;
          save();
          page = "home";
          render();
          toast("备份恢复完成。");
        } catch (error) { alert("无法恢复：" + error.message); }
      };
      reader.readAsText(file, "utf-8");
    },
    exportExcel: function (currentPeriod) {
      var docs = currentPeriod ? filteredDocs() : state.documents;
      var inventory = [["商品编号", "品名", "单位", "当前库存", "最低库存", "状态", "默认供应商", "移动平均价", "库存金额"]].concat(state.products.map(function (p) { return [p.code, p.name, p.unit, p.stock, p.min, p.status, p.supplier, p.avg / 100, p.avg * p.stock / 100]; }));
      var movements = [["日期", "单号", "类型", "商品编号", "品名", "数量", "单位", "用途", "单价/成本", "金额"]];
      docs.forEach(function (doc) { doc.items.forEach(function (line) { var p = productById(line.productId) || { code: "", name: "未知商品", unit: "" }; var unit = doc.type === "inbound" ? line.price : line.cost; movements.push([doc.at.slice(0, 10), doc.no, typeLabel(doc.type), p.code, p.name, doc.type === "stocktake" ? line.counted : line.quantity, p.unit, doc.purpose, unit / 100, Math.abs(line.quantity) * unit / 100]); }); });
      var xml = '<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">' + xmlSheet("库存", inventory) + xmlSheet("流水", movements) + "</Workbook>";
      download("仓储台离线数据-" + new Date().toISOString().slice(0, 10) + ".xls", "\ufeff" + xml, "application/vnd.ms-excel");
      toast("Excel 已导出。");
    },
    reset: function () {
      if (!confirm("确认清空全部商品、库存和流水？此操作不可撤销，建议先立即备份。")) return;
      state = initialData();
      save();
      page = "home";
      render();
      toast("全部数据已清空，系统已恢复为空白状态。");
    }
  };

  load();
})();
