/**
 * G7-S5b 机械验收：组件映射段 X18（R-KIND-10）
 *
 * 覆盖 execution-plan.md §S5 的 S5-5 + S5-6（X18 部分）+ 老模型零回归：
 * - S5-5 X18 交叉一致：映射表出现的 interface / dimension 必须在 IR 存在（悬空 → 硬失败）；
 *   IR 中未被映射者显式列出（不静默遗漏，进入报告输出）
 * - S5-6 死代码自检：X18 一条「若规则被绕过则结果不同」用例（防恒真/恒假）
 * - parser 三态（与 S5a 事务边界段同款）：段不存在 → undefined（老模型形态）；
 *   段存在 → ComponentMappingDef（三张映射表）
 * - 老模型零回归：无组件映射段的 model.md 解析/检查与 S5a 之前一致
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProtocolContent } from '../../src/parser/index.js';
import { checkCompleteness } from '../../src/checker/index.js';
import { KIND_RULES, KIND_RULE_IDS } from '../../src/checker/kind-rules.js';
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
// 辅助构造（IR 级，仿 kind-rules-s5.test.ts）
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
    action?: string;
  }
): TransitionDef {
  return {
    id,
    name: id,
    from: ['S1'],
    to,
    action: opts.action ?? id,
    triggerType: opts.triggerType,
    trigger: opts.trigger ?? opts.triggerType,
    triggerRoleId: opts.triggerRoleId,
    actionType: 'state_transition',
    affectsDimensions: opts.affectsDimensions ?? [],
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
 * 构造结构干净、可通过既有 checker 规则的模型（仿 S5a 测试的 mkModel）：
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
    componentMapping?: SourceProtocolModel['derivable']['componentMapping'];
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
    componentMapping: overrides.componentMapping,
  };
  return {
    metadata: {
      name: 'S5b 测试协议',
      version: '1.0.0',
      purpose: 'R-KIND-10 规则验收',
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

// 干净的组件映射段：全映射（接口 action + 维度），无悬空引用
function fullMapping() {
  return {
    interfaceImplementations: [
      { interface: 'place_order', component: 'order-service' },
      { interface: 'confirm_payment', component: 'payment-service' },
    ],
    dimensionStorage: [
      { dimension: 'order_status', table: 'orders' },
      { dimension: 'payment_status', table: 'payments', field: 'status' },
    ],
    componentTransfers: [
      { from: 'order-service', to: 'payment-service', channel: 'http', mode: 'sync' as const },
    ],
  };
}

// 双接口双维度 IR：接口命名空间 {T1/T2, place_order/confirm_payment}，维度 {order_status, payment_status}
function twoInterfaceModel(): SourceProtocolModel {
  return mkModel({
    states: [
      mkState('S1', 'initial', [mkDim('order_status'), mkDim('payment_status')]),
      mkState('S2', 'terminal'),
    ],
    transitions: [
      mkTransition('T1', 'S2', { triggerType: 'role', trigger: 'r1', affectsDimensions: ['order_status'], action: 'place_order' }),
      mkTransition('T2', 'S2', { triggerType: 'role', trigger: 'r1', affectsDimensions: ['payment_status'], action: 'confirm_payment' }),
    ],
  });
}

// ============================================================================
// S5-6 死代码自检：X18 一条「若规则被绕过则结果不同」用例
// ============================================================================

describe('S5-6 死代码自检：X18（R-KIND-10）「若规则被绕过则结果不同」', () => {
  test('有组件映射段 + 悬空 interface ⇒ R-KIND-10 命中 error；同一 IR 去掉该段 ⇒ 零输出（防恒真/恒假）', () => {
    const model = twoInterfaceModel();
    // 映射表引用 IR 不存在的接口 → 硬失败
    model.derivable.componentMapping = {
      interfaceImplementations: [{ interface: 'no_such_iface', component: 'ghost-service' }],
      dimensionStorage: [],
      componentTransfers: [],
    };
    const report = checkCompleteness(model);
    const hit = byRule(kindIssues(report), 'R-KIND-10');
    const errors = hit.filter((i) => i.severity === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('no_such_iface');
    expect(errors[0].message).toContain('在 IR 中不存在');
    // 悬空引用侧为 error；IR 未映射者显式列出侧为 warning（不阻断，另有断言覆盖）
    expect(hit.some((i) => i.severity === 'warning' && i.message.includes('未映射'))).toBe(true);
    expect(report.mechanical.passed).toBe(false);

    // 反证：同一 IR，无组件映射段（老模型形态 → undefined）⇒ R-KIND-10 零输出（规则被绕过则结果不同）
    const noSection = twoInterfaceModel();
    expect(noSection.derivable.componentMapping).toBeUndefined();
    const report2 = checkCompleteness(noSection);
    expect(byRule(kindIssues(report2), 'R-KIND-10')).toHaveLength(0);
    expect(report2.mechanical.passed).toBe(true);
  });
});

// ============================================================================
// S5-5：X18 交叉一致 —— 正向 / 反向（悬空引用）+ 未映射者显式列出
// ============================================================================

describe('S5-5 R-KIND-10（X18：组件映射交叉一致）', () => {
  test('正向：映射表出现的 interface/dimension 均在 IR 存在且全映射 ⇒ 零 issue，passed=true', () => {
    const model = twoInterfaceModel();
    model.derivable.componentMapping = fullMapping();
    const report = checkCompleteness(model);
    expect(byRule(kindIssues(report), 'R-KIND-10')).toHaveLength(0);
    expect(report.mechanical.passed).toBe(true);
  });

  test('正向：transition id 别名映射（映射 T1/T2 而非 action）⇒ action 别名视为已覆盖，无未映射接口', () => {
    const model = twoInterfaceModel();
    model.derivable.componentMapping = {
      interfaceImplementations: [
        { interface: 'T1', component: 'order-service' },
        { interface: 'T2', component: 'payment-service' },
      ],
      dimensionStorage: [
        { dimension: 'order_status', table: 'orders' },
        { dimension: 'payment_status', table: 'payments' },
      ],
      componentTransfers: [],
    };
    const report = checkCompleteness(model);
    const hit = byRule(kindIssues(report), 'R-KIND-10');
    expect(hit.filter((i) => i.severity === 'error')).toHaveLength(0);
    expect(hit.filter((i) => i.message.includes('未映射接口'))).toHaveLength(0);
  });

  test('反向：映射表引用 IR 不存在的 interface ⇒ 硬失败（error，mechanical.passed=false）', () => {
    const model = twoInterfaceModel();
    model.derivable.componentMapping = {
      interfaceImplementations: [
        { interface: 'place_order', component: 'order-service' },
        { interface: 'ghost_op', component: 'ghost-service' },
      ],
      dimensionStorage: [
        { dimension: 'order_status', table: 'orders' },
        { dimension: 'payment_status', table: 'payments' },
      ],
      componentTransfers: [],
    };
    const report = checkCompleteness(model);
    const hit = byRule(kindIssues(report), 'R-KIND-10');
    const errors = hit.filter((i) => i.severity === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('ghost_op');
    expect(errors[0].message).toContain('在 IR 中不存在');
    expect(report.mechanical.passed).toBe(false);
  });

  test('反向：映射表引用 IR 不存在的 dimension ⇒ 硬失败（error）', () => {
    const model = twoInterfaceModel();
    model.derivable.componentMapping = {
      interfaceImplementations: [
        { interface: 'place_order', component: 'order-service' },
        { interface: 'confirm_payment', component: 'payment-service' },
      ],
      dimensionStorage: [
        { dimension: 'order_status', table: 'orders' },
        { dimension: 'ghost_dim', table: 'ghost_table' },
      ],
      componentTransfers: [],
    };
    const report = checkCompleteness(model);
    const hit = byRule(kindIssues(report), 'R-KIND-10');
    const errors = hit.filter((i) => i.severity === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('ghost_dim');
    expect(errors[0].message).toContain('在 IR 中不存在');
    expect(report.mechanical.passed).toBe(false);
  });

  test('未映射者显式列出：IR 中未被映射的 interface/dimension 进入报告输出（warning，不静默）', () => {
    const model = twoInterfaceModel();
    model.derivable.componentMapping = {
      interfaceImplementations: [
        { interface: 'place_order', component: 'order-service' },
      ],
      dimensionStorage: [
        { dimension: 'order_status', table: 'orders' },
      ],
      componentTransfers: [],
    };
    const report = checkCompleteness(model);
    const hit = byRule(kindIssues(report), 'R-KIND-10');
    expect(hit).toHaveLength(1);
    expect(hit[0].severity).toBe('warning');
    expect(hit[0].message).toContain('不静默遗漏');
    // 显式列出未映射者：confirm_payment（未被接口映射覆盖；T2 因 action 别名 confirm_payment 未映射故同样列出）
    expect(hit[0].message).toContain('confirm_payment');
    expect(hit[0].message).toContain('payment_status');
    expect(report.mechanical.passed).toBe(true); // warning 不阻断
  });

  test('未映射者显式列出：接口全映射但维度有遗漏 ⇒ 仅列未映射维度', () => {
    const model = twoInterfaceModel();
    model.derivable.componentMapping = {
      interfaceImplementations: [
        { interface: 'place_order', component: 'order-service' },
        { interface: 'confirm_payment', component: 'payment-service' },
      ],
      dimensionStorage: [
        { dimension: 'order_status', table: 'orders' },
      ],
      componentTransfers: [],
    };
    const report = checkCompleteness(model);
    const hit = byRule(kindIssues(report), 'R-KIND-10');
    expect(hit).toHaveLength(1);
    expect(hit[0].message).toContain('未映射维度：payment_status');
    expect(hit[0].message).not.toContain('未映射接口');
    expect(hit[0].severity).toBe('warning');
  });
});

// ============================================================================
// parser 三态（段不存在 → undefined；段存在 → ComponentMappingDef）
// ============================================================================

describe('X18 parser：组件映射段三态', () => {
  test('段存在 ⇒ componentMapping 为对象，三张映射表解析正确', () => {
    const model = parseProtocolContent(`---
name: X18 组件映射 fixture
version: 1.0.0
purpose: 验证组件映射段解析
roles:
  - id: r1
    name: 角色1
    roleType: consensus
---

# 背景

验证组件映射段。

# 状态空间

| ID | 名称 | 类型 | 描述 | 角色 |
|---|---|---|---|---|
| S0 | 初始 | initial | 初始态 | r1 |
| S1 | 终态 | terminal | 终态 | r1 |

# 转移规则

| ID | 名称 | from | to | action | trigger | guard | effects | triggerType | actionType | affectsDimensions |
|---|---|---|---|---|---|---|---|---|---|---|
| T1 | 下单 | S0 | S1 | place_order | r1 | | | role | state_transition | order_status |

# 附属实体

\`\`\`yaml
- id: payment
  name: 支付单
  belongsTo: S1（本协议）
  instanceKey: payment.id
  lifecycleDependency: 随订单状态推进
  cascadeRules:
    - 下单后创建支付单
  stateSpace:
    dimensions:
      - name: order_status
        type: string
        initial: ""
\`\`\`

# 组件映射

\`\`\`yaml
interfaceImplementations:
  - interface: place_order
    component: order-service
  - interface: T1
    component: order-service
dimensionStorage:
  - dimension: order_status
    table: orders
    field: status
componentTransfers:
  - from: order-service
    to: payment-gateway
    channel: http
    mode: sync
    description: 下单后同步请求支付
\`\`\`
`);
    expect(model.derivable.componentMapping).toBeDefined();
    const m = model.derivable.componentMapping!;
    expect(m.interfaceImplementations).toHaveLength(2);
    expect(m.interfaceImplementations![0]).toMatchObject({
      interface: 'place_order',
      component: 'order-service',
    });
    expect(m.dimensionStorage).toHaveLength(1);
    expect(m.dimensionStorage![0]).toMatchObject({
      dimension: 'order_status',
      table: 'orders',
      field: 'status',
    });
    expect(m.componentTransfers).toHaveLength(1);
    expect(m.componentTransfers![0]).toMatchObject({
      from: 'order-service',
      to: 'payment-gateway',
      channel: 'http',
      mode: 'sync',
      description: '下单后同步请求支付',
    });
  });

  test('段不存在 ⇒ componentMapping 为 undefined（老模型形态，零回归）', () => {
    const model = parseProtocolContent(`---
name: 无组件映射段
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
    expect(model.derivable.componentMapping).toBeUndefined();
  });

  test('拒绝静默：componentTransfers[].mode 非 sync/async ⇒ ParseError', () => {
    expect(() =>
      parseProtocolContent(`---
name: 非法 mode
version: 1.0.0
purpose: 验证拒绝静默
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

# 组件映射

\`\`\`yaml
componentTransfers:
  - from: a
    to: b
    channel: http
    mode: parallel
\`\`\`
`)
    ).toThrow(/mode 必须是 sync 或 async/);
  });
});

// ============================================================================
// fixture 文件（model.md 新增段语法演示）+ 老模型零回归
// ============================================================================

describe('X18 fixture 与老模型零回归', () => {
  test('tests/fixtures/component-mapping-model.md：解析出三张表且 R-KIND-10 零 error（全映射）', () => {
    const model = parseProtocolContent(
      readFileSync(join(BASE_DIR, 'component-mapping-model.md'), 'utf-8')
    );
    const m = model.derivable.componentMapping;
    expect(m).toBeDefined();
    expect(m!.interfaceImplementations).toHaveLength(2);
    expect(m!.dimensionStorage).toHaveLength(2);
    expect(m!.componentTransfers).toHaveLength(1);
    const report = checkCompleteness(model);
    const hit = byRule(kindIssues(report), 'R-KIND-10');
    expect(hit.filter((i) => i.severity === 'error')).toHaveLength(0);
    expect(report.mechanical.passed).toBe(true);
  });

  const legacy = parseProtocolContent(
    readFileSync(join(BASE_DIR, 'legacy-model.md'), 'utf-8')
  );
  const foodDelivery = parseProtocolContent(
    readFileSync(join(EXAMPLES_DIR, 'food-delivery', 'protocol', 'model.md'), 'utf-8')
  );
  const fulfillP1 = parseProtocolContent(
    readFileSync(join(EXAMPLES_DIR, 'fulfillment-payment', 'protocol', 'P1', 'model.md'), 'utf-8')
  );

  const cases: Array<[string, SourceProtocolModel]> = [
    ['legacy-model.md（遗留协议）', legacy],
    ['examples/food-delivery（演示实例1）', foodDelivery],
    ['examples/fulfillment-payment/P1（演示实例2）', fulfillP1],
  ];

  for (const [label, model] of cases) {
    test(`${label}：无组件映射段 ⇒ R-KIND-10 零输出（老模型零回归）`, () => {
      expect(model.derivable.componentMapping).toBeUndefined();
      const report = checkCompleteness(model);
      expect(byRule(kindIssues(report), 'R-KIND-10')).toHaveLength(0);
    });
  }
});

// ============================================================================
// 注册表完整性（R-KIND-10 注册方式）
// ============================================================================

describe('规则注册表（S5b 扩展：R-KIND-10）', () => {
  test('KIND_RULES 包含 R-KIND-10，且 ID 列表与注册表一致', () => {
    expect(KIND_RULE_IDS).toContain('R-KIND-10');
    expect(KIND_RULES.map((r) => r.ruleId)).toEqual(KIND_RULE_IDS);
    const rule = KIND_RULES.find((r) => r.ruleId === 'R-KIND-10');
    expect(rule).toBeDefined();
    expect(rule!.description).toContain('X18');
  });
});
