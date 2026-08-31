/**
 * viewer 组件层面板（G7-V5 · §11.3 组件模型视图）
 *
 * 数据源（全部查表、端内零推导，数据来自 data.json 的 V3+ components 字段，即缺口 #10 X18 组件映射段）：
 *  - components.interfaceImplementations[]：{interface, component, description}（接口→实现组件，interface=接口名）；
 *  - components.dimensionStorage[]：{dimension, table, description?}（实体维度→存储，dimension=维度名）；
 *  - components.componentTransfers[]：{from, to, channel, mode, description}（组件→组件传输，mode=sync/async）；
 *  - interfaces[]：{id, name, ...}（接口 id↔name 查表——interfaceImplementations 以 name 关联 interfaces 得 id）；
 *  - dimensions[]：{owner, dimension, ...}（维度 owner 查表——dimensionStorage 以 name 关联 dimensions 得 owner）；
 *  - storage.entities[]：{entity, dimensions[]}（协议层卡片已在用；本面板拓扑节点计数仅用 components 自身）。
 *
 * 面板结构（§11.3 顺序）：
 *  ① 接口 → 实现组件表：行=interfaceImplementations 条目（接口 id+name / 组件 / 说明），按组件分组排序；
 *     点接口行 → 高亮该接口的实现组件（行+拓扑节点）与存储落点；点组件列 → 高亮该组件承载的全部接口。
 *  ② 实体维度 → 存储表：行=dimensionStorage 条目（维度名+owner / 表 / 说明），owner 按 dimensions 查表。
 *  ③ 组件 → 组件传输表：行=componentTransfers 条目（from→to / channel / mode sync·async 徽章 / 说明）。
 *  ④ 架构总览拓扑：节点=去重组件集（组件名+承载接口数），边=传输带 mode 徽章（纯 CSS，规模小可控）。
 *     —— 新 viewer 唯一保留的图形形式（§11.3 第 2 项）。
 *
 * 双向跳转（§11.3 第 3 项）：
 *  - 协议 → 组件：点协议交叉面板接口名（.proto-op-name）或本面板接口行 → 高亮实现组件行/拓扑节点与存储落点
 *    （存储落点=接口文本提及的 dimensionStorage 维度，与协议层 entitySetOf 同构的文本匹配，零推导）；
 *  - 组件 → 协议：点本面板组件（拓扑节点或组件列）→ 高亮其承载的全部接口（同面板 .hl + 协议层 .hl-comp）。
 * 跳转以 document 级事件委托实现（同 interface-jump-bridge 模式），不改动协议层面板。
 *
 * 降级：无 components 字段（老实例 data.json）→ 面板显式提示"无组件层数据"，不白屏不报错；
 * 部分字段缺失（如只缺 dimensionStorage）→ 对应区块显示空态。
 *
 * 边界（§11.3）：不变量/维度联动不重复实现（协议层 V4 已有）；不做状态机图形。
 */
