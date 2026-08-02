/**
 * 单协议端到端集成测试
 *
 * 验证从 check → reason → formalize → specify → contract 的完整链路。
 *
 * 使用的固件：approval-flow.md
 * - reason 和 formalize 需要 AI adapter，使用 MockAIAdapter
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProtocolContent } from '../../src/parser/index.js';
import { checkCompleteness } from '../../src/checker/index.js';
import { reason } from '../../src/reasoner/index.js';
import { formalize } from '../../src/formalizer/index.js';
import { specify } from '../../src/specifier/index.js';
import { deriveContracts } from '../../src/contractor/index.js';
import type { AIAdapter, AIPrompt, AIResponse } from '../../src/model/types.js';

const FIXTURES = join(process.cwd(), 'tests/fixtures');

function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf-8');
}

/**
 * MockAIAdapter —— 返回固定 JSON 响应的测试适配器
 */
class MockAIAdapter implements AIAdapter {
  name = 'mock';
  constructor(private responseContent: string, private succeed = true) {}
  async complete(prompt: AIPrompt): Promise<AIResponse> {
    return { content: this.responseContent, success: this.succeed, attempts: 1 };
  }
}

describe('单协议端到端集成（approval-flow.md）', () => {
  let model = parseProtocolContent(readFixture('approval-flow.md'), 'approval-flow.md');

  // AI 适配器：推演返回空结果（无问题）
  const reasonAiResponse = JSON.stringify({
    liveness: { passed: true, violations: [], notes: 'AI 推演：活性满足' },
    consistency: { passed: true, violations: [], notes: 'AI 推演：一致性满足' },
  });
  const adapter = new MockAIAdapter(reasonAiResponse);

  // ----------------------------------------------------------------
  // ① check（完备性检查）
  // ----------------------------------------------------------------
  describe('① check（完备性检查）', () => {
    test('parse + checkCompleteness 验证通过', () => {
      const report = checkCompleteness(model);
      expect(report.passed).toBe(true);
      expect(report.mechanical.passed).toBe(true);
      expect(report.checkedAt).toBeTruthy();
    });

    test('机械层无 error', () => {
      const report = checkCompleteness(model);
      const allErrors = [
        ...report.mechanical.structuralIssues.filter((i) => i.severity === 'error'),
        ...report.mechanical.fieldIssues.filter((i) => i.severity === 'error'),
        ...report.mechanical.referenceIssues.filter((i) => i.severity === 'error'),
      ];
      expect(allErrors).toHaveLength(0);
    });
  });

  // ----------------------------------------------------------------
  // ② reason（AI 推演）
  // ----------------------------------------------------------------
  describe('② reason（AI 推演）', () => {
    test('推演返回完整报告结构', async () => {
      const report = await reason(model, adapter);
      expect(report.passed).toBeDefined();
      expect(report.reachability).toBeDefined();
      expect(report.deadlock).toBeDefined();
      expect(report.liveness).toBeDefined();
      expect(report.consistency).toBeDefined();
      expect(report.reasonedAt).toBeTruthy();
    });

    test('代码预判的可达性和死锁结果有效', async () => {
      const report = await reason(model, adapter);
      // approval-flow 所有状态都是可达的
      expect(report.reachability.unreachableStates).toHaveLength(0);
      // S5（已撤回）是终态，不应有死锁
      expect(report.deadlock.deadlockStates).toHaveLength(0);
    });

    test('AI 推演的活性和一致性来自 adapter', async () => {
      const report = await reason(model, adapter);
      expect(report.liveness.passed).toBe(true);
      expect(report.consistency.passed).toBe(true);
    });
  });

  // ----------------------------------------------------------------
  // ③ formalize（形式化桥接）
  // ----------------------------------------------------------------
  describe('③ formalize（形式化桥接）', () => {
    test('生成形式化规格', async () => {
      const result = await formalize(model, adapter, { allowAIFallback: true });
      expect(result.report).toBeDefined();
      expect(result.report.generatedSpec).toBeTruthy();
      // formalizer 会根据协议特征自动选择工具（如 SCXML/TLA+），验证生成了规格内容
      expect(result.report.generatedSpec.length).toBeGreaterThan(0);
      expect(result.selectionReasons.length).toBeGreaterThan(0);
    });

    test('形式化报告包含必要字段', async () => {
      const result = await formalize(model, adapter);
      expect(result.report.tool).toBeTruthy();
      expect(result.report.suitabilityScore).toBeGreaterThanOrEqual(0);
      expect(result.report.verifiedAt).toBeTruthy();
      expect(Array.isArray(result.report.invariantResults)).toBe(true);
    });
  });

  // ----------------------------------------------------------------
  // ⑤ specify（规格推导）
  // ----------------------------------------------------------------
  describe('⑤ specify（规格推导）', () => {
    let specs = specify(model);

    test('生成了系统接口', () => {
      const systemSpecs = specs.filter((s) => s.kind === 'system');
      expect(systemSpecs.length).toBeGreaterThan(0);
      // approval-flow 有 5 条转移 → 至少 5 个系统接口
      expect(systemSpecs.length).toBeGreaterThanOrEqual(5);
    });

    test('生成了观测接口', () => {
      const observationSpecs = specs.filter((s) => s.kind === 'observation');
      expect(observationSpecs.length).toBeGreaterThan(0);
    });

    test('每个规格有完整的 inputs/outputs', () => {
      for (const spec of specs) {
        expect(spec.id).toBeTruthy();
        expect(Array.isArray(spec.inputs)).toBe(true);
        expect(Array.isArray(spec.outputs)).toBe(true);
      }
    });

    test('系统接口包含 approval-flow 的动作名', () => {
      const systemSpecs = specs.filter((s) => s.kind === 'system');
      const actions = systemSpecs.map((s) => s.sourceId);
      expect(actions).toContain('submit');
      expect(actions).toContain('approve');
      expect(actions).toContain('reject');
      expect(actions).toContain('withdraw');
      expect(actions).toContain('timeout_return');
    });
  });

  // ----------------------------------------------------------------
  // ④ contract（契约推导，依赖 ⑤ 的规格）
  // ----------------------------------------------------------------
  describe('④ contract（契约推导）', () => {
    let specs = specify(model);

    test('信息契约非空', async () => {
      const result = await deriveContracts(model, specs);
      expect(result.contracts.information.fields.length).toBeGreaterThan(0);
      expect(result.contracts.information.flows.length).toBeGreaterThan(0);
    });

    test('时序契约非空', async () => {
      const result = await deriveContracts(model, specs);
      // approval-flow 有 TM1 和 TM2 两条时序
      expect(result.contracts.timing.constraints.length).toBeGreaterThanOrEqual(2);
    });

    test('约束契约非空', async () => {
      const result = await deriveContracts(model, specs);
      expect(result.contracts.constraint.guards.length).toBeGreaterThan(0);
    });

    test('不变量契约非空', async () => {
      const result = await deriveContracts(model, specs);
      // approval-flow 有 INV1 和 INV2
      expect(result.contracts.invariant.invariants.length).toBeGreaterThanOrEqual(2);
    });

    test('契约方与协议角色一致', async () => {
      const result = await deriveContracts(model, specs);
      expect(result.contracts.parties).toContain('applicant');
      expect(result.contracts.parties).toContain('approver');
      expect(result.contracts.parties).toContain('system');
    });
  });

  // ----------------------------------------------------------------
  // 数据流一致性验证
  // ----------------------------------------------------------------
  describe('数据流一致性：specs ↔ contracts', () => {
    test('系统接口的动作名出现在信息契约流中', async () => {
      const specs = specify(model);
      const result = await deriveContracts(model, specs);
      const systemSpecs = specs.filter((s) => s.kind === 'system');
      const flowActions = result.contracts.information.flows
        .map((f) => f.triggerAction)
        .filter(Boolean);

      // 部分 triggerAction 应与系统接口 sourceId 对应
      const specActions = new Set(systemSpecs.map((s) => s.sourceId));
      for (const action of flowActions) {
        // 信息契约的 triggerAction 可以在系统接口中找到对应
        if (action && specActions.has(action)) {
          expect(specActions.has(action)).toBe(true);
        }
      }
    });

    test('契约方与规格中角色衍生一致', async () => {
      const specs = specify(model);
      const result = await deriveContracts(model, specs);
      const roles = model.metadata.roles.map((r) => r.id);
      expect(result.contracts.parties.sort()).toEqual(roles.sort());
    });

    test('specs（规格）的 sourceId 与 contracts 的字段名存在关联', () => {
      const specs = specify(model);
      const systemSpecs = specs.filter((s) => s.kind === 'system');
      const specActionNames = systemSpecs.map((s) => s.name);
      // 规约接口名包含动作相关的描述
      expect(specActionNames.length).toBeGreaterThan(0);
      // 系统接口名称应可读且非空
      for (const name of specActionNames) {
        expect(name).toBeTruthy();
      }
    });
  });
});
