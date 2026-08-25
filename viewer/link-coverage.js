/**
 * viewer ③ 接口↔状态联动 + ⑥ edgeCoverage 着色（W3-c / 05-execution-T1 TA5）
 *
 * ③ 接口列表↔状态高亮联动（建模者调试）：
 *   - 数据源：data.json.interfaces + stateMachine.edges；
 *   - 机械映射：接口 action（interface.name）=== 转移边 action（edge.action）；
 *   - 点击接口 → 高亮该接口触发的转移边 + 前置状态（from[]，蓝）/后置状态（to，绿）；
 *   - 无匹配边的接口（如观测接口）→ 尝试按状态 ID/名匹配节点，仍无 → 提示不参与联动。
 *
 * ⑥ 验证着色（建模者调试）：
 *   - 数据源：stateMachine.edgeCoverage（transitionId → pass/fail/uncovered，TA1 契约）；
 *   - 边着色：pass 绿 / fail 红 / uncovered 黄虚线；图例计数与 edgeCoverage 统计一致；
 *   - N1 触发（state.n1.degraded）→ 降级不着色 + 显式提示（与 TA3 守卫联动）。
 *
 * 边界（TA5）：verification-report.json 不参与着色（NR3-1 定案：唯一数据源 data.json）；
 * viewer 端零推导——所有字段直接取自 data.json。
 */
(function () {
  'use strict';

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // ---------------------------------------------------------------------------
  // ③ 接口列表 + 联动
  // ---------------------------------------------------------------------------
  function renderLinks(state, panels) {
    const data = state.dataJson;
    if (!data || !Array.isArray(data.interfaces) || data.interfaces.length === 0) return;
    if (panels.querySelector('.iface-panel')) return; // 已渲染

    const box = document.createElement('div');
    box.className = 'iface-panel';
    const title = document.createElement('div');
    title.className = 'panel-subtitle';
    title.textContent = '③ 接口 ↔ 状态联动（点击接口高亮前置/后置状态）';
    box.appendChild(title);
    const list = document.createElement('div');
    list.className = 'iface-list';
    for (const iface of data.interfaces) {
      const item = document.createElement('div');
      item.className = 'iface-item';
      item.dataset.ifaceId = iface.id;
      item.innerHTML =
        `<span class="iface-id">${esc(iface.id)}</span><span class="iface-kind">${esc(iface.kind)}</span>` +
        `<div class="iface-name">${esc(iface.name)}</div>`;
      item.addEventListener('click', () => highlightInterface(iface, item));
      list.appendChild(item);
    }
    box.appendChild(list);
    panels.prepend(box);
  }

  /** ③ 点击接口 → 高亮（机械映射，端内零推导） */
  function highlightInterface(iface, item) {
    const svg = document.querySelector('.sm-svg');
    if (!svg) return;
    // 清除既有高亮
    svg.querySelectorAll('.sm-node-group').forEach((g) => {
      g.classList.remove('highlight-pre', 'highlight-post', 'linked');
    });
    svg.querySelectorAll('.sm-edge.highlight').forEach((e) => e.classList.remove('highlight'));
    panelsQuery('.iface-item.active')?.classList.remove('active');
    item.classList.add('active');

    const data = window.ProtochainViewer.state.dataJson;
    const sm = data && data.stateMachine;
    if (!sm || !sm.edges) return;
    // 机械映射：接口 action === 转移边 action
    const edges = sm.edges.filter((e) => e.action === iface.name);
    const pre = new Set();
    const post = new Set();
    for (const e of edges) {
      for (const f of e.from) pre.add(f);
      post.add(e.to);
    }
    // 无匹配边 → 尝试状态 ID/名匹配（观测接口常见）；仍无 → 提示
    if (edges.length === 0) {
      const node = sm.nodes.find((n) => n.id === iface.name || n.name === iface.name);
      if (node) {
        pre.add(node.id);
        post.add(node.id);
      } else {
        const hint = document.createElement('div');
        hint.className = 'coverage-legend-note';
        hint.textContent = `接口 ${iface.id}（${iface.name}）无匹配转移边，不参与联动`;
        const box = panelsQuery('.iface-panel');
        if (box && !box.querySelector('.no-link-note')) {
          hint.className += ' no-link-note';
          box.appendChild(hint);
        }
        return;
      }
    }
    // 高亮节点 + 边
    svg.querySelectorAll('.sm-node-group').forEach((g) => {
      const id = g.getAttribute('data-node-id');
      if (pre.has(id)) g.classList.add('highlight-pre', 'linked');
      if (post.has(id)) g.classList.add('highlight-post', 'linked');
    });
    svg.querySelectorAll('.sm-edge').forEach((line) => {
      const tid = line.getAttribute('data-edge-id');
      const edge = sm.edges.find((e) => e.id === tid);
      if (edge && edges.includes(edge)) line.classList.add('highlight');
    });
  }

  function panelsQuery(sel) {
    const panels = document.querySelector('#panels');
    return panels ? panels.querySelector(sel) : null;
  }

  // ---------------------------------------------------------------------------
  // ⑥ edgeCoverage 着色 + 图例计数
  // ---------------------------------------------------------------------------
  function renderCoverage(state, panels) {
    const data = state.dataJson;
    const sm = data && data.stateMachine;
    const svg = panels.querySelector('.sm-svg');
    if (!sm || !sm.edgeCoverage || !svg) return;

    // N1 降级：不着色 + 显式提示（TA5 验收③ / 与 TA3 守卫联动）
    if (state.n1 && state.n1.degraded) {
      const note = document.createElement('div');
      note.className = 'coverage-legend-note';
      note.textContent = '⑥ 验证着色已降级：增强数据与 model.md 版本不一致（N1 守卫），暂不着色';
      panels.appendChild(note);
      return;
    }

    // 统计（与 edgeCoverage 逐值一致，图例可数）
    const counts = { pass: 0, fail: 0, uncovered: 0 };
    for (const v of Object.values(sm.edgeCoverage)) {
      if (v in counts) counts[v]++;
    }
    // 边着色
    svg.querySelectorAll('.sm-edge').forEach((line) => {
      const tid = line.getAttribute('data-edge-id');
      const st = sm.edgeCoverage[tid];
      if (st === 'pass' || st === 'fail' || st === 'uncovered') {
        line.classList.add('coverage-' + st);
      }
    });
    // 图例计数（追加到工具栏）
    const legend = document.createElement('span');
    legend.className = 'legend';
    legend.innerHTML =
      `<span class="legend-item"><span class="swatch" style="background:var(--pass)"></span>通过 ${counts.pass}</span>` +
      `<span class="legend-item"><span class="swatch" style="background:var(--fail)"></span>失败 ${counts.fail}</span>` +
      `<span class="legend-item"><span class="swatch" style="background:var(--uncovered);border-radius:50%"></span>未覆盖 ${counts.uncovered}</span>`;
    const toolbar = panels.querySelector('.panel-toolbar');
    if (toolbar) toolbar.appendChild(legend);
  }

  // 注册（main-view.js 已建 hooks 对象；此处叠加 TA5 渲染）
  const hooks = window.ProtochainViewerHooks || {};
  const prevRenderAll = hooks.renderAll;
  hooks.renderAll = function (state, panels) {
    if (prevRenderAll) prevRenderAll(state, panels);
    renderLinks(state, panels);
    renderCoverage(state, panels);
  };
  window.ProtochainViewerHooks = hooks;
})();
