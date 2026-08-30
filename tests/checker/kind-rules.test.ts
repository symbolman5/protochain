/**
 * G7-S2 机械验收：R-KIND-1~4 维度 kind 检查规则组
 *
 * 覆盖 execution-plan.md §S2 的 S2-2~S2-6：
 * - S2-2 R-KIND-1（X2）正反向各一
 * - S2-3 R-KIND-2（M10）正反向各一，混合 / 断言冲突两条触发路径分别验证
 * - S2-4 R-KIND-3（X3）正反向各一
 * - S2-5 死代码自检：对每条规则构造「若规则被绕过则结果不同」的用例（防恒真/恒假）
 * - S2-6 老模型零回归：legacy fixture + 两个演示实例检查结果与 S0 一致
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProtocolContent } from '../../src/parser/index.js';
import { checkCompleteness } from '../../src/checker/index.js';
import { KIND_RULES } from '../../src/checker/kind-rules.js';
import type {
  SourceProtocolModel,
  DerivableLayer,
  StateDef,
  StateDimension,
  TransitionDef,
  InvariantDef,
  TimingDef,
} from '../../src/model/types.js';

// ============================================================================
// 辅助构造（IR 级）
// ============================================================================

const BASE_DIR = join(process.cwd(), 'tests', 'fixtures');
const EXAMPLES_DIR = join(process.cwd(), 'examples');

function mkDim(name: string, extra?: Partial<StateDimension>): StateDimension {
  return { name, type: 'string', initial: '', ...extra };
}

function mkState(id: string, type: StateDef['type'], dimensions: StateDimension[] = []): StateDef {
  return { id, name: id, type, dimensions };
}

function mkTransition(
  id: string,
  to: string,
  opts: {
    triggerType: TransitionDef['triggerType'];
    trigger?: string;
    triggerRoleId?: string;
    affectsDimensions?: string[];
  }
): TransitionDef {
  return {
    id,
    name: id,
    from: ['S1'],
    to,
    action: id,
    triggerType: opts.triggerType,
    trigger: opts.trigger ?? opts.triggerType,
    triggerRoleId: opts.triggerRoleId,
    actionType: 'state_transition',
    affectsDimensions: opts.affectsDimensions ?? [],
  };
}

function mkInvariant(
  id: string,
  expression: string,
  scopeStateIds?: string[]
): InvariantDef {
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

/**
 * 构造结构干净、可通过既有 checker 规则的模型：
 * S1(initial) --T1--> S2(terminal)；terminalStateIds=[S2]。
 * 调用方通过 opts 覆盖 states/transitions 与 roles。
 */
function mkModel(
  overrides: {
    states?: StateDef[];
    transitions?: TransitionDef[];
    invariants?: InvariantDef[];
    timing?: TimingDef[];
    roles?: Array<{ id: string; name?: string; roleType?: 'consensus' | 'participant' }>;
  } = {}
): SourceProtocolModel {
  const roles =
    overrides.roles ??
    [{ id: 'r1', name: '角色1', roleType: 'consensus' as const }]; // consensus：使不变量 declaredBy 通过既有 R2 扩展规则
  const derivable: DerivableLayer = {
    degraded: false,
    states: overrides.states ?? [mkState('S1', 'initial'), mkState('S2', 'terminal')],
    transitions: overrides.transitions ?? [],
    invariants: overrides.invariants ?? [],
    timing: overrides.timing ?? [],
    exceptions: [],
    initialStateId: 'S1',
    terminalStateIds: ['S2'],
  };
  return {
    metadata: {
      name: '测试协议',
      version: '1.0.0',
      purpose: 'R-KIND 规则验收',
      roles: roles.map((r) => ({
        id: r.id,
        name: r.name ?? r.id,
        responsibilities: '',
        roleType: r.roleType ?? 'participant',
      })),
    },
    readable: { background: 'b', concepts: [], workflow: 'w' },
    derivable,
  };
}

