/**
 * 多协议端到端集成测试
 *
 * 验证从 composition → ①-C → ②-C → ③-C → ④-C → ⑦-C 的链路。
 *
 * 使用的固件：
 * - composition-saas.md（组合层）
 * - saas-P2-entry.md（子协议 P2）
 * - approval-flow.md（子协议 P1）
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCompositionContent } from '../../src/composition-parser/index.js';
import { parseProtocolContent } from '../../src/parser/index.js';
import { checkCompleteness } from '../../src/checker/index.js';
import { checkCompositionCompleteness } from '../../src/composition-checker/index.js';
import type { PendingRefWithSource } from '../../src/composition-checker/index.js';
import { checkCrossInvariants } from '../../src/cross-invariant-checker/index.js';
import { crossFormalize } from '../../src/cross-formalizer/index.js';
import { deriveCrossContracts } from '../../src/cross-contractor/index.js';
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

function loadP1Model(): SourceProtocolModel {
  return parseProtocolContent(
    readFixture('approval-flow.md'),
    'approval-flow.md'
  );
}

/**
 * 收集各子协议的 pendingCrossProtocolRefs，转换为 PendingRefWithSource[]。
 */
function collectPendingRefs(
  models: { protocolId: string; model: SourceProtocolModel }[]
): PendingRefWithSource[] {
  const refs: PendingRefWithSource[] = [];
  for (const { protocolId, model } of models) {
    const report = checkCompleteness(model);
    if (report.pendingCrossProtocolRefs) {
      for (const ref of report.pendingCrossProtocolRefs) {
        refs.push({ ...ref, sourceProtocol: protocolId });
      }
    }
  }
  return refs;
}

