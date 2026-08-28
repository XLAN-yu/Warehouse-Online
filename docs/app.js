(function () {
  "use strict";

  var page = "home";
  var period = "day";
  var reportToday = new Date();
  var reportTarget = { year: reportToday.getFullYear(), month: reportToday.getMonth() + 1, day: reportToday.getDate() };
  var documentType = "inbound";
  var draftLines = [{ product: "", quantity: "", price: "", remark: "" }];
  var draftSupplier = "";
  var draftRef = "";
  var draftPurpose = "";
  var draftCustomer = "";
  var draftContact = "";
  var draftRemark = "";
  var historyFilter = "all";
  var historySort = "desc";
  var toastTimer = null;
  var toastRemoveTimer = null;
  var dataReady = false;
  var saveQueue = Promise.resolve();
  var pendingProductLine = null;
  var selectedProductId = null;
  var selectedStocktakeProductId = null;
  var selectedSupplier = "";
  var selectedInventorySupplier = "";
  var selectedRecipeId = null;
  var recipeDraft = null;
  var globalQuery = "";
  var importPreviewRows = [];
  var importHistoryRows = { inbound: [], outbound: [] };
  var importHistoryErrors = [];
  var importRawProductRows = [];
  var importRawHistoryRows = { inbound: [], outbound: [] };
  var recipeImportRows = [];
  var recipeImportPreview = [];
  var pinyinCollator = typeof Intl !== "undefined" && Intl.Collator ? new Intl.Collator("zh-Hans-CN-u-co-pinyin") : null;
  var pinyinInitialBounds = [
    ["a", "阿"], ["b", "芭"], ["c", "擦"], ["d", "搭"], ["e", "蛾"], ["f", "发"], ["g", "噶"], ["h", "哈"],
    ["j", "击"], ["k", "喀"], ["l", "垃"], ["m", "妈"], ["n", "拿"], ["o", "哦"], ["p", "啪"], ["q", "期"],
    ["r", "然"], ["s", "撒"], ["t", "塌"], ["w", "挖"], ["x", "昔"], ["y", "压"], ["z", "匝"]
  ];

  function uid(prefix) {
    return prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  function now() { return new Date().toISOString(); }

  function defaultStatusDefinitions() {
    return [
      { name: "正常供货", color: "#21875A" },
      { name: "补货已下单", color: "#B88900" },
      { name: "价格有变动", color: "#C56A16" },
      { name: "启用替代供货", color: "#3377C8" },
      { name: "暂停采购", color: "#C74C4C" },
      { name: "新增待盘点", color: "#655BC7", system: true }
    ];
  }

  function validStatusColor(value) { return /^#[0-9a-f]{6}$/i.test(String(value || "").trim()); }

  function normalizeStatusDefinitions(value) {
    var defaults = defaultStatusDefinitions();
    var seen = Object.create(null);
    var definitions = Array.isArray(value) ? value.map(function (item) {
      var name = String(item && item.name || "").trim();
      var color = String(item && item.color || "").trim();
      if (!name || name.length > 20 || seen[name] || !validStatusColor(color)) return null;
      seen[name] = true;
      return { name: name, color: color, system: name === "新增待盘点" };
    }).filter(function (item) { return !!item; }) : [];
    if (!definitions.length) definitions = clone(defaults);
    if (!definitions.some(function (item) { return item.name === "新增待盘点"; })) definitions.push(defaults[5]);
    return definitions;
  }

  function productStatusesForSettings(settings) { return normalizeStatusDefinitions(settings && settings.statuses).map(function (item) { return item.name; }); }
  function statusDefinitions() { return normalizeStatusDefinitions(state && state.settings && state.settings.statuses); }
  function productStatuses() { return productStatusesForSettings(state && state.settings); }
  function normalSupplyStatus(definitions) {
    definitions = definitions || statusDefinitions();
    var normal = definitions.find(function (item) { return item.name === "正常供货"; });
    return normal ? normal.name : definitions[0].name;
  }
  function statusDefinition(name) {
    var definitions = statusDefinitions();
    return definitions.find(function (item) { return item.name === name; }) || definitions[0];
  }
  function statusFill(color) {
    var hex = String(color || "#21875A").slice(1);
    var red = parseInt(hex.slice(0, 2), 16), green = parseInt(hex.slice(2, 4), 16), blue = parseInt(hex.slice(4, 6), 16);
    return "#" + [red, green, blue].map(function (channel) { return Math.round(255 * .88 + channel * .12).toString(16).padStart(2, "0"); }).join("");
  }

  function initialData() {
    return {
      version: 1,
      products: [],
      documents: [],
      recipes: [],
      settings: { fontScale: 1, costMethod: "weighted", productCodePrefix: "ZERO", supplierGrouping: false, inventorySupplierGrouping: false, statuses: defaultStatusDefinitions() },
      undoHistory: []
    };
  }

  function normalizeState(value) {
    if (!value.settings) value.settings = { fontScale: 1, costMethod: "weighted", productCodePrefix: "ZERO", supplierGrouping: false, inventorySupplierGrouping: false, statuses: defaultStatusDefinitions() };
    if ([1, 1.2, 1.5].indexOf(Number(value.settings.fontScale)) < 0) value.settings.fontScale = 1;
    if (["weighted", "fifo", "lastInbound"].indexOf(value.settings.costMethod) < 0) value.settings.costMethod = "weighted";
    if (typeof value.settings.productCodePrefix !== "string") value.settings.productCodePrefix = "ZERO";
    value.settings.supplierGrouping = value.settings.supplierGrouping === true;
    value.settings.inventorySupplierGrouping = value.settings.inventorySupplierGrouping === true;
    value.settings.statuses = normalizeStatusDefinitions(value.settings.statuses);
    if (!Array.isArray(value.recipes)) value.recipes = [];
    if (!Array.isArray(value.undoHistory)) value.undoHistory = [];
    value.products.forEach(function (product) {
      product.archived = product.archived === true;
      product.min = Number.isSafeInteger(Number(product.min)) && Number(product.min) >= 0 ? Number(product.min) : 0;
      // 最高库存不再是商品资料字段；旧数据在下一次保存时自动清理。
      delete product.max;
      if (productStatusesForSettings(value.settings).indexOf(product.status) < 0) product.status = normalSupplyStatus(value.settings.statuses);
      if (!product.createdAt) {
        var relatedDates = value.documents.filter(function (doc) {
          return doc.items.some(function (line) { return line.productId === product.id; });
        }).map(function (doc) { return doc.at; }).sort();
        product.createdAt = relatedDates[0] || now();
      }
    });
    value.recipes = value.recipes.map(function (recipe) {
      recipe.id = String(recipe.id || uid("recipe"));
      recipe.name = String(recipe.name || "").trim();
      recipe.createdAt = recipe.createdAt || now();
      recipe.updatedAt = recipe.updatedAt || recipe.createdAt;
      recipe.components = Array.isArray(recipe.components) ? recipe.components.map(function (component) {
        return {
          productId: String(component.productId || ""),
          quantity: Number.isSafeInteger(Number(component.quantity)) && Number(component.quantity) > 0 ? Number(component.quantity) : 1,
          supplier: String(component.supplier || "").trim(),
          remark: String(component.remark || "").trim(),
          shelfLocation: String(component.shelfLocation || "").trim()
        };
      }).filter(function (component) { return !!component.productId; }) : [];
      return recipe;
    }).filter(function (recipe) { return !!recipe.name && recipe.components.length; });
    return value;
  }

  function activeProducts() {
    return state.products.filter(function (product) { return !product.archived; });
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function recordUndo(label) {
    state.undoHistory.push({
      id: uid("undo"),
      label: label,
      at: now(),
      snapshot: {
        products: clone(state.products),
        documents: clone(state.documents),
        recipes: clone(state.recipes),
        settings: clone(state.settings)
      }
    });
    if (state.undoHistory.length > 20) state.undoHistory.shift();
  }

  function applyFontScale() {
    var scale = Number(state.settings && state.settings.fontScale ? state.settings.fontScale : 1);
    document.body.style.zoom = String(scale);
    if (document.body.style.setProperty) document.body.style.setProperty("--font-scale", String(scale));
    else document.body.style["--font-scale"] = String(scale);
  }

  function load() {
    var saved = localStorage.getItem("warehouse-pages-demo-v2");
    if (saved) {
      try {
        state = normalizeState(JSON.parse(saved));
        dataReady = true;
        applyFontScale();
        render();
        return;
      } catch (error) { localStorage.removeItem("warehouse-pages-demo-v2"); }
    }
    state = normalizeState(initialData());
    dataReady = true;
    applyFontScale();
    render();
  }

  var state = initialData();

  function save() {
    if (!dataReady) return;
    localStorage.setItem("warehouse-pages-demo-v2", JSON.stringify(state));
  }

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
    });
  }

  function flashFields(fields) {
    var targets = fields.filter(function (field) { return !!field; });
    targets.forEach(function (field) {
      field.classList.remove("field-alert");
      void field.offsetWidth;
      field.classList.add("field-alert");
    });
    if (targets[0]) targets[0].focus();
    setTimeout(function () {
      targets.forEach(function (field) { field.classList.remove("field-alert"); });
    }, 1500);
  }

  function productPrefill(text) {
    var value = String(text || "").trim();
    var parts = value.split(" · ");
    if (parts.length > 1) return { code: parts.shift().trim(), name: parts.join(" · ").trim() };
    if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && /\d/.test(value)) return { code: value, name: "" };
    return { code: "", name: value };
  }

  function productCodePrefix() {
    return String(state.settings && typeof state.settings.productCodePrefix === "string" ? state.settings.productCodePrefix : "ZERO").trim();
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function nextProductCode() {
    var prefix = productCodePrefix();
    var pattern = prefix ? new RegExp("^" + escapeRegExp(prefix) + "-(\\d+)$", "i") : /^(\d+)$/;
    var max = state.products.reduce(function (value, product) {
      var match = pattern.exec(String(product.code || ""));
      return Math.max(value, match ? Number(match[1]) : 0);
    }, 0);
    var next = max + 1;
    var candidate = "";
    do {
      candidate = (prefix ? prefix + "-" : "") + String(next).padStart(6, "0");
      next += 1;
    } while (state.products.some(function (product) { return String(product.code || "").toLowerCase() === candidate.toLowerCase(); }));
    return candidate;
  }

  function pinyinInitials(value) {
    return Array.from(String(value || "")).map(function (character) {
      if (/[A-Za-z0-9]/.test(character)) return character.toLowerCase();
      if (!pinyinCollator || !/[\u3400-\u9fff]/.test(character)) return "";
      for (var index = pinyinInitialBounds.length - 1; index >= 0; index -= 1) {
        if (pinyinCollator.compare(character, pinyinInitialBounds[index][1]) >= 0) return pinyinInitialBounds[index][0];
      }
      return "";
    }).join("");
  }

  function productSearchText(product) {
    return [product.name, product.code, product.supplier, pinyinInitials(product.name), pinyinInitials(product.supplier)].join(" ").toLowerCase();
  }

  function money(cents) {
    return new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", minimumFractionDigits: 2 }).format((cents || 0) / 100);
  }

  function fmt(value) { return new Intl.NumberFormat("zh-CN").format(value || 0); }
  function dateTime(value) { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value)); }
  function fullDateTime(value) { return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value)); }
  function typeLabel(type) { return type === "inbound" ? "入库" : type === "outbound" ? "出库" : type === "assembly" ? "配料出库" : "盘点"; }
  function icon(type) { return type === "inbound" ? "↘" : (type === "outbound" || type === "assembly") ? "↗" : "✓"; }
  function productById(id) { return state.products.find(function (item) { return item.id === id; }); }
  function productFromText(text) {
    var term = String(text || "").trim().toLowerCase();
    if (!term) return;
    var available = activeProducts();
    var exact = available.find(function (item) {
      return item.id === term || item.code.toLowerCase() === term || item.name.toLowerCase() === term || (item.code + " · " + item.name).toLowerCase() === term;
    });
    if (exact) return exact;
    var matches = available.filter(function (item) {
      return item.code.toLowerCase().indexOf(term) >= 0 || item.name.toLowerCase().indexOf(term) >= 0;
    });
    return matches.length === 1 ? matches[0] : undefined;
  }
  function lastInboundPrice(productId) {
    for (var i = 0; i < state.documents.length; i += 1) {
      if (state.documents[i].type !== "inbound") continue;
      var line = state.documents[i].items.find(function (item) { return item.productId === productId; });
      if (line) return Number(line.price || 0);
    }
    return null;
  }
  function costMethodLabel(method) {
    return { weighted: "移动加权平均", fifo: "先进先出", lastInbound: "最近入库价" }[method] || "移动加权平均";
  }
  function consumeFifoLayers(layers, quantity, fallbackCost) {
    var remaining = quantity;
    var total = 0;
    while (remaining > 0 && layers.length) {
      var layer = layers[0];
      var used = Math.min(remaining, layer.quantity);
      total += used * layer.cost;
      layer.quantity -= used;
      remaining -= used;
      if (layer.quantity <= 0) layers.shift();
    }
    if (remaining > 0) total += remaining * fallbackCost;
    return total;
  }
  function fifoLayers(product) {
    var layers = [];
    state.documents.slice().sort(function (a, b) { return new Date(a.at) - new Date(b.at); }).forEach(function (doc) {
      var line = doc.items.find(function (item) { return item.productId === product.id; });
      if (!line) return;
      if (doc.type === "inbound") layers.push({ quantity: Math.abs(line.quantity), cost: Number(line.price || line.cost || product.avg || 0) });
      else if (doc.type === "outbound" || doc.type === "assembly") consumeFifoLayers(layers, Math.abs(line.quantity), Number(line.cost || product.avg || 0));
      else if (line.quantity > 0) layers.push({ quantity: line.quantity, cost: Number(line.cost || product.avg || 0) });
      else if (line.quantity < 0) consumeFifoLayers(layers, Math.abs(line.quantity), Number(line.cost || product.avg || 0));
    });
    var layerQuantity = layers.reduce(function (sum, layer) { return sum + layer.quantity; }, 0);
    if (layerQuantity < product.stock) layers.push({ quantity: product.stock - layerQuantity, cost: product.avg });
    else if (layerQuantity > product.stock) consumeFifoLayers(layers, layerQuantity - product.stock, product.avg);
    return layers;
  }
  function fifoUnitCost(product, quantity) {
    var layers = fifoLayers(product);
    return quantity ? Math.round(consumeFifoLayers(layers, quantity, product.avg) / quantity) : product.avg;
  }
  function outboundUnitCost(product, quantity) {
    var method = state.settings.costMethod || "weighted";
    if (method === "lastInbound") {
      var recent = lastInboundPrice(product.id);
      return recent === null ? product.avg : recent;
    }
    if (method === "fifo") return fifoUnitCost(product, quantity);
    return product.avg;
  }
  function inventoryUnitCost(product) {
    if (!product.stock) return 0;
    var method = state.settings.costMethod || "weighted";
    if (method === "lastInbound") {
      var recent = lastInboundPrice(product.id);
      return recent === null ? product.avg : recent;
    }
    if (method === "fifo") {
      var layers = fifoLayers(product);
      var total = layers.reduce(function (sum, layer) { return sum + layer.quantity * layer.cost; }, 0);
      return Math.round(total / product.stock);
    }
    return product.avg;
  }
  function inventoryValue(product) {
    return inventoryUnitCost(product) * product.stock;
  }
  function replenishmentItems() {
    return activeProducts().filter(function (product) { return product.stock <= product.min; }).sort(function (a, b) { return a.stock - b.stock; });
  }
  function pageTitle() {
    return { home: "工作台", inbound: "入库登记", outbound: "出库登记", inventory: "查看库存", recipes: "一键配料", "recipe-detail": "配料详情", "product-history": "商品全周期", "supplier-products": "供应商商品资料", search: "全局搜索", stocktake: "库存盘点", replenishment: "补货提醒", reports: "库存报表", products: "商品资料", settings: "设置", backup: "数据备份" }[page] || "工作台";
  }

  function statusSelect(product) {
    var definition = statusDefinition(product.status);
    var style = '--status-color:' + esc(definition.color) + ';--status-fill:' + esc(statusFill(definition.color));
    return '<select class="status-select dynamic-status" style="' + style + '" aria-label="修改' + esc(product.name) + '的状态" onclick="event.stopPropagation()" onkeydown="event.stopPropagation()" onchange="Warehouse.updateProductStatus(\'' + esc(product.id) + '\',this.value)">' + statusDefinitions().map(function (status) { return '<option style="color:' + esc(status.color) + '"' + (product.status === status.name ? " selected" : "") + '>' + esc(status.name) + '</option>'; }).join("") + '</select>';
  }

  function navButton(id, label, glyph) {
    return '<button class="' + (page === id ? "active" : "") + '" onclick="Warehouse.go(\'' + id + '\')"><span class="nav-glyph nav-glyph-' + id + '">' + glyph + '</span>' + label + "</button>";
  }

  function enhanceDocumentForm() {
    Array.prototype.slice.call(document.querySelectorAll(".cost-method")).forEach(function (node) {
      node.textContent = costMethodLabel(state.settings.costMethod);
    });
    if (page !== "inbound") return;
    var input = document.getElementById("docSupplier");
    if (!input || !input.parentNode) return;
    input.placeholder = "选择商品后自动填写";
    var wrapper = document.createElement("span");
    wrapper.className = "clearable-input";
    input.parentNode.insertBefore(wrapper, input);
    wrapper.appendChild(input);
    var clearButton = document.createElement("button");
    clearButton.type = "button";
    clearButton.textContent = "×";
    clearButton.title = "清空供应商";
    clearButton.setAttribute("aria-label", "清空实际供应商");
    clearButton.onclick = function () { window.Warehouse.clearDocumentSupplier(); };
    wrapper.appendChild(clearButton);
  }

  function render() {
    var root = document.getElementById("app");
    var lastUndo = state.undoHistory.length ? state.undoHistory[state.undoHistory.length - 1] : null;
    root.innerHTML =
      '<main class="shell">' +
        '<aside class="side">' +
          '<div class="brand"><span class="brand-mark">仓</span><div><strong>仓储台</strong><small>离线库存管理</small></div></div>' +
          '<div class="undo-zone"><button class="undo-button" onclick="Warehouse.undoLast()" ' + (lastUndo ? "" : "disabled") + '><span>↶</span><div><strong>撤回上一步</strong><small>' + (lastUndo ? esc(lastUndo.label) : "暂无可撤回操作") + '</small></div></button></div>' +
          '<nav class="nav">' +
            navButton("home", "工作台", "⌂") +
            navButton("products", "商品资料", "") +
            navButton("inbound", "入库登记", "↘") +
            navButton("outbound", "出库登记", "↗") +
            navButton("inventory", "查看库存", "▦") +
            navButton("recipes", "一键配料", "") +
            navButton("replenishment", "补货提醒", "↻") +
            navButton("settings", "设置", "⚙") +
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
      '</main><div id="modalHost"></div>';
    enhanceDocumentForm();
  }

  function pageView() {
    if (page === "home") return homeView();
    if (page === "inbound" || page === "outbound") return documentView();
    if (page === "inventory") return inventoryView();
    if (page === "recipes") return recipesView();
    if (page === "recipe-detail") return recipeDetailView();
    if (page === "product-history") return productHistoryView();
    if (page === "supplier-products") return supplierProductsView();
    if (page === "search") return globalSearchView();
    if (page === "stocktake") return stocktakeView();
    if (page === "replenishment") return replenishmentView();
    if (page === "reports") return reportsView();
    if (page === "products") return productsView();
    if (page === "settings") return settingsView();
    if (page === "backup") return backupView();
    return homeView();
  }

  function homeView() {
    var products = activeProducts();
    var displayDate = new Date();
    var displayMonth = new Intl.DateTimeFormat("zh-CN", { month: "long" }).format(displayDate);
    var displayWeekday = new Intl.DateTimeFormat("zh-CN", { weekday: "long" }).format(displayDate);
    var today = new Date().toISOString().slice(0, 10);
    var todays = state.documents.filter(function (doc) { return doc.at.slice(0, 10) === today; });
    var inQty = sumQty(todays, "inbound");
    var outQty = sumQty(todays, "outbound") + sumQty(todays, "assembly");
    var low = products.filter(function (p) { return p.stock <= p.min; });
    return '<div class="stack">' +
      '<section class="hero" onclick="Warehouse.showGuide()" title="点击深绿色边缘查看使用教程" aria-label="点击色块边缘查看使用教程"><div class="hero-badge" onclick="event.stopPropagation()"><b>' + displayDate.getDate() + '</b><strong>' + esc(displayMonth) + '</strong><span>' + esc(displayWeekday) + '</span><small>' + displayDate.getFullYear() + '</small></div><button class="hero-search" onclick="event.stopPropagation();Warehouse.go(\'search\')" aria-label="打开全局搜索"><span>⌕</span><strong>全局搜索</strong></button></section>' +
      '<section class="quick"><button onclick="Warehouse.go(\'products\')"><span class="qicon qproduct" aria-hidden="true"></span><div><strong>商品资料</strong></div><em>→</em></button><button onclick="Warehouse.go(\'inbound\')"><span class="qicon qin">↘</span><div><strong>商品入库</strong></div><em>→</em></button><button onclick="Warehouse.go(\'outbound\')"><span class="qicon qout">↗</span><div><strong>商品出库</strong></div><em>→</em></button><button onclick="Warehouse.go(\'recipes\')"><span class="qicon qrecipe" aria-hidden="true"></span><div><strong>一键配料</strong></div><em>→</em></button></section>' +
      '<section class="metrics"><button class="metric metric-link" onclick="Warehouse.go(\'inventory\')"><span>库存商品</span><strong>' + products.length + '<small> 种</small></strong><p>点击查看实时库存</p></button><button class="metric metric-link" onclick="Warehouse.go(\'reports\')"><span>今日出入库</span><strong>入 ' + fmt(inQty) + ' · 出 ' + fmt(outQty) + '</strong><p>点击查看库存报表</p></button></section>' +
      '<section class="grid2"><article class="panel"><div class="panel-head"><h2>最近流水</h2><button class="export" onclick="Warehouse.go(\'inventory\')">查看库存</button></div>' + activityRows(state.documents.slice(0, 6)) + '</article><article class="panel"><div class="panel-head"><h2>低库存商品</h2><span class="status">' + low.length + ' 种</span></div><div class="warnings">' + (low.length ? low.slice(0, 6).map(function (p) { return '<div><span><strong>' + esc(p.name) + '</strong><small>' + esc(p.code) + '</small></span><b>' + p.stock + ' / ' + p.min + esc(p.unit) + '</b></div>'; }).join("") : '<div class="empty"><strong>库存状态良好</strong></div>') + '</div></article></section>' +
    '</div>';
  }

  function activityRows(docs) {
    if (!docs.length) return '<div class="empty"><strong>还没有库存流水</strong><p>完成首次入库后会显示在这里。</p></div>';
    return '<div class="activity">' + docs.map(function (doc) {
      var names = doc.items.slice(0, 2).map(function (line) { var p = productById(line.productId); return p ? p.name : "未知商品"; }).join("、");
      var qty = doc.items.reduce(function (sum, line) { return sum + Math.abs(line.quantity); }, 0);
      return '<div class="activity-row ' + (doc.type === "assembly" ? "outbound" : doc.type) + '"><span class="aicon">' + icon(doc.type) + '</span><div><strong>' + esc(typeLabel(doc.type) + " · " + names) + '</strong><small>' + esc(doc.no + " · " + doc.purpose) + '</small></div><b>' + ((doc.type === "outbound" || doc.type === "assembly") ? "−" : doc.type === "inbound" ? "+" : "") + qty + '</b></div>';
    }).join("") + '</div>';
  }

  function inventoryView() {
    var products = activeProducts();
    var grouped = state.settings.inventorySupplierGrouping === true;
    var selected = selectedInventorySupplier;
    var visibleProducts = selected ? products.filter(function (product) { return (product.supplier || "未设置供应商") === selected; }) : products;
    var tableContent = grouped && !selected ? inventorySupplierGroupsView(products) : inventoryTable(visibleProducts, false);
    var toolbar = grouped && !selected
      ? '<span class="result">共 ' + products.length + ' 种库存商品，按默认供应商分类</span>'
      : '<input id="inventorySearch" class="search" placeholder="搜索品名、编号或供应商" oninput="Warehouse.filterInventory(this.value)"><span class="result">' + (selected ? esc(selected) + ' · ' : "") + '库存商品 ' + visibleProducts.length + ' 种</span>';
    return '<div class="stack"><section class="heading"><div><p class="eyebrow">实时库存</p><h1>查看库存</h1><p>当前共有 ' + products.length + ' 种库存商品。</p></div><button class="blue-action" onclick="Warehouse.exportExcel()">⇩ 导出 Excel</button></section><section class="inventory-tools"><button onclick="Warehouse.go(\'stocktake\')"><span>✓</span><div><strong>库存盘点</strong><small>核对账实并留存盘盈盘亏流水</small></div><b>→</b></button><button onclick="Warehouse.go(\'reports\')"><span>▤</span><div><strong>库存报表</strong><small>查看日报、月报和年报</small></div><b>→</b></button></section><section class="panel scroll"><div class="toolbar inventory-toolbar">' + (selected ? '<button class="secondary compact" onclick="Warehouse.clearInventorySupplier()">← 返回供应商分类</button>' : "") + '<button class="secondary supplier-group-toggle ' + (grouped ? "active" : "") + '" onclick="Warehouse.toggleInventorySupplierGrouping()">按供应商分类：' + (grouped ? "已开启" : "已关闭") + '</button>' + toolbar + '</div><div id="inventoryTable">' + tableContent + '</div></section></div>';
  }

  function recipeById(id) { return state.recipes.find(function (recipe) { return recipe.id === id; }); }

  function recipeComponentProduct(component) {
    var product = productById(component.productId);
    return product && !product.archived ? product : null;
  }

  function recipeMaximumOrder(recipe) {
    if (!recipe || !recipe.components.length) return 0;
    return recipe.components.reduce(function (maximum, component) {
      var product = recipeComponentProduct(component);
      return Math.min(maximum, product ? Math.floor(product.stock / component.quantity) : 0);
    }, Number.MAX_SAFE_INTEGER);
  }

  function recipesView() {
    var recipes = state.recipes.slice().sort(function (a, b) { return a.name.localeCompare(b.name, "zh-CN"); });
    var cards = recipes.length ? '<div class="recipe-cards">' + recipes.map(function (recipe) {
      var maximum = recipeMaximumOrder(recipe);
      return '<button class="recipe-card" onclick="Warehouse.openRecipe(\'' + esc(recipe.id) + '\')"><strong>' + esc(recipe.name) + '</strong><span><small>配件种类</small><b>' + recipe.components.length + ' 种</b></span><span><small>可下单</small><b>' + maximum + ' 件</b></span></button>';
    }).join("") + '</div>' : '<div class="empty"><strong>还没有产品配方</strong><p>先下载模板，填写某款产品所需的配件和每件用量后再导入。</p></div>';
    return '<div class="stack"><section class="heading"><div><p class="eyebrow">产品配方 · 自动扣料</p><h1>一键配料</h1><p>一份配料模板对应一款产品；填写产品名称后，录入该产品全部配件及每件用量。</p></div><div class="heading-actions"><button class="primary" onclick="Warehouse.newRecipe()">＋ 新增产品配方</button><button class="secondary data-action" onclick="Warehouse.downloadRecipeTemplate()">下载配料模板</button><button class="blue-action" onclick="document.getElementById(\'recipeImportFile\').click()">导入产品配方</button><input hidden id="recipeImportFile" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onchange="Warehouse.previewRecipeImport(this.files[0]);this.value=\'\'"> </div></section><section class="panel recipe-panel">' + cards + '</section></div>';
  }

  function recipeDetailView() {
    var recipe = recipeById(selectedRecipeId);
    if (!recipe) return '<div class="empty"><strong>产品配方不存在</strong><p><button class="secondary" onclick="Warehouse.go(\'recipes\')">返回一键配料</button></p></div>';
    var maximum = recipeMaximumOrder(recipe);
    var rows = recipe.components.map(function (component) {
      var product = recipeComponentProduct(component);
      var supplier = component.supplier || (product && product.supplier) || "未设置";
      return '<div class="recipe-line"><div><strong>' + esc(product ? product.name : "配件已移除") + '</strong></div><div><b>' + component.quantity + '</b></div><div>' + esc(component.shelfLocation || "—") + '</div><div>' + esc(supplier) + '</div><div>' + esc(component.remark || "—") + '</div></div>';
    }).join("");
    return '<div class="stack"><section class="heading history-heading"><div><button class="back-link" onclick="Warehouse.go(\'recipes\')">← 返回一键配料</button><p class="eyebrow">产品配方详情</p><h1>' + esc(recipe.name) + '</h1><p>共 ' + recipe.components.length + ' 种配件 · 每下单 1 件产品，按下表“每件用量”自动扣减库存。</p></div><button class="blue-action" onclick="Warehouse.editRecipe(\'' + esc(recipe.id) + '\')">编辑配方</button></section><section class="recipe-order"><div><span>可下单数量</span><strong>' + maximum + ' 件</strong><small>由库存最少的配件决定</small></div><label><span>下单产品数量 *</span><input id="recipeOrderQuantity" type="number" min="1" step="1" value="1" onkeydown="Warehouse.recipeOrderEnter(event)"></label><button class="primary primary-action" onclick="Warehouse.placeRecipeOrder(\'' + esc(recipe.id) + '\')">确认下单并扣减配件</button></section><div id="recipeOrderError"></div><section class="panel scroll"><div class="recipe-table"><div class="recipe-head"><span>配件品类</span><span>每件用量</span><span>货架位置（选填）</span><span>供应商（选填）</span><span>备注（选填）</span></div>' + rows + '</div></section></div>';
  }

  function recipeImportHeaders() { return ["配件品类", "每件用量", "货架位置（选填）", "供应商（选填）", "备注（选填）"]; }

  function normalizeRecipeImportHeader(value) {
    return String(value == null ? "" : value).trim().replace(/[（(]选填[）)]/g, "");
  }

  function validateRecipeImportRows(rows) {
    var headers = recipeImportHeaders();
    if (rows.length < 2) throw new Error("Excel 中没有完整的产品名称和配件明细。");
    for (var headerIndex = 0; headerIndex < headers.length; headerIndex += 1) if (normalizeRecipeImportHeader(rows[0][headerIndex]) !== normalizeRecipeImportHeader(headers[headerIndex])) throw new Error("“配方导入”表头不正确，请重新下载系统模板。");
    var productNameRow = rows.find(function (values) { return String(values[6] || "").trim() === "产品名称"; });
    if (!productNameRow) throw new Error("请在模板右侧“产品名称”输入框中填写产品名称。");
    var productName = String(productNameRow[7] == null ? "" : productNameRow[7]).trim();
    if (!productName) throw new Error("请先在模板右侧加粗的“产品名称”输入框填写本次配料模板对应的产品名称。");
    var names = Object.create(null);
    state.recipes.forEach(function (recipe) { names[recipe.name.toLowerCase()] = true; });
    var seenComponents = Object.create(null);
    var prepared = [];
    rows.slice(1).forEach(function (values, index) {
      if (!values.slice(0, 5).some(function (value) { return String(value == null ? "" : value).trim(); })) return;
      var componentName = String(values[0] == null ? "" : values[0]).trim();
      var quantityText = String(values[1] == null ? "" : values[1]).trim();
      var quantity = Number(quantityText);
      var shelfLocation = String(values[2] == null ? "" : values[2]).trim();
      var supplier = String(values[3] == null ? "" : values[3]).trim();
      var remark = String(values[4] == null ? "" : values[4]).trim();
      var errors = [];
      if (!componentName) errors.push("配件品类必填");
      if (!quantityText || !Number.isSafeInteger(quantity) || quantity <= 0) errors.push("每件用量必须是大于 0 的整数");
      if (names[productName.toLowerCase()]) errors.push("该产品配方已存在，请在详情中修改");
      var key = componentName.toLowerCase();
      if (componentName && seenComponents[key]) errors.push("同一产品不能重复填写同一配件");
      seenComponents[key] = true;
      prepared.push({ row: index + 2, productName: productName, componentName: componentName, quantity: quantity, supplier: supplier, remark: remark, shelfLocation: shelfLocation, errors: errors });
    });
    if (!prepared.length) throw new Error("“配方导入”工作表中没有可导入的配件。");
    if (prepared.length > 2000) throw new Error("一次最多导入 2000 行配件。");
    return prepared;
  }

  function recipeImportPreviewHtml(rows) {
    var errors = rows.reduce(function (sum, row) { return sum + row.errors.length; }, 0);
    var productName = rows[0] ? rows[0].productName : "";
    return '<div id="recipeImportError"></div><div class="import-summary ' + (errors ? "has-errors" : "ready") + '"><strong>' + (errors ? "发现 " + errors + " 个问题" : "校验通过，可以导入") + '</strong><span>产品：' + esc(productName) + ' · 共 ' + rows.length + ' 行配件；库中没有的配件会自动建档为“新增待盘点”。</span></div><div class="import-preview recipe-import-preview"><div class="recipe-import-head"><span>行</span><span>配件品类</span><span>每件用量</span><span>货架位置</span><span>供应商</span><span>备注</span><span>校验结果</span></div>' + rows.map(function (row) { return '<div class="recipe-import-row ' + (row.errors.length ? "invalid" : "valid") + '"><span>' + row.row + '</span><span><strong>' + esc(row.componentName || "—") + '</strong></span><span>' + row.quantity + '</span><span>' + esc(row.shelfLocation || "—") + '</span><span>' + esc(row.supplier || "—") + '</span><span>' + esc(row.remark || "—") + '</span><span>' + (row.errors.length ? '<b>' + esc(row.errors.join("；")) + '</b>' : "可导入") + '</span></div>'; }).join("") + '</div><div class="modal-actions"><button class="secondary" onclick="Warehouse.closeModal()">取消</button><button class="primary primary-action" ' + (errors ? "disabled" : "") + ' onclick="Warehouse.commitRecipeImport()">确认导入配方</button></div>';
  }

  function renderRecipeEditModal() {
    if (!recipeDraft) return;
    var isNew = !recipeDraft.id;
    var rows = recipeDraft.components.map(function (component, index) { return '<div class="recipe-edit-row"><input data-field="product" list="recipeProductList" value="' + esc(component.product || "") + '" placeholder="输入配件品类"><input data-field="quantity" type="number" min="1" step="1" value="' + esc(component.quantity || "") + '" placeholder="每件用量"><input data-field="shelfLocation" value="' + esc(component.shelfLocation || "") + '" placeholder="货架位置（选填）"><input data-field="supplier" value="' + esc(component.supplier || "") + '" placeholder="供应商（选填）"><input data-field="remark" value="' + esc(component.remark || "") + '" placeholder="备注（选填）">' + (recipeDraft.components.length > 1 ? '<button type="button" onclick="Warehouse.removeRecipeDraftComponent(' + index + ')" aria-label="删除配件">×</button>' : '<span></span>') + '</div>'; }).join("");
    document.getElementById("modalHost").innerHTML = '<div class="modal"><div class="modal-card recipe-edit-modal"><p class="eyebrow">' + (isNew ? "新建产品配方" : "修改产品配方") + '</p><h2>产品配件结构</h2><p class="modal-intro">先填写产品名称，再完整录入该产品的配件。每件用量为生产或下单 1 件产品时所扣减的数量。</p><label class="field"><span>产品名称 *</span><input id="recipeDraftName" value="' + esc(recipeDraft.name) + '" placeholder="例如：成套焊机"></label><datalist id="recipeProductList">' + productOptions() + '</datalist><div class="recipe-edit-head"><span>配件品类 *</span><span>每件用量 *</span><span>货架位置（选填）</span><span>供应商（选填）</span><span>备注（选填）</span><span></span></div><div id="recipeDraftRows">' + rows + '</div><button class="secondary recipe-add-component" type="button" onclick="Warehouse.addRecipeDraftComponent()">＋ 添加配件</button><div id="recipeEditError"></div><div class="modal-actions"><button class="secondary" onclick="Warehouse.closeModal()">取消</button><button class="primary primary-action" onclick="Warehouse.saveRecipeDraft()">' + (isNew ? "建立配方" : "保存配方") + '</button></div></div></div>';
  }

  function inventoryTable(products, editable) {
    if (editable) return productsTable(products);
    return '<div class="table inventory-table"><div class="thead"><span>商品</span><span>状态</span><span>当前库存</span><span>最低库存</span><span>计价单价</span><span>库存金额</span></div>' + products.map(function (p) {
      var needsStocktake = p.status === "新增待盘点";
      var action = needsStocktake ? "Warehouse.openPendingStocktake" : "Warehouse.openProductHistory";
      return '<div class="inventory-item"><div class="trow inventory-summary" role="link" tabindex="0" onclick="' + action + '(\'' + esc(p.id) + '\')" onkeydown="Warehouse.openInventoryProductKey(event,\'' + esc(p.id) + '\')"><div class="product inventory-product"><strong>' + esc(p.name) + '</strong></div><div>' + statusSelect(p) + '</div><div class="qty"><strong>' + p.stock + '</strong></div><div><strong>' + p.min + '</strong></div><div><strong>' + money(inventoryUnitCost(p)) + '</strong></div><div class="inventory-value"><span>' + money(inventoryValue(p)) + '</span><b>→</b></div></div></div>';
    }).join("") + '</div>';
  }

  function productsTable(products) {
    return '<div class="table product-master-table"><div class="thead"><span>商品编号</span><span>商品名称</span><span>默认供应商</span><span>状态</span><span>最低库存</span><span>操作</span></div>' + products.map(function (p) {
      return '<div class="trow product-master-main"><div class="master-code"><strong>' + esc(p.code) + '</strong></div><div class="master-name"><strong>' + esc(p.name) + '</strong></div><div class="master-supplier">' + esc(p.supplier || "未设置供应商") + '</div><div>' + statusSelect(p) + '</div><div class="master-min"><strong>' + p.min + '</strong><button class="limit-product" onclick="Warehouse.productMinimumModal(\'' + esc(p.id) + '\')">修改</button></div><button class="remove-product ' + (p.stock === 0 ? "" : "danger") + '" onclick="Warehouse.removeProduct(\'' + esc(p.id) + '\')">' + (p.stock === 0 ? "移除商品" : "清空并移除") + '</button></div>';
    }).join("") + '</div>';
  }

  function supplierGroupsView() {
    var groups = Object.create(null);
    activeProducts().forEach(function (product) {
      var supplier = product.supplier || "未设置供应商";
      if (!groups[supplier]) groups[supplier] = [];
      groups[supplier].push(product);
    });
    var suppliers = Object.keys(groups).sort(function (a, b) { return a.localeCompare(b, "zh-Hans-CN"); });
    if (!suppliers.length) return '<div class="empty"><strong>还没有商品资料</strong><p>新增商品并填写默认供应商后，可按供应商查看。</p></div>';
    return '<section class="supplier-groups">' + suppliers.map(function (supplier) {
      var items = groups[supplier];
      return '<button class="supplier-group-card" onclick="Warehouse.openSupplierProducts(\'' + esc(supplier) + '\')"><strong>' + esc(supplier) + '</strong><span><small>商品种类</small><b>' + items.length + ' 种</b></span></button>';
    }).join("") + '</section>';
  }

  function inventorySupplierGroupsView(products) {
    var groups = Object.create(null);
    products.forEach(function (product) {
      var supplier = product.supplier || "未设置供应商";
      if (!groups[supplier]) groups[supplier] = [];
      groups[supplier].push(product);
    });
    var suppliers = Object.keys(groups).sort(function (a, b) { return a.localeCompare(b, "zh-Hans-CN"); });
    if (!suppliers.length) return '<div class="empty"><strong>还没有库存商品</strong><p>新增商品后可按供应商查看实时库存。</p></div>';
    return '<section class="supplier-groups inventory-supplier-groups">' + suppliers.map(function (supplier) {
      var items = groups[supplier];
      var quantity = items.reduce(function (total, product) { return total + Number(product.stock || 0); }, 0);
      return '<button class="supplier-group-card" onclick="Warehouse.openInventorySupplier(\'' + esc(supplier) + '\')"><strong>' + esc(supplier) + '</strong><span><small>库存商品</small><b>' + items.length + ' 种 · ' + quantity + ' 件</b></span></button>';
    }).join("") + '</section>';
  }

  function supplierProductsView() {
    var supplier = selectedSupplier || "未设置供应商";
    var products = activeProducts().filter(function (product) { return (product.supplier || "未设置供应商") === supplier; });
    return '<div class="stack"><section class="heading"><div><button class="back-link" onclick="Warehouse.go(\'products\')">← 返回商品资料</button><p class="eyebrow">供应商分类</p><h1>' + esc(supplier) + '</h1><p>该供应商下共 ' + products.length + ' 种商品资料。</p></div></section><section class="panel scroll">' + productsTable(products) + '</section></div>';
  }

  function productLifecycle(product) {
    var docs = state.documents.filter(function (doc) {
      return doc.items.some(function (line) { return line.productId === product.id; });
    }).slice().sort(function (a, b) { return new Date(a.at) - new Date(b.at); });
    return [{ at: product.createdAt, type: "created", typeText: "建库", no: "—", quantity: null, unitPrice: null, priceLabel: "—", before: null, after: 0, detail: "建立商品资料 · 编号 " + product.code, operator: "离线管理员" }].concat(docs.map(function (doc) {
      var line = doc.items.find(function (item) { return item.productId === product.id; });
      var isInbound = doc.type === "inbound";
      var isOutbound = doc.type === "outbound" || doc.type === "assembly";
      var unitPrice = isInbound ? line.price : line.cost;
      var priceLabel = isInbound ? "入库单价" : isOutbound ? costMethodLabel(doc.costMethod || "weighted") + "出库成本" : "盘点时成本";
      // 备注单独显示在全周期的“备注”列，避免与供应商/用途混在一起。
      var detail = isInbound ? (doc.supplier || "未填写供应商") + (doc.ref ? " · 单号 " + doc.ref : "") : (doc.customer ? "客户 " + doc.customer : "") + (doc.contact ? (doc.customer ? " · " : "") + "联系方式 " + doc.contact : "") + ((doc.customer || doc.contact) && doc.purpose ? " · " : "") + (doc.purpose || "");
      return { at: doc.at, type: doc.type, typeText: typeLabel(doc.type), no: doc.no, quantity: isOutbound ? -Math.abs(line.quantity) : line.quantity, unitPrice: Number(unitPrice || 0), priceLabel: priceLabel, before: line.before, after: line.after, lineRemark: line.remark || "", remark: doc.remark || "", detail: detail, operator: doc.operator };
    }));
  }

  function productHistoryView() {
    var product = productById(selectedProductId);
    if (!product || product.archived) return '<div class="empty"><strong>商品不存在或已移除</strong><p><button class="secondary" onclick="Warehouse.go(\'inventory\')">返回库存</button></p></div>';
    var records = productLifecycle(product).filter(function (record) { return historyFilter === "all" || record.type === historyFilter || (historyFilter === "outbound" && record.type === "assembly"); }).sort(function (a, b) { return historySort === "asc" ? new Date(a.at) - new Date(b.at) : new Date(b.at) - new Date(a.at); });
    var rows = records.map(function (record) {
      var quantity = record.quantity == null ? "—" : ((record.quantity > 0 ? "+" : "") + record.quantity + product.unit);
      var stockChange = record.before == null ? "—" : record.before + " → " + record.after + product.unit;
      var remark = record.type === "inbound" ? (record.lineRemark || record.remark || "") : record.remark || "";
      return '<div class="history-row"><div>' + esc(fullDateTime(record.at)) + '</div><div><span class="history-type ' + esc(record.type) + '">' + esc(record.typeText) + '</span></div><div><strong>' + esc(record.no) + '</strong></div><div class="history-qty">' + esc(quantity) + '</div><div>' + (record.unitPrice == null ? "—" : money(record.unitPrice)) + '</div><div>' + esc(stockChange) + '</div><div>' + esc(remark || "—") + '</div><div>' + esc(record.detail) + '</div><div>' + esc(record.operator) + '</div></div>';
    }).join("");
    return '<div class="stack"><section class="heading history-heading"><div><button class="back-link" onclick="Warehouse.go(\'inventory\')">← 返回库存</button><p class="eyebrow">商品全周期</p><h1>' + esc(product.name) + '</h1><p>' + esc(product.code + " · " + (product.supplier || "未设置供应商")) + '</p></div><button class="blue-action" onclick="Warehouse.exportProductHistory(\'' + esc(product.id) + '\')">⇩ 导出 Excel</button></section><section class="history-summary"><article><span>当前库存</span><strong>' + product.stock + '<small>' + esc(product.unit) + '</small></strong></article><article><span>当前计价单价 · ' + esc(costMethodLabel(state.settings.costMethod)) + '</span><strong>' + money(inventoryUnitCost(product)) + '</strong></article><article><span>供应状态</span>' + statusSelect(product) + '</article><article><span>建库时间</span><strong class="summary-date">' + esc(fullDateTime(product.createdAt)) + '</strong></article></section><section class="panel scroll"><div class="history-toolbar"><label>筛选<select onchange="Warehouse.setHistoryFilter(this.value)"><option value="all"' + (historyFilter === "all" ? " selected" : "") + '>全部类型</option><option value="inbound"' + (historyFilter === "inbound" ? " selected" : "") + '>仅入库</option><option value="outbound"' + (historyFilter === "outbound" ? " selected" : "") + '>仅出库</option></select></label><label>排序<select onchange="Warehouse.setHistorySort(this.value)"><option value="desc"' + (historySort === "desc" ? " selected" : "") + '>时间降序（默认）</option><option value="asc"' + (historySort === "asc" ? " selected" : "") + '>时间升序</option></select></label><span>共 ' + records.length + ' 条</span></div><div class="history-table"><div class="history-head-row"><span>时间</span><span>类型</span><span>单号</span><span>数量</span><span>单价/成本</span><span>库存变化</span><span>备注</span><span>供应商/用途</span><span>操作人</span></div>' + rows + '</div></section></div>';
  }

  function globalSuggestions() {
    var seen = {};
    var values = [];
    activeProducts().forEach(function (product) {
      [product.name, product.code, product.supplier, pinyinInitials(product.name), pinyinInitials(product.supplier)].forEach(function (value) {
        value = String(value || "").trim();
        if (value && !seen[value.toLowerCase()]) { seen[value.toLowerCase()] = true; values.push(value); }
      });
    });
    return values.map(function (value) { return '<option value="' + esc(value) + '"></option>'; }).join("");
  }

  function globalSearchResults(query) {
    var term = String(query || "").trim().toLowerCase();
    if (!term) return '<div class="search-empty"><span>⌕</span><strong>输入供应商、商品编号或品名</strong><p>选择联想词后会显示库存、价格和快捷操作。</p></div>';
    var matches = activeProducts().filter(function (product) {
      return productSearchText(product).indexOf(term) >= 0;
    });
    if (!matches.length) return '<div class="search-empty"><span>×</span><strong>没有找到匹配商品</strong><p>可尝试输入更短的品名、编号或供应商名称。</p></div>';
    return '<div class="search-result-list"><div class="search-result-head"><span>商品名称</span><span>商品编号</span><span>默认供应商</span><span>当前库存</span><span>计价单价</span><span>状态</span><span>操作</span></div>' + matches.map(function (product) {
      return '<article class="search-result-card"><div class="search-result-main" data-label="商品名称"><span class="search-avatar">' + esc(product.name.slice(0, 1)) + '</span><strong>' + esc(product.name) + '</strong></div><div class="search-result-cell search-code" data-label="商品编号"><b>' + esc(product.code) + '</b></div><div class="search-result-cell search-supplier" data-label="默认供应商"><b>' + esc(product.supplier || "未设置供应商") + '</b></div><div class="search-result-cell" data-label="当前库存"><b>' + product.stock + esc(product.unit) + '</b></div><div class="search-result-cell" data-label="计价单价"><b>' + money(inventoryUnitCost(product)) + '</b><small class="cost-basis">' + esc(costMethodLabel(state.settings.costMethod)) + '</small></div><div class="search-result-cell" data-label="状态"><b>' + esc(product.status) + '</b></div><div class="search-result-actions"><button class="primary" onclick="Warehouse.startProductDocument(\'inbound\',\'' + esc(product.id) + '\')">商品入库</button><button class="secondary" onclick="Warehouse.startProductDocument(\'outbound\',\'' + esc(product.id) + '\')">商品出库</button><button class="blue-action compact" onclick="Warehouse.openProductHistory(\'' + esc(product.id) + '\')">查看全周期</button></div></article>';
    }).join("") + '</div>';
  }

  function globalSearchView() {
    return '<div class="stack"><section class="heading"><div><p class="eyebrow">跨商品检索</p><h1>全局搜索</h1><p>支持供应商、商品编号、商品名称及中文拼音首字母联想查询。</p></div><button class="secondary" onclick="Warehouse.go(\'home\')">返回工作台</button></section><section class="global-search-panel"><div class="global-search-box"><span>⌕</span><input id="globalSearchInput" list="globalSuggestions" value="' + esc(globalQuery) + '" placeholder="输入品名、供应商、编号或拼音首字母，如 yw" autocomplete="off" oninput="Warehouse.globalSearch(this.value)"><button onclick="Warehouse.clearGlobalSearch()" aria-label="清空搜索">×</button></div><datalist id="globalSuggestions">' + globalSuggestions() + '</datalist><div id="globalSearchResults">' + globalSearchResults(globalQuery) + '</div></section></div>';
  }

  function collectDraftLines() {
    var rows = Array.prototype.slice.call(document.querySelectorAll(".doc-line"));
    if (!rows.length) return;
    draftLines = rows.map(function (row) {
      return {
        product: row.querySelector("[data-field=product]").value,
        quantity: row.querySelector("[data-field=quantity]").value,
        price: row.querySelector("[data-field=price]") ? row.querySelector("[data-field=price]").value : "",
        remark: row.querySelector("[data-field=lineRemark]") ? row.querySelector("[data-field=lineRemark]").value : ""
      };
    });
  }

  function collectDraftMeta() {
    var supplier = document.getElementById("docSupplier");
    var ref = document.getElementById("docRef");
    var purpose = document.getElementById("docPurpose");
    var customer = document.getElementById("docCustomer");
    var contact = document.getElementById("docContact");
    var remark = document.getElementById("docRemark");
    if (supplier) draftSupplier = supplier.value;
    if (ref) draftRef = ref.value;
    if (purpose) draftPurpose = purpose.value;
    if (customer) draftCustomer = customer.value;
    if (contact) draftContact = contact.value;
    if (remark) draftRemark = remark.value;
  }

  function productOptions() {
    return activeProducts().map(function (p) { return '<option value="' + esc(p.code + " · " + p.name) + '"></option>'; }).join("");
  }

  function knownSuppliers() {
    var supplied = Object.create(null);
    activeProducts().forEach(function (product) {
      var supplier = String(product.supplier || "").trim();
      if (supplier) supplied[supplier.toLocaleLowerCase("zh-CN")] = supplier;
    });
    return Object.keys(supplied).map(function (key) { return supplied[key]; }).sort(function (a, b) { return a.localeCompare(b, "zh-Hans-CN"); });
  }

  function supplierOptions(selected) {
    var chosen = String(selected || "").trim().toLocaleLowerCase("zh-CN");
    return '<option value="">选择已有供应商</option>' + knownSuppliers().map(function (supplier) {
      return '<option value="' + esc(supplier) + '"' + (supplier.toLocaleLowerCase("zh-CN") === chosen ? " selected" : "") + '>' + esc(supplier) + '</option>';
    }).join("");
  }

  function documentView() {
    documentType = page;
    var inbound = documentType === "inbound";
    var extraFields = inbound
      ? '<details class="meta-details"><summary><span><b>供应商信息</b><small>选填 · 点击展开</small></span><b class="details-arrow" aria-hidden="true">⌄</b></summary><div class="meta inbound-meta"><label><span>实际供应商</span><input id="docSupplier" value="' + esc(draftSupplier) + '" placeholder="供应商名称" onkeydown="Warehouse.nextOnEnter(event)"></label><label><span>供应商单号</span><input id="docRef" value="' + esc(draftRef) + '" placeholder="选填" onkeydown="Warehouse.nextOnEnter(event)"></label></div></details>'
      : '<div class="meta outbound-meta"><label><span>客户（选填）</span><input id="docCustomer" value="' + esc(draftCustomer) + '" placeholder="客户名称" onkeydown="Warehouse.nextOnEnter(event)"></label><label><span>联系方式（选填）</span><input id="docContact" value="' + esc(draftContact) + '" placeholder="电话、微信或其他联系方式" onkeydown="Warehouse.nextOnEnter(event)"></label></div><details class="meta-details"><summary><span><b>用途及备注</b><small>选填 · 点击展开</small></span><b class="details-arrow" aria-hidden="true">⌄</b></summary><div class="meta outbound-meta"><label><span>用途</span><input id="docPurpose" value="' + esc(draftPurpose) + '" placeholder="例如：生产领用" onkeydown="Warehouse.nextOnEnter(event)"></label><label><span>备注</span><input id="docRemark" value="' + esc(draftRemark) + '" placeholder="填写出库备注" onkeydown="Warehouse.nextOnEnter(event)"></label></div></details>';
    return '<div class="stack"><section class="heading"><div><p class="eyebrow">' + (inbound ? "采购到货 · 库存增加" : "领用发货 · 库存减少") + '</p><h1>新建' + (inbound ? "入库" : "出库") + '单</h1><p>' + (inbound ? "输入库存中没有的商品时，提交后会自动打开新增商品窗口。" : "任何情况下都不允许负库存，成本由系统自动计算。") + '</p></div></section><section class="panel form"><div class="form-section"><div><h2>商品明细</h2></div><button class="export" onclick="Warehouse.addLine()">＋ 添加一行</button></div><datalist id="productList">' + productOptions() + '</datalist><div class="lines"><div class="lhead ' + (inbound ? "inbound-lines" : "") + '"><span>商品 *</span><span>当前库存</span><span>数量 *</span><span>' + (inbound ? "实际单价 *" : "计价方式") + '</span>' + (inbound ? '<span>备注（选填）</span>' : '') + '<span></span></div>' + draftLines.map(function (line, index) { var p = productFromText(line.product); return '<div class="line doc-line ' + (inbound ? "inbound-lines" : "") + '" data-index="' + index + '"><input data-field="product" list="productList" value="' + esc(line.product) + '" placeholder="输入品名或编号" onchange="Warehouse.syncLine(this)" onkeydown="Warehouse.nextOnEnter(event)"><span class="stock">' + (p ? p.stock + esc(p.unit) : "—") + '</span><input data-field="quantity" type="number" min="1" step="1" value="' + esc(line.quantity) + '" placeholder="填写数量" onkeydown="Warehouse.nextOnEnter(event)">' + (inbound ? '<input data-field="price" type="number" min="0" step="0.01" value="' + esc(line.price) + '" placeholder="¥ 0.00" onkeydown="Warehouse.nextOnEnter(event)"><input data-field="lineRemark" value="' + esc(line.remark || "") + '" placeholder="填写本次入库备注（选填）" onkeydown="Warehouse.nextOnEnter(event)">' : '<span class="cost-method">' + esc(costMethodLabel(state.settings.costMethod)) + '</span>') + (draftLines.length > 1 ? '<button type="button" aria-label="删除这一行" onclick="Warehouse.removeLine(' + index + ')">×</button>' : '<span class="line-action-placeholder"></span>') + '</div>'; }).join("") + '</div><div class="form-meta-title"><h2>' + (inbound ? "供应商信息" : "客户与出库信息") + '</h2></div>' + extraFields + '<div id="docError"></div><div class="form-foot"><p>共 ' + draftLines.length + ' 行商品明细 · 操作人自动记录</p><button class="primary primary-action" onclick="Warehouse.submitDocument()">确认' + (inbound ? "入库" : "出库") + '</button></div></section></div>';
  }

  function stocktakeView() {
    var targetProduct = productById(selectedStocktakeProductId);
    var products = activeProducts().slice();
    if (targetProduct && !targetProduct.archived) products.sort(function (a, b) { return a.id === targetProduct.id ? -1 : b.id === targetProduct.id ? 1 : 0; });
    return '<div class="stack"><section class="heading"><div><button class="back-link" onclick="Warehouse.go(\'inventory\')">← 返回查看库存</button><p class="eyebrow">账实核对 · 自动留痕</p><h1>库存盘点</h1><p>' + (targetProduct ? '已定位“' + esc(targetProduct.name) + '”，请填写该商品的实际数量。' : '填写实盘数量，系统生成盘盈盘亏流水。') + '</p></div></section><section class="panel scroll"><div class="toolbar"><input id="stocktakePurpose" class="search" value="定期盘点" placeholder="盘点说明"></div><div class="table"><div class="thead" style="grid-template-columns:minmax(260px,1.5fr) 130px 160px 130px"><span>商品</span><span>账面数量</span><span>实盘数量</span><span>差异</span></div>' + products.map(function (p) { var selected = targetProduct && p.id === targetProduct.id; return '<div class="trow stock-row' + (selected ? ' pending-stocktake-row' : '') + '" data-product="' + p.id + '" style="grid-template-columns:minmax(260px,1.5fr) 130px 160px 130px"><div class="product"><span>' + esc(p.name.slice(0, 1)) + '</span><div><strong>' + esc(p.name) + '</strong><small>' + esc(p.code) + '</small></div></div><div>' + p.stock + ' ' + esc(p.unit) + '</div><input class="search counted" type="number" min="0" step="1" placeholder="' + p.stock + '"' + (selected ? ' data-pending-stocktake="true"' : '') + ' oninput="Warehouse.stockDiff(this,' + p.stock + ',\'' + esc(p.unit) + '\')"><div class="diff">—</div></div>'; }).join("") + '</div><div id="stockError"></div><div class="form-foot"><p>提交已填写且有库存差异或待确认盘点的商品。</p><button class="primary primary-action" onclick="Warehouse.submitStocktake()">提交盘点</button></div></section></div>';
  }

  function replenishmentView() {
    var items = replenishmentItems();
    var rows = items.length ? '<div class="replenishment-table"><div class="replenishment-head"><span>商品</span><span>供应商</span><span>状态</span><span>当前库存</span><span>最低库存</span><span>提醒</span></div>' + items.map(function (p) { return '<div class="replenishment-row"><div class="replenishment-product"><strong>' + esc(p.name) + '</strong></div><div class="replenishment-supplier">' + esc(p.supplier || "未设置供应商") + '</div><div>' + statusSelect(p) + '</div><div><b>' + p.stock + '</b></div><div><b>' + p.min + '</b></div><div class="replenish-qty"><strong>需要补货</strong></div></div>'; }).join("") + '</div>' : '<div class="empty"><strong>当前无需补货</strong><p>库存低于或等于最低库存时，商品会显示在这里。</p></div>';
    return '<div class="stack"><section class="heading"><div><p class="eyebrow">采购辅助</p><h1>补货提醒</h1><p>库存低于或等于最低库存时提醒；采购数量由你按实际需要决定。</p></div><button class="blue-action" onclick="Warehouse.exportReplenishment()">⇩ 导出待补货清单</button></section><section class="report-cards replenishment-cards"><article><span>待补货商品</span><strong>' + items.length + ' 种</strong><p>按当前库存从低到高排列</p></article><article><span>已设置供应商</span><strong>' + items.filter(function (p) { return !!p.supplier; }).length + ' 种</strong><p>便于直接联系采购</p></article><article><span>规则</span><strong>低于最低</strong><p>当前库存低于或等于最低库存时触发</p></article></section><section class="panel scroll">' + rows + '</section></div>';
  }

  function reportsView() {
    var docs = filteredDocs();
    var inbound = docs.filter(function (d) { return d.type === "inbound"; });
    var outbound = docs.filter(function (d) { return d.type === "outbound" || d.type === "assembly"; });
    var stocktakes = docs.filter(function (d) { return d.type === "stocktake"; });
    var inQty = sumQty(docs, "inbound");
    var outQty = sumQty(docs, "outbound") + sumQty(docs, "assembly");
    var inValue = valueOf(inbound, true);
    var outValue = valueOf(outbound, false);
    var inventoryTotal = activeProducts().reduce(function (sum, product) { return sum + inventoryValue(product); }, 0);
    return '<div class="stack"><section class="heading"><div><button class="back-link" onclick="Warehouse.go(\'inventory\')">← 返回查看库存</button><p class="eyebrow">离线库存汇总</p><h1>库存报表</h1><p>当前查看：' + reportPeriodLabel() + ' · ' + reportFilterValue() + '</p></div><button class="blue-action" onclick="Warehouse.exportExcel(true)">⇩ 导出当前报表</button></section><div class="report-controls"><div class="tabs"><button class="' + (period === "day" ? "active" : "") + '" onclick="Warehouse.setPeriod(\'day\')">日报</button><button class="' + (period === "month" ? "active" : "") + '" onclick="Warehouse.setPeriod(\'month\')">月报</button><button class="' + (period === "year" ? "active" : "") + '" onclick="Warehouse.setPeriod(\'year\')">年报</button></div>' + reportDatePicker() + '</div><section class="report-cards report-summary-cards"><article><span>入库数量</span><strong>' + inQty + ' 件</strong><p>' + inbound.length + ' 张单 · ' + money(inValue) + '</p></article><article><span>出库数量</span><strong>' + outQty + ' 件</strong><p>' + outbound.length + ' 张单 · ' + money(outValue) + '</p></article><article><span>盘点调整</span><strong>' + stocktakes.length + ' 次</strong><p>' + stocktakes.reduce(function (s, d) { return s + d.items.length; }, 0) + ' 项盘盈盘亏</p></article><article><span>库存金额</span><strong>' + money(inventoryTotal) + '</strong><p>' + esc(costMethodLabel(state.settings.costMethod)) + '</p></article></section><section class="panel"><div class="panel-head"><h2>' + reportPeriodLabel() + '单据明细</h2><span class="status">' + docs.length + ' 张</span></div>' + activityRows(docs) + '</section></div>';
  }

  function productsView() {
    var grouped = state.settings.supplierGrouping === true;
    return '<div class="stack"><section class="heading"><div><p class="eyebrow">商品主数据</p><h1>商品资料</h1><p>可新增商品、批量导入 Excel，并设置最低库存和初始库存。</p></div><div class="heading-actions"><button class="secondary supplier-group-toggle ' + (grouped ? "active" : "") + '" onclick="Warehouse.toggleSupplierGrouping()">按供应商分类：' + (grouped ? "已开启" : "已关闭") + '</button><button class="secondary data-action" onclick="Warehouse.downloadImportTemplate()">下载导入模板</button><button class="blue-action" onclick="document.getElementById(\'productImportFile\').click()">Excel 批量导入</button><input hidden id="productImportFile" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onchange="Warehouse.previewProductImport(this.files[0]);this.value=\'\'"><button class="primary primary-action" onclick="Warehouse.productModal()">＋ 新增商品</button></div></section><section class="panel scroll">' + (grouped ? supplierGroupsView() : productsTable(activeProducts())) + '</section></div>';
  }

  function statusDefinitionRow(definition) {
    var protectedStatus = definition.name === "新增待盘点";
    return '<div class="status-definition-row"' + (protectedStatus ? ' data-system="true"' : '') + '><span class="status-color-preview" style="background:' + esc(definition.color) + '"></span><input class="status-definition-name" value="' + esc(definition.name) + '" maxlength="20"' + (protectedStatus ? ' readonly title="该状态用于自动盘点，名称不可删除或修改"' : '') + ' placeholder="例如：停止供货" oninput="Warehouse.previewStatusDefinition(this)"><input class="status-definition-color" type="color" value="' + esc(definition.color) + '" aria-label="' + esc(definition.name) + '颜色" oninput="Warehouse.previewStatusDefinition(this)"><span class="status-definition-sample" style="--status-color:' + esc(definition.color) + ';--status-fill:' + esc(statusFill(definition.color)) + '">' + esc(definition.name) + '</span>' + (protectedStatus ? '<span class="status-system-note">系统保留</span>' : '<button class="remove-status-definition" type="button" onclick="Warehouse.removeStatusDefinition(this)" aria-label="删除此状态">×</button>') + '</div>';
  }

  function statusOptionMarkup(selected) {
    return statusDefinitions().map(function (definition) { return '<option' + (selected === definition.name ? " selected" : "") + '>' + esc(definition.name) + '</option>'; }).join("");
  }

  function settingsView() {
    var current = Number(state.settings.fontScale || 1);
    var method = state.settings.costMethod || "weighted";
    var prefix = productCodePrefix();
    var preview = (prefix ? prefix + "-" : "") + "000001";
    var statuses = statusDefinitions();
    return '<div class="stack"><section class="heading"><div><p class="eyebrow">系统偏好</p><h1>设置</h1><p>显示大小、商品编号、商品状态和出库计价方式会保存在本机 data 文件夹。</p></div></section><section class="setting-section"><div class="setting-section-title"><h2>全局字体大小</h2></div><div class="settings-grid"><button class="setting-option ' + (current === 1 ? "active" : "") + '" onclick="Warehouse.setFontScale(1)"><b>标准</b><span>适合较大屏幕</span><em>100%</em></button><button class="setting-option ' + (current === 1.2 ? "active" : "") + '" onclick="Warehouse.setFontScale(1.2)"><b>较大</b><span>文字和按钮同步增大</span><em>120%</em></button><button class="setting-option ' + (current === 1.5 ? "active" : "") + '" onclick="Warehouse.setFontScale(1.5)"><b>特大</b><span>适合远距离查看</span><em>150%</em></button></div></section><section class="setting-section"><div class="setting-section-title"><h2>商品状态与颜色</h2><p>可新增、删除自定义状态，并为每个状态选择显示颜色；“新增待盘点”用于自动盘点，系统会保留。</p></div><div id="statusDefinitionList" class="status-definition-list">' + statuses.map(statusDefinitionRow).join("") + '</div><div class="status-definition-actions"><button class="secondary" type="button" onclick="Warehouse.addStatusDefinition()">＋ 新增状态</button><button class="primary" type="button" onclick="Warehouse.saveStatusDefinitions()">保存商品状态</button></div><div id="statusDefinitionError"></div></section><section class="setting-section"><div class="setting-section-title"><h2>商品编号前缀</h2><p>只影响之后自动生成的编号，已有商品编号不会改变。</p></div><div class="prefix-setting"><label class="field"><span>前缀名称</span><span class="clearable-input"><input id="productCodePrefix" value="' + esc(prefix) + '" maxlength="20" placeholder="留空表示无前缀" onkeydown="Warehouse.productCodePrefixEnter(event)"><button type="button" aria-label="清空商品编号前缀" title="设为无前缀" onclick="Warehouse.clearProductCodePrefix()">×</button></span></label><div class="prefix-preview"><span>下一个编号示例</span><strong>' + esc(preview) + '</strong></div><button class="primary prefix-save" onclick="Warehouse.saveProductCodePrefix()">保存前缀</button></div><div id="prefixError"></div></section><section class="setting-section"><div class="setting-section-title"><h2>出库计价方式</h2><p>只影响之后新建的出库单，历史流水不会改变。</p></div><div class="cost-method-grid"><button class="cost-option ' + (method === "weighted" ? "active" : "") + '" onclick="Warehouse.setCostMethod(\'weighted\')"><b>移动加权平均</b><span>综合现有库存与每次入库价格，波动较平稳</span><em>常用</em></button><button class="cost-option ' + (method === "fifo" ? "active" : "") + '" onclick="Warehouse.setCostMethod(\'fifo\')"><b>先进先出</b><span>优先使用最早批次的入库成本</span><em>FIFO</em></button><button class="cost-option ' + (method === "lastInbound" ? "active" : "") + '" onclick="Warehouse.setCostMethod(\'lastInbound\')"><b>最近入库价</b><span>使用该商品最近一次实际入库单价</span><em>最新</em></button></div></section></div>';
  }

  function backupView() {
    return '<div class="stack"><section class="heading"><div><p class="eyebrow">本机数据安全</p><h1>数据备份</h1><p>系统每周自动备份一次，并删除超过 30 天的旧备份。</p></div></section><section class="backup-grid"><article class="backup-card"><h2>立即备份到文件夹</h2><p>完整备份将写入 data\\backups，可直接复制到其他磁盘保存。</p><button class="blue-action" onclick="Warehouse.exportBackup()">立即备份</button></article><article class="backup-card"><h2>从备份恢复</h2><p>选择 data\\backups 中的仓储台 JSON 备份，用其替换当前数据。</p><button class="blue-action" onclick="document.getElementById(\'restoreFile\').click()">选择文件</button><input hidden id="restoreFile" type="file" accept=".json,application/json" onchange="Warehouse.restoreBackup(this.files[0])"></article><article class="backup-card"><h2>全量 Excel 导出</h2><p>生成库存与流水两个工作表，可直接使用 Microsoft Excel 打开。</p><button class="blue-action" onclick="Warehouse.exportExcel()">导出 Excel</button></article><article class="backup-card"><h2>清空全部数据</h2><p>清除商品、库存和全部流水，恢复为空白系统。操作前请先备份。</p><button class="blue-action" onclick="Warehouse.reset()">清空数据</button></article></section></div>';
  }

  function sumQty(docs, type) {
    return docs.filter(function (d) { return d.type === type; }).reduce(function (sum, d) { return sum + d.items.reduce(function (s, line) { return s + Math.abs(line.quantity); }, 0); }, 0);
  }
  function valueOf(docs, inbound) {
    return docs.reduce(function (sum, d) { return sum + d.items.reduce(function (s, line) { return s + Math.abs(line.quantity) * (inbound ? line.price : line.cost); }, 0); }, 0);
  }
  function padTwo(value) { return String(value).padStart(2, "0"); }
  function clampReportDay() { reportTarget.day = Math.min(reportTarget.day, new Date(reportTarget.year, reportTarget.month, 0).getDate()); }
  function reportPeriodLabel() { return period === "day" ? "日报" : period === "month" ? "月报" : "年报"; }
  function reportFilterValue() {
    if (period === "day") return reportTarget.year + "-" + padTwo(reportTarget.month) + "-" + padTwo(reportTarget.day);
    if (period === "month") return reportTarget.year + "-" + padTwo(reportTarget.month);
    return String(reportTarget.year);
  }
  function reportDatePicker() {
    var label = period === "day" ? "查看日期" : period === "month" ? "查看月份" : "查看年份";
    var type = period === "day" ? "date" : period === "month" ? "month" : "number";
    var limits = period === "year" ? ' min="1900" max="2100" step="1"' : "";
    return '<label class="report-date"><span>' + label + '</span><input type="' + type + '" value="' + reportFilterValue() + '"' + limits + ' aria-label="' + label + '" onclick="Warehouse.openPicker(this)" onchange="Warehouse.setReportDate(this.value)"></label>';
  }
  function filteredDocs() {
    return state.documents.filter(function (doc) {
      var value = new Date(doc.at);
      if (period === "day") return value.getFullYear() === reportTarget.year && value.getMonth() + 1 === reportTarget.month && value.getDate() === reportTarget.day;
      if (period === "month") return value.getFullYear() === reportTarget.year && value.getMonth() + 1 === reportTarget.month;
      return value.getFullYear() === reportTarget.year;
    });
  }

  function toast(message) {
    var old = document.querySelector(".success");
    if (old) old.remove();
    clearTimeout(toastTimer);
    clearTimeout(toastRemoveTimer);
    var node = document.createElement("div");
    node.className = "success" + (typeof message === "object" ? " success-card" : "");
    if (typeof message === "object") {
      node.innerHTML = '<span class="success-check">✓</span><div class="success-main"><strong>' + esc(message.title) + '</strong><small>' + esc(message.no) + '</small><p>' + esc(message.products) + '</p><div class="success-meta"><b>' + esc(message.quantity) + '</b><span>' + esc(message.detail) + '</span></div></div><button class="success-close" type="button" aria-label="关闭操作资料卡" onclick="Warehouse.closeToast(this)">×</button>';
    } else {
      node.textContent = "✓ " + message;
    }
    document.body.appendChild(node);
    var duration = typeof message === "object" ? 10000 : 3000;
    toastTimer = setTimeout(function () { node.classList.add("hide"); }, duration);
    toastRemoveTimer = setTimeout(function () { node.remove(); }, duration + 600);
  }

  function errorAt(id, message) {
    var host = document.getElementById(id);
    if (host) host.innerHTML = '<div class="error">' + esc(message) + '</div>';
  }

  function purposeError() {
    var host = document.getElementById("docError");
    if (host) host.innerHTML = '<div class="error error-with-action"><span>请填写所有红色闪烁的必填项目。</span><button type="button" onclick="Warehouse.ignorePurpose()">忽略用途</button></div>';
  }

  function download(name, content, type) {
    var blob = content && typeof content.arrayBuffer === "function" ? content : new Blob([content], { type: type });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
  }

  function xlsxEscape(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[char]; });
  }

  function xlsxColumn(index) {
    var value = "";
    do { value = String.fromCharCode(65 + (index % 26)) + value; index = Math.floor(index / 26) - 1; } while (index >= 0);
    return value;
  }

  function xlsxCell(value, row, col, format, styleOverride) {
    var ref = xlsxColumn(col) + (row + 1);
    var style = styleOverride == null ? (row === 0 ? 1 : format === "currency" ? 2 : format === "date" ? 3 : format === "integer" ? 4 : format === "decimal" ? 5 : format === "text" ? 6 : 0) : styleOverride;
    if (value == null || value === "") return '<c r="' + ref + '" s="' + style + '"/>';
    if (row > 0 && format === "date") {
      var date = value instanceof Date ? value : new Date(value);
      var serial = date.getTime() / 86400000 + 25569;
      return '<c r="' + ref + '" s="' + style + '"><v>' + serial + '</v></c>';
    }
    if (typeof value === "number" && Number.isFinite(value)) return '<c r="' + ref + '" s="' + style + '"><v>' + value + '</v></c>';
    return '<c r="' + ref + '" s="' + style + '" t="inlineStr"><is><t xml:space="preserve">' + xlsxEscape(value) + '</t></is></c>';
  }

  function xlsxSheet(rows, formats, validation, cellStyles, columnWidths, filterRange) {
    var columnCount = rows.reduce(function (max, row) { return Math.max(max, row.length); }, 0);
    var widths = [];
    for (var col = 0; col < columnCount; col += 1) {
      var width = 10;
      rows.forEach(function (row) {
        var value = row[col];
        var length = value instanceof Date ? 19 : String(value == null ? "" : value).length;
        width = Math.max(width, Math.min(32, length * 1.8 + 3));
      });
      if (columnWidths && Number(columnWidths[col]) > 0) width = Number(columnWidths[col]);
      widths.push('<col min="' + (col + 1) + '" max="' + (col + 1) + '" width="' + width.toFixed(1) + '" customWidth="1"' + (formats[col] === "text" ? ' style="6"' : "") + '/>');
    }
    var sheetRows = rows.map(function (values, row) {
      return '<row r="' + (row + 1) + '"' + (row === 0 ? ' ht="30" customHeight="1"' : "") + '>' + values.map(function (value, col) { return xlsxCell(value, row, col, formats[col], cellStyles && cellStyles[row + ":" + col]); }).join("") + '</row>';
    }).join("");
    var end = xlsxColumn(Math.max(0, columnCount - 1)) + Math.max(1, rows.length);
    var validations = validation && validation.sqref && validation.formula ? '<dataValidations count="1"><dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="' + (validation.allowCustom ? "0" : "1") + '" sqref="' + xlsxEscape(validation.sqref) + '"><formula1>' + xlsxEscape(validation.formula) + '</formula1></dataValidation></dataValidations>' : "";
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:' + end + '"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/><cols>' + widths.join("") + '</cols><sheetData>' + sheetRows + '</sheetData>' + (rows.length ? '<autoFilter ref="' + xlsxEscape(filterRange || ("A1:" + end)) + '"/>' : "") + validations + '</worksheet>';
  }

  function little16(value) { var bytes = new Uint8Array(2); new DataView(bytes.buffer).setUint16(0, value, true); return bytes; }
  function little32(value) { var bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, value >>> 0, true); return bytes; }
  function joinBytes(parts) {
    var total = parts.reduce(function (sum, part) { return sum + part.length; }, 0);
    var output = new Uint8Array(total);
    var offset = 0;
    parts.forEach(function (part) { output.set(part, offset); offset += part.length; });
    return output;
  }

  var crcTable = null;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = [];
      for (var n = 0; n < 256; n += 1) {
        var c = n;
        for (var k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
      }
    }
    var crc = 0xffffffff;
    for (var i = 0; i < bytes.length; i += 1) crc = crcTable[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function xlsxZip(files) {
    var encoder = new TextEncoder();
    var localParts = [];
    var centralParts = [];
    var offset = 0;
    files.forEach(function (file) {
      var name = encoder.encode(file.name);
      var data = typeof file.data === "string" ? encoder.encode(file.data) : file.data;
      var crc = crc32(data);
      var local = joinBytes([little32(0x04034b50), little16(20), little16(0x0800), little16(0), little16(0), little16(0), little32(crc), little32(data.length), little32(data.length), little16(name.length), little16(0), name, data]);
      localParts.push(local);
      centralParts.push(joinBytes([little32(0x02014b50), little16(20), little16(20), little16(0x0800), little16(0), little16(0), little16(0), little32(crc), little32(data.length), little32(data.length), little16(name.length), little16(0), little16(0), little16(0), little16(0), little32(0), little32(offset), name]));
      offset += local.length;
    });
    var central = joinBytes(centralParts);
    var end = joinBytes([little32(0x06054b50), little16(0), little16(0), little16(files.length), little16(files.length), little32(central.length), little32(offset), little16(0)]);
    return new Blob([joinBytes(localParts), central, end], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }

  function createXlsx(sheets) {
    var contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' + sheets.map(function (_, index) { return '<Override PartName="/xl/worksheets/sheet' + (index + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'; }).join("") + '</Types>';
    var definedNames = sheets.map(function (sheet) { return sheet.definedName && sheet.definedRange ? '<definedName name="' + xlsxEscape(sheet.definedName) + '">' + xlsxEscape(sheet.definedRange) + '</definedName>' : ""; }).join("");
    var workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + sheets.map(function (sheet, index) { return '<sheet name="' + xlsxEscape(sheet.name) + '" sheetId="' + (index + 1) + '" r:id="rId' + (index + 1) + '"' + (sheet.hidden ? ' state="hidden"' : '') + '/>'; }).join("") + '</sheets>' + (definedNames ? '<definedNames>' + definedNames + '</definedNames>' : '') + '<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>';
    var workbookRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + sheets.map(function (_, index) { return '<Relationship Id="rId' + (index + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (index + 1) + '.xml"/>'; }).join("") + '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>';
    var styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm:ss"/><numFmt numFmtId="165" formatCode="¥#,##0.00"/></numFmts><fonts count="4"><font><sz val="11"/><name val="Microsoft YaHei"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Microsoft YaHei"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="14"/><name val="Microsoft YaHei"/></font><font><b/><color rgb="FF1D6E55"/><sz val="16"/><name val="Microsoft YaHei"/></font></fonts><fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF4CA7FE"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1D6E55"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE9F6F0"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="medium"><color rgb="FF1D6E55"/></left><right style="medium"><color rgb="FF1D6E55"/></right><top style="medium"><color rgb="FF1D6E55"/></top><bottom style="medium"><color rgb="FF1D6E55"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="9"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="49" fontId="3" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment horizontal="left" vertical="center"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
    var files = [
      { name: "[Content_Types].xml", data: contentTypes },
      { name: "_rels/.rels", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
      { name: "xl/workbook.xml", data: workbook },
      { name: "xl/_rels/workbook.xml.rels", data: workbookRels },
      { name: "xl/styles.xml", data: styles }
    ];
    sheets.forEach(function (sheet, index) { files.push({ name: "xl/worksheets/sheet" + (index + 1) + ".xml", data: xlsxSheet(sheet.rows, sheet.formats || [], sheet.validation, sheet.cellStyles, sheet.columnWidths, sheet.filterRange) }); });
    return xlsxZip(files);
  }

  function zipText(files, name) {
    var bytes = files[name];
    if (!bytes) throw new Error("Excel 中缺少必要文件：" + name);
    return new TextDecoder("utf-8").decode(bytes);
  }

  function xmlDocument(text) {
    var xml = new DOMParser().parseFromString(text, "application/xml");
    if (xml.getElementsByTagName("parsererror").length) throw new Error("Excel 内容无法解析。");
    return xml;
  }

  function xmlLocal(node, name) {
    return Array.prototype.slice.call(node.getElementsByTagName("*")).filter(function (entry) { return entry.localName === name; });
  }

  function columnIndex(reference) {
    var match = /^[A-Za-z]+/.exec(String(reference || ""));
    var letters = match ? match[0].toUpperCase() : "";
    var result = 0;
    for (var i = 0; i < letters.length; i += 1) result = result * 26 + letters.charCodeAt(i) - 64;
    return result - 1;
  }

  function parseImportWorkbook(buffer) {
    if (!window.fflate || !window.fflate.unzipSync) throw new Error("离线 Excel 解析组件未加载。");
    var files = window.fflate.unzipSync(new Uint8Array(buffer));
    var fileNames = Object.keys(files);
    var uncompressedSize = fileNames.reduce(function (sum, name) { return sum + files[name].length; }, 0);
    if (fileNames.length > 200 || uncompressedSize > 25 * 1024 * 1024) throw new Error("Excel 解压后的内容过大或文件过多，请检查后重试。");
    var workbook = xmlDocument(zipText(files, "xl/workbook.xml"));
    var rels = xmlDocument(zipText(files, "xl/_rels/workbook.xml.rels"));
    var relationshipTargets = {};
    xmlLocal(rels, "Relationship").forEach(function (relationship) { relationshipTargets[relationship.getAttribute("Id")] = relationship.getAttribute("Target"); });
    var sheet = xmlLocal(workbook, "sheet").find(function (entry) { return entry.getAttribute("name") === "商品导入"; });
    if (!sheet) throw new Error("Excel 中没有“商品导入”工作表，请使用系统模板。");
    var relationshipId = sheet.getAttribute("r:id") || sheet.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
    var target = relationshipTargets[relationshipId];
    if (!target) throw new Error("无法定位“商品导入”工作表。");
    var sheetPath = target.charAt(0) === "/" ? target.slice(1) : "xl/" + target.replace(/^\.\//, "");
    var sharedStrings = [];
    if (files["xl/sharedStrings.xml"]) {
      xmlLocal(xmlDocument(zipText(files, "xl/sharedStrings.xml")), "si").forEach(function (item) { sharedStrings.push(xmlLocal(item, "t").map(function (node) { return node.textContent; }).join("")); });
    }
    function readRowsBySheetName(name) {
      var namedSheet = xmlLocal(workbook, "sheet").find(function (entry) { return entry.getAttribute("name") === name; });
      if (!namedSheet) return [];
      var relationshipId = namedSheet.getAttribute("r:id") || namedSheet.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
      var target = relationshipTargets[relationshipId];
      if (!target) throw new Error("Cannot locate import history sheet: " + name);
      var path = target.charAt(0) === "/" ? target.slice(1) : "xl/" + target.replace(/^\.\//, "");
      var xml = xmlDocument(zipText(files, path));
      return xmlLocal(xml, "row").map(function (row) {
        var values = [];
        xmlLocal(row, "c").forEach(function (cell) {
          var index = columnIndex(cell.getAttribute("r"));
          var type = cell.getAttribute("t");
          if (xmlLocal(cell, "f")[0]) throw new Error("Import history cannot contain formulas.");
          var valueNode = xmlLocal(cell, "v")[0];
          var inline = xmlLocal(cell, "is")[0];
          var value = inline ? xmlLocal(inline, "t").map(function (node) { return node.textContent; }).join("") : valueNode ? valueNode.textContent : "";
          if (type === "s") value = sharedStrings[Number(value)] || "";
          values[index] = value;
        });
        return values;
      });
    }
    var sheetXml = xmlDocument(zipText(files, sheetPath));
    var productRows = xmlLocal(sheetXml, "row").map(function (row) {
      var values = [];
      xmlLocal(row, "c").forEach(function (cell) {
        var index = columnIndex(cell.getAttribute("r"));
        var type = cell.getAttribute("t");
        var formula = xmlLocal(cell, "f")[0];
        if (formula) throw new Error("模板第 " + row.getAttribute("r") + " 行包含公式，请改为普通值后再导入。");
        var valueNode = xmlLocal(cell, "v")[0];
        var inline = xmlLocal(cell, "is")[0];
        var value = inline ? xmlLocal(inline, "t").map(function (node) { return node.textContent; }).join("") : valueNode ? valueNode.textContent : "";
        if (type === "s") value = sharedStrings[Number(value)] || "";
        if (type === "b") value = value === "1" ? "是" : "否";
        values[index] = value;
      });
      return values;
    });
    return { products: productRows, inbound: readRowsBySheetName("入库历史"), outbound: readRowsBySheetName("出库历史") };
  }

  function readXlsxSheetRows(buffer, sheetName) {
    if (!window.fflate || !window.fflate.unzipSync) throw new Error("离线 Excel 解析组件未加载。");
    var files = window.fflate.unzipSync(new Uint8Array(buffer));
    var fileNames = Object.keys(files);
    var uncompressedSize = fileNames.reduce(function (sum, name) { return sum + files[name].length; }, 0);
    if (fileNames.length > 200 || uncompressedSize > 25 * 1024 * 1024) throw new Error("Excel 解压后的内容过大或文件过多，请检查后重试。");
    var workbook = xmlDocument(zipText(files, "xl/workbook.xml"));
    var rels = xmlDocument(zipText(files, "xl/_rels/workbook.xml.rels"));
    var targets = {};
    xmlLocal(rels, "Relationship").forEach(function (relationship) { targets[relationship.getAttribute("Id")] = relationship.getAttribute("Target"); });
    var sheet = xmlLocal(workbook, "sheet").find(function (entry) { return entry.getAttribute("name") === sheetName; });
    if (!sheet) throw new Error("Excel 中没有“" + sheetName + "”工作表，请使用系统模板。");
    var relationshipId = sheet.getAttribute("r:id") || sheet.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
    var target = targets[relationshipId];
    if (!target) throw new Error("无法定位“" + sheetName + "”工作表。");
    var path = target.charAt(0) === "/" ? target.slice(1) : "xl/" + target.replace(/^\.\//, "");
    var sharedStrings = [];
    if (files["xl/sharedStrings.xml"]) xmlLocal(xmlDocument(zipText(files, "xl/sharedStrings.xml")), "si").forEach(function (item) { sharedStrings.push(xmlLocal(item, "t").map(function (node) { return node.textContent; }).join("")); });
    var xml = xmlDocument(zipText(files, path));
    return xmlLocal(xml, "row").map(function (row) {
      var values = [];
      xmlLocal(row, "c").forEach(function (cell) {
        var index = columnIndex(cell.getAttribute("r"));
        var type = cell.getAttribute("t");
        if (xmlLocal(cell, "f")[0]) throw new Error("“" + sheetName + "”第 " + row.getAttribute("r") + " 行不能包含公式。");
        var valueNode = xmlLocal(cell, "v")[0];
        var inline = xmlLocal(cell, "is")[0];
        var value = inline ? xmlLocal(inline, "t").map(function (node) { return node.textContent; }).join("") : valueNode ? valueNode.textContent : "";
        if (type === "s") value = sharedStrings[Number(value)] || "";
        values[index] = value;
      });
      return values;
    });
  }

  function importHeaders() {
    return ["商品编号", "商品名称", "单位", "最低库存", "期初库存", "期初单价（元）", "默认供应商", "供应状态"];
  }

  function historyHeaders(type) {
    return type === "inbound" ? ["日期", "商品编号", "数量", "单价（元）", "供应商", "供应商单号", "备注"] : ["日期", "商品编号", "数量", "客户", "联系方式", "用途", "备注"];
  }

  function importHistoryDate(value) {
    var textValue = String(value == null ? "" : value).trim();
    if (!/^\d{4}-\d{1,2}-\d{1,2}$/.test(textValue)) return "";
    var parts = textValue.split("-").map(Number);
    var date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    return date.getUTCFullYear() === parts[0] && date.getUTCMonth() === parts[1] - 1 && date.getUTCDate() === parts[2] ? date.toISOString() : "";
  }

  function validateHistoryRows(rows, type, codeSet) {
    if (!rows.length) return [];
    var headers = historyHeaders(type);
    var legacyHeaders = type === "inbound" ? ["日期", "商品编号", "数量", "单价（元）", "供应商"] : ["日期", "商品编号", "数量", "用途"];
    var isLegacy = legacyHeaders.every(function (header, index) { return String(rows[0][index] || "").trim() === header; }) && String(rows[0][legacyHeaders.length] || "").trim() === "";
    if (!isLegacy) for (var h = 0; h < headers.length; h += 1) if (String(rows[0][h] || "").trim() !== headers[h]) throw new Error("“" + (type === "inbound" ? "入库历史" : "出库历史") + "”表头不正确，请重新下载系统模板。");
    return rows.slice(1).map(function (values, index) {
      if (!values.some(function (entry) { return String(entry == null ? "" : entry).trim(); })) return null;
      var date = importHistoryDate(values[0]);
      var code = String(values[1] == null ? "" : values[1]).trim();
      var quantity = Number(values[2]);
      var priceText = type === "inbound" ? String(values[3] == null ? "" : values[3]).trim() : "";
      var price = type === "inbound" ? Math.round(Number(priceText) * 100) : 0;
      var detail = String(values[type === "inbound" ? 4 : (isLegacy ? 3 : 5)] == null ? "" : values[type === "inbound" ? 4 : (isLegacy ? 3 : 5)]).trim();
      var errors = [];
      if (!date) errors.push("日期必须为 yyyy-mm-dd");
      if (!code) errors.push("商品编号必填");
      else if (!codeSet[code.toLowerCase()]) errors.push("商品编号未出现在商品导入表中");
      if (!Number.isSafeInteger(quantity) || quantity <= 0) errors.push("数量必须是大于 0 的整数");
      if (type === "inbound" && (priceText === "" || !Number.isSafeInteger(price) || price < 0)) errors.push("单价必须是非负数字");
      return { row: index + 2, type: type, date: date, code: code, quantity: quantity, price: price, supplier: type === "inbound" ? detail : "", ref: type === "inbound" && !isLegacy ? String(values[5] == null ? "" : values[5]).trim() : "", customer: type === "outbound" && !isLegacy ? String(values[3] == null ? "" : values[3]).trim() : "", contact: type === "outbound" && !isLegacy ? String(values[4] == null ? "" : values[4]).trim() : "", purpose: type === "outbound" ? detail : "", remark: type === "inbound" && !isLegacy ? String(values[6] == null ? "" : values[6]).trim() : type === "outbound" && !isLegacy ? String(values[6] == null ? "" : values[6]).trim() : "", errors: errors };
    }).filter(function (entry) { return !!entry; });
  }

  function validateHistoryInventory(products, histories) {
    var available = Object.create(null);
    products.forEach(function (row) { if (!row.errors.length) available[row.code.toLowerCase()] = row.stock; });
    var entries = histories.inbound.concat(histories.outbound).filter(function (row) { return !row.errors.length; }).sort(function (a, b) {
      var time = a.date.localeCompare(b.date);
      return time || (a.type === "inbound" ? -1 : 1);
    });
    entries.forEach(function (entry) {
      var key = entry.code.toLowerCase();
      if (entry.type === "inbound") {
        available[key] += entry.quantity;
      } else if (entry.quantity > available[key]) {
        entry.errors.push("该日期出库会造成负库存");
      } else {
        available[key] -= entry.quantity;
      }
    });
  }

  function rebuildImportPreview() {
    importPreviewRows = validateImportRows(importRawProductRows);
    var codeSet = Object.create(null);
    importPreviewRows.forEach(function (row) { if (!row.errors.length) codeSet[row.code.toLowerCase()] = true; });
    importHistoryRows = { inbound: validateHistoryRows(importRawHistoryRows.inbound, "inbound", codeSet), outbound: validateHistoryRows(importRawHistoryRows.outbound, "outbound", codeSet) };
    validateHistoryInventory(importPreviewRows, importHistoryRows);
    importHistoryErrors = importHistoryRows.inbound.concat(importHistoryRows.outbound).filter(function (row) { return row.errors.length; });
  }

  function renderImportPreview() {
    document.getElementById("modalHost").innerHTML = '<div class="modal"><div class="modal-card import-modal"><p class="eyebrow">导入前检查</p><h2>商品与历史流水批量导入预览</h2><p class="modal-intro">系统只会新增商品，不会覆盖已有资料；有问题的行可直接修改或删除。</p>' + importPreviewHtml(importPreviewRows, importHistoryRows) + '</div></div>';
  }

  function validateImportRows(rows) {
    var headers = importHeaders();
    if (!rows.length) throw new Error("Excel 中没有数据。");
    for (var h = 0; h < headers.length; h += 1) if (String(rows[0][h] || "").trim() !== headers[h]) throw new Error("表头不正确，请重新下载系统模板填写。");
    var codeSet = {};
    state.products.forEach(function (product) { codeSet[String(product.code || "").toLowerCase()] = true; });
    var prepared = [];
    var nextAuto = null;
    function uniqueAutoCode() {
      var candidate = nextAuto || nextProductCode();
      var prefix = productCodePrefix();
      var match = /(\d+)$/.exec(candidate);
      var number = match ? Number(match[1]) : 1;
      while (codeSet[candidate.toLowerCase()]) { number += 1; candidate = (prefix ? prefix + "-" : "") + String(number).padStart(6, "0"); }
      nextAuto = (prefix ? prefix + "-" : "") + String(number + 1).padStart(6, "0");
      return candidate;
    }
    rows.slice(1).forEach(function (values, index) {
      if (!values.some(function (value) { return String(value == null ? "" : value).trim(); })) return;
      var rowNumber = index + 2;
      var rawCode = String(values[0] == null ? "" : values[0]).trim();
      var code = rawCode || uniqueAutoCode();
      var name = String(values[1] == null ? "" : values[1]).trim();
      var unit = String(values[2] == null ? "" : values[2]).trim();
      var minText = String(values[3] == null ? "" : values[3]).trim();
      var min = Number(minText);
      var stock = String(values[4] == null ? "" : values[4]).trim() === "" ? 0 : Number(values[4]);
      var priceText = String(values[5] == null ? "" : values[5]).trim();
      var price = priceText === "" ? 0 : Math.round(Number(priceText) * 100);
      var supplier = String(values[6] == null ? "" : values[6]).trim();
      var status = String(values[7] == null ? "" : values[7]).trim() || "正常供货";
      var errors = [];
      if (!name) errors.push("商品名称必填");
      if (!unit) errors.push("单位必填");
      if (!minText || !Number.isSafeInteger(min) || min < 0) errors.push("最低库存必须填写非负整数");
      if (!Number.isSafeInteger(stock) || stock < 0) errors.push("期初库存必须是非负整数");
      if (stock > 0 && priceText === "") errors.push("有期初库存时必须填写期初单价");
      if (!Number.isSafeInteger(price) || price < 0) errors.push("期初单价必须是可安全计算的非负数字");
      if (productStatuses().indexOf(status) < 0) errors.push("供应状态无效");
      if (codeSet[code.toLowerCase()]) errors.push("商品编号重复");
      if (!errors.length) codeSet[code.toLowerCase()] = true;
      prepared.push({ row: rowNumber, code: code, name: name, unit: unit, min: min, stock: stock, price: price, supplier: supplier, status: status, errors: errors });
    });
    if (!prepared.length) throw new Error("“商品导入”工作表中没有可导入的商品。");
    if (prepared.length > 2000) throw new Error("一次最多导入 2000 种商品。");
    return prepared;
  }

  function importHistoryIssuesHtml(histories) {
    var entries = histories.inbound.concat(histories.outbound).filter(function (row) { return row.errors.length; });
    if (!entries.length) return "";
    return '<div class="import-history-issues"><strong>历史流水待处理</strong>' + entries.map(function (row) {
      var label = row.type === "inbound" ? "入库历史" : "出库历史";
      return '<div><span>' + esc(label + " 第 " + row.row + " 行：" + row.errors.join("；")) + '</span><button onclick="Warehouse.editImportHistory(\'' + row.type + '\',' + row.row + ')">修改</button><button class="danger" onclick="Warehouse.deleteImportHistory(\'' + row.type + '\',' + row.row + ')">删除该行</button></div>';
    }).join("") + '</div>';
  }

  function importPreviewHtml(rows, histories) {
    var productErrors = rows.reduce(function (sum, row) { return sum + row.errors.length; }, 0);
    var historyErrors = histories.inbound.concat(histories.outbound).reduce(function (sum, row) { return sum + row.errors.length; }, 0);
    var errors = productErrors + historyErrors;
    var historyCount = histories.inbound.length + histories.outbound.length;
    return '<div id="importError"></div><div class="import-summary ' + (errors ? "has-errors" : "ready") + '"><strong>' + (errors ? "发现 " + errors + " 个问题" : "校验通过，可以导入") + '</strong><span>共 ' + rows.length + ' 行商品，' + histories.inbound.length + ' 条入库历史、' + histories.outbound.length + ' 条出库历史；整批导入可一次撤回。</span></div>' + (historyCount ? '<p class="modal-intro">历史流水会按日期顺序写入；无日期的行应折算到期初库存，不会生成流水。</p>' : '') + '<div class="import-preview"><div class="import-head"><span>行</span><span>编号 / 商品</span><span>单位</span><span>最低库存</span><span>期初库存</span><span>供应商</span><span>校验结果 / 操作</span></div>' + rows.map(function (row) { return '<div class="import-row ' + (row.errors.length ? "invalid" : "valid") + '"><span>' + row.row + '</span><span><b>' + esc(row.code) + '</b><small>' + esc(row.name || "未填写") + '</small></span><span>' + esc(row.unit || "—") + '</span><span>' + row.min + '</span><span>' + row.stock + (row.stock ? ' · ' + money(row.price) : "") + '</span><span>' + esc(row.supplier || "未设置") + '</span><span class="import-actions">' + (row.errors.length ? '<b>' + esc(row.errors.join("；")) + '</b><button onclick="Warehouse.editImportProduct(' + row.row + ')">修改</button><button class="danger" onclick="Warehouse.deleteImportProduct(' + row.row + ')">删除该行</button>' : '可导入') + '</span></div>'; }).join("") + '</div>' + importHistoryIssuesHtml(histories) + '<div class="modal-actions"><button class="secondary" onclick="Warehouse.closeModal()">取消</button><button class="primary primary-action" ' + (errors ? "disabled" : "") + ' onclick="Warehouse.commitProductImport()">确认批量导入</button></div>';
  }

  window.Warehouse = {
    go: function (next) {
      page = next;
      if (next === "stocktake") selectedStocktakeProductId = null;
      if (next === "search") globalQuery = "";
      if (next === "inbound" || next === "outbound") {
        documentType = next;
        draftLines = [{ product: "", quantity: "", price: "", remark: "" }];
        draftSupplier = "";
        draftRef = "";
        draftPurpose = "";
        draftCustomer = "";
        draftContact = "";
        draftRemark = "";
      }
      render();
      window.scrollTo(0, 0);
      if (next === "search") setTimeout(function () { var input = document.getElementById("globalSearchInput"); if (input) input.focus(); }, 0);
    },
    showGuide: function () {
      document.getElementById("modalHost").innerHTML = '<div class="modal"><div class="modal-card guide-card"><p class="eyebrow">仓储台使用方法</p><h2>先建商品，再做出入库</h2><div class="guide-steps"><article><b>1</b><div><h3>建立商品资料</h3><p>第一次收到某种商品时，先填写品名、编号、单位、最低库存和默认供应商。</p></div></article><article><b>2</b><div><h3>登记商品入库</h3><p>选择商品，填写数量、实际单价和本次供应商，系统自动增加库存并计算移动平均价。</p></div></article><article><b>3</b><div><h3>登记商品出库</h3><p>选择商品并填写数量和用途；系统按设置中的计价方式记录成本，且绝不允许负库存。</p></div></article></div><div class="modal-actions"><button class="primary" onclick="Warehouse.closeModal()">知道了</button></div></div></div>';
    },
    closeToast: function (button) {
      var node = button && button.closest ? button.closest(".success") : document.querySelector(".success");
      if (!node) return;
      clearTimeout(toastTimer);
      clearTimeout(toastRemoveTimer);
      node.classList.add("hide");
      toastRemoveTimer = setTimeout(function () { node.remove(); }, 250);
    },
    setFontScale: function (value) {
      if (Number(state.settings.fontScale) === Number(value)) return;
      recordUndo("调整字体为 " + Math.round(Number(value) * 100) + "%");
      state.settings.fontScale = Number(value);
      applyFontScale();
      save();
      render();
      toast("全局显示大小已调整为 " + Math.round(Number(value) * 100) + "%");
    },
    setCostMethod: function (method) {
      if (["weighted", "fifo", "lastInbound"].indexOf(method) < 0 || state.settings.costMethod === method) return;
      recordUndo("调整出库计价方式为 " + costMethodLabel(method));
      state.settings.costMethod = method;
      save();
      render();
      toast("之后的出库将使用：" + costMethodLabel(method));
    },
    previewStatusDefinition: function (input) {
      var row = input && input.closest ? input.closest(".status-definition-row") : null;
      if (!row) return;
      var name = row.querySelector(".status-definition-name").value.trim() || "新建状态";
      var color = row.querySelector(".status-definition-color").value;
      var swatch = row.querySelector(".status-color-preview");
      var sample = row.querySelector(".status-definition-sample");
      if (swatch) swatch.style.background = color;
      if (sample) { sample.textContent = name; sample.style.setProperty("--status-color", color); sample.style.setProperty("--status-fill", statusFill(color)); }
    },
    addStatusDefinition: function () {
      var list = document.getElementById("statusDefinitionList");
      if (!list) return;
      list.insertAdjacentHTML("beforeend", statusDefinitionRow({ name: "", color: "#4CA7FE" }));
      var input = list.lastElementChild && list.lastElementChild.querySelector(".status-definition-name");
      if (input) input.focus();
    },
    removeStatusDefinition: function (button) {
      var row = button && button.closest ? button.closest(".status-definition-row") : null;
      if (!row || row.getAttribute("data-system") === "true") return;
      row.remove();
    },
    saveStatusDefinitions: function () {
      var rows = Array.prototype.slice.call(document.querySelectorAll("#statusDefinitionList .status-definition-row"));
      var fields = [];
      var names = Object.create(null);
      var definitions = [];
      var error = "";
      rows.forEach(function (row) {
        var nameInput = row.querySelector(".status-definition-name");
        var colorInput = row.querySelector(".status-definition-color");
        var name = String(nameInput.value || "").trim();
        var color = String(colorInput.value || "").trim();
        if (!name || name.length > 20) { error = "每个商品状态都需要填写 1 至 20 个字符的名称。"; fields.push(nameInput); return; }
        if (names[name]) { error = "商品状态名称不能重复：" + name; fields.push(nameInput); return; }
        if (!validStatusColor(color)) { error = "请选择有效的状态颜色。"; fields.push(colorInput); return; }
        names[name] = true;
        definitions.push({ name: name, color: color, system: name === "新增待盘点" });
      });
      if (!definitions.length) error = "请至少保留一个商品状态。";
      if (!definitions.some(function (item) { return item.name === "新增待盘点"; })) error = "“新增待盘点”用于自动盘点，必须保留。";
      if (error) { flashFields(fields); return errorAt("statusDefinitionError", error); }
      if (JSON.stringify(definitions) === JSON.stringify(statusDefinitions())) return toast("商品状态没有变化。");
      recordUndo("修改商品状态与颜色");
      state.settings.statuses = definitions;
      var allowed = productStatuses();
      var fallback = normalSupplyStatus();
      state.products.forEach(function (product) { if (allowed.indexOf(product.status) < 0) product.status = fallback; });
      save();
      render();
      toast("商品状态与显示颜色已保存。");
    },
    productCodePrefixEnter: function (event) {
      if (event.key !== "Enter") return;
      event.preventDefault();
      window.Warehouse.saveProductCodePrefix();
    },
    clearProductCodePrefix: function () {
      var input = document.getElementById("productCodePrefix");
      if (!input) return;
      input.value = "";
      input.focus();
    },
    saveProductCodePrefix: function () {
      var input = document.getElementById("productCodePrefix");
      if (!input) return;
      var prefix = input.value.trim();
      if (prefix.length > 20 || !/^[A-Za-z\u3400-\u9fff]*$/.test(prefix)) {
        flashFields([input]);
        return errorAt("prefixError", "前缀只能填写英文或中文，最多 20 个字符；也可以留空表示无前缀。");
      }
      if (prefix === productCodePrefix()) return toast("商品编号前缀没有变化。");
      recordUndo("修改商品编号前缀");
      state.settings.productCodePrefix = prefix;
      save();
      render();
      toast("商品编号前缀已改为：" + (prefix || "无前缀"));
    },
    nextOnEnter: function (event) {
      if (event.key !== "Enter") return;
      event.preventDefault();
      var inDocumentForm = event.target.closest && event.target.closest(".form");
      var selector = inDocumentForm ? ".form input:not([disabled]), .form select:not([disabled])" : ".modal-card input:not([disabled]), .modal-card select:not([disabled])";
      var fields = Array.prototype.slice.call(document.querySelectorAll(selector)).filter(function (field) { return field.offsetParent !== null; });
      var index = fields.indexOf(event.target);
      if (index >= 0 && fields[index + 1]) {
        setTimeout(function () { fields[index + 1].focus(); }, 0);
      } else if (index >= 0 && inDocumentForm && (page === "inbound" || page === "outbound")) {
        window.Warehouse.submitDocument();
      } else if (index >= 0 && !inDocumentForm && pendingProductLine !== null && page === "inbound") {
        window.Warehouse.addProduct();
      }
    },
    productModalEnter: function (event) {
      if (event.key !== "Enter") return;
      event.preventDefault();
      if (event.stopPropagation) event.stopPropagation();
      window.Warehouse.addProduct();
    },
    clearProductCode: function () {
      var input = document.getElementById("newCode");
      if (!input) return;
      input.value = "";
      input.focus();
    },
    undoLast: function () {
      if (!state.undoHistory.length) return;
      var entry = state.undoHistory.pop();
      var remainingHistory = state.undoHistory;
      state = normalizeState({
        version: 1,
        products: clone(entry.snapshot.products),
        documents: clone(entry.snapshot.documents),
        recipes: clone(entry.snapshot.recipes || []),
        settings: clone(entry.snapshot.settings),
        undoHistory: remainingHistory
      });
      applyFontScale();
      save();
      render();
      toast("已撤回：" + entry.label);
    },
    filterInventory: function (query) {
      var term = String(query || "").toLowerCase();
      var source = activeProducts();
      if (selectedInventorySupplier) source = source.filter(function (p) { return (p.supplier || "未设置供应商") === selectedInventorySupplier; });
      var filtered = source.filter(function (p) { return (p.code + " " + p.name + " " + p.supplier).toLowerCase().indexOf(term) >= 0; });
      document.getElementById("inventoryTable").innerHTML = inventoryTable(filtered, false);
    },
    toggleInventorySupplierGrouping: function () {
      var next = state.settings.inventorySupplierGrouping !== true;
      state.settings.inventorySupplierGrouping = next;
      selectedInventorySupplier = "";
      save();
      render();
      toast(next ? "已开启库存按供应商分类。" : "已关闭库存按供应商分类。");
    },
    openInventorySupplier: function (supplier) {
      selectedInventorySupplier = String(supplier || "未设置供应商");
      render();
      window.scrollTo(0, 0);
    },
    clearInventorySupplier: function () {
      selectedInventorySupplier = "";
      render();
    },
    openProductHistory: function (id) {
      selectedProductId = id;
      page = "product-history";
      render();
      window.scrollTo(0, 0);
    },
    openInventoryProductKey: function (event, id) {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      var product = productById(id);
      if (product && product.status === "新增待盘点") window.Warehouse.openPendingStocktake(id);
      else window.Warehouse.openProductHistory(id);
    },
    openPendingStocktake: function (id) {
      var product = productById(id);
      if (!product || product.archived || product.status !== "新增待盘点") return;
      selectedStocktakeProductId = id;
      page = "stocktake";
      render();
      window.scrollTo(0, 0);
      setTimeout(function () {
        var input = document.querySelector("[data-pending-stocktake]");
        if (!input) return;
        input.focus();
        input.select();
      }, 0);
    },
    openRecipe: function (id) {
      if (!recipeById(id)) return;
      selectedRecipeId = id;
      page = "recipe-detail";
      render();
      window.scrollTo(0, 0);
    },
    downloadRecipeTemplate: function () {
      var instructions = [["一键配料导入说明", "内容"], ["一份模板", "只对应一款产品。请在“配方导入”右侧第 4 行加粗的产品名称输入框填写产品名称，再从左上角开始填写全部配件。"], ["配件品类、每件用量", "必填。配件品类可从下拉提示中选择，也可自由输入新商品；每件用量必须为大于 0 的整数。"], ["货架位置（选填）、供应商（选填）、备注（选填）", "均为选填；会保存在该产品配方的配件明细中，列顺序不可调整。"], ["自动建档", "库存中没有的配件品类会在导入时自动新建商品资料，状态设为“新增待盘点”。"], ["下单扣减", "一键配料下单时，系统会按下单数量 × 每件用量扣减所有配件；任一配件不足都会阻止下单。"]];
      var recipeTemplateRows = [recipeImportHeaders().concat(["", "", ""]), [], [], ["", "", "", "", "", "", "产品名称", ""]];
      var componentReference = [["商品编号", "商品名称", "当前库存", "单位", "默认供应商"]].concat(activeProducts().map(function (product) { return [product.code, product.name, product.stock, product.unit, product.supplier || ""]; }));
      var referenceEndRow = Math.max(2, componentReference.length);
      download("仓储台-一键配料导入模板.xlsx", createXlsx([{ name: "填写说明", rows: instructions, formats: ["text", "text"] }, { name: "配方导入", rows: recipeTemplateRows, formats: ["text", "integer", "text", "text", "text", "text", "text", "text"], cellStyles: { "3:6": 7, "3:7": 8 }, columnWidths: [22, 14, 20, 20, 28, 4, 16, 32], filterRange: "A1:E1", validation: { sqref: "A2:A501", formula: "RecipeComponentNames", allowCustom: true } }, { name: "库存配件参考", rows: componentReference, formats: ["text", "text", "integer", "text", "text"], hidden: true, definedName: "RecipeComponentNames", definedRange: "'库存配件参考'!$B$2:$B$" + referenceEndRow }]), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      toast("一键配料导入模板已下载，可自由填写新的配件品类。 ");
    },
    previewRecipeImport: function (file) {
      if (!file) return;
      if (!/\.xlsx$/i.test(file.name || "")) return alert("请选择系统模板格式的 .xlsx 文件。");
      if (file.size > 5 * 1024 * 1024) return alert("导入文件不能超过 5MB。");
      var reader = new FileReader();
      reader.onload = function () {
        try {
          recipeImportRows = readXlsxSheetRows(reader.result, "配方导入");
          recipeImportPreview = validateRecipeImportRows(recipeImportRows);
          document.getElementById("modalHost").innerHTML = '<div class="modal"><div class="modal-card import-modal"><p class="eyebrow">配方导入前检查</p><h2>产品配件结构预览</h2><p class="modal-intro">未出现在库存中的配件会自动建立商品资料，状态为“新增待盘点”。</p>' + recipeImportPreviewHtml(recipeImportPreview) + '</div></div>';
        } catch (error) {
          recipeImportRows = [];
          recipeImportPreview = [];
          alert("无法导入：" + error.message);
        }
      };
      reader.onerror = function () { alert("无法读取所选 Excel 文件。"); };
      reader.readAsArrayBuffer(file);
    },
    commitRecipeImport: function () {
      if (!recipeImportPreview.length || recipeImportPreview.some(function (row) { return row.errors.length; })) return;
      var duplicate = recipeImportPreview.find(function (row) { return state.recipes.some(function (recipe) { return recipe.name.toLowerCase() === row.productName.toLowerCase(); }); });
      if (duplicate) return errorAt("recipeImportError", "产品“" + duplicate.productName + "”的配方已经存在，请进入详情修改。 ");
      recordUndo("Excel 导入 " + Object.keys(recipeImportPreview.reduce(function (items, row) { items[row.productName] = true; return items; }, {})).length + " 款产品配方");
      var createdProducts = 0;
      var componentsByProductName = Object.create(null);
      recipeImportPreview.forEach(function (row) {
        var component = activeProducts().find(function (product) { var name = product.name.toLowerCase(); var code = product.code.toLowerCase(); var value = row.componentName.toLowerCase(); return name === value || code === value || (product.code + " · " + product.name).toLowerCase() === value; });
        if (!component) {
          component = { id: uid("p"), code: nextProductCode(), name: row.componentName, unit: "件", status: "新增待盘点", min: 0, stock: 0, avg: 0, supplier: row.supplier, createdAt: now() };
          state.products.push(component);
          createdProducts += 1;
        }
        if (!componentsByProductName[row.productName]) componentsByProductName[row.productName] = [];
        componentsByProductName[row.productName].push({ productId: component.id, quantity: row.quantity, supplier: row.supplier, remark: row.remark, shelfLocation: row.shelfLocation });
      });
      Object.keys(componentsByProductName).forEach(function (productName) { state.recipes.push({ id: uid("recipe"), name: productName, components: componentsByProductName[productName], createdAt: now(), updatedAt: now() }); });
      var count = Object.keys(componentsByProductName).length;
      window.Warehouse.closeModal();
      save();
      page = "recipes";
      render();
      toast("已导入 " + count + " 款产品配方" + (createdProducts ? "，并新增 " + createdProducts + " 个待盘点配件" : "") + "。 ");
    },
    editRecipe: function (id) {
      var recipe = recipeById(id);
      if (!recipe) return;
      recipeDraft = { id: recipe.id, name: recipe.name, components: recipe.components.map(function (component) { var product = recipeComponentProduct(component); return { product: product ? product.code + " · " + product.name : "", quantity: component.quantity, supplier: component.supplier, remark: component.remark, shelfLocation: component.shelfLocation }; }) };
      renderRecipeEditModal();
    },
    newRecipe: function () {
      recipeDraft = { id: "", name: "", components: [{ product: "", quantity: "", shelfLocation: "", supplier: "", remark: "" }] };
      renderRecipeEditModal();
    },
    addRecipeDraftComponent: function () {
      if (!recipeDraft) return;
      recipeDraft.components.push({ product: "", quantity: "", supplier: "", remark: "", shelfLocation: "" });
      renderRecipeEditModal();
    },
    removeRecipeDraftComponent: function (index) {
      if (!recipeDraft || recipeDraft.components.length <= 1) return;
      recipeDraft.components.splice(index, 1);
      renderRecipeEditModal();
    },
    saveRecipeDraft: function () {
      if (!recipeDraft) return;
      var nameInput = document.getElementById("recipeDraftName");
      var rowNodes = Array.prototype.slice.call(document.querySelectorAll(".recipe-edit-row"));
      var name = nameInput ? nameInput.value.trim() : "";
      var missing = [];
      if (!name) missing.push(nameInput);
      var parsed = rowNodes.map(function (row) {
        var fields = {};
        Array.prototype.slice.call(row.querySelectorAll("[data-field]")).forEach(function (input) { fields[input.dataset.field] = input; });
        var productText = fields.product.value.trim();
        var quantity = Number(fields.quantity.value);
        if (!productText) missing.push(fields.product);
        if (!fields.quantity.value.trim() || !Number.isSafeInteger(quantity) || quantity <= 0) missing.push(fields.quantity);
        return { fields: fields, productText: productText, quantity: quantity };
      });
      if (missing.length) { flashFields(missing); return errorAt("recipeEditError", "请填写所有红色闪烁的产品名称、配件品类和每件用量。 "); }
      if (state.recipes.some(function (recipe) { return recipe.id !== recipeDraft.id && recipe.name.toLowerCase() === name.toLowerCase(); })) return errorAt("recipeEditError", "已有同名产品配方，请修改产品名称。 ");
      var componentIds = {};
      for (var checkIndex = 0; checkIndex < parsed.length; checkIndex += 1) {
        var checkEntry = parsed[checkIndex];
        var foundProduct = productFromText(checkEntry.productText);
        var componentKey = foundProduct ? foundProduct.id : "new:" + checkEntry.productText.toLowerCase();
        if (componentIds[componentKey]) { flashFields([checkEntry.fields.product]); return errorAt("recipeEditError", "同一产品配方不能重复填写同一种配件。 "); }
        componentIds[componentKey] = true;
      }
      recordUndo((recipeDraft.id ? "修改" : "新增") + "产品配方：" + name);
      componentIds = {};
      var autoCreated = 0;
      var components = [];
      for (var index = 0; index < parsed.length; index += 1) {
        var entry = parsed[index];
        var product = productFromText(entry.productText);
        if (!product) {
          product = { id: uid("p"), code: nextProductCode(), name: entry.productText, unit: "件", status: "新增待盘点", min: 0, stock: 0, avg: 0, supplier: entry.fields.supplier.value.trim(), createdAt: now() };
          state.products.push(product);
          autoCreated += 1;
        }
        componentIds[product.id] = true;
        components.push({ productId: product.id, quantity: entry.quantity, supplier: entry.fields.supplier.value.trim(), remark: entry.fields.remark.value.trim(), shelfLocation: entry.fields.shelfLocation.value.trim() });
      }
      var recipe = recipeById(recipeDraft.id);
      if (!recipe) {
        recipe = { id: uid("recipe"), name: "", components: [], createdAt: now(), updatedAt: now() };
        state.recipes.push(recipe);
      }
      recipe.name = name;
      recipe.components = components;
      recipe.updatedAt = now();
      selectedRecipeId = recipe.id;
      window.Warehouse.closeModal();
      save();
      render();
      toast("配方已保存" + (autoCreated ? "，并新增 " + autoCreated + " 个待盘点配件" : "") + "。 ");
    },
    recipeOrderEnter: function (event) {
      if (event.key !== "Enter") return;
      event.preventDefault();
      if (selectedRecipeId) window.Warehouse.placeRecipeOrder(selectedRecipeId);
    },
    placeRecipeOrder: function (id) {
      var recipe = recipeById(id);
      var quantityInput = document.getElementById("recipeOrderQuantity");
      var orderQuantity = Number(quantityInput && quantityInput.value);
      if (!recipe || !quantityInput || !quantityInput.value.trim() || !Number.isSafeInteger(orderQuantity) || orderQuantity <= 0) { flashFields([quantityInput]); return errorAt("recipeOrderError", "下单产品数量必须是大于 0 的整数。 "); }
      var requirements = {};
      for (var index = 0; index < recipe.components.length; index += 1) {
        var component = recipe.components[index];
        var product = recipeComponentProduct(component);
        var required = component.quantity * orderQuantity;
        if (!product || !Number.isSafeInteger(required) || required <= 0) return errorAt("recipeOrderError", "配方中存在无效或已移除的配件，请先编辑配方。 ");
        if (!requirements[product.id]) requirements[product.id] = { product: product, quantity: 0, component: component };
        requirements[product.id].quantity += required;
      }
      var shortage = Object.keys(requirements).map(function (key) { return requirements[key]; }).find(function (entry) { return entry.quantity > entry.product.stock; });
      if (shortage) { flashFields([quantityInput]); return errorAt("recipeOrderError", shortage.product.name + "库存只有 " + shortage.product.stock + shortage.product.unit + "，本次配料需要 " + shortage.quantity + shortage.product.unit + "。 "); }
      recordUndo("一键配料下单：" + recipe.name + " × " + orderQuantity);
      var items = Object.keys(requirements).map(function (key) {
        var entry = requirements[key];
        var before = entry.product.stock;
        var cost = outboundUnitCost(entry.product, entry.quantity);
        entry.product.stock = before - entry.quantity;
        if (!entry.product.stock) entry.product.avg = 0;
        return { productId: entry.product.id, quantity: entry.quantity, price: 0, cost: cost, remark: entry.component.remark || "", supplier: entry.component.supplier || "", shelfLocation: entry.component.shelfLocation || "", before: before, after: entry.product.stock };
      });
      var no = "PL-OFF-" + String(state.documents.length + 1).padStart(4, "0");
      state.documents.unshift({ id: uid("d"), no: no, type: "assembly", purpose: "一键配料下单：" + recipe.name + " × " + orderQuantity, supplier: "", ref: "", customer: "", contact: "", remark: "", recipeId: recipe.id, recipeName: recipe.name, orderQuantity: orderQuantity, costMethod: state.settings.costMethod || "weighted", at: now(), operator: "离线管理员", items: items });
      save();
      render();
      toast({ title: "一键配料下单成功", no: no, products: recipe.name, quantity: "下单 " + orderQuantity + " 件 · 扣减 " + items.length + " 种配件", detail: "已按配方自动扣减库存 · " + costMethodLabel(state.settings.costMethod) });
    },
    updateProductStatus: function (id, value) {
      var product = productById(id);
      if (!product || product.archived || productStatuses().indexOf(value) < 0 || product.status === value) return;
      recordUndo("修改商品状态：" + product.name);
      product.status = value;
      save();
      render();
      toast("已更新“" + product.name + "”状态：" + value);
    },
    toggleSupplierGrouping: function () {
      var next = state.settings.supplierGrouping !== true;
      recordUndo((next ? "开启" : "关闭") + "商品资料供应商分类");
      state.settings.supplierGrouping = next;
      save();
      render();
      toast(next ? "已开启按供应商分类，点击供应商可查看其全部商品。" : "已关闭按供应商分类。");
    },
    openSupplierProducts: function (supplier) {
      selectedSupplier = String(supplier || "未设置供应商");
      page = "supplier-products";
      render();
      window.scrollTo(0, 0);
    },
    productMinimumModal: function (id) {
      var product = productById(id);
      if (!product || product.archived) return;
      document.getElementById("modalHost").innerHTML = '<div class="modal"><div class="modal-card limits-modal"><p class="eyebrow">库存提醒规则</p><h2>' + esc(product.name) + '</h2><p class="modal-intro">库存低于或等于最低库存时，会显示在补货提醒中。</p><div class="modal-grid"><label class="field"><span>最低库存 *</span><input id="limitMin" type="number" min="0" step="1" value="' + product.min + '"></label></div><div id="limitError"></div><div class="modal-actions"><button class="secondary" onclick="Warehouse.closeModal()">取消</button><button class="primary" onclick="Warehouse.saveProductMinimum(\'' + esc(product.id) + '\')">保存最低库存</button></div></div></div>';
    },
    saveProductMinimum: function (id) {
      var product = productById(id);
      var minInput = document.getElementById("limitMin");
      if (!product || !minInput) return;
      var min = Number(minInput.value);
      if (!minInput.value.trim() || !Number.isSafeInteger(min) || min < 0) {
        flashFields([minInput]);
        return errorAt("limitError", "最低库存必须填写非负整数。");
      }
      if (product.min === min) return window.Warehouse.closeModal();
      recordUndo("修改最低库存：" + product.name);
      product.min = min;
      save();
      window.Warehouse.closeModal();
      render();
      toast("已更新“" + product.name + "”最低库存。");
    },
    globalSearch: function (value) {
      globalQuery = value;
      var host = document.getElementById("globalSearchResults");
      if (host) host.innerHTML = globalSearchResults(value);
    },
    clearGlobalSearch: function () {
      globalQuery = "";
      var input = document.getElementById("globalSearchInput");
      if (input) { input.value = ""; input.focus(); }
      var host = document.getElementById("globalSearchResults");
      if (host) host.innerHTML = globalSearchResults("");
    },
    startProductDocument: function (type, id) {
      var product = productById(id);
      if (!product || product.archived || (type !== "inbound" && type !== "outbound")) return;
      page = type;
      documentType = type;
      draftLines = [{ product: product.code + " · " + product.name, quantity: "", price: type === "inbound" && lastInboundPrice(product.id) !== null ? (lastInboundPrice(product.id) / 100).toFixed(2) : "", remark: "" }];
      draftSupplier = type === "inbound" ? product.supplier : "";
      draftRef = "";
      draftPurpose = "";
      render();
      window.scrollTo(0, 0);
      setTimeout(function () { var row = document.querySelector(".doc-line"); var input = row && row.querySelector("[data-field=quantity]"); if (input) input.focus(); }, 0);
    },
    removeProduct: function (id) {
      var product = productById(id);
      if (!product || product.archived) return;
      if (product.stock === 0) {
        if (!confirm("确定移除“" + product.name + "”吗？历史出入库记录仍会保留。")) return;
        recordUndo("移除商品：" + product.name);
        product.archived = true;
        product.status = "已移除";
        save();
        render();
        return toast("已移除零库存商品：" + product.name);
      }
      if (!confirm("“" + product.name + "”当前还有 " + product.stock + product.unit + "。继续将把库存清空为 0 并移除商品，是否继续？")) return;
      if (!confirm("二次确认：确定清空并移除“" + product.name + "”吗？此操作会生成库存清空记录。")) return;
      recordUndo("清空并移除商品：" + product.name);
      var before = product.stock;
      var oldAverage = product.avg;
      product.stock = 0;
      product.avg = 0;
      product.archived = true;
      product.status = "已移除";
      state.documents.unshift({
        id: uid("d"),
        no: "PD-OFF-" + String(state.documents.length + 1).padStart(4, "0"),
        type: "stocktake",
        purpose: "清空库存并移除商品",
        supplier: "",
        ref: "",
        at: now(),
        operator: "离线管理员",
        items: [{ productId: product.id, quantity: -before, counted: 0, price: 0, cost: oldAverage, before: before, after: 0 }]
      });
      save();
      render();
      toast("已清空库存并移除商品：" + product.name);
    },
    addLine: function () {
      collectDraftLines();
      collectDraftMeta();
      draftLines.push({ product: "", quantity: "", price: "", remark: "" });
      render();
    },
    removeLine: function (index) {
      collectDraftLines();
      collectDraftMeta();
      if (draftLines.length > 1) draftLines.splice(index, 1);
      render();
    },
    syncLine: function (input) {
      var p = productFromText(input.value);
      if (p) input.value = p.code + " · " + p.name;
      var row = input.closest(".line");
      row.querySelector(".stock").textContent = p ? p.stock + p.unit : "—";
      var priceInput = row.querySelector("[data-field=price]");
      if (p && documentType === "inbound" && priceInput) {
        var previousPrice = lastInboundPrice(p.id);
        if (previousPrice !== null) priceInput.value = (previousPrice / 100).toFixed(2);
        var supplierInput = document.getElementById("docSupplier");
        if (supplierInput && !supplierInput.value.trim() && p.supplier) {
          supplierInput.value = p.supplier;
          draftSupplier = p.supplier;
        }
      }
    },
    clearDocumentSupplier: function () {
      var input = document.getElementById("docSupplier");
      draftSupplier = "";
      if (input) { input.value = ""; input.focus(); }
    },
    ignorePurpose: function () {
      window.Warehouse.submitDocument(true);
    },
    submitDocument: function (ignorePurpose) {
      collectDraftLines();
      collectDraftMeta();
      var supplierInput = documentType === "inbound" ? document.getElementById("docSupplier") : null;
      var purposeInput = documentType === "outbound" ? document.getElementById("docPurpose") : null;
      var customerInput = documentType === "outbound" ? document.getElementById("docCustomer") : null;
      var contactInput = documentType === "outbound" ? document.getElementById("docContact") : null;
      var remarkInput = document.getElementById("docRemark");
      var rowNodes = Array.prototype.slice.call(document.querySelectorAll(".doc-line"));
      var missingFields = [];
      rowNodes.forEach(function (row) {
        var productField = row.querySelector("[data-field=product]");
        var quantityField = row.querySelector("[data-field=quantity]");
        var priceField = row.querySelector("[data-field=price]");
        if (!productField.value.trim()) missingFields.push(productField);
        if (!quantityField.value.trim()) missingFields.push(quantityField);
        if (documentType === "inbound" && priceField && !priceField.value.trim()) missingFields.push(priceField);
      });
      if (missingFields.length) {
        flashFields(missingFields);
        return errorAt("docError", "请填写所有红色闪烁的必填项目。");
      }
      var parsed = [];
      for (var i = 0; i < draftLines.length; i += 1) {
        var line = draftLines[i];
        var rowNode = rowNodes[i];
        var productInput = rowNode ? rowNode.querySelector("[data-field=product]") : null;
        var quantityInput = rowNode ? rowNode.querySelector("[data-field=quantity]") : null;
        var priceInput = rowNode ? rowNode.querySelector("[data-field=price]") : null;
        var lineRemarkInput = rowNode ? rowNode.querySelector("[data-field=lineRemark]") : null;
        var p = productFromText(line.product);
        var quantity = Number(line.quantity);
        var price = Math.round(Number(line.price || 0) * 100);
        if (!String(line.product || "").trim()) {
          flashFields([productInput]);
          return errorAt("docError", "请填写第 " + (i + 1) + " 行商品。");
        }
        if (!p && documentType === "inbound") {
          pendingProductLine = i;
          window.Warehouse.productModal({ source: "inbound", text: line.product, supplier: supplierInput ? supplierInput.value.trim() : "" });
          return;
        }
        if (!p) {
          flashFields([productInput]);
          return errorAt("docError", "第 " + (i + 1) + " 行没有找到对应商品，请从联想列表选择。");
        }
        if (!String(line.quantity || "").trim() || !Number.isSafeInteger(quantity) || quantity <= 0) {
          flashFields([quantityInput]);
          return errorAt("docError", "第 " + (i + 1) + " 行数量必须是大于 0 的整数。");
        }
        if (documentType === "inbound" && (!String(line.price || "").trim() || !Number.isSafeInteger(price) || price < 0)) {
          flashFields([priceInput]);
          return errorAt("docError", "请填写第 " + (i + 1) + " 行实际单价，可填写 0。");
        }
        if (documentType === "outbound" && quantity > p.stock) {
          flashFields([quantityInput]);
          return errorAt("docError", p.name + "库存只有 " + p.stock + p.unit + "，最大可出库 " + p.stock + p.unit + "。");
        }
        if (parsed.some(function (entry) { return entry.product.id === p.id; })) {
          flashFields([productInput]);
          return errorAt("docError", "同一张单据不能重复添加同一种商品。");
        }
        parsed.push({ product: p, quantity: quantity, price: price, remark: String(line.remark || "").trim() });
      }
      var docId = uid("d");
      recordUndo((documentType === "inbound" ? "商品入库：" : "商品出库：") + parsed.map(function (entry) { return entry.product.name; }).join("、"));
      var items = parsed.map(function (entry) {
        var p = entry.product;
        var before = p.stock;
        var oldAverage = p.avg;
        var selectedCost = documentType === "inbound" ? entry.price : outboundUnitCost(p, entry.quantity);
        var after = documentType === "inbound" ? before + entry.quantity : before - entry.quantity;
        if (documentType === "inbound") p.avg = after ? Math.round((before * oldAverage + entry.quantity * entry.price) / after) : 0;
        else if (after === 0) p.avg = 0;
        p.stock = after;
        return { productId: p.id, quantity: entry.quantity, price: documentType === "inbound" ? entry.price : 0, cost: selectedCost, remark: documentType === "inbound" ? entry.remark : "", before: before, after: after };
      });
      var count = state.documents.length + 1;
      var no = (documentType === "inbound" ? "RK" : "CK") + "-OFF-" + String(count).padStart(4, "0");
      var purpose = documentType === "inbound" ? "采购入库" : (purposeInput && purposeInput.value.trim() || "未填写用途");
      var completedDocument = { id: docId, no: no, type: documentType, purpose: purpose, supplier: supplierInput ? supplierInput.value.trim() : "", ref: documentType === "inbound" ? document.getElementById("docRef").value.trim() : "", customer: customerInput ? customerInput.value.trim() : "", contact: contactInput ? contactInput.value.trim() : "", remark: remarkInput ? remarkInput.value.trim() : "", costMethod: documentType === "outbound" ? (state.settings.costMethod || "weighted") : "", at: now(), operator: "离线管理员", items: items };
      state.documents.unshift(completedDocument);
      save();
      draftLines = [{ product: "", quantity: "", price: "", remark: "" }];
      draftSupplier = "";
      draftRef = "";
      draftPurpose = "";
      draftCustomer = "";
      draftContact = "";
      draftRemark = "";
      page = "home";
      render();
      toast({
        title: documentType === "inbound" ? "入库登记成功" : "出库登记成功",
        no: no,
        products: parsed.map(function (entry) { return entry.product.name; }).join("、"),
        quantity: "共 " + parsed.reduce(function (sum, entry) { return sum + entry.quantity; }, 0) + " 件",
        detail: documentType === "inbound" ? (completedDocument.supplier || "未填写供应商") : (completedDocument.purpose + " · " + costMethodLabel(completedDocument.costMethod) + " · 出库成本 " + money(items.reduce(function (sum, line) { return sum + Math.abs(line.quantity) * line.cost; }, 0)))
      });
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
        if (!Number.isSafeInteger(counted) || counted < 0) return errorAt("stockError", "实盘数量必须是大于或等于 0 的安全整数。");
        var p = productById(rows[i].dataset.product);
        if (counted !== p.stock || p.status === "新增待盘点") changed.push({ product: p, counted: counted });
      }
      if (!changed.length) return errorAt("stockError", "请至少填写一项有库存差异或“新增待盘点”的商品实盘数量。");
      recordUndo("库存盘点：" + changed.map(function (entry) { return entry.product.name; }).join("、"));
      var confirmedPending = 0;
      var items = changed.map(function (entry) { var before = entry.product.stock; var wasPending = entry.product.status === "新增待盘点"; entry.product.stock = entry.counted; if (wasPending) { entry.product.status = "正常供货"; confirmedPending += 1; } return { productId: entry.product.id, quantity: entry.counted - before, counted: entry.counted, price: 0, cost: entry.product.avg, before: before, after: entry.counted }; });
      var no = "PD-OFF-" + String(state.documents.length + 1).padStart(4, "0");
      state.documents.unshift({ id: uid("d"), no: no, type: "stocktake", purpose: document.getElementById("stocktakePurpose").value.trim() || "离线盘点", supplier: "", ref: "", at: now(), operator: "离线管理员", items: items });
      save();
      selectedStocktakeProductId = null;
      page = "home";
      render();
      toast("盘点完成：" + no + (confirmedPending ? "，已确认 " + confirmedPending + " 个待盘点商品" : ""));
    },
    setPeriod: function (value) { period = value; render(); },
    openPicker: function (input) {
      if (!input) return;
      input.focus();
      if (typeof input.showPicker === "function") {
        try { input.showPicker(); } catch (error) { /* Older browsers keep the focused native input. */ }
      }
    },
    setReportDate: function (value) {
      if (!value) return;
      var parts = String(value).split("-").map(Number);
      if (period === "day" && parts.length === 3) {
        reportTarget.year = parts[0]; reportTarget.month = parts[1]; reportTarget.day = parts[2];
      } else if (period === "month" && parts.length === 2) {
        reportTarget.year = parts[0]; reportTarget.month = parts[1];
      } else if (period === "year") {
        var year = Number(value);
        if (!Number.isInteger(year) || year < 1900 || year > 2100) return;
        reportTarget.year = year;
      }
      clampReportDay();
      render();
    },
    setHistoryFilter: function (value) {
      historyFilter = ["all", "inbound", "outbound"].indexOf(value) >= 0 ? value : "all";
      render();
    },
    setHistorySort: function (value) {
      historySort = value === "asc" ? "asc" : "desc";
      render();
    },
    deleteImportProduct: function (rowNumber) {
      var index = Number(rowNumber) - 1;
      if (index < 1 || index >= importRawProductRows.length) return;
      importRawProductRows.splice(index, 1);
      try { rebuildImportPreview(); renderImportPreview(); } catch (error) { errorAt("importError", error.message); }
    },
    editImportProduct: function (rowNumber) {
      var index = Number(rowNumber) - 1;
      var values = importRawProductRows[index];
      if (!values) return;
      document.getElementById("modalHost").innerHTML = '<div class="modal"><div class="modal-card"><p class="eyebrow">修改导入行</p><h2>第 ' + rowNumber + ' 行商品</h2><div class="modal-grid"><label class="field"><span>商品编号</span><input id="editImportCode" value="' + esc(values[0] || "") + '"></label><label class="field"><span>商品名称 *</span><input id="editImportName" value="' + esc(values[1] || "") + '"></label><label class="field"><span>单位 *</span><input id="editImportUnit" value="' + esc(values[2] || "") + '"></label><label class="field"><span>最低库存 *</span><input id="editImportMin" type="number" min="0" step="1" value="' + esc(values[3] || "") + '"></label><label class="field"><span>期初库存</span><input id="editImportStock" type="number" min="0" step="1" value="' + esc(values[4] || "") + '"></label><label class="field"><span>期初单价（元）</span><input id="editImportPrice" type="number" min="0" step="0.01" value="' + esc(values[5] || "") + '"></label><label class="field"><span>默认供应商</span><input id="editImportSupplier" value="' + esc(values[6] || "") + '"></label><label class="field"><span>供应状态</span><select id="editImportStatus">' + statusOptionMarkup(String(values[7] || normalSupplyStatus())) + '</select></label></div><div id="editImportError"></div><div class="modal-actions"><button class="secondary" onclick="Warehouse.cancelImportEdit()">取消</button><button class="primary" onclick="Warehouse.saveImportProduct(' + rowNumber + ')">保存修改</button></div></div></div>';
    },
    cancelImportEdit: function () { renderImportPreview(); },
    saveImportProduct: function (rowNumber) {
      var index = Number(rowNumber) - 1;
      if (!importRawProductRows[index]) return;
      importRawProductRows[index] = ["editImportCode", "editImportName", "editImportUnit", "editImportMin", "editImportStock", "editImportPrice", "editImportSupplier", "editImportStatus"].map(function (id) { return document.getElementById(id).value.trim(); });
      try { rebuildImportPreview(); renderImportPreview(); } catch (error) { errorAt("editImportError", error.message); }
    },
    deleteImportHistory: function (type, rowNumber) {
      if (type !== "inbound" && type !== "outbound") return;
      var index = Number(rowNumber) - 1;
      var rows = importRawHistoryRows[type];
      if (index < 1 || index >= rows.length) return;
      rows.splice(index, 1);
      try { rebuildImportPreview(); renderImportPreview(); } catch (error) { errorAt("importError", error.message); }
    },
    editImportHistory: function (type, rowNumber) {
      if (type !== "inbound" && type !== "outbound") return;
      var index = Number(rowNumber) - 1;
      var values = importRawHistoryRows[type][index];
      if (!values) return;
      var headers = historyHeaders(type);
      document.getElementById("modalHost").innerHTML = '<div class="modal"><div class="modal-card"><p class="eyebrow">修改导入行</p><h2>第 ' + rowNumber + ' 行' + (type === "inbound" ? "入库历史" : "出库历史") + '</h2><div class="modal-grid">' + headers.map(function (header, column) { return '<label class="field"><span>' + esc(header) + (header === "日期" || header === "商品编号" || header === "数量" || header === "单价（元）" ? " *" : "") + '</span><input id="editHistory' + column + '" value="' + esc(values[column] == null ? "" : values[column]) + '"' + (header === "数量" || header === "单价（元）" ? ' type="number" min="0" step="' + (header === "数量" ? "1" : "0.01") + '"' : "") + '></label>'; }).join("") + '</div><div id="editImportError"></div><div class="modal-actions"><button class="secondary" onclick="Warehouse.cancelImportEdit()">取消</button><button class="primary" onclick="Warehouse.saveImportHistory(\'' + type + '\',' + rowNumber + ')">保存修改</button></div></div></div>';
    },
    saveImportHistory: function (type, rowNumber) {
      if (type !== "inbound" && type !== "outbound") return;
      var index = Number(rowNumber) - 1;
      if (!importRawHistoryRows[type][index]) return;
      importRawHistoryRows[type][index] = historyHeaders(type).map(function (_, column) { return document.getElementById("editHistory" + column).value.trim(); });
      try { rebuildImportPreview(); renderImportPreview(); } catch (error) { errorAt("editImportError", error.message); }
    },
    productModal: function (prefill) {
      prefill = prefill || {};
      if (prefill.source !== "inbound") pendingProductLine = null;
      // 入库时输入的新内容始终作为品名，避免把“编号式品名”误填到商品编号；编号由系统生成。
      var guessed = prefill.source === "inbound" ? { code: nextProductCode(), name: String(prefill.text || "").trim() } : productPrefill(prefill.text || "");
      if (!guessed.code) guessed.code = nextProductCode();
      var intro = prefill.source === "inbound" ? "库存中没有找到这个商品。已把入库时填写的内容带入，请补全带 * 的商品资料；按 Enter 可直接建立并入库。" : "带 * 的项目必须填写；编号已自动生成，可清空后改为人工编号。按 Enter 可直接建立商品。";
      var prefixNote = productCodePrefix() ? productCodePrefix() + " 为当前自动编号前缀" : "当前自动编号无前缀";
      document.getElementById("modalHost").innerHTML = '<div class="modal"><div class="modal-card product-modal" onkeydown="Warehouse.productModalEnter(event)"><p class="eyebrow">' + (prefill.source === "inbound" ? "入库时自动补建" : "商品主数据") + '</p><h2>' + (prefill.source === "inbound" ? "补全并新增商品" : "新增商品") + '</h2><p class="modal-intro">' + intro + '</p><div class="modal-grid"><label class="field"><span>商品编号 <small class="field-label-note">' + esc(prefixNote) + '</small></span><span class="clearable-input"><input id="newCode" value="' + esc(guessed.code) + '" placeholder="可手工填写" onkeydown="Warehouse.productModalEnter(event)"><button type="button" aria-label="清空商品编号" title="清空编号" onclick="Warehouse.clearProductCode()">×</button></span></label><label class="field"><span>商品名称 *</span><input id="newName" value="' + esc(guessed.name) + '" placeholder="必填" onkeydown="Warehouse.productModalEnter(event)"></label><label class="field supplier-picker"><span>默认供应商 <small class="field-label-note">可选择已有供应商或手工填写</small></span><select id="newSupplierChoice" onchange="Warehouse.chooseNewSupplier(this.value)" onkeydown="Warehouse.productModalEnter(event)">' + supplierOptions(prefill.supplier || "") + '</select><input id="newSupplier" value="' + esc(prefill.supplier || "") + '" placeholder="也可手工填写新供应商" onkeydown="Warehouse.productModalEnter(event)"></label><label class="field"><span>供应状态 *</span><select id="newStatus" onkeydown="Warehouse.productModalEnter(event)">' + statusOptionMarkup(normalSupplyStatus()) + '</select></label><label class="field"><span>最低库存 *</span><input id="newMin" type="number" min="0" step="1" value="0" onkeydown="Warehouse.productModalEnter(event)"></label><label class="field"><span>初始库存</span><input id="newInitialStock" type="number" min="0" step="1" value="0" onkeydown="Warehouse.productModalEnter(event)"></label><label class="field product-unit-field"><span>单位 *</span><input id="newUnit" value="件" placeholder="例如：件、箱、千克" onkeydown="Warehouse.productModalEnter(event)"></label></div><div id="productError"></div><div class="modal-actions"><button class="secondary" onclick="Warehouse.closeModal()">取消</button><button class="primary" onclick="Warehouse.addProduct()">' + (prefill.source === "inbound" ? "建立并返回入库" : "建立商品") + '</button></div></div></div>';
    },
    chooseNewSupplier: function (supplier) {
      var input = document.getElementById("newSupplier");
      if (!input || !supplier) return;
      input.value = supplier;
      input.focus();
    },
    closeModal: function () {
      pendingProductLine = null;
      recipeDraft = null;
      recipeImportRows = [];
      recipeImportPreview = [];
      importPreviewRows = [];
      importHistoryRows = { inbound: [], outbound: [] };
      importHistoryErrors = [];
      importRawProductRows = [];
      importRawHistoryRows = { inbound: [], outbound: [] };
      document.getElementById("modalHost").innerHTML = "";
    },
    addProduct: function () {
      var nameInput = document.getElementById("newName");
      var codeInput = document.getElementById("newCode");
      var unitInput = document.getElementById("newUnit");
      var minInput = document.getElementById("newMin");
      var initialStockInput = document.getElementById("newInitialStock");
      var name = nameInput.value.trim();
      var code = codeInput.value.trim();
      var unit = unitInput.value.trim();
      var min = Number(minInput.value);
      var initialStock = Number(initialStockInput.value);
      var missingFields = [];
      if (!name) missingFields.push(nameInput);
      if (!unit) missingFields.push(unitInput);
      if (!minInput.value.trim()) missingFields.push(minInput);
      if (missingFields.length) {
        flashFields(missingFields);
        return errorAt("productError", "请填写所有红色闪烁的商品资料。");
      }
      if (!Number.isSafeInteger(min) || min < 0) {
        flashFields([minInput]);
        return errorAt("productError", "最低库存必须是非负整数。");
      }
      if (!Number.isSafeInteger(initialStock) || initialStock < 0) {
        flashFields([initialStockInput]);
        return errorAt("productError", "初始库存必须是非负整数。");
      }
      if (!code) {
        code = nextProductCode();
      }
      if (state.products.some(function (p) { return p.code.toLowerCase() === code.toLowerCase(); })) {
        flashFields([codeInput]);
        return errorAt("productError", "商品编号 " + code + " 已存在。");
      }
      var createdAt = now();
      var product = { id: uid("p"), code: code, name: name, unit: unit, status: document.getElementById("newStatus").value, min: min, stock: initialStock, avg: 0, supplier: document.getElementById("newSupplier").value.trim(), createdAt: createdAt };
      recordUndo("新增商品：" + name);
      state.products.push(product);
      if (initialStock > 0) state.documents.unshift({ id: uid("d"), no: "QC-OFF-" + String(state.documents.length + 1).padStart(4, "0"), type: "inbound", purpose: "建立商品时录入初始库存", supplier: product.supplier, ref: "", at: createdAt, operator: "离线管理员", items: [{ productId: product.id, quantity: initialStock, price: 0, cost: 0, before: 0, after: initialStock }] });
      var returningToInbound = pendingProductLine !== null && page === "inbound";
      if (returningToInbound && draftLines[pendingProductLine]) draftLines[pendingProductLine].product = product.code + " · " + product.name;
      if (returningToInbound && !draftSupplier.trim() && product.supplier) draftSupplier = product.supplier;
      pendingProductLine = null;
      save();
      render();
      if (returningToInbound) {
        setTimeout(function () { window.Warehouse.submitDocument(); }, 0);
      } else {
        toast("商品已建立：" + name + "（" + code + "）");
      }
    },
    downloadImportTemplate: function () {
      var instructions = [["仓储台批量导入说明", "内容"], ["商品导入", "必须填写商品资料。期初库存是导入历史前的库存；不要修改表头或添加公式。"], ["商品编号", "可留空，由系统按照当前编号前缀自动生成；编号按文本保存。"], ["最低库存", "必须填写非负整数；低于或等于此数量时会显示补货提醒。"], ["期初库存", "可留空，按 0 处理；大于 0 时必须填写期初单价。"], ["入库历史 / 出库历史", "两张表均为可选。日期须填写 yyyy-mm-dd；历史按日期顺序写入。没有日期的旧流水不要写入历史，应折算至期初库存。供应商、单号、客户、联系方式、用途和备注均可留空。"], ["供应状态", productStatuses().join("、")]];
      var rows = [importHeaders()];
      download("仓储台-商品批量导入模板.xlsx", createXlsx([{ name: "填写说明", rows: instructions, formats: ["text", "text"] }, { name: "商品导入", rows: rows, formats: ["text", "text", "text", "integer", "integer", "currency", "text", "text"] }, { name: "入库历史", rows: [historyHeaders("inbound")], formats: ["text", "text", "integer", "currency", "text", "text", "text"] }, { name: "出库历史", rows: [historyHeaders("outbound")], formats: ["text", "text", "integer", "text", "text", "text", "text"] }]), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      toast("商品批量导入模板已下载。");
    },
    previewProductImport: function (file) {
      if (!file) return;
      if (!/\.xlsx$/i.test(file.name || "")) return alert("请选择系统模板格式的 .xlsx 文件。");
      if (file.size > 5 * 1024 * 1024) return alert("导入文件不能超过 5MB。");
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var parsed = parseImportWorkbook(reader.result);
          importRawProductRows = parsed.products;
          importRawHistoryRows = { inbound: parsed.inbound, outbound: parsed.outbound };
          rebuildImportPreview();
          renderImportPreview();
        } catch (error) {
          importPreviewRows = [];
          importHistoryRows = { inbound: [], outbound: [] };
          importHistoryErrors = [];
          importRawProductRows = [];
          importRawHistoryRows = { inbound: [], outbound: [] };
          alert("无法导入：" + error.message);
        }
      };
      reader.onerror = function () { alert("无法读取所选 Excel 文件。"); };
      reader.readAsArrayBuffer(file);
    },
    commitProductImport: function () {
      if (!importPreviewRows.length || importPreviewRows.some(function (row) { return row.errors.length; }) || importHistoryErrors.length) return;
      var duplicate = importPreviewRows.find(function (row) { return state.products.some(function (product) { return product.code.toLowerCase() === row.code.toLowerCase(); }); });
      if (duplicate) return errorAt("importError", "商品编号 " + duplicate.code + " 已存在，请重新选择文件预览。");
      var history = importHistoryRows.inbound.concat(importHistoryRows.outbound).sort(function (a, b) { var time = a.date.localeCompare(b.date); return time || (a.type === "inbound" ? -1 : 1); });
      recordUndo("Excel 批量导入 " + importPreviewRows.length + " 种商品" + (history.length ? "及历史流水" : ""));
      var createdAt = now();
      var importedProducts = importPreviewRows.map(function (row) {
        var product = { id: uid("p"), code: row.code, name: row.name, unit: row.unit, status: row.status, min: row.min, stock: row.stock, avg: row.stock ? row.price : 0, supplier: row.supplier, createdAt: createdAt };
        state.products.push(product);
        return { product: product, row: row };
      });
      var groups = Object.create(null);
      importedProducts.filter(function (entry) { return entry.row.stock > 0; }).forEach(function (entry) { var key = entry.row.supplier || "未填写供应商"; if (!groups[key]) groups[key] = []; groups[key].push(entry); });
      var initialDocumentNumber = state.documents.length + 1;
      Object.keys(groups).forEach(function (supplier, groupIndex) {
        var entries = groups[supplier];
        state.documents.unshift({ id: uid("d"), no: "QC-OFF-" + String(initialDocumentNumber + groupIndex).padStart(4, "0"), type: "inbound", purpose: "Excel 导入期初库存", supplier: supplier === "未填写供应商" ? "" : supplier, ref: "Excel批量导入", at: createdAt, operator: "离线管理员", items: entries.map(function (entry) { return { productId: entry.product.id, quantity: entry.row.stock, price: entry.row.price, cost: entry.row.price, before: 0, after: entry.row.stock }; }) });
      });
      var productsByCode = Object.create(null);
      importedProducts.forEach(function (entry) { productsByCode[entry.product.code.toLowerCase()] = entry.product; });
      var inboundHistoryNumber = 1;
      var outboundHistoryNumber = 1;
      history.forEach(function (entry) {
        var product = productsByCode[entry.code.toLowerCase()];
        var before = product.stock;
        var after = entry.type === "inbound" ? before + entry.quantity : before - entry.quantity;
        var unitCost = entry.type === "inbound" ? entry.price : outboundUnitCost(product, entry.quantity);
        if (entry.type === "inbound") product.avg = after ? Math.round((before * product.avg + entry.quantity * entry.price) / after) : 0;
        product.stock = after;
        if (!after) product.avg = 0;
        state.documents.unshift({ id: uid("d"), no: (entry.type === "inbound" ? "RK-HIS-" + String(inboundHistoryNumber++).padStart(4, "0") : "CK-HIS-" + String(outboundHistoryNumber++).padStart(4, "0")), type: entry.type, purpose: entry.type === "outbound" ? (entry.purpose || "历史出库导入") : "", supplier: entry.type === "inbound" ? entry.supplier : "", ref: entry.type === "inbound" ? (entry.ref || "Excel历史导入") : "Excel历史导入", customer: entry.type === "outbound" ? entry.customer : "", contact: entry.type === "outbound" ? entry.contact : "", remark: entry.remark || "", at: entry.date, operator: "离线管理员", items: [{ productId: product.id, quantity: entry.quantity, price: entry.type === "inbound" ? entry.price : 0, cost: unitCost, before: before, after: after }] });
      });
      var count = importPreviewRows.length;
      var historyCount = history.length;
      importPreviewRows = [];
      importHistoryRows = { inbound: [], outbound: [] };
      importHistoryErrors = [];
      importRawProductRows = [];
      importRawHistoryRows = { inbound: [], outbound: [] };
      save();
      document.getElementById("modalHost").innerHTML = "";
      render();
      toast("已批量导入 " + count + " 种商品" + (historyCount ? "及 " + historyCount + " 条历史流水" : "") + "，可从左侧撤回。");
    },
    exportReplenishment: function () {
      var items = replenishmentItems();
      if (!items.length) return toast("当前没有需要补货的商品。");
      var rows = [["商品编号", "品名", "单位", "当前库存", "最低库存", "默认供应商", "供应状态"]].concat(items.map(function (p) { return [p.code, p.name, p.unit, p.stock, p.min, p.supplier, p.status]; }));
      download("仓储台-补货提醒-" + new Date().toISOString().slice(0, 10) + ".xlsx", createXlsx([{ name: "补货提醒", rows: rows, formats: ["text", "text", "text", "integer", "integer", "text", "text"] }]), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      toast("补货提醒 Excel 已导出。");
    },
    exportBackup: function () {
      download("仓储台-浏览器备份-" + new Date().toISOString().slice(0, 10) + ".json", JSON.stringify({ format: "warehouse-offline-backup", createdAt: now(), data: state }, null, 2), "application/json");
      toast("备份已下载到浏览器的下载目录。");
    },
    restoreBackup: function (file) {
      if (!file) return;
      if (!confirm("恢复备份会替换 data 文件夹中的全部库存和流水，确认继续吗？")) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var backup = JSON.parse(reader.result);
          if (!backup || backup.format !== "warehouse-offline-backup" || !backup.data || !Array.isArray(backup.data.products) || !Array.isArray(backup.data.documents)) throw new Error("文件格式不正确");
          recordUndo("恢复备份");
          var preservedHistory = state.undoHistory;
          state = normalizeState(backup.data);
          state.undoHistory = preservedHistory;
          applyFontScale();
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
      var inventory = [["商品编号", "品名", "单位", "当前库存", "最低库存", "状态", "默认供应商", "计价方式", "计价单价", "库存金额", "建库时间"]].concat(activeProducts().map(function (p) { return [p.code, p.name, p.unit, p.stock, p.min, p.status, p.supplier, costMethodLabel(state.settings.costMethod), inventoryUnitCost(p) / 100, inventoryValue(p) / 100, new Date(p.createdAt)]; }));
      var movements = [["时间", "单号", "类型", "商品编号", "品名", "数量", "单位", "供应商/客户/用途", "明细备注", "单价/成本", "金额", "操作人"]];
      docs.forEach(function (doc) { doc.items.forEach(function (line) { var p = productById(line.productId) || { code: "", name: "未知商品", unit: "" }; var unit = doc.type === "inbound" ? line.price : line.cost; var detail = doc.type === "inbound" ? doc.supplier : (doc.customer ? "客户 " + doc.customer + (doc.contact ? " · " + doc.contact : "") + (doc.purpose ? " · " : "") : "") + doc.purpose; movements.push([new Date(doc.at), doc.no, typeLabel(doc.type), p.code, p.name, (doc.type === "outbound" || doc.type === "assembly") ? -Math.abs(line.quantity) : line.quantity, p.unit, detail, line.remark || doc.remark || "", unit / 100, Math.abs(line.quantity) * unit / 100, doc.operator]); }); });
      var exportName = currentPeriod ? ("仓储台" + reportPeriodLabel() + "-" + reportFilterValue() + ".xlsx") : ("仓储台离线数据-" + new Date().toISOString().slice(0, 10) + ".xlsx");
      var workbook = createXlsx([
        { name: "库存", rows: inventory, formats: ["text", "text", "text", "integer", "integer", "integer", "integer", "text", "text", "text", "currency", "currency", "date"] },
        { name: "流水", rows: movements, formats: ["date", "text", "text", "text", "text", "integer", "text", "text", "text", "currency", "currency", "text"] }
      ]);
      download(exportName, workbook, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      toast("Excel 已导出。");
    },
    exportProductHistory: function (id) {
      var product = productById(id);
      if (!product) return;
      var overview = [["项目", "内容"], ["商品编号", product.code], ["商品名称", product.name], ["默认供应商", product.supplier], ["状态", product.status], ["单位", product.unit], ["当前库存", product.stock], ["当前计价方式", costMethodLabel(state.settings.costMethod)], ["当前计价单价", inventoryUnitCost(product) / 100], ["当前库存金额", inventoryValue(product) / 100], ["建库时间", new Date(product.createdAt)]];
      var history = [["时间", "类型", "单号", "数量", "单位", "单价/成本", "价格说明", "变动前库存", "变动后库存", "备注", "供应商/客户/用途", "操作人"]];
      productLifecycle(product).forEach(function (record) {
        var remark = record.type === "inbound" ? (record.lineRemark || record.remark || "") : (record.remark || "");
        history.push([new Date(record.at), record.typeText, record.no, record.quantity, product.unit, record.unitPrice == null ? null : record.unitPrice / 100, record.priceLabel, record.before, record.after, remark, record.detail, record.operator]);
      });
      var workbook = createXlsx([
        { name: "商品概览", rows: overview, formats: ["text", "text"] },
        { name: "全周期记录", rows: history, formats: ["date", "text", "text", "integer", "text", "currency", "text", "integer", "integer", "text", "text", "text"] }
      ]);
      download("商品全周期-" + product.code + "-" + new Date().toISOString().slice(0, 10) + ".xlsx", workbook, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      toast("商品全周期 Excel 已导出。");
    },
    reset: function () {
      if (!confirm("确认清空全部商品、库存和流水？清空后可通过左侧“撤回上一步”恢复，但仍建议先立即备份。")) return;
      recordUndo("清空全部数据");
      var preservedHistory = state.undoHistory;
      state = initialData();
      state.undoHistory = preservedHistory;
      applyFontScale();
      save();
      page = "home";
      render();
      toast("全部数据已清空，系统已恢复为空白状态。");
    }
  };

  load();
})();
