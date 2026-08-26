/**
 * T4 TD7 viewer 导入层测试（09-execution-T4.md TD7 / 08-project-viewer-design.md §8.1 R5/R9/R16）
 *
 * 机械判据（TD7 验收）：
 * ① jsdom 构造拖项目根目录（前缀 fulfillment-payment/web/）与拖 web/ 目录（前缀 web/）两种
 *    File 集合 → 均正确定位六文件（层级兼容）；
 * ② R16 反向：集合含 old-p1.data.json / backup.p1.data.json → 不命中 p1.data.json（basename 不等）；
 * ③ 多命中（嵌套同名）→ 取最浅 + warning；
 * ④ 误导入非 manifest JSON（kind 不符）→ 显式提示不白屏；
 * ⑤ manifest 缺失 → 既有单协议/组合层导入路径行为与 G3 基线一致（零回归）；
 * ⑥ 静态扫描：无 fetch/XHR/远程资源（B 模 fetch 仅在 http 协议分支内）；
 * ⑦ 守卫联动：S1 失配 fixture → 对应协议视图横幅（jsdom 断言）；
 * ⑧ file:// 双击打开无控制台错误。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInContext } from 'node:vm';
import { JSDOM } from 'jsdom';

const ROOT = process.cwd();
const VIEWER = join(ROOT, 'viewer');
const WEB = join(ROOT, 'examples', 'fulfillment-payment', 'web');

function readViewerFile(rel: string): string {
  return readFileSync(join(VIEWER, rel), 'utf-8');
}

function loadJson(rel: string): unknown {
  return JSON.parse(readFileSync(join(WEB, rel), 'utf-8'));
}

interface ViewerWin {
  ProtochainViewer: {
    state: {
      manifest: { bundles: { protocols: Array<{ id: string; dataFile: string }>; diff: Array<{ id: string; file: string }>; composition: { file: string }; interfaceDetails: { file: string } } } | null;
      projectMode: boolean;
      projectData: Record<string, unknown>;
      interfaceDetails: unknown;
      diffData: Record<string, unknown>;
      dataJson: unknown;
      projectFreshness: { perProtocol: Record<string, { alert: string | null; fresh: boolean; degraded: boolean; level: string }> } | null;
      nav: { scope: string; protocolId?: string; interfaceId?: string } | null;
      n1: { degraded: boolean };
    };
    importProjectFiles: (files: unknown[]) => Promise<boolean>;
    els: { importStatus: { textContent: string; className: string } };
  };
  ProtochainViewerHooks: { renderAll: (s: unknown, p: unknown) => void };
  ProtochainProjectNav: { renderScope: (s: unknown, p: unknown) => void; navigate: (s: unknown, n: unknown) => void };
  [key: string]: unknown;
}

/** 构造带 webkitRelativePath 的 File */
function makeFile(dom: JSDOM, content: unknown, name: string, relPath: string): File {
  const f = new dom.window.File([JSON.stringify(content, null, 2)], name, { type: 'application/json' });
  Object.defineProperty(f, 'webkitRelativePath', { value: relPath, writable: true });
  return f as unknown as File;
}

/** 加载全部 viewer 脚本（与既有 jsdom 测试同构 + T4 新增两面板） */
function setupDom(): { dom: JSDOM; win: ViewerWin } {
  const html = readViewerFile('index.html');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'file:///viewer/index.html' });
  const ctx = dom.getInternalVMContext();
  runInContext(readViewerFile('assets/parser.js'), ctx);
  runInContext(readViewerFile('n1-guard.js'), ctx);
  runInContext(readViewerFile('app.js'), ctx);
  runInContext(readViewerFile('main-view.js'), ctx);
  runInContext(readViewerFile('link-coverage.js'), ctx);
  runInContext(readViewerFile('swimlanes.js'), ctx);
  runInContext(readViewerFile('replay.js'), ctx);
  runInContext(readViewerFile('relations-panel.js'), ctx);
  runInContext(readViewerFile('diff-panel.js'), ctx);
  runInContext(readViewerFile('composition-panel.js'), ctx);
  runInContext(readViewerFile('project-nav.js'), ctx);
  runInContext(readViewerFile('interface-detail-panel.js'), ctx);
  return { dom, win: dom.window as unknown as ViewerWin };
}

/** 演示实例六文件（内容 + 文件名 + 相对路径） */
function demoFiles(prefix: string): Array<{ content: unknown; name: string; rel: string }> {
  const names: Array<{ content: unknown; name: string }> = [
    { content: loadJson('manifest.json'), name: 'manifest.json' },
    { content: loadJson('data.json'), name: 'data.json' },
    { content: loadJson('p1.data.json'), name: 'p1.data.json' },
    { content: loadJson('p2.data.json'), name: 'p2.data.json' },
    { content: loadJson('payment.diff.data.json'), name: 'payment.diff.data.json' },
    { content: loadJson('interface-details.json'), name: 'interface-details.json' },
  ];
  return names.map((x) => ({ ...x, rel: `${prefix}${x.name}` }));
}

