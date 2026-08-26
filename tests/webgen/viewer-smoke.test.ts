/**
 * viewer 骨架静态资产冒烟（W3-a / TA3）
 *
 * 机械判据（05-execution-T1.md §TA3 验收）：
 * ① N1 正反向：版本匹配无警示、不匹配出警示 ——（viewer-n1-guard.test.ts 已覆盖纯函数；
 *    本文件做 jsdom 集成冒烟：警示条真实渲染/隐藏）
 * ② 双击 file:// 打开无控制台错误、无网络请求 ——（jsdom 无网络加载 + 静态扫描无 fetch/XHR/http 引用）
 * ③ 导入 fixture model.md 后页面显示模型名/版本/状态数 ——（jsdom 模拟 File 导入断言 DOM）
 *
 * 实现方式：JSDOM + 注入 viewer 三件套（assets/parser.js + n1-guard.js + app.js），
 * 模拟浏览器环境（window.ProtochainParser / N1Guard / FileReader）。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInContext } from 'node:vm';
import { JSDOM } from 'jsdom';

const ROOT = process.cwd();
const VIEWER = join(ROOT, 'viewer');

function readViewerFile(rel: string): string {
  return readFileSync(join(VIEWER, rel), 'utf-8');
}

interface SmokeWindow {
  ProtochainParser?: { PARSER_VERSION: string; parseProtocolContent: (c: string, n?: string) => unknown };
  ProtochainViewer?: {
    state: {
      modelIr: { metadata: { name: string; version: string }; derivable: { states: unknown[]; transitions: unknown[] } } | null;
      dataJson: { sourceModelVersion: string } | null;
      n1: { fresh: boolean; degraded: boolean; alert: string | null; level: string };
    };
    importModel: (file: unknown) => Promise<void>;
    importData: (file: unknown) => Promise<void>;
  };
  [key: string]: unknown;
}

function setupDom(): { dom: JSDOM; win: SmokeWindow } {
  const html = readViewerFile('index.html');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'file:///viewer/index.html' });
  const win = dom.window as unknown as SmokeWindow;
  // 注入三件套（顺序与 index.html 一致）。
  // 用 vm.runInContext 而非 win.eval：jsdom 的 outside-only eval 不会把顶层
  // var 声明挂到 window（真实浏览器 <script> 行为），runInContext 与浏览器一致。
  const ctx = dom.getInternalVMContext();
  runInContext(readViewerFile('assets/parser.js'), ctx);
  runInContext(readViewerFile('n1-guard.js'), ctx);
  runInContext(readViewerFile('app.js'), ctx);
  return { dom, win };
}

/** 构造 jsdom File（jsdom 支持 FileReader + File） */
function makeFile(win: SmokeWindow, content: string, name: string): unknown {
  const W = win as unknown as { File: new (parts: string[], name: string, opts?: object) => unknown };
  return new W.File([content], name, { type: 'text/plain' });
}

/** 读取渲染后的模型信息文本 */
function modelInfoText(dom: JSDOM): string {
  return dom.window.document.querySelector('.model-info')?.textContent ?? '';
}

function bannerText(dom: JSDOM): string {
  const b = dom.window.document.querySelector('#n1-banner');
  return b ? (b.textContent ?? '') + '|' + (b.className ?? '') : '';
}