/** 从检查报告中抽取 R-KIND 规则产生的 issue */
function kindIssues(report: ReturnType<typeof checkCompleteness>) {
  return report.mechanical.referenceIssues.filter((i) => i.message.includes('R-KIND-'));
}

function byRule(issues: ReturnType<typeof kindIssues>, ruleId: string) {
  return issues.filter((i) => i.message.includes(`[${ruleId}/`));
}

// ============================================================================
// S2-5 死代码自检（防恒真/恒假；先于正反向用例给出「若规则被绕过则结果不同」证明）
// ============================================================================

describe('S2-5 死代码自检：每条规则存在「若被绕过则结果不同」用例', () => {
  test('R-KIND-1：断言 observed + role 写入 ⇒ 命中；若规则只看 W(dim)（role-only→declared）则漏报，结果不同', () => {
    const model = mkModel({
      roles: [{ id: 'customer', name: '顾客' }],
      states: [
        mkState('S1', 'initial', [mkDim('dimA', { kind: 'observed', kindSource: 'asserted' })]),
        mkState('S2', 'terminal'),
      ],
      transitions: [mkTransition('T1', 'S2', { triggerType: 'role', trigger: 'customer', triggerRoleId: 'customer', affectsDimensions: ['dimA'] })],
    });
    const report = checkCompleteness(model);
    const hit = byRule(kindIssues(report), 'R-KIND-1');
    // 命中：kind='observed'（断言）被 role 接口写入
    expect(hit.length).toBeGreaterThan(0);
    // 反证：同一模型 W(dimA)={role} 只含 role，纯 W(dim) 视角会推导 declared 而不报 ——
    // 证明 R-KIND-1 的判定主体必须是 kind（含断言），不是恒真/恒假
    expect(report.mechanical.passed).toBe(false);
  });

  test('R-KIND-2 子句1：混合写入 ⇒ 命中；若规则只看单一写入方则不报，结果不同', () => {
    const model = mkModel({
      states: [
        mkState('S1', 'initial', [mkDim('dimM')]),
        mkState('S2', 'terminal'),
      ],
      transitions: [
        mkTransition('T1', 'S2', { triggerType: 'role', trigger: 'r1', affectsDimensions: ['dimM'] }),
        mkTransition('T2', 'S2', { triggerType: 'system', trigger: 'system', affectsDimensions: ['dimM'] }),
      ],
    });
    const report = checkCompleteness(model);
    const hit = byRule(kindIssues(report), 'R-KIND-2');
    expect(hit.some((i) => i.message.includes('dimension-kind-conflict'))).toBe(true);
    expect(report.mechanical.passed).toBe(false);
  });

  test('R-KIND-2 子句2：断言 declared + 推导 observed ⇒ 命中；若规则不比对断言则不报，结果不同', () => {
    const model = mkModel({
      states: [
        mkState('S1', 'initial', [mkDim('dimN', { kind: 'declared', kindSource: 'asserted' })]),
        mkState('S2', 'terminal'),
      ],
      transitions: [mkTransition('T1', 'S2', { triggerType: 'system', trigger: 'system', affectsDimensions: ['dimN'] })],
    });
    const report = checkCompleteness(model);
    const hit = byRule(kindIssues(report), 'R-KIND-2');
    expect(hit.some((i) => i.message.includes('dimension-kind-mismatch'))).toBe(true);
    expect(report.mechanical.passed).toBe(false);
  });

  test('R-KIND-3：observed 维度不变量无 boundMs ⇒ 命中；若规则只看表达式不匹配时序则不报，结果不同', () => {
    const model = mkModel({
      states: [
        mkState('S1', 'initial', [mkDim('dimP')]),
        mkState('S2', 'terminal'),
      ],
      transitions: [mkTransition('T1', 'S2', { triggerType: 'system', trigger: 'system', affectsDimensions: ['dimP'] })],
      invariants: [mkInvariant('INV1', 'dimP > 0', ['S1'])],
      timing: [],
    });
    const report = checkCompleteness(model);
    const hit = byRule(kindIssues(report), 'R-KIND-3');
    expect(hit.length).toBeGreaterThan(0);
    expect(report.mechanical.passed).toBe(false);
  });

  test('R-KIND-4：无接口触发的角色 ⇒ 告警；若规则只查有接口的角色则不报，结果不同', () => {
    const model = mkModel({
      roles: [
        { id: 'customer', name: '顾客' },
        { id: 'ghost', name: '幽灵角色' },
      ],
      transitions: [mkTransition('T1', 'S2', { triggerType: 'role', trigger: 'customer', triggerRoleId: 'customer' })],
    });
    const report = checkCompleteness(model);
    const hit = byRule(kindIssues(report), 'R-KIND-4');
    expect(hit).toHaveLength(1);
    expect(hit[0].severity).toBe('warning');
    expect(hit[0].elementId).toBe('ghost');
  });
});

