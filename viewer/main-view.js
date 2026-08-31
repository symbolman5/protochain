/**
 * viewer ① 生命周期主视图（W3-b / 05-execution-T1 TA4；R2a 降为兼容层）
 *
 * R2a（§11.3 推翻重构）：协议层视图（protocol-panel.js）成为默认主界面，
 * 状态机转移图不再作为主展示形式。本文件保留对"声明状态机段"的老模型
 * （stateMachine.nodes 非空）渲染转移图的能力（G3/T2/T3/T4 既有行为零回归）；
 * 六张清单形态（无状态机轴，nodes/edges 为空）下不渲染转移图容器（R2a-4）。
 *
 * 布局 v2：终态节点（terminal / error）从主流程 level 摘出，统一放到主流程下方
 * 的"汇区"；到终态的边走正交折线（从源节点底部下行 → 汇区上方 y → 目标列 →
 * 上行到目标节点顶部），多个源到同一终态的边错开纵向偏移。多源转同目标不再
 * 横穿主流程。
 *
 * 消费 data.json 的 stateMachine.nodes/edges（TA1 W3-d 契约）渲染交互 SVG：
 * - 节点形态：initial 圆形 / terminal 双圆 / error 菱形 / normal 圆角矩形；
 * - 点击节点高亮 + 点击边显示详情（action/from/to/derived-from 溯源/guard
 *   schemaKind/degraded/timing——逐字段取自 data.json，端内零推导）；
 * - 图例读出状态数/边数（与契约一致，TA4 验收③）。
 *
 * 边界（TA4）：不做验证着色（TA5 ⑥ 消费 edgeCoverage）；不做接口联动（TA5 ③）。
 * 本文件在 app.js 之后加载，注册 window.ProtochainViewerHooks.renderAll。
 */
