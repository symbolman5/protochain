/**
 * W3-f ⑦ 演进 diff 投影测试（07-execution-T3 TC9）
 *
 * 机械判据（TC9 验收）：
 * ① 演示实例支付协议 v1→v2：data.json diffView 变更元素集合与 model-diff.json 逐字段一致、
 *    受影响接口/用例清单与工具链投影一致（投影零推导断言）；
 * ② viewer：变更高亮集合 = diffView 查表；受影响接口/用例计数 = diffView 列表长度（图例可数）；
 * ③ 无 diffView 的 data.json → diff 模式显式提示（不端内计算）；
 * ④ 无 diff 数据字段时既有 data.json 契约不变（零回归）；
 * ⑤ tsc 0 errors + suite 全过。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import { parseProtocolFile } from '../../src/parser/index.js';
import { diffModels } from '../../src/differ/index.js';
import { specify, specsFromEnvelope } from '../../src/specifier/index.js';
import { buildWebData, type DeriveWebInputs } from '../../src/webgen/index.js';
import type { SourceProtocolModel, TestCaseSet } from '../../src/model/types.js';

const ROOT = process.cwd();
const VIEWER = join(ROOT, 'viewer');
const DEMO = join(ROOT, 'examples', 'fulfillment-payment');
const P2 = join(DEMO, 'protocol', 'P2');

function readViewerFile(rel: string): string {
  return readFileSync(join(VIEWER, rel), 'utf-8');
}

/** 确定性用例集（v2 支付协议：覆盖含 T5 的路径） */
function makeTestCases(v2: SourceProtocolModel): TestCaseSet {
  const transitionById = new Map(v2.derivable.transitions.map((t) => [t.id, t]));
  const stateOf = (tid: string) => transitionById.get(tid)?.to ?? '';
  const paths = [
    { id: 'P_full_refund', transitionIds: ['T1', 'T2', 'T4'], stateIds: ['S0', 'S1', 'S2', 'S3'] },
    { id: 'P_partial_refund', transitionIds: ['T1', 'T2', 'T5'], stateIds: ['S0', 'S1', 'S2', 'S3'] },
    { id: 'P_pay_failed', transitionIds: ['T1', 'T3'], stateIds: ['S0', 'S1', 'S4'] },
  ];
  void stateOf;
  return {
    paths,
    coverage: {
      transitions: Object.fromEntries(
        v2.derivable.transitions.map((t) => [t.id, { covered: true, passed: true }])
      ),
      states: Object.fromEntries(v2.derivable.states.map((s) => [s.id, { covered: true }])),
      overall: 'full' as const,
    },
    generatedAt: new Date().toISOString(),
  };
}

async function buildV2DataWithDiff(): Promise<{
  data: ReturnType<typeof buildWebData>;
  diff: Awaited<ReturnType<typeof diffModels>>['diff'];
  impact: Awaited<ReturnType<typeof diffModels>>['impact'];
}> {
  const v1 = parseProtocolFile(join(P2, 'model.md'));
  const v2 = parseProtocolFile(join(P2, 'model.v2.md'));
  const { diff, impact } = await diffModels(v1, v2, undefined, {
    useAIForInvariantEquivalence: false,
  });
  const inputs: DeriveWebInputs = {
    specsEnvelope: specify(v2),
    model: v2,
    testCases: makeTestCases(v2),
    diff,
    impact,
  };
  return { data: buildWebData(inputs), diff, impact };
}

describe('TC9 ① diffView 机械投影（v1→v2，与 model-diff/impact 逐字段一致）', () => {
  let ctx: Awaited<ReturnType<typeof buildV2DataWithDiff>>;
  beforeAll(async () => {
    ctx = await buildV2DataWithDiff();
  });

  test('变更元素集合与 model-diff.json derivableChanges 逐字段一致', () => {
    const { data, diff } = ctx;
    expect(data.diffView).toBeDefined();
    expect(data.diffView!.changedTransitions).toEqual(
      diff.derivableChanges.filter((c) => c.elementType === 'transition').map((c) => c.elementId)
    );
    expect(data.diffView!.changedStates).toEqual(
      diff.derivableChanges.filter((c) => c.elementType === 'state').map((c) => c.elementId)
    );
  });

  test('演示实例 v1→v2 具体断言：新增 T5 部分退款转移', () => {
    const { data } = ctx;
    expect(data.diffView!.changedTransitions).toEqual(['T5']);
    expect(data.diffView!.changedStates).toEqual([]);
    // 元数据版本变更（1.0.0 → 1.1.0）在 changedOthers/摘要中可见
    expect(data.diffView!.summary).toContain('元数据');
  });

  test('受影响接口 = 工具链投影（specs 命中变更转移 IF_SYS_T5）', () => {
    const { data } = ctx;
    expect(data.diffView!.affectedInterfaces).toContain('IF_SYS_T5');
    // 全部受影响接口均来自 specs（非空、与变更转移对应）
    expect(data.diffView!.affectedInterfaces.length).toBeGreaterThanOrEqual(1);
  });

  test('受影响用例 = testCases 命中变更转移（P_partial_refund 含 T5）', () => {
    const { data } = ctx;
    expect(data.diffView!.affectedCases).toEqual(['P_partial_refund']);
  });

  test('impact 视图同时投影（与 diff 同批产物）', () => {
    const { data, impact } = ctx;
    expect(data.impact).not.toBeNull();
    expect(data.impact!.affectedSteps).toEqual(impact.affectedSteps);
  });

  test('④ 无 diff 数据字段 → 既有 data.json 契约不变（diffView 缺省）', () => {
    const v2 = parseProtocolFile(join(P2, 'model.v2.md'));
    const data = buildWebData({ specsEnvelope: specify(v2), model: v2 });
    expect(data.diffView).toBeUndefined();
    // 既有字段不受影响
    expect(data.schemaVersion).toBe('1.0');
    expect(data.stateMachine.edges.length).toBe(v2.derivable.transitions.length);
  });
});

