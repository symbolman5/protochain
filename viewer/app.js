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
    // T4（09-execution-T4 TD7）：项目模式状态扩展
    projectMode: false, // 已导入项目 manifest
    manifest: null, // ProjectManifest
    interfaceDetails: null, // ProjectInterfaceDetailData
    projectData: {}, // Pn → pN.data.json（WebDataJson；未导入 → null）
    projectModelIr: {}, // Pn → 浏览器解析 model.md IR（C 模可选，S2 源）
    diffData: {}, // diffId → 快照 data.json（diff tab 消费）
    projectFreshness: null, // checkProjectFreshness 结果
    nav: null, // { scope:'project'|'composition'|'protocol'|'interface'|'diff', protocolId?, interfaceId?, diffId? }
  };

  const $ = (sel) => document.querySelector(sel);
  const els = {
    parserVersion: $('#parser-version'),
    modelDrop: $('#model-drop'),
    dataDrop: $('#data-drop'),
    projectDrop: $('#project-drop'),
    modelFile: $('#model-file'),
    dataFile: $('#data-file'),
    projectFile: $('#project-file'),
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
      // T4（TD7）C 模判别（R18-1）：按文件内容归类，不依赖路径。
      const kind = classifyImportedJson(json);
      if (kind === 'interfaceDetails') {
        state.interfaceDetails = json;
        setStatus('✓ interface-details.json 已导入（接口详情数据）', 'ok');
        runProjectFreshness();
        runRenderHooks();
        return;
      }
      if (kind === 'manifest') {
        if (json.kind !== 'project-manifest' || json.schemaVersion !== '1.0') {
          setStatus('非项目 manifest（kind/schemaVersion 不符），未解析', 'error');
          return;
        }
        state.manifest = json;
        state.projectMode = true;
        setStatus(`✓ 项目 manifest 已导入：${json.project.systemName}（其余子产物请分别导入，或拖入 web/ 目录一次装配）`, 'ok');
        runRenderHooks();
        return;
      }
      if (kind === 'protocolData' && state.manifest) {
        const proto = (state.manifest.bundles.protocols || []).find(
          (p) => basenameOf(file.name) === p.dataFile
        );
        if (proto) {
          state.projectData[proto.id] = json;
          state.projectMode = true;
          setStatus(`✓ ${proto.id} 协议数据已导入（${proto.name}）`, 'ok');
          runProjectFreshness();
          runRenderHooks();
          return;
        }
      }
      // 既有路径：单协议 / 组合层 data.json（零回归）
      state.dataJson = json;
      runN1();
      setStatus('✓ data.json 已导入（增强数据，验证着色唯一数据源）', 'ok');
      runRenderHooks();
    } catch (err) {
      setStatus(`✗ data.json 解析失败：${err.message}`, 'error');
    }
  }

  // ---------------------------------------------------------------------------
  // T4 项目导入（09-execution-T4 TD7 / 08 §8.1 R5 三模：A 拖目录 / B http fetch / C 分别导入）
  // ---------------------------------------------------------------------------

  /** C 模内容判别（R18-1）：interface-details.json 看 kind；组合层看 schemaVersion=1.1；协议数据看 sourceModelVersion */
  function classifyImportedJson(json) {
    if (json && typeof json === 'object') {
      if (json.kind === 'interface-details') return 'interfaceDetails';
      if (json.kind === 'project-manifest') return 'manifest';
      if (json.schemaVersion === '1.1') return 'composition';
      if (typeof json.sourceModelVersion === 'string') return 'protocolData';
    }
    return 'unknown';
  }

  /** basename（兼容 webkitRelativePath / 裸文件名） */
  function basenameOf(p) {
    const parts = String(p).split('/');
    return parts[parts.length - 1];
  }

  /** 路径层级深度（webkitRelativePath 段数；无相对路径 → 0） */
  function depthOf(p) {
    const rel = String(p || '');
    return rel === '' ? 0 : rel.split('/').length;
  }

  /**
   * manifest 发现（08 §8.1 R9/R16）：File 集合中 basename === 'manifest.json' 且内容
   * kind === 'project-manifest'；多命中取层级最浅 + warning（其余忽略）。
   * 返回 { manifest, manifestFile, warnings }；未命中 → null。
   */
  async function findManifestFile(files) {
    const candidates = [];
    const warnings = [];
    for (const f of files) {
      if (basenameOf(f.webkitRelativePath || f.name) !== 'manifest.json') continue;
      try {
        const json = JSON.parse(await readFileAsText(f));
        if (json && json.kind === 'project-manifest') {
          candidates.push({ file: f, json, depth: depthOf(f.webkitRelativePath || f.name) });
        } else {
          warnings.push(`忽略 ${f.name}：非 project-manifest（kind=${json && json.kind}）`);
        }
      } catch (err) {
        warnings.push(`忽略 ${f.name}：manifest JSON 解析失败（${err.message}）`);
      }
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.depth - b.depth);
    if (candidates.length > 1) {
      warnings.push(`manifest.json 多个命中（${candidates.length}），取层级最浅者`);
    }
    return { manifest: candidates[0].json, manifestFile: candidates[0].file, warnings };
  }

  /**
   * 子文件定位（08 §8.1 R16 收紧）：manifest 声明的 file 值按 basename 相等匹配；
   * 多命中取层级最浅 + warning；零命中 → 该文件未导入（null，按 §4.4 降级）。
   */
  function locateByBasename(files, manifest) {
    const declared = [];
    const b = manifest.bundles || {};
    if (b.composition) declared.push(b.composition.file);
    if (b.interfaceDetails) declared.push(b.interfaceDetails.file);
    for (const p of b.protocols || []) declared.push(p.dataFile);
    for (const d of b.diff || []) declared.push(d.file);
    const index = {};
    const warnings = [];
    for (const name of new Set(declared.filter(Boolean))) {
      const hits = files.filter((f) => basenameOf(f.webkitRelativePath || f.name) === name);
      if (hits.length === 0) {
        index[name] = null;
        continue;
      }
      hits.sort((a, b2) => depthOf(a.webkitRelativePath || a.name) - depthOf(b2.webkitRelativePath || b2.name));
      if (hits.length > 1) {
        warnings.push(`"${name}" 多个匹配（${hits.length}），取层级最浅者`);
      }
      index[name] = hits[0];
    }
    return { index, warnings };
  }

  /** A 模：File 集合 → 项目状态装配（manifest 发现 + basename 定位 + 守卫） */
  async function importProjectFiles(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return false;
    const found = await findManifestFile(files);
    if (!found) {
      // manifest 缺失 → 维持既有单文件浏览模式（顶栏提示，08 §4.4）
      setStatus('未检测到项目 manifest，当前为单文件浏览模式', 'warn');
      return false;
    }
    const { manifest, warnings } = found;
    if (manifest.kind !== 'project-manifest' || manifest.schemaVersion !== '1.0') {
      setStatus('非项目 manifest（kind/schemaVersion 不符），未解析', 'error');
      return false;
    }
    const located = locateByBasename(files, manifest);
    const allWarnings = warnings.concat(located.warnings);
    state.manifest = manifest;
    state.projectMode = true;
    state.projectData = {};
    state.diffData = {};
    // 组合层 data.json（可缺 → 组合层总览降级）
    const compFile = located.index[manifest.bundles.composition.file];
    state.dataJson = compFile ? JSON.parse(await readFileAsText(compFile)) : null;
    // 接口详情（可缺 → 接口详情降级）
    const idFile = located.index[manifest.bundles.interfaceDetails.file];
    state.interfaceDetails = idFile ? JSON.parse(await readFileAsText(idFile)) : null;
    // 逐协议数据（缺 → null，该协议 tab 显示"数据未导入"）
    for (const p of manifest.bundles.protocols || []) {
      const f = located.index[p.dataFile];
      state.projectData[p.id] = f ? JSON.parse(await readFileAsText(f)) : null;
    }
    // diff 快照（diff tab 消费）
    for (const d of manifest.bundles.diff || []) {
      const f = located.index[d.file];
      state.diffData[d.id] = f ? JSON.parse(await readFileAsText(f)) : null;
    }
    state.nav = { scope: 'project' };
    runProjectFreshness();
    const warnText = allWarnings.length > 0 ? `（${allWarnings.join('；')}）` : '';
    const missing = [];
    for (const p of manifest.bundles.protocols || []) {
      if (!state.projectData[p.id]) missing.push(p.dataFile);
    }
    const missText = missing.length > 0 ? `；未导入：${missing.join('、')}` : '';
    setStatus(
      `✓ 项目已导入：${manifest.project.systemName}（${(manifest.bundles.protocols || []).length} 个子协议）${warnText}${missText}`,
      'ok'
    );
    runRenderHooks();
    return true;
  }

  /** B 模（08 §8.1）：http/https 时 fetch manifest 声明的相对路径（file:// 场景零网络调用） */
  async function importProjectViaFetch() {
    const proto = window.location.protocol;
    if (proto !== 'http:' && proto !== 'https:') return false;
    try {
      const res = await fetch('manifest.json');
      if (!res.ok) return false;
      const manifest = await res.json();
      if (manifest.kind !== 'project-manifest') return false;
      state.manifest = manifest;
      state.projectMode = true;
      state.projectData = {};
      state.diffData = {};
      state.dataJson = await fetchJsonSafely(manifest.bundles.composition.file);
      state.interfaceDetails = await fetchJsonSafely(manifest.bundles.interfaceDetails.file);
      for (const p of manifest.bundles.protocols || []) {
        state.projectData[p.id] = await fetchJsonSafely(p.dataFile);
      }
      for (const d of manifest.bundles.diff || []) {
        state.diffData[d.id] = await fetchJsonSafely(d.file);
      }
      state.nav = { scope: 'project' };
      runProjectFreshness();
      setStatus(`✓ 项目已导入（http 模式）：${manifest.project.systemName}`, 'ok');
      runRenderHooks();
      return true;
    } catch (err) {
      setStatus(`✗ 项目 http 导入失败：${err.message}`, 'error');
      return false;
    }
  }

  /** B 模辅助：fetch 相对路径 JSON；失败 → null（降级由各视图处理） */
  async function fetchJsonSafely(rel) {
    if (!rel) return null;
    try {
      const res = await fetch(rel);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  /** 项目级守卫（TD6）：checkProjectFreshness → 顶栏横幅 + state.projectFreshness */
  function runProjectFreshness() {
    if (!state.manifest) return;
    const verdicts = N1.checkProjectFreshness(state.manifest, {
      protocolData: state.projectData,
      interfaceDetails: state.interfaceDetails,
      compositionData: state.dataJson,
      modelIr: state.projectModelIr,
    });
    state.projectFreshness = verdicts;
    // 顶栏横幅：组合层 S6（warning）+ 接口详情 S5（error）优先展示；逐协议横幅由 TD8 渲染
    const banners = [];
    if (verdicts.composition.alert) banners.push(verdicts.composition.alert);
    if (verdicts.interfaceDetails.alert) banners.push(verdicts.interfaceDetails.alert);
    if (banners.length > 0) {
      const level = verdicts.interfaceDetails.degraded ? verdicts.interfaceDetails.level : verdicts.composition.level;
      els.n1Banner.textContent = banners.join('；');
      els.n1Banner.className = 'n1-banner n1-' + level;
    } else {
      els.n1Banner.textContent = '';
      els.n1Banner.className = 'n1-banner hidden';
    }
  }

  /** 项目导入 dropzone：webkitdirectory 选择 + 目录拖拽（webkitGetAsEntry 递归收集） */
  function setupProjectDropzone() {
    const zone = els.projectDrop;
    const input = els.projectFile;
    zone.addEventListener('click', () => input.click());
    zone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        input.click();
      }
    });
    input.addEventListener('change', () => {
      if (input.files && input.files.length > 0) {
        importProjectFiles(input.files);
        input.value = '';
      }
    });
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('dragging');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragging'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('dragging');
      const items = e.dataTransfer && e.dataTransfer.items;
      if (items && items.length > 0 && typeof items[0].webkitGetAsEntry === 'function') {
        // 目录拖拽：递归收集 File（webkitRelativePath 由浏览器填充）
        const collected = [];
        const queue = Array.from(items).map((it) => it.webkitGetAsEntry()).filter(Boolean);
        const walk = (entry) => {
          if (!entry) return;
          if (entry.isFile) {
            entry.file((f) => {
              if (f) collected.push(f);
            });
          } else if (entry.isDirectory) {
            const reader = entry.createReader();
            const readBatch = () => {
              reader.readEntries((entries) => {
                if (entries.length === 0) return;
                for (const en of entries) walk(en);
                readBatch();
              });
            };
            readBatch();
          }
        };
        queue.forEach(walk);
        // 异步收集完成后再装配（轮询兜底：目录读取是异步的）
        setTimeout(() => {
          if (collected.length > 0) importProjectFiles(collected);
        }, 300);
        return;
      }
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        importProjectFiles(e.dataTransfer.files);
      }
    });
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
  setupProjectDropzone();
  // B 模（08 §8.1）：http/https 时自动 fetch manifest（file:// 场景零网络调用）
  if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
    importProjectViaFetch();
  }

  // 唯一全局出口（状态 + 钩子注册点，TA4/TA5 复用）
  window.ProtochainViewer = {
    state,
    els,
    importModel,
    importData,
    importProjectFiles,
    importProjectViaFetch,
    runN1,
    runProjectFreshness,
    setStatus,
  };
})();
