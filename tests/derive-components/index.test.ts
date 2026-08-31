/**
 * T1b 机械验收：derive-components 组件模型骨架推导
 *
 * - T1b-2 anonymous-saas（P1/P2/P3）derive-components 产物：候选组件/表/传输覆盖全部
 *   接口/维度/关系（覆盖率 100% 或未覆盖显式列出）；计数与协议模型一致
 * - T1b-3 候选骨架确定性：同一模型两次运行产物一致（幂等）
 * - T1b-4 骨架语法可被 T1a parser 解析（round-trip 无错）
 */
import { join } from 'node:path';
import { parseProtocolFile } from '../../src/parser/index.js';
import { parseComponentsContent } from '../../src/parser/components.js';
import {
  deriveComponentsSkeleton,
  renderSkeletonMarkdown,
} from '../../src/derive-components/index.js';

const EXAMPLES = join(process.cwd(), 'examples', 'anonymous-saas', 'protocol');

function loadModel(p: string) {
  return parseProtocolFile(join(EXAMPLES, p, 'model.md'), { allowDegraded: true });
}

describe('T1b-2 覆盖：anonymous-saas 子协议骨架覆盖全部接口/维度/关系', () => {
  test.each(['P1', 'P2', 'P3'])('%s：接口/维度/关系覆盖率 100%（或未覆盖显式列出）', (p) => {
    const model = loadModel(p);
    const s = deriveComponentsSkeleton(model, { dict: {} });
    const ops = model.derivable.operations ?? [];
    const dims = model.derivable.entityDimensions ?? [];
    const candidateRelations = (model.derivable.relations ?? []).filter(
      (r) => r.type === '运行依赖' || r.type === '派生'
    );
    // 计数与协议模型一致（接口 = 操作数；维度 = 实体维度行数）
    expect(s.coverage.interfaceTotal).toBe(ops.length);
    expect(s.coverage.dimensionTotal).toBe(dims.length);
    expect(s.coverage.relationTotal).toBe(candidateRelations.length);
    // 覆盖率 100% 或未覆盖显式列出（不静默）
    const c = s.coverage;
    const interfaceFull = c.interfaceCovered === c.interfaceTotal;
    const dimFull = c.dimensionCovered === c.dimensionTotal;
    const relFull = c.relationCovered === c.relationTotal;
    if (!interfaceFull) expect(c.unmappedInterfaces.length).toBeGreaterThan(0);
    if (!dimFull) expect(c.unmappedDimensions.length).toBeGreaterThan(0);
    if (!relFull) expect(c.unmappedRelations.length).toBeGreaterThan(0);
    // 未覆盖接口数 = 总数 - 覆盖数
    expect(c.unmappedInterfaces.length).toBe(c.interfaceTotal - c.interfaceCovered);
    expect(c.unmappedDimensions.length).toBe(c.dimensionTotal - c.dimensionCovered);
    expect(c.unmappedRelations.length).toBe(c.relationTotal - c.relationCovered);
    // 骨架条目都带 derived 标注
    for (const d of s.components) {
      expect(d.kindSource).toBe('derived');
      expect(d.confirmed).toBe(false);
    }
    // 接口契约：method 默认 POST，observed 触发 → GET
    for (const ct of s.contracts) {
      const op = ops.find((o) => o.name === ct.interface);
      if (op) {
        expect(ct.method).toBe(op.triggerType === 'observed' ? 'GET' : 'POST');
        expect(ct.path).toBeTruthy();
      }
    }
  });

  test('P2：契约 path 由 action 转写（字典空 → 保留原文片段 + 降级记录）', () => {
    const model = loadModel('P2');
    const s = deriveComponentsSkeleton(model, { dict: {} });
    // 取 P2 首个操作的契约
    const op = (model.derivable.operations ?? [])[0];
    const contract = s.contracts.find((ct) => ct.interface === op.name);
    expect(contract).toBeDefined();
    expect(contract!.path).toBeTruthy();
    expect(contract!.path!.startsWith('/')).toBe(true);
  });
});

describe('T1b-3 幂等：同一模型两次运行产物一致', () => {
  test.each(['P1', 'P2', 'P3'])('%s：两次推导 deepEqual（排除 generatedAt）', (p) => {
    const model = loadModel(p);
    const a = deriveComponentsSkeleton(model);
    const b = deriveComponentsSkeleton(model);
    const strip = (s: ReturnType<typeof deriveComponentsSkeleton>) => {
      const { generatedAt: _g, ...rest } = s;
      return rest;
    };
    expect(strip(a)).toEqual(strip(b));
  });
});

describe('T1b-4 round-trip：骨架语法可被 T1a parser 解析', () => {
  test.each(['P1', 'P2', 'P3'])('%s：components.skeleton.md 可被 parseComponentsContent 解析', (p) => {
    const model = loadModel(p);
    const s = deriveComponentsSkeleton(model);
    const md = renderSkeletonMarkdown(s, { name: model.metadata.name, version: model.metadata.version });
    const parsed = parseComponentsContent(md, 'derived/components.skeleton.md');
    // 组件定义/契约 round-trip（额外字段 kindSource/confirmed 被 parser 忽略）
    expect(parsed.components).toHaveLength(s.components.length);
    expect(parsed.contracts).toHaveLength(s.contracts.length);
    expect(parsed.mapping.interfaceImplementations).toHaveLength(
      s.mapping.interfaceImplementations?.length ?? 0
    );
    expect(parsed.mapping.dimensionStorage).toHaveLength(s.mapping.dimensionStorage?.length ?? 0);
    // 组件名 round-trip 一致
    for (let i = 0; i < s.components.length; i++) {
      expect(parsed.components![i].name).toBe(s.components[i].name);
    }
  });
});
