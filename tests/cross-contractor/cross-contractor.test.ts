import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCompositionContent } from '../../src/composition-parser/index.js';
import { deriveCrossContracts } from '../../src/cross-contractor/index.js';
import type { CompositionModel, CrossContractSet } from '../../src/model/types.js';

const FIXTURES = join(process.cwd(), 'tests/fixtures');

function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf-8');
}

function loadComposition(): CompositionModel {
  return parseCompositionContent(
    readFixture('composition-saas.md'),
    'composition-saas.md'
  );
}

describe('deriveCrossContracts', () => {
  const composition = loadComposition();
  const contracts: CrossContractSet = deriveCrossContracts(composition);

  test('事件契约：2 条 edges → 2 条事件契约', () => {
    expect(contracts.eventContracts).toHaveLength(2);
    expect(contracts.eventContracts[0].id).toBe('cross-event-0');
    expect(contracts.eventContracts[0].fromProtocol).toBe('P1');
    expect(contracts.eventContracts[0].toProtocol).toBe('P2');
    expect(contracts.eventContracts[1].id).toBe('cross-event-1');
    expect(contracts.eventContracts[1].fromProtocol).toBe('P2');
    expect(contracts.eventContracts[1].toProtocol).toBe('P1');
  });

  test('事件契约包含事件描述', () => {
    const event0 = contracts.eventContracts[0];
    expect(event0.event).toContain('state');
    expect(event0.event).toContain('租户存在是入口创建的前提');

    const event1 = contracts.eventContracts[1];
    expect(event1.event).toContain('event');
    expect(event1.event).toContain('入口状态变更通知租户');
  });

  test('影响范围契约：upstream external dependency → 1 条影响契约', () => {
    expect(contracts.impactContracts).toHaveLength(1);
    const impact = contracts.impactContracts[0];
    expect(impact.id).toBe('cross-impact-0');
    expect(impact.sourceEvent).toBe('upstream');
    expect(impact.affectedProtocols).toEqual(['P2']);
    expect(impact.expectedResponse).toContain('事件同步');
  });

  test('时序契约：CT1 → 1 条时序契约', () => {
    expect(contracts.timingContracts).toHaveLength(1);
    const tc = contracts.timingContracts[0];
    expect(tc.id).toBe('cross-timing-0');
    expect(tc.crossTimingId).toBe('CT1');
    expect(tc.span).toEqual(['P1', 'P2']);
    expect(tc.rule).toContain('租户创建后');
    expect(tc.boundMs).toBe(60000);
  });

  test('补偿契约：external dependency 有 2 条补偿规则 → 2 条补偿契约', () => {
    expect(contracts.compensationContracts).toHaveLength(2);
    const comp0 = contracts.compensationContracts[0];
    expect(comp0.id).toBe('cross-compensation-0-0');
    expect(comp0.failureScenario).toBe('入口无法接收流量');
    expect(comp0.compensationAction).toBe('丢弃重复事件');
    expect(comp0.span).toEqual(['P2']);

    const comp1 = contracts.compensationContracts[1];
    expect(comp1.id).toBe('cross-compensation-0-1');
    expect(comp1.failureScenario).toBe('入口无法接收流量');
    expect(comp1.compensationAction).toBe('延迟超阈值丢弃');
    expect(comp1.span).toEqual(['P2']);
  });

  test('无跨协议不变量时不产生空契约', () => {
    const emptyComp: CompositionModel = {
      ...composition,
      dependencyGraph: { ...composition.dependencyGraph, edges: [] },
      externalDependencies: [],
      crossTiming: [],
    };
    const result = deriveCrossContracts(emptyComp);
    expect(result.eventContracts).toHaveLength(0);
    expect(result.impactContracts).toHaveLength(0);
    expect(result.timingContracts).toHaveLength(0);
  });
});
