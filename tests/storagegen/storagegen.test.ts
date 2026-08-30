/**
 * X19（G7/S3）：derive-storage —— 实体维度 → 存储 schema 骨架（纯机械）。
 *
 * 验收映射：
 * - S3-4：对两个演示实例（food-delivery / fulfillment-payment P1、P2）产出的 schema
 *   覆盖全部实体维度（覆盖率 100%，对应 G8 D3；food-delivery 4 维度需全部有存储落点）
 * - 降级显式：kind 缺省（dimension-kind-undetermined）维度列照常生成，kind='undetermined'
 *   标注 + warnings 记录（B-1 分流，不得静默）
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  deriveStorage,
  deriveStorageSchema,
  STORAGE_SCHEMA_KIND,
} from '../../src/storagegen/index.js';
import type { DimensionKindEntry } from '../../src/model/dimension-kind.js';

const EXAMPLES_DIR = '/work/protochain/examples';

// ---------------------------------------------------------------------------
// deriveStorageSchema（纯函数单测）
// ---------------------------------------------------------------------------

describe('deriveStorageSchema（纯机械）', () => {
  test('food-delivery 维度清单（4 维度，kind 全缺省）→ 覆盖率 100%，全部有存储落点（S3-4 核心）', () => {
    const dimensions: DimensionKindEntry[] = [
      { owner: 'refund_order', dimension: 'refund_status', writers: [] },
      { owner: 'refund_order', dimension: 'refund_amount', writers: [] },
      { owner: 'rider_assignment', dimension: 'rider_id', writers: [] },
      { owner: 'rider_assignment', dimension: 'delivery_location', writers: [] },
    ];
    const schema = deriveStorageSchema({
      dimensions,
      sourceModelVersion: '1.0.0',
      schemaDegradedReasons: [
        'dimension-kind-undetermined：维度 refund_status（refund_order）无任何写入方（W(dim)=∅），无法机械判定 kind，显式降级（B-1 分流）',
        'dimension-kind-undetermined：维度 refund_amount（refund_order）无任何写入方（W(dim)=∅），无法机械判定 kind，显式降级（B-1 分流）',
        'dimension-kind-undetermined：维度 rider_id（rider_assignment）无任何写入方（W(dim)=∅），无法机械判定 kind，显式降级（B-1 分流）',
        'dimension-kind-undetermined：维度 delivery_location（rider_assignment）无任何写入方（W(dim)=∅），无法机械判定 kind，显式降级（B-1 分流）',
      ],
    });

    expect(schema.kind).toBe(STORAGE_SCHEMA_KIND);
    expect(schema.dimensionCount).toBe(4);
    expect(schema.coveredDimensionCount).toBe(4);
    expect(schema.coverageRate).toBe(1);
    expect(schema.entities).toHaveLength(2);

    const refund = schema.entities.find((e) => e.entity === 'refund_order')!;
    expect(refund.dimensionCount).toBe(2);
    expect(refund.columns.map((c) => c.dimension).sort()).toEqual(['refund_amount', 'refund_status']);
    for (const col of refund.columns) {
      expect(col.column).toBe(col.dimension); // 列名 = 维度名
      expect(col.kind).toBe('undetermined'); // 显式降级标注
      expect(col.type).toBe('TODO');
    }

    const rider = schema.entities.find((e) => e.entity === 'rider_assignment')!;
    expect(rider.dimensionCount).toBe(2);
    expect(rider.columns.map((c) => c.dimension).sort()).toEqual(['delivery_location', 'rider_id']);

    // 降级显式：schemaDegradedReasons 搬运 + warnings 逐维度记录
    expect(schema.schemaDegradedReasons).toHaveLength(4);
    expect(schema.warnings.filter((w) => w.includes('dimension-kind-undetermined')).length).toBeGreaterThanOrEqual(4);
  });

  test('declared / observed 维度：列 kind 原样搬运（存储与 kind 无关，全量覆盖）', () => {
    const schema = deriveStorageSchema({
      dimensions: [
        { owner: 'S1', dimension: 'dimA', kind: 'declared', kindSource: 'derived', writers: ['role'] },
        { owner: 'S1', dimension: 'dimB', kind: 'observed', kindSource: 'derived', writers: ['system'] },
      ],
      sourceModelVersion: '1.0.0',
      schemaDegradedReasons: undefined,
    });
    expect(schema.dimensionCount).toBe(2);
    expect(schema.coverageRate).toBe(1);
    const cols = schema.entities[0].columns;
    expect(cols.find((c) => c.dimension === 'dimA')).toMatchObject({ kind: 'declared', type: 'TODO' });
    expect(cols.find((c) => c.dimension === 'dimB')).toMatchObject({ kind: 'observed', type: 'TODO' });
  });

  test('无维度声明（dimensions 空/缺省）→ 空 entities + 显式 warning（空集真空覆盖）', () => {
    const schema = deriveStorageSchema({
      dimensions: [],
      sourceModelVersion: '1.0.0',
      schemaDegradedReasons: undefined,
    });
    expect(schema.dimensionCount).toBe(0);
    expect(schema.coveredDimensionCount).toBe(0);
    expect(schema.coverageRate).toBe(1); // 空集真空成立
    expect(schema.entities).toEqual([]);
    expect(schema.warnings.some((w) => w.includes('无维度声明'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deriveStorage（CLI 入口，写文件）—— 两个演示实例实跑（S3-4）
// ---------------------------------------------------------------------------

describe('deriveStorage（CLI 入口）· 两个演示实例（S3-4）', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync('/tmp/e3-storagegen-');
    mkdirSync(`${tmpRoot}/derived`, { recursive: true });
  });

  test('food-delivery：specs.json 的 4 维度全部有存储落点，覆盖率 100%', async () => {
    const specsRaw = readFileSync(
      join(EXAMPLES_DIR, 'food-delivery', 'derived', 'specs.json'),
      'utf-8'
    );
    writeFileSync(`${tmpRoot}/derived/specs.json`, specsRaw, 'utf-8');

    const result = await deriveStorage({ rootDir: tmpRoot });
    expect(result.schemaPath).toBe(`${tmpRoot}/derived/storage.schema.json`);
    expect(existsSync(result.schemaPath)).toBe(true);

    const s = result.schema;
    expect(s.dimensionCount).toBe(4);
    expect(s.coveredDimensionCount).toBe(4);
    expect(s.coverageRate).toBe(1);
    const allColumns = s.entities.flatMap((e) => e.columns.map((c) => c.dimension)).sort();
    expect(allColumns).toEqual(['delivery_location', 'refund_amount', 'refund_status', 'rider_id']);
    // 全部 kind 缺省 → 显式降级标注 + 记录
    for (const col of s.entities.flatMap((e) => e.columns)) {
      expect(col.kind).toBe('undetermined');
    }
    expect(s.schemaDegradedReasons).toHaveLength(4);
    expect(s.warnings.some((w) => w.includes('dimension-kind-undetermined'))).toBe(true);
  });

  test('fulfillment-payment P1：无维度声明 → 空 entities + 覆盖率 1（真空成立）', async () => {
    const specsRaw = readFileSync(
      join(EXAMPLES_DIR, 'fulfillment-payment', 'protocol', 'P1', 'derived', 'specs.json'),
      'utf-8'
    );
    writeFileSync(`${tmpRoot}/derived/specs.json`, specsRaw, 'utf-8');

    const result = await deriveStorage({ rootDir: tmpRoot });
    expect(result.schema.dimensionCount).toBe(0);
    expect(result.schema.coverageRate).toBe(1);
    expect(result.schema.entities).toEqual([]);
  });

  test('fulfillment-payment P2：无维度声明 → 空 entities + 覆盖率 1（真空成立）', async () => {
    const specsRaw = readFileSync(
      join(EXAMPLES_DIR, 'fulfillment-payment', 'protocol', 'P2', 'derived', 'specs.json'),
      'utf-8'
    );
    writeFileSync(`${tmpRoot}/derived/specs.json`, specsRaw, 'utf-8');

    const result = await deriveStorage({ rootDir: tmpRoot });
    expect(result.schema.dimensionCount).toBe(0);
    expect(result.schema.coverageRate).toBe(1);
    expect(result.schema.entities).toEqual([]);
  });

  test('specs.json 不存在 → 抛错', async () => {
    await expect(deriveStorage({ rootDir: tmpRoot })).rejects.toThrow(/specs\.json 不存在/);
  });

  test('已存在 schema + 未传 --force → 抛错；--force 覆盖', async () => {
    const specsRaw = readFileSync(
      join(EXAMPLES_DIR, 'food-delivery', 'derived', 'specs.json'),
      'utf-8'
    );
    writeFileSync(`${tmpRoot}/derived/specs.json`, specsRaw, 'utf-8');
    writeFileSync(`${tmpRoot}/derived/storage.schema.json`, 'old', 'utf-8');

    await expect(deriveStorage({ rootDir: tmpRoot })).rejects.toThrow(/存储 schema 已存在/);

    const result = await deriveStorage({ rootDir: tmpRoot, force: true });
    expect(result.schema.dimensionCount).toBe(4);
    expect(readFileSync(result.schemaPath, 'utf-8')).not.toBe('old');
  });
});
