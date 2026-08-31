/**
 * R1b：六张清单 checker 适配验收测试
 *
 * 覆盖（机械验收 R1b-2 / R1b-3 / R1b-4）：
 * - 判据 5：六张清单操作 guard 引用的「实体.维度」必须在实体维度段存在（悬空硬失败）；
 *   正样本零误报（guard 引用全在实体维度段）
 * - 判据 7（R-KIND-1）：role 触发操作写 observed 维度 ⇒ 硬失败（六张清单形态，无 transitions）
 * - 判据 10（R-KIND-4）：六张清单角色触发判定数据源 = 操作段（有触发不误报；无触发告警）
 * - 判据 11（R-KIND-8）：操作 target 多实体未声明事务边界 ⇒ 新模型硬失败；
 *   已声明 ⇒ 通过；老模型形态 ⇒ 告警不阻断
 * - 判据 12（R-KIND-3）：依赖 observed 维度的不变量无 boundMs ⇒ 硬失败；带 boundMs ⇒ 通过
 * - R1b-4 死代码自检：R-KIND-1 / R-KIND-8 六张清单路径各一条「若规则被绕过则结果不同」
 * - R1b-3 老实例零回归：food-delivery / fulfillment-payment 检查结果与 R1a 之前一致
 *   （R-KIND 组零新增 error；全量 jest 套件兜底）
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProtocolContent } from '../../src/parser/index.js';
import { checkCompleteness } from '../../src/checker/index.js';
import type {
  SourceProtocolModel,
  DerivableLayer,
  StateDimension,
  OperationDef,
  OperationTriggerType,
  DimensionChange,
  InvariantDef,
  TimingDef,
  TransactionBoundaryDef,
} from '../../src/model/types.js';

// ============================================================================
// 辅助构造（IR 级，仿 kind-rules.test.ts / kind-rules-s5.test.ts）
// ============================================================================

const EXAMPLES_DIR = join(process.cwd(), 'examples');

function mkDim(name: string, kind: 'declared' | 'observed'): StateDimension {
  return { name, type: 'string', initial: '', kind, kindSource: 'asserted' };
}

function mkOperation(opts: {
  id: string;
  name: string;
  triggerRoleId: string;
  target: string;
  targetEntities: string[];
  guard?: string;
  change: string;
  changes: DimensionChange[];
  triggerType: OperationTriggerType;
}): OperationDef {
  return {
    id: opts.id,
    name: opts.name,
    triggerRoleId: opts.triggerRoleId,
    target: opts.target,
    targetEntities: opts.targetEntities,
    guard: opts.guard,
    change: opts.change,
    changes: opts.changes,
    affectsDimensions: Array.from(
      new Set(opts.changes.map((c) => c.dimension).filter((d) => d.length > 0))
    ),
    sideEffects: [],
    triggerType: opts.triggerType,
  };
}

function mkInvariant(id: string, expression: string): InvariantDef {
  return {
    id,
    name: id,
    expression,
    declaredBy: 'publisher',
    invariantClass: 'intra_protocol',
  };
}

function mkTiming(id: string, invId: string, boundMs?: number): TimingDef {
  return { id, name: id, type: 'deadline', source: invId, target: invId, boundMs };
}

/**
 * 六张清单形态模型（正样本，自洽）：
 * - 无状态空间/转移规则段（状态机为兼容层，六张清单形态不声明）；
 * - 「操作」段：OP1（role，资源＋认领码 跨实体）、OP2（scheduled，写 observed 连接状态）；
 * - 「实体维度」段投影为 subsidiaryEntities（kind 断言）：
 *   资源.归属状态=declared、认领码.兑付状态=declared、短时映射实例.连接状态=observed。
 */