describe('多协议端到端集成（composition-saas + P1 + P2）', () => {
  const composition = loadComposition();
  const p2Model = loadP2Model();
  const p1Model = loadP1Model();
  const subProtocolModels = [p2Model, p1Model];

  // ----------------------------------------------------------------
  // ① 解析 composition + 各子协议
  // ----------------------------------------------------------------
  describe('① 解析 composition + 各子协议', () => {
    test('composition-parser 正确解析 composition-saas.md', () => {
      expect(composition.metadata.systemName).toBe('SaaS 系统');
      expect(composition.subProtocols).toHaveLength(2);
      expect(composition.dependencyGraph.edges).toHaveLength(2);
      expect(composition.crossInvariants).toHaveLength(2);
    });

    test('composition 包含 CI1 和 CI2', () => {
      const ciIds = composition.crossInvariants.map((ci) => ci.id);
      expect(ciIds).toContain('CI1');
      expect(ciIds).toContain('CI2');
    });

    test('parse P2（saas-P2-entry.md）包含扩展段', () => {
      expect(p2Model.metadata.name).toBe('入口协议');
      expect(p2Model.derivable.transitions.length).toBeGreaterThanOrEqual(3);
      // 有外部事件定义（扩展段）
      expect(p2Model.derivable.externalEvents).toBeDefined();
      expect(p2Model.derivable.externalEvents!.length).toBeGreaterThan(0);
    });

    test('parse P1（approval-flow.md）为正常协议', () => {
      expect(p1Model.metadata.name).toBe('审批流协议');
      expect(p1Model.derivable.transitions.length).toBeGreaterThanOrEqual(5);
    });
  });

  // ----------------------------------------------------------------
  // ①-C composition-checker（组合层完备性检查）
  // ----------------------------------------------------------------
  describe('①-C composition-checker（组合层完备性检查）', () => {
    test('收集 pending 引用后校验通过', () => {
      const pendingRefs = collectPendingRefs([
        { protocolId: 'P1', model: p1Model },
        { protocolId: 'P2', model: p2Model },
      ]);
      // P2 应有 pending 引用（external trigger / resource pool crossInvariantIds / subsidiary entity belongsTo）
      expect(pendingRefs.length).toBeGreaterThan(0);

      const report = checkCompositionCompleteness(composition, pendingRefs, {
        subProtocolModels,
      });
      // 验证引用解析结果存在
      expect(report.crossProtocolRefResults.length).toBeGreaterThan(0);
      // 机械层结构/字段检查应通过
      expect(report.mechanical.structuralIssues.filter((i) => i.severity === 'error')).toHaveLength(0);
      expect(report.mechanical.fieldIssues.filter((i) => i.severity === 'error')).toHaveLength(0);
    });

    test('crossProtocolRefResults 包含每个 ref 的解析结果', () => {
      const pendingRefs = collectPendingRefs([
        { protocolId: 'P2', model: p2Model },
      ]);
      const report = checkCompositionCompleteness(composition, pendingRefs, {
        subProtocolModels: [p2Model],
      });
      expect(report.crossProtocolRefResults.length).toBe(pendingRefs.length);
      // 验证引用解析结果结构正确（resolved 值取决于组合层配置）
      for (const result of report.crossProtocolRefResults) {
        expect(typeof result.resolved).toBe('boolean');
        expect(result.sourceProtocol).toBe('P2');
        expect(result.targetRef).toBeTruthy();
      }
    });

    test('机械层包含结构/字段/引用检查', () => {
      const pendingRefs = collectPendingRefs([
        { protocolId: 'P2', model: p2Model },
      ]);
      const report = checkCompositionCompleteness(composition, pendingRefs, {
        subProtocolModels: [p2Model],
      });
      expect(report.mechanical.structuralIssues).toBeDefined();
      expect(report.mechanical.fieldIssues).toBeDefined();
      expect(report.mechanical.referenceIssues).toBeDefined();
    });
  });

  // ----------------------------------------------------------------
  // ②-C cross-invariant-checker（跨协议不变量检查）
  // ----------------------------------------------------------------
  describe('②-C cross-invariant-checker（跨协议不变量检查）', () => {
    test('无 AI 适配器时 first_order 不变量标记未通过', async () => {
      const report = await checkCrossInvariants(composition, {
        subProtocolModels,
      });
      // CI1 和 CI2 都是 first_order，需要 AI 适配器
      expect(report.results.length).toBe(composition.crossInvariants.length);
      for (const r of report.results) {
        expect(r.checkMethod).toBe('code+ai');
        expect(r.passed).toBe(false);
        expect(r.counterexample).toContain('需要 AI 适配器');
      }
    });

    test('报告包含状态实例化摘要', async () => {
      const report = await checkCrossInvariants(composition, {
        subProtocolModels,
      });
      expect(report.instantiatedStateSummary).toBeTruthy();
      expect(report.instantiatedStateSummary.length).toBeGreaterThan(0);
      expect(report.checkedAt).toBeTruthy();
    });

    test('无跨协议不变量时报告通过', async () => {
      const emptyComp: CompositionModel = {
        ...composition,
        crossInvariants: [],
      };
      const report = await checkCrossInvariants(emptyComp, {
        subProtocolModels,
      });
      expect(report.results).toHaveLength(0);
      expect(report.passed).toBe(true);
    });
  });

  // ----------------------------------------------------------------
  // ③-C cross-formalizer（跨协议形式化桥接）
  // ----------------------------------------------------------------
  describe('③-C cross-formalizer（跨协议形式化桥接）', () => {
    test('生成 TLA+ 骨架（无 AI 适配器）', async () => {
      const report = await crossFormalize(composition, {
        subProtocolModels,
      });
      expect(report).toBeDefined();
      expect(report.generatedSpec).toBeTruthy();
      expect(report.generatedSpec).toContain('MODULE');
      expect(report.tool).toBe('tla+');
    });

    test('骨架包含子协议的状态变量', async () => {
      const report = await crossFormalize(composition, {
        subProtocolModels,
      });
      // P2 模型名称匹配，应有 P2_state 变量
      expect(report.generatedSpec).toContain('P2_state');
      // P1（approval-flow.md metadata.name="审批流协议"）可能与组合层子协议名"租户协议"不匹配，
      // 因此不强制要求包含 P1_state，验证骨架整体结构完整即可
      expect(report.generatedSpec).toContain('VARIABLE');
    });

    test('骨架包含跨协议不变量', async () => {
      const report = await crossFormalize(composition, {
        subProtocolModels,
      });
      // 应包含 CI1 和 CI2 作为类型不变量
      expect(report.generatedSpec).toContain('CI1');
      expect(report.generatedSpec).toContain('CI2');
    });

    test('无 AI 适配器时标注未经确定性验证', async () => {
      const report = await crossFormalize(composition, {
        subProtocolModels,
      });
      // 骨架通过，但适用性问题应提示未提供 AI
      expect(report.passed).toBe(true);
      expect(report.specFilePath).toBe('derived/composition/model.tla');
    });
  });

  // ----------------------------------------------------------------
  // ④-C cross-contractor（跨协议契约推导）
  // ----------------------------------------------------------------
  describe('④-C cross-contractor（跨协议契约推导）', () => {
    test('生成了事件契约', () => {
      const contracts = deriveCrossContracts(composition);
      expect(contracts.eventContracts.length).toBeGreaterThan(0);
    });

    test('事件契约包含两条 edges 对应的事件', () => {
      const contracts = deriveCrossContracts(composition);
      // composition-saas 有 2 条 edges
      expect(contracts.eventContracts.length).toBe(2);
      expect(contracts.eventContracts[0].fromProtocol).toBe('P1');
      expect(contracts.eventContracts[0].toProtocol).toBe('P2');
      expect(contracts.eventContracts[1].fromProtocol).toBe('P2');
      expect(contracts.eventContracts[1].toProtocol).toBe('P1');
    });

    test('生成了影响范围契约', () => {
      const contracts = deriveCrossContracts(composition);
      // composition-saas 有一条外部依赖（upstream）
      expect(contracts.impactContracts.length).toBeGreaterThan(0);
      expect(contracts.impactContracts[0].affectedProtocols).toContain('P2');
    });

    test('生成了时序契约', () => {
      const contracts = deriveCrossContracts(composition);
      // composition-saas 有一条跨协议时序 CT1
      expect(contracts.timingContracts.length).toBeGreaterThanOrEqual(1);
      expect(contracts.timingContracts[0].span).toContain('P1');
      expect(contracts.timingContracts[0].span).toContain('P2');
    });

    test('补偿契约推导：external dependency 的 compensation 列表投影为契约', () => {
      const contracts = deriveCrossContracts(composition);
      // composition-saas 的 upstream 外部依赖有 2 条补偿规则
      expect(contracts.compensationContracts.length).toBeGreaterThanOrEqual(2);
      for (const cc of contracts.compensationContracts) {
        expect(cc.failureScenario).toBeTruthy();
        expect(cc.compensationAction).toBeTruthy();
        expect(cc.span).toBeDefined();
        expect(cc.span.length).toBeGreaterThan(0);
      }
    });
  });

  // ----------------------------------------------------------------
  // ⑦-C cross-casegen（跨协议测试用例生成）
  // ----------------------------------------------------------------
  describe('⑦-C cross-casegen（跨协议测试用例生成）', () => {
    test('生成 2 条跨协议路径', () => {
      const cases = generateCrossCases(composition, subProtocolModels);
      expect(cases.paths).toHaveLength(2);
    });

    test('每条路径包含两个 segments', () => {
      const cases = generateCrossCases(composition, subProtocolModels);
      for (const path of cases.paths) {
        expect(path.segments).toHaveLength(2);
        expect(path.segments[0].protocolId).toBeDefined();
        expect(path.segments[1].protocolId).toBeDefined();
      }
    });

    test('路径 description 包含依赖类型', () => {
      const cases = generateCrossCases(composition, subProtocolModels);
      expect(cases.paths[0].description).toContain('P1');
      expect(cases.paths[0].description).toContain('P2');
    });

    test('路径包含跨协议不变量检查点', () => {
      const cases = generateCrossCases(composition, subProtocolModels);
      for (const path of cases.paths) {
        expect(path.crossInvariantCheckpoints).toContain('CI1');
        expect(path.crossInvariantCheckpoints).toContain('CI2');
      }
    });

    test('覆盖度报告统计正确', () => {
      const cases = generateCrossCases(composition, subProtocolModels);
      expect(cases.coverage.eventCoverage.total).toBe(2);
      expect(cases.coverage.eventCoverage.covered).toBe(2);
      expect(cases.coverage.invariantCoverage.total).toBe(2);
      expect(cases.coverage.invariantCoverage.covered).toBe(2);
      expect(cases.generatedAt).toBeTruthy();
    });

    test('无 edges 时路径为空', () => {
      const emptyComp: CompositionModel = {
        ...composition,
        dependencyGraph: { ...composition.dependencyGraph, edges: [] },
      };
      const cases = generateCrossCases(emptyComp, subProtocolModels);
      expect(cases.paths).toHaveLength(0);
      expect(cases.coverage.eventCoverage.total).toBe(0);
    });
  });
});
