/**
 * W3-d 数据契约补强（05-execution-T1 TA1）单测
 *
 * 覆盖范围（05-execution-T1.md §TA1 验收判据）：
 * ① nodes/edges 数量与 fixture model 状态/转移数一致；
 * ② edgeCoverage 覆盖全部 transitionId（无遗漏）；
 * ③ sourceModelVersion 字段保留不变；
 * ④ tsc 0 errors + jest 全过（本文件即 jest 部分）。
 *
 * 机械投影原则（03-viewer.md W3-d）：
 * - nodes/edges 只做 StateDef/TransitionDef 字段搬运；
 * - edgeCoverage 从既有 test-cases coverage + verification caseResults 投影；
 * - 不做任何端内推导（viewer 端零推导，这里验证的是工具链侧投影）。
 */

import {
  buildWebData,
  buildStateMachineView,
  buildEdgeCoverage,
  type WebDataJson,
  type EdgeCoverageStatus,
} from '../../src/webgen/index.js';
import { parseProtocolFile } from '../../src/parser/index.js';
import { specify, envelopeMigrate, isSpecsEnvelope } from '../../src/specifier/index.js';
import type {
  SourceProtocolModel,
  TestCaseSet,
  VerificationReport,
} from '../../src/model/types.js';

const FIXTURE_DIR = '/work/protochain/tests/fixtures';

function loadApprovalFlowModel(): SourceProtocolModel {
  return parseProtocolFile(`${FIXTURE_DIR}/approval-flow.md`);
}

function loadFoodDeliveryModel(): SourceProtocolModel {
  // /work/protochain/tests/fixtures → 上两级 = /work/protochain → examples/...
  return parseProtocolFile(`${FIXTURE_DIR}/../../examples/food-delivery/protocol/model.md`);
}

/** 构造最小 TestCaseSet：coverage 报告的 uncoveredIds + paths（含 transitionIds） */
function makeTestCases(
  paths: Array<{ id: string; transitionIds: string[]; stateIds: string[] }>,
  uncoveredIds: string[],
  totalTransitions: number
): TestCaseSet {
  const allCovered = new Set(paths.flatMap((p) => p.transitionIds));
  const coveredIds = [...allCovered].filter((id) => !uncoveredIds.includes(id));
  return {
    paths: paths.map((p) => ({
      id: p.id,
      transitionIds: p.transitionIds,
      stateIds: p.stateIds,
      length: p.transitionIds.length,
    })),
    coverage: {
      criterion: 'transition',
      stateCoverage: {
        total: 0,
        covered: 0,
        coveredIds: [],
        uncoveredIds: [],
        ratio: 0,
      },
      transitionCoverage: {
        total: totalTransitions,
        covered: coveredIds.length,
        coveredIds,
        uncoveredIds,
        ratio: coveredIds.length / totalTransitions,
      },
      uncoveredDispositions: uncoveredIds.map((id) => ({
        elementId: id,
        elementType: 'transition',
        disposition: 'missing_supplement' as const,
        reason: 'test fixture',
      })),
    },
    generatedAt: new Date().toISOString(),
  };
}

/** 构造最小 VerificationReport */
function makeVerification(
  caseResults: Array<{ pathId: string; passed: boolean }>
): VerificationReport {
  return {
    authoritative: {
      passed: caseResults.every((r) => r.passed),
      counts: {
        passed: caseResults.filter((r) => r.passed).length,
        failed: caseResults.filter((r) => !r.passed).length,
        skipped: 0,
      },
      caseResults: caseResults.map((r) => ({
        pathId: r.pathId,
        passed: r.passed,
        deviations: [],
      })),
    },
    verifiedAt: new Date().toISOString(),
  };
}

/** 构造 specs Envelope（approval-flow / food-delivery 通用） */
function makeSpecsEnvelope(model: SourceProtocolModel) {
  const migrated = envelopeMigrate(specify(model).specs);
  if (!isSpecsEnvelope(migrated.envelope)) {
    throw new Error('specs envelope 构造失败');
  }
  return migrated.envelope;
}

// ---------------------------------------------------------------------------
// ① nodes/edges 数量与 fixture 一致
// ---------------------------------------------------------------------------

