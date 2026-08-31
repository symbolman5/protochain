/**
 * viewer 用例路径回放面板（W3-e / 06-execution-T2 TB4）
 *
 * 数据源（TB2 契约核验结论：testCases/edges/edgeCoverage 零缺口）：
 *  - data.json.testCases[].stateIds / transitionIds / verificationPassed / verificationSkipped
 *    （buildTestCaseViews 已合并 verification caseResults，不另建数据源）；
 *  - stateMachine.edges（transitionId → action/from/to，查表）；
 *  - stateMachine.edgeCoverage（transitionId → pass/fail/uncovered，该步验证着色）。
 *
 * 回放语义：
 *  - 选一条用例 → 沿 stateIds/transitionIds 播放（步进/自动/暂停），初始态 → 终态；
 *  - 步数 = transitionIds.length + 1（初始态 + 每转移一步）；
 *  - 每步侧栏：当前状态、当前转移、action、该步验证着色状态——全部查表，端内零推导；
 *  - 主视图 SVG 高亮当前状态节点 + 当前转移边（路径原文播放，不重算路径）。
 *
 * 边界（TB4）：
 *  - 未导入/过期 data.json（N1）→ 回放不可用 + 显式提示（testCases 属增强数据，N1 联动）；
 *  - 不做多用例对比回放；deviations 展开为首版可选（不阻塞判据）。
 */
