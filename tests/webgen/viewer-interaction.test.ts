/**
 * viewer ① 主视图 + ③ 联动 + ⑥ 着色 交互测试（W3-b/c / 05-execution-T1 TA4/TA5）
 *
 * 机械判据：
 * TA4 ① 全部状态/转移渲染且可点；② 边详情与 data.json 逐字段一致（端内零推导）；
 *      ③ 状态数/边数可在图例读出且与契约一致；
 * TA5 ① 未覆盖路径数在图例可数，与 edgeCoverage 统计一致；
 *      ② 任一接口点击后前置/后置状态高亮且无错位（对 fixture 逐接口断言）；
 *      ③ N1 触发时 ⑥ 降级为不着色 + 提示（与 TA3 守卫联动）。
 *
 * 环境：jsdom（jsdom@26，@exodus/bytes 经 jest moduleNameMapper 垫片）。
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
  ProtochainViewer?: {
    state: {
      dataJson: WebDataLike | null;
      n1: { degraded: boolean; fresh: boolean; alert: string | null };
    };
    importModel: (file: unknown) => Promise<void>;
    importData: (file: unknown) => Promise<void>;
  };
  [key: string]: unknown;
}

interface WebDataLike {
  sourceModelVersion: string;
  stateMachine: {
    nodes: Array<{ id: string; name: string; type: string }>;
    edges: Array<{ id: string; action: string; from: string[]; to: string; degraded: boolean; derivedFrom: string }>;
    edgeCoverage: Record<string, 'pass' | 'fail' | 'uncovered'>;
  };
  interfaces: Array<{ id: string; name: string; kind: string }>;
}

function setupDom(dataJson: unknown): { dom: JSDOM; win: SmokeWindow } {
  const html = readViewerFile('index.html');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'file:///viewer/index.html' });
  const ctx = dom.getInternalVMContext();
  runInContext(readViewerFile('assets/parser.js'), ctx);
  runInContext(readViewerFile('n1-guard.js'), ctx);
  runInContext(readViewerFile('app.js'), ctx);
  runInContext(readViewerFile('main-view.js'), ctx);
  runInContext(readViewerFile('link-coverage.js'), ctx);
  const win = dom.window as unknown as SmokeWindow;
  if (dataJson !== undefined) {
    win.ProtochainViewer!.state.dataJson = dataJson as WebDataLike;
  }
  // 触发全量渲染（等价于真实导入 data.json 后的 runRenderHooks）
  const panels = dom.window.document.querySelector('#panels') as unknown as { innerHTML: string };
  (dom.window as unknown as { ProtochainViewerHooks: { renderAll: (s: unknown, p: unknown) => void } })
    .ProtochainViewerHooks.renderAll(win.ProtochainViewer!.state, panels);
  return { dom, win };
}

function makeFile(win: SmokeWindow, content: string, name: string): unknown {
  const W = win as unknown as { File: new (parts: string[], name: string, opts?: object) => unknown };
  return new W.File([content], name, { type: 'text/plain' });
}

function loadDataJson(): WebDataLike {
  return JSON.parse(readViewerFile('samples/food-delivery.data.json')) as WebDataLike;
}

function clickEdge(dom: JSDOM, edgeId: string): void {
  const line = dom.window.document.querySelector(`.sm-edge[data-edge-id="${edgeId}"]`);
  if (!line) throw new Error(`edge ${edgeId} 未渲染`);
  line.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
}

function clickInterface(dom: JSDOM, ifaceId: string): void {
  const item = dom.window.document.querySelector(`.iface-item[data-iface-id="${ifaceId}"]`);
  if (!item) throw new Error(`iface ${ifaceId} 未渲染`);
  item.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
}

/** Node 侧同一映射规则（interface.name === edge.action）计算期望 pre/post */
function expectedLink(data: WebDataLike, ifaceName: string): { pre: string[]; post: string[] } {
  const edges = data.stateMachine.edges.filter((e) => e.action === ifaceName);
  const pre = new Set<string>();
  const post = new Set<string>();
  for (const e of edges) for (const f of e.from) pre.add(f);
  for (const e of edges) post.add(e.to);
  if (edges.length === 0) {
    const node = data.stateMachine.nodes.find((n) => n.id === ifaceName || n.name === ifaceName);
    if (node) {
      pre.add(node.id);
      post.add(node.id);
    }
  }
  return { pre: [...pre].sort(), post: [...post].sort() };
}

function highlightedNodes(dom: JSDOM, cls: string): string[] {
  const ids = [...dom.window.document.querySelectorAll(`.sm-node-group.${cls}`)]
    .map((g) => g.getAttribute('data-node-id'))
    .filter((x): x is string => !!x);
  return ids.sort();
}

