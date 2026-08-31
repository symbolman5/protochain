/**
 * T1a 机械验收：components.md 独立组件模型（parser + checker R-KIND-10 延伸）
 *
 * 覆盖 execution-plan 缺口⑦ T1a：
 * - T1a-2 parser：components.md fixture（组件定义 + 三表 + 接口契约）解析为完整 ComponentModel IR；
 *   接口契约的 interface 悬空 → checker 硬失败（正反向）
 * - T1a-3 降级：无 auth 声明 → 接口 authorization 显示 none + 降级记录（R-KIND-10/T1a warning）
 * - T1a-4 老模型零回归：无 components.md（checkCompleteness 不带 componentModel）→ 不产生 T1a 校验
 */
import { parseComponentsContent } from '../../src/parser/components.js';
import { checkCompleteness } from '../../src/checker/index.js';
import type {
  SourceProtocolModel,
  DerivableLayer,
  StateDef,
  StateDimension,
  TransitionDef,
} from '../../src/model/types.js';

// ============================================================================
// 辅助构造（IR 级，仿 component-mapping.test.ts）
// ============================================================================

function mkDim(name: string, extra?: Partial<StateDimension>): StateDimension {
  return { name, type: 'string', initial: '', ...extra };
}

function mkState(id: string, type: StateDef['type'], dimensions: StateDimension[] = []): StateDef {
  return { id, name: id, type, dimensions };
}

function mkTransition(id: string, to: string, action: string): TransitionDef {
  return {
    id,
    name: id,
    from: ['S1'],
    to,
    action,
    triggerType: 'role',
    trigger: 'r1',
    triggerRoleId: 'r1',
    actionType: 'state_transition',
    affectsDimensions: [],
  };
}

/** 双接口 IR：接口命名空间 {T1/T2, place_order/confirm_payment}，带 credentials 段 */
function mkModel(): SourceProtocolModel {
  const derivable: DerivableLayer = {
    degraded: false,
    states: [
      mkState('S1', 'initial', [mkDim('order_status')]),
      mkState('S2', 'terminal'),
    ],
    transitions: [
      mkTransition('T1', 'S2', 'place_order'),
      mkTransition('T2', 'S2', 'confirm_payment'),
    ],
    invariants: [],
    timing: [],
    exceptions: [],
    initialStateId: 'S1',
    terminalStateIds: ['S2'],
  };
  return {
    metadata: {
      name: 'T1a 测试协议',
      version: '1.0.0',
      purpose: 'components.md parser + checker 验收',
      roles: [
        { id: 'r1', name: '角色1', responsibilities: '', roleType: 'consensus' },
      ],
      credentials: [
        {
          name: 'order_token',
          issuer: 'r1',
          holder: 'r1',
          redeemer: 'r1',
          selfContained: 'local-verify',
          ttl: '短',
          revoke: '主动失效',
          premise: '保密',
        },
      ],
    },
    readable: { background: 'b', concepts: [], workflow: 'w' },
    derivable,
    contractInput: undefined,
  };
}

/** 完整 components.md fixture：组件定义 + 三表 + 接口契约（一级标题分节，与 composition.md 风格一致） */
const FULL_COMPONENTS_MD = `---
name: 组件测试
protocolId: P1
---

# 组件定义

\`\`\`yaml
components:
  - name: order-service
    description: 订单服务
    baseUrl: https://order.example.com
    auth: bearer
  - name: payment-service
    auth: none
\`\`\`

# 组件映射

\`\`\`yaml
interfaceImplementations:
  - interface: place_order
    component: order-service
dimensionStorage:
  - dimension: order_status
    table: orders
componentTransfers:
  - from: order-service
    to: payment-service
    channel: http
    mode: sync
\`\`\`

# 接口契约

\`\`\`yaml
contracts:
  - interface: place_order
    path: /orders
    method: POST
    authorization: order_token
    requestSchema: 契约.requestSchema
  - interface: confirm_payment
    method: POST
    authorization: bearer
\`\`\`
`;

// ============================================================================
// T1a-2 parser：components.md → ComponentModel IR
// ============================================================================

describe('T1a-2 parser：components.md 解析为完整 ComponentModel IR', () => {
  test('组件定义 + 三张映射表 + 接口契约 → 完整 IR', () => {
    const cm = parseComponentsContent(FULL_COMPONENTS_MD, 'protocol/P1/components.md');
    // 元数据（宽松 front matter）
    expect(cm.name).toBe('组件测试');
    expect(cm.protocolId).toBe('P1');
    expect(cm.sourcePath).toBe('protocol/P1/components.md');
    // 组件定义
    expect(cm.components).toHaveLength(2);
    expect(cm.components![0]).toMatchObject({
      name: 'order-service',
      description: '订单服务',
      baseUrl: 'https://order.example.com',
      auth: 'bearer',
    });
    expect(cm.components![1]).toMatchObject({ name: 'payment-service', auth: 'none' });
    // 三张映射表
    expect(cm.mapping.interfaceImplementations).toEqual([
      { interface: 'place_order', component: 'order-service' },
    ]);
    expect(cm.mapping.dimensionStorage).toEqual([{ dimension: 'order_status', table: 'orders' }]);
    expect(cm.mapping.componentTransfers).toEqual([
      { from: 'order-service', to: 'payment-service', channel: 'http', mode: 'sync' },
    ]);
    // 接口契约
    expect(cm.contracts).toHaveLength(2);
    expect(cm.contracts![0]).toMatchObject({
      interface: 'place_order',
      path: '/orders',
      method: 'POST',
      authorization: 'order_token', // 凭证引用（credentials 段查表）
      requestSchema: '契约.requestSchema',
    });
    expect(cm.contracts![1]).toMatchObject({
      interface: 'confirm_payment',
      method: 'POST',
      authorization: 'bearer', // 鉴权类型枚举（全小写命中）
    });
  });

  test('缺失段降级：无组件定义/接口契约段 → 缺省字段，不抛错', () => {
    const cm = parseComponentsContent(
      '# 组件映射\n\n```yaml\ninterfaceImplementations:\n  - interface: place_order\n    component: order-service\n```\n',
      'x.md'
    );
    expect(cm.components).toBeUndefined();
    expect(cm.contracts).toBeUndefined();
    expect(cm.mapping.interfaceImplementations).toHaveLength(1);
    expect(cm.name).toBeUndefined();
  });
});