// ============================================================================
// S2-2 R-KIND-1（X2）：正反向各一
// ============================================================================

describe('S2-2 R-KIND-1（X2：observed 不得被 role 接口写入）', () => {
  test('正向：人写断言 kind=observed + triggerType=role 接口写入 ⇒ 报告含 R-KIND-1 且 verdict=fail', () => {
    const model = mkModel({
      roles: [{ id: 'customer', name: '顾客' }],
      states: [
        mkState('S1', 'initial', [mkDim('dimA', { kind: 'observed', kindSource: 'asserted' })]),
        mkState('S2', 'terminal'),
      ],
      transitions: [
        mkTransition('T1', 'S2', { triggerType: 'role', trigger: 'customer', triggerRoleId: 'customer', affectsDimensions: ['dimA'] }),
      ],
    });
    const report = checkCompleteness(model);
    const hit = byRule(kindIssues(report), 'R-KIND-1');
    expect(hit.length).toBeGreaterThan(0);
    expect(hit[0].severity).toBe('error');
    expect(hit[0].elementId).toBe('dimA');
    expect(hit[0].message).toContain('人写断言');
    expect(report.mechanical.passed).toBe(false); // verdict = fail
    expect(report.passed).toBe(false);
  });

  test('反向：kind=observed 但无任何 role 接口写入 ⇒ R-KIND-1 不命中（报告无 R-KIND error）', () => {
    const model = mkModel({
      roles: [{ id: 'r1', name: '角色1' }],
      states: [
        mkState('S1', 'initial', [mkDim('dimB', { kind: 'observed', kindSource: 'asserted' })]),
        mkState('S2', 'terminal'),
      ],
      transitions: [
        mkTransition('T1', 'S2', { triggerType: 'system', trigger: 'system', affectsDimensions: ['dimB'] }),
        mkTransition('T2', 'S2', { triggerType: 'external', trigger: 'gw', affectsDimensions: ['dimB'] }),
      ],
    });
    const report = checkCompleteness(model);
    const hit = byRule(kindIssues(report), 'R-KIND-1');
    expect(hit).toHaveLength(0);
    // 断言 observed == 推导 observed，R-KIND-2 亦不报 → 干净模型整体通过
    expect(kindIssues(report).filter((i) => i.severity === 'error')).toHaveLength(0);
    expect(report.mechanical.passed).toBe(true);
  });
});

// ============================================================================
// S2-3 R-KIND-2（M10）：正反向各一，混合 / 断言冲突两条路径分别验证
// ============================================================================

