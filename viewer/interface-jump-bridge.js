/**
 * viewer 接口↔状态 双向跳转桥（G5 Wave 4 · TI9 / 10 §3-4 / W3-c ③）
 *
 * 在"状态机主视图（main-view，T1 面板，按红线三不改动）"与"接口详情（interface scope）"
 * 之间建立双向跳转，而**不修改 main-view.js**：
 *  - 接口详情 → 状态/转移：由 interface-detail-panel.js 在状态/转移 chip 上绑定导航（同源文件内）。
 *  - 状态机 → 接口：本文件以 document 级委托监听 `.sm-edge`（转移边）点击，按
 *    interface-details.entries 查表（relation.ownedTransitions 含该转移 id → 对应接口），
 *    委托 ProtochainProjectNav.navigate 打开接口详情。零推导、纯查表。
 *
 * 仅在项目模式（state.manifest 在场）生效；单独 data.json 导入无 interface-details → 自然 no-op。
 */
(function () {
  'use strict';

  function findInterfaceByTransition(state, transitionId) {
    const details = state && state.interfaceDetails;
    if (!details || !details.entries) return null;
    for (const [pid, entries] of Object.entries(details.entries)) {
      for (const [iid, entry] of Object.entries(entries)) {
        const owned = (entry.relation && entry.relation.ownedTransitions) || [];
        if (owned.indexOf(transitionId) !== -1) {
          return { protocolId: pid, interfaceId: iid };
        }
      }
    }
    return null;
  }

  function onClick(ev) {
    const edge = ev.target && ev.target.closest ? ev.target.closest('.sm-edge') : null;
    if (!edge) return;
    const id = edge.getAttribute('data-edge-id');
    if (!id) return;
    const viewer = window.ProtochainViewer;
    const state = viewer && viewer.state;
    if (!state || !state.manifest) return; // 仅项目模式
    const hit = findInterfaceByTransition(state, id);
    if (hit && window.ProtochainProjectNav && window.ProtochainProjectNav.navigate) {
      // 捕获阶段执行（先于 main-view 自身的边详情处理），导航后用接口详情替换面板
      window.ProtochainProjectNav.navigate(state, {
        scope: 'interface',
        protocolId: hit.protocolId,
        interfaceId: hit.interfaceId,
      });
    }
  }

  // 捕获阶段：保证在 main-view 的边 click 处理器之前完成导航
  if (typeof document !== 'undefined') {
    document.addEventListener('click', onClick, true);
  }
})();