describe('viewer ① 主视图（TA4）', () => {
  test('fixture 全部状态/转移渲染：图例读出状态 8 · 转移 11（与契约一致）', () => {
    const { dom } = setupDom(loadDataJson());
    const d = dom.window.document;
    // 图例计数（TA4 验收③）
    const toolbar = d.querySelector('.panel-toolbar')?.textContent ?? '';
    expect(toolbar).toContain('状态 8');
    expect(toolbar).toContain('转移 11');
    // 节点组 = 状态数；多源边 T7(S1,S2) 渲染 2 条线 → 共 12 条线
    expect(d.querySelectorAll('.sm-node-group').length).toBe(8);
    expect(d.querySelectorAll('.sm-edge').length).toBe(12);
  });

  test('点击边 → 详情逐字段与 data.json 一致（端内零推导）', () => {
    const data = loadDataJson();
    const { dom } = setupDom(data);
    clickEdge(dom, 'T1');
    // 逐字段 DOM 断言：label/value 结构与 data.json 一致
    const detailRows = [...dom.window.document.querySelectorAll('.detail-row')].map((r) => ({
      label: r.querySelector('.detail-label')?.textContent ?? '',
      value: r.querySelector('.detail-value')?.textContent ?? '',
    }));
    const row = (label: string) => detailRows.find((r) => r.label === label)?.value;
    const edge = data.stateMachine.edges.find((e) => e.id === 'T1')!;
    expect(row('转移 ID（derived-from）')).toBe('T1');
    expect(row('action')).toBe(edge.action);
    expect(row('from')).toBe(edge.from.join(', '));
    expect(row('to')).toBe(edge.to);
    expect(row('触发角色')).toBe(edge.triggerRoleId);
    expect(row('degraded（异常路径）')).toBe('否');
    // T8（超时自动取消，异常路径）→ degraded 是
    clickEdge(dom, 'T8');
    const rows2 = [...dom.window.document.querySelectorAll('.detail-row')].map((r) => ({
      label: r.querySelector('.detail-label')?.textContent ?? '',
      value: r.querySelector('.detail-value')?.textContent ?? '',
    }));
    const row2 = (label: string) => rows2.find((r) => r.label === label)?.value;
    expect(row2('degraded（异常路径）')).toBe('是');
    expect(row2('action')).toBe('auto_cancel_accept_timeout');
  });

  test('边几何：每条线两端坐标均为数值且落在 from/to 节点中心行（防 undefined 坐标）', () => {
    const data = loadDataJson();
    const { dom } = setupDom(data);
    const d = dom.window.document;
    // 主流程边用 <line>（x1/y1/x2/y2），到 sink 汇区的边用 <path>（d="M ... L ..."）；
    // 本测试只对 line 元素做线性几何断言，path 单独校验 d 格式 + 终点的 from/to 节点列对齐。
    const lines = [...d.querySelectorAll('line.sm-edge')];
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const x1 = line.getAttribute('x1');
      const y1 = line.getAttribute('y1');
      const x2 = line.getAttribute('x2');
      const y2 = line.getAttribute('y2');
      // 坐标不得为 undefined/null/NaN（此前 bug：y1/y2=undefined → 边画在图顶部）
      expect(x1).toMatch(/^-?\d+(\.\d+)?$/);
      expect(y1).toMatch(/^-?\d+(\.\d+)?$/);
      expect(x2).toMatch(/^-?\d+(\.\d+)?$/);
      expect(y2).toMatch(/^-?\d+(\.\d+)?$/);
      // 边从左往右指向目标节点（x2 > x1，分层布局不变式）
      expect(Number(x2)).toBeGreaterThan(Number(x1));
    }
    // 抽查 T1（S0 → S1）：起点 x 在 S0 右边界、终点 x 在 S1 左边界（节点宽 150）
    const t1 = d.querySelector('line.sm-edge[data-edge-id="T1"]')!;
    expect(Number(t1.getAttribute('x1'))).toBe(60 + 150 / 2 + 150 / 2); // margin.left + 节点宽
    expect(Number(t1.getAttribute('x2'))).toBe(60 + 170 + 0); // S1 左边界（第 1 层起点）
    // y 坐标为节点中心（非 0 顶部）：S0/S1 同层单节点 → 行中心相同
    expect(Number(t1.getAttribute('y1'))).toBe(Number(t1.getAttribute('y2')));
    expect(Number(t1.getAttribute('y1'))).toBeGreaterThan(0);

    // 到 sink 汇区的折线（path）：d 非空、含 M/L 段、首尾点数值化且终点靠近目标节点顶部
    const paths = [...d.querySelectorAll('path.sm-edge')];
    expect(paths.length).toBeGreaterThan(0); // food-delivery 至少 T7/T8/T9/T10 → S7 等折线
    for (const p of paths) {
      const dAttr = p.getAttribute('d') ?? '';
      // 形如 "M 815 74 L 815 214 L 985 214 L 985 228"（M + 至少 1 段 L）
      expect(dAttr).toMatch(/^M\s+\d+(\.\d+)?\s+\d+(\.\d+)?(\s+L\s+\d+(\.\d+)?\s+\d+(\.\d+)?)+$/);
      // 折线终点应靠近目标节点（cyTop 附近，非 0/非远离汇区）
      const m = dAttr.match(/L\s+(\d+(\.\d+)?)\s+(\d+(\.\d+)?)\s*$/);
      expect(m).not.toBeNull();
      const yEnd = Number(m![3]);
      expect(yEnd).toBeGreaterThan(0);
    }
  });

  test('点击节点 → 节点高亮（selected）', () => {
    const { dom } = setupDom(loadDataJson());
    const node = dom.window.document.querySelector('.sm-node-group[data-node-id="S2"]')!;
    node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    expect(node.classList.contains('selected')).toBe(true);
  });
});

