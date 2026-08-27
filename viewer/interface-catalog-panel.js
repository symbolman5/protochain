/**
 * viewer 接口目录面板（G5 Wave 4 · TI8 / 10 §3-1 / C-6）
 *
 * 新面板，独立文件挂载（不触碰 T4 七视角面板，红线三）。
 * 消费 state.interfaceDetails.catalog 三索引（byProtocol / byRole / byPreconditionState），
 * 仅查表渲染，零推导（10 §3-1 / 红线二 / R10）：归组边界规则（triggerRoleId=null→
 * "系统/未指派角色"、观测→"观测"组、多 from 重复展示）已由工具链在 TI3 投影，此处不重算。
 *
 * 注册为 'catalog' scope 渲染器（TD8 renderScope）：window.ProtochainProjectNav.registerScopeRenderer('catalog', ...)。
 * 面板仅在 interface-details/catalog 存在时由 project-nav 添加 tab（自动启停）。
 */
(function () {
  'use strict';

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  const ICP_CSS = `
.icp-card{border:1px solid var(--border,#ddd);border-radius:8px;padding:12px;background:var(--panel-bg,#fafafa)}
.icp-title{font-weight:600;font-size:15px;margin-bottom:8px}
.icp-subtabs{display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap}
.icp-subtab{padding:4px 12px;border:1px solid #ccc;border-radius:14px;cursor:pointer;font-size:13px;background:#fff}
.icp-subtab.active{background:#2f6fed;border-color:#2f6fed;color:#fff}
.icp-group{margin:10px 0;border:1px solid #eee;border-radius:6px;padding:8px}
.icp-group-title{font-weight:600;font-size:13px;color:#444;margin-bottom:4px}
.icp-group-title .icp-count{color:#999;font-weight:400;font-size:12px;margin-left:6px}
.icp-item{padding:4px 8px;border-radius:6px;cursor:pointer;font-size:13px;margin:2px 0;display:flex;align-items:baseline;gap:8px}
.icp-item:hover{background:#eef2ff}
.icp-item .icp-itid{font-weight:600}
.icp-item .icp-itname{color:#555}
.icp-item .icp-ittype{margin-left:auto;font-size:11px;color:#999}
.icp-empty{color:#888;font-size:13px;padding:4px 0}
`;

  let styleInjected = false;
  function injectStyle() {
    if (styleInjected) return;
    styleInjected = true;
    const st = document.createElement('style');
    st.setAttribute('data-icp', '1');
    st.textContent = ICP_CSS;
    document.head.appendChild(st);
  }

  // 索引元信息（展示标签 + 顺序）
  const INDEX_DEFS = [
    { key: 'byProtocol', label: '按协议' },
    { key: 'byRole', label: '按角色' },
    { key: 'byPreconditionState', label: '按前置状态' },
  ];

  // 当前选中的索引（模块级，避免每次重渲染丢状态）
  let currentIndex = 'byProtocol';

  function interfaceLabel(state, protocolId, interfaceId) {
    const entry = state.interfaceDetails &&
      state.interfaceDetails.entries &&
      state.interfaceDetails.entries[protocolId] &&
      state.interfaceDetails.entries[protocolId][interfaceId];
    if (!entry) return { name: '', type: '' };
    const i = entry.interface || {};
    return { name: i.name || '', type: i.interfaceType || i.kind || '' };
  }

  function renderCatalogScope(state, panels) {
    injectStyle();
    const details = state.interfaceDetails;
    if (!details || !details.catalog) {
      const p = document.createElement('div');
      p.className = 'panel-empty icp-card';
      p.textContent = '接口目录数据未生成（缺 interface-details.json 的 catalog，请重新 derive-web --project）';
      panels.appendChild(p);
      return;
    }

    const box = document.createElement('div');
    box.className = 'icp-card';

    let html = '<div class="icp-title">接口目录</div><div class="icp-subtabs">';
    for (const def of INDEX_DEFS) {
      const active = def.key === currentIndex ? ' active' : '';
      html += `<span class="icp-subtab${active}" data-idx="${esc(def.key)}">${esc(def.label)}</span>`;
    }
    html += '</div><div class="icp-body"></div>';
    box.innerHTML = html;
    panels.appendChild(box);

    const body = box.querySelector('.icp-body');
    renderGroups(state, body, details.catalog, currentIndex);

    box.querySelectorAll('.icp-subtab').forEach((tab) => {
      tab.addEventListener('click', () => {
        currentIndex = tab.getAttribute('data-idx');
        box.querySelectorAll('.icp-subtab').forEach((t) =>
          t.classList.toggle('active', t.getAttribute('data-idx') === currentIndex)
        );
        body.innerHTML = '';
        renderGroups(state, body, details.catalog, currentIndex);
      });
    });
  }

  /** 渲染某一索引的分组（纯查表，零推导） */
  function renderGroups(state, body, catalog, indexKey) {
    const U = window.InterfaceViewUtils;
    const view = U ? U.buildCatalogView(catalog, indexKey) : { indexKey, groups: [] };
    if (!view.groups || view.groups.length === 0) {
      body.innerHTML = '<div class="icp-empty">（该索引下无分组）</div>';
      return;
    }
    let html = '';
    for (const group of view.groups) {
      html +=
        `<div class="icp-group"><div class="icp-group-title">${esc(group.key)}` +
        `<span class="icp-count">${group.items.length}</span></div>`;
      if (group.items.length === 0) {
        html += '<div class="icp-empty">（无接口）</div>';
      } else {
        for (const it of group.items) {
          const lbl = interfaceLabel(state, it.protocolId, it.interfaceId);
          html +=
            `<div class="icp-item" data-proto="${esc(it.protocolId)}" data-iface="${esc(it.interfaceId)}">` +
            `<span class="icp-itid">${esc(it.interfaceId)}</span>` +
            (lbl.name ? `<span class="icp-itname">${esc(lbl.name)}</span>` : '') +
            (lbl.type ? `<span class="icp-ittype">${esc(lbl.type)}</span>` : '') +
            `</div>`;
        }
      }
      html += '</div>';
    }
    body.innerHTML = html;

    body.querySelectorAll('.icp-item[data-iface]').forEach((item) => {
      item.addEventListener('click', () => {
        const protocolId = item.getAttribute('data-proto');
        const interfaceId = item.getAttribute('data-iface');
        window.ProtochainProjectNav.navigate(state, {
          scope: 'interface',
          protocolId,
          interfaceId,
        });
      });
    });
  }

  // ---------------------------------------------------------------------------
  // 注册为 catalog scope 渲染器（TD8 renderScope）
  // ---------------------------------------------------------------------------
  if (window.ProtochainProjectNav && window.ProtochainProjectNav.registerScopeRenderer) {
    window.ProtochainProjectNav.registerScopeRenderer('catalog', renderCatalogScope);
  }
})();
