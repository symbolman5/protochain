/**
 * viewer ② 角色泳道面板 + 约束承载联动（W3-e / 06-execution-T2 TB3）
 *
 * 数据源（TB2 契约，全部查表、端内零推导）：
 *  - data.json.protocol.roles（泳道顺序与 id）；
 *  - data.json.stateMachine.nodes[].roleIds（落道 = 单字段查表：多角色状态落首
 *    roleId 道、详情显示全部 roleIds；无 roleIds 状态落"公共"道）；
 *  - data.json.stateMachine.invariantScope（invariantId → { name, scopeStateIds,
 *    carrierRoleIds }，TB2 已把"不变量 × 状态 × 角色"的跨元素聚合上移工具链）。
 *
 * 约束承载联动（直接回答"该约束由哪个角色/状态承载"）：
 *  点击 invariantScope 条目 → 高亮其 scope 状态（节点）及所在泳道（carrierRoleIds
 *  对应行），高亮集合 = 查表 scopeStateIds / carrierRoleIds，无错位。
 *
 * 边界（TB3）：
 *  - N1 不匹配 → invariantScope 联动不渲染 + 降级提示（对齐 TA3 守卫）；
 *  - 未导入 data.json → 泳道视图显式提示"需增强数据"（不白屏、不端内降级凑数）；
 *  - 不做泳道间的时序线（⑤ 视角，未排期）；无框架、无运行时依赖。
 */
