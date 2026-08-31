/**
 * T4a（X20）机械验收：对抗用例执行闭环验证
 *
 * - T4a-2 D5 确定性：用例 → 测试代码确定性翻译（同一模型两次生成 body 逐字节一致）
 * - T4a-3 执行：body mock 依赖闭合（引用 ⊆ runtime 提供 → 可执行；缺失 → 显式降级记录）
 * - T4a-4 冻结边界：带 scheduled 任务模型 body 声明 mock 调度器/定时器（R5）
 */
import { generateCases } from '../../src/casegen/index.js';
import { collectAdversarialRuntimeDeps } from '../../src/testtool/adversarial-runtime.js';
import type {
  SourceProtocolModel,
  DerivableLayer,
  OperationDef,
  InvariantDef,
  StateDef,
} from '../../src/model/types.js';

function mkOp(id: string, name: string, triggerType: OperationDef['triggerType'], affectsDimensions: string[]): OperationDef {
  return {
    id,
    name,
    triggerRoleId: 'role1',
    target: '实体',
    targetEntities: ['实体'],
    guard: '无',
    change: '',
    changes: [],
    affectsDimensions,
    sideEffects: [],
    triggerType,
  };
}

function mkModel(overrides: { operations?: OperationDef[]; invariants?: InvariantDef[] } = {}): SourceProtocolModel {
  const derivable: DerivableLayer = {
    degraded: false,
    states: [
      { id: 'S1', name: 'S1', type: 'initial', dimensions: [{ name: 'dim_obs', type: 'string', initial: '', kind: 'observed', kindSource: 'asserted' }] },
      { id: 'S2', name: 'S2', type: 'terminal', dimensions: [] },
    ],
    transitions: [
      {
        id: 'T1',
        name: 'T1',
        from: ['S1'],
        to: 'S2',
        action: 'act_role',
        triggerType: 'role',
        trigger: 'role1',
        triggerRoleId: 'role1',
        actionType: 'state_transition',
        affectsDimensions: ['dim_obs'],
      },
    ],
    operations: overrides.operations ?? [],
    invariants: overrides.invariants ?? [],
    timing: [],
    exceptions: [],
    initialStateId: 'S1',
    terminalStateIds: ['S2'],
  };
  return {
    metadata: {
      name: 'T4a 测试协议',
      version: '1.0.0',
      purpose: '对抗用例执行闭环验收',
      roles: [
        { id: 'role1', name: '角色1', responsibilities: '', roleType: 'participant' },
        { id: 'system', name: '系统', responsibilities: '', roleType: 'consensus' },
      ],
    },
    readable: { background: 'b', concepts: [], workflow: 'w' },
    derivable,
    contractInput: undefined,
  };
}

describe('T4a-2 确定性翻译（D5）', () => {
  test('同一模型两次生成对抗用例 body 逐字节一致', () => {
    const model = mkModel({
      operations: [mkOp('OP1', 'recalc', 'scheduled', ['dim_obs'])],
      invariants: [
        {
          id: 'INV1',
          name: 'INV1',
          expression: 'dim_obs == "ok"',
          declaredBy: 'system',
          invariantClass: 'intra_protocol',
          remedy: { detection: { kind: 'description-only', description: '对账任务比对' }, action: '重算' },
        },
      ],
    });
    const a = generateCases(model);
    const b = generateCases(model);
    const bodiesA = (a.adversarialCases ?? []).map((c) => c.body);
    const bodiesB = (b.adversarialCases ?? []).map((c) => c.body);
    expect(bodiesA.length).toBe(bodiesB.length);
    for (let i = 0; i < bodiesA.length; i++) {
      expect(bodiesA[i]).toBe(bodiesB[i]);
    }
  });
});

describe('T4a-3 mock 依赖闭合', () => {
  test('body 引用函数 ⊆ runtime 提供 → executable=true', () => {
    const model = mkModel({
      operations: [mkOp('OP1', 'recalc', 'scheduled', ['dim_obs'])],
      invariants: [
        {
          id: 'INV1',
          name: 'INV1',
          expression: 'dim_obs == "ok"',
          declaredBy: 'system',
          invariantClass: 'intra_protocol',
          remedy: { detection: { kind: 'description-only', description: '对账任务比对' }, action: '重算' },
        },
      ],
    });
    const set = generateCases(model);
    const bodies = (set.adversarialCases ?? []).map((c) => c.body ?? '');
    const r = collectAdversarialRuntimeDeps(bodies);
    expect(r.missing).toEqual([]);
    expect(r.executable).toBe(true);
    // X12 依赖的函数在 runtime 中
    for (const f of ['makeViolation', 'converged', 'elapsed', 'mockSchedulerAndTimers']) {
      expect(r.provided).toContain(f);
    }
  });

  test('body 引用未提供函数 → missing 显式记录（降级不静默）', () => {
    const r = collectAdversarialRuntimeDeps([
      `someUnknownHelper('x');`,
    ]);
    expect(r.executable).toBe(false);
    expect(r.missing).toContain('someUnknownHelper');
  });
});

describe('T4a-4 冻结边界声明（R5）', () => {
  test('scheduled 模型对抗用例 body 声明 mock 调度器/定时器', () => {
    const model = mkModel({
      operations: [mkOp('OP1', 'recalc', 'scheduled', ['dim_obs'])],
      invariants: [
        {
          id: 'INV1',
          name: 'INV1',
          expression: 'dim_obs == "ok"',
          declaredBy: 'system',
          invariantClass: 'intra_protocol',
          remedy: { detection: { kind: 'description-only', description: '对账' }, action: '重算' },
        },
      ],
    });
    const set = generateCases(model);
    const bodies = (set.adversarialCases ?? []).map((c) => c.body ?? '');
    expect(bodies.join('\n')).toContain('mockSchedulerAndTimers()');
    expect(bodies.join('\n')).toContain('冻结边界声明');
  });
});
