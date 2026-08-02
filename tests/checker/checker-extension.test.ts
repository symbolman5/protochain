import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProtocolContent } from '../../src/parser/index.js';
import { checkCompleteness } from '../../src/checker/index.js';

const FIXTURES = join(process.cwd(), 'tests/fixtures');

function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf-8');
}

function parseAndCheck(content: string) {
  const model = parseProtocolContent(content, 'test.md');
  return checkCompleteness(model);
}

/**
 * 构造最小合法协议模型（含 consensus 角色与扩展字段表头）。
 *
 * 表头包含扩展字段列（triggerType/actionType/affectsDimensions/declaredBy/
 * invariantClass/onViolation/schedule），数据行通过 *Rows 参数覆盖。
 */
function baseModel(overrides: {
  transitionsRows?: string;
  invariantsRows?: string;
  timingRows?: string;
  roles?: string;
  externalEvents?: string;
  resourcePools?: string;
  subsidiaryEntities?: string;
} = {}): string {
  const roles = overrides.roles ?? `roles:
  - id: admin
    name: 管理员
    roleType: consensus`;
  return `---
name: 测试协议
version: 1.0.0
purpose: 测试
${roles}
---

# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S1 | 初始 | initial |
| S2 | 终态 | terminal |

# 转移规则

| ID | 名称 | from | to | action | trigger | guard | effects | triggerType | actionType | affectsDimensions |
|---|---|---|---|---|---|---|---|---|---|---|
${overrides.transitionsRows ?? '| T1 | 转移 | S1 | S2 | submit | admin | | | role | state_transition | |'}

# 不变量

| ID | 名称 | 表达式 | 作用状态 | declaredBy | invariantClass |
|---|---|---|---|---|---|
${overrides.invariantsRows ?? '| INV1 | 不变量 | true | S1 | admin | intra_protocol |'}

# 时序约束

| ID | 名称 | 类型 | 源 | 目标 | boundMs | onViolation | schedule |
|---|---|---|---|---|---|---|---|
${overrides.timingRows ?? '| TM1 | 时序 | response | S1 | S2 | 1000 | | |'}
${overrides.externalEvents ? `\n# 外部事件\n\n${overrides.externalEvents}` : ''}
${overrides.resourcePools ? `\n# 资源池\n\n${overrides.resourcePools}` : ''}
${overrides.subsidiaryEntities ? `\n# 附属实体\n\n${overrides.subsidiaryEntities}` : ''}
`;
}

describe('checker 扩展校验规则（7 条）', () => {
  describe('R2: 不变量 declaredBy 必须引用 consensus 角色', () => {
    test('正例：declaredBy 指向 consensus 角色 → 通过', () => {
      const report = parseAndCheck(
        baseModel({
          invariantsRows: '| INV1 | 不变量 | true | S1 | admin | intra_protocol |',
        })
      );
      const r2Issues = report.mechanical.referenceIssues.filter((i) =>
        i.message.includes('declaredBy')
      );
      expect(r2Issues).toHaveLength(0);
    });

    test('反例：declaredBy 指向非 consensus 角色 → 报错', () => {
      const content = baseModel({
        roles: `roles:
  - id: admin
    name: 管理员
    roleType: consensus
  - id: guest
    name: 访客
    roleType: participant`,
        invariantsRows: '| INV1 | 不变量 | true | S1 | guest | intra_protocol |',
      });
      const report = parseAndCheck(content);
      const r2Issues = report.mechanical.referenceIssues.filter(
        (i) =>
          i.message.includes('declaredBy') && i.message.includes('consensus')
      );
      expect(r2Issues.length).toBeGreaterThan(0);
    });
  });

  describe('R3: actionType=attribute_update → affectsDimensions 非空', () => {
    test('正例：attribute_update 且 affectsDimensions 非空 → 通过', () => {
      const report = parseAndCheck(
        baseModel({
          transitionsRows:
            '| T1 | 更新 | S1 | S1 | update | admin | | | role | attribute_update | count |',
        })
      );
      const r3Issues = report.mechanical.referenceIssues.filter((i) =>
        i.message.includes('affectsDimensions')
      );
      expect(r3Issues).toHaveLength(0);
    });

    test('反例：attribute_update 但 affectsDimensions 为空 → 报错', () => {
      const report = parseAndCheck(
        baseModel({
          transitionsRows:
            '| T1 | 更新 | S1 | S1 | update | admin | | | role | attribute_update | |',
        })
      );
      const r3Issues = report.mechanical.referenceIssues.filter((i) =>
        i.message.includes('affectsDimensions')
      );
      expect(r3Issues.length).toBeGreaterThan(0);
    });
  });

  describe('R4: continuous 时序 → onViolation 必须声明', () => {
    test('反例：continuous 无 onViolation → 报错', () => {
      const report = parseAndCheck(
        baseModel({
          timingRows: '| TM1 | 持续 | continuous | S1 | S2 | | | |',
        })
      );
      const r4Issues = report.mechanical.referenceIssues.filter((i) =>
        i.message.includes('onViolation')
      );
      expect(r4Issues.length).toBeGreaterThan(0);
    });

    test('正例：continuous 有 onViolation → 通过', () => {
      const report = parseAndCheck(
        baseModel({
          timingRows: '| TM1 | 持续 | continuous | S1 | S2 | | S2 | |',
        })
      );
      const r4Issues = report.mechanical.referenceIssues.filter((i) =>
        i.message.includes('onViolation')
      );
      expect(r4Issues).toHaveLength(0);
    });
  });

  describe('R5: scheduled 时序 → schedule 必须声明', () => {
    test('反例：scheduled 无 schedule → 报错', () => {
      const report = parseAndCheck(
        baseModel({
          timingRows: '| TM1 | 定时 | scheduled | S1 | S2 | | | |',
        })
      );
      const r5Issues = report.mechanical.referenceIssues.filter((i) =>
        i.message.includes('schedule')
      );
      expect(r5Issues.length).toBeGreaterThan(0);
    });
  });

  describe('R6: triggerType=external → trigger 引用已定义 ExternalEventDef', () => {
    test('正例：external trigger 匹配 ExternalEventDef.source → 通过', () => {
      const report = parseAndCheck(
        baseModel({
          transitionsRows:
            '| T1 | 接收 | S1 | S2 | receive | upstream | | | external | state_transition | |',
          externalEvents:
            '```yaml\n- id: EE1\n  name: 上游\n  source: upstream\n  triggerAction: receive\n```',
        })
      );
      const r6Issues = report.mechanical.referenceIssues.filter((i) =>
        i.message.includes('externalEvents')
      );
      expect(r6Issues).toHaveLength(0);
    });

    test('反例：external trigger 未定义 → 报错', () => {
      const report = parseAndCheck(
        baseModel({
          transitionsRows:
            '| T1 | 接收 | S1 | S2 | receive | unknown_src | | | external | state_transition | |',
          externalEvents:
            '```yaml\n- id: EE1\n  name: 上游\n  source: upstream\n  triggerAction: receive\n```',
        })
      );
      const r6Issues = report.mechanical.referenceIssues.filter((i) =>
        i.message.includes('externalEvents')
      );
      expect(r6Issues.length).toBeGreaterThan(0);
    });
  });

  describe('R7: cascadeRules / crossInvariantIds 完整性', () => {
    test('反例：附属实体 cascadeRules 为空 → 报错', () => {
      const report = parseAndCheck(
        baseModel({
          subsidiaryEntities:
            '```yaml\n- id: sub1\n  name: 附属\n  belongsTo: main（P1）\n  instanceKey: sub1.id\n  lifecycleDependency: 随主实体\n  cascadeRules: []\n  stateSpace:\n    dimensions: []\n  invariants: []\n```',
        })
      );
      const r7Issues = report.mechanical.referenceIssues.filter((i) =>
        i.message.includes('cascadeRules')
      );
      expect(r7Issues.length).toBeGreaterThan(0);
    });
  });

  describe('pendingCrossProtocolRefs 收集', () => {
    test('external trigger 标记为 pending composition 引用', () => {
      const content = readFixture('saas-P2-entry.md');
      const model = parseProtocolContent(content, 'saas-P2-entry.md');
      const report = checkCompleteness(model);
      const externalRefs = report.pendingCrossProtocolRefs?.filter(
        (r) => r.sourceField === 'TransitionDef.trigger'
      );
      expect(externalRefs).toBeDefined();
      expect(externalRefs!.length).toBeGreaterThan(0);
      expect(externalRefs![0].refType).toBe('composition');
    });

    test('资源池 crossInvariantIds 标记为 pending', () => {
      const content = readFixture('saas-P2-entry.md');
      const model = parseProtocolContent(content, 'saas-P2-entry.md');
      const report = checkCompleteness(model);
      const poolRefs = report.pendingCrossProtocolRefs?.filter(
        (r) => r.sourceField === 'ResourcePoolDef.crossInvariantIds'
      );
      expect(poolRefs).toBeDefined();
      expect(poolRefs!.some((r) => r.targetRef === 'CI1')).toBe(true);
    });

    test('附属实体 belongsTo 标记为 cross_protocol 引用', () => {
      const content = readFixture('saas-P2-entry.md');
      const model = parseProtocolContent(content, 'saas-P2-entry.md');
      const report = checkCompleteness(model);
      const belongsRefs = report.pendingCrossProtocolRefs?.filter(
        (r) => r.sourceField === 'SubsidiaryEntityDef.belongsTo'
      );
      expect(belongsRefs).toBeDefined();
      expect(belongsRefs!.length).toBeGreaterThan(0);
      expect(belongsRefs![0].refType).toBe('cross_protocol');
    });

    test('遗留 model.md 无扩展段 → pendingCrossProtocolRefs 为 undefined', () => {
      const content = readFixture('legacy-model.md');
      const model = parseProtocolContent(content, 'legacy-model.md');
      const report = checkCompleteness(model);
      expect(report.pendingCrossProtocolRefs).toBeUndefined();
    });
  });

  describe('saas-P2-entry.md 整体校验', () => {
    test('7 条规则全部通过', () => {
      const content = readFixture('saas-P2-entry.md');
      const model = parseProtocolContent(content, 'saas-P2-entry.md');
      const report = checkCompleteness(model);
      // 扩展规则不应产生 error
      const extErrors = report.mechanical.referenceIssues.filter(
        (i) =>
          i.severity === 'error' &&
          (i.message.includes('declaredBy') ||
            i.message.includes('affectsDimensions') ||
            i.message.includes('onViolation') ||
            i.message.includes('schedule') ||
            i.message.includes('externalEvents') ||
            i.message.includes('cascadeRules') ||
            i.message.includes('crossInvariantIds'))
      );
      expect(extErrors).toHaveLength(0);
    });
  });
});
