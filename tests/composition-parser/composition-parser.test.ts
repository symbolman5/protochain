import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCompositionContent, ParseError } from '../../src/composition-parser/index.js';

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
