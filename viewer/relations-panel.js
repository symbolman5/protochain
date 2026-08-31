/**
 * viewer 关系展示面板（W1-a 消费端 / 06-execution-T2 TB5）
 *
 * 数据源：data.json.relations（entries[] + sourceModelVersion，TB1 机械投影）。
 * 展示（全部原文查表、端内零推导）：
 *  - 四种 kind 过滤（sequence / causes_state_change / invariant_scope / timing）
 *    + degraded 标记 + 条目计数；
 *  - 条目展示两端元素（fromId → toId）与 derived-from 溯源；
 *  - 面板头部显示 relations 的 sourceModelVersion（与 N1 守卫同源复用）。
 *
 * 高亮联动（点击条目 → 主视图，查表）：
 *  - sequence：derivedFrom 恰为转移对 [Tm, Tn] → 高亮 2 条边；
 *  - causes_state_change：derivedFrom[0]（转移）→ 高亮该边 + toId 状态；
 *  - invariant_scope：scopeStateIds → 高亮这些状态；
 *  - timing：derivedFrom[0]（timingId）→ 高亮 edges[].timing 含该 id 的边。
 *
 * 边界（TB5）：不做接口级聚合视图（投影层不预聚合定案，viewer 端同样不聚合）；
 * 不做关系图布局（列表 + 高亮联动即满足"可展示"）；N1 反向 → 面板降级提示。
 */
