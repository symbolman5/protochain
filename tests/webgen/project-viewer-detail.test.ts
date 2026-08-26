/**
 * T4 TD9 接口详情面板测试（09-execution-T4.md TD9 / 08-project-viewer-design.md §5 + R10 + §6.4）
 *
 * 机械判据（TD9 验收）：
 * ① jsdom 演示实例 P1/IF_SYS_T4：五段渲染与 §5.3 示例逐字段一致（triggerRoleId=platform /
 *    ownedTransitions=[T4] / 前置[S2] 后置[S4] / coveredInvariants 含 INV2"取消不产生履约费用" /
 *    diffImpact 未受影响 / binding 未读取 / crossRefs 4 条）；
 * ② crossRefs 点击（resolved=false）→ 显示 reason"语义别名：P2 当前版本状态集无 S_refunded，
 *    接口/资源池亦无命中"，不发生导航；
 * ③ fixture downlink resolved=true（kind=state）→ 点击跳目标协议状态高亮（§6.4 查表）；
 * ④ diffImpact.affected=true 条目（fixture）→ 高亮 + summary 展示；
 * ⑤ 五项降级场景（08 §5.4 表逐行）显式提示不白屏；
 * ⑥ 静态扫描 + file:// 双击无错误。
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

interface DetailWin {
  ProtochainViewer: {
    state: {
      manifest: unknown;
      projectMode: boolean;
      projectData: Record<string, unknown>;
      interfaceDetails: unknown;
      diffData: Record<string, unknown>;
      dataJson: unknown;
      nav: { scope: string; protocolId?: string; interfaceId?: string } | null;
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

function setupDom(): { dom: JSDOM; win: DetailWin } {
  const html = readViewerFile('index.html');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'file:///viewer/index.html' });
  const ctx = dom.getInternalVMContext();
  for (const f of ['assets/parser.js', 'n1-guard.js', 'app.js', 'main-view.js', 'link-coverage.js', 'swimlanes.js', 'replay.js', 'relations-panel.js', 'diff-panel.js', 'composition-panel.js', 'project-nav.js', 'interface-detail-panel.js']) {
    runInContext(readViewerFile(f), ctx);
  }
  return { dom, win: dom.window as unknown as DetailWin };
}

function demoFiles(prefix = 'web/'): Array<{ content: unknown; name: string; rel: string }> {
  const names = ['manifest.json', 'data.json', 'p1.data.json', 'p2.data.json', 'payment.diff.data.json', 'interface-details.json'];
  return names.map((n) => ({ content: loadJson(n), name: n, rel: prefix + n }));
}

async function importDemo(dom: JSDOM, win: DetailWin): Promise<void> {
  const files = demoFiles().map((f) => makeFile(dom, f.content, f.name, f.rel));
  await win.ProtochainViewer.importProjectFiles(files);
}

function text(dom: JSDOM): string {
  return (dom.window.document.querySelector('#panels')?.textContent ?? '');
}

async function openDetail(dom: JSDOM, win: DetailWin, protocolId: string, interfaceId: string): Promise<void> {
  await importDemo(dom, win);
  win.ProtochainProjectNav.navigate(win.ProtochainViewer.state, { scope: 'interface', protocolId, interfaceId });
}

describe('TD9 ① P1/IF_SYS_T4 五段渲染与 §5.3 示例逐字段一致', () => {
  test('接口段/关系段/binding/diffImpact/crossRefs 五段齐全且值正确', async () => {
    const { dom, win } = setupDom();
    await openDetail(dom, win, 'P1', 'IF_SYS_T4');
    const t = text(dom);
    // ① 接口自身
    expect(t).toContain('refund_cancel');
    expect(t).toContain('system');
    expect(t).toContain('platform'); // triggerRoleId
    expect(t).toContain('退款已批准 且 P2.S_refunded'); // description
    expect(t).toContain('legacy-stub'); // schemaKind
    // ② 关系
    expect(t).toContain('T4');
    expect(t).toContain('S2');
    expect(t).toContain('S4');
    expect(t).toContain('INV2'); // coveredInvariants
    expect(t).toContain('取消不产生履约费用');
    // ③ binding：未读取到 bindings.yaml
    expect(t).toContain('未读取到 bindings.yaml');
    // ④ diffImpact：未受影响
    expect(t).toContain('否');
    // ⑤ crossRefs 4 条
    const refRows = dom.window.document.querySelectorAll('.idp-ref-row');
    expect(refRows.length).toBe(4);
  });
});

describe('TD9 ② crossRefs resolved=false → 显示 reason，不发生导航', () => {
  test('点击降级引用 → reason 文案显示，nav 保持 interface scope', async () => {
    const { dom, win } = setupDom();
    await openDetail(dom, win, 'P1', 'IF_SYS_T4');
    const row = dom.window.document.querySelector('.idp-ref-row[data-resolved="0"]');
    expect(row).not.toBeNull();
    // 降级文案（语义别名，viewer 不做 target 推断）
    expect(row!.textContent ?? '').toContain('语义别名：P2 当前版本状态集无 S_refunded，接口/资源池亦无命中');
    row!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    // 不发生导航：scope 仍为 interface
    expect(win.ProtochainViewer.state.nav?.scope).toBe('interface');
    expect(win.ProtochainViewer.state.nav?.interfaceId).toBe('IF_SYS_T4');
  });
});

describe('TD9 ③ fixture downlink resolved=true（kind=state）→ 点击跳目标协议状态高亮', () => {
  test('手工注入 resolved=true 引用 → 点击后 nav 跳 P2 协议 scope', async () => {
    const { dom, win } = setupDom();
    await openDetail(dom, win, 'P1', 'IF_SYS_T4');
    // 手工注入一条 resolved=true 的 crossRef（P2 真实状态 S3）
    const details = loadJson('interface-details.json') as {
      entries: { P1: { IF_SYS_T4: { crossRefs: Array<Record<string, unknown>> } } };
    };
    details.entries.P1.IF_SYS_T4.crossRefs = [
      {
        kind: 'guard',
        toProtocol: 'P2',
        target: 'S3',
        sourceField: 'precondition',
        context: 'fixture',
        downlink: { resolved: true, kind: 'state', protocolId: 'P2', target: 'S3' },
      },
    ];
    win.ProtochainViewer.state.interfaceDetails = details;
    win.ProtochainProjectNav.navigate(win.ProtochainViewer.state, { scope: 'interface', protocolId: 'P1', interfaceId: 'IF_SYS_T4' });
    const row = dom.window.document.querySelector('.idp-ref-row[data-resolved="1"]');
    expect(row).not.toBeNull();
    expect(row!.textContent ?? '').toContain('已解析 → state S3（点击定位）');
    // 点击 → 跳目标协议 scope（§6.4 查表定位）
    row!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    expect(win.ProtochainViewer.state.nav?.scope).toBe('protocol');
    expect(win.ProtochainViewer.state.nav?.protocolId).toBe('P2');
  });
});

describe('TD9 ④ diffImpact.affected=true → 高亮 + summary 展示', () => {
  test('手工注入受影响条目 → 高亮"是"+变更转移 T5 + summary', async () => {
    const { dom, win } = setupDom();
    await openDetail(dom, win, 'P2', 'IF_SYS_T1');
    const details = loadJson('interface-details.json') as {
      entries: { P2: { IF_SYS_T1: { relation: { diffImpact: unknown } } } };
    };
    details.entries.P2.IF_SYS_T1.relation.diffImpact = {
      affected: true,
      changedTransitions: ['T5'],
      changedStates: [],
      changedOthers: [],
      summary: '元数据 2 项变更；可读层 3 项变更；可推演层 1 项变更',
    };
    win.ProtochainViewer.state.interfaceDetails = details;
    win.ProtochainProjectNav.navigate(win.ProtochainViewer.state, { scope: 'interface', protocolId: 'P2', interfaceId: 'IF_SYS_T1' });
    const t = text(dom);
    expect(t).toContain('受影响');
    expect(t).toContain('T5');
    expect(t).toContain('元数据 2 项变更');
    // 高亮 chip 存在（.idp-chip.hl）
    expect(dom.window.document.querySelectorAll('.idp-chip.hl').length).toBeGreaterThan(0);
  });
});

describe('TD9 ⑤ 五项降级场景显式提示不白屏（08 §5.4）', () => {
  test('interface-details.json 缺失 → "接口详情数据未生成"', async () => {
    const { dom, win } = setupDom();
    await importDemo(dom, win);
    win.ProtochainViewer.state.interfaceDetails = null;
    win.ProtochainProjectNav.navigate(win.ProtochainViewer.state, { scope: 'interface', protocolId: 'P1', interfaceId: 'IF_SYS_T4' });
    const t = text(dom);
    expect(t).toContain('接口详情数据未生成');
    expect(t).toContain('interface-details.json');
    expect(dom.window.document.querySelector('#panels')).not.toBeNull();
  });

  test('该协议条目缺失（specs 不可读）→ 显式提示', async () => {
    const { dom, win } = setupDom();
    await importDemo(dom, win);
    const details = loadJson('interface-details.json') as { entries: Record<string, unknown> };
    delete (details.entries as Record<string, unknown>).P2;
    win.ProtochainViewer.state.interfaceDetails = details;
    win.ProtochainProjectNav.navigate(win.ProtochainViewer.state, { scope: 'interface', protocolId: 'P2', interfaceId: 'IF_SYS_T1' });
    const t = text(dom);
    expect(t).toContain('specs 不可读');
  });

  test('coveredInvariants 空 → "无覆盖不变量"', async () => {
    const { dom, win } = setupDom();
    await openDetail(dom, win, 'P1', 'IF_SYS_T4');
    const details = loadJson('interface-details.json') as {
      entries: { P1: { IF_SYS_T4: { relation: { coveredInvariants: unknown } } } };
    };
    details.entries.P1.IF_SYS_T4.relation.coveredInvariants = [];
    win.ProtochainViewer.state.interfaceDetails = details;
    win.ProtochainProjectNav.navigate(win.ProtochainViewer.state, { scope: 'interface', protocolId: 'P1', interfaceId: 'IF_SYS_T4' });
    expect(text(dom)).toContain('无覆盖不变量');
  });

  test('crossRefs 空 → "本接口未涉及跨协议引用"', async () => {
    const { dom, win } = setupDom();
    await openDetail(dom, win, 'P1', 'IF_SYS_T4');
    const details = loadJson('interface-details.json') as {
      entries: { P1: { IF_SYS_T4: { crossRefs: unknown } } };
    };
    details.entries.P1.IF_SYS_T4.crossRefs = [];
    win.ProtochainViewer.state.interfaceDetails = details;
    win.ProtochainProjectNav.navigate(win.ProtochainViewer.state, { scope: 'interface', protocolId: 'P1', interfaceId: 'IF_SYS_T4' });
    expect(text(dom)).toContain('本接口未涉及跨协议引用');
  });

  test('diff 新增接口（IF_SYS_T5）→ 快照摘要 + "diff 新增"（不白屏）', async () => {
    const { dom, win } = setupDom();
    await openDetail(dom, win, 'P2', 'IF_SYS_T5');
    const t = text(dom);
    expect(t).toContain('IF_SYS_T5');
    expect(t).toContain('refund_partial');
    expect(t).toContain('payment-v1-v2');
    expect(t).toContain('diff 新增');
  });
});

describe('TD9 ⑥ 静态扫描 + 无控制台错误', () => {
  test('interface-detail-panel.js 无网络/框架', () => {
    const code = readViewerFile('interface-detail-panel.js');
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/XMLHttpRequest/);
    expect(code).not.toMatch(/https?:\/\//);
    expect(code).not.toContain('import React');
  });

  test('五段渲染无 console.error', async () => {
    const errors: unknown[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      const { dom, win } = setupDom();
      await openDetail(dom, win, 'P1', 'IF_SYS_T4');
    } finally {
      console.error = origError;
    }
    expect(errors).toEqual([]);
  });
});
