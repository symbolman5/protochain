/**
 * viewer 协议层面板（G7-V4 · §11.3 协议模型视图）
 *
 * 数据源（全部查表、端内零推导，数据来自 data.json 的 V3+/V4 字段）：
 *  - dimensions[]：{owner, dimension, kind, kindSource, writers}（S1 维度 kind 判定投影）；
 *  - invariants[]：{id, name, expression, subject, dimensions[], timing, bound, remedy, level}（V4 不变量投影）；
 *  - modelRelations[]：{from, to, type, constraint, onGone}（V1 关系段投影）；
 *  - storage.entities[]：{entity, dimensionCount, dimensions[].{name,type,kind}}（S3 存储落点，实体卡片补充源）；
 *  - interfaces[]：{id, name, kind, triggerRoleId, precondition, invariantIds, sideEffects, postconditions}；
 *  - stateMachine.edges[].timing：时序约束（deadline 等，时间语义摘要条数据源）。
 *
 * 面板结构（§11.3 顺序）：
 *  ① 实体-维度卡片区：每实体一张卡（dimensions 按 owner 分组 + storage.entities 补充），
 *     卡片列维度/kind（declared 蓝 / observed 青着色）/值域/初始值；
 *     点任意维度 → 高亮引用它的全部 guard（interfaces[].precondition 含维度名）与不变量（invariants[].dimensions 含维度名）。
 *  ② 操作 × 不变量交叉面板：行=操作（角色+接口名+guard+作用实体），列=不变量；
 *     单元格 ● = interfaces[].invariantIds 显式命中；跨实体操作（作用实体 ≥2 个 owner）行上标注；
 *     点一条不变量 → 高亮它约束的操作（invariantIds 命中 ∪ 文本提及）与涉及的维度。
 *  ③ 时间语义摘要条：always / eventually_within 分布 + boundMs 一览 + 时序约束（edges[].timing）。
 *  ④ 关系图：modelRelations 列表（节点=实体，边=五种关系带 type 标签）。
 *
 * 降级：无新字段（老模型 data.json）→ 面板显式提示"无协议层数据"，不白屏不报错；
 * 部分字段缺失 → 对应区块显示空态。
 *
 * 边界（§11.3）：不做状态机图形；不做组件模型视图（缺口 #10 数据源属组件层）；不做跨协议 diff。
 */