describe('buildStateMachineView（W3-d 数据契约）', () => {
  test('approval-flow：nodes=5、edges=5（与 model 状态/转移数一致）', () => {
    const model = loadApprovalFlowModel();
    const view = buildStateMachineView(model);
    expect(model.derivable.states.length).toBe(5);
    expect(model.derivable.transitions.length).toBe(5);
    expect(view.nodes.length).toBe(5);
    expect(view.edges.length).toBe(5);
  });

  test('food-delivery：nodes=8、edges=11（与 model 状态/转移数一致）', () => {
    const model = loadFoodDeliveryModel();
    const view = buildStateMachineView(model);
    expect(model.derivable.states.length).toBe(8);
    expect(model.derivable.transitions.length).toBe(11);
    expect(view.nodes.length).toBe(8);
    expect(view.edges.length).toBe(11);
  });

  test('nodes 投影：id/name/type/terminal/roleIds 与 StateDef 逐字段一致', () => {
    const model = loadApprovalFlowModel();
    const view = buildStateMachineView(model);
    // S1 草稿 initial / S3 已通过 terminal / 无 roleIds 的 S3
    const s1 = view.nodes.find((n) => n.id === 'S1');
    const s3 = view.nodes.find((n) => n.id === 'S3');
    const s2 = view.nodes.find((n) => n.id === 'S2');
    expect(s1).toMatchObject({ id: 'S1', name: '草稿', type: 'initial', terminal: false });
    expect(s1?.roleIds).toEqual(['applicant']);
    expect(s3).toMatchObject({ id: 'S3', name: '已通过', type: 'terminal', terminal: true });
    expect(s2?.roleIds).toEqual(['approver']);
    // 全部节点 id 与 model 一致（无遗漏、无多）
    expect(view.nodes.map((n) => n.id).sort()).toEqual(
      model.derivable.states.map((s) => s.id).sort()
    );
  });

  test('edges 投影：id/action/from/to/derivedFrom 与 TransitionDef 逐字段一致', () => {
    const model = loadApprovalFlowModel();
    const view = buildStateMachineView(model);
    const t1 = view.edges.find((e) => e.id === 'T1');
    expect(t1).toMatchObject({
      id: 'T1',
      action: 'submit',
      from: ['S1'],
      to: 'S2',
      triggerRoleId: 'applicant',
      derivedFrom: 'T1',
    });
    const t5 = view.edges.find((e) => e.id === 'T5');
    expect(t5).toMatchObject({ id: 'T5', action: 'timeout_return', from: ['S2'], to: 'S1' });
    // 全部边 id 与 model 一致（无遗漏、无多）
    expect(view.edges.map((e) => e.id).sort()).toEqual(
      model.derivable.transitions.map((t) => t.id).sort()
    );
  });

  test('degraded 投影：异常路径 transitionIds 中的转移标记为 true', () => {
    const model = loadApprovalFlowModel();
    const view = buildStateMachineView(model);
    // EX1: T1,T5；EX2: T4
    expect(view.edges.find((e) => e.id === 'T1')?.degraded).toBe(true);
    expect(view.edges.find((e) => e.id === 'T4')?.degraded).toBe(true);
    expect(view.edges.find((e) => e.id === 'T5')?.degraded).toBe(true);
    expect(view.edges.find((e) => e.id === 'T2')?.degraded).toBe(false);
    expect(view.edges.find((e) => e.id === 'T3')?.degraded).toBe(false);
  });

  test('guard 投影：guard 原文 + guardSchemaKind 显式降级为 description-only', () => {
    const model = loadApprovalFlowModel();
    const view = buildStateMachineView(model);
    const t1 = view.edges.find((e) => e.id === 'T1');
    expect(t1?.guard).toBe('form_valid');
    expect(t1?.guardSchemaKind).toBe('description-only');
    const t2 = view.edges.find((e) => e.id === 'T2');
    expect(t2?.guard).toBe('has_request');
    expect(t2?.guardSchemaKind).toBe('description-only');
    // 无 guard 的转移不携带 guard 字段（food-delivery T1 提交订单无 guard 列）
    const fdModel = loadFoodDeliveryModel();
    const fdView = buildStateMachineView(fdModel);
    const fdT1 = fdView.edges.find((e) => e.id === 'T1');
    expect(fdT1?.guard).toBeUndefined();
    expect(fdT1?.guardSchemaKind).toBeUndefined();
  });

  test('timing 投影：timing.source/target 匹配转移 action 的时序约束被关联', () => {
    const model = loadApprovalFlowModel();
    const view = buildStateMachineView(model);
    // TM1: source=submit target=approve → T1(submit)/T2(approve)
    // TM2: source=timeout_return target=submit → T5(timeout_return)/T1(submit)
    const t1 = view.edges.find((e) => e.id === 'T1');
    const t2 = view.edges.find((e) => e.id === 'T2');
    const t5 = view.edges.find((e) => e.id === 'T5');
    expect(t1?.timing?.map((x) => x.id).sort()).toEqual(['TM1', 'TM2']);
    expect(t2?.timing?.map((x) => x.id)).toEqual(['TM1']);
    expect(t5?.timing?.map((x) => x.id)).toEqual(['TM2']);
    expect(t2?.timing?.[0]).toMatchObject({ type: 'timeout', boundMs: 86400000 });
    // 无关转移（T3/T4）无 timing
    expect(view.edges.find((e) => e.id === 'T3')?.timing).toBeUndefined();
    expect(view.edges.find((e) => e.id === 'T4')?.timing).toBeUndefined();
  });

  test('mermaid 字符串保留兼容（VitePress 快照页不回归）', () => {
    const model = loadApprovalFlowModel();
    const view = buildStateMachineView(model);
    expect(view.mermaid).toContain('stateDiagram-v2');
    expect(view.mermaid).toContain('S1 --> S2 : submit[form_valid]');
  });
});

