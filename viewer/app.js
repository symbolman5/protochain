/**
 * Protochain Viewer 应用逻辑（W3-a / TA3 骨架）
 *
 * 无框架、无运行时依赖、纯本地 File API、双击 file:// 可开、无网络请求。
 * 本文件当前实现：
 *  - W3-a：model.md / data.json 拖拽或选择导入；
 *  - 浏览器端解析（window.ProtochainParser，TA2 bundle）；
 *  - N1 新鲜度守卫（window.N1Guard）：sourceModelVersion vs metadata.version；
 *  - 模型信息展示（模型名/版本/状态数）——TA3 验收③；
 *  - 面板容器与渲染钩子（TA4 ①主视图 / TA5 ③⑥ 面板在此挂载）。
 *
 * 约定：
 *  - 唯一全局 window.ProtochainViewer（状态 + 导入入口 + 渲染钩子）；
 *  - 渲染函数（renderMain / renderLinks / renderCoverage）由 TA4/TA5 填充，
 *    此处先提供空实现占位，避免 import 顺序问题。
 */
(function () {
  'use strict';

  const P = window.ProtochainParser;
  const N1 = window.N1Guard;
  if (!P || !N1) {
    document.body.innerHTML =
      '<h1 style="padding:40px;font-family:system-ui">缺少依赖：请确认 assets/parser.js 与 n1-guard.js 已随 index.html 加载</h1>';
    throw new Error('ProtochainParser / N1Guard 未加载');
  }

  // ---------------------------------------------------------------------------
  // 状态
  // ---------------------------------------------------------------------------
  const state = {
    modelIr: null, // parseProtocolContent 的 SourceProtocolModel
    dataJson: null, // WebDataJson（着色唯一数据源）
    n1: { fresh: true, degraded: false, alert: null, level: 'ok' },
  };

  const $ = (sel) => document.querySelector(sel);
  const els = {
    parserVersion: $('#parser-version'),
    modelDrop: $('#model-drop'),
    dataDrop: $('#data-drop'),
    modelFile: $('#model-file'),
    dataFile: $('#data-file'),
    n1Banner: $('#n1-banner'),
    modelInfo: $('#model-info'),
    panels: $('#panels'),
    importStatus: $('#import-status'),
  };

  // ---------------------------------------------------------------------------
  // 工具
  // ---------------------------------------------------------------------------
  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error(`读取文件失败：${file.name}`));
      reader.readAsText(file, 'utf-8');
    });
  }

  function setStatus(text, kind) {
    els.importStatus.textContent = text;
    els.importStatus.className = 'status-text' + (kind ? ' status-' + kind : '');
  }

  // ---------------------------------------------------------------------------
  // 导入（W3-a）
  // ---------------------------------------------------------------------------
  function setupDropzone(zone, input, onFile) {
    zone.addEventListener('click', () => input.click());
    zone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        input.click();
      }
    });
    input.addEventListener('change', () => {
      if (input.files && input.files.length > 0) onFile(input.files[0]);
    });
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('dragging');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragging'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('dragging');
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        onFile(e.dataTransfer.files[0]);
      }
    });
  }

  async function importModel(file) {
    try {
      const content = await readFileAsText(file);
      const ir = P.parseProtocolContent(content, file.name);
      state.modelIr = ir;
      renderModelInfo();
      runN1();
      setStatus(`✓ model.md 已导入：${ir.metadata.name}（v${ir.metadata.version}）`, 'ok');
      runRenderHooks();
    } catch (err) {
      setStatus(`✗ model.md 解析失败：${err.message}`, 'error');
    }
  }

  async function importData(file) {
    try {
      const content = await readFileAsText(file);
      const json = JSON.parse(content);
      state.dataJson = json;
      runN1();
      setStatus('✓ data.json 已导入（增强数据，验证着色唯一数据源）', 'ok');
      runRenderHooks();
    } catch (err) {
      setStatus(`✗ data.json 解析失败：${err.message}`, 'error');
    }
  }

  // ---------------------------------------------------------------------------
  // N1 新鲜度守卫（03-viewer.md W3-a / NR3-1）
  // ---------------------------------------------------------------------------
  function runN1() {
    const verdict = N1.checkFreshness(
      state.dataJson ? state.dataJson.sourceModelVersion : undefined,
      state.modelIr ? state.modelIr.metadata.version : undefined
    );
    state.n1 = verdict;
    if (verdict.alert) {
      els.n1Banner.textContent = verdict.alert;
      els.n1Banner.className = 'n1-banner n1-' + verdict.level;
    } else {
      els.n1Banner.textContent = '';
      els.n1Banner.className = 'n1-banner hidden';
    }
  }

  // ---------------------------------------------------------------------------
  // 模型信息（TA3 验收③：模型名/版本/状态数）
  // ---------------------------------------------------------------------------
  function renderModelInfo() {
    const ir = state.modelIr;
    if (!ir) return;
    const states = ir.derivable.states;
    const transitions = ir.derivable.transitions;
    const roles = (ir.metadata.roles || []).map((r) => r.name).join('、');
    els.modelInfo.innerHTML =
      '<div class="model-card">' +
      `<div class="model-name">${esc(ir.metadata.name)}</div>` +
      `<div class="model-meta"><span>版本 v${esc(ir.metadata.version)}</span><span>状态 ${states.length} · 转移 ${transitions.length}</span></div>` +
      `<div class="model-roles">角色：${esc(roles)}</div>` +
      '</div>';
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // ---------------------------------------------------------------------------
  // 渲染钩子（TA4/TA5 填充）
  // ---------------------------------------------------------------------------
  // 按依赖顺序执行；导入顺序任意，全部依赖就绪后渲染。
  function runRenderHooks() {
    if (window.ProtochainViewerHooks && window.ProtochainViewerHooks.renderAll) {
      window.ProtochainViewerHooks.renderAll(state, els.panels);
    }
  }

  // ---------------------------------------------------------------------------
  // 初始化
  // ---------------------------------------------------------------------------
  els.parserVersion.textContent = `内嵌 parser v${P.PARSER_VERSION}`;
  setupDropzone(els.modelDrop, els.modelFile, importModel);
  setupDropzone(els.dataDrop, els.dataFile, importData);

  // 唯一全局出口（状态 + 钩子注册点，TA4/TA5 复用）
  window.ProtochainViewer = {
    state,
    els,
    importModel,
    importData,
    runN1,
    setStatus,
  };
})();
