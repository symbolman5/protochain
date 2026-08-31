/**
 * T2a + T2b 机械验收：guard 可执行化（M11）+ computed 三值
 *
 * - T2a-2 M11：命中 guard 全 json-schema 且 ajv 可编译（正反向）；未命中显式降级有记录
 * - T2a-3 M4：role 触发接口写 observed/computed 维度 ⇒ 硬失败
 * - T2a-4 computed：断言 computed 但写入方含 role ⇒ 硬失败；写入方全 scheduled ⇒ 通过；
 *   依赖 computed 的不变量标 always 且同事务声明 ⇒ 通过；异步重算无 boundMs ⇒ 硬失败
 * - T2a-5 bindgen：computed/observed 均不出现 setter（grep 判据）
 * - T2a-6 老模型 fixture 零回归（无 computed 维度 → 行为不变）
 */
import { scaffoldInterfaces } from '../../src/scaffolder/index.js';
import { deriveDimensionAccessors } from '../../src/bindgen/index.js';
import { checkCompleteness } from '../../src/checker/index.js';
import { KIND_RULES } from '../../src/checker/kind-rules.js';
import type {
  SourceProtocolModel,
  DerivableLayer,
  StateDef,
  StateDimension,
  OperationDef,
  TransitionDef,
  InvariantDef,
  TimingDef,
  InterfaceSpec,
  SchemaExpression,
} from '../../src/model/types.js';

// ============================================================================
// 辅助构造（IR 级）
// ============================================================================

function mkDim(name: string, kind?: StateDimension['kind']): StateDimension {
  const d: StateDimension = { name, type: 'string', initial: '' };
  if (kind) {
    d.kind = kind;
    d.kindSource = 'asserted';
  }
  return d;
}

function mkState(id: string, type: StateDef['type'], dimensions: StateDimension[] = []): StateDef {
  return { id, name: id, type, dimensions };
}