// ---------------------------------------------------------------------------
// ② edgeCoverage 覆盖全部 transitionId（无遗漏）
// ---------------------------------------------------------------------------

describe('buildEdgeCoverage（W3-d edgeCoverage 投影）', () => {
  test('无 testCases/verification → 全部 uncovered 且覆盖全部 transitionId', () => {
    const model = loadApprovalFlowModel();
    const coverage = buildEdgeCoverage(model);
    expect(Object.keys(coverage).sort()).toEqual(['T1', 'T2', 'T3', 'T4', 'T5']);
    for (const status of Object.values(coverage)) {
      expect(status).toBe('uncovered');
    }
  });

  test('uncovered 优先：coverage.uncoveredIds 中的转移标 uncovered', () => {
    const model = loadApprovalFlowModel();
    const testCases = makeTestCases(
      [{ id: 'P1', transitionIds: ['T1', 'T2'], stateIds: ['S1', 'S2', 'S3'] }],
      ['T3', 'T4', 'T5'],
      5
    );
    const coverage = buildEdgeCoverage(model, testCases);
    expect(coverage.T1).toBe('uncovered'); // 无 verification → 无验证证据
    expect(coverage.T2).toBe('uncovered');
    expect(coverage.T3).toBe('uncovered');
    expect(coverage.T4).toBe('uncovered');
    expect(coverage.T5).toBe('uncovered');
    expect(Object.keys(coverage).length).toBe(5);
  });

  test('被覆盖转移 + verification 全过 → pass', () => {
    const model = loadApprovalFlowModel();
    const testCases = makeTestCases(
      [{ id: 'P1', transitionIds: ['T1', 'T2'], stateIds: ['S1', 'S2', 'S3'] }],
      ['T3', 'T4', 'T5'],
      5
    );
    const verification = makeVerification([{ pathId: 'P1', passed: true }]);
    const coverage = buildEdgeCoverage(model, testCases, verification);
    expect(coverage.T1).toBe('pass');
    expect(coverage.T2).toBe('pass');
    expect(coverage.T3).toBe('uncovered');
  });

  test('任一覆盖路径失败 → fail（即使其他路径通过）', () => {
    const model = loadApprovalFlowModel();
    const testCases = makeTestCases(
      [
        { id: 'P1', transitionIds: ['T1', 'T2'], stateIds: ['S1', 'S2', 'S3'] },
        { id: 'P2', transitionIds: ['T2', 'T3'], stateIds: ['S1', 'S2', 'S4'] },
      ],
      ['T4', 'T5'],
      5
    );
    const verification = makeVerification([
      { pathId: 'P1', passed: false },
      { pathId: 'P2', passed: true },
    ]);
    const coverage = buildEdgeCoverage(model, testCases, verification);
    // T1 仅被 P1（failed）覆盖 → fail；T2 被 P1(failed)+P2(passed) → fail；T3 仅 P2(passed) → pass
    expect(coverage.T1).toBe('fail');
    expect(coverage.T2).toBe('fail');
    expect(coverage.T3).toBe('pass');
    expect(coverage.T4).toBe('uncovered');
    expect(coverage.T5).toBe('uncovered');
  });

  test('被覆盖但 caseResult 缺席（skipped/未验证）→ uncovered，不谎报 pass', () => {
    const model = loadApprovalFlowModel();
    // P1 覆盖 T1/T2，但 verification 无 P1 的 caseResult
    const testCases = makeTestCases(
      [{ id: 'P1', transitionIds: ['T1', 'T2'], stateIds: ['S1', 'S2', 'S3'] }],
      ['T3', 'T4', 'T5'],
      5
    );
    const verification = makeVerification([{ pathId: 'P_OTHER', passed: true }]);
    const coverage = buildEdgeCoverage(model, testCases, verification);
    expect(coverage.T1).toBe('uncovered');
    expect(coverage.T2).toBe('uncovered');
  });

  test('food-delivery：edgeCoverage 覆盖全部 11 个 transitionId', () => {
    const model = loadFoodDeliveryModel();
    const coverage = buildEdgeCoverage(model);
    const ids = Object.keys(coverage);
    expect(ids.length).toBe(11);
    for (const id of ids) {
      expect(coverage[id]).toBe('uncovered');
      expect(['pass', 'fail', 'uncovered'] as EdgeCoverageStatus[]).toContain(coverage[id]);
    }
    // 与 model transitions 一一对应
    expect(ids.sort()).toEqual(model.derivable.transitions.map((t) => t.id).sort());
  });
});

