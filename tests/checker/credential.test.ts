/**
 * G7-S6（X13 / P2-6）：R-KIND-11 凭证声明完整性检查测试
 *
 * 覆盖：
 * - A 七列完整性：任一列缺失/空串 → error（硬失败）；
 * - B selfContained 枚举合法性：非 local-verify/needs-lookup → error（拒绝静默）；
 * - C name 唯一性：重复凭证名 → error；
 * - D issuer / holder / redeemer 角色引用闭合：引用未声明角色 → error；
 * - 干净凭证模型 → 零 issue（R-KIND-11 不误报）；
 * - S6-5 老模型零回归：legacy + 两演示实例无 credential 段 → R-KIND-11 零输出；
 * - 注册表含 R-KIND-11。
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
  CredentialDeclaration,
} from '../../src/model/types.js';

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

function mkTransition(id: string, to: string): TransitionDef {
  return {
    id,
    name: id,
    from: ['S1'],
    to,
    action: id,
    triggerType: 'role',
    trigger: 'r1',
    triggerRoleId: 'r1',
    actionType: 'state_transition',
    affectsDimensions: [],
  };
}

/** 干净可过既有规则的模型（S1(initial) --T1--> S2(terminal)） */
function mkModel(
  overrides: {
    states?: StateDef[];
    transitions?: TransitionDef[];
    credentials?: CredentialDeclaration[];
  } = {}
): SourceProtocolModel {
  const derivable: DerivableLayer = {
    degraded: false,
    states: overrides.states ?? [mkState('S1', 'initial'), mkState('S2', 'terminal')],
    transitions: overrides.transitions ?? [mkTransition('T1', 'S2')],
    invariants: [],
    timing: [],
    exceptions: [],
    initialStateId: 'S1',
    terminalStateIds: ['S2'],
  };
  return {
    metadata: {
      name: 'S6 凭证测试协议',
      version: '1.0.0',
      purpose: 'R-KIND-11 规则验收',
      roles: [
        { id: 'ca', name: '证书中心', roleType: 'consensus' },
        { id: 'merchant', name: '商家', roleType: 'participant' },
        { id: 'customer', name: '顾客', roleType: 'participant' },
      ],
      credentials: overrides.credentials,
    },
    readable: { background: 'b', concepts: [], workflow: 'w' },
    derivable,
  };
}

/** 干净凭证（三方均引用已声明角色） */
function cleanCredential(): CredentialDeclaration {
  return {
    name: 'merchant_license',
    issuer: 'ca',
    holder: 'merchant',
    redeemer: 'customer',
    selfContained: 'local-verify',
    ttl: '365d',
    revoke: '吊销后即时失效',
    premise: '商家完成资质认证',
  };
}

function kindIssues(report: ReturnType<typeof checkCompleteness>) {
  return report.mechanical.referenceIssues.filter((i) => i.message.includes('R-KIND-'));
}

function byRule(issues: ReturnType<typeof kindIssues>, ruleId: string) {
  return issues.filter((i) => i.message.includes(`[${ruleId}/`));
}

describe('G7-S6 R-KIND-11 凭证声明完整性', () => {
  test('干净凭证 → R-KIND-11 零 issue（不误报）', () => {
    const report = checkCompleteness(mkModel({ credentials: [cleanCredential()] }));
    expect(byRule(kindIssues(report), 'R-KIND-11')).toHaveLength(0);
  });

  test('A：七列任一缺失 → error（硬失败）', () => {
    const incomplete: Partial<CredentialDeclaration>[] = [
      { ...cleanCredential(), issuer: '' },
      { ...cleanCredential(), holder: '' },
      { ...cleanCredential(), redeemer: '' },
      { ...cleanCredential(), ttl: '' },
      { ...cleanCredential(), revoke: '' },
      { ...cleanCredential(), premise: '' },
      { ...cleanCredential(), selfContained: '' },
    ];
    for (const bad of incomplete) {
      const report = checkCompleteness(
        mkModel({ credentials: [bad as CredentialDeclaration] })
      );
      const issues = byRule(kindIssues(report), 'R-KIND-11');
      expect(issues.length).toBeGreaterThan(0);
      expect(issues.every((i) => i.severity === 'error')).toBe(true);
    }
  });

  test('B：selfContained 枚举非法值 → error（拒绝静默）', () => {
    const bad = { ...cleanCredential(), selfContained: 'online-only' as CredentialDeclaration['selfContained'] };
    const report = checkCompleteness(mkModel({ credentials: [bad] }));
    const issues = byRule(kindIssues(report), 'R-KIND-11');
    expect(issues.some((i) => i.message.includes('selfContained 必须是 local-verify 或 needs-lookup'))).toBe(true);
  });

  test('C：凭证名重复 → error（唯一性）', () => {
    const report = checkCompleteness(
      mkModel({ credentials: [cleanCredential(), { ...cleanCredential() }] })
    );
    const issues = byRule(kindIssues(report), 'R-KIND-11');
    expect(issues.some((i) => i.message.includes('重复声明'))).toBe(true);
    // 重复名只报一次（首次出现处）
    expect(issues.filter((i) => i.message.includes('重复声明'))).toHaveLength(1);
  });

  test('D：issuer / holder / redeemer 引用未声明角色 → error（引用闭合）', () => {
    const cases: Array<[keyof CredentialDeclaration, string]> = [
      ['issuer', 'unknown_ca'],
      ['holder', 'unknown_holder'],
      ['redeemer', 'unknown_redeemer'],
    ];
    for (const [party, ref] of cases) {
      const bad = { ...cleanCredential(), [party]: ref };
      const report = checkCompleteness(mkModel({ credentials: [bad as CredentialDeclaration] }));
      const issues = byRule(kindIssues(report), 'R-KIND-11');
      expect(issues.some((i) => i.message.includes(`${party}="${ref}"`) && i.message.includes('未在 metadata.roles 中声明'))).toBe(true);
    }
  });
});

// ============================================================================
// S6-5 老模型零回归（R-KIND-11 对 legacy + 两演示实例零输出）
// ============================================================================

describe('S6-5 老模型零回归（R-KIND-11 不得对无凭证段模型报 issue）', () => {
  const legacy = parseProtocolContent(readFileSync(join(BASE_DIR, 'legacy-model.md'), 'utf-8'));
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
    test(`${label}：R-KIND-11 零输出（credentials=undefined，S6-5）`, () => {
      expect(model.metadata.credentials).toBeUndefined();
      const report = checkCompleteness(model);
      expect(byRule(kindIssues(report), 'R-KIND-11')).toHaveLength(0);
    });
  }
});

describe('规则注册表（S6 扩展：R-KIND-11）', () => {
  test('注册表含 R-KIND-11 且可执行', () => {
    expect(KIND_RULE_IDS).toContain('R-KIND-11');
    expect(new Set(KIND_RULE_IDS).size).toBe(KIND_RULE_IDS.length);
    const rule = KIND_RULES.find((r) => r.ruleId === 'R-KIND-11');
    expect(rule).toBeDefined();
    expect(rule!.description.length).toBeGreaterThan(0);
    // 死代码自检（S6 同 S2-5/S5-6）：对无凭证段模型零输出、对凭证模型有输出
    expect(rule!.check({ model: mkModel() })).toHaveLength(0);
    expect(rule!.check({ model: mkModel({ credentials: [cleanCredential()] }) })).toHaveLength(0);
    expect(
      rule!.check({
        model: mkModel({ credentials: [{ ...cleanCredential(), issuer: 'ghost' }] }),
      }).length
    ).toBeGreaterThan(0);
  });
});