describe('TD7 ① 两前缀均正确定位六文件（层级兼容，R9/R16）', () => {
  for (const prefix of ['fulfillment-payment/web/', 'web/']) {
    test(`拖入前缀 ${prefix} → 六文件全部定位`, async () => {
      const { dom, win } = setupDom();
      const files = demoFiles(prefix).map((f) => makeFile(dom, f.content, f.name, f.rel));
      const ok = await win.ProtochainViewer.importProjectFiles(files);
      expect(ok).toBe(true);
      const s = win.ProtochainViewer.state;
      expect(s.manifest).not.toBeNull();
      expect(s.projectMode).toBe(true);
      expect(s.projectData.P1).not.toBeNull();
      expect(s.projectData.P2).not.toBeNull();
      expect(s.dataJson).not.toBeNull();
      expect(s.interfaceDetails).not.toBeNull();
      expect(s.diffData['payment-v1-v2']).not.toBeNull();
      // 守卫正向 fresh
      expect(s.projectFreshness?.perProtocol.P1.fresh).toBe(true);
      expect(s.projectFreshness?.perProtocol.P2.fresh).toBe(true);
    });
  }
});

describe('TD7 ② R16 反向：old-p1.data.json / backup.p1.data.json 不命中 p1.data.json', () => {
  test('basename 不等 → projectData.P1 = null（未导入降级）', async () => {
    const { dom, win } = setupDom();
    const files = demoFiles('web/');
    // 把 p1.data.json 替换为 old-p1.data.json（前缀粘连误命中反例）
    const withoutP1 = files.filter((f) => f.name !== 'p1.data.json');
    withoutP1.push({ content: loadJson('p1.data.json'), name: 'old-p1.data.json', rel: 'web/old-p1.data.json' });
    withoutP1.push({ content: loadJson('p1.data.json'), name: 'backup.p1.data.json', rel: 'web/backup.p1.data.json' });
    const fileList = withoutP1.map((f) => makeFile(dom, f.content, f.name, f.rel));
    await win.ProtochainViewer.importProjectFiles(fileList);
    const s = win.ProtochainViewer.state;
    expect(s.manifest).not.toBeNull();
    // 不命中 p1.data.json（basename 相等规则）
    expect(s.projectData.P1).toBeNull();
    // P2 正常命中
    expect(s.projectData.P2).not.toBeNull();
  });
});

describe('TD7 ③ 多命中（嵌套同名真重复）→ 取层级最浅 + warning', () => {
  test('web/p1.data.json 与 deep/web/p1.data.json 并存 → 取 web/ 层级最浅者', async () => {
    const { dom, win } = setupDom();
    const files = demoFiles('web/');
    // 追加一个更深层级的 p1.data.json
    files.push({ content: { schemaVersion: '1.0', sourceModelVersion: '9.9.9', interfaces: [], stateMachine: { nodes: [], edges: [] } }, name: 'p1.data.json', rel: 'web/backup/web/p1.data.json' });
    const fileList = files.map((f) => makeFile(dom, f.content, f.name, f.rel));
    await win.ProtochainViewer.importProjectFiles(fileList);
    const s = win.ProtochainViewer.state;
    // 取层级最浅者（真实 p1.data.json，sourceModelVersion=1.0.0）
    expect((s.projectData.P1 as { sourceModelVersion: string }).sourceModelVersion).toBe('1.0.0');
    // warning 提示
    expect(win.ProtochainViewer.els.importStatus.textContent).toContain('多个匹配');
  });
});

describe('TD7 ④ 误导入非 manifest JSON（kind 不符）→ 显式提示不白屏', () => {
  test('manifest.json 内容 kind !== project-manifest → 不解析、显式提示', async () => {
    const { dom, win } = setupDom();
    const files = demoFiles('web/');
    const idx = files.findIndex((f) => f.name === 'manifest.json');
    files[idx] = { content: { kind: 'other', schemaVersion: '1.0' }, name: 'manifest.json', rel: 'web/manifest.json' };
    const fileList = files.map((f) => makeFile(dom, f.content, f.name, f.rel));
    await win.ProtochainViewer.importProjectFiles(fileList);
    const s = win.ProtochainViewer.state;
    expect(s.manifest).toBeNull();
    expect(win.ProtochainViewer.els.importStatus.textContent).toContain('未检测到项目 manifest');
    // 不白屏：主视图容器存在
    expect(dom.window.document.querySelector('#panels')).not.toBeNull();
  });
});