// ---------------------------------------------------------------------------
// ③ buildWebData 集成：sourceModelVersion 保留 + 契约完整
// ---------------------------------------------------------------------------

describe('buildWebData 集成（W3-d）', () => {
  test('approval-flow → stateMachine 契约完整 + sourceModelVersion 保留', () => {
    const model = loadApprovalFlowModel();
    const specsEnvelope = makeSpecsEnvelope(model);
    const data: WebDataJson = buildWebData({
      specsEnvelope,
      model,
    });
    expect(data.sourceModelVersion).toBe('1.0.0');
    expect(data.stateMachine.nodes.length).toBe(5);
    expect(data.stateMachine.edges.length).toBe(5);
    expect(data.stateMachine.mermaid).toContain('stateDiagram-v2');
    expect(Object.keys(data.stateMachine.edgeCoverage).length).toBe(5);
  });

  test('带 test-cases + verification → edgeCoverage 有 pass 值且 data.json 序列化正常', () => {
    const model = loadApprovalFlowModel();
    const specsEnvelope = makeSpecsEnvelope(model);
    const testCases = makeTestCases(
      [{ id: 'P1', transitionIds: ['T1', 'T2'], stateIds: ['S1', 'S2', 'S3'] }],
      ['T3', 'T4', 'T5'],
      5
    );
    const verification = makeVerification([{ pathId: 'P1', passed: true }]);
    const data = buildWebData({ specsEnvelope, model, testCases, verification });
    expect(data.stateMachine.edgeCoverage.T1).toBe('pass');
    expect(data.stateMachine.edgeCoverage.T3).toBe('uncovered');
    // JSON 序列化往返无损（viewer 读取 data.json 的形态）
    const roundtrip = JSON.parse(JSON.stringify(data)) as WebDataJson;
    expect(roundtrip.stateMachine.nodes.length).toBe(5);
    expect(roundtrip.stateMachine.edges[0]).toHaveProperty('derivedFrom');
    expect(roundtrip.stateMachine.edgeCoverage.T2).toBe('pass');
  });

  test('sourceModelVersion 与 metadata.version 始终一致（N1 守卫比对依据）', () => {
    const model = loadFoodDeliveryModel();
    const specsEnvelope = makeSpecsEnvelope(model);
    const data = buildWebData({ specsEnvelope, model });
    expect(data.sourceModelVersion).toBe(model.metadata.version);
    expect(data.sourceModelVersion).toBe('1.0.0');
  });
});

