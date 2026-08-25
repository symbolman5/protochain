/**
 * W3-f viewer 组合层面板测试（07-execution-T3 TC8）
 *
 * 机械判据（TC8 验收）：
 * ① jsdom 对演示实例组合层 data.json：协议节点数/依赖边数/引用边数与 data.json 逐字段一致（图例可数）；
 * ② 点击退款 guard 引用条目 → 恰好高亮履约+支付两端协议 + 显示 target（查表一致，逐条目断言）；
 * ③ 误导入单协议 data.json / 未导入 → 组合层面板显式提示（不白屏）；
 * ④ 静态扫描：无 fetch/XHR/远程资源、无框架引入（本地相对路径脚本）；
 * ⑤ 双击 file:// 打开无控制台错误（jsdom 无 console.error + 静态扫描兜底）。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import { parseCompositionFile } from '../../src/composition-parser/index.js';
import { parseProtocolFile } from '../../src/parser/index.js';
import { specify, specsFromEnvelope } from '../../src/specifier/index.js';
import { buildCompositionWebData } from '../../src/webgen/composition.js';

const ROOT = process.cwd();
const VIEWER = join(ROOT, 'viewer');
const DEMO = join(ROOT, 'examples', 'fulfillment-payment');

function readViewerFile(rel: string): string {
  return readFileSync(join(VIEWER, rel), 'utf-8');
}

/** 重建演示实例组合层 data.json（与 derive-web 同源，不依赖提交产物） */
function loadCompositionData(): ReturnType<typeof buildCompositionWebData> {
  const composition = parseCompositionFile(join(DEMO, 'protocol', 'composition.md'));
  const subSpecs = new Map<string, ReturnType<typeof specsFromEnvelope>>();
  for (const sub of composition.subProtocols) {
    const model = parseProtocolFile(join(DEMO, 'protocol', sub.protocolId, 'model.md'));
    subSpecs.set(sub.protocolId, specsFromEnvelope(specify(model)));
  }
  return buildCompositionWebData(composition, subSpecs, new Map());
}

interface T3Window {
  ProtochainViewer?: {
    state: { dataJson: unknown; n1: { degraded: boolean } };
  };
  [key: string]: unknown;
}

function setupDom(dataJson: unknown): { dom: JSDOM; win: T3Window } {
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
  const win = dom.window as unknown as T3Window;
  if (dataJson !== undefined) {
    win.ProtochainViewer!.state.dataJson = dataJson;
  }
  const panels = dom.window.document.querySelector('#panels') as unknown as { innerHTML: string };
  (dom.window as unknown as { ProtochainViewerHooks: { renderAll: (s: unknown, p: unknown) => void } })
    .ProtochainViewerHooks.renderAll(win.ProtochainViewer!.state, panels);
  return { dom, win };
}

function click(dom: JSDOM, el: Element): void {
  el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
}

describe('TC8 ① 组合层面板图例可数（jsdom，与 data.json 逐字段一致）', () => {
  const data = loadCompositionData();
  const { dom } = setupDom(data);

  test('组合层面板渲染 + 标题计数与 data.json 一致', () => {
    const title = dom.window.document.querySelector('.composition-panel .panel-subtitle')?.textContent ?? '';
    expect(title).toContain('schemaVersion 1.1');
    expect(title).toContain(`协议 ${data.protocols.length}`);
    expect(title).toContain(`依赖边 ${data.dependencyGraph.edges.length}`);
    expect(title).toContain(`引用边 ${data.crossRefs.length}`);
  });

  test('协议节点数/ID 与 data.json.protocols 逐字段一致', () => {
    const chips = [...dom.window.document.querySelectorAll('.proto-node')];
    expect(chips.length).toBe(data.protocols.length);
    const ids = chips.map((c) => c.getAttribute('data-protocol-id'));
    expect(ids).toEqual(data.protocols.map((p) => p.id));
    expect(ids).toContain('P1');
    expect(ids).toContain('P2');
  });

  test('依赖边行与 dependencyGraph.edges 逐条一致', () => {
    const rows = [...dom.window.document.querySelectorAll('.dep-row')];
    expect(rows.length).toBe(data.dependencyGraph.edges.length);
    for (let i = 0; i < data.dependencyGraph.edges.length; i++) {
      const e = data.dependencyGraph.edges[i];
      const text = rows[i].textContent ?? '';
      expect(text).toContain(e.from);
      expect(text).toContain(e.to);
      expect(text).toContain(e.dependencyType);
    }
  });

  test('引用边行与 crossRefs 逐条一致（kind/target 查表）', () => {
    const rows = [...dom.window.document.querySelectorAll('.ref-row')];
    expect(rows.length).toBe(data.crossRefs.length);
    for (const c of data.crossRefs) {
      const match = rows.filter((r) =>
        (r.getAttribute('data-ref') ?? '') === `${c.fromProtocol}->${c.toProtocol}`
      );
      expect(match.length).toBeGreaterThan(0);
    }
    // 退款 guard 引用条目存在（target=S_refunded 显示）
    const refundRow = rows.find((r) => (r.textContent ?? '').includes('S_refunded'));
    expect(refundRow).toBeDefined();
    expect(refundRow!.textContent).toContain('P2');
  });

  test('invariantSpans 列表覆盖 CI1/CI2', () => {
    const spans = [...dom.window.document.querySelectorAll('.inv-span-row')];
    const text = spans.map((s) => s.textContent ?? '').join('|');
    expect(text).toContain('CI1');
    expect(text).toContain('CI2');
    expect(text).toContain('P1, P2');
  });
});

