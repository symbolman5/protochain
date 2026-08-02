import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCompositionContent } from '../../src/composition-parser/index.js';
import { parseProtocolContent } from '../../src/parser/index.js';
import { generateCrossCases } from '../../src/cross-casegen/index.js';
import type { CompositionModel, SourceProtocolModel } from '../../src/model/types.js';

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

function loadP2Model(): SourceProtocolModel {
  return parseProtocolContent(
    readFixture('saas-P2-entry.md'),
    'saas-P2-entry.md'
  );
}

describe('generateCrossCases', () => {
  const composition = loadComposition();
  const p2Model = loadP2Model();

  test('跨协议路径生成：2 条 edges → 2 条路径', () => {
    const cases = generateCrossCases(composition, [p2Model]);
    expect(cases.paths).toHaveLength(2);
    expect(cases.paths[0].id).toBe('CROSS_PATH_01');
    expect(cases.paths[1].id).toBe('CROSS_PATH_02');
  });

  test('路径包含两个 segments', () => {
    const cases = generateCrossCases(composition, [p2Model]);
    for (const path of cases.paths) {
      expect(path.segments).toHaveLength(2);
      expect(path.segments[0].protocolId).toBeDefined();
      expect(path.segments[1].protocolId).toBeDefined();
    }
  });

  test('路径 description 包含依赖类型和描述', () => {
    const cases = generateCrossCases(composition, [p2Model]);
    expect(cases.paths[0].description).toContain('P1');
    expect(cases.paths[0].description).toContain('P2');
    expect(cases.paths[0].description).toContain('state');
  });

  test('路径包含跨协议不变量检查点', () => {
    const cases = generateCrossCases(composition, [p2Model]);
    for (const path of cases.paths) {
      expect(path.crossInvariantCheckpoints).toContain('CI1');
      expect(path.crossInvariantCheckpoints).toContain('CI2');
    }
  });

  test('覆盖度报告：事件覆盖数等于 edges 数量', () => {
    const cases = generateCrossCases(composition, [p2Model]);
    expect(cases.coverage.eventCoverage.total).toBe(2);
    expect(cases.coverage.eventCoverage.covered).toBe(2);
    expect(cases.coverage.eventCoverage.ratio).toBe(1);
  });

  test('覆盖度报告：不变量覆盖', () => {
    const cases = generateCrossCases(composition, [p2Model]);
    expect(cases.coverage.invariantCoverage.total).toBe(2);
    // 两条路径都包含 CI1 和 CI2，所以 covered 应为 2
    expect(cases.coverage.invariantCoverage.covered).toBe(2);
  });

  test('覆盖度报告：无未覆盖项', () => {
    const cases = generateCrossCases(composition, [p2Model]);
    expect(cases.coverage.uncoveredDispositions).toHaveLength(0);
  });

  test('generateAt 字段不为空', () => {
    const cases = generateCrossCases(composition, [p2Model]);
    expect(cases.generatedAt).toBeTruthy();
    expect(() => new Date(cases.generatedAt)).not.toThrow();
  });

  test('无 edges 时路径为空', () => {
    const emptyComp: CompositionModel = {
      ...composition,
      dependencyGraph: { ...composition.dependencyGraph, edges: [] },
    };
    const cases = generateCrossCases(emptyComp, [p2Model]);
    expect(cases.paths).toHaveLength(0);
    expect(cases.coverage.eventCoverage.total).toBe(0);
    expect(cases.coverage.eventCoverage.covered).toBe(0);
  });
});
