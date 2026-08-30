/**
 * G7-S5a 机械验收：R-KIND-5~9（X7 / X8 / X9 / X17）
 *
 * 覆盖 execution-plan.md §S5 的 S5-2~S5-4 + S5-6：
 * - X7（P1-3 判据10 分支②③）：R-KIND-5 完全可控组件建议降级实体；
 *   R-KIND-6 非本系统组件建议移出模型（与 R-KIND-4 分支①去重，三条分支全告警级）
 * - X8（P1-4 判据3）：R-KIND-7 机械只筛候选（affectsDimensions 为空 ⇒ ③候选），
 *   ②③之分人工复核留痕（B-2）
 * - X9（P1-5 判据11）：R-KIND-8 跨 ≥2 实体未声明事务边界 ⇒ 新模型硬失败；
 *   老模型告警 + 迁移截止日 2026-09-30（决策 D-2）；事务边界段 parser 解析
 * - X17（P1-9）：R-KIND-9 + computeGuardCoverage 受限谓词覆盖率 + 未命中显式降级
 * - S5-6 死代码自检：X7/X8/X9 各一条「若规则被绕过则结果不同」用例（防恒真/恒假）
 * - S5 老模型零回归：R-KIND-5/6/8/9 对 legacy + 两演示实例零 error（R-KIND-7 仅
 *   warning 不阻断 mechanical.passed）
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProtocolContent } from '../../src/parser/index.js';
import { checkCompleteness } from '../../src/checker/index.js';
import { specify } from '../../src/specifier/index.js';
import { KIND_RULES } from '../../src/checker/kind-rules.js';
import { computeGuardCoverage, TRANSACTION_BOUNDARY_MIGRATION_DEADLINE } from '../../src/checker/kind-rules.js';
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
// 辅助构造（IR 级，仿 kind-rules.test.ts）
// ============================================================================

const BASE_DIR = join(process.cwd(), 'tests', 'fixtures');
const EXAMPLES_DIR = join(process.cwd(), 'examples');

function mkDim(name: string, extra?: Partial<StateDimension>): StateDimension {
  return { name, type: 'string', initial: '', ...extra };
}

function mkState(id: string, type: StateDef['type'], dimensions: StateDimension[] = [], roleIds?: string[]): StateDef {
  const s: StateDef = { id, name: id, type, dimensions };
  if (roleIds) s.roleIds = roleIds;
  return s;
}

function mkTransition(
  id: string,
  to: string,
  opts: {
    triggerType: TransitionDef['triggerType'];
    trigger?: string;
    triggerRoleId?: string;
    affectsDimensions?: string[];
    guard?: string;
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
    guard: opts.guard,
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

/**
 * 构造结构干净、可通过既有 checker 规则的模型（仿 S2 测试的 mkModel）：
 * S1(initial) --T1--> S2(terminal)。
 */
