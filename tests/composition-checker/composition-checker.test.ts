import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCompositionContent } from '../../src/composition-parser/index.js';
import { parseProtocolContent } from '../../src/parser/index.js';
import {
  checkCompositionCompleteness,
  type PendingRefWithSource,
} from '../../src/composition-checker/index.js';
import type { CompositionModel, SourceProtocolModel } from '../../src/model/types.js';

const FIXTURES = join(process.cwd(), 'tests/fixtures');

function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf-8');
}

function loadBaseComposition(): CompositionModel {
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

/** 深拷贝 composition 并应用修改函数 */
function mutateComposition(
  base: CompositionModel,
  mutate: (c: CompositionModel) => void
): CompositionModel {
  const copy: CompositionModel = JSON.parse(JSON.stringify(base));
  mutate(copy);
  return copy;
}

describe('composition-checker 机械层 4 项校验', () => {
  const baseComposition = loadBaseComposition();
  const p2Model = loadP2Model();

  describe('1. 跨协议引用存在性', () => {
    test('正例：external trigger 引用 upstream → resolved', () => {
      const refs: PendingRefWithSource[] = [
        {
          sourceProtocol: 'P2',
          sourceField: 'TransitionDef.trigger',
          targetRef: 'upstream',
          refType: 'composition',
        },
      ];
      const report = checkCompositionCompleteness(baseComposition, refs, {
        subProtocolModels: [p2Model],
      });
      expect(report.crossProtocolRefResults).toHaveLength(1);
      expect(report.crossProtocolRefResults[0].resolved).toBe(true);
    });

    test('反例：external trigger 引用未知源 → 未解析', () => {
      const refs: PendingRefWithSource[] = [
        {
          sourceProtocol: 'P2',
          sourceField: 'TransitionDef.trigger',
          targetRef: 'unknown_src',
          refType: 'composition',
        },
      ];
      const report = checkCompositionCompleteness(baseComposition, refs);
      expect(report.crossProtocolRefResults[0].resolved).toBe(false);
      expect(report.mechanical.passed).toBe(false);
    });

    test('正例：crossInvariantIds 引用 CI1 → resolved', () => {
      const refs: PendingRefWithSource[] = [
        {
          sourceProtocol: 'P2',
          sourceField: 'ResourcePoolDef.crossInvariantIds',
          targetRef: 'CI1',
          refType: 'composition',
        },
      ];
      const report = checkCompositionCompleteness(baseComposition, refs);
      expect(report.crossProtocolRefResults[0].resolved).toBe(true);
    });

    test('反例：crossInvariantIds 引用 CI9 → 未解析', () => {
      const refs: PendingRefWithSource[] = [
        {
          sourceProtocol: 'P2',
          sourceField: 'ResourcePoolDef.crossInvariantIds',
          targetRef: 'CI9',
          refType: 'composition',
        },
      ];
      const report = checkCompositionCompleteness(baseComposition, refs);
      expect(report.crossProtocolRefResults[0].resolved).toBe(false);
    });

    test('反例：来源协议不在子协议清单 → 未解析', () => {
      const refs: PendingRefWithSource[] = [
        {
          sourceProtocol: 'P9',
          sourceField: 'TransitionDef.trigger',
          targetRef: 'upstream',
          refType: 'composition',
        },
      ];
      const report = checkCompositionCompleteness(baseComposition, refs);
      expect(report.crossProtocolRefResults[0].resolved).toBe(false);
      expect(report.crossProtocolRefResults[0].error).toContain('不在');
    });

    test('正例：cross_protocol 引用 port（P2）→ resolved', () => {
      const refs: PendingRefWithSource[] = [
        {
          sourceProtocol: 'P2',
          sourceField: 'SubsidiaryEntityDef.belongsTo',
          targetRef: 'port（P2）',
          refType: 'cross_protocol',
        },
      ];
      const report = checkCompositionCompleteness(baseComposition, refs, {
        subProtocolModels: [p2Model],
      });
      expect(report.crossProtocolRefResults[0].resolved).toBe(true);
    });

    test('反例：cross_protocol 引用不存在实体 → 未解析', () => {
      const refs: PendingRefWithSource[] = [
        {
          sourceProtocol: 'P2',
          sourceField: 'SubsidiaryEntityDef.belongsTo',
          targetRef: 'ghost（P2）',
          refType: 'cross_protocol',
        },
      ];
      const report = checkCompositionCompleteness(baseComposition, refs, {
        subProtocolModels: [p2Model],
      });
      expect(report.crossProtocolRefResults[0].resolved).toBe(false);
    });
  });

  describe('2. 观测接口覆盖', () => {
    test('正例：OI1 observable.object=S2 在 P2 中存在 → 通过', () => {
      const report = checkCompositionCompleteness(baseComposition, [], {
        subProtocolModels: [p2Model],
      });
      const oiIssues = report.mechanical.referenceIssues.filter((i) =>
        i.message.includes('观测接口')
      );
      expect(oiIssues).toHaveLength(0);
    });

    test('反例：observable.object 不存在 → 报错', () => {
      const composition = mutateComposition(baseComposition, (c) => {
        c.observationInterfaces[0].observable[0].object = 'S9';
      });
      const report = checkCompositionCompleteness(composition, [], {
        subProtocolModels: [p2Model],
      });
      const oiIssues = report.mechanical.referenceIssues.filter((i) =>
        i.message.includes('观测接口') && i.message.includes('S9')
      );
      expect(oiIssues.length).toBeGreaterThan(0);
    });

    test('反例：observable.protocol 不在子协议清单 → 报错', () => {
      const composition = mutateComposition(baseComposition, (c) => {
        c.observationInterfaces[0].observable[0].protocol = 'P9';
      });
      const report = checkCompositionCompleteness(composition, []);
      const oiIssues = report.mechanical.referenceIssues.filter((i) =>
        i.message.includes('观测接口') && i.message.includes('P9')
      );
      expect(oiIssues.length).toBeGreaterThan(0);
    });

    test('正例：协议ID匹配 — object=P2 → 通过', () => {
      const composition = mutateComposition(baseComposition, (c) => {
        c.observationInterfaces[0].observable[0].object = 'P2';
      });
      const report = checkCompositionCompleteness(composition, [], {
        subProtocolModels: [p2Model],
      });
      const oiIssues = report.mechanical.referenceIssues.filter((i) =>
        i.message.includes('观测接口') && i.message.includes('P2')
      );
      expect(oiIssues).toHaveLength(0);
    });

    test('正例：协议名匹配 — object=入口协议 → 通过', () => {
      const composition = mutateComposition(baseComposition, (c) => {
        c.observationInterfaces[0].observable[0].object = '入口协议';
      });
      const report = checkCompositionCompleteness(composition, [], {
        subProtocolModels: [p2Model],
      });
      const oiIssues = report.mechanical.referenceIssues.filter((i) =>
        i.message.includes('观测接口') && i.message.includes('入口协议')
      );
      expect(oiIssues).toHaveLength(0);
    });

    test('正例：状态名匹配 — object=运行中 → 通过', () => {
      const composition = mutateComposition(baseComposition, (c) => {
        c.observationInterfaces[0].observable[0].object = '运行中';
      });
      const report = checkCompositionCompleteness(composition, [], {
        subProtocolModels: [p2Model],
      });
      const oiIssues = report.mechanical.referenceIssues.filter((i) =>
        i.message.includes('观测接口') && i.message.includes('运行中')
      );
      expect(oiIssues).toHaveLength(0);
    });

    test('反例：object 无法匹配任何层级 → 报错', () => {
      const composition = mutateComposition(baseComposition, (c) => {
        c.observationInterfaces[0].observable[0].object = '不存在的名称';
      });
      const report = checkCompositionCompleteness(composition, [], {
        subProtocolModels: [p2Model],
      });
      const oiIssues = report.mechanical.referenceIssues.filter((i) =>
        i.message.includes('观测接口') && i.message.includes('不存在的名称')
      );
      expect(oiIssues.length).toBeGreaterThan(0);
    });
  });

  describe('3. 切面约束追溯', () => {
    test('正例：tracesToInvariantId=CI1 存在 → 通过', () => {
      const report = checkCompositionCompleteness(baseComposition, []);
      const facetIssues = report.mechanical.referenceIssues.filter((i) =>
        i.message.includes('tracesToInvariantId')
      );
      expect(facetIssues).toHaveLength(0);
    });

    test('反例：tracesToInvariantId=CI9 不存在 → 报错', () => {
      const composition = mutateComposition(baseComposition, (c) => {
        c.objectStateFacets[0].crossFacetConstraints[0].tracesToInvariantId = 'CI9';
      });
      const report = checkCompositionCompleteness(composition, []);
      const facetIssues = report.mechanical.referenceIssues.filter((i) =>
        i.message.includes('tracesToInvariantId') && i.message.includes('CI9')
      );
      expect(facetIssues.length).toBeGreaterThan(0);
    });
  });

  describe('4. 安全前提声明完整性', () => {
    test('正例：SA1 全部字段非空 → 通过', () => {
      const report = checkCompositionCompleteness(baseComposition, []);
      const saIssues = report.mechanical.fieldIssues.filter((i) =>
        i.message.includes('安全前提')
      );
      expect(saIssues).toHaveLength(0);
    });

    test('反例：assumption 为空 → 报错', () => {
      const composition = mutateComposition(baseComposition, (c) => {
        c.securityAssumptions[0].assumption = '';
      });
      const report = checkCompositionCompleteness(composition, []);
      const saIssues = report.mechanical.fieldIssues.filter(
        (i) =>
          i.message.includes('安全前提') && i.message.includes('assumption')
      );
      expect(saIssues.length).toBeGreaterThan(0);
    });

    test('反例：impactIfViolated 为空 → 报错', () => {
      const composition = mutateComposition(baseComposition, (c) => {
        c.securityAssumptions[0].impactIfViolated = '';
      });
      const report = checkCompositionCompleteness(composition, []);
      const saIssues = report.mechanical.fieldIssues.filter(
        (i) =>
          i.message.includes('安全前提') &&
          i.message.includes('impactIfViolated')
      );
      expect(saIssues.length).toBeGreaterThan(0);
    });
  });

  describe('5. 组合层结构完备性', () => {
    test('正例：依赖图 edges 与 span 与 protocol 全部合法 → 通过', () => {
      const report = checkCompositionCompleteness(baseComposition, []);
      const structIssues = report.mechanical.structuralIssues.filter(
        (i) => i.severity === 'error'
      );
      expect(structIssues).toHaveLength(0);
    });

    test('反例：依赖图 edge.from 不在子协议清单 → 报错', () => {
      const composition = mutateComposition(baseComposition, (c) => {
        c.dependencyGraph.edges[0].from = 'P9';
      });
      const report = checkCompositionCompleteness(composition, []);
      const edgeIssues = report.mechanical.structuralIssues.filter((i) =>
        i.message.includes('edge.from')
      );
      expect(edgeIssues.length).toBeGreaterThan(0);
    });

    test('反例：跨协议不变量 span 含未知协议 → 报错', () => {
      const composition = mutateComposition(baseComposition, (c) => {
        c.crossInvariants[0].span = ['P9'];
      });
      const report = checkCompositionCompleteness(composition, []);
      const spanIssues = report.mechanical.structuralIssues.filter((i) =>
        i.message.includes('span')
      );
      expect(spanIssues.length).toBeGreaterThan(0);
    });

    test('反例：externalDependencies.protocol 不在子协议清单 → 报错', () => {
      const composition = mutateComposition(baseComposition, (c) => {
        c.externalDependencies[0].protocol = 'P9';
      });
      const report = checkCompositionCompleteness(composition, []);
      const depIssues = report.mechanical.structuralIssues.filter((i) =>
        i.message.includes('外部依赖') && i.message.includes('protocol')
      );
      expect(depIssues.length).toBeGreaterThan(0);
    });

    test('反例：direction=query 未声明 queryObservationInterfaceId → 报错', () => {
      const composition = mutateComposition(baseComposition, (c) => {
        c.externalDependencies[0].direction = 'query';
        c.externalDependencies[0].queryObservationInterfaceId = undefined;
      });
      const report = checkCompositionCompleteness(composition, []);
      const queryIssues = report.mechanical.structuralIssues.filter((i) =>
        i.message.includes('queryObservationInterfaceId')
      );
      expect(queryIssues.length).toBeGreaterThan(0);
    });
  });

  describe('整体校验', () => {
    test('composition-saas.md 无 pendingRefs → 机械层通过', () => {
      const report = checkCompositionCompleteness(baseComposition, [], {
        subProtocolModels: [p2Model],
      });
      expect(report.mechanical.passed).toBe(true);
      expect(report.passed).toBe(true);
      expect(report.crossProtocolRefResults).toHaveLength(0);
    });
  });
});