(function () {
  'use strict';

  // 分层视图目标解析（R2b+）：view-tabs.js 加载且非项目模式 → 渲染进 #view-protocol；否则原 #panels（零回归）
  const viewBox = (window.ProtochainViewerTabs && window.ProtochainViewerTabs.viewBox) || ((p) => p);

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // 查表：transitionId → edge（零推导）
  function edgeIndex(sm) {
    const idx = new Map();
    for (const e of sm.edges || []) idx.set(e.id, e);
    return idx;
  }

  function coverageLabel(st) {
    if (st === 'pass') return '通过';
    if (st === 'fail') return '失败';
    return '未覆盖';
  }

  function caseStatusLabel(tc) {
    if (tc.verificationSkipped) return '跳过';
    if (tc.verificationPassed === true) return '通过';
    if (tc.verificationPassed === false) return '失败';
    return '未验证';
  }

  // ---------------------------------------------------------------------------
  // 回放控制（步进 + 自动播放）
  // ---------------------------------------------------------------------------
  function buildReplayer(box, svg, edges, coverage, tc) {
    const stateIds = tc.stateIds || [];
    const transitionIds = tc.transitionIds || [];
    const maxStep = Math.max(0, stateIds.length - 1); // 最后一步 = 终态
    let step = 0;
    let timer = null;

    const side = box.querySelector('.replay-side');
    const stepLabel = box.querySelector('.replay-step-label');
    const btnPrev = box.querySelector('.replay-prev');
    const btnNext = box.querySelector('.replay-next');
    const btnPlay = box.querySelector('.replay-play');

    function clearSvgHighlight() {
      if (!svg) return;
      svg.querySelectorAll('.sm-node-group.highlight-pre, .sm-node-group.highlight-post, .sm-node-group.replay-now, .sm-edge.replay-now').forEach((x) => {
        x.classList.remove('highlight-pre', 'highlight-post', 'replay-now');
      });
    }

    function paint() {
      if (!svg) return;
      clearSvgHighlight();
      // 当前状态节点（stateIds[step]）
      const curId = stateIds[step];
      svg.querySelectorAll('.sm-node-group').forEach((g) => {
        if (g.getAttribute('data-node-id') === curId) g.classList.add('replay-now');
      });
      // 当前转移边（transitionIds[step-1]，查表高亮）
      if (step > 0) {
        const tid = transitionIds[step - 1];
        const edge = edges.get(tid);
        svg.querySelectorAll('.sm-edge').forEach((line) => {
          if (line.getAttribute('data-edge-id') === tid) line.classList.add('replay-now');
        });
        // 前置状态高亮（该转移 from 查表）
        if (edge) {
          for (const f of edge.from) {
            svg.querySelectorAll('.sm-node-group').forEach((g) => {
              if (g.getAttribute('data-node-id') === f) g.classList.add('highlight-pre');
            });
          }
        }
      }
    }

    function renderSide() {
      const curStateId = stateIds[step];
      let html = `<div class="detail-row"><span class="detail-label">步</span><span class="detail-value">${step + 1} / ${stateIds.length}</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">当前状态</span><span class="detail-value">${esc(curStateId)}</span></div>`;
      if (step > 0) {
        const tid = transitionIds[step - 1];
        const edge = edges.get(tid);
        const cov = coverage ? coverage[tid] : undefined;
        html += `<div class="detail-row"><span class="detail-label">转移</span><span class="detail-value">${esc(tid)}</span></div>`;
        if (edge) {
          html += `<div class="detail-row"><span class="detail-label">action</span><span class="detail-value">${esc(edge.action)}</span></div>`;
          html += `<div class="detail-row"><span class="detail-label">from</span><span class="detail-value">${esc(edge.from.join(', '))}</span></div>`;
          html += `<div class="detail-row"><span class="detail-label">to</span><span class="detail-value">${esc(edge.to)}</span></div>`;
        } else {
          html += `<div class="detail-row"><span class="detail-label">action</span><span class="detail-value">（edges 查表未命中）</span></div>`;
        }
        html += `<div class="detail-row"><span class="detail-label">该步验证着色</span><span class="detail-value">${esc(cov ? coverageLabel(cov) : '—')}</span></div>`;
      } else {
        html += `<div class="detail-row"><span class="detail-label">初始态</span><span class="detail-value">开始回放</span></div>`;
      }
      side.innerHTML = html;
      stepLabel.textContent = `${tc.id} · 步 ${step + 1}/${stateIds.length}`;
      paint();
    }

    function stopAuto() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
        btnPlay.textContent = '自动';
      }
    }

    function goto(s) {
      if (s < 0 || s > maxStep) return;
      step = s;
      renderSide();
    }

    btnPrev.addEventListener('click', () => { stopAuto(); goto(step - 1); });
    btnNext.addEventListener('click', () => { stopAuto(); goto(step + 1); });
    btnPlay.addEventListener('click', () => {
      if (timer !== null) { stopAuto(); return; }
      btnPlay.textContent = '暂停';
      timer = setInterval(() => {
        if (step >= maxStep) { stopAuto(); return; }
        step += 1;
        renderSide();
      }, 900);
    });

    renderSide();
    return { stopAuto };
  }

  // ---------------------------------------------------------------------------
  // 面板渲染
  // ---------------------------------------------------------------------------
  function renderReplay(state, panels) {
    const data = state.dataJson;
    const sm = data && data.stateMachine;
    if (!data || !sm || !sm.edges) {
      const p = document.createElement('div');
      p.className = 'panel-empty replay-empty';
      p.textContent = '用例路径回放：需增强数据（data.json 的 testCases/stateMachine.edges），请先导入 data.json';
      panels.appendChild(p);
      return;
    }
    // N1 反向：testCases 属增强数据，版本过期 → 回放不可用 + 显式提示（验收③）
    if (state.n1 && state.n1.degraded) {
      const p = document.createElement('div');
      p.className = 'panel-empty replay-empty';
      p.textContent = '用例路径回放：增强数据与 model.md 版本不一致（N1 守卫），回放不可用';
      panels.appendChild(p);
      return;
    }
    if (panels.querySelector('.replay-panel')) return;

    const testCases = Array.isArray(data.testCases) ? data.testCases : [];
    if (testCases.length === 0) {
      const p = document.createElement('div');
      p.className = 'panel-empty replay-empty';
      p.textContent = '用例路径回放：当前增强数据无 testCases（用例集），无可回放路径';
      panels.appendChild(p);
      return;
    }

    const box = document.createElement('div');
    box.className = 'replay-panel';
    const title = document.createElement('div');
    title.className = 'panel-subtitle';
    title.textContent = '用例路径回放（沿 stateIds/transitionIds 播放，零推导）';
    box.appendChild(title);

    // 用例列表
    const list = document.createElement('div');
    list.className = 'replay-case-list';
    for (const tc of testCases) {
      const item = document.createElement('div');
      item.className = 'replay-case-item';
      item.setAttribute('data-case-id', tc.id);
      item.innerHTML =
        `<span class="replay-case-id">${esc(tc.id)}</span>` +
        `<span class="replay-case-len">${tc.transitionIds.length} 步</span>` +
        `<span class="replay-case-status replay-status-${tc.verificationPassed === true ? 'pass' : tc.verificationPassed === false ? 'fail' : tc.verificationSkipped ? 'skip' : 'none'}">${caseStatusLabel(tc)}</span>`;
      item.addEventListener('click', () => {
        if (box._stopAuto) box._stopAuto();
        list.querySelectorAll('.replay-case-item').forEach((x) => x.classList.remove('active'));
        item.classList.add('active');
        // 重建回放器（替换既有）
        const old = box.querySelector('.replay-controls');
        if (old) old.remove();
        const ctl = buildControls(box, sm, tc);
        box.appendChild(ctl);
      });
      list.appendChild(item);
    }
    box.appendChild(list);

    // 占位控制区（选中用例后填充）
    const placeholder = document.createElement('div');
    placeholder.className = 'panel-empty';
    placeholder.textContent = '选择上方用例开始回放（步进/自动/暂停）';
    box.appendChild(placeholder);
    panels.appendChild(box);
  }

  /** 构造回放控制区（含步进侧栏） */
  function buildControls(box, sm, tc) {
    const ctl = document.createElement('div');
    ctl.className = 'replay-controls';
    ctl.innerHTML =
      `<div class="replay-bar">` +
      `<span class="replay-step-label">${esc(tc.id)}</span>` +
      `<button class="replay-prev" type="button">◀ 上一步</button>` +
      `<button class="replay-play" type="button">自动</button>` +
      `<button class="replay-next" type="button">下一步 ▶</button>` +
      `</div>` +
      `<div class="replay-side detail-box"></div>`;
    const svg = document.querySelector('.sm-svg');
    const replayer = buildReplayer(ctl, svg, edgeIndex(sm), sm.edgeCoverage, tc);
    ctl._stopAuto = () => replayer.stopAuto();
    box._stopAuto = () => replayer.stopAuto();
    return ctl;
  }

  // ---------------------------------------------------------------------------
  // 注册（叠加到 renderAll 链）
  // ---------------------------------------------------------------------------
  const hooks = window.ProtochainViewerHooks || {};
  const prevRenderAll = hooks.renderAll;
  hooks.renderAll = function (state, panels) {
    panels = viewBox(panels, 'view-protocol');
    if (prevRenderAll) prevRenderAll(state, panels);
    renderReplay(state, panels);
  };
  window.ProtochainViewerHooks = hooks;
})();
