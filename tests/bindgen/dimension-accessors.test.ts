/**
 * X4/X19（G7/S3）：derive-bindings 维度访问器骨架 —— observed 不生成 setter、declared 生成 setter、
 * kind 缺省显式降级（dimension-kind-undetermined，B-1 分流）、老模型降级路径不改行为（S3-5）。
 *
 * 验收映射：
 * - S3-2：grep 判据 —— derive-bindings 产物（bindings.skeleton.yaml）中 observed 维度名后不出现 setter（逐维度断言）
 * - S3-3：declared 维度仍正常生成 setter（正向对照，防一刀切不生成）
 * - S3-5：无 kind 标注的老模型（specs.json 无 dimensions 段）产物与 S1 之前完全一致（不产出 dimensions 段）
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import {
  deriveBindings,
  deriveSkeletonBindings,
  deriveDimensionAccessors,
  SKELETON_MARKER,
  type SkeletonBindings,
} from '../../src/bindgen/index.js';
import { parseProtocolFile } from '../../src/parser/index.js';
import { specify } from '../../src/specifier/index.js';
import type {
  InterfaceSpec,
  SourceProtocolModel,
} from '../../src/model/types.js';
import type { DimensionKindEntry } from '../../src/model/dimension-kind.js';

const FIXTURE_DIR = '/work/protochain/tests/fixtures';

function loadModel(): SourceProtocolModel {
  return parseProtocolFile(`${FIXTURE_DIR}/approval-flow.md`);
}

function loadSpecs(): InterfaceSpec[] {
  return specify(loadModel()).specs;
}

/** 三态维度清单：observed / declared / undetermined（对应 S3-2 / S3-3 / 降级） */
function mkDimensionEntries(): DimensionKindEntry[] {
  return [
    { owner: 'S1', dimension: 'observed_dim', kind: 'observed', kindSource: 'derived', writers: ['system'] },
    { owner: 'S1', dimension: 'declared_dim', kind: 'declared', kindSource: 'derived', writers: ['role'] },
    { owner: 'refund_order', dimension: 'refund_status', writers: [] },
  ];
}

/**
 * 从 YAML 文本中抽取单维度条目块（维度名出现 → 下一个维度条目 / 段尾）。
 * 用于逐维度 grep 断言（S3-2/S3-3）。
 */
function extractDimensionBlock(yaml: string, dimension: string): string {
  const marker = `dimension: ${dimension}`;
  const start = yaml.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0); // 维度名必须出现在产物中
  const after = yaml.slice(start + marker.length);
  // 下一个条目以「  - owner:」开头（2 空格 + 列表项）
  const nextEntry = after.search(/\n  - owner:/);
  const tail = nextEntry >= 0 ? after.slice(0, nextEntry) : after;
  // 到 stats 段为止（dimensions 是最后一个段之前，防御段尾越界）
  const statsIdx = tail.indexOf('\nstats:');
  return statsIdx >= 0 ? tail.slice(0, statsIdx) : tail;
}

// ---------------------------------------------------------------------------
// deriveDimensionAccessors（纯函数单测）
// ---------------------------------------------------------------------------

