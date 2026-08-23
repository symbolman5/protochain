import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseCompositionContent,
  ParseError,
  preprocessYamlProse,
} from '../../src/composition-parser/index.js';

const FIXTURES = join(process.cwd(), 'tests/fixtures');

function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf-8');
}

describe('composition-parser', () => {
  const content = readFixture('composition-saas.md');
  const composition = parseCompositionContent(content, 'composition-saas.md');

  test('解析系统元数据', () => {
    expect(composition.metadata.systemName).toBe('SaaS 系统');
    expect(composition.metadata.version).toBe('0.1.0');
    expect(composition.metadata.changeType).toBe('protocol_tweak');
  });

  test('解析子协议清单', () => {
    expect(composition.subProtocols).toHaveLength(2);
    const p2 = composition.subProtocols.find((s) => s.protocolId === 'P2');
    expect(p2?.name).toBe('入口协议');
    expect(p2?.modelPath).toBe('protocol/P2/model.md');
  });

  test('解析依赖图（edges 为权威）', () => {
    expect(composition.dependencyGraph.mermaid).toContain('P1');
    expect(composition.dependencyGraph.edges).toHaveLength(2);
    const edge = composition.dependencyGraph.edges[0];
    expect(edge.from).toBe('P1');
    expect(edge.to).toBe('P2');
    expect(edge.dependencyType).toBe('state');
  });

  test('解析跨协议不变量（### 标题 + YAML）', () => {
    expect(composition.crossInvariants).toHaveLength(2);
    const ci1 = composition.crossInvariants.find((i) => i.id === 'CI1');
    expect(ci1?.name).toBe('端口跨入口独占');
    expect(ci1?.span).toEqual(['P2']);
    expect(ci1?.complexity).toBe('first_order');
    expect(ci1?.declaredBy).toBe('platform');
    const ci2 = composition.crossInvariants.find((i) => i.id === 'CI2');
    expect(ci2?.span).toEqual(['P1', 'P2']);
  });

  test('解析跨协议时序', () => {
    expect(composition.crossTiming).toHaveLength(1);
    expect(composition.crossTiming[0].id).toBe('CT1');
    expect(composition.crossTiming[0].boundMs).toBe(60000);
  });

  test('解析外部依赖', () => {
    expect(composition.externalDependencies).toHaveLength(1);
    const dep = composition.externalDependencies[0];
    expect(dep.system).toBe('upstream');
    expect(dep.direction).toBe('event_sync');
    expect(dep.protocol).toBe('P2');
    expect(dep.syncCharacteristics.length).toBeGreaterThan(0);
  });

  test('解析观测接口', () => {
    expect(composition.observationInterfaces).toHaveLength(1);
    const oi = composition.observationInterfaces[0];
    expect(oi.id).toBe('OI1');
    expect(oi.readOnly).toBe(true);
    expect(oi.observable).toHaveLength(1);
    expect(oi.observable[0].protocol).toBe('P2');
    expect(oi.observable[0].fields).toEqual(['traffic_count']);
  });

  test('解析对象状态切面', () => {
    expect(composition.objectStateFacets).toHaveLength(1);
    const facet = composition.objectStateFacets[0];
    expect(facet.object).toBe('entry');
    expect(facet.idKey).toBe('entry.id');
    expect(facet.facets).toHaveLength(1);
    expect(facet.crossFacetConstraints).toHaveLength(1);
    expect(facet.crossFacetConstraints[0].tracesToInvariantId).toBe('CI1');
  });

  test('解析安全前提', () => {
    expect(composition.securityAssumptions).toHaveLength(1);
    const sa = composition.securityAssumptions[0];
    expect(sa.id).toBe('SA1');
    expect(sa.assumption).toContain('隔离');
    expect(sa.impactIfViolated).toContain('泄露');
  });

  test('缺少必要段落 → ParseError', () => {
    const bad = `# 子协议清单\n\`\`\`yaml\n- protocolId: P1\n  name: 协议1\n  version: 0.1.0\n  modelPath: protocol/P1/model.md\n\`\`\``;
    expect(() => parseCompositionContent(bad)).toThrow(ParseError);
  });

  test('依赖图 edges 与 Mermaid 共存时 edges 为权威', () => {
    // composition-saas.md 同时有 Mermaid 和 edges，edges 应被解析
    expect(composition.dependencyGraph.edges.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// B1-I2 修复：changeType 枚举扩展 + 宽松 YAML 解析
// ---------------------------------------------------------------------------

describe('B1-I2 修复：changeType 枚举', () => {
  test('protocol_extend 通过校验（hsk-ng 迭代 17 用）', () => {
    const md = `# 系统元数据

\`\`\`yaml
systemName: hskNG
version: 0.7.0
changeType: protocol_extend
\`\`\`

# 子协议清单

\`\`\`yaml
  - protocolId: P1
    name: 甲
    version: 0.7.0
    modelPath: protocol/P1/model.md
\`\`\`

# 依赖图

\`\`\`yaml
  - from: P1
    to: P1
    dependencyType: state
    description: 自依赖
\`\`\`
`;
    const c = parseCompositionContent(md);
    expect(c.metadata.changeType).toBe('protocol_extend');
  });

  test('非法 changeType 仍抛错', () => {
    const md = `# 系统元数据

\`\`\`yaml
systemName: X
version: 0.1.0
changeType: unknown_value
\`\`\`

# 子协议清单

\`\`\`yaml
  - protocolId: P1
    name: 甲
    version: 0.7.0
    modelPath: protocol/P1/model.md
\`\`\`

# 依赖图

\`\`\`yaml
  - from: P1
    to: P1
    dependencyType: state
    description: x
\`\`\`
`;
    expect(() => parseCompositionContent(md)).toThrow(ParseError);
  });
});

describe('B1-I2 修复：preprocessYamlProse', () => {
  test('单行 prose 字段用单引号包裹', () => {
    const input = `id: CI1
name: x
expression: forall op in {a, b}: guard(op) implies true
`;
    const out = preprocessYamlProse(input);
    expect(out).toContain("name: 'x'");
    expect(out).toContain("expression: 'forall op in {a, b}: guard(op) implies true'");
  });

  test('多行 prose 字段转 literal block scalar（hsk-ng CI2 checkMethod 场景）', () => {
    const input = `id: CI2
name: 网卡IP入口归属唯一账户
checkMethod: 存储层约束——网卡入口 owner_id 引用活跃 P2 账户（可空=公共/平台入口），
  注册时校验归属账户活跃；归属账户注销时其网卡归属清空（owner_id→NULL，网卡入口保留，
  迁移 0010 FK ON DELETE SET NULL——迭代 16 的级联删除语义修订），转发服务器本体保持平台归属、不受影响
complexity: simple_boolean
`;
    const out = preprocessYamlProse(input);
    expect(out).toContain('checkMethod: |');
    // 续行保留内容（block 内）
    expect(out).toContain('存储层约束');
    expect(out).toContain('迁移 0010 FK ON DELETE SET NULL');
    // 下一 key 应在 block 之后（缩进 ≤ checkMethod 缩进 = 0）
    expect(out.indexOf('complexity:')).toBeGreaterThan(out.indexOf('checkMethod: |'));
  });

  test('hsk-ng CI1 expression 含 `{...}: ...`（原 js-yaml 报错的真实场景）', () => {
    const input = `id: CI1
name: P1 写操作会话守卫
span: [P1, P2]
expression: forall op in {register, goOnline, disable, deregister}: guard(op) implies (P2.account = S1_active AND session.valid = true AND access_token.expired = false)
declaredBy: system
checkMethod: 控制面守卫校验——P1 写操作执行前校验调用方 P2 账户处于 S1 活跃且持有未过期会话
complexity: simple_boolean
`;
    const out = preprocessYamlProse(input);
    expect(out).toContain("expression: 'forall op in {register, goOnline, disable, deregister}: guard(op)");
    // 用 parseCompositionContent 端到端验证：完整 composition.md
  });

  test('端到端：完整 hsk-ng 风格 composition.md（CI1~CI3）跑通', () => {
    const md = `# 系统元数据

\`\`\`yaml
systemName: hskNG
version: 0.7.0
changeType: protocol_extend
\`\`\`

# 子协议清单

\`\`\`yaml
  - protocolId: P1
    name: 甲
    version: 0.7.0
    modelPath: protocol/P1/model.md
  - protocolId: P2
    name: 乙
    version: 0.7.0
    modelPath: protocol/P2/model.md
\`\`\`

# 依赖图

\`\`\`yaml
  - from: P2
    to: P1
    dependencyType: state
    description: P1 写操作守卫依赖 P2 会话
\`\`\`

# 跨协议不变量

### CI1: P1 写操作会话守卫

\`\`\`yaml
id: CI1
name: P1写操作会话守卫
span: [P1, P2]
expression: forall op in {register, goOnline, disable, deregister}: guard(op) implies (P2.account = S1_active AND session.valid = true)
declaredBy: system
checkMethod: 控制面守卫校验
complexity: simple_boolean
\`\`\`

### CI2: 网卡 IP 入口归属

\`\`\`yaml
id: CI2
name: 网卡IP入口归属
span: [P1, P2]
expression: 'forall e in P1.nic_entries: (e.owner_id = null) or (exists u in P2.accounts such that e.owner_id = u.id)'
declaredBy: system
checkMethod: 存储层约束——网卡入口 owner_id 引用活跃 P2 账户（可空=公共），
  注册时校验归属账户活跃；注销时清空归属
complexity: simple_boolean
\`\`\`
`;
    const c = parseCompositionContent(md);
    expect(c.crossInvariants).toHaveLength(2);
    expect(c.crossInvariants[0].expression).toContain('forall op in {register, goOnline');
    expect(c.crossInvariants[1].checkMethod).toContain('存储层约束');
    expect(c.crossInvariants[1].checkMethod).toContain('注册时校验归属账户活跃');
  });
});
