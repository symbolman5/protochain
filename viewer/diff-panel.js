/**
 * viewer ⑦ 演进 diff 面板（W3-f / 07-execution-T3 TC9）
 *
 * 数据源：data.json.diffView（工具链机械投影：变更状态/转移集合 + 受影响接口/用例清单）。
 * 展示（全部查表、端内零推导）：
 *  - 变更状态/转移在主视图 SVG 高亮（diff-highlight 类，集合 = diffView 查表）；
 *  - 受影响接口/用例清单 + 计数（图例可数，计数 = diffView 列表长度）；
 *  - 无 diffView → 显式提示"无 diff 数据"（不白屏、不端内计算 diff）。
 *
 * 边界（TC9 最小口径）：不做多版本历史 / diff 时间轴；不做跨协议 diff 分析（E9 边界）。
 */
(function () {
  'use strict';

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // ---------------------------------------------------------------------------
  // 高亮（查表：changedTransitions → 边；changedStates → 节点）
  // ---------------------------------------------------------------------------
  function applyDiffHighlight(svg, diffView) {
    if (!svg || !diffView) return;
    svg.querySelectorAll('.sm-edge.diff-highlight').forEach((x) => x.classList.remove('diff-highlight'));
    svg.querySelectorAll('.sm-node-group.diff-highlight').forEach((x) => x.classList.remove('diff-highlight'));
    const transitions = new Set(diffView.changedTransitions || []);
    const states = new Set(diffView.changedStates || []);
    svg.querySelectorAll('.sm-edge').forEach((line) => {
      const tid = line.getAttribute('data-edge-id');
      if (tid && transitions.has(tid)) line.classList.add('diff-highlight');
    });
    svg.querySelectorAll('.sm-node-group').forEach((g) => {
      const nid = g.getAttribute('data-node-id');
      if (nid && states.has(nid)) g.classList.add('diff-highlight');
    });
  }

  function clearDiffHighlight(svg) {
    if (!svg) return;
    svg.querySelectorAll('.sm-edge.diff-highlight').forEach((x) => x.classList.remove('diff-highlight'));
    svg.querySelectorAll('.sm-node-group.diff-highlight').forEach((x) => x.classList.remove('diff-highlight'));
  }

  // ---------------------------------------------------------------------------
  // 面板渲染
  // ---------------------------------------------------------------------------
  function renderDiffPanel(state, panels) {
    const data = state.dataJson;
    const sm = data && data.stateMachine;
    if (!data || !sm) return;
    if (panels.querySelector('.diff-panel')) return;

    const diffView = data.diffView;
    const box = document.createElement('div');
    box.className = 'diff-panel';

    if (!diffView || !Array.isArray(diffView.changedTransitions)) {
      // 无 diff 数据 → 显式提示（不端内计算）
      const p = document.createElement('div');
      p.className = 'panel-empty diff-empty';
      p.textContent = '⑦ diff 面板：当前 data.json 无 diffView 数据。请对 v1→v2 模型改动运行 protochain diff/impact 后重新 derive-web（viewer 不做端内 diff 计算）';
      box.appendChild(p);
      panels.appendChild(box);
      return;
    }

    const title = document.createElement('div');
    title.className = 'panel-subtitle';
    title.textContent = `⑦ 演进 diff（diffView 机械投影）`;
    box.appendChild(title);

    // 图例可数：计数 = diffView 列表长度
    const summary = document.createElement('div');
    summary.className = 'diff-summary';
    summary.innerHTML =
      `<span class="legend">变更转移 <b>${diffView.changedTransitions.length}</b></span>` +
      `<span class="legend">变更状态 <b>${diffView.changedStates.length}</b></span>` +
      `<span class="legend">受影响接口 <b>${diffView.affectedInterfaces.length}</b></span>` +
      `<span class="legend">受影响用例 <b>${diffView.affectedCases.length}</b></span>` +
      (diffView.summary ? `<span class="diff-summary-text" title="${esc(diffView.summary)}">摘要：${esc(diffView.summary)}</span>` : '');
    box.appendChild(summary);

    // 高亮控制
    const controls = document.createElement('div');
    controls.className = 'diff-controls';
    const hlBtn = document.createElement('button');
    hlBtn.type = 'button';
    hlBtn.className = 'diff-hl-btn';
    hlBtn.textContent = '高亮变更元素';
    hlBtn.addEventListener('click', () => {
      applyDiffHighlight(document.querySelector('.sm-svg'), diffView);
    });
    const clrBtn = document.createElement('button');
    clrBtn.type = 'button';
    clrBtn.className = 'diff-clr-btn';
    clrBtn.textContent = '清除高亮';
    clrBtn.addEventListener('click', () => {
      clearDiffHighlight(document.querySelector('.sm-svg'));
    });
    controls.appendChild(hlBtn);
    controls.appendChild(clrBtn);
    box.appendChild(controls);

    // 受影响接口/用例清单（查表显示）
    const affected = document.createElement('div');
    affected.className = 'diff-affected';
    const ifaceHtml = diffView.affectedInterfaces.length > 0
      ? `<div class="diff-block-title">受影响接口</div><div class="diff-chips">${diffView.affectedInterfaces.map((i) => `<span class="diff-chip">${esc(i)}</span>`).join('')}</div>`
      : `<div class="diff-block-title">受影响接口</div><div class="diff-none">（无）</div>`;
    const caseHtml = diffView.affectedCases.length > 0
      ? `<div class="diff-block-title">受影响用例</div><div class="diff-chips">${diffView.affectedCases.map((c) => `<span class="diff-chip">${esc(c)}</span>`).join('')}</div>`
      : `<div class="diff-block-title">受影响用例</div><div class="diff-none">（无）</div>`;
    const changedHtml = diffView.changedTransitions.length > 0
      ? `<div class="diff-block-title">变更转移</div><div class="diff-chips">${diffView.changedTransitions.map((t) => `<span class="diff-chip">${esc(t)}</span>`).join('')}</div>`
      : '';
    affected.innerHTML = changedHtml + ifaceHtml + caseHtml;
    box.appendChild(affected);

    panels.appendChild(box);

    // 渲染后自动高亮（集合 = diffView 查表）
    applyDiffHighlight(document.querySelector('.sm-svg'), diffView);
  }

  // ---------------------------------------------------------------------------
  // 注册（叠加到 renderAll 链；顺序在 relations 之后）
  // ---------------------------------------------------------------------------
  const hooks = window.ProtochainViewerHooks || {};
  const prevRenderAll = hooks.renderAll;
  hooks.renderAll = function (state, panels) {
    if (prevRenderAll) prevRenderAll(state, panels);
    renderDiffPanel(state, panels);
  };
  window.ProtochainViewerHooks = hooks;
})();