(function () {
  'use strict';

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // ---------------------------------------------------------------------------
  // 数据提取（查表，端内零推导）
  // ---------------------------------------------------------------------------

  /** 维度名 → owner（dimensions 查表） */
  function buildDimOwnerMap(dims) {
    const map = new Map();
    for (const d of dims || []) {
      if (!map.has(d.dimension)) map.set(d.dimension, d.owner);
    }
    return map;
  }

  /** 操作的作用实体集合：sideEffects/postconditions/precondition 文本中出现的维度名 → owner 去重 */
  function entitySetOf(op, dims) {
    const texts = [];
    if (Array.isArray(op.sideEffects)) {
      for (const s of op.sideEffects) texts.push(s.description || s.kind || '');
    }
    if (Array.isArray(op.postconditions)) texts.push(...op.postconditions);
    if (typeof op.precondition === 'string') texts.push(op.precondition);
    const joined = texts.join('\n');
    const owners = new Set();
    for (const d of dims || []) {
      if (joined.includes(d.dimension)) owners.add(d.owner);
    }
    return [...owners].sort();
  }

  /** 操作文本是否提及不变量（invariantIds 之外的自然语言引用，如 "INV-2 标 always 的依据"） */
  function opTextsMentionInv(op, invId) {
    const texts = [];
    if (typeof op.precondition === 'string') texts.push(op.precondition);
    if (Array.isArray(op.postconditions)) texts.push(...op.postconditions);
    if (Array.isArray(op.sideEffects)) {
      for (const s of op.sideEffects) texts.push(s.description || s.kind || '');
    }
    if (Array.isArray(op.outputs)) {
      for (const o of op.outputs) texts.push(o.description || '');
    }
    return texts.join('\n').includes(invId);
  }

  /** 维度条目的值域/初始值（dimensions 条目可选字段 → storage 同名维度 type → '—'） */
  function dimRangeAndInitial(dim, storageDimByName) {
    let range = dim.type;
    let initial = dim.initial;
    if (range === undefined) {
      const t = storageDimByName.get(dim.dimension);
      if (t && t !== 'TODO' && t !== '') range = t;
    }
    if (range === undefined || range === null || range === '') range = '—';
    if (initial === undefined || initial === null || initial === '') initial = '—';
    return { range, initial };
  }

  // ---------------------------------------------------------------------------
  // 高亮联动（DOM 集合操作）
  // ---------------------------------------------------------------------------

  function clearProtocolHighlights(box) {
    box.querySelectorAll('.proto-dim-row.active').forEach((x) => x.classList.remove('active'));
    box.querySelectorAll('.proto-dim-row.hl-inv-dim').forEach((x) => x.classList.remove('hl-inv-dim'));
    box.querySelectorAll('.proto-op-row.hl-guard').forEach((x) => x.classList.remove('hl-guard'));
    box.querySelectorAll('.proto-op-row.hl-inv').forEach((x) => x.classList.remove('hl-inv'));
    box.querySelectorAll('.proto-inv-col.hl').forEach((x) => x.classList.remove('hl'));
    box.querySelectorAll('.proto-inv-col.active').forEach((x) => x.classList.remove('active'));
    box.querySelectorAll('.proto-cell.hl').forEach((x) => x.classList.remove('hl'));
  }

  // ---------------------------------------------------------------------------
  // 区块渲染
  // ---------------------------------------------------------------------------

  /** ① 实体-维度卡片区 */
  function renderEntityCards(box, data, dims) {
    const section = document.createElement('div');
    section.className = 'proto-section proto-entity-section';

    // 实体卡片：dimensions 按 owner 分组；storage.entities 补充（dimensions 无该 owner 时）
    const owners = [];
    const ownerDims = new Map(); // owner -> dim entries
    for (const d of dims || []) {
      if (!ownerDims.has(d.owner)) {
        ownerDims.set(d.owner, []);
        owners.push(d.owner);
      }
      ownerDims.get(d.owner).push(d);
    }
    const storageDimByName = new Map();
    for (const e of data.storage && data.storage.entities ? data.storage.entities : []) {
      for (const dd of e.dimensions || []) {
        if (!storageDimByName.has(dd.name)) storageDimByName.set(dd.name, dd.type);
      }
    }
    for (const e of data.storage && data.storage.entities ? data.storage.entities : []) {
      if (!ownerDims.has(e.entity)) {
        ownerDims.set(e.entity, []);
        owners.push(e.entity);
      }
    }
    const totalDims = (dims || []).length;
    const sub = document.createElement('div');
    sub.className = 'proto-section-title';
    sub.textContent = `① 实体-维度卡片区（实体 ${owners.length} · 维度 ${totalDims}）—— 点任意维度高亮引用它的 guard 与不变量`;
    section.appendChild(sub);

    if (owners.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'proto-empty';
      empty.textContent = '（无实体/维度数据：dimensions 与 storage.entities 均缺失）';
      section.appendChild(empty);
      box.appendChild(section);
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'proto-entity-grid';

    for (const owner of owners) {
      const entries = ownerDims.get(owner) || [];
      const card = document.createElement('div');
      card.className = 'proto-entity-card';
      card.setAttribute('data-entity', owner);
      const head = document.createElement('div');
      head.className = 'proto-entity-head';
      head.innerHTML = `<span class="proto-entity-name">${esc(owner)}</span><span class="proto-entity-count">${entries.length} 维度</span>`;
      card.appendChild(head);
      if (entries.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'proto-empty';
        empty.textContent = '（该实体无维度数据）';
        card.appendChild(empty);
      } else {
        for (const d of entries) {
          const { range, initial } = dimRangeAndInitial(d, storageDimByName);
          const row = document.createElement('div');
          row.className = 'proto-dim-row';
          row.setAttribute('data-dimension', d.dimension);
          row.setAttribute('data-owner', owner);
          row.title = `维度 ${d.dimension}（${owner}）——点击高亮引用它的 guard 与不变量`;
          row.innerHTML =
            `<span class="proto-dim-name">${esc(d.dimension)}</span>` +
            `<span class="proto-kind proto-kind-${esc(d.kind)}">${esc(d.kind)}</span>` +
            `<span class="proto-dim-range" title="值域">${esc(range)}</span>` +
            `<span class="proto-dim-initial" title="初始值">${esc(initial)}</span>`;
          row.addEventListener('click', () => {
            clearProtocolHighlights(box);
            row.classList.add('active');
            // guard 引用：interfaces[].precondition 含维度名
            const dimName = row.getAttribute('data-dimension');
            box.querySelectorAll('.proto-op-row').forEach((opRow) => {
              const guard = opRow.getAttribute('data-guard') || '';
              if (guard.includes(dimName)) opRow.classList.add('hl-guard');
            });
            // 不变量引用：invariants[].dimensions 含维度名
            box.querySelectorAll('.proto-inv-col').forEach((col) => {
              const dimsOfInv = (col.getAttribute('data-dims') || '').split('|');
              if (dimsOfInv.includes(dimName)) col.classList.add('hl');
            });
          });
          card.appendChild(row);
        }
      }
      grid.appendChild(card);
    }
    section.appendChild(grid);
    box.appendChild(section);
  }

  /** ③ 时间语义摘要条（§11.3 第 3 项；交叉面板之上先渲染，供②引用） */
  function renderTimingBar(box, data, invs) {
    const section = document.createElement('div');
    section.className = 'proto-section proto-timing-section';

    const sub = document.createElement('div');
    sub.className = 'proto-section-title';
    sub.textContent = '③ 时间语义摘要条（always / eventually_within 分布 + boundMs 一览 + 时序约束）';
    section.appendChild(sub);

    const bar = document.createElement('div');
    bar.className = 'proto-timing-bar';

    let always = 0;
    let ev = 0;
    const boundList = [];
    for (const inv of invs || []) {
      if (inv.timing === 'eventually_within') {
        ev += 1;
        boundList.push(`${inv.id} ≤${inv.bound !== undefined ? inv.bound : '?'}ms`);
      } else {
        always += 1;
      }
    }
    const chip = document.createElement('span');
    chip.className = 'proto-timing-chips';
    chip.innerHTML =
      `<span class="proto-timing-chip proto-timing-chip-always">always ${always}</span>` +
      `<span class="proto-timing-chip proto-timing-chip-ev">eventually_within ${ev}</span>`;
    bar.appendChild(chip);

    if (boundList.length > 0) {
      const bl = document.createElement('span');
      bl.className = 'proto-bound-list';
      bl.textContent = 'boundMs：' + boundList.join(' · ');
      bar.appendChild(bl);
    }

    // 时序约束（stateMachine.edges[].timing 查表，去重）
    const edgeTimings = new Map();
    for (const e of data.stateMachine && data.stateMachine.edges ? data.stateMachine.edges : []) {
      for (const t of e.timing || []) {
        if (!edgeTimings.has(t.id)) edgeTimings.set(t.id, t);
      }
    }
    if (edgeTimings.size > 0) {
      const et = document.createElement('span');
      et.className = 'proto-edge-timing';
      et.textContent =
        '时序约束：' +
        [...edgeTimings.values()]
          .map((t) => `${t.id} ${t.type}${t.boundMs !== undefined ? ' ' + t.boundMs + 'ms' : ''}`)
          .join(' · ');
      bar.appendChild(et);
    }

    section.appendChild(bar);
    box.appendChild(section);
    return section;
  }

  /** ② 操作 × 不变量交叉面板 */
  function renderCrossPanel(box, data, dims, invs) {
    const section = document.createElement('div');
    section.className = 'proto-section proto-cross-section';

    const sub = document.createElement('div');
    sub.className = 'proto-section-title';
    sub.textContent = `② 操作 × 不变量交叉面板（行=操作，列=不变量；●=invariantIds 显式关联；跨实体操作行上标注）`;
    section.appendChild(sub);

    if (!invs || invs.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'proto-empty';
      empty.textContent = '（无不变量数据：data.json 缺 invariants 字段，请重新运行 derive-web）';
      section.appendChild(empty);
      box.appendChild(section);
      return;
    }

    const ifaces = Array.isArray(data.interfaces) ? data.interfaces : [];

    const wrap = document.createElement('div');
    wrap.className = 'proto-cross-scroll';
    const table = document.createElement('table');
    table.className = 'proto-cross-table';

    // thead：操作头 + 每列一个不变量
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    const opHead = document.createElement('th');
    opHead.className = 'proto-op-head';
    opHead.textContent = '操作（角色 · 接口 · guard · 作用实体）';
    headRow.appendChild(opHead);
    for (const inv of invs) {
      const th = document.createElement('th');
      th.className = 'proto-inv-col';
      th.setAttribute('data-invariant-id', inv.id);
      th.setAttribute('data-dims', (inv.dimensions || []).join('|'));
      th.title = `${inv.name}：${inv.expression}`;
      th.innerHTML =
        `<span class="proto-inv-id">${esc(inv.id)}</span>` +
        `<span class="proto-inv-timing proto-inv-timing-${esc(inv.timing)}">${esc(inv.timing)}</span>`;
      th.addEventListener('click', () => {
        clearProtocolHighlights(box);
        th.classList.add('active');
        const invId = th.getAttribute('data-invariant-id');
        const invDims = (th.getAttribute('data-dims') || '').split('|').filter(Boolean);
        // 约束的操作：invariantIds 显式命中 ∪ 操作文本提及
        box.querySelectorAll('.proto-op-row').forEach((opRow) => {
          const iid = opRow.getAttribute('data-interface-id');
          const iface = ifaces.find((i) => i.id === iid);
          const explicit = iface && Array.isArray(iface.invariantIds) && iface.invariantIds.includes(invId);
          const mentioned = iface && opTextsMentionInv(iface, invId);
          if (explicit || mentioned) opRow.classList.add('hl-inv');
        });
        // 涉及的维度：invariants[].dimensions → 维度卡片行高亮
        box.querySelectorAll('.proto-dim-row').forEach((row) => {
          const dimName = row.getAttribute('data-dimension');
          if (invDims.includes(dimName)) row.classList.add('hl-inv-dim');
        });
        // 该列单元格高亮
        box.querySelectorAll(`.proto-cell[data-invariant-id="${invId}"]`).forEach((cell) => cell.classList.add('hl'));
      });
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    // tbody：每操作一行
    const tbody = document.createElement('tbody');
    for (const op of ifaces) {
      const entities = entitySetOf(op, dims);
      const cross = entities.length >= 2;
      const row = document.createElement('tr');
      row.className = 'proto-op-row' + (cross ? ' proto-op-cross' : '');
      row.setAttribute('data-interface-id', op.id);
      row.setAttribute('data-guard', typeof op.precondition === 'string' ? op.precondition : '');
      row.setAttribute('data-entities', entities.join('|'));

      const td = document.createElement('td');
      td.className = 'proto-op-cell';
      td.innerHTML =
        `<span class="proto-op-role">${esc(op.triggerRoleId || '—')}</span>` +
        `<span class="proto-op-name" title="${esc(op.id)}">${esc(op.name || op.id)}</span>` +
        (typeof op.precondition === 'string' && op.precondition
          ? `<span class="proto-op-guard" title="${esc(op.precondition)}">${esc(op.precondition)}</span>`
          : '') +
        `<span class="proto-op-ents">${entities.length > 0 ? '作用：' + esc(entities.join(', ')) : '作用：—'}</span>` +
        (cross ? `<span class="proto-cross-tag" title="作用实体跨 ≥2 个（${esc(entities.join(', '))}）">跨实体</span>` : '');
      row.appendChild(td);

      for (const inv of invs) {
        const cell = document.createElement('td');
        cell.className = 'proto-cell';
        cell.setAttribute('data-invariant-id', inv.id);
        if (Array.isArray(op.invariantIds) && op.invariantIds.includes(inv.id)) {
          const dot = document.createElement('span');
          dot.className = 'proto-cell-dot';
          dot.title = `${op.id} 显式关联 ${inv.id}`;
          cell.appendChild(dot);
        }
        row.appendChild(cell);
      }
      tbody.appendChild(row);
    }
    table.appendChild(tbody);

    wrap.appendChild(table);
    section.appendChild(wrap);
    box.appendChild(section);
  }

  /** ④ 关系图（modelRelations 列表：节点=实体，边=五种关系带 type 标签） */
  function renderRelations(box, rels) {
    const section = document.createElement('div');
    section.className = 'proto-section proto-relation-section';

    const sub = document.createElement('div');
    sub.className = 'proto-section-title';
    sub.textContent = `④ 关系图（modelRelations，${Array.isArray(rels) ? rels.length : 0} 条 · 节点=实体 · 边=关系带 type 标签）`;
    section.appendChild(sub);

    if (!Array.isArray(rels) || rels.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'proto-empty';
      empty.textContent = '（无关系数据：data.json 缺 modelRelations 字段）';
      section.appendChild(empty);
      box.appendChild(section);
      return;
    }

    // 节点：from/to 集合去重
    const nodeSet = new Set();
    for (const r of rels) {
      nodeSet.add(r.from);
      nodeSet.add(r.to);
    }
    const nodeRow = document.createElement('div');
    nodeRow.className = 'proto-rel-nodes';
    nodeRow.innerHTML = '<span class="proto-rel-nodes-label">节点：</span>';
    for (const n of [...nodeSet].sort()) {
      const chip = document.createElement('span');
      chip.className = 'proto-rel-node';
      chip.textContent = n;
      nodeRow.appendChild(chip);
    }
    section.appendChild(nodeRow);

    const list = document.createElement('div');
    list.className = 'proto-rel-list';
    for (const r of rels) {
      const row = document.createElement('div');
      row.className = 'proto-rel-row';
      row.setAttribute('data-from', r.from);
      row.setAttribute('data-to', r.to);
      row.innerHTML =
        `<span class="proto-rel-pair"><b>${esc(r.from)}</b> → <b>${esc(r.to)}</b></span>` +
        `<span class="proto-rel-type proto-rel-type-${esc(r.type)}">${esc(r.type)}</span>` +
        (r.constraint ? `<span class="proto-rel-constraint" title="${esc(r.constraint)}">${esc(r.constraint)}</span>` : '') +
        (r.onGone ? `<span class="proto-rel-ongone" title="${esc(r.onGone)}">onGone：${esc(r.onGone)}</span>` : '');
      list.appendChild(row);
    }
    section.appendChild(list);
    box.appendChild(section);
  }

  // ---------------------------------------------------------------------------
  // 面板渲染入口
  // ---------------------------------------------------------------------------
  function renderProtocolPanel(state, panels) {
    const data = state.dataJson;
    if (!data) return; // 未导入：主视图已有提示，协议层不重复
    if (panels.querySelector('.protocol-panel') || panels.querySelector('.protocol-empty')) return;

    const dims = Array.isArray(data.dimensions) ? data.dimensions : undefined;
    const invs = Array.isArray(data.invariants) ? data.invariants : undefined;
    const rels = Array.isArray(data.modelRelations) ? data.modelRelations : undefined;
    const hasStorageEnts = data.storage && Array.isArray(data.storage.entities) && data.storage.entities.length > 0;

    // 老模型（无任何协议层新字段）→ 显式缺省提示（不白屏不报错）
    if (!dims && !invs && !rels && !hasStorageEnts) {
      const p = document.createElement('div');
      p.className = 'panel-empty protocol-empty';
      p.textContent =
        '协议层面板：当前 data.json 无协议层数据（dimensions / invariants / modelRelations / storage，V3+ derive-web 产物）——请重新运行 derive-web 或导入新版 data.json';
      panels.appendChild(p);
      return;
    }

    const box = document.createElement('div');
    box.className = 'protocol-panel';

    const entityCount = new Set((dims || []).map((d) => d.owner)).size;
    const title = document.createElement('div');
    title.className = 'panel-subtitle';
    title.textContent =
      `协议层面板（§11.3 · 实体 ${entityCount} · 维度 ${(dims || []).length} · 不变量 ${(invs || []).length} · 关系 ${(rels || []).length}）`;
    box.appendChild(title);

    // ① 实体-维度卡片区
    renderEntityCards(box, data, dims);
    // ② 操作 × 不变量交叉面板
    renderCrossPanel(box, data, dims, invs);
    // ③ 时间语义摘要条
    renderTimingBar(box, data, invs);
    // ④ 关系图
    renderRelations(box, rels);

    panels.appendChild(box);
  }

  // ---------------------------------------------------------------------------
  // 注册（叠加到 renderAll 链尾；顺序在 relations / composition 之后）
  // ---------------------------------------------------------------------------
  const hooks = window.ProtochainViewerHooks || {};
  const prevRenderAll = hooks.renderAll;
  hooks.renderAll = function (state, panels) {
    if (prevRenderAll) prevRenderAll(state, panels);
    renderProtocolPanel(state, panels);
  };
  window.ProtochainViewerHooks = hooks;
})();