describe('viewer 静态资产冒烟（W3-a / TA3）', () => {
  test('① 骨架加载：版本角标展示"内嵌 parser v0.1.0"', () => {
    const { dom } = setupDom();
    expect(dom.window.document.querySelector('#parser-version')?.textContent).toBe('内嵌 parser v0.1.0');
  });

  test('③ 导入 fixture model.md → 显示模型名/版本/状态数（8 状态 · 11 转移）', async () => {
    const { dom, win } = setupDom();
    const content = readViewerFile('samples/food-delivery.model.md');
    await win.ProtochainViewer!.importModel(makeFile(win, content, 'model.md'));
    const info = modelInfoText(dom);
    expect(info).toContain('外卖订单履约协议');
    expect(info).toContain('v1.0.0');
    expect(info).toContain('状态 8');
    expect(info).toContain('转移 11');
    // 状态机数据已就绪（TA4 渲染输入）
    expect(win.ProtochainViewer!.state.modelIr).not.toBeNull();
  });

  test('① N1 反向：导入过期 data.json（版本不匹配）→ 警示条出现"增强数据过期"', async () => {
    const { dom, win } = setupDom();
    const modelContent = readViewerFile('samples/food-delivery.model.md');
    await win.ProtochainViewer!.importModel(makeFile(win, modelContent, 'model.md'));
    // 构造过期增强数据：sourceModelVersion 与 model 版本（1.0.0）不匹配
    const stale = JSON.parse(readViewerFile('samples/food-delivery.data.json')) as { sourceModelVersion: string };
    stale.sourceModelVersion = '0.9.0';
    await win.ProtochainViewer!.importData(makeFile(win, JSON.stringify(stale), 'data.json'));
    const banner = bannerText(dom);
    expect(banner).toContain('增强数据过期');
    expect(banner).toContain('v0.9.0 vs v1.0.0');
    expect(banner).toContain('n1-error');
    // 降级状态联动（TA5 ⑥ 据此不着色）
    expect(win.ProtochainViewer!.state.n1.degraded).toBe(true);
  });

  test('① N1 正向：导入匹配版本 data.json → 无警示条', async () => {
    const { dom, win } = setupDom();
    const modelContent = readViewerFile('samples/food-delivery.model.md');
    await win.ProtochainViewer!.importModel(makeFile(win, modelContent, 'model.md'));
    const fresh = readViewerFile('samples/food-delivery.data.json'); // sourceModelVersion = 1.0.0
    await win.ProtochainViewer!.importData(makeFile(win, fresh, 'data.json'));
    const banner = bannerText(dom);
    expect(banner).toContain('hidden');
    expect(win.ProtochainViewer!.state.n1.degraded).toBe(false);
    expect(win.ProtochainViewer!.state.n1.fresh).toBe(true);
  });

  test('② 静态扫描：viewer 三件套无 XHR/远程 http 引用；B 模 fetch 仅限 http 协议分支（纯本地离线）', () => {
    const html = readViewerFile('index.html');
    const app = readViewerFile('app.js');
    const n1 = readViewerFile('n1-guard.js');
    // 无网络请求 API（T4 08 §8.1 B 模例外：fetch 仅出现在 http/https 协议分支内——
    // file:// 场景零网络调用；XMLHttpRequest/WebSocket/sendBeacon 全禁）
    for (const bad of ['XMLHttpRequest', 'WebSocket(', 'navigator.sendBeacon']) {
      expect(app).not.toContain(bad);
      expect(n1).not.toContain(bad);
    }
    // B 模 fetch 存在但受协议分支保护（08 红线 4：http 模 B 例外）
    expect(app).toContain('fetch(');
    expect(app).toMatch(/proto !== 'http:' && proto !== 'https:'/);
    // 无远程资源引用（script/link href 均为本地相对路径）
    const remoteRefs = html.match(/(?:src|href)="https?:\/\//g);
    expect(remoteRefs).toBeNull();
    // 不引用 CDN / 不内联远程 import
    expect(app).not.toMatch(/import\s+.*from\s+['"]https?:/);
    expect(n1).not.toMatch(/import\s+.*from\s+['"]https?:/);
  });

  test('② 骨架 DOM 结构完整：导入区/版本角标/警示条/面板容器齐备', () => {
    const { dom } = setupDom();
    const d = dom.window.document;
    expect(d.querySelector('#model-drop')).not.toBeNull();
    expect(d.querySelector('#data-drop')).not.toBeNull();
    expect(d.querySelector('#project-drop')).not.toBeNull();
    expect(d.querySelector('#parser-version')).not.toBeNull();
    expect(d.querySelector('#n1-banner')).not.toBeNull();
    expect(d.querySelector('#panels')).not.toBeNull();
    // 无框架：无外部框架脚本（仅本地 12 件套 + 无 CDN；T2 新增 swimlanes/replay/relations-panel，
    // T3 新增 diff-panel/composition-panel，T4 新增 project-nav/interface-detail-panel）
    const scripts = [...d.querySelectorAll('script[src]')].map((s) => s.getAttribute('src'));
    expect(scripts).toEqual([
      'assets/parser.js',
      'n1-guard.js',
      'app.js',
      'main-view.js',
      'link-coverage.js',
      'swimlanes.js',
      'replay.js',
      'relations-panel.js',
      'diff-panel.js',
      'composition-panel.js',
      'project-nav.js',
      'interface-detail-panel.js',
    ]);
  });
});