(function () {
  'use strict';

  // 分层视图目标解析（R2b+）：view-tabs.js 加载且非项目模式 → 渲染进 #view-protocol；否则原 #panels（零回归）
  const viewBox = (window.ProtochainViewerTabs && window.ProtochainViewerTabs.viewBox) || ((p) => p);

  const COMMON_ROLE = '__common__';
  const COMMON_LABEL = '公共';

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // ---------------------------------------------------------------------------
  // 泳道布局（角色顺序分道；节点按 roleIds 落道 = 单字段查表）
  // ---------------------------------------------------------------------------
  function buildLanes(roles, nodes) {
    // 泳道顺序：roles 原序 + 末尾公共道（全部渲染——carrierRoleIds 高亮需覆盖
    // 空泳道，且"按 roles 顺序分道"语义要求每角色一道）
    const laneOrder = roles.map((r) => r.id);
    const lanes = new Map();
    for (const r of roles) lanes.set(r.id, { label: r.name, nodes: [] });
    lanes.set(COMMON_ROLE, { label: COMMON_LABEL, nodes: [] });
    for (const n of nodes) {
      const roleIds = Array.isArray(n.roleIds) && n.roleIds.length > 0 ? n.roleIds : [];
      const laneId = roleIds.length > 0 ? roleIds[0] : COMMON_ROLE;
      const lane = lanes.get(laneId);
      if (lane) lane.nodes.push({ node: n, allRoleIds: roleIds });
    }
    const visible = laneOrder.map((rid) => ({ rid, lane: lanes.get(rid) }));
    const common = lanes.get(COMMON_ROLE);
    if (common && common.nodes.length > 0) {
      visible.push({ rid: COMMON_ROLE, lane: common });
    }
    return visible;
  }

  // ---------------------------------------------------------------------------
  // 约束承载联动（全部查表；N1 降级时联动不渲染）
  // ---------------------------------------------------------------------------
  function clearScopeHighlights(container) {
    container.querySelectorAll('.lane-row.scope-highlight').forEach((x) => x.classList.remove('scope-highlight'));
    container.querySelectorAll('.lane-node.scope-highlight').forEach((x) => x.classList.remove('scope-highlight'));
    container.querySelectorAll('.invariant-item.active').forEach((x) => x.classList.remove('active'));
  }

  function highlightScope(container, entry) {
    clearScopeHighlights(container);
    // 高亮泳道集合 = carrierRoleIds（查表）
    const carrier = new Set(entry.carrierRoleIds);
    container.querySelectorAll('.lane-row').forEach((row) => {
      const rid = row.getAttribute('data-role-id');
      if (rid && carrier.has(rid)) row.classList.add('scope-highlight');
    });
    // 高亮状态集合 = scopeStateIds（查表）
    const scope = new Set(entry.scopeStateIds);
    container.querySelectorAll('.lane-node').forEach((node) => {
      const nid = node.getAttribute('data-node-id');
      if (nid && scope.has(nid)) node.classList.add('scope-highlight');
    });
  }

  // ---------------------------------------------------------------------------
  // 泳道面板渲染
  // ---------------------------------------------------------------------------
  function renderSwimlanes(state, panels) {
    const data = state.dataJson;
    const sm = data && data.stateMachine;
    if (!data || !sm || !sm.nodes) {
      // 未导入 data.json → 显式提示"需增强数据"（不白屏、不凑数）
      const p = document.createElement('div');
      p.className = 'panel-empty lane-empty';
      p.textContent = '② 角色泳道：需增强数据（data.json 的 stateMachine.nodes/roles/invariantScope），请先导入 data.json';
      panels.appendChild(p);
      return;
    }
    if (panels.querySelector('.lane-panel')) return; // 已渲染

    const roles = (data.protocol && data.protocol.roles) || [];
    const lanes = buildLanes(roles, sm.nodes);

    const box = document.createElement('div');
    box.className = 'lane-panel';

    const title = document.createElement('div');
    title.className = 'panel-subtitle';
    title.textContent = '② 角色泳道（按 StateDef.roleIds 落道，零推导）';
    box.appendChild(title);

    // 泳道容器
    const laneBox = document.createElement('div');
    laneBox.className = 'lane-container';
    for (const { rid, lane } of lanes) {
      const row = document.createElement('div');
      row.className = 'lane-row' + (rid === COMMON_ROLE ? ' lane-common' : '');
      row.setAttribute('data-role-id', rid);
      const label = document.createElement('div');
      label.className = 'lane-role';
      label.textContent = lane.label;
      row.appendChild(label);
      const nodesBox = document.createElement('div');
      nodesBox.className = 'lane-nodes';
      if (lane.nodes.length === 0) {
        const empty = document.createElement('span');
        empty.className = 'lane-empty-hint';
        empty.textContent = '（无状态）';
        nodesBox.appendChild(empty);
      } else {
        for (const { node, allRoleIds } of lane.nodes) {
          const n = document.createElement('div');
          n.className = 'lane-node';
          n.setAttribute('data-node-id', node.id);
          n.textContent = `${node.id} ${node.name}`;
          // 多角色状态：详情显示全部 roleIds（title 提示，零推导）
          if (allRoleIds.length > 1) {
            n.title = `roles: ${allRoleIds.join(', ')}`;
            n.classList.add('lane-node-multi');
          }
          nodesBox.appendChild(n);
        }
      }
      row.appendChild(nodesBox);
      laneBox.appendChild(row);
    }
    box.appendChild(laneBox);

    // 约束承载联动列表
    const invTitle = document.createElement('div');
    invTitle.className = 'panel-subtitle';
    invTitle.textContent = '约束承载联动（点击条目高亮 scope 状态与承载泳道）';
    box.appendChild(invTitle);

    const invScope = sm.invariantScope;
    if (state.n1 && state.n1.degraded) {
      // N1 反向：联动不渲染 + 降级提示（验收③；先于 invScope 存在性判断）
      const note = document.createElement('div');
      note.className = 'coverage-legend-note';
      note.textContent = '② 约束承载联动已降级：增强数据与 model.md 版本不一致（N1 守卫），不渲染 invariantScope 联动';
      box.appendChild(note);
    } else if (invScope && Object.keys(invScope).length > 0) {
      const list = document.createElement('div');
      list.className = 'invariant-scope-list';
      for (const [invId, entry] of Object.entries(invScope)) {
        const item = document.createElement('div');
        item.className = 'invariant-item';
        item.setAttribute('data-invariant-id', invId);
        item.innerHTML =
          `<span class="inv-name">${esc(invId)} ${esc(entry.name)}</span>` +
          `<span class="inv-meta">承载：${esc(entry.carrierRoleIds.join(', ') || '—')} · 覆盖 ${entry.scopeStateIds.length} 状态</span>`;
        item.addEventListener('click', () => highlightScope(box, entry));
        list.appendChild(item);
      }
      box.appendChild(list);
    } else {
      const note = document.createElement('div');
      note.className = 'coverage-legend-note';
      note.textContent = '② 当前增强数据不含 invariantScope（旧版 data.json），约束承载联动不可用';
      box.appendChild(note);
    }

    panels.appendChild(box);
  }

  // ---------------------------------------------------------------------------
  // 注册（叠加到 renderAll 链）
  // ---------------------------------------------------------------------------
  const hooks = window.ProtochainViewerHooks || {};
  const prevRenderAll = hooks.renderAll;
  hooks.renderAll = function (state, panels) {
    panels = viewBox(panels, 'view-protocol');
    if (prevRenderAll) prevRenderAll(state, panels);
    renderSwimlanes(state, panels);
  };
  window.ProtochainViewerHooks = hooks;
})();