function mkSixListModel(
  overrides: {
    operations?: OperationDef[];
    subsidiaryEntities?: DerivableLayer['subsidiaryEntities'];
    invariants?: InvariantDef[];
    timing?: TimingDef[];
    roles?: Array<{ id: string; name?: string; roleType?: 'consensus' | 'participant' }>;
    transactionBoundaries?: TransactionBoundaryDef[];
  } = {}
): SourceProtocolModel {
  const roles =
    overrides.roles ??
    [
      { id: 'publisher', name: '发布端', roleType: 'consensus' as const },
      { id: 'system', name: '系统自身', roleType: 'consensus' as const },
    ];
  const operations =
    overrides.operations ??
    [
      mkOperation({
        id: 'OP1',
        name: '匿名发布资源',
        triggerRoleId: 'publisher',
        target: '资源 ＋ 认领码',
        targetEntities: ['资源', '认领码'],
        guard: '发布形态合法',
        change: '资源.归属状态=无归属 ∧ 认领码.兑付状态=未使用',
        changes: [
          { entity: '资源', dimension: '归属状态', value: '无归属' },
          { entity: '认领码', dimension: '兑付状态', value: '未使用' },
        ],
        triggerType: 'role',
      }),
      mkOperation({
        id: 'OP2',
        name: '心跳超时判定',
        triggerRoleId: 'system',
        target: '短时映射实例',
        targetEntities: ['短时映射实例'],
        guard: '连接状态=在线 ∧ 短时映射实例.连接状态=在线',
        change: '连接状态=离线',
        changes: [{ entity: '', dimension: '连接状态', value: '离线' }],
        triggerType: 'scheduled',
      }),
    ];
  const subsidiaryEntities =
    overrides.subsidiaryEntities ??
    [
      {
        id: '资源',
        name: '资源',
        belongsTo: '资源',
        instanceKey: '资源.id',
        lifecycleDependency: '六张清单形态',
        cascadeRules: ['实体维度随实体生命周期变更'],
        stateSpace: { dimensions: [mkDim('归属状态', 'declared')] },
        invariants: [],
      },
      {
        id: '认领码',
        name: '认领码',
        belongsTo: '认领码',
        instanceKey: '认领码.id',
        lifecycleDependency: '六张清单形态',
        cascadeRules: ['实体维度随实体生命周期变更'],
        stateSpace: { dimensions: [mkDim('兑付状态', 'declared')] },
        invariants: [],
      },
      {
        id: '短时映射实例',
        name: '短时映射实例',
        belongsTo: '短时映射实例',
        instanceKey: '短时映射实例.id',
        lifecycleDependency: '六张清单形态',
        cascadeRules: ['实体维度随实体生命周期变更'],
        stateSpace: { dimensions: [mkDim('连接状态', 'observed')] },
        invariants: [],
      },
    ];
  const derivable: DerivableLayer = {
    degraded: false,
    states: [],
    transitions: [],
    invariants: overrides.invariants ?? [],
    timing: overrides.timing ?? [],
    exceptions: [],
    terminalStateIds: [],
    operations,
    subsidiaryEntities,
    transactionBoundaries: overrides.transactionBoundaries,
  };
  return {
    metadata: {
      name: 'R1b 六张清单测试协议',
      version: '1.0.0',
      purpose: 'R-KIND 规则六张清单形态验收',
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

function byMessage(issues: ReturnType<typeof kindIssues>, text: string) {
  return issues.filter((i) => i.message.includes(text));
}

// ============================================================================
// R1b-4 死代码自检（防恒真/恒假；六张清单适配路径至少一条「若被绕过则结果不同」）
// ============================================================================

describe('R1b-4 死代码自检：六张清单适配路径存在「若规则被绕过则结果不同」用例', () => {
  test('R-KIND-1：六张清单 role 操作写 observed ⇒ 命中；若规则数据源仍只看 transitions（六张清单无 transitions）则恒不报，结果不同', () => {
    const badOp = mkOperation({
      id: 'OP3',
      name: '伪造心跳',
      triggerRoleId: 'publisher',
      target: '短时映射实例',
      targetEntities: ['短时映射实例'],
      change: '连接状态=在线',
      changes: [{ entity: '', dimension: '连接状态', value: '在线' }],
      triggerType: 'role',
    });
    const model = mkSixListModel({ operations: [badOp] });
    const report = checkCompleteness(model);
    const hit = byRule(kindIssues(report), 'R-KIND-1');
    // 命中：kind=observed（断言）被 role 操作写入
    expect(hit.length).toBeGreaterThan(0);
    expect(hit[0].severity).toBe('error');
    // 反证：该模型无任何 transitions，R1b 前的数据源（仅 transitions）永不命中——
    // 证明六张清单形态必须走统一接口视图（transitions ∪ operations），非恒真/恒假
    expect(model.derivable.transitions).toHaveLength(0);
    expect(report.mechanical.passed).toBe(false);
  });

  test('R-KIND-8：六张清单 target 多实体未声明事务边界（新模型）⇒ 命中；若规则只遍历 transitions 则不报，结果不同', () => {
    const model = mkSixListModel({ transactionBoundaries: [] });
    const report = checkCompleteness(model);
    const hit = byRule(kindIssues(report), 'R-KIND-8');
    // 命中：OP1 target 资源＋认领码 跨 2 实体，新模型形态（已启用事务边界段）未声明 → 硬失败
    expect(hit.length).toBeGreaterThan(0);
    expect(hit.some((i) => i.severity === 'error' && i.elementId === 'OP1')).toBe(true);
    // 反证：该模型无 transitions，R1b 前只遍历 transitions 的判定恒不命中
    expect(model.derivable.transitions).toHaveLength(0);
    expect(report.mechanical.passed).toBe(false);
  });
});

// ============================================================================
// 判据 5：六张清单 guard 引用维度必须在实体维度段存在（悬空硬失败）
// ============================================================================

describe('判据 5（六张清单 guard 维度引用存在性）', () => {
  test('正向：guard 引用的维度全在实体维度段 ⇒ 零 error、零误报', () => {
    const report = checkCompleteness(mkSixListModel());
    const hits = byMessage(
      report.mechanical.referenceIssues,
      '判据5：guard 引用的属性必须升为维度'
    );
    expect(hits).toHaveLength(0);
    expect(report.mechanical.passed).toBe(true);
  });

  test('反向：guard 引用未声明的维度（资源.形态）⇒ 硬失败', () => {
    const op1 = mkOperation({
      id: 'OP1',
      name: '匿名发布资源',
      triggerRoleId: 'publisher',
      target: '资源 ＋ 认领码',
      targetEntities: ['资源', '认领码'],
      guard: '资源.形态=短时内网映射',
      change: '资源.归属状态=无归属 ∧ 认领码.兑付状态=未使用',
      changes: [
        { entity: '资源', dimension: '归属状态', value: '无归属' },
        { entity: '认领码', dimension: '兑付状态', value: '未使用' },
      ],
      triggerType: 'role',
    });
    const report = checkCompleteness(mkSixListModel({ operations: [op1] }));
    const hits = byMessage(
      report.mechanical.referenceIssues,
      '引用维度 "形态"，但该维度未在「实体维度」段声明'
    );
    // 「形态」未在实体维度段（仅 归属状态/兑付状态/连接状态）→ 悬空硬失败
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe('error');
    expect(hits[0].elementId).toBe('OP1');
    expect(report.mechanical.passed).toBe(false);
  });
});

// ============================================================================
// 判据 7（R-KIND-1）：observed 维度不得被 role 触发操作写入
// ============================================================================

describe('判据 7（R-KIND-1，六张清单形态）', () => {
  test('反向：role 操作写 observed 维度 ⇒ 硬失败', () => {
    const badOp = mkOperation({
      id: 'OP3',
      name: '伪造心跳',
      triggerRoleId: 'publisher',
      target: '短时映射实例',
      targetEntities: ['短时映射实例'],
      change: '连接状态=在线',
      changes: [{ entity: '', dimension: '连接状态', value: '在线' }],
      triggerType: 'role',
    });
    const report = checkCompleteness(mkSixListModel({ operations: [badOp] }));
    const hit = byRule(kindIssues(report), 'R-KIND-1');
    expect(hit.length).toBeGreaterThan(0);
    expect(hit[0].severity).toBe('error');
    expect(hit[0].elementId).toBe('连接状态');
    expect(report.mechanical.passed).toBe(false);
  });

  test('正向：observed 维度只被事实侧（scheduled）写入 ⇒ R-KIND-1 零命中', () => {
    const report = checkCompleteness(mkSixListModel());
    expect(byRule(kindIssues(report), 'R-KIND-1')).toHaveLength(0);
    expect(byRule(kindIssues(report), 'R-KIND-2')).toHaveLength(0);
  });
});

// ============================================================================
// 判据 10（R-KIND-4）：六张清单角色触发判定（数据源 = 操作段）
// ============================================================================

describe('判据 10（R-KIND-4，六张清单形态）', () => {
  test('有触发操作的角色不误报；无触发操作的角色告警', () => {
    const roles = [
      { id: 'publisher', name: '发布端', roleType: 'consensus' as const },
      { id: 'system', name: '系统自身', roleType: 'consensus' as const },
      { id: 'ghost', name: '幽灵角色', roleType: 'participant' as const },
    ];
    const report = checkCompleteness(mkSixListModel({ roles }));
    const hit = byRule(kindIssues(report), 'R-KIND-4');
    // publisher（OP1）、system（OP2）有操作触发 → 不告警；ghost 无触发 → 告警
    expect(hit).toHaveLength(1);
    expect(hit[0].elementId).toBe('ghost');
    expect(hit[0].severity).toBe('warning');
    // 六张清单形态（无 transitions）下角色触发判定必须来自操作段——publisher/system 不被误报
    expect(hit.some((i) => i.elementId === 'publisher' || i.elementId === 'system')).toBe(false);
  });
});

// ============================================================================
// 判据 11（R-KIND-8）：操作 target 多实体未声明事务边界
// ============================================================================

describe('判据 11（R-KIND-8，六张清单形态）', () => {
  test('反向-新模型：target 多实体未声明事务边界 ⇒ 硬失败', () => {
    const report = checkCompleteness(mkSixListModel({ transactionBoundaries: [] }));
    const hit = byRule(kindIssues(report), 'R-KIND-8');
    expect(hit.some((i) => i.severity === 'error' && i.elementId === 'OP1')).toBe(true);
    expect(hit[0].message).toContain('作用实体（target）');
    expect(report.mechanical.passed).toBe(false);
  });

  test('反向-已声明：target 多实体但已在事务边界段声明 ⇒ 通过', () => {
    const report = checkCompleteness(
      mkSixListModel({
        transactionBoundaries: [
          { id: 'TX1', interface: '匿名发布资源', boundaryType: 'same_transaction' },
        ],
      })
    );
    const hit = byRule(kindIssues(report), 'R-KIND-8');
    expect(hit).toHaveLength(0);
    expect(report.mechanical.passed).toBe(true);
  });

  test('正向-老模型形态（无事务边界段）：跨实体 ⇒ 告警不阻断', () => {
    const report = checkCompleteness(mkSixListModel());
    const hit = byRule(kindIssues(report), 'R-KIND-8');
    expect(hit.length).toBeGreaterThan(0);
    expect(hit[0].severity).toBe('warning');
    expect(hit[0].message).toContain('迁移截止日 2026-09-30');
    expect(report.mechanical.passed).toBe(true); // warning 不阻断
  });

  test('单实体操作不触发（target=短时映射实例 仅 1 实体）', () => {
    const report = checkCompleteness(mkSixListModel());
    const hit = byRule(kindIssues(report), 'R-KIND-8');
    // OP2 target 单实体不命中；命中的只有跨实体的 OP1
    expect(hit.filter((i) => i.elementId === 'OP2')).toHaveLength(0);
  });
});

// ============================================================================
// 判据 12（R-KIND-3）：依赖 observed 维度的不变量标 always ⇒ 硬失败
// ============================================================================

describe('判据 12（R-KIND-3，六张清单不变量段）', () => {
  const invObserved = mkInvariant(
    'INV_OBS',
    '短时映射实例.连接状态=在线 时资源可被访问（依赖 observed 连接状态）'
  );

  test('反向：不变量依赖 observed 维度且无 boundMs ⇒ 硬失败', () => {
    const report = checkCompleteness(mkSixListModel({ invariants: [invObserved], timing: [] }));
    const hit = byRule(kindIssues(report), 'R-KIND-3');
    expect(hit.length).toBeGreaterThan(0);
    expect(hit[0].severity).toBe('error');
    expect(hit[0].elementId).toBe('INV_OBS');
    expect(report.mechanical.passed).toBe(false);
  });

  test('正向：依赖 observed 维度且带 boundMs（eventually_within）⇒ 通过', () => {
    const report = checkCompleteness(
      mkSixListModel({
        invariants: [invObserved],
        timing: [mkTiming('TM1', 'INV_OBS', 5000)],
      })
    );
    expect(byRule(kindIssues(report), 'R-KIND-3')).toHaveLength(0);
    expect(report.mechanical.passed).toBe(true);
  });

  test('只依赖 declared 维度且无 timing ⇒ R-KIND-3 不命中（判据 12 只约束 observed）', () => {
    const invDeclared = mkInvariant(
      'INV_DECL',
      '认领码.兑付状态 ∈ {未使用, 已使用, 已失效}'
    );
    const report = checkCompleteness(mkSixListModel({ invariants: [invDeclared] }));
    expect(byRule(kindIssues(report), 'R-KIND-3')).toHaveLength(0);
  });
});

// ============================================================================
// 数据源核对（R1b 改动1）：R-KIND-10 接口命名空间须含操作段（组件映射不误报悬空）
// ============================================================================

describe('R1b 数据源核对（R-KIND-10：六张清单组件映射接口命名空间）', () => {
  test('组件映射引用操作接口名/实体维度 ⇒ 零 error（接口命名空间含 operations）', () => {
    const model = mkSixListModel();
    model.derivable.componentMapping = {
      interfaceImplementations: [{ interface: '匿名发布资源', component: '发布服务' }],
      dimensionStorage: [{ dimension: '归属状态', table: 'resources' }],
      componentTransfers: [],
    };
    const report = checkCompleteness(model);
    const hit = byRule(kindIssues(report), 'R-KIND-10');
    // A 方向（悬空引用 error）零命中：操作接口「匿名发布资源」/维度「归属状态」都在 IR
    expect(hit.filter((i) => i.severity === 'error')).toHaveLength(0);
    // B 方向（未映射列出）为 warning，不阻断
    expect(hit.filter((i) => i.severity === 'warning')).toHaveLength(1);
    expect(report.mechanical.passed).toBe(true);
  });

  test('组件映射引用不存在的接口 ⇒ 硬失败（六张清单形态同样生效）', () => {
    const model = mkSixListModel();
    model.derivable.componentMapping = {
      interfaceImplementations: [{ interface: '不存在的操作', component: '幽灵服务' }],
      dimensionStorage: [],
      componentTransfers: [],
    };
    const report = checkCompleteness(model);
    const hit = byRule(kindIssues(report), 'R-KIND-10');
    expect(hit.some((i) => i.severity === 'error' && i.message.includes('不存在的操作'))).toBe(
      true
    );
  });
});

// ============================================================================
// R1b-3 老实例零回归：状态机实例检查结果与 R1a 之前一致（R-KIND 组零新增 error）
// ============================================================================

describe('R1b-3 老实例零回归（状态机实例 R-KIND 组零新增 error）', () => {
  const foodDelivery = parseProtocolContent(
    readFileSync(join(EXAMPLES_DIR, 'food-delivery', 'protocol', 'model.md'), 'utf-8'),
    'food-delivery/model.md'
  );
  const fulfillP1 = parseProtocolContent(
    readFileSync(join(EXAMPLES_DIR, 'fulfillment-payment', 'protocol', 'P1', 'model.md'), 'utf-8'),
    'fulfillment-payment/P1/model.md'
  );

  const cases: Array<[string, SourceProtocolModel]> = [
    ['food-delivery', foodDelivery],
    ['fulfillment-payment/P1', fulfillP1],
  ];

  for (const [label, model] of cases) {
    test(`${label}：状态机形态无六张清单段（operations 保持 undefined）`, () => {
      expect(model.derivable.operations).toBeUndefined();
      expect(model.derivable.transitions.length).toBeGreaterThan(0);
    });

    test(`${label}：R-KIND 组零新增 error（与 R1a 之前一致）`, () => {
      const report = checkCompleteness(model);
      const errors = kindIssues(report).filter((i) => i.severity === 'error');
      // 零新增：R-KIND-5/6/8 对老模型零输出，全部 R-KIND 零 error
      expect(byRule(kindIssues(report), 'R-KIND-5')).toHaveLength(0);
      expect(byRule(kindIssues(report), 'R-KIND-6')).toHaveLength(0);
      expect(byRule(kindIssues(report), 'R-KIND-8')).toHaveLength(0);
      expect(errors).toHaveLength(0);
    });
  }
});
