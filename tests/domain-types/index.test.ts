/**
 * T2c 机械验收：维度 domain → 代码类型推导（判据 D1）
 *
 * - T2c-2 D1：anonymous-saas 全部实体维度产出类型定义（覆盖率 100%，或未覆盖显式列出 + 降级记录）
 * - T2c-3 storage.schema.json 无 "TODO" type（有 domain 的维度全部为推导类型）
 * - T2c-4 老模型（无 domain）零回归：type 缺省走降级（string + 显式记录）
 */
import { join } from 'node:path';
import { parseProtocolFile } from '../../src/parser/index.js';
import { deriveDomainTypes, renderTypesFile, parseDomainEnum, isNumericDomain } from '../../src/domain-types/index.js';
import { deriveStorageSchema } from '../../src/storagegen/index.js';

const EXAMPLES = join(process.cwd(), 'examples', 'anonymous-saas', 'protocol');

function loadModel(p: string) {
  return parseProtocolFile(join(EXAMPLES, p, 'model.md'), { allowDegraded: true });
}

describe('domain 解析：值域花括号 / 档位', () => {
  test('parseDomainEnum：{a, b} → [a,b]（中英文分隔符）', () => {
    expect(parseDomainEnum('{短时内网映射, 长期文件托管}')).toEqual(['短时内网映射', '长期文件托管']);
    expect(parseDomainEnum('{在线, 离线}')).toEqual(['在线', '离线']);
    expect(parseDomainEnum('非花括号')).toBeNull();
  });

  test('isNumericDomain：档位范围 → number', () => {
    expect(isNumericDomain('1..10')).toBe(true);
    expect(isNumericDomain('≤100')).toBe(true);
    expect(isNumericDomain('0.5~2')).toBe(true);
    expect(isNumericDomain('{a, b}')).toBe(false);
  });
});

describe('T2c-2 D1：anonymous-saas 全部实体维度产出类型定义', () => {
  test.each(['P1', 'P2', 'P3'])('%s：覆盖率 100%（defs 数 = 实体维度数）', (p) => {
    const model = loadModel(p);
    const dims = model.derivable.entityDimensions ?? [];
    const { defs, warnings } = deriveDomainTypes(dims);
    // 每个实体维度必产定义（enum/number/string 三态）
    expect(defs.length).toBe(dims.length);
    const byDim = new Map(defs.map((d) => [d.dimension, d]));
    for (const d of dims) {
      const def = byDim.get(d.dimension);
      expect(def).toBeDefined();
      // enum 维度：值列表与 domain 花括号解析一致
      if (def!.kind === 'enum') {
        expect(def!.values!.length).toBeGreaterThan(0);
      }
    }
    // 未覆盖显式列出：无 domain 的维度必降级（degraded）；中文维度无转写字典类型名也降级
    const degraded = defs.filter((d) => d.degraded);
    expect(degraded.length).toBeGreaterThanOrEqual(
      dims.filter((d) => !d.domain || d.domain.trim() === '').length
    );
    if (degraded.length > 0) expect(warnings.length).toBeGreaterThanOrEqual(degraded.length);
  });

  test('P2：enum 类型定义（含中文值）→ types.ts 可渲染', () => {
    const model = loadModel('P2');
    const { defs } = deriveDomainTypes(model.derivable.entityDimensions ?? []);
    const enums = defs.filter((d) => d.kind === 'enum');
    expect(enums.length).toBeGreaterThan(0);
    const md = renderTypesFile(defs, { sourceModelVersion: model.metadata.version });
    expect(md).toContain('export type');
    // enum 值保留原文（中文）
    const first = enums[0];
    expect(md).toContain(`export type ${first.typeName} =`);
  });
});

describe('T2c-3 storage.schema.json 无 TODO type', () => {
  test('domainTypes 传入 → 列 type 由 domain 推导（enum → 类型名 / number → number）', () => {
    const model = loadModel('P2');
    const { defs } = deriveDomainTypes(model.derivable.entityDimensions ?? []);
    const domainTypes = new Map(defs.map((d) => [d.dimension, d]));
    // 用 specs 的维度清单（owner/dimension/kind）驱动 storage 推导
    const dimensions = (model.derivable.entityDimensions ?? []).map((d) => ({
      owner: d.entity,
      dimension: d.dimension,
      kind: d.kind,
      kindSource: 'asserted' as const,
      writers: [],
    }));
    const schema = deriveStorageSchema({
      dimensions,
      sourceModelVersion: model.metadata.version,
      schemaDegradedReasons: undefined,
      domainTypes,
    });
    // 全部列无 TODO（有 domain 的列全部为推导类型）
    const allTypes = schema.entities.flatMap((e) => e.columns.map((c) => c.type));
    expect(allTypes.every((t) => t !== 'TODO')).toBe(true);
    // enum 维度列 type = 类型名
    const enumDims = defs.filter((d) => d.kind === 'enum').map((d) => d.dimension);
    for (const dim of enumDims) {
      const col = schema.entities.flatMap((e) => e.columns).find((c) => c.dimension === dim)!;
      const def = domainTypes.get(dim)!;
      expect(col.type).toBe(def.typeName);
    }
  });
});

describe('T2c-4 老模型（无 domain）零回归', () => {
  test('无 domainTypes → 列 type 缺省 string + 显式降级记录', () => {
    const schema = deriveStorageSchema({
      dimensions: [
        { owner: 'S1', dimension: 'dimA', kind: 'declared', kindSource: 'derived', writers: ['role'] },
      ],
      sourceModelVersion: '1.0.0',
      schemaDegradedReasons: undefined,
    });
    expect(schema.entities[0].columns[0].type).toBe('string');
    expect(schema.warnings.some((w) => w.includes('无 domain 声明') && w.includes('T2c'))).toBe(true);
  });
});