describe('deriveDimensionAccessors（X4/X19 纯函数）', () => {
  test('observed → 只 reader，无 setter（S3-2 核心）', () => {
    const { entries, warnings } = deriveDimensionAccessors(mkDimensionEntries());
    const observed = entries.find((e) => e.dimension === 'observed_dim')!;
    expect(observed.reader).toBe('getObservedDim');
    expect(observed.setter).toBeUndefined();
    expect(observed.kind).toBe('observed');
    expect(
      warnings.some((w) => w.includes('observed_dim') && w.includes('不生成 setter'))
    ).toBe(true);
  });

  test('declared → reader + setter（S3-3 正向对照）', () => {
    const { entries } = deriveDimensionAccessors(mkDimensionEntries());
    const declared = entries.find((e) => e.dimension === 'declared_dim')!;
    expect(declared.reader).toBe('getDeclaredDim');
    expect(declared.setter).toBe('setDeclaredDim');
    expect(declared.kind).toBe('declared');
  });

  test('kind 缺省（undetermined）→ 只 reader + 显式降级 warning（B-1 分流）', () => {
    const { entries, warnings } = deriveDimensionAccessors(mkDimensionEntries());
    const undetermined = entries.find((e) => e.dimension === 'refund_status')!;
    expect(undetermined.kind).toBe('undetermined');
    expect(undetermined.reader).toBe('getRefundStatus');
    expect(undetermined.setter).toBeUndefined();
    expect(
      warnings.some((w) => w.includes('refund_status') && w.includes('dimension-kind-undetermined'))
    ).toBe(true);
  });

  test('snake_case 维度名 → PascalCase 访问器', () => {
    const { entries } = deriveDimensionAccessors([
      { owner: 'e', dimension: 'delivery_location', kind: 'declared', kindSource: 'derived', writers: ['role'] },
    ]);
    expect(entries[0].reader).toBe('getDeliveryLocation');
    expect(entries[0].setter).toBe('setDeliveryLocation');
  });

  test('specs.json 已记录的降级原因并入 warnings（不静默）', () => {
    const { warnings } = deriveDimensionAccessors([], [
      'dimension-kind-undetermined：维度 x（S1）无任何写入方（W(dim)=∅）',
    ]);
    expect(warnings.some((w) => w.includes('dimension-kind-undetermined'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deriveSkeletonBindings（不写文件，结构断言）
// ---------------------------------------------------------------------------

describe('deriveSkeletonBindings · dimensions 段', () => {
  test('非空维度清单 → 产出 dimensions 段（逐维度断言）', () => {
    const skeleton = deriveSkeletonBindings(
      loadModel(),
      loadSpecs(),
      { sourceEnvelope: true, sourceMigrated: false, sourceMigrationWarnings: [] },
      { dimensions: mkDimensionEntries() }
    );
    expect(skeleton.dimensions).toHaveLength(3);
    const byName = new Map(skeleton.dimensions!.map((d) => [d.dimension, d]));
    expect(byName.get('observed_dim')).toMatchObject({ reader: 'getObservedDim', kind: 'observed' });
    expect(byName.get('observed_dim')!.setter).toBeUndefined();
    expect(byName.get('declared_dim')).toMatchObject({ reader: 'getDeclaredDim', setter: 'setDeclaredDim', kind: 'declared' });
    expect(byName.get('refund_status')).toMatchObject({ kind: 'undetermined', reader: 'getRefundStatus' });
    expect(byName.get('refund_status')!.setter).toBeUndefined();
  });

  test('维度清单缺省/空 → 不产出 dimensions 段（S3-5 降级路径不改行为）', () => {
    const skeletonNoCtx = deriveSkeletonBindings(
      loadModel(),
      loadSpecs(),
      { sourceEnvelope: true, sourceMigrated: false, sourceMigrationWarnings: [] }
    );
    expect(skeletonNoCtx.dimensions).toBeUndefined();

    const skeletonEmpty = deriveSkeletonBindings(
      loadModel(),
      loadSpecs(),
      { sourceEnvelope: true, sourceMigrated: false, sourceMigrationWarnings: [] },
      { dimensions: [] }
    );
    expect(skeletonEmpty.dimensions).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// deriveBindings（CLI 入口，写文件）—— S3-2/S3-3/S3-5 grep 判据
// ---------------------------------------------------------------------------

describe('deriveBindings · 产物 grep 判据（S3-2/S3-3/S3-5）', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync('/tmp/e3-dimacc-');
    mkdirSync(`${tmpRoot}/derived`, { recursive: true });
    mkdirSync(`${tmpRoot}/protocol`, { recursive: true });
    const modelContent = readFileSync(`${FIXTURE_DIR}/approval-flow.md`, 'utf-8');
    writeFileSync(`${tmpRoot}/protocol/model.md`, modelContent, 'utf-8');
  });

  function parseModelFn(rootDir: string): SourceProtocolModel {
    return parseProtocolFile(`${rootDir}/protocol/model.md`);
  }

  function writeSpecsEnvelope(dimensions?: DimensionKindEntry[], schemaDegradedReasons?: string[]): void {
    const envelope = {
      schemaVersion: '1.0',
      generatedAt: new Date().toISOString(),
      sourceModelVersion: '1.0.0',
      specs: loadSpecs(),
    };
    if (dimensions) (envelope as Record<string, unknown>).dimensions = dimensions;
    if (schemaDegradedReasons) (envelope as Record<string, unknown>).schemaDegradedReasons = schemaDegradedReasons;
    writeFileSync(`${tmpRoot}/derived/specs.json`, JSON.stringify(envelope, null, 2), 'utf-8');
  }

  test('S3-2：observed 维度名后不出现 setter（逐维度 grep 断言）', async () => {
    writeSpecsEnvelope(mkDimensionEntries());
    const result = await deriveBindings({ rootDir: tmpRoot }, parseModelFn);
    const yaml = readFileSync(result.skeletonPath, 'utf-8');

    expect(yaml).toContain('dimensions:');

    // observed_dim 块：维度名后不得出现 setter
    const observedBlock = extractDimensionBlock(yaml, 'observed_dim');
    expect(observedBlock).not.toMatch(/setter/i);
    expect(observedBlock).toContain('reader: getObservedDim');
    expect(observedBlock).toContain('kind: observed');

    // refund_status（undetermined 降级）块：同样不得出现 setter
    const undeterminedBlock = extractDimensionBlock(yaml, 'refund_status');
    expect(undeterminedBlock).not.toMatch(/setter/i);
    expect(undeterminedBlock).toContain('kind: undetermined');
    expect(undeterminedBlock).toContain('reader: getRefundStatus');
  });

  test('S3-3：declared 维度仍正常生成 setter（正向对照）', async () => {
    writeSpecsEnvelope(mkDimensionEntries());
    const result = await deriveBindings({ rootDir: tmpRoot }, parseModelFn);
    const yaml = readFileSync(result.skeletonPath, 'utf-8');

    const declaredBlock = extractDimensionBlock(yaml, 'declared_dim');
    expect(declaredBlock).toMatch(/setter: setDeclaredDim/);
    expect(declaredBlock).toContain('reader: getDeclaredDim');
    expect(declaredBlock).toContain('kind: declared');
  });

  test('S3-2 降级显式：undetermined 维度 warning 落盘（不得静默）', async () => {
    writeSpecsEnvelope(mkDimensionEntries(), [
      'dimension-kind-undetermined：维度 refund_status（refund_order）无任何写入方（W(dim)=∅），无法机械判定 kind，显式降级（B-1 分流）',
    ]);
    const result = await deriveBindings({ rootDir: tmpRoot }, parseModelFn);
    const report = JSON.parse(readFileSync(result.reportPath, 'utf-8'));
    expect(
      report.warnings.some((w: string) => w.includes('dimension-kind-undetermined') && w.includes('refund_status'))
    ).toBe(true);
  });

  test('S3-5：无 kind 标注老模型 → 产物不产出 dimensions 段（与 S1 之前完全一致）', async () => {
    // 无 dimensions 字段的 envelope（S1 之前形态）
    writeSpecsEnvelope(undefined);
    const result = await deriveBindings({ rootDir: tmpRoot }, parseModelFn);
    const yaml = readFileSync(result.skeletonPath, 'utf-8');

    // 结构断言：不产出 dimensions 键
    expect(yaml).not.toContain('dimensions:');
    const parsed = (await import('yaml')).parse(yaml) as SkeletonBindings;
    expect('dimensions' in parsed).toBe(false);

    // 既有产物结构完整（roles/interfaces/stateMap/stats/warnings 与 S1 之前一致）
    expect((parsed as unknown as Record<string, unknown>)[SKELETON_MARKER]).toBe(true);
    expect(parsed.interfaces).toHaveLength(loadSpecs().length);
    expect(Object.keys(parsed.roles).sort()).toEqual(['applicant', 'approver', 'system']);
  });
});