(function () {
  'use strict';

  // 分层视图目标解析（R2b+）：view-tabs.js 加载且非项目模式 → 渲染进 #view-protocol；否则原 #panels（零回归）
  const viewBox = (window.ProtochainViewerTabs && window.ProtochainViewerTabs.viewBox) || ((p) => p);

  const KIND_LABEL = {
    sequence: '顺序前置',
    causes_state_change: '状态变更',
    invariant_scope: '不变量覆盖',
    timing: '时限',
  };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // ---------------------------------------------------------------------------
  // 高亮联动（查表：transitionId → 边；scopeStateIds → 状态）
  // ---------------------------------------------------------------------------
  function clearRelHighlights(svg) {
    if (!svg) return;
    svg.querySelectorAll('.sm-edge.rel-highlight').forEach((x) => x.classList.remove('rel-highlight'));
    svg.querySelectorAll('.sm-node-group.rel-highlight').forEach((x) => x.classList.remove('rel-highlight'));
  }

  function highlightEdgesByIds(svg, sm, transitionIds) {
    const ids = new Set(transitionIds);
    svg.querySelectorAll('.sm-edge').forEach((line) => {
      const tid = line.getAttribute('data-edge-id');
      if (tid && ids.has(tid)) line.classList.add('rel-highlight');
    });
  }

  function highlightStatesByIds(svg, stateIds) {
    const ids = new Set(stateIds);
    svg.querySelectorAll('.sm-node-group').forEach((g) => {
      const nid = g.getAttribute('data-node-id');
      if (nid && ids.has(nid)) g.classList.add('rel-highlight');
    });
  }

  function applyHighlight(svg, sm, entry) {
    clearRelHighlights(svg);
    if (!svg || !sm) return;
    if (entry.kind === 'sequence') {
      // derivedFrom 恰为转移对 → 高亮 2 条边（验收②）
      highlightEdgesByIds(svg, sm, entry.derivedFrom);
    } else if (entry.kind === 'causes_state_change') {
      highlightEdgesByIds(svg, sm, entry.derivedFrom);
      if (entry.toId) highlightStatesByIds(svg, [entry.toId]);
    } else if (entry.kind === 'invariant_scope') {
      if (entry.scopeStateIds) highlightStatesByIds(svg, entry.scopeStateIds);
    } else if (entry.kind === 'timing') {
      // 查表：edges[].timing 含该 timingId 的边
      const tid = entry.derivedFrom[0];
      const edgeIds = (sm.edges || [])
        .filter((e) => Array.isArray(e.timing) && e.timing.some((t) => t.id === tid))
        .map((e) => e.id);
      highlightEdgesByIds(svg, sm, edgeIds);
    }
  }

  // ---------------------------------------------------------------------------
  // 面板渲染
  // ---------------------------------------------------------------------------
  function renderRelations(state, panels) {
    const data = state.dataJson;
    const sm = data && data.stateMachine;
    if (!data || !sm) return;
    if (panels.querySelector('.relations-panel')) return;

    const rel = data.relations;
    if (!rel || !Array.isArray(rel.entries)) {
      // 旧版 data.json（无 relations 契约）→ 显式提示需增强数据
      const p = document.createElement('div');
      p.className = 'panel-empty relations-empty';
      p.textContent = '关系面板：当前增强数据不含 relations 契约（旧版 data.json），请重新运行 derive-web';
      panels.appendChild(p);
      return;
    }
    // N1 反向：增强数据过期 → 面板降级提示（验收④）
    if (state.n1 && state.n1.degraded) {
      const p = document.createElement('div');
      p.className = 'panel-empty relations-empty';
      p.textContent = '关系面板：增强数据与 model.md 版本不一致（N1 守卫），关系数据降级不可用';
      panels.appendChild(p);
      return;
    }

    const box = document.createElement('div');
    box.className = 'relations-panel';

    const title = document.createElement('div');
    title.className = 'panel-subtitle';
    title.textContent = `关系面板（W1-a relations 投影 · sourceModelVersion v${esc(rel.sourceModelVersion)}）`;
    box.appendChild(title);

    // 统计（与 entries 逐条一致，图例可数）
    const counts = {};
    let degradedCount = 0;
    for (const e of rel.entries) {
      counts[e.kind] = (counts[e.kind] || 0) + 1;
      if (e.degraded) degradedCount += 1;
    }

    // kind 过滤栏
    const filter = document.createElement('div');
    filter.className = 'relations-filter';
    const kinds = ['all', 'sequence', 'causes_state_change', 'invariant_scope', 'timing'];
    for (const k of kinds) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'relations-kind-btn' + (k === 'all' ? ' active' : '');
      btn.setAttribute('data-kind', k);
      btn.textContent = k === 'all' ? `全部 ${rel.entries.length}` : `${KIND_LABEL[k]} ${counts[k] || 0}`;
      btn.addEventListener('click', () => {
        filter.querySelectorAll('.relations-kind-btn').forEach((x) => x.classList.remove('active'));
        btn.classList.add('active');
        renderList(box, rel, sm, k, false);
      });
      filter.appendChild(btn);
    }
    const degBtn = document.createElement('button');
    degBtn.type = 'button';
    degBtn.className = 'relations-kind-btn relations-degraded-btn';
    degBtn.setAttribute('data-kind', 'degraded');
    degBtn.textContent = `degraded ${degradedCount}`;
    degBtn.addEventListener('click', () => {
      filter.querySelectorAll('.relations-kind-btn').forEach((x) => x.classList.remove('active'));
      degBtn.classList.add('active');
      renderList(box, rel, sm, 'all', true);
    });
    filter.appendChild(degBtn);
    box.appendChild(filter);

    // 条目列表容器
    const listBox = document.createElement('div');
    listBox.className = 'relations-list';
    box.appendChild(listBox);
    panels.appendChild(box);
    renderList(box, rel, sm, 'all', false);
  }

  function renderList(box, rel, sm, kind, onlyDegraded) {
    const listBox = box.querySelector('.relations-list');
    if (!listBox) return;
    listBox.innerHTML = '';
    const svg = document.querySelector('.sm-svg');
    let entries = rel.entries;
    if (kind !== 'all') entries = entries.filter((e) => e.kind === kind);
    if (onlyDegraded) entries = entries.filter((e) => e.degraded);
    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'panel-empty';
      empty.textContent = '（无匹配条目）';
      listBox.appendChild(empty);
      return;
    }
    for (const e of entries) {
      const item = document.createElement('div');
      item.className = 'relations-item' + (e.degraded ? ' relations-item-degraded' : '');
      item.setAttribute('data-kind', e.kind);
      let extra = '';
      if (e.kind === 'invariant_scope' && e.scopeStateIds) {
        extra = `<span class="rel-scope">覆盖 ${e.scopeStateIds.length} 状态</span>`;
      }
      if (e.kind === 'timing' && e.boundMs !== undefined) {
        extra = `<span class="rel-bound">≤${e.boundMs}ms</span>`;
      }
      if (e.degraded) {
        extra = `<span class="rel-degraded-tag" title="${esc(e.degradedReason || '')}">degraded</span>`;
      }
      item.innerHTML =
        `<span class="rel-kind rel-kind-${esc(e.kind)}">${esc(KIND_LABEL[e.kind] || e.kind)}</span>` +
        `<span class="rel-pair">${esc(e.fromId)} → ${esc(e.toId)}</span>` +
        extra +
        `<span class="rel-derived" title="derived-from 溯源">源自：${esc(e.derivedFrom.join(', '))}</span>`;
      item.addEventListener('click', () => {
        listBox.querySelectorAll('.relations-item').forEach((x) => x.classList.remove('active'));
        item.classList.add('active');
        applyHighlight(svg, sm, e);
      });
      listBox.appendChild(item);
    }
  }

  // ---------------------------------------------------------------------------
  // 注册（叠加到 renderAll 链）
  // ---------------------------------------------------------------------------
  const hooks = window.ProtochainViewerHooks || {};
  const prevRenderAll = hooks.renderAll;
  hooks.renderAll = function (state, panels) {
    panels = viewBox(panels, 'view-protocol');
    if (prevRenderAll) prevRenderAll(state, panels);
    renderRelations(state, panels);
  };
  window.ProtochainViewerHooks = hooks;
})();
