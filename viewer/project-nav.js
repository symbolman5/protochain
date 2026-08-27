/**
 * viewer 项目级导航控制器（T4 09-execution-T4.md TD8 / 08-project-viewer-design.md §8.2/8.3）
 *
 * renderScope(state, panels) 导航控制器：
 * - 顶层 tab 条（项目总览/组合层/Pn/.../diff，tab 数 = protocols.length + 3，按 manifest 生成）；
 * - 侧栏接口列表（按 interface-details 条目 id 查表；可点 → 接口详情）；
 * - 面包屑（项目 → Pn → 接口；diff 新增接口显示"（diff 新增）"）；
 * - diff tab 消费语义（R8）：逐条展示快照全量（diffView 摘要 + 快照状态机高亮
 *   changedTransitions/changedStates + 受影响接口列表可点击 → L3 下钻）；
 * - sourceProtocolId 消费：L3 下钻协议上下文 + 协议 tab 顶栏 badge"本协议有 N 个 diff 快照"；
 * - L3 nav 流转：diff tab 点击受影响接口 → {scope:'interface', protocolId:diff.sourceProtocolId,
 *   interfaceId}；接口在当前协议数据不存在（diff 新增）→ 渲染 diff 快照摘要 +
 *   面包屑"项目 → P2 → IF_SYS_T5（diff 新增）"；
 * - 既有单文件导入路径（无 manifest）仍走原 renderAll 全量堆叠（零回归）；
 * - 导航切换 = 改 state.nav + 重渲染，零数据计算。
 *
 * 边界：不做 hash 路由/深链接（08 §8.3 明确不做）；不做跨协议 diff 分析（E9）。
 * 消费：window.ProtochainProjectNav（registerScopeRenderer 供 TD9 接口详情面板注册）。
 */