(function () {
  'use strict';

  // 分层视图目标解析（R2b+）：view-tabs.js 加载且非项目模式 → 渲染进 #view-protocol；否则原 #panels（零回归）
  const viewBox = (window.ProtochainViewerTabs && window.ProtochainViewerTabs.viewBox) || ((p) => p);

  const NS = 'http://www.w3.org/2000/svg';
  const SVG_MARGIN = { top: 30, left: 60, right: 60, bottom: 30 };
  const LEVEL_GAP = 170;
  const NODE_W = 150;
  const NODE_H = 44;
  const TERMINAL_BAND_GAP = 170; // 主流程底边到汇区节点顶边的距离（容纳 sink 入边 lane band）
  const SINK_LANE_SPACING = 14;   // 同一汇区目标上多源边的纵向错开间距

  // ---------------------------------------------------------------------------
  // 节点分类：normal-flow（参与分层） vs sink（汇入汇区，terminal/error）
  // ---------------------------------------------------------------------------
  function isSink(type) {
    return type === 'terminal' || type === 'error';
  }

  function classifyNodes(nodes) {
    const normal = [];
    const sink = [];
    for (const n of nodes) (isSink(n.type) ? sink : normal).push(n);
    return { normal, sink };
  }

  // ---------------------------------------------------------------------------
  // 机械布局：normal-flow 节点按最长路径分层；sink 节点水平均布于主流程下方
  // ---------------------------------------------------------------------------
  function computeLevelsForNormal(normalNodes, allEdges) {
    const levels = {};
    const isInitial = new Set(normalNodes.filter((n) => n.type === 'initial').map((n) => n.id));
    for (const n of normalNodes) levels[n.id] = n.type === 'initial' ? 0 : -1;
    // 迭代上限：最长路径 ≤ N-1；有环（如 S2→S1 回流）时提前停止，防死循环
    const maxIters = Math.max(normalNodes.length, 1);
    let changed = true;
    let iter = 0;
    while (changed && iter < maxIters) {
      changed = false;
      iter++;
      for (const e of allEdges) {
        // 跳过指向 sink 的边（sink 不在 normalNodes，level 不参与计算）
        if (!(e.to in levels)) continue;
        // 回边保护：指向 initial 节点的边不提升其 level（防 S1↔S2 环死循环）
        if (isInitial.has(e.to)) continue;
        for (const f of e.from) {
          if (levels[f] === undefined || levels[f] < 0) continue;
          const cur = levels[e.to] === undefined || levels[e.to] < 0 ? -1 : levels[e.to];
          if (levels[f] + 1 > cur) {
            levels[e.to] = levels[f] + 1;
            changed = true;
          }
        }
      }
    }
    for (const n of normalNodes) if (levels[n.id] < 0) levels[n.id] = 0;
    return levels;
  }

  function computePositions(nodes, edges) {
    const { normal, sink } = classifyNodes(nodes);
    const levels = computeLevelsForNormal(normal, edges);

    const byLevel = {};
    for (const n of normal) {
      const l = levels[n.id];
      (byLevel[l] = byLevel[l] || []).push(n);
    }
    const maxLevel = Math.max(0, ...Object.keys(byLevel).map(Number));
    const maxCountNormal = Math.max(1, ...Object.values(byLevel).map((arr) => arr.length));

    const mainWidth = SVG_MARGIN.left + maxLevel * LEVEL_GAP + NODE_W + SVG_MARGIN.right;
    const mainBandHeight = maxCountNormal * (NODE_H + 36);
    const sinkBandHeight = sink.length > 0 ? NODE_H + 36 : 0;
    const totalContentHeight = mainBandHeight + (sink.length > 0 ? TERMINAL_BAND_GAP + sinkBandHeight : 0);
    // 宽度：主流程宽度 与 sink 汇区需求宽度 取较大者。
    // sink 汇区右端让出 maxLevel 列（避免与最右主流程节点同列 → 折线退化成竖直线）。
    const sinkNeededWidth = sink.length > 0 ? 2 * SVG_MARGIN.left + sink.length * (NODE_W + 60) : 0;
    const width = Math.max(mainWidth, sinkNeededWidth, 720);
    const height = Math.max(240, SVG_MARGIN.top + totalContentHeight + SVG_MARGIN.bottom);
    // sink 可占用的水平跨度：优先避让 maxLevel 列（防止源/汇同列导致折线退化）；
    // 若避让后跨度不足以容纳全部 sink，则退化为在扩展后的宽度上均布。
    const levelMaxColX = SVG_MARGIN.left + maxLevel * LEVEL_GAP; // maxLevel 列左上 x
    let sinkSpan = Math.max(levelMaxColX - NODE_W / 2 - 24 - SVG_MARGIN.left - NODE_W, 0);
    const minSinkSpan = sink.length > 1 ? (sink.length - 1) * NODE_W : 0;
    if (sinkSpan < minSinkSpan) {
      sinkSpan = Math.max(width - 2 * SVG_MARGIN.left - NODE_W, minSinkSpan);
    }

    const normalRowCenterY = SVG_MARGIN.top + mainBandHeight / 2;
    const sinkRowCenterY = SVG_MARGIN.top + mainBandHeight + TERMINAL_BAND_GAP + sinkBandHeight / 2;
    const sinkRowTopY = sinkRowCenterY - NODE_H / 2;

    const pos = {};
    for (const [lStr, arr] of Object.entries(byLevel)) {
      const l = Number(lStr);
      const startY = normalRowCenterY - (arr.length * (NODE_H + 36)) / 2;
      arr.forEach((n, i) => {
        pos[n.id] = {
          x: SVG_MARGIN.left + l * LEVEL_GAP,
          y: startY + i * (NODE_H + 36),
          level: l,
          band: 'main',
        };
      });
    }
    // sink 节点：水平均布于汇区跨度（右端避让 maxLevel 列，防止源/汇同列导致折线退化）
    if (sink.length === 1) {
      pos[sink[0].id] = {
        x: SVG_MARGIN.left + sinkSpan / 2,
        y: sinkRowTopY,
        level: -1,
        band: 'sink',
      };
    } else if (sink.length > 1) {
      const step = sinkSpan / (sink.length - 1);
      sink.forEach((n, i) => {
        pos[n.id] = {
          x: SVG_MARGIN.left + i * step,
          y: sinkRowTopY,
          level: -1,
          band: 'sink',
        };
      });
    }

    return { pos, width, height, maxLevel, sinkRowTopY };
  }

  // ---------------------------------------------------------------------------
  // SVG 节点/边元素
  // ---------------------------------------------------------------------------
  function shapeFor(type) {
    return type === 'initial' ? 'circle' : type === 'terminal' ? 'double' : type === 'error' ? 'diamond' : 'rect';
  }

  function el(tag, attrs) {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, String(v));
    return node;
  }

  /** 渲染一个状态节点；返回中心坐标 + 上下边 y 供连边 */
  function renderNode(g, node, cx, cy) {
    const shape = shapeFor(node.type);
    const cxLabel = cx + NODE_W / 2;
    const cyLabel = cy + NODE_H / 2;
    if (shape === 'circle') {
      const r = NODE_H / 2;
      g.appendChild(el('circle', { cx: cxLabel, cy: cyLabel, r, class: 'sm-node sm-initial' }));
    } else if (shape === 'double') {
      const r = NODE_H / 2;
      g.appendChild(el('circle', { cx: cxLabel, cy: cyLabel, r: r - 4, class: 'sm-node sm-terminal' }));
      g.appendChild(el('circle', { cx: cxLabel, cy: cyLabel, r, class: 'sm-node-outer' }));
    } else if (shape === 'diamond') {
      const w = NODE_W * 0.55;
      const h = NODE_H;
      g.appendChild(el('polygon', {
        points: `${cx},${cyLabel} ${cx + w},${cy} ${cx + 2 * w},${cyLabel} ${cx + w},${cy + NODE_H}`,
        class: 'sm-node sm-error',
      }));
    } else {
      g.appendChild(el('rect', { x: cx, y: cy, width: NODE_W, height: NODE_H, rx: 10, class: 'sm-node sm-normal' }));
    }
    g.appendChild(el('text', { x: cxLabel, y: cyLabel + 5, 'text-anchor': 'middle', class: 'sm-node-label' }));
    g.lastChild.textContent = `${node.id} ${node.name}`;
    g.setAttribute('data-node-id', node.id);
    g.classList.add('sm-node-group');
    g.style.cursor = 'pointer';
    return { cx: cxLabel, cy: cyLabel, cxLeft: cx, cxRight: cx + NODE_W, cyTop: cy, cyBottom: cy + NODE_H };
  }

  /** 渲染一条边（from → to）；to 在 sink 汇区时走正交折线，否则走水平直线 */
  function renderEdge(g, edge, fromInfo, toInfo, edgeId, toNodePos, sinkLaneY) {
    if (toNodePos && toNodePos.band === 'sink') {
      const x1 = fromInfo.cx;
      const y1 = fromInfo.cyBottom;
      const x2 = toInfo.cx;
      const y2 = toInfo.cyTop;
      const laneY = sinkLaneY != null ? sinkLaneY : y2 - 14;
      const d = `M ${x1} ${y1} L ${x1} ${laneY} L ${x2} ${laneY} L ${x2} ${y2}`;
      const path = el('path', { d, class: 'sm-edge', 'data-edge-id': edgeId });
      path.setAttribute('marker-end', 'url(#sm-arrow)');
      path.classList.toggle('sm-edge-degraded', !!edge.degraded);
      g.appendChild(path);
      return path;
    }
    const x1 = fromInfo.cxRight;
    const y1 = fromInfo.cy;
    const x2 = toInfo.cxLeft;
    const y2 = toInfo.cy;
    const line = el('line', { x1, y1, x2, y2, class: 'sm-edge', 'data-edge-id': edgeId });
    line.setAttribute('marker-end', 'url(#sm-arrow)');
    line.classList.toggle('sm-edge-degraded', !!edge.degraded);
    g.appendChild(line);
    return line;
  }

  // ---------------------------------------------------------------------------
  // 详情面板（逐字段取自 data.json，零推导）
  // ---------------------------------------------------------------------------
  function fieldRow(label, value) {
    if (value === undefined || value === null || value === '') return '';
    const display = Array.isArray(value) ? value.join(', ') : String(value);
    return `<div class="detail-row"><span class="detail-label">${label}</span><span class="detail-value">${escapeHtml(display)}</span></div>`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function renderEdgeDetail(edge) {
    const rows = [
      fieldRow('转移 ID（derived-from）', edge.derivedFrom),
      fieldRow('action', edge.action),
      fieldRow('from', edge.from),
      fieldRow('to', edge.to),
      fieldRow('触发角色', edge.triggerRoleId),
      fieldRow('guard', edge.guard),
      fieldRow('guard schemaKind', edge.guardSchemaKind),
      fieldRow('degraded（异常路径）', edge.degraded ? '是' : '否'),
    ];
    if (edge.timing && edge.timing.length > 0) {
      rows.push(
        fieldRow(
          'timing',
          edge.timing.map((t) => `${t.id}(${t.type}${t.boundMs !== undefined ? ',' + t.boundMs + 'ms' : ''})`).join('；')
        )
      );
    }
    const title = `<div class="detail-title">边详情 · ${escapeHtml(edge.id)}</div>`;
    return `<div class="edge-detail">${title}${rows.join('')}</div>`;
  }

  // ---------------------------------------------------------------------------
  // 主视图渲染
  // ---------------------------------------------------------------------------
  function renderMain(state, panels) {
    const data = state.dataJson;
    const sm = data && data.stateMachine;
    if (!sm || !sm.nodes || !sm.edges) {
      const p = document.createElement('div');
      p.className = 'panel-empty';
      p.textContent = '① 主视图：请先导入 data.json（derive-web 产物，含 stateMachine.nodes/edges 契约）';
      panels.innerHTML = '';
      panels.appendChild(p);
      return;
    }
    // R2a（§11.3）：六张清单形态（无状态机轴，nodes/edges 为空）→ 不渲染转移图容器；
    // 协议层视图（protocol-panel.js）为默认主界面。老状态机模型（nodes 非空）走下方既有逻辑。
    if (Array.isArray(sm.nodes) && sm.nodes.length === 0 && Array.isArray(sm.edges) && sm.edges.length === 0) {
      const p = document.createElement('div');
      p.className = 'panel-empty sm-empty';
      p.textContent =
        '① 主视图：当前模型为六张清单形态（无状态机轴，不渲染转移图）——协议层主视图（实体-维度卡片 / 操作×不变量交叉 / 时间语义摘要 / 关系网络）为默认主界面';
      panels.innerHTML = '';
      panels.appendChild(p);
      return;
    }
    const { pos, width, height, sinkRowTopY } = computePositions(sm.nodes, sm.edges);
    // 图例 + 计数（TA4 验收③：状态数/边数从契约读出）
    const toolbar = document.createElement('div');
    toolbar.className = 'panel-toolbar';
    toolbar.innerHTML =
      `<span class="legend">` +
      `<span class="legend-item"><span class="swatch" style="background:#1f2733;border-radius:50%"></span>初始</span>` +
      `<span class="legend-item"><span class="swatch" style="background:#6b7686;border:3px solid #fff;box-shadow:0 0 0 1px #6b7686"></span>终态</span>` +
      `<span class="legend-item"><span class="swatch" style="background:#2f6fed"></span>普通</span>` +
      `<span class="legend-item"><span class="swatch" style="background:#cf222e;border-radius:0;transform:rotate(45deg) scale(0.7)"></span>异常</span>` +
      `</span>` +
      `<span class="legend">状态 <b>${sm.nodes.length}</b> · 转移 <b>${sm.edges.length}</b></span>`;
    panels.innerHTML = '';
    panels.appendChild(toolbar);

    const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, class: 'sm-svg', role: 'img' });
    svg.appendChild(
      el('defs', {}, [el('marker', {
        id: 'sm-arrow',
        viewBox: '0 0 10 10',
        refX: 9,
        refY: 5,
        markerWidth: 7,
        markerHeight: 7,
        orient: 'auto-start-reverse',
      }, [el('path', { d: 'M 0 0 L 10 5 L 0 10 z', class: 'sm-arrow-head' })])])
    );

    // 节点 → 渲染信息表（供连边）
    const centers = {};
    for (const n of sm.nodes) {
      const g = el('g');
      const info = renderNode(g, n, pos[n.id].x, pos[n.id].y);
      centers[n.id] = { ...info, band: pos[n.id].band };
      g.addEventListener('click', () => {
        svg.querySelectorAll('.sm-node-group').forEach((x) => x.classList.remove('selected'));
        g.classList.add('selected');
      });
      svg.appendChild(g);
    }

    // 边（多源边逐条渲染）
    // 预计算 sink 入边的 lane：按目标分组 → 目标内按源 x 从右到左分配 lane
    // （x 最大的源 lane 最低、最靠近终态，视觉呈单调阶梯、互不交叉）。
    const sinkLanes = new Map(); // key: `${edge.id}:${fromId}` -> laneY
    const sinkInbound = new Map(); // targetId -> [{ key, fromId, edge }]
    for (const edge of sm.edges) {
      const toPos = pos[edge.to];
      if (toPos && toPos.band === 'sink') {
        for (const fromId of edge.from) {
          const key = edge.id + ':' + fromId;
          if (!sinkInbound.has(edge.to)) sinkInbound.set(edge.to, []);
          sinkInbound.get(edge.to).push({ key, fromId });
        }
      }
    }
    let laneBase = sinkRowTopY - 14; // 汇区节点顶部上方第一条 lane
    const sinkTargets = [...sinkInbound.keys()].sort((a, b) => pos[a].x - pos[b].x);
    for (const targetId of sinkTargets) {
      const list = sinkInbound.get(targetId);
      // x 最大的源 → idx 0 → lane 最低（最贴近目标），避免与其它目标/主流程交叉
      list.sort((a, b) => centers[b.fromId].cx - centers[a.fromId].cx);
      list.forEach((item, idx) => {
        sinkLanes.set(item.key, laneBase - idx * SINK_LANE_SPACING);
      });
      laneBase -= list.length * SINK_LANE_SPACING + 16; // 不同目标之间留 16px 间隔
    }

    const edgeGroup = el('g');
    for (const edge of sm.edges) {
      const toPos = pos[edge.to];
      const isSinkTarget = toPos && toPos.band === 'sink';
      for (const fromId of edge.from) {
        const fp = centers[fromId];
        const tp = centers[edge.to];
        if (!fp || !tp) continue;
        const laneY = isSinkTarget ? sinkLanes.get(edge.id + ':' + fromId) : null;
        const elRef = renderEdge(edgeGroup, edge, fp, tp, edge.id, toPos, laneY);
        // 点击边 → 详情（TA4 验收②：逐字段显示，零推导）
        elRef.addEventListener('click', (ev) => {
          ev.stopPropagation();
          svg.querySelectorAll('.sm-edge').forEach((x) => x.classList.remove('selected'));
          elRef.classList.add('selected');
          const detail = renderEdgeDetail(edge);
          showDetail(panels, detail);
        });
      }
    }
    svg.appendChild(edgeGroup);

    // 详情占位
    const detailBox = document.createElement('div');
    detailBox.className = 'detail-box';
    detailBox.innerHTML = '<div class="detail-title">边详情</div><div class="detail-hint">点击图中的转移边查看详情（数据来自 data.json，端内零推导）</div>';
    panels.appendChild(svg);
    panels.appendChild(detailBox);

    function showDetail(panelsEl, html) {
      const box = panelsEl.querySelector('.detail-box');
      if (box) box.innerHTML = html;
    }
  }

  // ---------------------------------------------------------------------------
  // ③ 接口↔状态联动（TA5 填充占位）与 ⑥ 着色（TA5 填充占位）
  // ---------------------------------------------------------------------------
  function renderLinks(_state, _panels) {
    /* TA5 */
  }
  function renderCoverage(_state, _panels) {
    /* TA5 */
  }

  window.ProtochainViewerHooks = {
    renderAll(state, panels) {
      panels = viewBox(panels, 'view-protocol');
      renderMain(state, panels);
      renderLinks(state, panels);
      renderCoverage(state, panels);
    },
  };
})();