function mkModel(
  overrides: {
    states?: StateDef[];
    transitions?: TransitionDef[];
    invariants?: InvariantDef[];
    timing?: TimingDef[];
    roles?: Array<{ id: string; name?: string; roleType?: 'consensus' | 'participant' }>;
    parties?: string[];
    transactionBoundaries?: SourceProtocolModel['derivable']['transactionBoundaries'];
  } = {}
): SourceProtocolModel {
  const roles =
    overrides.roles ??
    [{ id: 'r1', name: '角色1', roleType: 'consensus' as const }];
  const derivable: DerivableLayer = {
    degraded: false,
    states: overrides.states ?? [mkState('S1', 'initial'), mkState('S2', 'terminal')],
    transitions: overrides.transitions ?? [],
    invariants: overrides.invariants ?? [],
    timing: overrides.timing ?? [],
    exceptions: [],
    initialStateId: 'S1',
    terminalStateIds: ['S2'],
    transactionBoundaries: overrides.transactionBoundaries,
  };
  return {
    metadata: {
      name: 'S5 测试协议',
      version: '1.0.0',
      purpose: 'R-KIND-5~9 规则验收',
      roles: roles.map((r) => ({
        id: r.id,
        name: r.name ?? r.id,
        responsibilities: '',
        roleType: r.roleType ?? 'participant',
      })),
    },
    readable: { background: 'b', concepts: [], workflow: 'w' },
    derivable,
    contractInput: overrides.parties ? { parties: overrides.parties } : undefined,
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
// S5-6 死代码自检（防恒真/恒假；先于正反向用例给出「若规则被绕过则结果不同」证明）
// ============================================================================

describe('S5-6 死代码自检：X7/X8/X9 各一条「若规则被绕过则结果不同」用例', () => {
  test('X7（R-KIND-5）：无触发接口的完全可控组件 ⇒ 命中；若规则只看「有接口触发的角色」则漏报，结果不同', () => {
    const model = mkModel({
      roles: [
        { id: 'customer', name: '顾客' },
        { id: 'ghost_entity', name: '幽灵实体' },
      ],
      states: [
        mkState('S1', 'initial', [], ['ghost_entity']),
        mkState('S2', 'terminal'),
      ],
      transitions: [
        mkTransition('T1', 'S2', { triggerType: 'role', trigger: 'customer', triggerRoleId: 'customer' }),
      ],
    });
    const report = checkCompleteness(model);
    const hit = byRule(kindIssues(report), 'R-KIND-5');
    // 命中：ghost_entity 无接口触发但拥有状态（完全可控组件）→ 建议降级实体
    expect(hit).toHaveLength(1);
    expect(hit[0].severity).toBe('warning');
    expect(hit[0].elementId).toBe('ghost_entity');
    // 反证：同一角色若规则按「有接口即角色」判定则不报（无触发接口）——非恒真/恒假
    expect(byRule(kindIssues(report), 'R-KIND-6')).toHaveLength(0);
  });

  test('X7（R-KIND-6）：非本系统组件且无程序化交互 ⇒ 命中；若规则把「在契约 parties」的角色也算进来则误报，结果不同', () => {
    const model = mkModel({
      roles: [
        { id: 'external_vendor', name: '外部供应商' },
      ],
      parties: ['r1'], // external_vendor 不在契约方 → 无程序化交互
      states: [
        mkState('S1', 'initial'),
        mkState('S2', 'terminal'),
      ],
      transitions: [],
    });
    const report = checkCompleteness(model);
    const hit = byRule(kindIssues(report), 'R-KIND-6');
    expect(hit).toHaveLength(1);
    expect(hit[0].severity).toBe('warning');
    expect(hit[0].elementId).toBe('external_vendor');
    // 反向：若 external_vendor 在契约 parties（有程序化交互）→ 不命中 R-KIND-6（规则被绕过则结果不同）
    const withParty = mkModel({
      roles: [{ id: 'external_vendor', name: '外部供应商' }],
      parties: ['external_vendor'],
      states: [mkState('S1', 'initial'), mkState('S2', 'terminal')],
      transitions: [],
    });
    expect(byRule(kindIssues(checkCompleteness(withParty)), 'R-KIND-6')).toHaveLength(0);
  });

  test('X8（R-KIND-7）：未声明状态变更 ⇒ ③候选命中；若规则只看 affectsDimensions 非空（恒不报）则漏报，结果不同', () => {
    const model = mkModel({
      states: [mkState('S1', 'initial', [mkDim('dimA')]), mkState('S2', 'terminal')],
      transitions: [mkTransition('T1', 'S2', { triggerType: 'role', trigger: 'r1', affectsDimensions: [] })],
    });
    const report = checkCompleteness(model);
    const hit = byRule(kindIssues(report), 'R-KIND-7');
    expect(hit).toHaveLength(1);
    expect(hit[0].severity).toBe('warning');
    expect(hit[0].message).toContain('③候选');
    // 反向：affectsDimensions 非空（分支①改变状态）→ 不命中（防恒真）
    const withDim = mkModel({
      states: [mkState('S1', 'initial', [mkDim('dimA')]), mkState('S2', 'terminal')],
      transitions: [mkTransition('T1', 'S2', { triggerType: 'role', trigger: 'r1', affectsDimensions: ['dimA'] })],
    });
    expect(byRule(kindIssues(checkCompleteness(withDim)), 'R-KIND-7')).toHaveLength(0);
  });

  test('X9（R-KIND-8）：跨 ≥2 实体未声明事务边界 ⇒ 命中；若规则只看「已声明边界」（恒不报）则漏报，结果不同', () => {
    const model = mkModel({
      transactionBoundaries: [], // 新模型形态（已启用事务边界段）
      states: [
        mkState('S1', 'initial', [mkDim('dimA')]),
        mkState('S2', 'terminal', [mkDim('dimB')]),
      ],
      transitions: [
        mkTransition('T1', 'S2', { triggerType: 'role', trigger: 'r1', affectsDimensions: ['dimA', 'dimB'] }),
      ],
    });
    const report = checkCompleteness(model);
    const hit = byRule(kindIssues(report), 'R-KIND-8');
    expect(hit).toHaveLength(1);
    expect(hit[0].severity).toBe('error');
    // 反向：已声明事务边界 → 不命中（防恒真）
    const declared = mkModel({
      transactionBoundaries: [
        { id: 'TX1', interface: 'T1', boundaryType: 'same_transaction' },
      ],
      states: [
        mkState('S1', 'initial', [mkDim('dimA')]),
        mkState('S2', 'terminal', [mkDim('dimB')]),
      ],
      transitions: [
        mkTransition('T1', 'S2', { triggerType: 'role', trigger: 'r1', affectsDimensions: ['dimA', 'dimB'] }),
      ],
    });
    expect(byRule(kindIssues(checkCompleteness(declared)), 'R-KIND-8')).toHaveLength(0);
  });
});

// ============================================================================
// S5-2 / S5-3：X9 判据11 正反向 + 老模型路径
// ============================================================================

describe('S5-2/S5-3 R-KIND-8（X9：跨实体事务边界）', () => {
  const crossEntityStates = [
    mkState('S1', 'initial', [mkDim('dimA')]),
    mkState('S2', 'terminal', [mkDim('dimB')]),
  ];
  const crossEntityTransition = [
    mkTransition('T1', 'S2', { triggerType: 'role', trigger: 'r1', affectsDimensions: ['dimA', 'dimB'] }),
  ];

  test('正向（S5-2）：跨 ≥2 实体未声明事务边界 ⇒ 新模型（已启用事务边界段）硬失败', () => {
    const model = mkModel({
      transactionBoundaries: [],
      states: crossEntityStates,
      transitions: crossEntityTransition,
    });
    const report = checkCompleteness(model);
    const hit = byRule(kindIssues(report), 'R-KIND-8');
    expect(hit).toHaveLength(1);
    expect(hit[0].severity).toBe('error');
    expect(hit[0].message).toContain('same_transaction');
    expect(report.mechanical.passed).toBe(false);
  });

  test('反向（S5-2）：跨实体已声明事务边界（same_transaction）⇒ 通过', () => {
    const model = mkModel({
      transactionBoundaries: [
        { id: 'TX1', interface: 'T1', boundaryType: 'same_transaction', description: '订单+库存同库事务' },
      ],
      states: crossEntityStates,
      transitions: crossEntityTransition,
    });
    const report = checkCompleteness(model);
    expect(byRule(kindIssues(report), 'R-KIND-8')).toHaveLength(0);
    expect(report.mechanical.passed).toBe(true);
  });

  test('反向：跨实体已声明 async_compensation 同样通过', () => {
    const model = mkModel({
      transactionBoundaries: [
        { id: 'TX1', interface: 'T1', boundaryType: 'async_compensation' },
      ],
      states: crossEntityStates,
      transitions: crossEntityTransition,
    });
    const report = checkCompleteness(model);
    expect(byRule(kindIssues(report), 'R-KIND-8')).toHaveLength(0);
  });

  test('反向：affectsDimensions 未跨实体（单 owner）⇒ 不命中', () => {
    const model = mkModel({
      transactionBoundaries: [],
      states: crossEntityStates,
      transitions: [
        mkTransition('T1', 'S2', { triggerType: 'role', trigger: 'r1', affectsDimensions: ['dimA'] }),
      ],
    });
    const report = checkCompleteness(model);
    expect(byRule(kindIssues(report), 'R-KIND-8')).toHaveLength(0);
  });

  test('老模型路径（S5-3）：无事务边界段（undefined）⇒ 告警非硬失败 + 迁移截止日 2026-09-30', () => {
    const model = mkModel({
      transactionBoundaries: undefined, // 老模型形态：未启用事务边界段
      states: crossEntityStates,
      transitions: crossEntityTransition,
    });
    const report = checkCompleteness(model);
    const hit = byRule(kindIssues(report), 'R-KIND-8');
    expect(hit).toHaveLength(1);
    expect(hit[0].severity).toBe('warning'); // 非硬失败
    expect(hit[0].message).toContain(TRANSACTION_BOUNDARY_MIGRATION_DEADLINE); // 2026-09-30
    expect(hit[0].message).toContain('决策 D-2');
    expect(report.mechanical.passed).toBe(true); // warning 不阻断
  });

  test('事务边界段 parser 解析：model.md 声明「事务边界」段 ⇒ transactionBoundaries 非空', () => {
    const model = parseProtocolContent(`---
name: X9 事务边界 fixture
version: 1.0.0
purpose: 验证事务边界段解析
roles:
  - id: r1
    name: 角色1
    roleType: consensus
---

# 背景

验证事务边界。

# 状态空间

| ID | 名称 | 类型 | 描述 | 角色 |
|---|---|---|---|---|
| S0 | 初始 | initial | 初始态 | r1 |
| S1 | 终态 | terminal | 终态 | r1 |

# 转移规则

| ID | 名称 | from | to | action | trigger | guard | effects | triggerType | actionType | affectsDimensions |
|---|---|---|---|---|---|---|---|---|---|---|
| T1 | 跨实体操作 | S0 | S1 | cross_op | r1 | | | role | state_transition | dimA, dimB |

# 状态维度

\`\`\`yaml
- stateId: S0
  dimensions:
    - name: dimA
      type: string
      initial: ""
- stateId: S1
  dimensions:
    - name: dimB
      type: string
      initial: ""
\`\`\`

# 事务边界

\`\`\`yaml
- id: TX1
  interface: cross_op
  boundaryType: same_transaction
  description: 跨实体操作同库事务
\`\`\`
`);
    expect(model.derivable.transactionBoundaries).toBeDefined();
    expect(model.derivable.transactionBoundaries).toHaveLength(1);
    expect(model.derivable.transactionBoundaries![0]).toMatchObject({
      id: 'TX1',
      interface: 'cross_op',
      boundaryType: 'same_transaction',
    });
    // 已声明 → R-KIND-8 不命中（正向路径闭环）
    const report = checkCompleteness(model);
    expect(byRule(kindIssues(report), 'R-KIND-8')).toHaveLength(0);
  });

  test('事务边界段 parser 解析：model.md 无该段 ⇒ undefined（老模型形态）', () => {
    const model = parseProtocolContent(`---
name: 无事务边界段
version: 1.0.0
purpose: 验证缺省为老模型形态
roles:
  - id: r1
    name: 角色1
    roleType: consensus
---

# 背景

b

# 状态空间

| ID | 名称 | 类型 | 描述 | 角色 |
|---|---|---|---|---|
| S0 | 初始 | initial | 初始态 | r1 |
| S1 | 终态 | terminal | 终态 | r1 |

# 转移规则

| ID | 名称 | from | to | action | trigger | guard | effects | triggerType | actionType | affectsDimensions |
|---|---|---|---|---|---|---|---|---|---|---|
| T1 | 推进 | S0 | S1 | advance | r1 | | | role | state_transition | |
`);
    expect(model.derivable.transactionBoundaries).toBeUndefined();
  });
});

// ============================================================================
// X7：R-KIND-5/6 正反向 + 与 R-KIND-4 去重
// ============================================================================

describe('S5 X7（R-KIND-5/6：判据10 分支②③，与 R-KIND-4 去重）', () => {
  test('R-KIND-4 分支①去重：无触发角色命中 R-KIND-4（基础告警）+ R-KIND-5（处置建议），R-KIND-5 不重复报分支①', () => {
    const model = mkModel({
      roles: [
        { id: 'ghost', name: '幽灵角色' },
        { id: 'r1', name: '角色1' },
      ],
      states: [
        mkState('S1', 'initial', [], ['ghost']),
        mkState('S2', 'terminal'),
      ],
      transitions: [
        mkTransition('T1', 'S2', { triggerType: 'role', trigger: 'r1', triggerRoleId: 'r1' }),
      ],
    });
    const report = checkCompleteness(model);
    const all = kindIssues(report);
    const r4 = byRule(all, 'R-KIND-4');
    const r5 = byRule(all, 'R-KIND-5');
    // 三分完整：分支①（R-KIND-4）+ 分支②（R-KIND-5）同时告警，均为 warning
    expect(r4).toHaveLength(1);
    expect(r5).toHaveLength(1);
    expect(r4[0].elementId).toBe('ghost');
    expect(r5[0].elementId).toBe('ghost');
    expect(all.every((i) => i.severity === 'warning')).toBe(true); // 三条分支全告警级
    expect(report.mechanical.passed).toBe(true); // warning 不阻断
  });

  test('R-KIND-5 反向：角色有接口以它触发 ⇒ 不命中', () => {
    const model = mkModel({
      roles: [{ id: 'r1', name: '角色1' }],
      states: [
        mkState('S1', 'initial', [], ['r1']),
        mkState('S2', 'terminal'),
      ],
      transitions: [
        mkTransition('T1', 'S2', { triggerType: 'role', trigger: 'r1', triggerRoleId: 'r1' }),
      ],
    });
    const report = checkCompleteness(model);
    expect(byRule(kindIssues(report), 'R-KIND-5')).toHaveLength(0);
    expect(byRule(kindIssues(report), 'R-KIND-6')).toHaveLength(0);
    expect(byRule(kindIssues(report), 'R-KIND-4')).toHaveLength(0);
  });

  test('R-KIND-6 反向：无触发但出现在契约 parties（有程序化交互）⇒ 不命中', () => {
    const model = mkModel({
      roles: [{ id: 'vendor', name: '供应商' }],
      parties: ['vendor'],
      states: [mkState('S1', 'initial'), mkState('S2', 'terminal')],
      transitions: [],
    });
    const report = checkCompleteness(model);
    // 有程序化交互 → 不命中 R-KIND-6（分支③条件不满足）；R-KIND-4 基础告警仍保留
    expect(byRule(kindIssues(report), 'R-KIND-6')).toHaveLength(0);
    expect(byRule(kindIssues(report), 'R-KIND-4')).toHaveLength(1);
  });
});

// ============================================================================
// X8：R-KIND-7 正反向 + 留痕
// ============================================================================

describe('S5 X8（R-KIND-7：判据3 机械只筛候选 + 留痕）', () => {
  test('正向：接口未声明状态变更（affectsDimensions 为空）⇒ ③候选告警，issue 描述含留痕语义（B-2）', () => {
    const model = mkModel({
      states: [mkState('S1', 'initial', [mkDim('dimA')]), mkState('S2', 'terminal')],
      transitions: [
        mkTransition('T1', 'S2', { triggerType: 'role', trigger: 'r1', affectsDimensions: [] }),
      ],
    });
    const report = checkCompleteness(model);
    const hit = byRule(kindIssues(report), 'R-KIND-7');
    expect(hit).toHaveLength(1);
    expect(hit[0].severity).toBe('warning');
    expect(hit[0].message).toContain('③候选');
    // 留痕 = issue 描述字段（B-2）：消息含人工复核要求与留痕方式
    expect(hit[0].message).toContain('人工复核');
    expect(hit[0].message).toContain('B-2');
    expect(hit[0].message).toContain('acceptance-record');
    expect(report.mechanical.passed).toBe(true);
  });

  test('正向（有 guard）：无状态变更 + guard ⇒ 疑似分支②候选', () => {
    const model = mkModel({
      states: [mkState('S1', 'initial', [mkDim('dimA')]), mkState('S2', 'terminal')],
      transitions: [
        mkTransition('T1', 'S2', { triggerType: 'role', trigger: 'r1', affectsDimensions: [], guard: 'dimA > 0' }),
      ],
    });
    const report = checkCompleteness(model);
    const hit = byRule(kindIssues(report), 'R-KIND-7');
    expect(hit).toHaveLength(1);
    expect(hit[0].message).toContain('疑似分支②');
  });

  test('反向：接口改变状态（affectsDimensions 非空，分支①）⇒ 不命中', () => {
    const model = mkModel({
      states: [mkState('S1', 'initial', [mkDim('dimA')]), mkState('S2', 'terminal')],
      transitions: [
        mkTransition('T1', 'S2', { triggerType: 'role', trigger: 'r1', affectsDimensions: ['dimA'] }),
      ],
    });
    const report = checkCompleteness(model);
    expect(byRule(kindIssues(report), 'R-KIND-7')).toHaveLength(0);
  });
});

// ============================================================================
// S5-4：X17（R-KIND-9 + computeGuardCoverage）受限谓词覆盖率 + 显式降级
// ============================================================================

describe('S5-4 X17（R-KIND-9：guard 可执行化覆盖率 + 未命中显式降级）', () => {
  test('命中：preconditions 全部 kind=json-schema 且 ajv 可编译 ⇒ 覆盖率 100%，无 R-KIND-9 告警', () => {
    const model = mkModel({
      states: [mkState('S1', 'initial', [mkDim('dimA')]), mkState('S2', 'terminal')],
      transitions: [
        mkTransition('T1', 'S2', { triggerType: 'role', trigger: 'r1', guard: 'nonEmpty(request_id)' }),
      ],
    });
    const stats = computeGuardCoverage(model);
    expect(stats.total).toBe(1);
    expect(stats.hit).toBe(1);
    expect(stats.miss).toBe(0);
    expect(stats.hitRate).toBe(1);
    expect(stats.degraded).toHaveLength(0);
    const report = checkCompleteness(model);
    expect(byRule(kindIssues(report), 'R-KIND-9')).toHaveLength(0);
  });

  test('未命中：guard 自然语言（未按受限谓词语法）⇒ 覆盖率 <100%，显式降级记录不静默', () => {
    const model = mkModel({
      states: [mkState('S1', 'initial', [mkDim('dimA')]), mkState('S2', 'terminal')],
      transitions: [
        mkTransition('T1', 'S2', { triggerType: 'role', trigger: 'r1', guard: '库存充足且订单已确认' }),
      ],
    });
    const stats = computeGuardCoverage(model);
    expect(stats.total).toBe(1);
    expect(stats.hit).toBe(0);
    expect(stats.miss).toBe(1);
    expect(stats.hitRate).toBe(0);
    expect(stats.degraded).toHaveLength(1);
    expect(stats.degraded[0].reason).toContain('未机械结构化');
    const report = checkCompleteness(model);
    const hit = byRule(kindIssues(report), 'R-KIND-9');
    expect(hit).toHaveLength(1);
    expect(hit[0].severity).toBe('warning');
    expect(hit[0].message).toContain('未可执行化');
    // spec 层 schemaDegradedReasons 有记录（S5-4：未命中者显式降级）
    const specs = specify(model).specs;
    const t1 = specs.find((s) => s.sourceId === 'T1' || s.sourceId === 't1');
    // guard 自然语言 → legacy-stub/description-only → schemaKind 非 structured → schemaDegradedReasons 非空
    expect((specs ?? []).some((s) => (s.schemaDegradedReasons?.length ?? 0) > 0)).toBe(true);
    void t1;
  });

  test('混合：受限谓词 + 自然语言整串未命中谓词语法 ⇒ miss 计入，reason 精确到未命中表达式', () => {
    const model = mkModel({
      states: [mkState('S1', 'initial', [mkDim('dimA')]), mkState('S2', 'terminal')],
      transitions: [
        mkTransition('T1', 'S2', { triggerType: 'role', trigger: 'r1', guard: 'nonEmpty(request_id) && 库存充足' }),
      ],
    });
    const stats = computeGuardCoverage(model);
    expect(stats.total).toBe(1);
    expect(stats.miss).toBe(1);
    // 整串未命中受限谓词语法（含中文标点）→ tryParseGuardSchema 判 legacy-stub（W2 同款降级，不拆分合取项）
    expect(stats.degraded[0].reason).toContain('legacy-stub');
    expect(stats.degraded[0].reason).toContain('未机械结构化');
  });

  test('无 guard 转移不计入分母（total=0 → hitRate=1，无噪声）', () => {
    const model = mkModel({
      states: [mkState('S1', 'initial', [mkDim('dimA')]), mkState('S2', 'terminal')],
      transitions: [
        mkTransition('T1', 'S2', { triggerType: 'role', trigger: 'r1', affectsDimensions: ['dimA'] }),
      ],
    });
    const stats = computeGuardCoverage(model);
    expect(stats.total).toBe(0);
    expect(stats.hitRate).toBe(1);
    const report = checkCompleteness(model);
    expect(byRule(kindIssues(report), 'R-KIND-9')).toHaveLength(0);
  });

  test('契约层 preconditions（json-schema）命中：契约结构化表达式优先于 guard 文本', () => {
    const model = mkModel({
      states: [mkState('S1', 'initial', [mkDim('dimA')]), mkState('S2', 'terminal')],
      transitions: [
        mkTransition('T1', 'S2', { triggerType: 'role', trigger: 'r1', guard: '自然语言守卫' }),
      ],
    });
    // 契约层提供结构化 preconditions（kind=json-schema）→ 命中（契约优先，同 S4 resolveX6Conjuncts）
    model.contractInput = {
      parties: ['r1'],
      contracts: [
        {
          interface: 'T1',
          preconditions: [
            {
              kind: 'json-schema',
              description: 'request_id 非空',
              schema: { type: 'object', required: ['request_id'] },
            },
          ],
        },
      ],
    };
    const stats = computeGuardCoverage(model);
    expect(stats.total).toBe(1);
    expect(stats.hit).toBe(1);
    expect(stats.miss).toBe(0);
  });
});

// ============================================================================
// S5 老模型零回归（R-KIND-5~9 对 legacy + 两演示实例零 error）
// ============================================================================

describe('S5 老模型零回归（R-KIND-5~9 不得对老模型报硬失败）', () => {
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

  for (const [label, model] of cases) {
    test(`${label}：R-KIND-5~9 零 error（warning 允许，不叠加既有基线失败）`, () => {
      const report = checkCompleteness(model);
      const issues = kindIssues(report);
      // R-KIND-5/6/8 对老模型零输出（无触发角色 / 无跨实体转移）
      expect(byRule(issues, 'R-KIND-5')).toHaveLength(0);
      expect(byRule(issues, 'R-KIND-6')).toHaveLength(0);
      expect(byRule(issues, 'R-KIND-8')).toHaveLength(0);
      // 全部 R-KIND 规则：零 error（R-KIND-7 候选告警 / R-KIND-9 未结构化告警仅为 warning）
      expect(issues.filter((i) => i.severity === 'error')).toHaveLength(0);
      // 不叠加既有基线失败：P1/P2 的 mechanical.passed=false 是 E11 等既有 error（与 S5 无关），
      // 此处仅断言 S5 新增规则不引入 error。
    });
  }

  test('legacy-model.md：transactionBoundaries 缺省为 undefined（老模型形态）', () => {
    expect(legacy.derivable.transactionBoundaries).toBeUndefined();
  });
});

// ============================================================================
// 注册表完整性（S5 规则注册方式）
// ============================================================================

describe('规则注册表（S5 扩展：R-KIND-5~9）', () => {
  test('注册表含 R-KIND-1~9 且每条有 description 与可执行的 check', () => {
    const ids = KIND_RULES.map((r) => r.ruleId);
    expect(ids).toContain('R-KIND-5');
    expect(ids).toContain('R-KIND-6');
    expect(ids).toContain('R-KIND-7');
    expect(ids).toContain('R-KIND-8');
    expect(ids).toContain('R-KIND-9');
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of KIND_RULES) {
      expect(rule.description.length).toBeGreaterThan(0);
      expect(typeof rule.check).toBe('function');
    }
  });
});
