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
      '.comp-impl-row.hl, .comp-storage-row.hl, .comp-topo-node.hl, .comp-transfer-row.hl, .comp-impl-component.hl'
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
  // 面板渲染入口
  // ---------------------------------------------------------------------------
  function renderComponentPanel(state, panels) {
    const data = state.dataJson;
    if (!data) return; // 未导入：主视图已有提示，组件层不重复
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