describe('TD7 ⑤ manifest 缺失 → 既有单文件模式零回归', () => {
  test('只拖 model.md + data.json → 不进入项目模式，renderAll 全量堆叠（G3 基线）', async () => {
    const { dom, win } = setupDom();
    const files = demoFiles('web/');
    // 去掉 manifest.json → findManifestFile 返回 null → 单文件浏览模式提示
    const noManifest = files.filter((f) => f.name !== 'manifest.json');
    const fileList = noManifest.map((f) => makeFile(dom, f.content, f.name, f.rel));
    await win.ProtochainViewer.importProjectFiles(fileList);
    expect(win.ProtochainViewer.state.manifest).toBeNull();
    expect(win.ProtochainViewer.els.importStatus.textContent).toContain('单文件浏览模式');
    // 单文件导入路径照常工作（G3 基线行为）
    win.ProtochainViewer.state.dataJson = loadJson('data.json');
    win.ProtochainViewerHooks.renderAll(win.ProtochainViewer.state, dom.window.document.querySelector('#panels'));
    // 组合层面板正常渲染（组合层 data.json schemaVersion=1.1）
    expect(dom.window.document.querySelector('.composition-panel')?.textContent).toContain('组合层面板');
  });
});

describe('TD7 ⑥ 静态扫描：B 模 fetch 仅在 http 协议分支内（file:// 零网络调用）', () => {
  test('app.js 中 fetch 仅出现在协议分支守卫内', () => {
    const code = readViewerFile('app.js');
    // fetch 出现（B 模）
    expect(code).toMatch(/fetch\(/);
    // 但受协议分支保护：file:// 下不调用
    expect(code).toMatch(/proto !== 'http:' && proto !== 'https:'/);
    expect(code).toMatch(/return false/);
    // 无远程资源 / 无框架
    expect(code).not.toMatch(/https?:\/\//);
    expect(code).not.toContain('import React');
  });

  test('project-nav / interface-detail-panel 无 fetch/XHR/远程资源', () => {
    for (const f of ['project-nav.js', 'interface-detail-panel.js']) {
      const code = readViewerFile(f);
      expect(code).not.toMatch(/\bfetch\s*\(/);
      expect(code).not.toMatch(/XMLHttpRequest/);
      expect(code).not.toMatch(/https?:\/\//);
      expect(code).not.toContain('import React');
      expect(code).not.toContain('Vue');
      expect(code).not.toContain('angular');
    }
  });

  test('index.html 脚本全部本地相对路径', () => {
    const html = readViewerFile('index.html');
    const scriptSrcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
    for (const src of scriptSrcs) {
      expect(src.startsWith('http://') || src.startsWith('https://') || src.startsWith('//')).toBe(false);
    }
  });
});

describe('TD7 ⑦ 守卫联动：S1 失配 fixture → 对应协议视图横幅', () => {
  test('旧 p1.data.json（sourceModelVersion=0.9.0）混入 → P1 协议头显示降级横幅，P2 不受影响', async () => {
    const { dom, win } = setupDom();
    const files = demoFiles('web/');
    const idx = files.findIndex((f) => f.name === 'p1.data.json');
    const p1 = loadJson('p1.data.json') as { sourceModelVersion: string };
    files[idx] = { content: { ...p1, sourceModelVersion: '0.9.0' }, name: 'p1.data.json', rel: 'web/p1.data.json' };
    const fileList = files.map((f) => makeFile(dom, f.content, f.name, f.rel));
    await win.ProtochainViewer.importProjectFiles(fileList);
    const s = win.ProtochainViewer.state;
    expect(s.projectFreshness?.perProtocol.P1.degraded).toBe(true);
    expect(s.projectFreshness?.perProtocol.P1.level).toBe('error');
    expect(s.projectFreshness?.perProtocol.P1.alert).toContain('v0.9.0');
    expect(s.projectFreshness?.perProtocol.P2.fresh).toBe(true);
    // 渲染协议 scope → 协议头横幅
    win.ProtochainProjectNav.navigate(s, { scope: 'protocol', protocolId: 'P1' });
    const panels = dom.window.document.querySelector('#panels');
    expect(panels?.textContent ?? '').toContain('增强数据过期');
    expect(panels?.textContent ?? '').toContain('v0.9.0');
  });
});

describe('TD7 ⑧ file:// 双击打开无控制台错误', () => {
  test('jsdom file:// 加载 + 项目导入渲染期间无 console.error', async () => {
    const errors: unknown[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      const { dom, win } = setupDom();
      const files = demoFiles('web/').map((f) => makeFile(dom, f.content, f.name, f.rel));
      await win.ProtochainViewer.importProjectFiles(files);
      win.ProtochainProjectNav.renderScope(win.ProtochainViewer.state, dom.window.document.querySelector('#panels'));
    } finally {
      console.error = origError;
    }
    expect(errors).toEqual([]);
  });
});
