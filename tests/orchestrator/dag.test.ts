import {
  getStep,
  getAllSteps,
  getAllPrerequisites,
  getStepRange,
  checkPrerequisites,
} from '../../src/orchestrator/dag.js';
import type { StepId, StepExecutionResult } from '../../src/model/types.js';

describe('orchestrator DAG', () => {
  describe('步骤定义', () => {
    test('所有步骤已定义', () => {
      const steps = getAllSteps();
      expect(steps).toHaveLength(9);
      const ids = steps.map((s) => s.id);
      expect(ids).toEqual([
        'check',
        'reason',
        'formalize',
        'derive-specs',
        'derive-contracts',
        'generate-tests',
        'generate-cases',
        'check-impl',
        'verify',
      ]);
    });

    test('方法论编号正确', () => {
      expect(getStep('check').methodologyNumber).toBe('①');
      expect(getStep('reason').methodologyNumber).toBe('②');
      expect(getStep('formalize').methodologyNumber).toBe('③');
      expect(getStep('derive-specs').methodologyNumber).toBe('⑤');
      expect(getStep('derive-contracts').methodologyNumber).toBe('④');
      expect(getStep('verify').methodologyNumber).toBe('⑩');
    });

    test('执行序 ⑤ 在 ④ 之前（设计决策：先规格再投影契约）', () => {
      const steps = getAllSteps();
      const specsIdx = steps.findIndex((s) => s.id === 'derive-specs');
      const contractsIdx = steps.findIndex((s) => s.id === 'derive-contracts');
      expect(specsIdx).toBeLessThan(contractsIdx);
    });
  });

  describe('依赖关系', () => {
    test('check 无前置', () => {
      expect(getAllPrerequisites('check')).toEqual([]);
    });

    test('reason 依赖 check', () => {
      expect(getAllPrerequisites('reason')).toEqual(['check']);
    });

    test('derive-contracts 传递依赖包含 check/reason/formalize/derive-specs', () => {
      const deps = getAllPrerequisites('derive-contracts');
      expect(deps).toEqual(
        expect.arrayContaining(['check', 'reason', 'formalize', 'derive-specs'])
      );
    });

    test('verify 传递依赖包含所有前置步骤', () => {
      const deps = getAllPrerequisites('verify');
      expect(deps).toEqual(
        expect.arrayContaining([
          'check',
          'reason',
          'formalize',
          'derive-specs',
          'derive-contracts',
          'generate-tests',
          'generate-cases',
          'check-impl',
        ])
      );
    });
  });

  describe('getStepRange', () => {
    test('区间含两端', () => {
      const range = getStepRange('reason', 'derive-specs');
      expect(range).toEqual(['reason', 'formalize', 'derive-specs']);
    });

    test('单步区间', () => {
      expect(getStepRange('check', 'check')).toEqual(['check']);
    });

    test('from 在 to 之后抛错', () => {
      expect(() => getStepRange('verify', 'check')).toThrow();
    });
  });

  describe('checkPrerequisites', () => {
    function makeResult(stepId: StepId, passed: boolean): StepExecutionResult {
      return {
        stepId,
        passed,
        executedAt: new Date().toISOString(),
      };
    }

    test('check 前置始终满足', () => {
      const completed = new Map();
      const result = checkPrerequisites('check', completed);
      expect(result.satisfied).toBe(true);
    });

    test('reason 前置未完成时不满足', () => {
      const completed = new Map();
      const result = checkPrerequisites('reason', completed);
      expect(result.satisfied).toBe(false);
      expect(result.missing).toEqual(['check']);
    });

    test('reason 前置已通过时满足', () => {
      const completed = new Map<StepId, StepExecutionResult>([
        ['check', makeResult('check', true)],
      ]);
      const result = checkPrerequisites('reason', completed);
      expect(result.satisfied).toBe(true);
    });

    test('reason 前置未通过时不满足', () => {
      const completed = new Map<StepId, StepExecutionResult>([
        ['check', makeResult('check', false)],
      ]);
      const result = checkPrerequisites('reason', completed);
      expect(result.satisfied).toBe(false);
      expect(result.missing).toEqual(['check']);
    });

    test('verify 需所有前置通过', () => {
      const all: StepId[] = [
        'check',
        'reason',
        'formalize',
        'derive-specs',
        'derive-contracts',
        'generate-tests',
        'generate-cases',
        'check-impl',
      ];
      const completed = new Map<StepId, StepExecutionResult>(
        all.map((id) => [id, makeResult(id, true)])
      );
      expect(checkPrerequisites('verify', completed).satisfied).toBe(true);

      // 缺一个
      completed.delete('generate-cases');
      const result = checkPrerequisites('verify', completed);
      expect(result.satisfied).toBe(false);
      expect(result.missing).toContain('generate-cases');
    });
  });
});