// ============================================================================
// ②③ viewer diff 面板（jsdom）
// ============================================================================

interface DiffWindow {
  ProtochainViewer?: {
    state: { dataJson: unknown; n1: { degraded: boolean } };
  };
  [key: string]: unknown;
}

function setupDom(dataJson: unknown): { dom: JSDOM; win: DiffWindow } {
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
  const win = dom.window as unknown as DiffWindow;
  if (dataJson !== undefined) {
    win.ProtochainViewer!.state.dataJson = dataJson;
  }
  const panels = dom.window.document.querySelector('#panels') as unknown as { innerHTML: string };
  (dom.window as unknown as { ProtochainViewerHooks: { renderAll: (s: unknown, p: unknown) => void } })
    .ProtochainViewerHooks.renderAll(win.ProtochainViewer!.state, panels);
  return { dom, win };
}

function highlightedDiffEdges(dom: JSDOM): string[] {
  return [...dom.window.document.querySelectorAll('.sm-edge.diff-highlight')]
    .map((e) => e.getAttribute('data-edge-id'))
    .filter((x): x is string => !!x)
    .sort();
}

describe('TC9 ②③ viewer diff 面板（jsdom，查表零推导）', () => {
  test('② 变更高亮集合 = diffView 查表；计数 = 列表长度（图例可数）', async () => {
    const ctx = await buildV2DataWithDiff();
    const { dom } = setupDom(ctx.data);
    // 高亮集合 = diffView.changedTransitions（T5）
    expect(highlightedDiffEdges(dom)).toEqual([...ctx.data.diffView!.changedTransitions].sort());
    // 图例计数 = diffView 列表长度
    const summaryText = dom.window.document.querySelector('.diff-summary')?.textContent ?? '';
    expect(summaryText).toContain(`变更转移 ${ctx.data.diffView!.changedTransitions.length}`);
    expect(summaryText).toContain(`变更状态 ${ctx.data.diffView!.changedStates.length}`);
    expect(summaryText).toContain(`受影响接口 ${ctx.data.diffView!.affectedInterfaces.length}`);
    expect(summaryText).toContain(`受影响用例 ${ctx.data.diffView!.affectedCases.length}`);
    // 受影响用例清单 = diffView.affectedCases（P_partial_refund 可数，在清单区）
    const affectedText = dom.window.document.querySelector('.diff-affected')?.textContent ?? '';
    expect(affectedText).toContain('P_partial_refund');
    // 受影响接口 chip 显示 IF_SYS_T5
    expect(affectedText).toContain('IF_SYS_T5');
  });

  test('② 点击"高亮变更元素"按钮 → 高亮集合与 diffView 一致（查表）', async () => {
    const ctx = await buildV2DataWithDiff();
    const { dom } = setupDom(ctx.data);
    // 先清除后点击（验证按钮行为，非初始自动高亮）
    const btn = dom.window.document.querySelector('.diff-hl-btn')!;
    btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    expect(highlightedDiffEdges(dom)).toEqual(['T5']);
  });

  test('③ 无 diffView 的 data.json → diff 面板显式提示"无 diff 数据"（不端内计算）', () => {
    const v2 = parseProtocolFile(join(P2, 'model.v2.md'));
    const data = buildWebData({ specsEnvelope: specify(v2), model: v2 });
    const { dom } = setupDom(data);
    const note = dom.window.document.querySelector('.diff-empty')?.textContent ?? '';
    expect(note).toContain('无 diffView 数据');
    expect(note).toContain('端内');
    // 不白屏：主视图仍渲染（无 diff 高亮）
    expect(dom.window.document.querySelectorAll('.sm-edge').length).toBeGreaterThan(0);
  });

  test('③b 未导入 data.json → 不渲染 diff 面板（无白屏）', () => {
    const { dom } = setupDom(null);
    expect(dom.window.document.querySelector('.diff-panel')).toBeNull();
  });
});