describe('S2-3 R-KIND-2（M10：混合 / 断言冲突）', () => {
  test('路径1-混合：W(dim) 同时含 role 与 system ⇒ 报告含 R-KIND-2（dimension-kind-conflict）且 verdict=fail', () => {
    const model = mkModel({
      states: [
        mkState('S1', 'initial', [mkDim('dimM')]),
        mkState('S2', 'terminal'),
      ],
      transitions: [
        mkTransition('T1', 'S2', { triggerType: 'role', trigger: 'r1', affectsDimensions: ['dimM'] }),
        mkTransition('T2', 'S2', { triggerType: 'system', trigger: 'system', affectsDimensions: ['dimM'] }),
      ],
    });
    const report = checkCompleteness(model);
    const hit = byRule(kindIssues(report), 'R-KIND-2');
    expect(hit.some((i) => i.message.includes('dimension-kind-conflict'))).toBe(true);
    expect(report.mechanical.passed).toBe(false);
  });

  test('路径1-混合：external + role 同样命中（写入方集合矛盾与 trigger 值域无关）', () => {
    const model = mkModel({
      states: [
        mkState('S1', 'initial', [mkDim('dimM2')]),
        mkState('S2', 'terminal'),
      ],
      transitions: [
        mkTransition('T1', 'S2', { triggerType: 'external', trigger: 'gw', affectsDimensions: ['dimM2'] }),
        mkTransition('T2', 'S2', { triggerType: 'role', trigger: 'r1', affectsDimensions: ['dimM2'] }),
      ],
    });
    const report = checkCompleteness(model);
    const hit = byRule(kindIssues(report), 'R-KIND-2');
    expect(hit.some((i) => i.message.includes('dimension-kind-conflict'))).toBe(true);
  });

  test('路径2-断言冲突：人写断言 declared vs 机械推导 observed ⇒ 报告含 R-KIND-2（dimension-kind-mismatch）且 verdict=fail', () => {
    const model = mkModel({
      states: [
        mkState('S1', 'initial', [mkDim('dimN', { kind: 'declared', kindSource: 'asserted' })]),
        mkState('S2', 'terminal'),
      ],
      transitions: [mkTransition('T1', 'S2', { triggerType: 'system', trigger: 'system', affectsDimensions: ['dimN'] })],
    });
    const report = checkCompleteness(model);
    const hit = byRule(kindIssues(report), 'R-KIND-2');
    expect(hit.some((i) => i.message.includes('dimension-kind-mismatch'))).toBe(true);
    expect(report.mechanical.passed).toBe(false);
  });

  test('反向：W(dim) 单一 + 断言与推导一致 ⇒ R-KIND-2 不命中（报告无 R-KIND error）', () => {
    const model = mkModel({
      states: [
        mkState('S1', 'initial', [mkDim('dimO', { kind: 'observed', kindSource: 'asserted' })]),
        mkState('S2', 'terminal'),
      ],
      transitions: [
        mkTransition('T1', 'S2', { triggerType: 'external', trigger: 'gw', affectsDimensions: ['dimO'] }),
      ],
    });
    const report = checkCompleteness(model);
    const hit = byRule(kindIssues(report), 'R-KIND-2');
    expect(hit).toHaveLength(0);
    expect(kindIssues(report).filter((i) => i.severity === 'error')).toHaveLength(0);
    expect(report.mechanical.passed).toBe(true);
  });
});

// ============================================================================
// S2-4 R-KIND-3（X3）：正反向各一
// ============================================================================

