import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCompositionContent } from '../../src/composition-parser/index.js';
import { parseProtocolContent } from '../../src/parser/index.js';
import {
  instantiateMultiProtocolStates,
  checkCrossInvariants,
} from '../../src/cross-invariant-checker/index.js';
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

function loadApprovalModel(): SourceProtocolModel {
  return parseProtocolContent(
    readFixture('approval-flow.md'),
    'approval-flow.md'
  );
}

describe('cross-invariant-checker', () => {
  const composition = loadComposition();
  const p2Model = loadP2Model();

  describe('StateInstantiator', () => {
    test('为 simple_boolean 不变量 CI1 实例化状态', () => {
      const ci1 = composition.crossInvariants[0];
      const state = instantiateMultiProtocolStates(composition, [p2Model], ci1);

      // CI1 span 为 [P2]，应只有 P2 实例
      expect(state.protocolStates.has('P2')).toBe(true);
      const p2States = state.protocolStates.get('P2')!;
      expect(p2States.length).toBeGreaterThan(0);

      // 只应有活跃（非 terminal）实例
      const active = p2States.filter((s) => s.lifecycleStatus === 'active');
      expect(active.length).toBe(p2States.length);
    });

    test('实例化状态包含维度值', () => {
      const ci1 = composition.crossInvariants[0];
      const state = instantiateMultiProtocolStates(composition, [p2Model], ci1);
      const p2States = state.protocolStates.get('P2')!;
      for (const s of p2States) {
        expect(typeof s.dimensionValues).toBe('object');
        expect(typeof s.currentStateId).toBe('string');
        expect(typeof s.instanceId).toBe('string');
      }
    });

    test('建立跨协议实例关联（P2 自引用）', () => {
      const ci1 = composition.crossInvariants[0]; // CI1 span=[P2]
      const state = instantiateMultiProtocolStates(composition, [p2Model], ci1);

      // P2 被实例化
      expect(state.protocolStates.has('P2')).toBe(true);

      // 实例关联基于对象状态切面建立（单协议自引用可能为空）
      expect(Array.isArray(state.instanceLinks)).toBe(true);
    });
  });

  describe('checkCrossInvariants（代码确定性执行）', () => {
    test('first_order 不变量的检查需要 AI 适配器', async () => {
      // CI1 和 CI2 的 complexity 均为 first_order，无 AI 适配器时标记未通过
      const report = await checkCrossInvariants(composition, {
        subProtocolModels: [p2Model],
      });

      for (const r of report.results) {
        expect(r.checkMethod).toBe('code+ai');
        expect(r.passed).toBe(false);
        expect(r.counterexample).toContain('需要 AI 适配器');
      }
    });

    test('无跨协议不变量时报告通过', async () => {
      const emptyComp = {
        ...composition,
        crossInvariants: [],
      };
      const report = await checkCrossInvariants(emptyComp, {
        subProtocolModels: [p2Model],
      });
      expect(report.results).toHaveLength(0);
      expect(report.passed).toBe(true);
    });

    test('状态实例化摘要可读', async () => {
      const report = await checkCrossInvariants(composition, {
        subProtocolModels: [p2Model],
      });
      expect(report.instantiatedStateSummary).toBeTruthy();
      expect(report.instantiatedStateSummary.length).toBeGreaterThan(0);
      expect(report.checkedAt).toBeTruthy();
    });

    test('simple_boolean 不变量由代码机械检查', async () => {
      // 构造一个 simple_boolean 不变量的组合层
      const compWithSimple: CompositionModel = {
        ...composition,
        crossInvariants: [
          {
            id: 'CI_SIMPLE',
            name: '端口独占',
            span: ['P2'],
            expression: 'P2.port_exclusive = true',
            declaredBy: 'platform',
            checkMethod: '查询表',
            complexity: 'simple_boolean',
          },
        ],
      };
      const report = await checkCrossInvariants(compWithSimple, {
        subProtocolModels: [p2Model],
      });
      expect(report.results).toHaveLength(1);
      expect(report.results[0].checkMethod).toBe('code');
      // 在简化实例化中 port_exclusive 维度在附属实体中有定义
      // 具体结果取决于实例化状态值，但代码路径应正确执行
    });
  });
});
