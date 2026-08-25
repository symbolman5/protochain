/**
 * viewer 组合层面板（W3-f / 07-execution-T3 TC8）
 *
 * 数据源：组合层 data.json（derive-web --project 产物，schemaVersion='1.1'；
 * 与单协议 data.json（schemaVersion=1.0）区分识别）。
 *
 * 渲染（全部查表、端内零推导）：
 *  - 协议节点（protocols[].id/name/version）；
 *  - 依赖边（dependencyGraph.edges[]，from→to + dependencyType）；
 *  - 跨协议引用边（crossRefs[]，fromProtocol→toProtocol + kind/target/context）；
 *  - 跨协议不变量覆盖（invariantSpans[]，id + 覆盖协议集合）；
 *  - 点击引用条目 → 高亮两端协议节点 + 显示 kind/target/context 原文（查表一致）。
 *
 * 边界（TC8）：
 *  - 无组合层数据 / 误导入单协议 data.json → 显式提示"需组合层数据"（不白屏、不端内凑数）；
 *  - 无框架 / 无运行时依赖 / 无 fetch-XHR-远程资源（静态扫描红线）；
 *  - 不做组合层 mermaid 渲染；不做跨协议 diff 面板（E9 边界）。
 */
(function () {
  'use strict';

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // ---------------------------------------------------------------------------
  // 引用点击 → 高亮两端协议节点（查表）
  // ---------------------------------------------------------------------------
  function clearProtoHighlights(box) {
    box.querySelectorAll('.proto-node.hl').forEach((x) => x.classList.remove('hl'));
  }

  function highlightProtocols(box, fromProtocol, toProtocol) {
    clearProtoHighlights(box);
    box.querySelectorAll('.proto-node').forEach((chip) => {
      const pid = chip.getAttribute('data-protocol-id');
      if (pid === fromProtocol || pid === toProtocol) chip.classList.add('hl');
    });
  }

  // ---------------------------------------------------------------------------
  // 面板渲染
  // ---------------------------------------------------------------------------
  function renderCompositionPanel(state, panels) {
    const data = state.dataJson;
    if (!data) return; // 未导入：主视图已有提示，组合层不重复
    if (panels.querySelector('.composition-panel') || panels.querySelector('.composition-empty')) return;

    // 误导入单协议 data.json → 显式提示需组合层数据（不白屏）
    if (data.schemaVersion !== '1.1') {
      const p = document.createElement('div');
      p.className = 'panel-empty composition-empty';
      p.textContent =
        '组合层面板：当前 data.json 为单协议数据（schemaVersion=' +
        (data.schemaVersion || '未知') +
        '），需组合层 data.json（schemaVersion=1.1，derive-web --project 产物）';
      panels.appendChild(p);
      return;
    }

    // 组合层数据完整性守卫（查表前提：protocols/dependencyGraph/crossRefs 齐备）
    if (!Array.isArray(data.protocols) || !data.dependencyGraph || !Array.isArray(data.crossRefs)) {
      const p = document.createElement('div');
      p.className = 'panel-empty composition-empty';
      p.textContent = '组合层面板：data.json 缺少组合层契约字段（protocols / dependencyGraph / crossRefs），请重新运行 derive-web --project';
      panels.appendChild(p);
      return;
    }

    const box = document.createElement('div');
    box.className = 'composition-panel';

    // 标题 + 图例计数（与 data.json 逐字段一致，图例可数）
    const title = document.createElement('div');
    title.className = 'panel-subtitle';
    title.textContent =
      `组合层面板（W3-f · schemaVersion ${esc(data.schemaVersion)} · ` +
      `协议 ${data.protocols.length} · 依赖边 ${data.dependencyGraph.edges.length} · 引用边 ${data.crossRefs.length}）`;
    box.appendChild(title);

    // ── 协议节点 ──
    const nodeRow = document.createElement('div');
    nodeRow.className = 'compo-proto-row';
    for (const p of data.protocols) {
      const chip = document.createElement('span');
      chip.className = 'proto-node';
      chip.setAttribute('data-protocol-id', p.id);
      chip.textContent = `${p.id} ${p.name}${p.version ? ' · v' + p.version : ''}`;
      chip.title = `子协议 ${p.id}（${p.name}）`;
      nodeRow.appendChild(chip);
    }
    box.appendChild(nodeRow);

    // ── 依赖边 ──
    if (data.dependencyGraph.edges.length > 0) {
      const depTitle = document.createElement('div');
      depTitle.className = 'compo-block-title';
      depTitle.textContent = `依赖边（dependencyGraph.edges，${data.dependencyGraph.edges.length}）`;
      box.appendChild(depTitle);
      const depBox = document.createElement('div');
      depBox.className = 'compo-dep-list';
      for (const e of data.dependencyGraph.edges) {
        const row = document.createElement('div');
        row.className = 'dep-row';
        row.innerHTML =
          `<span class="dep-pair"><b>${esc(e.from)}</b> → <b>${esc(e.to)}</b></span>` +
          `<span class="dep-type">${esc(e.dependencyType)}</span>` +
          (e.description ? `<span class="dep-desc">${esc(e.description)}</span>` : '');
        depBox.appendChild(row);
      }
      box.appendChild(depBox);
    }

    // ── 跨协议引用边（crossRefs，点击高亮两端协议 + 显示原文）──
    if (data.crossRefs.length > 0) {
      const refTitle = document.createElement('div');
      refTitle.className = 'compo-block-title';
      refTitle.textContent = `跨协议引用（crossRefs，${data.crossRefs.length}）—— 点击条目高亮两端协议`;
      box.appendChild(refTitle);
      const refBox = document.createElement('div');
      refBox.className = 'compo-ref-list';
      for (const c of data.crossRefs) {
        const row = document.createElement('div');
        row.className = 'ref-row';
        row.setAttribute('data-ref', `${c.fromProtocol}->${c.toProtocol}`);
        row.innerHTML =
          `<span class="ref-pair"><b>${esc(c.fromProtocol)}</b> → <b>${esc(c.toProtocol)}</b></span>` +
          `<span class="ref-kind ref-kind-${esc(c.kind)}">${esc(c.kind)}</span>` +
          (c.target !== undefined ? `<span class="ref-target">target=${esc(c.target)}</span>` : '') +
          `<span class="ref-src">${esc(c.sourceField)}</span>` +
          `<span class="ref-ctx" title="${esc(c.context)}">「${esc(c.context)}」</span>`;
        row.addEventListener('click', () => {
          refBox.querySelectorAll('.ref-row').forEach((x) => x.classList.remove('hl'));
          row.classList.add('hl');
          highlightProtocols(box, c.fromProtocol, c.toProtocol);
        });
        refBox.appendChild(row);
      }
      box.appendChild(refBox);
    }

    // ── 跨协议不变量覆盖（invariantSpans）──
    if (Array.isArray(data.invariantSpans) && data.invariantSpans.length > 0) {
      const invTitle = document.createElement('div');
      invTitle.className = 'compo-block-title';
      invTitle.textContent = `跨协议不变量覆盖（invariantSpans，${data.invariantSpans.length}）`;
      box.appendChild(invTitle);
      const invBox = document.createElement('div');
      invBox.className = 'compo-inv-list';
      for (const s of data.invariantSpans) {
        const row = document.createElement('div');
        row.className = 'inv-span-row';
        row.innerHTML =
          `<span class="inv-span-id"><b>${esc(s.id)}</b> ${esc(s.name)}</span>` +
          `<span class="inv-span-protos">覆盖：${(s.protocols || []).map((x) => esc(x)).join(', ')}</span>`;
        invBox.appendChild(row);
      }
      box.appendChild(invBox);
    }

    panels.appendChild(box);
  }

  // ---------------------------------------------------------------------------
  // 注册（叠加到 renderAll 链；顺序在 relations / diff 之后）
  // ---------------------------------------------------------------------------
  const hooks = window.ProtochainViewerHooks || {};
  const prevRenderAll = hooks.renderAll;
  hooks.renderAll = function (state, panels) {
    if (prevRenderAll) prevRenderAll(state, panels);
    renderCompositionPanel(state, panels);
  };
  window.ProtochainViewerHooks = hooks;
})();