describe('S2-4 R-KIND-3（X3：observed 不变量必须 eventually_within + boundMs）', () => {
  test('正向：不变量涉及 observed 维度且无关联 timing ⇒ 报告含 R-KIND-3 且 verdict=fail', () => {
    const model = mkModel({
      states: [
        mkState('S1', 'initial', [mkDim('dimP')]),
        mkState('S2', 'terminal'),
      ],
      transitions: [mkTransition('T1', 'S2', { triggerType: 'system', trigger: 'system', affectsDimensions: ['dimP'] })],
      invariants: [mkInvariant('INV1', 'dimP > 0', ['S1'])],
      timing: [],
    });
    const report = checkCompleteness(model);
    const hit = byRule(kindIssues(report), 'R-KIND-3');
    expect(hit.length).toBeGreaterThan(0);
    expect(hit[0].severity).toBe('error');
    expect(hit[0].elementId).toBe('INV1');
    expect(hit[0].message).toContain('always');
    expect(report.mechanical.passed).toBe(false);
  });

  test('正向（缺 boundMs）：有关联 timing 但无 boundMs 同样命中', () => {
    const model = mkModel({
      states: [
        mkState('S1', 'initial', [mkDim('dimP2')]),
        mkState('S2', 'terminal'),
      ],
      transitions: [mkTransition('T1', 'S2', { triggerType: 'external', trigger: 'gw', affectsDimensions: ['dimP2'] })],
      invariants: [mkInvariant('INV1', 'dimP2 > 0')],
      timing: [mkTiming('TM1', 'INV1', 'INV1')], // 关联但无 boundMs
    });
    const report = checkCompleteness(model);
    const hit = byRule(kindIssues(report), 'R-KIND-3');
    expect(hit.length).toBeGreaterThan(0);
    expect(hit[0].message).toContain('boundMs');
  });

  test('反向：涉及 observed 维度但关联 timing 带 boundMs（eventually_within）⇒ R-KIND-3 不命中', () => {
    const model = mkModel({
      states: [
        mkState('S1', 'initial', [mkDim('dimQ')]),
        mkState('S2', 'terminal'),
      ],
      transitions: [mkTransition('T1', 'S2', { triggerType: 'system', trigger: 'system', affectsDimensions: ['dimQ'] })],
      invariants: [mkInvariant('INV1', 'dimQ > 0', ['S1'])],
      timing: [mkTiming('TM1', 'INV1', 'INV1', 5000)],
    });
    const report = checkCompleteness(model);
    const hit = byRule(kindIssues(report), 'R-KIND-3');
    expect(hit).toHaveLength(0);
    expect(kindIssues(report).filter((i) => i.severity === 'error')).toHaveLength(0);
    expect(report.mechanical.passed).toBe(true);
  });

  test('反向：不变量不涉及任何 observed 维度（表达式未引用且 scope 无 observed）⇒ 不命中', () => {
    const model = mkModel({
      states: [
        mkState('S1', 'initial', [mkDim('dimR', { kind: 'declared', kindSource: 'asserted' })]),
        mkState('S2', 'terminal'),
      ],
      transitions: [mkTransition('T1', 'S2', { triggerType: 'role', trigger: 'r1', affectsDimensions: ['dimR'] })],
      invariants: [mkInvariant('INV1', 'other > 0', ['S2'])],
      timing: [],
    });
    const report = checkCompleteness(model);
    expect(byRule(kindIssues(report), 'R-KIND-3')).toHaveLength(0);
  });
});

// ============================================================================
// S2-5 补充：死代码自检反向（规则被「绕过」则结果不同的另一侧）
// ============================================================================

describe('S2-5 死代码自检（反向侧：规则跳过合规情形则不误报）', () => {
  test('R-KIND-1 反向：observed + 仅 system/external 写入不命中；若规则按「存在任何写入」判则误报', () => {
    const model = mkModel({
      states: [
        mkState('S1', 'initial', [mkDim('dimC', { kind: 'observed', kindSource: 'asserted' })]),
        mkState('S2', 'terminal'),
      ],
      transitions: [mkTransition('T1', 'S2', { triggerType: 'system', trigger: 'system', affectsDimensions: ['dimC'] })],
    });
    const report = checkCompleteness(model);
    expect(byRule(kindIssues(report), 'R-KIND-1')).toHaveLength(0);
  });

  test('R-KIND-3 反向：observed 维度不变量 + boundMs 时序不命中；若规则把「涉及 observed 即报」则误报', () => {
    const model = mkModel({
      states: [
        mkState('S1', 'initial', [mkDim('dimD')]),
        mkState('S2', 'terminal'),
      ],
      transitions: [mkTransition('T1', 'S2', { triggerType: 'system', trigger: 'system', affectsDimensions: ['dimD'] })],
      invariants: [mkInvariant('INV1', 'dimD > 0')],
      timing: [mkTiming('TM1', 'INV1', 'INV1', 1000)],
    });
    const report = checkCompleteness(model);
    expect(byRule(kindIssues(report), 'R-KIND-3')).toHaveLength(0);
  });

  test('R-KIND-4 反向：角色有接口以它触发不命中；若规则把「声明即告警」则误报', () => {
    const model = mkModel({
      roles: [{ id: 'customer', name: '顾客' }],
      transitions: [mkTransition('T1', 'S2', { triggerType: 'role', trigger: 'customer', triggerRoleId: 'customer' })],
    });
    const report = checkCompleteness(model);
    expect(byRule(kindIssues(report), 'R-KIND-4')).toHaveLength(0);
  });
});