// ============================================================================
// T1a-2 checker 正反向：接口契约 interface 悬空 / 凭证悬空 → 硬失败
// ============================================================================

function byRule10(issues: ReturnType<typeof kindIssues>, tag: string) {
  return issues.filter((i) => i.message.includes(`[R-KIND-10/${tag}]`));
}

function kindIssues(report: ReturnType<typeof checkCompleteness>) {
  return report.mechanical.referenceIssues.filter((i) => i.message.includes('R-KIND-'));
}

describe('T1a-2 checker：接口契约引用校验（R-KIND-10 延伸）', () => {
  test('合法契约（interface 在 IR + 凭证存在）→ 无 error（仅未契约接口/auth 未声明 warning）', () => {
    const model = mkModel();
    const cm = parseComponentsContent(FULL_COMPONENTS_MD);
    const report = checkCompleteness(model, { componentModel: cm });
    const errs = byRule10(kindIssues(report), 'T1a').filter((i) => i.severity === 'error');
    expect(errs).toHaveLength(0);
    // 反向 1：未契约接口列出（warning）——place_order/confirm_payment 均已契约，无此 warning
    // 反向 2：auth 未声明降级记录（warning）——本 fixture 两个组件都声明了 auth
    expect(byRule10(kindIssues(report), 'T1a').filter((i) => i.severity === 'warning' && i.message.includes('auth'))).toHaveLength(0);
    expect(report.mechanical.passed).toBe(true);
  });

  test('接口契约 interface 悬空 → R-KIND-10/T1a error（硬失败）', () => {
    const model = mkModel();
    const cm = parseComponentsContent(
      `# 接口契约\n\n\`\`\`yaml\ncontracts:\n  - interface: no_such_iface\n    path: /x\n    method: POST\n\`\`\`\n`
    );
    const report = checkCompleteness(model, { componentModel: cm });
    const errs = byRule10(kindIssues(report), 'T1a').filter((i) => i.severity === 'error');
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toContain('no_such_iface');
    expect(errs[0].message).toContain('在 IR 中不存在');
    expect(report.mechanical.passed).toBe(false);
    // 反证：同一 IR 不带 componentModel（老路径）→ 无 T1a 校验输出
    const report2 = checkCompleteness(model);
    expect(byRule10(kindIssues(report2), 'T1a')).toHaveLength(0);
  });

  test('authorization 凭证引用悬空 → R-KIND-10/T1a error（硬失败）', () => {
    const model = mkModel();
    const cm = parseComponentsContent(
      `# 接口契约\n\n\`\`\`yaml\ncontracts:\n  - interface: place_order\n    method: POST\n    authorization: ghost_credential\n\`\`\`\n`
    );
    const report = checkCompleteness(model, { componentModel: cm });
    const errs = byRule10(kindIssues(report), 'T1a').filter((i) => i.severity === 'error');
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toContain('ghost_credential');
    expect(errs[0].message).toContain('credentials 段中不存在');
    expect(report.mechanical.passed).toBe(false);
  });
});

// ============================================================================
// T1a-3 降级：无 auth 声明 → 显式降级记录（warning）
// ============================================================================

describe('T1a-3 降级：组件定义未声明 auth → 降级记录', () => {
  test('components[].auth 缺省 → R-KIND-10/T1a warning（接口 authorization 显示 none + 组件模型未声明）', () => {
    const model = mkModel();
    const cm = parseComponentsContent(
      `# 组件定义\n\n\`\`\`yaml\ncomponents:\n  - name: order-service\n    description: 未声明 auth\n\`\`\`\n\n# 接口契约\n\n\`\`\`yaml\ncontracts:\n  - interface: place_order\n    method: POST\n\`\`\`\n`
    );
    const report = checkCompleteness(model, { componentModel: cm });
    const warns = byRule10(kindIssues(report), 'T1a').filter(
      (i) => i.severity === 'warning' && i.message.includes('未声明 auth')
    );
    expect(warns).toHaveLength(1);
    expect(warns[0].message).toContain('order-service');
    expect(warns[0].message).toContain('组件模型未声明');
    // warning 不阻断
    expect(report.mechanical.passed).toBe(true);
  });
});

// ============================================================================
// T1a-4 老模型零回归：无 components.md → 不产生 T1a 校验
// ============================================================================

describe('T1a-4 老模型零回归', () => {
  test('checkCompleteness 不带 componentModel（老路径）→ 无 T1a 校验输出', () => {
    const model = mkModel();
    // 老模型形态：model.md 内嵌组件映射段（componentMapping 存在，components.md 缺省）
    model.derivable.componentMapping = {
      interfaceImplementations: [{ interface: 'place_order', component: 'order-service' }],
      dimensionStorage: [{ dimension: 'order_status', table: 'orders' }],
      componentTransfers: [],
    };
    const report = checkCompleteness(model);
    expect(byRule10(kindIssues(report), 'T1a')).toHaveLength(0);
    // 内嵌段既有行为保留（R-KIND-10/X18 交叉一致照常）
    expect(report.mechanical.passed).toBe(true);
  });
});
