import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProtocolContent } from '../../src/parser/index.js';
import { generateCases } from '../../src/casegen/index.js';
import { verify, formatVerificationSummary, type ProtocolImplementationStub } from '../../src/verifier/index.js';
import type { AIAdapter, AIPrompt, AIResponse, SourceProtocolModel, TestCaseSet } from '../../src/model/types.js';

const FIXTURES = join(process.cwd(), 'tests/fixtures');
function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf-8');
}

class MockAIAdapter implements AIAdapter {
  name = 'mock';
  constructor(private responseContent: string, private succeed = true) {}
  async complete(prompt: AIPrompt): Promise<AIResponse> {
    return { content: this.responseContent, success: this.succeed, attempts: 1 };
  }
}

describe('verifier', () => {
  describe('用例执行', () => {
    const model = parseProtocolContent(readFixture('approval-flow.md'));
    const testCases = generateCases(model, { criterion: 'state' });

    test('无实现时路径跳过但消极保证通过', async () => {
      const report = await verify(model, { rootDir: '.', testCases, implementation: undefined });
      expect(report.authoritative.counts.skipped).toBe(testCases.paths.length);
      expect(report.authoritative.counts.passed).toBe(model.derivable.invariants.length); // 消极保证验证通过
      expect(report.authoritative.counts.failed).toBe(0);
      // 消极保证全部通过 → passed=true（路径跳过不算失败）
      expect(report.authoritative.passed).toBe(true);
    });

    test('正确实现所有用例通过', async () => {
      const implementation: ProtocolImplementationStub = {
        submit: async (s) => ({ nextState: s === 'S1' ? 'S2' : s }),
        approve: async (s) => ({ nextState: s === 'S2' ? 'S3' : s }),
        reject: async (s) => ({ nextState: s === 'S2' ? 'S4' : s }),
        withdraw: async (s) => ({ nextState: s === 'S2' ? 'S5' : s }),
        timeout_return: async (s) => ({ nextState: s === 'S2' ? 'S1' : s }),
      };

      const report = await verify(model, { rootDir: '.', testCases, implementation });
      expect(report.authoritative.counts.skipped).toBe(0);
      expect(report.authoritative.counts.failed).toBe(0);
      // 路径数 + 不变量数（消极保证验证）
      expect(report.authoritative.counts.passed).toBe(testCases.paths.length + model.derivable.invariants.length);
      expect(report.authoritative.passed).toBe(true);
    });

    test('错误的状态转移被检测为偏差', async () => {
      const implementation: ProtocolImplementationStub = {
        submit: async (s) => ({ nextState: 'S3' }), // 应为 S2，错误
        approve: async (s) => ({ nextState: 'S3' }),
        reject: async (s) => ({ nextState: 'S4' }),
        withdraw: async (s) => ({ nextState: 'S5' }),
        timeout_return: async (s) => ({ nextState: 'S1' }),
      };

      const report = await verify(model, { rootDir: '.', testCases, implementation });
      expect(report.authoritative.counts.failed).toBeGreaterThan(0);
      expect(report.authoritative.passed).toBe(false);

      // 检查偏差详情
      const failedCase = report.authoritative.caseResults.find((c) => !c.passed);
      expect(failedCase).toBeDefined();
      expect(failedCase!.deviations).toBeDefined();
      const firstDev = failedCase!.deviations![0];
      expect(firstDev.kind).toBe('state_mismatch');
      expect(firstDev.expected).toBe('S2');
      expect(firstDev.actual).toBe('S3');
    });

    test('缺失的 action 实现被检测', async () => {
      const implementation: ProtocolImplementationStub = {
        submit: async (s) => ({ nextState: 'S2' }),
        // 缺少 approve/reject/withdraw/timeout_return
      };

      const report = await verify(model, { rootDir: '.', testCases, implementation });
      const failed = report.authoritative.caseResults.filter((c) => !c.passed && !c.skipped);
      expect(failed.length).toBeGreaterThan(0);
      const missingDevs = failed.flatMap((c) => c.deviations ?? []).filter((d) => d.kind === 'missing_action');
      expect(missingDevs.length).toBeGreaterThan(0);
    });

    test('实现抛出异常被捕获并记录偏差', async () => {
      const implementation: ProtocolImplementationStub = {
        submit: async () => { throw new Error('网络错误'); },
        approve: async (s) => ({ nextState: 'S3' }),
        reject: async (s) => ({ nextState: 'S4' }),
        withdraw: async (s) => ({ nextState: 'S5' }),
        timeout_return: async (s) => ({ nextState: 'S1' }),
      };

      const report = await verify(model, { rootDir: '.', testCases, implementation });
      const failed = report.authoritative.caseResults.filter((c) => !c.passed && !c.skipped);
      expect(failed.length).toBeGreaterThan(0);
      const firstFailed = failed[0];
      expect(firstFailed.deviations![0].actual).toContain('网络错误');
    });
  });

  describe('权威层报告结构', () => {
    const model = parseProtocolContent(readFixture('approval-flow.md'));
    const testCases = generateCases(model, { criterion: 'state' });

    test('报告含 counts 三项计数', async () => {
      const report = await verify(model, { rootDir: '.', testCases });
      expect(report.authoritative.counts).toHaveProperty('passed');
      expect(report.authoritative.counts).toHaveProperty('failed');
      expect(report.authoritative.counts).toHaveProperty('skipped');
    });

    test('caseResults 含每条路径的结果', async () => {
      const report = await verify(model, { rootDir: '.', testCases });
      // 路径结果 + 消极保证验证结果（不变量数）
      expect(report.authoritative.caseResults.length).toBe(testCases.paths.length + model.derivable.invariants.length);
      for (const cr of report.authoritative.caseResults) {
        expect(cr.pathId).toBeDefined();
        expect(typeof cr.passed).toBe('boolean');
      }
    });

    test('记录验证时间戳', async () => {
      const report = await verify(model, { rootDir: '.', testCases });
      expect(report.verifiedAt).toBeTruthy();
      expect(report.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('AI 辅助摘要', () => {
    const model = parseProtocolContent(readFixture('approval-flow.md'));
    const testCases = generateCases(model, { criterion: 'state' });

    test('启用 AI 摘要时生成 auxiliary 字段', async () => {
      const aiResponse = JSON.stringify({
        summary: '本次验证全部跳过，未提供实现',
        deviationCategories: [],
      });
      const adapter = new MockAIAdapter(aiResponse);
      const report = await verify(
        model,
        { rootDir: '.', testCases },
        adapter,
        { useAISummary: true }
      );
      expect(report.auxiliary).toBeDefined();
      expect(report.auxiliary!.summary).toContain('跳过');
    });

    test('全部通过时 AI 摘要标注验证通过', async () => {
      const aiResponse = JSON.stringify({
        summary: '验证通过',
        deviationCategories: [],
      });
      const adapter = new MockAIAdapter(aiResponse);
      const implementation: ProtocolImplementationStub = {
        submit: async (s) => ({ nextState: 'S2' }),
        approve: async (s) => ({ nextState: 'S3' }),
        reject: async (s) => ({ nextState: 'S4' }),
        withdraw: async (s) => ({ nextState: 'S5' }),
        timeout_return: async (s) => ({ nextState: 'S1' }),
      };
      const report = await verify(
        model,
        { rootDir: '.', testCases, implementation },
        adapter,
        { useAISummary: true }
      );
      expect(report.auxiliary).toBeDefined();
      expect(report.auxiliary!.summary).toContain('通过');
    });

    test('AI 调用失败时不影响权威层', async () => {
      const adapter = new MockAIAdapter('', false);
      const report = await verify(
        model,
        { rootDir: '.', testCases },
        adapter,
        { useAISummary: true }
      );
      expect(report.auxiliary).toBeUndefined();
      // 权威层仍正常
      expect(report.authoritative.counts.skipped).toBe(testCases.paths.length);
    });

    test('AI 输出非 JSON 时辅助层为空', async () => {
      const adapter = new MockAIAdapter('不是 JSON');
      const report = await verify(
        model,
        { rootDir: '.', testCases },
        adapter,
        { useAISummary: true }
      );
      expect(report.auxiliary).toBeUndefined();
    });
  });

  describe('无测试用例场景', () => {
    test('无测试用例时返回空报告', async () => {
      const model = parseProtocolContent(readFixture('approval-flow.md'));
      const emptyTestCases: TestCaseSet = {
        paths: [],
        coverage: {
          criterion: 'state',
          stateCoverage: { covered: 0, total: 0, ratio: 0, coveredIds: [], uncoveredIds: [] },
          transitionCoverage: { covered: 0, total: 0, ratio: 0, coveredIds: [], uncoveredIds: [] },
          uncoveredDispositions: [],
        },
        generatedAt: new Date().toISOString(),
      };
      const report = await verify(model, { rootDir: '.', testCases: emptyTestCases });
      // 无路径用例，但仍有消极保证验证结果（不变量数）
      expect(report.authoritative.caseResults.length).toBe(model.derivable.invariants.length);
      expect(report.authoritative.counts.passed).toBe(model.derivable.invariants.length);
    });
  });

  describe('报告摘要格式', () => {
    test('摘要包含通过/失败/跳过计数', async () => {
      const model = parseProtocolContent(readFixture('approval-flow.md'));
      const testCases = generateCases(model, { criterion: 'state' });
      const report = await verify(model, { rootDir: '.', testCases });
      const summary = formatVerificationSummary(report);
      expect(summary).toContain('一致性验证');
      expect(summary).toContain('通过');
      expect(summary).toContain('失败');
      expect(summary).toContain('跳过');
    });

    test('失败用例在摘要中列出', async () => {
      const model = parseProtocolContent(readFixture('approval-flow.md'));
      const testCases = generateCases(model, { criterion: 'state' });
      const implementation: ProtocolImplementationStub = {
        submit: async () => ({ nextState: 'S3' }), // 错误实现
        approve: async (s) => ({ nextState: 'S3' }),
        reject: async (s) => ({ nextState: 'S4' }),
        withdraw: async (s) => ({ nextState: 'S5' }),
        timeout_return: async (s) => ({ nextState: 'S1' }),
      };
      const report = await verify(model, { rootDir: '.', testCases, implementation });
      const summary = formatVerificationSummary(report);
      expect(summary).toContain('失败用例');
    });
  });
});