// ============================================================================
// S2-6 老模型零回归：legacy fixture + 两个演示实例
// ============================================================================

describe('S2-6 老模型零回归（新规则不得对老模型报硬失败，结果与 S0 一致）', () => {
  const legacy = parseProtocolContent(
    readFileSync(join(BASE_DIR, 'legacy-model.md'), 'utf-8')
  );
  const foodDelivery = parseProtocolContent(
    readFileSync(join(EXAMPLES_DIR, 'food-delivery', 'protocol', 'model.md'), 'utf-8')
  );
  const fulfillP1 = parseProtocolContent(
    readFileSync(join(EXAMPLES_DIR, 'fulfillment-payment', 'protocol', 'P1', 'model.md'), 'utf-8')
  );
  const fulfillP2 = parseProtocolContent(
    readFileSync(join(EXAMPLES_DIR, 'fulfillment-payment', 'protocol', 'P2', 'model.md'), 'utf-8')
  );

  const cases: Array<[string, SourceProtocolModel]> = [
    ['legacy-model.md（遗留协议）', legacy],
    ['examples/food-delivery（演示实例1）', foodDelivery],
    ['examples/fulfillment-payment/P1（演示实例2）', fulfillP1],
    ['examples/fulfillment-payment/P2（演示实例2）', fulfillP2],
  ];

  // 仅限定 S2 交付的 R-KIND-1~4（G7-S5a 新增的 R-KIND-5~9 属 S5 交付，其老模型
  // 行为由 tests/checker/kind-rules-s5.test.ts 的 S5 老模型零回归用例覆盖：
  // R-KIND-5/6/8/9 对老模型零输出，R-KIND-7 仅 warning 不阻断 mechanical.passed）。
  const kindIssuesS2 = (report: ReturnType<typeof checkCompleteness>) =>
    report.mechanical.referenceIssues.filter((i) => /\[R-KIND-[1-4]\//.test(i.message));

  for (const [label, model] of cases) {
    test(`${label}：R-KIND-1~4 零输出（与 S0 一致）`, () => {
      const report = checkCompleteness(model);
      const issues = kindIssuesS2(report);
      expect(issues).toHaveLength(0);
      // 新规则不得破坏机械层通过状态（无 error 级 R-KIND issue → passed 语义不变）
      expect(issues.filter((i) => i.severity === 'error')).toHaveLength(0);
    });
  }

  test('legacy-model.md：整体机械层结果与基线一致（无新增 error）', () => {
    const report = checkCompleteness(legacy);
    // S0 基线 legacy 机械层通过；R-KIND 组零输出后仍通过
    expect(report.mechanical.passed).toBe(true);
  });
});

// ============================================================================
// 注册表完整性（S2 规则注册方式）
// ============================================================================

describe('规则注册表（R-KIND 组，沿用 mcheck/rules.ts 组织方式）', () => {
  test('注册表含 R-KIND-1~15 且 ID 唯一', () => {
    const ids = KIND_RULES.map((r) => r.ruleId);
    expect(ids).toEqual([
      'R-KIND-1',
      'R-KIND-2',
      'R-KIND-3',
      'R-KIND-4',
      'R-KIND-5',
      'R-KIND-6',
      'R-KIND-7',
      'R-KIND-8',
      'R-KIND-9',
      'R-KIND-10',
      'R-KIND-11',
      'R-KIND-12',
      'R-KIND-13',
      'R-KIND-14',
      'R-KIND-15',
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('每条规则都有 description 与可执行的 check', () => {
    for (const rule of KIND_RULES) {
      expect(rule.description.length).toBeGreaterThan(0);
      expect(typeof rule.check).toBe('function');
    }
  });
});