describe('TC8 ② 点击引用条目 → 恰好高亮两端协议 + 显示 target（查表）', () => {
  const data = loadCompositionData();
  const { dom } = setupDom(data);

  test('点击退款 guard 引用条目 → 高亮 P1 + P2 两端（无其他协议）', () => {
    const rows = [...dom.window.document.querySelectorAll('.ref-row')];
    // 找到退款 guard 条目（from P1 → to P2，target S_refunded）
    const refundRow = rows.find((r) => (r.textContent ?? '').includes('S_refunded'))!;
    click(dom, refundRow);
    const highlighted = [...dom.window.document.querySelectorAll('.proto-node.hl')]
      .map((c) => c.getAttribute('data-protocol-id'))
      .sort();
    // 恰好两端协议（履约 P1 + 支付 P2）
    expect(highlighted).toEqual(['P1', 'P2']);
    // 条目自身进入高亮态
    expect(refundRow.classList.contains('hl')).toBe(true);
  });

  test('逐条目断言：每条引用点击后高亮集合 = 该条 fromProtocol/toProtocol 两端', () => {
    const rows = [...dom.window.document.querySelectorAll('.ref-row')];
    for (const c of data.crossRefs) {
      const row = rows.find((r) =>
        (r.getAttribute('data-ref') ?? '') === `${c.fromProtocol}->${c.toProtocol}`
      )!;
      click(dom, row);
      const highlighted = [...dom.window.document.querySelectorAll('.proto-node.hl')]
        .map((x) => x.getAttribute('data-protocol-id'))
        .sort();
      expect(highlighted).toEqual([c.fromProtocol, c.toProtocol].sort());
    }
  });
});

describe('TC8 ③ 误导入 / 未导入 → 显式提示（不白屏）', () => {
  test('误导入单协议 data.json（schemaVersion=1.0）→ 组合层面板显式提示需组合层数据', () => {
    const single = {
      schemaVersion: '1.0',
      generatedAt: '',
      sourceModelVersion: '1.0.0',
      stateMachine: { nodes: [{ id: 'S1', name: 'x', type: 'normal' }], edges: [] },
    };
    const { dom } = setupDom(single);
    const note = dom.window.document.querySelector('.composition-empty')?.textContent ?? '';
    expect(note).toContain('单协议');
    expect(note).toContain('组合层');
    // 不白屏：主视图照常渲染
    expect(dom.window.document.querySelectorAll('.sm-svg').length).toBe(1);
  });

  test('未导入 → 组合层面板不渲染（主视图有提示，不重复）', () => {
    const { dom } = setupDom(null);
    expect(dom.window.document.querySelector('.composition-panel')).toBeNull();
    expect(dom.window.document.querySelector('.panel-empty')?.textContent ?? '').toContain('请先导入');
  });
});

describe('TC8 ④ 静态扫描：无 fetch/XHR/远程资源、无框架引入（本地相对路径脚本）', () => {
  test('index.html 脚本全部本地相对路径，无 CDN/远程', () => {
    const html = readViewerFile('index.html');
    const scriptSrcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
    expect(scriptSrcs.length).toBeGreaterThan(0);
    for (const src of scriptSrcs) {
      expect(src.startsWith('http://') || src.startsWith('https://') || src.startsWith('//')).toBe(false);
    }
    expect(html).not.toMatch(/https?:\/\/[^"'\s]+\.(js|css)/);
  });

  test('组合层面板与 diff 面板源码无 fetch/XHR/远程资源/框架', () => {
    for (const f of ['composition-panel.js', 'diff-panel.js']) {
      const code = readViewerFile(f);
      expect(code).not.toMatch(/\bfetch\s*\(/);
      expect(code).not.toMatch(/XMLHttpRequest/);
      expect(code).not.toMatch(/https?:\/\//);
      expect(code).not.toContain('import React');
      expect(code).not.toContain('Vue');
      expect(code).not.toContain('angular');
    }
  });

  test('组合层 data.json 渲染期间无 console.error（jsdom）', () => {
    const data = loadCompositionData();
    const errors: unknown[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      setupDom(data);
    } finally {
      console.error = origError;
    }
    expect(errors).toEqual([]);
  });
});
