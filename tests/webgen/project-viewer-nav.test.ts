/**
 * T4 TD8 project-nav 导航控制器测试（09-execution-T4.md TD8 / 08-project-viewer-design.md §8.2/8.3 R8）
 *
 * 机械判据（TD8 验收）：
 * ① jsdom 演示实例：tab 数 = 6（项目总览/接口目录[G5 新增]/组合层/P1/P2/diff），tab 标题与 manifest 逐字段一致；
 * ② scope 切换：项目→P1→接口 → 面包屑文本逐级正确；
 * ③ diff tab：payment-v1-v2 条目显示 diffView 摘要（changedTransitions=[T5] 可数）+ IF_SYS_T5 可点击；
 * ④ L3 下钻 IF_SYS_T5 → 面包屑"项目 → P2 → IF_SYS_T5（diff 新增）"+ 快照摘要渲染；
 * ⑤ P2 tab badge："本协议有 1 个 diff 快照"；
 * ⑥ 零回归：无 manifest 单文件导入 → renderAll 全量堆叠与 G3 基线一致；
 * ⑦ 静态扫描无新增网络/框架；
 * ⑧ file:// 双击无控制台错误。
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

interface NavWin {
  ProtochainViewer: {
    state: {
      manifest: { bundles: { protocols: Array<{ id: string; name: string }>; diff: Array<{ sourceProtocolId: string; id: string }> } } | null;
      projectMode: boolean;
      projectData: Record<string, unknown>;
      interfaceDetails: unknown;
      diffData: Record<string, unknown>;
      dataJson: unknown;
      nav: { scope: string; protocolId?: string; interfaceId?: string; diffId?: string } | null;
    };
    importProjectFiles: (files: unknown[]) => Promise<boolean>;
  };
  ProtochainProjectNav: {
    renderScope: (s: unknown, p: unknown) => void;
    navigate: (s: unknown, n: unknown) => void;
  };
  [key: string]: unknown;
}

function makeFile(dom: JSDOM, content: unknown, name: string, relPath: string): File {
  const f = new dom.window.File([JSON.stringify(content, null, 2)], name, { type: 'application/json' });
  Object.defineProperty(f, 'webkitRelativePath', { value: relPath, writable: true });
  return f as unknown as File;
}

function setupDom(): { dom: JSDOM; win: NavWin } {
  const html = readViewerFile('index.html');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'file:///viewer/index.html' });
  const ctx = dom.getInternalVMContext();
  for (const f of ['assets/parser.js', 'n1-guard.js', 'app.js', 'main-view.js', 'link-coverage.js', 'swimlanes.js', 'replay.js', 'relations-panel.js', 'diff-panel.js', 'composition-panel.js', 'project-nav.js', 'interface-detail-panel.js']) {
    runInContext(readViewerFile(f), ctx);
  }
  return { dom, win: dom.window as unknown as NavWin };
}

function demoFiles(prefix = 'web/'): Array<{ content: unknown; name: string; rel: string }> {
  const names = ['manifest.json', 'data.json', 'p1.data.json', 'p2.data.json', 'payment.diff.data.json', 'interface-details.json'];
  return names.map((n) => ({ content: loadJson(n), name: n, rel: prefix + n }));
}

async function importDemo(dom: JSDOM, win: NavWin): Promise<void> {
  const files = demoFiles().map((f) => makeFile(dom, f.content, f.name, f.rel));
  await win.ProtochainViewer.importProjectFiles(files);
}

function text(dom: JSDOM): string {
  return (dom.window.document.querySelector('#panels')?.textContent ?? '');
}

function click(dom: JSDOM, el: Element | null): void {
  if (el) el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
}

describe('TD8 ① tab 数 = 6（含 G5 新增"接口目录"）且标题对齐 manifest', () => {
  test('项目总览/接口目录/组合层/P1/P2/diff', async () => {
    const { dom, win } = setupDom();
    await importDemo(dom, win);
    win.ProtochainProjectNav.renderScope(win.ProtochainViewer.state, dom.window.document.querySelector('#panels'));
    const tabs = [...dom.window.document.querySelectorAll('.pn-tab')];
    expect(tabs.length).toBe(6);
    const labels = tabs.map((t) => t.querySelector('.pn-tab-label')?.textContent?.trim());
    expect(labels[0]).toBe('项目总览');
    expect(labels[1]).toBe('接口目录'); // G5 TI7：interface-details/catalog 在场即出现，自动启停（红线二）
    expect(labels[2]).toBe('组合层');
    expect(labels[3]).toBe('P1');
    expect(labels[4]).toBe('P2');
    expect(labels[5]).toBe('diff');
    // tab 数 = protocols.length + 4（项目总览 + 接口目录 + 组合层 + diff）
    expect(tabs.length).toBe(win.ProtochainViewer.state.manifest!.bundles.protocols.length + 4);
  });
});

describe('TD8 ② scope 切换：面包屑逐级正确', () => {
  test('项目 → P1 → 接口 IF_SYS_T4 面包屑', async () => {
    const { dom, win } = setupDom();
    await importDemo(dom, win);
    const s = win.ProtochainViewer.state;
    const panels = dom.window.document.querySelector('#panels');
    // 项目
    win.ProtochainProjectNav.renderScope(s, panels);
    expect(text(dom)).toContain('履约-支付组合系统');
    // P1
    win.ProtochainProjectNav.navigate(s, { scope: 'protocol', protocolId: 'P1' });
    expect(text(dom)).toContain('项目');
    expect(text(dom)).toContain('P1');
    expect(text(dom)).toContain('履约协议');
    // 接口
    win.ProtochainProjectNav.navigate(s, { scope: 'interface', protocolId: 'P1', interfaceId: 'IF_SYS_T4' });
    expect(text(dom)).toContain('IF_SYS_T4');
    // 面包屑文本：项目 → P1 → IF_SYS_T4
    const crumb = dom.window.document.querySelector('.pn-breadcrumb')?.textContent ?? '';
    expect(crumb).toContain('项目');
    expect(crumb).toContain('P1');
    expect(crumb).toContain('IF_SYS_T4');
  });

  test('组合层 scope 面包屑 + 组合层面板', async () => {
    const { dom, win } = setupDom();
    await importDemo(dom, win);
    const s = win.ProtochainViewer.state;
    win.ProtochainProjectNav.navigate(s, { scope: 'composition' });
    expect((dom.window.document.querySelector('.pn-breadcrumb')?.textContent ?? '')).toContain('组合层');
    expect(text(dom)).toContain('组合层面板');
  });
});

describe('TD8 ③ diff tab：diffView 摘要可数 + IF_SYS_T5 可点击', () => {
  test('payment-v1-v2 条目：changedTransitions=[T5]、受影响接口 IF_SYS_T5', async () => {
    const { dom, win } = setupDom();
    await importDemo(dom, win);
    const s = win.ProtochainViewer.state;
    win.ProtochainProjectNav.navigate(s, { scope: 'diff' });
    const t = text(dom);
    expect(t).toContain('payment-v1-v2');
    expect(t).toContain('P2');
    expect(t).toContain('v1.0.0');
    expect(t).toContain('v1.1.0');
    // 变更转移可数（T5 高亮 chip）
    expect(t).toContain('T5');
    expect(t).toContain('IF_SYS_T5');
    const ifaceChip = dom.window.document.querySelector('[data-diff-iface="IF_SYS_T5"]');
    expect(ifaceChip).not.toBeNull();
    // 快照状态机高亮（T5 行高亮）
    const hlRows = [...dom.window.document.querySelectorAll('.pn-state-table tr.hl')];
    expect(hlRows.length).toBeGreaterThan(0);
  });
});

describe('TD8 ④ L3 下钻 IF_SYS_T5（diff 新增）', () => {
  test('面包屑"项目 → P2 → IF_SYS_T5（diff 新增）"+ 快照摘要渲染', async () => {
    const { dom, win } = setupDom();
    await importDemo(dom, win);
    const s = win.ProtochainViewer.state;
    win.ProtochainProjectNav.navigate(s, { scope: 'diff' });
    const chip = dom.window.document.querySelector('[data-diff-iface="IF_SYS_T5"]');
    click(dom, chip);
    const crumb = dom.window.document.querySelector('.pn-breadcrumb')?.textContent ?? '';
    expect(crumb).toContain('项目');
    expect(crumb).toContain('P2');
    expect(crumb).toContain('IF_SYS_T5');
    expect(crumb).toContain('diff 新增');
    // 快照摘要渲染（name refund_partial / 快照 payment-v1-v2）
    const t = text(dom);
    expect(t).toContain('refund_partial');
    expect(t).toContain('payment-v1-v2');
  });
});

describe('TD8 ⑤ P2 tab badge：本协议有 1 个 diff 快照', () => {
  test('P2 tab 徽标存在且文案正确', async () => {
    const { dom, win } = setupDom();
    await importDemo(dom, win);
    const s = win.ProtochainViewer.state;
    win.ProtochainProjectNav.navigate(s, { scope: 'protocol', protocolId: 'P2' });
    const badges = [...dom.window.document.querySelectorAll('.pn-badge')];
    expect(badges.length).toBeGreaterThan(0);
    const badgeTexts = badges.map((b) => b.textContent ?? '').join('|');
    expect(badgeTexts).toContain('1');
    // 协议头 badge 文案
    expect(text(dom)).toContain('本协议有 1 个 diff 快照');
    // P1 无 badge
    win.ProtochainProjectNav.navigate(s, { scope: 'protocol', protocolId: 'P1' });
    expect(text(dom)).not.toContain('本协议有 1 个 diff 快照');
  });
});

describe('TD8 ⑥ 零回归：无 manifest 单文件导入 → renderAll 全量堆叠（G3 基线）', () => {
  test('单协议 data.json 导入 → 主视图 + 面板堆叠（不进入项目导航）', async () => {
    const { dom, win } = setupDom();
    const s = win.ProtochainViewer.state;
    s.dataJson = loadJson('p1.data.json');
    // project-nav 的 renderAll 包裹在非项目模式透传 baseRenderAll
    win.ProtochainViewerHooks.renderAll(s, dom.window.document.querySelector('#panels'));
    // 主视图 SVG + 面板渲染（G3 基线行为）
    expect(dom.window.document.querySelectorAll('.sm-svg').length).toBeGreaterThan(0);
    expect(dom.window.document.querySelector('.pn-tabs')).toBeNull();
  });
});

describe('TD8 ⑦ 静态扫描', () => {
  test('project-nav.js 无网络/框架引入', () => {
    const code = readViewerFile('project-nav.js');
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/XMLHttpRequest/);
    expect(code).not.toMatch(/https?:\/\//);
    expect(code).not.toContain('import React');
  });
});

describe('TD8 ⑧ file:// 双击无控制台错误', () => {
  test('全流程导航渲染无 console.error', async () => {
    const errors: unknown[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      const { dom, win } = setupDom();
      await importDemo(dom, win);
      const s = win.ProtochainViewer.state;
      const panels = dom.window.document.querySelector('#panels');
      for (const nav of [
        { scope: 'project' },
        { scope: 'composition' },
        { scope: 'protocol', protocolId: 'P1' },
        { scope: 'interface', protocolId: 'P1', interfaceId: 'IF_SYS_T4' },
        { scope: 'diff' },
        { scope: 'interface', protocolId: 'P2', interfaceId: 'IF_SYS_T5' },
      ]) {
        win.ProtochainProjectNav.navigate(s, nav);
      }
    } finally {
      console.error = origError;
    }
    expect(errors).toEqual([]);
  });
});