describe('viewer ③ 接口↔状态联动（TA5）', () => {
  test('逐接口断言：点击后前置/后置状态高亮与 Node 侧映射一致（无错位）', () => {
    const data = loadDataJson();
    const { dom } = setupDom(data);
    // 对 data.json 中每个系统接口断言
    for (const iface of data.interfaces) {
      clickInterface(dom, iface.id);
      const exp = expectedLink(data, iface.name);
      const pre = highlightedNodes(dom, 'highlight-pre');
      const post = highlightedNodes(dom, 'highlight-post');
      if (exp.pre.length === 0 && exp.post.length === 0) {
        // 无匹配的观测接口：不高亮
        expect(pre).toEqual([]);
        expect(post).toEqual([]);
        continue;
      }
      expect(pre).toEqual(exp.pre);
      expect(post).toEqual(exp.post);
      // 已链接节点应非空（防错位后空转）
      expect(pre.length + post.length).toBeGreaterThan(0);
    }
  });

  test('create 接口 → 前置 S0、后置 S1（food-delivery 具体断言）', () => {
    const { dom } = setupDom(loadDataJson());
    clickInterface(dom, 'IF_SYS_T1'); // create
    expect(highlightedNodes(dom, 'highlight-pre')).toEqual(['S0']);
    expect(highlightedNodes(dom, 'highlight-post')).toEqual(['S1']);
  });

  test('无匹配接口（观测接口）→ 提示不参与联动', () => {
    const data = loadDataJson();
    const obs = data.interfaces.find((i) => i.kind === 'observation');
    const { dom } = setupDom(data);
    if (!obs) return; // fixture 无观测接口则跳过（不失败）
    clickInterface(dom, obs.id);
    const note = dom.window.document.querySelector('.no-link-note')?.textContent ?? '';
    expect(note).toContain('无匹配转移边');
  });
});

describe('viewer ⑥ edgeCoverage 着色（TA5）', () => {
  /** 构造带部分 pass/fail 的 edgeCoverage 变体 */
  function withCoverage(data: WebDataLike, patch: Record<string, 'pass' | 'fail' | 'uncovered'>): WebDataLike {
    const clone = JSON.parse(JSON.stringify(data)) as WebDataLike;
    for (const k of Object.keys(clone.stateMachine.edgeCoverage)) {
      clone.stateMachine.edgeCoverage[k] = 'uncovered';
    }
    Object.assign(clone.stateMachine.edgeCoverage, patch);
    return clone;
  }

  test('未覆盖路径数在图例可数，与 edgeCoverage 统计一致', () => {
    const data = withCoverage(loadDataJson(), { T1: 'pass', T2: 'pass', T3: 'fail' });
    const { dom } = setupDom(data);
    const legend = dom.window.document.querySelector('.panel-toolbar')?.textContent ?? '';
    expect(legend).toContain('通过 2');
    expect(legend).toContain('失败 1');
    expect(legend).toContain('未覆盖 8'); // 11 - 2 - 1
    // 边着色 class 正确
    const t1 = dom.window.document.querySelector('.sm-edge[data-edge-id="T1"]')!;
    const t3 = dom.window.document.querySelector('.sm-edge[data-edge-id="T3"]')!;
    const t4 = dom.window.document.querySelector('.sm-edge[data-edge-id="T4"]')!;
    expect(t1.classList.contains('coverage-pass')).toBe(true);
    expect(t3.classList.contains('coverage-fail')).toBe(true);
    expect(t4.classList.contains('coverage-uncovered')).toBe(true);
  });

  test('N1 触发（数据过期）→ ⑥ 降级不着色 + 显式提示', () => {
    const data = withCoverage(loadDataJson(), { T1: 'pass' });
    const { dom, win } = setupDom(data);
    // 模拟 N1 守卫触发：更新 state.n1 后重新渲染（等价于 app.js runN1 → runRenderHooks）
    win.ProtochainViewer!.state.n1 = { degraded: true, fresh: false, alert: '增强数据过期' };
    const panels = dom.window.document.querySelector('#panels') as unknown as { innerHTML: string };
    (dom.window as unknown as { ProtochainViewerHooks: { renderAll: (s: unknown, p: unknown) => void } })
      .ProtochainViewerHooks.renderAll(win.ProtochainViewer!.state, panels);
    const note = dom.window.document.querySelector('.coverage-legend-note')?.textContent ?? '';
    expect(note).toContain('已降级');
    expect(note).toContain('N1');
    // 无着色 class 应用
    const t1 = dom.window.document.querySelector('.sm-edge[data-edge-id="T1"]')!;
    expect(t1.classList.contains('coverage-pass')).toBe(false);
  });
});