(function () {
  'use strict';

  // 分层视图目标解析（R2b+）：view-tabs.js 加载且非项目模式 → 渲染进 #view-component；否则原 #panels（零回归）
  const viewBox = (window.ProtochainViewerTabs && window.ProtochainViewerTabs.viewBox) || ((p) => p);

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // 渲染上下文：render 时收集的查表结构（renderAll 每次清空并重建面板，交互前必然已刷新）
  let ctx = null;

  // ---------------------------------------------------------------------------
  // 数据提取（查表，端内零推导）
  // ---------------------------------------------------------------------------

  /** interfaces[] 索引：name → iface / id → iface（interfaceImplementations 以 name 关联） */
  function buildIfaceIndex(ifaces) {
    const byName = new Map();
    const byId = new Map();
    for (const i of ifaces || []) {
      if (i && typeof i.name === 'string' && !byName.has(i.name)) byName.set(i.name, i);
      if (i && typeof i.id === 'string' && !byId.has(i.id)) byId.set(i.id, i);
    }
    return { byName, byId };
  }

  /** 维度名 → owner 集合（dimensions 查表；同名多 owner 并列展示，如 在册状态 分属 servers/domains） */
  function buildDimOwners(dims) {
    const map = new Map();
    for (const d of dims || []) {
      if (!d || typeof d.dimension !== 'string') continue;
      if (!map.has(d.dimension)) map.set(d.dimension, []);
      if (d.owner && !map.get(d.dimension).includes(d.owner)) map.get(d.dimension).push(d.owner);
    }
    return map;
  }

  /** 接口文本拼接（precondition/postconditions/sideEffects/outputs），用于存储落点维度名匹配 */
  function ifaceTexts(iface) {
    const texts = [];
    if (typeof iface.precondition === 'string') texts.push(iface.precondition);
    if (Array.isArray(iface.postconditions)) texts.push(...iface.postconditions);
    if (Array.isArray(iface.sideEffects)) {
      for (const s of iface.sideEffects) texts.push(s.description || s.kind || '');
    }
    if (Array.isArray(iface.outputs)) {
      for (const o of iface.outputs) texts.push(o.description || '');
    }
    return texts;
  }

  // ---------------------------------------------------------------------------
  // 高亮联动（DOM 集合操作）
  // ---------------------------------------------------------------------------

  function clearCompHighlights(box) {
    if (!box) return;
    box.querySelectorAll(
      '.comp-impl-row.hl, .comp-storage-row.hl, .comp-topo-node.hl, .comp-transfer-row.hl, .comp-impl-component.hl, .comp-ctl-card.hl'
    ).forEach((x) => x.classList.remove('hl'));
    // 协议层跨面板高亮：独立类名，不与协议层自身联动（active/hl-guard/hl-inv）互踩
    if (typeof document !== 'undefined') {
      document.querySelectorAll('.proto-op-row.hl-comp').forEach((x) => x.classList.remove('hl-comp'));
    }
  }

  /** 接口 → 实现组件与存储落点高亮（协议→组件 跳转核心；ifaceId 与 ifaceName 至少其一） */
  function highlightInterface(box, ifaceId, ifaceName) {
    clearCompHighlights(box);
    if (!box || !ctx) return;
    const iface = (ifaceId && ctx.ifaceIndex.byId.get(ifaceId)) ||
      (ifaceName && ctx.ifaceIndex.byName.get(ifaceName));
    const name = iface ? iface.name : ifaceName;
    if (!name) return;
    // 实现组件行 + 拓扑节点
    const row = box.querySelector(`.comp-impl-row[data-interface-name="${name}"]`);
    if (row) row.classList.add('hl');
    // T5a：接口契约卡片同步高亮
    const ctlCard = box.querySelector(`.comp-ctl-card[data-interface-name="${name}"]`);
    if (ctlCard) ctlCard.classList.add('hl');
    const comp = row && row.getAttribute('data-component');
    if (comp) {
      const node = box.querySelector(`.comp-topo-node[data-component="${comp}"]`);
      if (node) node.classList.add('hl');
    }
    // 存储落点：接口文本提及的 dimensionStorage 维度
    if (iface) {
      const joined = ifaceTexts(iface).join('\n');
      box.querySelectorAll('.comp-storage-row').forEach((sr) => {
        const dim = sr.getAttribute('data-dimension');
        if (dim && joined.includes(dim)) sr.classList.add('hl');
      });
    }
  }

  /** 组件 → 承载接口高亮（组件→协议 跳转核心；同面板 + 协议层 .hl-comp） */
  function highlightComponent(box, component) {
    clearCompHighlights(box);
    if (!box || !ctx || !component) return;
    // 同面板：该组件的全部接口行 + 拓扑节点
    box.querySelectorAll(`.comp-impl-row[data-component="${component}"]`).forEach((r) => r.classList.add('hl'));
    const node = box.querySelector(`.comp-topo-node[data-component="${component}"]`);
    if (node) node.classList.add('hl');
    // 协议层：这些接口（id）的操作行
    if (typeof document !== 'undefined') {
      box.querySelectorAll(`.comp-impl-row[data-component="${component}"]`).forEach((r) => {
        const id = r.getAttribute('data-interface-id');
        if (id) {
          const op = document.querySelector(`.proto-op-row[data-interface-id="${id}"]`);
          if (op) op.classList.add('hl-comp');
        }
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 区块渲染
  // ---------------------------------------------------------------------------

  function emptyHint(section, text) {
    const empty = document.createElement('div');
    empty.className = 'comp-empty';
    empty.textContent = text;
    section.appendChild(empty);
  }

  /** ① 接口 → 实现组件表 */
  function renderInterfaceImplementations(box, impls) {
    const section = document.createElement('div');
    section.className = 'comp-section comp-impl-section';

    const sub = document.createElement('div');
    sub.className = 'comp-section-title';
    sub.textContent = `① 接口 → 实现组件（${impls.length} 条 · 点接口高亮实现组件与存储落点 · 点组件列高亮其承载接口）`;
    section.appendChild(sub);

    if (impls.length === 0) {
      emptyHint(section, '（无接口实现映射：components.interfaceImplementations 缺失或为空）');
      box.appendChild(section);
      return;
    }

    const table = document.createElement('table');
    table.className = 'comp-impl-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const h of ['接口（id · name）', '实现组件', '说明']) {
      const th = document.createElement('th');
      th.textContent = h;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    const sorted = [...impls].sort((a, b) =>
      (a.component || '').localeCompare(b.component || '') ||
      (a.interface || '').localeCompare(b.interface || '')
    );
    for (const im of sorted) {
      const iface = ctx.ifaceIndex.byName.get(im.interface);
      const row = document.createElement('tr');
      row.className = 'comp-impl-row';
      row.setAttribute('data-interface-name', im.interface || '');
      row.setAttribute('data-interface-id', iface ? iface.id : '');
      row.setAttribute('data-component', im.component || '');
      row.title = im.description || `接口 ${im.interface} 由 ${im.component} 实现`;

      const tdIface = document.createElement('td');
      tdIface.className = 'comp-impl-iface';
      tdIface.innerHTML =
        `<span class="comp-impl-id">${esc(iface ? iface.id : '—')}</span>` +
        `<span class="comp-impl-name">${esc(im.interface || '—')}</span>`;

      const tdComp = document.createElement('td');
      const compSpan = document.createElement('span');
      compSpan.className = 'comp-impl-component';
      compSpan.setAttribute('data-component', im.component || '');
      compSpan.textContent = im.component || '—';
      compSpan.title = `点击高亮 ${im.component} 承载的全部接口`;
      tdComp.appendChild(compSpan);

      const tdDesc = document.createElement('td');
      tdDesc.className = 'comp-impl-desc';
      tdDesc.textContent = im.description || '';

      row.appendChild(tdIface);
      row.appendChild(tdComp);
      row.appendChild(tdDesc);
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    section.appendChild(table);
    box.appendChild(section);
  }

  /** ② 实体维度 → 存储表 */
  function renderDimensionStorage(box, rows) {
    const section = document.createElement('div');
    section.className = 'comp-section comp-storage-section';

    const sub = document.createElement('div');
    sub.className = 'comp-section-title';
    sub.textContent = `② 实体维度 → 存储（${rows.length} 条 · 维度名+owner 查表 · 表=存储落点）`;
    section.appendChild(sub);

    if (rows.length === 0) {
      emptyHint(section, '（无维度存储映射：components.dimensionStorage 缺失或为空）');
      box.appendChild(section);
      return;
    }

    const table = document.createElement('table');
    table.className = 'comp-storage-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const h of ['维度（owner）', '存储表', '说明']) {
      const th = document.createElement('th');
      th.textContent = h;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const s of rows) {
      const owners = ctx.dimOwners.get(s.dimension) || [];
      const ownerText = owners.length > 0 ? owners.join(' · ') : '—';
      const row = document.createElement('tr');
      row.className = 'comp-storage-row';
      row.setAttribute('data-dimension', s.dimension || '');
      row.setAttribute('data-owner', ownerText);
      row.setAttribute('data-table', s.table || '');
      row.title = s.description || `维度 ${s.dimension} 落表 ${s.table}`;

      const tdDim = document.createElement('td');
      tdDim.innerHTML =
        `<span class="comp-storage-dim">${esc(s.dimension || '—')}</span>` +
        `<span class="comp-storage-owner" title="owner（dimensions 查表）">${esc(ownerText)}</span>`;

      const tdTable = document.createElement('td');
      const tag = document.createElement('span');
      tag.className = 'comp-storage-table-tag';
      tag.textContent = s.table || '—';
      tdTable.appendChild(tag);

      const tdDesc = document.createElement('td');
      tdDesc.className = 'comp-storage-desc';
      tdDesc.textContent = s.description || '';

      row.appendChild(tdDim);
      row.appendChild(tdTable);
      row.appendChild(tdDesc);
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    section.appendChild(table);
    box.appendChild(section);
  }

  /** ③ 组件 → 组件传输表 */
  function renderTransfers(box, transfers) {
    const section = document.createElement('div');
    section.className = 'comp-section comp-transfer-section';

    const sub = document.createElement('div');
    sub.className = 'comp-section-title';
    sub.textContent = `③ 组件 → 组件传输（${transfers.length} 条 · mode 同步/异步徽章）`;
    section.appendChild(sub);

    if (transfers.length === 0) {
      emptyHint(section, '（无组件传输：components.componentTransfers 缺失或为空）');
      box.appendChild(section);
      return;
    }

    const list = document.createElement('div');
    list.className = 'comp-transfer-list';
    for (const t of transfers) {
      const row = document.createElement('div');
      row.className = 'comp-transfer-row';
      row.setAttribute('data-from', t.from || '');
      row.setAttribute('data-to', t.to || '');
      row.setAttribute('data-mode', t.mode || '');
      row.innerHTML =
        `<span class="comp-transfer-pair"><b>${esc(t.from || '—')}</b> → <b>${esc(t.to || '—')}</b></span>` +
        `<span class="comp-transfer-channel">${esc(t.channel || '—')}</span>` +
        `<span class="comp-mode comp-mode-${t.mode === 'sync' ? 'sync' : 'async'}">${esc(t.mode || '—')}</span>` +
        (t.description ? `<span class="comp-transfer-desc" title="${esc(t.description)}">${esc(t.description)}</span>` : '');
      list.appendChild(row);
    }
    section.appendChild(list);
    box.appendChild(section);
  }

  /** ④ 架构总览拓扑（节点=去重组件集 · 边=传输带 mode 徽章；纯 CSS） */
  function renderTopology(box, impls, transfers) {
    const section = document.createElement('div');
    section.className = 'comp-section comp-topo-section';

    const sub = document.createElement('div');
    sub.className = 'comp-section-title';
    sub.textContent = '④ 架构总览（节点=组件·承载接口数 · 边=传输带 mode 徽章 · 点组件高亮其承载接口）';
    section.appendChild(sub);

    // 节点：接口实现组件 ∪ 传输 from/to 去重，计承载接口数
    const nodeMap = new Map();
    for (const im of impls || []) {
      if (!im.component) continue;
      if (!nodeMap.has(im.component)) nodeMap.set(im.component, 0);
      nodeMap.set(im.component, nodeMap.get(im.component) + 1);
    }
    for (const t of transfers || []) {
      if (t.from && !nodeMap.has(t.from)) nodeMap.set(t.from, 0);
      if (t.to && !nodeMap.has(t.to)) nodeMap.set(t.to, 0);
    }

    if (nodeMap.size === 0) {
      emptyHint(section, '（无组件节点：interfaceImplementations 与 componentTransfers 均缺失）');
      box.appendChild(section);
      return;
    }

    const nodes = [...nodeMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const nodeRow = document.createElement('div');
    nodeRow.className = 'comp-topo-nodes';
    const label = document.createElement('span');
    label.className = 'comp-topo-nodes-label';
    label.textContent = '节点：';
    nodeRow.appendChild(label);
    for (const [name, count] of nodes) {
      const chip = document.createElement('span');
      chip.className = 'comp-topo-node';
      chip.setAttribute('data-component', name);
      chip.setAttribute('data-interface-count', String(count));
      chip.textContent = `${name} · ${count} 接口`;
      chip.title = `点击高亮 ${name} 承载的全部接口`;
      nodeRow.appendChild(chip);
    }
    section.appendChild(nodeRow);

    const edgeList = document.createElement('div');
    edgeList.className = 'comp-topo-edges';
    for (const t of transfers || []) {
      const e = document.createElement('div');
      e.className = 'comp-topo-edge';
      e.setAttribute('data-from', t.from || '');
      e.setAttribute('data-to', t.to || '');
      e.setAttribute('data-mode', t.mode || '');
      e.innerHTML =
        `<span class="comp-topo-arrow"><b>${esc(t.from || '—')}</b> → <b>${esc(t.to || '—')}</b></span>` +
        `<span class="comp-mode comp-mode-${t.mode === 'sync' ? 'sync' : 'async'}">${esc(t.mode || '—')}</span>` +
        (t.channel ? `<span class="comp-topo-channel">${esc(t.channel)}</span>` : '');
      edgeList.appendChild(e);
    }
    section.appendChild(edgeList);
    box.appendChild(section);
  }

  // ---------------------------------------------------------------------------
  // T5a · ⑤ 接口契约详情（apifox 式卡片：url/method/authorization/参数/响应/错误）
  // 数据源全部查表（interfaces[].transport/authorization/requestSchema/responseSchema/
  // errorResponses 由 webgen 投影），端内零推导；缺失字段显示缺省占位不崩。
  // ---------------------------------------------------------------------------

  /** schema 树节点 → <li>（含嵌套；与 interface-detail-panel schemaNodeHtml 同构的轻量实现） */
  function ctlSchemaNodeHtml(node, requiredSet) {
    const req = requiredSet && requiredSet.indexOf(node.name) !== -1 ? ' <span class="comp-ctl-req">必填</span>' : '';
    const desc = node.description ? ` <span class="comp-ctl-schema-desc">${esc(node.description)}</span>` : '';
    const en = node.enum ? ` <span class="comp-ctl-schema-enum">enum: ${esc(node.enum.join(', '))}</span>` : '';
    let html =
      `<li><code>${esc(node.name)}</code> : <span class="comp-ctl-schema-type">${esc(node.type)}</span>${req}${desc}${en}</li>`;
    if (node.children && node.children.length) {
      html += '<ul class="comp-ctl-schema-tree">' +
        node.children.map((c) => ctlSchemaNodeHtml(c, node.required)).join('') +
        '</ul>';
    }
    return html;
  }

  /** schema → 字段树 HTML（复用 InterfaceViewUtils.buildSchemaTree；U 缺失 → 降级占位） */
  function ctlSchemaTreeHtml(schema, name) {
    if (!schema) {
      return '<div class="comp-ctl-empty">（接口契约未声明 ' + esc(name) + '）</div>';
    }
    const U = window.InterfaceViewUtils;
    if (!U || typeof U.buildSchemaTree !== 'function') {
      return '<div class="comp-ctl-empty">（schema 渲染工具未加载）</div>';
    }
    const tree = U.buildSchemaTree(schema, name, '');
    if (!tree || !tree.children || !tree.children.length) {
      return '<div class="comp-ctl-empty">（无 schema 字段）</div>';
    }
    return '<ul class="comp-ctl-schema-tree">' +
      tree.children.map((c) => ctlSchemaNodeHtml(c, tree.required)).join('') +
      '</ul>';
  }

  /** 错误码表 HTML（复用 InterfaceViewUtils.buildErrorTable；无 → 占位） */
  function ctlErrorTableHtml(iface) {
    const U = window.InterfaceViewUtils;
    let rows = [];
    if (U && typeof U.buildErrorTable === 'function') {
      rows = U.buildErrorTable({ interface: iface, binding: {} }) || [];
    } else if (Array.isArray(iface.errorResponses)) {
      rows = iface.errorResponses.map((e) => ({
        errorCode: e.errorCode,
        httpStatus: e.httpStatus,
        description: e.description || '',
        unmapped: false,
      }));
    }
    if (!rows.length) {
      return '<div class="comp-ctl-empty">（无错误响应定义）</div>';
    }
    let html =
      '<table class="comp-ctl-errtable"><thead><tr><th>错误码</th><th>HTTP</th><th>说明</th></tr></thead><tbody>';
    for (const r of rows) {
      html +=
        `<tr><td>${esc(r.errorCode)}</td>` +
        `<td>${r.httpStatus !== null && r.httpStatus !== undefined ? esc(String(r.httpStatus)) : '—'}</td>` +
        `<td>${esc(r.description || '')}</td></tr>`;
    }
    html += '</tbody></table>';
    return html;
  }

  /** 授权行 HTML（interfaces[].authorization 查表；缺失 → 组件模型未声明降级） */
  function ctlAuthHtml(iface) {
    const a = iface && iface.authorization;
    if (!a) {
      return (
        '<div class="comp-ctl-auth">' +
        '<span class="comp-ctl-auth-badge comp-ctl-auth-none">none</span>' +
        '<span class="comp-ctl-auth-degraded">组件模型未声明（接口未绑定凭证）</span>' +
        '</div>'
      );
    }
    const cls = a.type === 'bearer' ? 'bearer' : a.type === 'oauth' ? 'oauth' : a.type === 'token' ? 'token' : 'none';
    const cred = a.credential
      ? ` · 凭证 ${esc(a.credential)}${a.selfContained ? `（${esc(a.selfContained)}）` : ''}`
      : '';
    const degraded = a.degraded
      ? `<span class="comp-ctl-auth-degraded">${esc(a.reason || '组件模型未声明')}</span>`
      : '';
    return `<div class="comp-ctl-auth"><span class="comp-ctl-auth-badge comp-ctl-auth-${cls}">${esc(a.type)}</span>${cred}${degraded}</div>`;
  }

  /**
   * ⑤ 接口契约详情（apifox 式卡片，按组件分组）。
   * url：path 原文 + baseUrl 缺省用组件名占位（组件模型未声明 baseUrl，显式标注）；
   * method：interfaces[].transport.method（webgen 从 bindings/skeleton 投影）；缺失 → '—' 占位。
   */
  function renderContractDetails(box, impls) {
    const section = document.createElement('div');
    section.className = 'comp-section comp-ctl-section';

    const sub = document.createElement('div');
    sub.className = 'comp-section-title';
    sub.textContent = `⑤ 接口契约详情（${impls.length} 接口 · url/method/authorization/参数/响应/错误 · 点卡片高亮协议层落点）`;
    section.appendChild(sub);

    if (impls.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'comp-ctl-empty';
      empty.textContent = '（无接口实现映射，无契约详情可展示）';
      section.appendChild(empty);
      box.appendChild(section);
      return;
    }

    // 按组件分组（与①同构：组件名排序）
    const groups = new Map();
    for (const im of impls) {
      const c = im.component || '（未命名组件）';
      if (!groups.has(c)) groups.set(c, []);
      groups.get(c).push(im);
    }
    for (const [comp, items] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const g = document.createElement('div');
      g.className = 'comp-ctl-group';
      const gname = document.createElement('div');
      gname.className = 'comp-ctl-group-name';
      gname.textContent = `组件 ${comp}（${items.length} 接口）`;
      g.appendChild(gname);
      for (const im of items) {
        const iface = ctx.ifaceIndex.byName.get(im.interface);
        const t = (iface && iface.transport) || {};
        const method = (t.method || '—').toUpperCase();
        const path = t.path || '';
        const urlText = path ? path : '（path 未声明）';
        const m = method.toLowerCase();
        const methodCls = m === 'get' || m === 'put' || m === 'delete' || m === 'patch' ? m : 'post';
        const card = document.createElement('div');
        card.className = 'comp-ctl-card';
        card.setAttribute('data-interface-name', im.interface || '');
        card.setAttribute('data-interface-id', iface ? iface.id : '');
        card.title = `点击高亮接口 ${im.interface} 在组件层/协议层的既有落点`;
        card.innerHTML =
          `<div class="comp-ctl-head">` +
          `<span class="comp-ctl-method ${methodCls}">${esc(method)}</span>` +
          `<span class="comp-ctl-name">${esc(im.interface || '—')}</span>` +
          (iface ? `<span class="comp-ctl-id">${esc(iface.id)}</span>` : '') +
          `<span class="comp-ctl-id">→ ${esc(im.component || '—')}</span>` +
          `</div>` +
          `<div class="comp-ctl-url" title="baseUrl 组件模型未声明，缺省用组件名占位">${esc(urlText)}${t.path ? '<span class="comp-ctl-baseurl-degraded">（baseUrl 未声明 · 组件名占位）</span>' : ''}</div>` +
          ctlAuthHtml(iface) +
          `<div class="comp-ctl-block"><div class="comp-ctl-block-title">参数（requestSchema）</div>` +
          ctlSchemaTreeHtml(iface && iface.requestSchema, 'requestSchema') +
          `</div>` +
          `<div class="comp-ctl-block"><div class="comp-ctl-block-title">响应（responseSchema）</div>` +
          ctlSchemaTreeHtml(iface && iface.responseSchema, 'responseSchema') +
          `</div>` +
          `<div class="comp-ctl-block"><div class="comp-ctl-block-title">错误码表（errorResponses）</div>` +
          ctlErrorTableHtml(iface || {}) +
          `</div>`;
        g.appendChild(card);
      }
      section.appendChild(g);
    }
    box.appendChild(section);
  }

  // ---------------------------------------------------------------------------
  // 面板渲染入口
  // ---------------------------------------------------------------------------
  function renderComponentPanel(state, panels) {
    const data = state.dataJson;
    if (!data) return; // 未导入：主视图已有提示，组件层不重复
    panels = viewBox(panels, 'view-component');
    if (panels.querySelector('.component-panel') || panels.querySelector('.component-empty')) return;

    const comp = data.components && typeof data.components === 'object' ? data.components : null;
    const impls = comp && Array.isArray(comp.interfaceImplementations) ? comp.interfaceImplementations : [];
    const dimRows = comp && Array.isArray(comp.dimensionStorage) ? comp.dimensionStorage : [];
    const transfers = comp && Array.isArray(comp.componentTransfers) ? comp.componentTransfers : [];

    // 老实例（无 components 字段，或三张表全缺）→ 显式缺省提示（不白屏不报错）
    if (!comp || (impls.length === 0 && dimRows.length === 0 && transfers.length === 0)) {
      const p = document.createElement('div');
      p.className = 'panel-empty component-empty';
      p.textContent =
        '组件层面板：当前 data.json 无组件层数据（components.interfaceImplementations / dimensionStorage / componentTransfers，V3+ derive-web X18 组件映射段）——请重新运行 derive-web 或导入新版 data.json';
      panels.appendChild(p);
      return;
    }

    // 查表索引（交互跳转读取）
    ctx = {
      ifaceIndex: buildIfaceIndex(Array.isArray(data.interfaces) ? data.interfaces : []),
      dimOwners: buildDimOwners(Array.isArray(data.dimensions) ? data.dimensions : []),
    };

    const box = document.createElement('div');
    box.className = 'component-panel';

    const nodeSet = new Set();
    for (const im of impls) if (im.component) nodeSet.add(im.component);
    for (const t of transfers) {
      if (t.from) nodeSet.add(t.from);
      if (t.to) nodeSet.add(t.to);
    }
    const tableSet = new Set(dimRows.map((r) => r.table).filter(Boolean));

    const title = document.createElement('div');
    title.className = 'panel-subtitle';
    title.textContent =
      `组件层面板（§11.3 · 组件 ${nodeSet.size} · 接口实现 ${impls.length} · 存储表 ${tableSet.size} · 传输 ${transfers.length}）`;
    box.appendChild(title);

    // ① 接口 → 实现组件
    renderInterfaceImplementations(box, impls);
    // ② 实体维度 → 存储
    renderDimensionStorage(box, dimRows);
    // ③ 组件 → 组件传输
    renderTransfers(box, transfers);
    // ④ 架构总览拓扑
    renderTopology(box, impls, transfers);
    // ⑤ 接口契约详情（T5a：apifox 式，按组件分组）
    renderContractDetails(box, impls);

    panels.appendChild(box);
  }

  // ---------------------------------------------------------------------------
  // 注册（叠加到 renderAll 链尾；顺序在 protocol 之后）
  // ---------------------------------------------------------------------------
  const hooks = window.ProtochainViewerHooks || {};
  const prevRenderAll = hooks.renderAll;
  hooks.renderAll = function (state, panels) {
    if (prevRenderAll) prevRenderAll(state, panels);
    renderComponentPanel(state, panels);
  };
  window.ProtochainViewerHooks = hooks;

  // ---------------------------------------------------------------------------
  // 双向跳转（document 级事件委托，同 interface-jump-bridge 模式；不改动协议层面板）
  // ---------------------------------------------------------------------------
  if (typeof document !== 'undefined') {
    document.addEventListener('click', (ev) => {
      const t = ev.target;
      if (!t || typeof t.closest !== 'function') return;
      // 组件层：点组件列（优先于接口行——组件 span 嵌在行内）
      const compCell = t.closest('.comp-impl-component');
      if (compCell) {
        const box = compCell.closest('.component-panel');
        if (box) highlightComponent(box, compCell.getAttribute('data-component'));
        return;
      }
      // 组件层：点接口行 → 接口→组件+存储落点
      const implRow = t.closest('.comp-impl-row');
      if (implRow) {
        const box = implRow.closest('.component-panel');
        if (box) {
          highlightInterface(box, implRow.getAttribute('data-interface-id'), implRow.getAttribute('data-interface-name'));
        }
        return;
      }
      // 组件层：点拓扑节点 → 组件→承载接口
      const topoNode = t.closest('.comp-topo-node');
      if (topoNode) {
        const box = topoNode.closest('.component-panel');
        if (box) highlightComponent(box, topoNode.getAttribute('data-component'));
        return;
      }
      // 组件层：点接口契约卡片 → 接口→实现组件+存储落点+协议层高亮（T5a）
      const ctlCard = t.closest('.comp-ctl-card');
      if (ctlCard) {
        const box = ctlCard.closest('.component-panel');
        if (box) {
          highlightInterface(box, ctlCard.getAttribute('data-interface-id'), ctlCard.getAttribute('data-interface-name'));
        }
        return;
      }
      // 协议层：点接口名 → 跳组件层（实现组件 + 存储落点）
      const opName = t.closest('.proto-op-name');
      if (opName) {
        const opRow = opName.closest('.proto-op-row');
        const ifaceId = opRow && opRow.getAttribute('data-interface-id');
        const box = document.querySelector('.component-panel');
        if (box && ifaceId) {
          highlightInterface(box, ifaceId);
          opRow.classList.add('hl-comp'); // 协议层点击的接口行同步标记
        }
      }
    });
  }
})();
