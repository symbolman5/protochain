/**
 * T3a 机械验收：remedy.detection → 收敛断言（X12）
 *
 * - T3a-2 正反向：有 detection 的不变量 → 生成收敛断言（含 boundMs）；无 detection → 显式降级不阻断
 * - T3a-3 M9：收敛用例数 ≤ 不变量数，差额有降级记录
 * - T3a-4 老模型零回归：remedy 纯文本（action 无 detection）继续可解析 + 降级
 * - T3a-R5 冻结边界声明：带 scheduled 任务的模型，X12 用例 body 声明 mock 掉调度器/定时器
 */
import { generateCases } from '../../src/casegen/index.js';
import type {
  SourceProtocolModel,
  DerivableLayer,
  StateDef,
  OperationDef,
  InvariantDef,
  TimingDef,
  SchemaExpression,
} from '../../src/model/types.js';

function mkOp(
  id: string,
  name: string,
  triggerType: OperationDef['triggerType'],
  affectsDimensions: string[]
): OperationDef {
  return {
    id,
    name,
    triggerRoleId: undefined,
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

function mkInvariant(
  id: string,
  expression: string,
  remedy?: { detection?: SchemaExpression; action: string }
): InvariantDef {
  return {
    id,
    name: id,
    expression,
    declaredBy: 'system',
    invariantClass: 'intra_protocol',
    remedy,
  };
}

function mkTiming(id: string, source: string, target: string, boundMs?: number): TimingDef {
  return { id, name: id, type: 'timeout', source, target, boundMs };
}

function mkModel(overrides: {
  operations?: OperationDef[];
  invariants?: InvariantDef[];
  timing?: TimingDef[];
} = {}): SourceProtocolModel {
  const derivable: DerivableLayer = {
    degraded: false,
    states: [
      { id: 'S1', name: 'S1', type: 'initial', dimensions: [] },
      { id: 'S2', name: 'S2', type: 'terminal', dimensions: [] },
    ],
    transitions: [],
    operations: overrides.operations ?? [],
    invariants: overrides.invariants ?? [],
    timing: overrides.timing ?? [],
    exceptions: [],
    initialStateId: 'S1',
    terminalStateIds: ['S2'],
  };
  return {
    metadata: {
      name: 'T3a 测试协议',
      version: '1.0.0',
      purpose: 'remedy.detection → X12 收敛断言验收',
      roles: [{ id: 'system', name: '系统', responsibilities: '', roleType: 'consensus' }],
    },
    readable: { background: 'b', concepts: [], workflow: 'w' },
    derivable,
    contractInput: undefined,
  };
}

function convergenceCases(model: SourceProtocolModel) {
  const set = generateCases(model);
  return (set.adversarialCases ?? []).filter((c) => c.kind === 'convergence');
}

describe('T3a-2 正反向：remedy.detection → 收敛断言', () => {
  test('有 detection + boundMs → 生成收敛用例（含 boundMs 断言）', () => {
    const model = mkModel({
      operations: [mkOp('OP1', 'recalc', 'scheduled', ['dim1'])],
      invariants: [
        mkInvariant('INV1', 'dim1 == "ok"', {
          detection: { kind: 'description-only', description: '对账任务比对观测值' },
          action: '重算观测值',
        }),
      ],
      timing: [mkTiming('TM1', 'INV1', 'INV1', 60000)],
    });
    const cases = convergenceCases(model);
    expect(cases).toHaveLength(1);
    expect(cases[0].id).toBe('X12_INV1');
    expect(cases[0].boundMs).toBe(60000);
    expect(cases[0].body).toContain('toBeLessThanOrEqual(60000)');
  });

  test('无 detection（remedy 纯文本）→ 显式降级记录，不生成用例（不阻断）', () => {
    const model = mkModel({
      invariants: [mkInvariant('INV2', 'dim1 == "ok"', { action: '重算观测值' })],
    });
    const set = generateCases(model);
    expect(convergenceCases(model)).toHaveLength(0);
    const degraded = (set.degradedReasons ?? []).some(
      (d) => d.includes('X12 降级') && d.includes('INV2') && d.includes('detection 缺省')
    );
    expect(degraded).toBe(true);
  });
});

describe('T3a-3 M9：收敛用例数 ≤ 不变量数，差额有降级记录', () => {
  test('有 detection 1 + 无 detection 2 → 用例 1，降级记录 2', () => {
    const model = mkModel({
      invariants: [
        mkInvariant('INV_A', 'e1', { detection: { kind: 'description-only', description: 'd1' }, action: 'a1' }),
        mkInvariant('INV_B', 'e2', { action: 'a2' }),
        mkInvariant('INV_C', 'e3', { action: 'a3' }),
      ],
    });
    const set = generateCases(model);
    const cases = convergenceCases(model);
    expect(cases.length).toBe(1);
    expect(cases.length).toBeLessThanOrEqual(model.derivable.invariants.length);
    const degradedCount = (set.degradedReasons ?? []).filter(
      (d) => d.includes('X12 降级') && d.includes('detection 缺省')
    ).length;
    expect(degradedCount).toBe(2); // INV_B / INV_C 差额显式记录
  });
});

describe('T3a-R5 冻结边界声明', () => {
  test('带 scheduled 重算任务的模型 → X12 body 声明 mock 调度器/定时器', () => {
    const model = mkModel({
      operations: [mkOp('OP1', 'recalc', 'scheduled', ['dim1'])],
      invariants: [
        mkInvariant('INV1', 'dim1 == "ok"', {
          detection: { kind: 'description-only', description: '对账任务比对' },
          action: '重算',
        }),
      ],
    });
    const cases = convergenceCases(model);
    expect(cases).toHaveLength(1);
    expect(cases[0].body).toContain('冻结边界声明');
    expect(cases[0].body).toContain('mockSchedulerAndTimers()');
  });

  test('无 scheduled 任务 → body 不含 mock 声明（标注无需冻结）', () => {
    const model = mkModel({
      invariants: [
        mkInvariant('INV1', 'dim1 == "ok"', {
          detection: { kind: 'description-only', description: '对账任务比对' },
          action: '重算',
        }),
      ],
    });
    const cases = convergenceCases(model);
    expect(cases).toHaveLength(1);
    expect(cases[0].body).toContain('无需冻结调度器');
    expect(cases[0].body).not.toContain('mockSchedulerAndTimers()');
  });
});