function mkOp(
  id: string,
  name: string,
  triggerType: OperationDef['triggerType'],
  affectsDimensions: string[],
  triggerRoleId?: string
): OperationDef {
  return {
    id,
    name,
    triggerRoleId,
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

function mkInvariant(id: string, expression: string, scopeStateIds?: string[]): InvariantDef {
  return {
    id,
    name: id,
    expression,
    scopeStateIds,
    declaredBy: 'r1',
    invariantClass: 'intra_protocol',
  };
}

function mkTiming(id: string, source: string, target: string, boundMs?: number): TimingDef {
  return { id, name: id, type: 'deadline', source, target, boundMs };
}

/** 三值维度模型：dim_obs（observed）/ dim_computed（computed）/ dim_decl（declared） */
function mkModel(overrides: {
  operations?: OperationDef[];
  transitions?: TransitionDef[];
  invariants?: InvariantDef[];
  timing?: TimingDef[];
  transactionBoundaries?: DerivableLayer['transactionBoundaries'];
} = {}): SourceProtocolModel {
  const derivable: DerivableLayer = {
    degraded: false,
    states: [
      mkState('S1', 'initial', [mkDim('dim_obs', 'observed'), mkDim('dim_computed', 'computed'), mkDim('dim_decl', 'declared')]),
      mkState('S2', 'terminal'),
    ],
    transitions: overrides.transitions ?? [],
    operations: overrides.operations ?? [],
    invariants: overrides.invariants ?? [],
    timing: overrides.timing ?? [],
    exceptions: [],
    initialStateId: 'S1',
    terminalStateIds: ['S2'],
    transactionBoundaries: overrides.transactionBoundaries,
  };
  return {
    metadata: {
      name: 'T2 测试协议',
      version: '1.0.0',
      purpose: 'T2a guard 可执行化 + T2b computed 三值验收',
      roles: [{ id: 'r1', name: '角色1', responsibilities: '', roleType: 'consensus' }],
    },
    readable: { background: 'b', concepts: [], workflow: 'w' },
    derivable,
    contractInput: undefined,
  };
}

function kindIssues(report: ReturnType<typeof checkCompleteness>) {
  return report.mechanical.referenceIssues.filter((i) => i.message.includes('R-KIND-'));
}

function byRule(issues: ReturnType<typeof kindIssues>, ruleId: string) {
  return issues.filter((i) => i.message.includes(`[${ruleId}/`));
}

// ============================================================================
// T2a-3 M4：role 触发接口写 observed/computed 维度 ⇒ 硬失败
// ============================================================================

describe('T2a-3 M4：role 触发接口写 observed/computed 维度 ⇒ 硬失败', () => {
  test('role 操作写 computed 维度 → R-KIND-1 error（正反向）', () => {
    const model = mkModel({
      operations: [mkOp('OP1', 'act1', 'role', ['dim_computed'], 'r1')],
    });
    const report = checkCompleteness(model);
    const errs = byRule(kindIssues(report), 'R-KIND-1').filter((i) => i.severity === 'error');
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toContain('dim_computed');
    expect(errs[0].message).toContain("kind='computed'");
    expect(report.mechanical.passed).toBe(false);
    // 反证：scheduled 写 computed → 无 error（通过）
    const ok = mkModel({
      operations: [mkOp('OP2', 'recalc', 'scheduled', ['dim_computed'])],
    });
    const report2 = checkCompleteness(ok);
    expect(byRule(kindIssues(report2), 'R-KIND-1').filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  test('role 操作写 observed 维度 → R-KIND-1 error（既有行为保留）', () => {
    const model = mkModel({
      operations: [mkOp('OP1', 'act1', 'role', ['dim_obs'], 'r1')],
    });
    const report = checkCompleteness(model);
    expect(byRule(kindIssues(report), 'R-KIND-1').filter((i) => i.severity === 'error').length).toBe(1);
  });
});

// ============================================================================
// T2a-4 computed 正反向
// ============================================================================

describe('T2a-4 computed 三值判定', () => {
  test('断言 computed 但写入方含 role → R-KIND-2 mismatch 硬失败（computed vs derived=declared）', () => {
    const model = mkModel({
      operations: [mkOp('OP1', 'act1', 'role', ['dim_computed'], 'r1')],
    });
    const report = checkCompleteness(model);
    const mismatch = byRule(kindIssues(report), 'R-KIND-2').filter(
      (i) => i.severity === 'error' && i.message.includes('dimension-kind-mismatch')
    );
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0].message).toContain('dim_computed');
  });

  test('断言 computed 且写入方全 scheduled（推导 observed）→ 通过（computed ⊂ observed 豁免）', () => {
    const model = mkModel({
      operations: [mkOp('OP2', 'recalc', 'scheduled', ['dim_computed'])],
    });
    const report = checkCompleteness(model);
    // 无 mismatch、无 role 写 computed
    expect(byRule(kindIssues(report), 'R-KIND-2').filter((i) => i.severity === 'error')).toHaveLength(0);
    expect(byRule(kindIssues(report), 'R-KIND-1').filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  test('依赖 computed 的不变量标 always 且同事务声明 → 通过（判据 11）', () => {
    const model = mkModel({
      operations: [mkOp('OP2', 'recalc', 'scheduled', ['dim_computed'])],
      invariants: [mkInvariant('INV1', 'dim_computed == "ok"')],
      transactionBoundaries: [
        { id: 'TX1', interface: 'recalc', boundaryType: 'same_transaction' },
      ],
    });
    const report = checkCompleteness(model);
    expect(byRule(kindIssues(report), 'R-KIND-3').filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  test('依赖 computed 的不变量异步重算无 boundMs → 硬失败（判据 11）', () => {
    const model = mkModel({
      operations: [mkOp('OP2', 'recalc', 'scheduled', ['dim_computed'])],
      invariants: [mkInvariant('INV1', 'dim_computed == "ok"')],
      // 无 transactionBoundaries、无 timing → 等价 always → 硬失败
    });
    const report = checkCompleteness(model);
    const errs = byRule(kindIssues(report), 'R-KIND-3').filter((i) => i.severity === 'error');
    expect(errs.length).toBeGreaterThanOrEqual(1);
    expect(errs[0].message).toContain('dim_computed');
    expect(errs[0].message).toContain('判据11');
  });

  test('依赖 computed 的不变量关联 timing 带 boundMs → 通过', () => {
    const model = mkModel({
      operations: [mkOp('OP2', 'recalc', 'scheduled', ['dim_computed'])],
      invariants: [mkInvariant('INV1', 'dim_computed == "ok"')],
      timing: [mkTiming('TM1', 'INV1', 'INV1', 500)],
    });
    const report = checkCompleteness(model);
    expect(byRule(kindIssues(report), 'R-KIND-3').filter((i) => i.severity === 'error')).toHaveLength(0);
  });
});

// ============================================================================
// T2a-5 bindgen：computed/observed 均不出现 setter
// ============================================================================

describe('T2a-5 bindgen：computed/observed 均不生成 setter', () => {
  test('deriveDimensionAccessors：computed/observed 只生成 reader；declared 生成 reader+setter', () => {
    const { entries } = deriveDimensionAccessors([
      { owner: 'S1', dimension: 'dim_obs', kind: 'observed', kindSource: 'derived', writers: ['system'] },
      { owner: 'S1', dimension: 'dim_computed', kind: 'computed', kindSource: 'asserted', writers: ['system'] },
      { owner: 'S1', dimension: 'dim_decl', kind: 'declared', kindSource: 'derived', writers: ['role'] },
    ]);
    const obs = entries.find((e) => e.dimension === 'dim_obs')!;
    const comp = entries.find((e) => e.dimension === 'dim_computed')!;
    const decl = entries.find((e) => e.dimension === 'dim_decl')!;
    expect(obs.setter).toBeUndefined();
    expect(comp.setter).toBeUndefined();
    expect(decl.setter).toBe('setDimDecl');
    expect(obs.reader).toBe('getDimObs');
    expect(comp.reader).toBe('getDimComputed');
  });
});

// ============================================================================
// T2a-2 M11：guard 可执行化（scaffold 标注）
// ============================================================================

describe('T2a-2 M11：guard 可执行化（scaffold 标注正反向）', () => {
  function spec(id: string, name: string, preconditions?: SchemaExpression[]): InterfaceSpec {
    return {
      id,
      kind: 'system',
      sourceId: id,
      name,
      inputs: [],
      outputs: [],
      preconditions,
    };
  }

  test('命中：preconditions 全 json-schema 且 ajv 可编译 → 标注可执行化 + 谓词体待填', () => {
    const specs = [
      spec('IF1', 'act1', [
        {
          kind: 'json-schema',
          schema: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] },
          description: 'status 非空',
        },
      ]),
    ];
    const code = scaffoldInterfaces({ specs });
    expect(code).toContain('[T2a] guard 可执行化（M11 命中）');
    expect(code).toContain('谓词体待填实现');
  });

  test('未命中：legacy-stub 谓词 → 显式降级标注（不静默）', () => {
    const specs = [
      spec('IF1', 'act1', [
        { kind: 'legacy-stub', description: '自然语言守卫，未机械提取' },
      ]),
    ];
    const code = scaffoldInterfaces({ specs });
    expect(code).toContain('[T2a] guard 未可执行化（M11 未命中，显式降级）');
    expect(code).toContain('留 TODO');
  });

  test('无 guard（preconditions 空）→ 无 T2a 标注（老模型零回归）', () => {
    const specs = [spec('IF1', 'act1', undefined)];
    const code = scaffoldInterfaces({ specs });
    expect(code).not.toContain('[T2a]');
  });
});

// ============================================================================
// T2a-6 老模型 fixture 零回归
// ============================================================================

describe('T2a-6 老模型零回归', () => {
  test('无 kind 断言维度（kind 缺省）→ 走既有 undetermined 降级，不引入 computed 行为', () => {
    const model: SourceProtocolModel = mkModel();
    // 清掉维度 kind 断言
    for (const s of model.derivable.states) {
      for (const d of s.dimensions) {
        delete d.kind;
        delete d.kindSource;
      }
    }
    const report = checkCompleteness(model);
    // 无 R-KIND-1/2/3 error（维度无写入方 → undetermined 降级）
    for (const ruleId of ['R-KIND-1', 'R-KIND-2', 'R-KIND-3']) {
      expect(byRule(kindIssues(report), ruleId).filter((i) => i.severity === 'error')).toHaveLength(0);
    }
  });

  test('KIND_RULES 注册表包含 R-KIND-1~15（computed 扩展不改变规则集）', () => {
    const ids = KIND_RULES.map((r) => r.ruleId);
    expect(ids).toContain('R-KIND-1');
    expect(ids).toContain('R-KIND-3');
    expect(ids).toContain('R-KIND-15');
  });
});