(function () {
  'use strict';

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // 动态注入项目导航样式（独立文件，不污染 app.css）
  const PN_CSS = `
.pn-tabs{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 10px;padding:8px;border:1px solid var(--border,#ddd);border-radius:8px;background:var(--panel-bg,#fafafa)}
.pn-tab{padding:5px 14px;border:1px solid #ccc;border-radius:16px;cursor:pointer;background:#fff;font-size:13px}
.pn-tab.active{background:#2f6fed;border-color:#2f6fed;color:#fff}
.pn-tab .pn-badge{margin-left:6px;padding:1px 7px;border-radius:10px;background:#f59f00;color:#fff;font-size:11px}
.pn-breadcrumb{margin:0 0 10px;padding:6px 10px;border-left:3px solid #2f6fed;background:var(--panel-bg,#fafafa);font-size:13px}
.pn-breadcrumb .sep{margin:0 6px;color:#999}
.pn-breadcrumb .diff-new{color:#d6336c;font-weight:600}
.pn-layout{display:flex;gap:12px}
.pn-sidebar{width:220px;flex:0 0 220px;border:1px solid var(--border,#ddd);border-radius:8px;padding:8px;background:var(--panel-bg,#fafafa);max-height:560px;overflow:auto}
.pn-sidebar .pn-side-title{font-weight:600;font-size:12px;color:#666;margin:4px 2px 6px}
.pn-side-item{padding:4px 8px;border-radius:6px;cursor:pointer;font-size:13px;margin:2px 0}
.pn-side-item:hover{background:#eef2ff}
.pn-side-item.active{background:#2f6fed;color:#fff}
.pn-side-item .kind{font-size:11px;color:#999;margin-left:4px}
.pn-content{flex:1;min-width:0}
.pn-proto-head{padding:8px 12px;border-radius:8px;margin-bottom:10px;background:#eef6ff;border:1px solid #cfe3ff}
.pn-proto-head .pn-badge{display:inline-block;margin-left:8px;padding:1px 8px;border-radius:10px;background:#f59f00;color:#fff;font-size:12px}
.pn-diff-card{border:1px solid var(--border,#ddd);border-radius:8px;padding:10px;margin-bottom:10px;background:var(--panel-bg,#fafafa)}
.pn-diff-card .pn-diff-title{font-weight:600;margin-bottom:6px}
.pn-diff-chip{display:inline-block;padding:2px 8px;margin:2px;border-radius:10px;background:#fff;border:1px solid #ccc;font-size:12px}
.pn-diff-chip.hl{background:#ffe3ec;border-color:#d6336c;color:#d6336c;font-weight:600}
.pn-diff-iface{cursor:pointer;color:#2f6fed;text-decoration:underline}
.pn-state-table{width:100%;border-collapse:collapse;margin:6px 0;font-size:12px}
.pn-state-table th,.pn-state-table td{border:1px solid #e0e0e0;padding:3px 8px;text-align:left}
.pn-state-table tr.hl{background:#ffe3ec}
.pn-project-card{border:1px solid var(--border,#ddd);border-radius:8px;padding:12px;margin-bottom:10px;background:var(--panel-bg,#fafafa)}
.pn-meta{color:#666;font-size:13px;margin:2px 0}
.pn-verdict-ok{color:#2b8a3e}.pn-verdict-warn{color:#e8590c}.pn-verdict-error{color:#d6336c}
.pn-nav-note{padding:8px 12px;border:1px dashed #ccc;border-radius:8px;margin-bottom:10px;color:#666;font-size:13px}
`;

  let styleInjected = false;
  function injectStyle() {
    if (styleInjected) return;
    styleInjected = true;
    const st = document.createElement('style');
    st.setAttribute('data-project-nav', '1');
    st.textContent = PN_CSS;
    document.head.appendChild(st);
  }

  // ---------------------------------------------------------------------------
  // 注册表：按 scope 调用的渲染器（TD9 接口详情面板注册 'interface'）
  // ---------------------------------------------------------------------------
  const scopeRenderers = {};
  function registerScopeRenderer(scope, fn) {
    scopeRenderers[scope] = fn;
  }

  // ---------------------------------------------------------------------------
  // 导航状态
  // ---------------------------------------------------------------------------
  function navigate(state, nav) {
    state.nav = nav;
    // 重渲染（导航切换 = 改 state.nav + 重渲染，零数据计算）
    renderScope(state, window.ProtochainViewer.els.panels);
  }

  // ---------------------------------------------------------------------------
  // 面包屑
  // ---------------------------------------------------------------------------
  function breadcrumbHtml(state) {
    const nav = state.nav || { scope: 'project' };
    const parts = ['项目'];
    const manifest = state.manifest;
    if (nav.scope === 'composition') {
      parts.push('组合层');
    } else if (nav.scope === 'protocol') {
      const p = (manifest.bundles.protocols || []).find((x) => x.id === nav.protocolId);
      parts.push(p ? p.id : nav.protocolId);
    } else if (nav.scope === 'interface') {
      const p = (manifest.bundles.protocols || []).find((x) => x.id === nav.protocolId);
      parts.push(p ? p.id : nav.protocolId);
      // diff 新增接口：查 interface-details entries 是否存在
      const exists = !!(
        state.interfaceDetails &&
        state.interfaceDetails.entries &&
        state.interfaceDetails.entries[nav.protocolId] &&
        state.interfaceDetails.entries[nav.protocolId][nav.interfaceId]
      );
      parts.push(
        exists
          ? nav.interfaceId
          : `<span class="diff-new">${esc(nav.interfaceId)}（diff 新增）</span>`
      );
    } else if (nav.scope === 'diff') {
      parts.push('diff');
    }
    return (
      '<div class="pn-breadcrumb">' +
      parts.map((p, i) => (i === 0 ? `<b>${p}</b>` : `<span class="sep">→</span>${p}`)).join('') +
      '</div>'
    );
  }

  // ---------------------------------------------------------------------------
  // tab 条（tab 数 = protocols.length + 3，按 manifest 生成）
  // ---------------------------------------------------------------------------
  function tabsHtml(state) {
    const manifest = state.manifest;
    const nav = state.nav || { scope: 'project' };
    const tabs = [{ id: 'project', label: '项目总览' }];
    // TI7（Ob-6=A）：interface-details/catalog 在场时追加"接口目录"tab（自动启停，红线二）
    if (state.interfaceDetails && state.interfaceDetails.catalog) {
      tabs.push({ id: 'catalog', label: '接口目录', nav: { scope: 'catalog' } });
    }
    tabs.push({ id: 'composition', label: '组合层' });
    const diffCountByProto = {};
    for (const d of manifest.bundles.diff || []) {
      diffCountByProto[d.sourceProtocolId] = (diffCountByProto[d.sourceProtocolId] || 0) + 1;
    }
    for (const p of manifest.bundles.protocols || []) {
      const n = diffCountByProto[p.id] || 0;
      tabs.push({
        id: 'protocol:' + p.id,
        label: p.id,
        nav: { scope: 'protocol', protocolId: p.id },
        badge: n > 0 ? n : null,
        badgeText: `本协议有 ${n} 个 diff 快照`,
      });
    }
    tabs.push({ id: 'diff', label: 'diff', nav: { scope: 'diff' } });
    let html = '<div class="pn-tabs">';
    for (const t of tabs) {
      const active =
        t.id === 'diff'
          ? nav.scope === 'diff'
          : t.id === 'project'
            ? nav.scope === 'project'
            : t.id === 'catalog'
              ? nav.scope === 'catalog'
              : t.id === 'composition'
                ? nav.scope === 'composition'
                : nav.scope === 'protocol' && nav.protocolId === t.nav.protocolId;
      const badge = t.badge
        ? `<span class="pn-badge" title="${esc(t.badgeText)}">${t.badge}</span>`
        : '';
      html += `<span class="pn-tab${active ? ' active' : ''}" data-tab="${esc(t.id)}" data-nav="${esc(
        JSON.stringify(t.nav || { scope: t.id })
      )}"><span class="pn-tab-label">${esc(t.label)}</span>${badge}</span>`;
    }
    html += '</div>';
    return html;
  }

  // ---------------------------------------------------------------------------
  // 侧栏接口列表（按 interface-details 条目 id 查表）
  // ---------------------------------------------------------------------------
  function sidebarHtml(state, protocolId) {
    const manifest = state.manifest;
    const p = (manifest.bundles.protocols || []).find((x) => x.id === protocolId);
    if (!p) return '';
    const nav = state.nav || {};
    let items = '';
    if (state.interfaceDetails && state.interfaceDetails.entries && state.interfaceDetails.entries[protocolId]) {
      const entries = state.interfaceDetails.entries[protocolId];
      for (const [ifid, entry] of Object.entries(entries)) {
        const active = nav.scope === 'interface' && nav.interfaceId === ifid;
        items +=
          `<div class="pn-side-item${active ? ' active' : ''}" data-iface="${esc(ifid)}" data-proto="${esc(protocolId)}">` +
          `<span>${esc(ifid)}</span><span class="kind">${esc(entry.interface ? entry.interface.kind : '')}</span></div>`;
      }
    } else {
      items = '<div class="pn-side-item" style="color:#999">（接口详情数据未导入）</div>';
    }
    return (
      '<div class="pn-sidebar"><div class="pn-side-title">接口（' +
      p.name +
      '）</div>' +
      items +
      '</div>'
    );
  }

  // ---------------------------------------------------------------------------
  // scope 渲染器
  // ---------------------------------------------------------------------------

  /** 项目总览（manifest 摘要 + 每协议卡 + 新鲜度状态） */
  function renderProjectOverview(state, panels) {
    const manifest = state.manifest;
    const box = document.createElement('div');
    const freshness = state.projectFreshness || {};
    let cards = '';
    for (const p of manifest.bundles.protocols || []) {
      const v = (freshness.perProtocol || {})[p.id];
      const vCls = !v || v.fresh ? 'pn-verdict-ok' : v.level === 'error' ? 'pn-verdict-error' : 'pn-verdict-warn';
      const vText = !v || v.fresh ? '新鲜' : v.degraded ? '已降级' : 'ok';
      const missing = state.projectData[p.id] ? '' : '（数据未导入）';
      cards +=
        `<div class="pn-project-card"><b>${esc(p.id)} ${esc(p.name)}</b>${missing}<br>` +
        `<div class="pn-meta">model v${esc(p.modelVersion)} · 数据 v${esc(p.dataSourceModelVersion || '—')} · 接口 ${p.interfaceCount} · bindings 指纹 ${p.bindingsFingerprint ? '有' : '无'}</div>` +
        `<div class="pn-meta"><span class="${vCls}">${vText}</span>${v && v.alert ? `：${esc(v.alert)}` : ''}</div></div>`;
    }
    const comp = freshness.composition || {};
    const idl = freshness.interfaceDetails || {};
    box.innerHTML =
      `<div class="pn-project-card"><b>${esc(manifest.project.systemName)}</b><br>` +
      `<div class="pn-meta">版本 ${esc(manifest.project.version)} · 变更类型 ${esc(manifest.project.changeType)} · 子协议 ${(manifest.bundles.protocols || []).length} · diff 快照 ${(manifest.bundles.diff || []).length}</div>` +
      (comp.alert ? `<div class="pn-meta ${comp.level === 'error' ? 'pn-verdict-error' : 'pn-verdict-warn'}">${esc(comp.alert)}</div>` : '') +
      (idl.alert ? `<div class="pn-meta pn-verdict-error">${esc(idl.alert)}</div>` : '') +
      `</div>${cards}` +
      (manifest.redactionNotice || []).map((r) => `<div class="pn-meta" style="color:#999;font-size:12px">${esc(r)}</div>`).join('');
    panels.appendChild(box);
  }

  /** 组合层 scope：既有组合层面板走 baseRenderAll（消费 state.dataJson=组合层 data.json） */
  function renderCompositionScope(state, panels) {
    if (!state.dataJson) {
      const p = document.createElement('div');
      p.className = 'panel-empty';
      p.textContent = '组合层数据未导入（缺 data.json）';
      panels.appendChild(p);
      return;
    }
    if (state.dataJson.schemaVersion !== '1.1') {
      const p = document.createElement('div');
      p.className = 'panel-empty';
      p.textContent = '组合层数据缺失或 schemaVersion 不符（需 1.1）';
      panels.appendChild(p);
      return;
    }
    // 复用既有渲染链（composition-panel 等按 state.dataJson 渲染）
    callBaseRenderAll(state, panels);
  }

  /** 协议 scope：协议头（badge）+ 侧栏 + 既有面板（临时 dataJson = 该协议数据） */
  /** diff scope：逐条快照全量（diffView 摘要 + 状态机高亮 + 受影响接口可点击） */
  function renderDiffScope(state, panels) {
    const manifest = state.manifest;
    const diffs = manifest.bundles.diff || [];
    if (diffs.length === 0) {
      const p = document.createElement('div');
      p.className = 'panel-empty';
      p.textContent = '无 diff 数据（manifest 未声明 diff 快照）';
      panels.appendChild(p);
      return;
    }
    for (const d of diffs) {
      const card = document.createElement('div');
      card.className = 'pn-diff-card';
      const snap = state.diffData[d.id];
      if (!snap || !snap.diffView) {
        card.innerHTML =
          `<div class="pn-diff-title">${esc(d.id)}（${esc(d.sourceProtocolId)} · v${esc(d.baseModelVersion)} → v${esc(d.targetModelVersion)}）</div>` +
          `<div class="pn-meta">快照数据未导入（缺 ${esc(d.file)}）</div>`;
        panels.appendChild(card);
        continue;
      }
      const dv = snap.diffView;
      let html =
        `<div class="pn-diff-title">${esc(d.id)}（${esc(d.sourceProtocolId)} · v${esc(d.baseModelVersion)} → v${esc(d.targetModelVersion)}）</div>` +
        `<div class="pn-meta">变更转移 <b>${(dv.changedTransitions || []).length}</b> · 变更状态 <b>${(dv.changedStates || []).length}</b> · 受影响接口 <b>${(dv.affectedInterfaces || []).length}</b> · 受影响用例 <b>${(dv.affectedCases || []).length}</b>` +
        (dv.summary ? ` · 摘要：${esc(dv.summary)}` : '') +
        `</div>`;
      // 快照状态机高亮（changedTransitions/changedStates → 表格行高亮，查表）
      if (snap.stateMachine && snap.stateMachine.nodes) {
        const changedT = new Set(dv.changedTransitions || []);
        const changedS = new Set(dv.changedStates || []);
        html +=
          '<div class="pn-meta">快照状态机（changedTransitions/changedStates 高亮）：</div>' +
          '<table class="pn-state-table"><tr><th>状态</th><th>转移</th></tr>' +
          snap.stateMachine.nodes.map((n) =>
            `<tr class="${changedS.has(n.id) ? 'hl' : ''}"><td>${esc(n.id)} ${esc(n.name)}</td><td></td></tr>`
          ).join('') +
          (snap.stateMachine.edges || []).map((e) =>
            `<tr class="${changedT.has(e.id) ? 'hl' : ''}"><td></td><td>${esc(e.id)} ${esc(e.action)}（${esc(e.from.join(','))} → ${esc(e.to)}）</td></tr>`
          ).join('') +
          '</table>';
      }
      // 受影响接口列表（可点击 → L3 下钻）
      if ((dv.affectedInterfaces || []).length > 0) {
        html += '<div class="pn-meta">受影响接口：</div><div>';
        for (const ifid of dv.affectedInterfaces) {
          html += `<span class="pn-diff-chip pn-diff-iface" data-diff-iface="${esc(ifid)}" data-diff-proto="${esc(d.sourceProtocolId)}">${esc(ifid)}</span>`;
        }
        html += '</div>';
      }
      card.innerHTML = html;
      panels.appendChild(card);
    }
  }

  // ---------------------------------------------------------------------------
  // renderScope 主入口
  // ---------------------------------------------------------------------------
  function renderScope(state, panels) {
    // 非项目模式（无 manifest）→ 由 baseRenderAll 全量堆叠（零回归，本函数不介入）
    if (!state.manifest || !state.projectMode) {
      return callBaseRenderAll(state, panels);
    }
    injectStyle();
    const nav = state.nav || { scope: 'project' };
    panels.innerHTML = '';
    const frame = document.createElement('div');
    // tab 条
    frame.innerHTML = tabsHtml(state);
    panels.appendChild(frame.firstChild);
    // 面包屑
    const crumb = document.createElement('div');
    crumb.innerHTML = breadcrumbHtml(state);
    panels.appendChild(crumb.firstChild);
    // scope 内容
    if (nav.scope === 'protocol') {
      const layout = document.createElement('div');
      layout.className = 'pn-layout';
      panels.appendChild(layout);
      renderProtocolScopeInner(state, layout);
    } else if (nav.scope === 'interface') {
      renderInterfaceScope(state, panels);
    } else if (nav.scope === 'catalog') {
      // TI7/TI8：接口目录（catalog 面板已注册为 'catalog' scope 渲染器）
      renderCatalogScope(state, panels);
    } else if (nav.scope === 'diff') {
      renderDiffScope(state, panels);
    } else if (nav.scope === 'composition') {
      // 组合层 scope：既有面板渲染到独立内容容器（main-view 等渲染器会清空 panels）
      const content = document.createElement('div');
      content.className = 'pn-content';
      panels.appendChild(content);
      renderCompositionScope(state, content);
    } else {
      renderProjectOverview(state, panels);
    }
    bindTabs(panels, state);
    bindSidebar(panels, state);
    bindDiffInterfaces(panels, state);
  }

  /** 协议 scope 内：协议头 + 侧栏 + 内容区（临时 dataJson） */
  function renderProtocolScopeInner(state, layout) {
    const pid = (state.nav || {}).protocolId;
    const manifest = state.manifest;
    const p = (manifest.bundles.protocols || []).find((x) => x.id === pid);
    const diffCount = (manifest.bundles.diff || []).filter((d) => d.sourceProtocolId === pid).length;
    const data = state.projectData[pid];
    const head = document.createElement('div');
    if (!data) {
      head.className = 'pn-proto-head';
      head.innerHTML =
        `<b>${esc(pid)} ${esc(p ? p.name : '')}</b>` +
        (diffCount > 0 ? `<span class="pn-badge">本协议有 ${diffCount} 个 diff 快照</span>` : '') +
        `<div class="pn-meta">数据未导入（缺 ${esc(p ? p.dataFile : '')}）——请拖入完整 web/ 目录或分别导入</div>`;
      layout.appendChild(head);
      return;
    }
    const v = ((state.projectFreshness || {}).perProtocol || {})[pid];
    head.className = 'pn-proto-head';
    head.innerHTML =
      `<b>${esc(pid)} ${esc(p ? p.name : '')}</b>` +
      (diffCount > 0 ? `<span class="pn-badge" title="本协议有 ${diffCount} 个 diff 快照">本协议有 ${diffCount} 个 diff 快照</span>` : '') +
      `<div class="pn-meta">model v${esc(p.modelVersion)} · 数据 v${esc(data.sourceModelVersion)} · 接口 ${data.interfaces ? data.interfaces.length : '—'}</div>` +
      (v && v.alert ? `<div class="pn-meta ${v.level === 'error' ? 'pn-verdict-error' : 'pn-verdict-warn'}">${esc(v.alert)}</div>` : '');
    layout.appendChild(head);
    const side = document.createElement('div');
    side.innerHTML = sidebarHtml(state, pid);
    layout.appendChild(side.firstChild);
    const content = document.createElement('div');
    content.className = 'pn-content';
    layout.appendChild(content);
    const saved = state.dataJson;
    state.dataJson = data;
    callBaseRenderAll(state, content);
    state.dataJson = saved;
  }

  /** interface scope：接口详情面板（TD9 注册的渲染器；无渲染器 → 提示） */
  function renderInterfaceScope(state, panels) {
    const renderer = scopeRenderers['interface'];
    if (renderer) {
      renderer(state, panels);
      return;
    }
    const p = document.createElement('div');
    p.className = 'panel-empty';
    p.textContent = '接口详情面板未注册';
    panels.appendChild(p);
  }

  /** catalog scope：接口目录面板（TI8 注册的渲染器；无渲染器 → 提示） */
  function renderCatalogScope(state, panels) {
    const renderer = scopeRenderers['catalog'];
    if (renderer) {
      renderer(state, panels);
      return;
    }
    const p = document.createElement('div');
    p.className = 'panel-empty';
    p.textContent = '接口目录面板未注册';
    panels.appendChild(p);
  }

  // ---------------------------------------------------------------------------
  // 事件绑定
  // ---------------------------------------------------------------------------
  function bindTabs(panels, state) {
    panels.querySelectorAll('.pn-tab[data-nav]').forEach((tab) => {
      tab.addEventListener('click', () => {
        let nav;
        try {
          nav = JSON.parse(tab.getAttribute('data-nav'));
        } catch {
          nav = { scope: tab.getAttribute('data-tab') };
        }
        if (nav.scope === 'protocol' && nav.protocolId) {
          navigate(state, { scope: 'protocol', protocolId: nav.protocolId });
        } else {
          navigate(state, { scope: nav.scope });
        }
      });
    });
  }

  function bindSidebar(panels, state) {
    panels.querySelectorAll('.pn-side-item[data-iface]').forEach((item) => {
      item.addEventListener('click', () => {
        const protocolId = item.getAttribute('data-proto');
        const interfaceId = item.getAttribute('data-iface');
        navigate(state, { scope: 'interface', protocolId, interfaceId });
      });
    });
  }

  function bindDiffInterfaces(panels, state) {
    panels.querySelectorAll('[data-diff-iface]').forEach((chip) => {
      chip.addEventListener('click', () => {
        const interfaceId = chip.getAttribute('data-diff-iface');
        const protocolId = chip.getAttribute('data-diff-proto');
        // L3 nav 流转（R8）：scope='interface'，协议上下文 = diff.sourceProtocolId
        navigate(state, { scope: 'interface', protocolId, interfaceId });
      });
    });
  }

  // ---------------------------------------------------------------------------
  // baseRenderAll（既有 renderAll 链）：加载时捕获，项目模式复用 / 单文件模式透传
  // ---------------------------------------------------------------------------
  let baseRenderAll = null;
  function captureBaseRenderAll() {
    const hooks = window.ProtochainViewerHooks || {};
    baseRenderAll = hooks.renderAll || null;
    hooks.renderAll = function (state, panels) {
      renderScope(state, panels);
    };
    window.ProtochainViewerHooks = hooks;
  }

  function callBaseRenderAll(state, panels) {
    if (baseRenderAll) {
      baseRenderAll(state, panels);
    }
  }

  // ---------------------------------------------------------------------------
  // 注册
  // ---------------------------------------------------------------------------
  window.ProtochainProjectNav = {
    renderScope,
    navigate,
    registerScopeRenderer,
  };
  captureBaseRenderAll();
})();
