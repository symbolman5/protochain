/**
 * viewer 分层视图切换（R2b+：组件层/用例层与协议层分离视图）
 *
 * 背景：R2a/R2b 把协议层/组件层/用例层堆叠渲染进 #panels。本文件提供视图级分离：
 *   - index.html 静态提供 tab 栏（#view-tabs）与三个容器（#view-protocol / #view-component / #view-cases）；
 *   - 各 panel 渲染目标经 ProtochainViewerTabs.viewBox(panels, sel) 解析——启用时返回对应容器，
 *     否则（测试环境未加载本文件 / 项目模式）返回原 panels，零回归；
 *   - tab 点击切换激活容器（CSS 显示切换，不重渲染；跨视图高亮 DOM 常驻，切换后立即可见）。
 *
 * 启用边界（零回归保证）：
 *   - 单协议浏览模式（非 projectMode）且本文件已加载 → 分离生效；
 *   - 测试环境（jsdom 未加载本文件）→ 各 panel 退回原 #panels 堆叠行为（断言不变）；
 *   - 项目模式（manifest 装配，project-nav.js 接管渲染）→ 不激活分离，项目流程零变化。
 */
(function () {
  'use strict';

  /** 是否激活分层视图：单协议浏览模式（非项目模式） */
  function enabled() {
    var st = window.ProtochainViewer && window.ProtochainViewer.state;
    return !(st && st.projectMode);
  }

  /** panel 渲染目标解析：启用时返回对应容器；否则返回原 panels（测试/项目模式零回归） */
  function viewBox(panels, sel) {
    if (enabled()) {
      var c = document.getElementById(sel);
      if (c) return c;
    }
    return panels;
  }

  // 全局出口（各 panel 消费；测试环境未加载本文件时各 panel 用 identity 兜底）
  window.ProtochainViewerTabs = {
    viewBox: viewBox,
    enabled: enabled,
  };

  // tab 切换（CSS 激活态 + 容器显示切换）
  if (typeof document !== 'undefined') {
    var tabBar = document.getElementById('view-tabs');
    if (tabBar) {
      tabBar.addEventListener('click', function (ev) {
        var btn = ev.target && ev.target.closest ? ev.target.closest('.view-tab') : null;
        if (!btn) return;
        var name = btn.getAttribute('data-view');
        if (!name) return;
        tabBar.querySelectorAll('.view-tab').forEach(function (t) {
          var active = t === btn;
          t.classList.toggle('active', active);
          t.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        ['protocol', 'component', 'cases'].forEach(function (v) {
          var c = document.getElementById('view-' + v);
          if (c) c.classList.toggle('active', v === name);
        });
      });
    }
  }
})();