// ---------------------------------------------------------------------------
// ④ W3-e invariantScope（06-execution-T2 TB2）：不变量 × 状态 × 角色 机械投影
// ---------------------------------------------------------------------------

describe('buildStateMachineView.invariantScope（W3-e / TB2）', () => {
  test('① 条目数 = fixture model 不变量数（逐不变量无遗漏）', () => {
    const model = loadFoodDeliveryModel();
    const view = buildStateMachineView(model);
    expect(Object.keys(view.invariantScope).sort()).toEqual(
      model.derivable.invariants.map((i) => i.id).sort()
    );
    expect(Object.keys(view.invariantScope).length).toBe(5); // INV1~INV5
  });

  test('② scopeStateIds 与 InvariantDef.scopeStateIds 一致（空 → 全部状态 id）', () => {
    const model = loadFoodDeliveryModel();
    const view = buildStateMachineView(model);
    const allStateIds = model.derivable.states.map((s) => s.id);
    const invById = new Map(model.derivable.invariants.map((i) => [i.id, i]));
    for (const [invId, entry] of Object.entries(view.invariantScope)) {
      const inv = invById.get(invId)!;
      const expected =
        inv.scopeStateIds && inv.scopeStateIds.length > 0
          ? inv.scopeStateIds
          : allStateIds;
      expect(entry.scopeStateIds).toEqual(expected);
      // 每个 scope 状态 id 均存在
      for (const sid of entry.scopeStateIds) {
        expect(model.derivable.states.some((s) => s.id === sid)).toBe(true);
      }
      expect(entry.name).toBe(inv.name);
    }
    // 具体断言：INV4（骑手在途单量受限）scope=[S5]
    expect(view.invariantScope.INV4.scopeStateIds).toEqual(['S5']);
    // approval-flow：INV1/INV2 全局 → 全部 5 状态
    const af = buildStateMachineView(loadApprovalFlowModel());
    expect(af.invariantScope.INV1.scopeStateIds).toEqual(['S1', 'S2', 'S3', 'S4', 'S5']);
    expect(af.invariantScope.INV2.scopeStateIds).toEqual(['S1', 'S2', 'S3', 'S4', 'S5']);
  });

  test('③ carrierRoleIds ⊆ 顶层 roles id 集合，且 = scope 状态 roleIds 并集（独立计算比对）', () => {
    const model = loadFoodDeliveryModel();
    const view = buildStateMachineView(model);
    const roleIds = new Set(model.metadata.roles.map((r) => r.id));
    const roleByState = new Map(model.derivable.states.map((s) => [s.id, s.roleIds ?? []]));
    for (const entry of Object.values(view.invariantScope)) {
      // ⊆ roles
      for (const r of entry.carrierRoleIds) {
        expect(roleIds.has(r)).toBe(true);
      }
      // = scope 状态 roleIds 并集（Node 侧独立计算）
      const union = new Set<string>();
      for (const sid of entry.scopeStateIds) {
        for (const r of roleByState.get(sid) ?? []) union.add(r);
      }
      expect(entry.carrierRoleIds).toEqual([...union].sort());
    }
    // 具体断言：INV4（骑手运力约束）→ carrier = {rider}（S5 的 roleIds）
    expect(view.invariantScope.INV4.carrierRoleIds).toEqual(['rider']);
    // INV1（金额一致性，S1~S6）→ {customer, merchant, rider, system}
    expect(view.invariantScope.INV1.carrierRoleIds).toEqual(['customer', 'merchant', 'rider', 'system']);
  });

  test('④ sourceModelVersion 保留不变（buildWebData 集成）', () => {
    const model = loadFoodDeliveryModel();
    const specsEnvelope = makeSpecsEnvelope(model);
    const data = buildWebData({ specsEnvelope, model });
    expect(data.sourceModelVersion).toBe('1.0.0');
    expect(Object.keys(data.stateMachine.invariantScope).length).toBe(5);
    // JSON 序列化往返无损（viewer 读取形态）
    const roundtrip = JSON.parse(JSON.stringify(data)) as WebDataJson;
    expect(roundtrip.stateMachine.invariantScope.INV4.carrierRoleIds).toEqual(['rider']);
  });
});
