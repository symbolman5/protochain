/**
 * viewer T2 面板交互测试（06-execution-T2 TB3 泳道 / TB4 回放 / TB5 关系面板）
 *
 * 机械判据：
 * TB3 ① 逐状态落道正确（所在泳道 = roleIds 首元素对应道，与 data.json 逐字段一致）；
 *     ② 逐不变量：点击后高亮状态集合 = invariantScope.scopeStateIds、
 *        高亮泳道集合 = carrierRoleIds，无错位；
 *     ③ N1 反向（过期 data.json）→ invariantScope 联动不渲染 + 降级提示；
 *     ④ 未导入 data.json → 泳道视图显式提示"需增强数据"。
 * TB4 ① 逐用例：回放步序与 stateIds/transitionIds 逐字段一致、步数 = transitionIds.length + 1；
 *     ② 每步 action/from/to 与 edges 查表一致（端内零推导）；
 *     ③ 未导入/过期 data.json → 回放不可用 + 显式提示。
 * TB5 ① 四 kind + degraded 计数 = data.json relations 统计（图例可数）；
 *     ② 点击 sequence 条目 → 恰好高亮 2 条边（= derived-from 转移对），逐条目断言；
 *     ③ 点击 causes_state_change / invariant_scope / timing → 高亮集合与查表一致；
 *     ④ N1 反向 → 面板降级提示。
 *
 * 环境：jsdom（与 viewer-interaction.test.ts 同构）。
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

interface T2DataLike {
  sourceModelVersion: string;
  protocol: { roles: Array<{ id: string; name: string }> };
  stateMachine: {
    nodes: Array<{ id: string; name: string; type: string; roleIds?: string[] }>;
    edges: Array<{
      id: string;
      action: string;
      from: string[];
      to: string;
      timing?: Array<{ id: string; type: string; boundMs?: number }>;
    }>;
    edgeCoverage: Record<string, 'pass' | 'fail' | 'uncovered'>;
    invariantScope: Record<string, { name: string; scopeStateIds: string[]; carrierRoleIds: string[] }>;
  };
  testCases: Array<{
    id: string;
    stateIds: string[];
    transitionIds: string[];
    verificationPassed?: boolean;
    verificationSkipped?: boolean;
  }>;
  relations: {
    sourceModelVersion: string;
    entries: Array<{
      kind: 'sequence' | 'causes_state_change' | 'invariant_scope' | 'timing';
      fromId: string;
      toId: string;
      derivedFrom: string[];
      scopeStateIds?: string[];
      boundMs?: number;
      degraded?: boolean;
      degradedReason?: string;
    }>;
  };
}

interface T2Window {
  ProtochainViewer?: {
    state: { dataJson: T2DataLike | null; n1: { degraded: boolean; fresh: boolean; alert: string | null } };
  };
  [key: string]: unknown;
}

function setupDom(dataJson: unknown): { dom: JSDOM; win: T2Window } {
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
  const win = dom.window as unknown as T2Window;
  if (dataJson !== undefined) {
    win.ProtochainViewer!.state.dataJson = dataJson as T2DataLike;
  }
  const panels = dom.window.document.querySelector('#panels') as unknown as { innerHTML: string };
  (dom.window as unknown as { ProtochainViewerHooks: { renderAll: (s: unknown, p: unknown) => void } })
    .ProtochainViewerHooks.renderAll(win.ProtochainViewer!.state, panels);
  return { dom, win };
}

function loadT2Data(): T2DataLike {
  return JSON.parse(readViewerFile('samples/food-delivery.t2.data.json')) as T2DataLike;
}

function click(dom: JSDOM, el: Element): void {
  el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
}

function laneNodesIn(dom: JSDOM, roleId: string): string[] {
  const row = dom.window.document.querySelector(`.lane-row[data-role-id="${roleId}"]`);
  if (!row) return [];
  return [...row.querySelectorAll('.lane-node')]
    .map((n) => n.getAttribute('data-node-id'))
    .filter((x): x is string => !!x);
}

function highlightedLaneNodes(dom: JSDOM): string[] {
  return [...dom.window.document.querySelectorAll('.lane-node.scope-highlight')]
    .map((n) => n.getAttribute('data-node-id'))
    .filter((x): x is string => !!x)
    .sort();
}

function highlightedLanes(dom: JSDOM): string[] {
  return [...dom.window.document.querySelectorAll('.lane-row.scope-highlight')]
    .map((r) => r.getAttribute('data-role-id'))
    .filter((x): x is string => !!x)
    .sort();
}

function highlightedRelEdges(dom: JSDOM): string[] {
  // 多源转移（如 T7 from=[S1,S2]）在主视图渲染多条线，高亮集合按转移去重
  const set = new Set(
    [...dom.window.document.querySelectorAll('.sm-edge.rel-highlight')]
      .map((e) => e.getAttribute('data-edge-id'))
      .filter((x): x is string => !!x)
  );
  return [...set].sort();
}

function highlightedRelNodes(dom: JSDOM): string[] {
  return [...dom.window.document.querySelectorAll('.sm-node-group.rel-highlight')]
    .map((g) => g.getAttribute('data-node-id'))
    .filter((x): x is string => !!x)
    .sort();
}

// ---------------------------------------------------------------------------
// TB3 角色泳道
// ---------------------------------------------------------------------------

describe('TB3 ② 角色泳道面板（W3-e）', () => {
  test('① 逐状态落道正确：所在泳道 = roleIds 首元素对应道（与 data.json 逐字段一致）', () => {
    const data = loadT2Data();
    const { dom } = setupDom(data);
    // 泳道行 = 全部 roles + 公共道
    const roleIds = data.protocol.roles.map((r) => r.id);
    for (const rid of roleIds) {
      expect(dom.window.document.querySelector(`.lane-row[data-role-id="${rid}"]`)).not.toBeNull();
    }
    // 逐状态断言：节点出现在 roleIds[0] 对应泳道
    for (const n of data.stateMachine.nodes) {
      const roleIds0 = Array.isArray(n.roleIds) && n.roleIds.length > 0 ? n.roleIds : [];
      const expectLane = roleIds0.length > 0 ? roleIds0[0] : '__common__';
      const inLane = laneNodesIn(dom, expectLane);
      expect(inLane).toContain(n.id);
      // 且不在其他泳道
      const total = [...dom.window.document.querySelectorAll(`.lane-node[data-node-id="${n.id}"]`)];
      expect(total.length).toBe(1);
    }
    // food-delivery 具体断言：S2（customer, merchant）→ customer 道；S5 → rider 道
    expect(laneNodesIn(dom, 'customer')).toContain('S2');
    expect(laneNodesIn(dom, 'rider')).toContain('S5');
    expect(laneNodesIn(dom, 'merchant')).toContain('S3');
    // 无 roleIds 状态落公共道（approval-flow S3 无角色）
  });

  test('② 逐不变量断言：点击后高亮状态集合 = scopeStateIds、高亮泳道集合 = carrierRoleIds（无错位）', () => {
    const data = loadT2Data();
    const { dom } = setupDom(data);
    const invScope = data.stateMachine.invariantScope;
    for (const invId of Object.keys(invScope)) {
      const entry = invScope[invId];
      const item = dom.window.document.querySelector(`.invariant-item[data-invariant-id="${invId}"]`)!;
      click(dom, item);
      expect(highlightedLaneNodes(dom)).toEqual([...entry.scopeStateIds].sort());
      expect(highlightedLanes(dom)).toEqual([...entry.carrierRoleIds].sort());
    }
    // 具体断言：INV4（骑手运力约束）→ 状态 S5、泳道 rider
    const item4 = dom.window.document.querySelector('.invariant-item[data-invariant-id="INV4"]')!;
    click(dom, item4);
    expect(highlightedLaneNodes(dom)).toEqual(['S5']);
    expect(highlightedLanes(dom)).toEqual(['rider']);
  });

  test('③ N1 反向（过期 data.json）→ invariantScope 联动不渲染 + 降级提示', () => {
    const data = loadT2Data();
    const { dom, win } = setupDom(data);
    win.ProtochainViewer!.state.n1 = { degraded: true, fresh: false, alert: '增强数据过期' };
    const panels = dom.window.document.querySelector('#panels') as unknown as { innerHTML: string };
    (dom.window as unknown as { ProtochainViewerHooks: { renderAll: (s: unknown, p: unknown) => void } })
      .ProtochainViewerHooks.renderAll(win.ProtochainViewer!.state, panels);
    // 联动不渲染：无 .invariant-item
    expect(dom.window.document.querySelectorAll('.invariant-item').length).toBe(0);
    const note = dom.window.document.querySelector('.lane-panel .coverage-legend-note')?.textContent ?? '';
    expect(note).toContain('已降级');
    expect(note).toContain('N1');
  });

  test('④ 未导入 data.json → 泳道视图显式提示"需增强数据"（不白屏）', () => {
    const { dom } = setupDom(null);
    const note = dom.window.document.querySelector('.lane-empty')?.textContent ?? '';
    expect(note).toContain('需增强数据');
  });
});

// ---------------------------------------------------------------------------
// TB4 用例路径回放
// ---------------------------------------------------------------------------

describe('TB4 用例路径回放面板（W3-e）', () => {
  test('① 逐用例：回放步序与 stateIds/transitionIds 逐字段一致、步数 = transitionIds.length + 1', () => {
    const data = loadT2Data();
    const { dom } = setupDom(data);
    for (const tc of data.testCases) {
      const item = dom.window.document.querySelector(`.replay-case-item[data-case-id="${tc.id}"]`)!;
      click(dom, item);
      // 侧栏步数：初始态 + 每转移一步 = stateIds.length = transitionIds.length + 1
      const stepLabel = dom.window.document.querySelector('.replay-step-label')?.textContent ?? '';
      expect(stepLabel).toContain(tc.id);
      expect(tc.stateIds.length).toBe(tc.transitionIds.length + 1);
      // 遍历每一步：第 s 步当前状态 = stateIds[s]；s>0 时转移 = transitionIds[s-1]，
      // action/from/to 与 edges 查表一致（TB4 验收①②，逐用例）
      const side = dom.window.document.querySelector('.replay-side')!;
      const btnNext = dom.window.document.querySelector('.replay-next')!;
      const readRow = (label: string) => {
        const rows = [...side.querySelectorAll('.detail-row')].map((r) => ({
          label: r.querySelector('.detail-label')?.textContent ?? '',
          value: r.querySelector('.detail-value')?.textContent ?? '',
        }));
        return rows.find((r) => r.label === label)?.value;
      };
      const edgeById = new Map(data.stateMachine.edges.map((e) => [e.id, e]));
      // 第 0 步：初始态
      expect(readRow('当前状态')).toBe(tc.stateIds[0]);
      for (let s = 1; s < tc.stateIds.length; s++) {
        click(dom, btnNext); // 步进到第 s 步
        expect(readRow('当前状态')).toBe(tc.stateIds[s]);
        const tid = tc.transitionIds[s - 1];
        expect(readRow('转移')).toBe(tid);
        const edge = edgeById.get(tid)!;
        expect(readRow('action')).toBe(edge.action);
        expect(readRow('from')).toBe(edge.from.join(', '));
        expect(readRow('to')).toBe(edge.to);
      }
    }
  });

  test('② 回放路径在主视图 SVG 上高亮当前节点与当前边（查表，无错位）', () => {
    const data = loadT2Data();
    const { dom } = setupDom(data);
    const tc = data.testCases.find((t) => t.id === 'P1')!;
    click(dom, dom.window.document.querySelector(`.replay-case-item[data-case-id="P1"]`)!);
    // 第 0 步：当前状态 S0
    const nowNode = (ids: string[]) => ids.sort();
    const nodeNow = () =>
      [...dom.window.document.querySelectorAll('.sm-node-group.replay-now')]
        .map((g) => g.getAttribute('data-node-id'))
        .filter((x): x is string => !!x)
        .sort();
    expect(nodeNow()).toEqual(['S0']);
    // 步进 1 → 当前 S1，边 T1 高亮
    click(dom, dom.window.document.querySelector('.replay-next')!);
    expect(nodeNow()).toEqual(['S1']);
    const edgeNow = () =>
      [...dom.window.document.querySelectorAll('.sm-edge.replay-now')]
        .map((e) => e.getAttribute('data-edge-id'))
        .filter((x): x is string => !!x)
        .sort();
    expect(edgeNow()).toEqual(['T1']);
    // 步进到终态 S6 → 最后一条边 T6
    for (let s = 2; s < tc.stateIds.length; s++) {
      click(dom, dom.window.document.querySelector('.replay-next')!);
    }
    expect(nodeNow()).toEqual(['S6']);
    expect(edgeNow()).toEqual(['T6']);
  });

  test('③ 未导入 data.json → 回放不可用 + 显式提示', () => {
    const { dom } = setupDom(null);
    const note = dom.window.document.querySelector('.replay-empty')?.textContent ?? '';
    expect(note).toContain('需增强数据');
  });

  test('③b N1 反向 → 回放不可用 + 显式提示', () => {
    const data = loadT2Data();
    const { dom, win } = setupDom(data);
    win.ProtochainViewer!.state.n1 = { degraded: true, fresh: false, alert: '增强数据过期' };
    const panels = dom.window.document.querySelector('#panels') as unknown as { innerHTML: string };
    (dom.window as unknown as { ProtochainViewerHooks: { renderAll: (s: unknown, p: unknown) => void } })
      .ProtochainViewerHooks.renderAll(win.ProtochainViewer!.state, panels);
    const note = dom.window.document.querySelector('.replay-empty')?.textContent ?? '';
    expect(note).toContain('回放不可用');
  });

  test('④ 用例列表显示验证标记（verificationPassed/skipped 查表）', () => {
    const data = loadT2Data();
    const { dom } = setupDom(data);
    const items = [...dom.window.document.querySelectorAll('.replay-case-item')];
    for (const it of items) {
      const cid = it.getAttribute('data-case-id');
      const tc = data.testCases.find((t) => t.id === cid)!;
      const statusText = it.querySelector('.replay-case-status')?.textContent ?? '';
      if (tc.verificationPassed === true) expect(statusText).toBe('通过');
      else if (tc.verificationPassed === false) expect(statusText).toBe('失败');
      else if (tc.verificationSkipped) expect(statusText).toBe('跳过');
      else expect(statusText).toBe('未验证');
    }
  });
});

// ---------------------------------------------------------------------------
// TB5 关系展示面板
// ---------------------------------------------------------------------------

describe('TB5 关系展示面板（W1-a 消费端）', () => {
  test('① 四 kind + degraded 计数 = data.json relations 统计（图例可数）', () => {
    const data = loadT2Data();
    const { dom } = setupDom(data);
    const counts: Record<string, number> = {};
    let degraded = 0;
    for (const e of data.relations.entries) {
      counts[e.kind] = (counts[e.kind] || 0) + 1;
      if (e.degraded) degraded += 1;
    }
    const filterText = dom.window.document.querySelector('.relations-filter')?.textContent ?? '';
    expect(filterText).toContain(`全部 ${data.relations.entries.length}`);
    expect(filterText).toContain(`顺序前置 ${counts.sequence}`);
    expect(filterText).toContain(`状态变更 ${counts.causes_state_change}`);
    expect(filterText).toContain(`不变量覆盖 ${counts.invariant_scope}`);
    expect(filterText).toContain(`时限 ${counts.timing}`);
    expect(filterText).toContain(`degraded ${degraded}`);
    // 面板头部 sourceModelVersion 与 data.json 同源
    expect(dom.window.document.querySelector('.relations-panel .panel-subtitle')?.textContent).toContain('v1.0.0');
  });

  test('② 点击任一 sequence 条目 → 恰好高亮 2 条边（= derived-from 转移对），逐条目断言', () => {
    const data = loadT2Data();
    const { dom } = setupDom(data);
    const seqEntries = data.relations.entries.filter((e) => e.kind === 'sequence');
    expect(seqEntries.length).toBeGreaterThan(0);
    for (const entry of seqEntries) {
      const item = [...dom.window.document.querySelectorAll('.relations-item[data-kind="sequence"]')]
        .find((x) => (x.textContent ?? '').includes(`${entry.fromId} → ${entry.toId}`));
      if (!item) throw new Error(`sequence 条目 ${entry.fromId} → ${entry.toId} 未渲染`);
      click(dom, item);
      expect(highlightedRelEdges(dom)).toEqual([...entry.derivedFrom].sort());
      expect(highlightedRelEdges(dom).length).toBe(2);
    }
  });

  test('③ 点击 causes_state_change → 高亮 1 条边 + toId 状态；invariant_scope → scopeStateIds；timing → edges[].timing 查表', () => {
    const data = loadT2Data();
    const { dom } = setupDom(data);
    // causes_state_change：T8（超时取消）→ 边 T8 + 状态 S7
    const csItem = [...dom.window.document.querySelectorAll('.relations-item[data-kind="causes_state_change"]')]
      .find((x) => (x.textContent ?? '').includes('T8 → S7'))!;
    click(dom, csItem);
    expect(highlightedRelEdges(dom)).toEqual(['T8']);
    expect(highlightedRelNodes(dom)).toEqual(['S7']);
    // invariant_scope：INV4 → scopeStateIds [S5]
    const invItem = [...dom.window.document.querySelectorAll('.relations-item[data-kind="invariant_scope"]')]
      .find((x) => (x.textContent ?? '').includes('INV4'))!;
    click(dom, invItem);
    expect(highlightedRelNodes(dom)).toEqual(['S5']);
    expect(highlightedRelEdges(dom)).toEqual([]);
    // timing：TM1（timeout，source=pay_success target=accept）→ edges[].timing 含 TM1 的边
    const tmItem = [...dom.window.document.querySelectorAll('.relations-item[data-kind="timing"]')]
      .find((x) => (x.textContent ?? '').includes('TM1'))!;
    click(dom, tmItem);
    const expectedEdges = data.stateMachine.edges
      .filter((e) => Array.isArray(e.timing) && e.timing.some((t) => t.id === 'TM1'))
      .map((e) => e.id)
      .sort();
    expect(expectedEdges.length).toBeGreaterThan(0);
    expect(highlightedRelEdges(dom)).toEqual(expectedEdges);
  });

  test('③b timing degraded 条目：显示 degraded 标记（TM3/TM4）', () => {
    const data = loadT2Data();
    const { dom } = setupDom(data);
    const degradedItems = [...dom.window.document.querySelectorAll('.relations-item-degraded')];
    expect(degradedItems.length).toBe(2); // TM3 scheduled / TM4 continuous
    const text = degradedItems.map((x) => x.textContent ?? '').join('|');
    expect(text).toContain('degraded');
    expect(text).toContain('TM3');
    expect(text).toContain('TM4');
  });

  test('④ N1 反向 → 面板降级提示', () => {
    const data = loadT2Data();
    const { dom, win } = setupDom(data);
    win.ProtochainViewer!.state.n1 = { degraded: true, fresh: false, alert: '增强数据过期' };
    const panels = dom.window.document.querySelector('#panels') as unknown as { innerHTML: string };
    (dom.window as unknown as { ProtochainViewerHooks: { renderAll: (s: unknown, p: unknown) => void } })
      .ProtochainViewerHooks.renderAll(win.ProtochainViewer!.state, panels);
    const note = dom.window.document.querySelector('.relations-empty')?.textContent ?? '';
    expect(note).toContain('N1');
  });
});
