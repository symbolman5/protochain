/**
 * 阶段 A"可执行入口契约"测试：
 * - generate-tests 产物（test-tool 4 文件）可加载（编译/import）可执行；
 * - generate-cases 产物（test-cases.json）可加载、逐条执行；
 * - 失败可见：错误实现导致用例失败且带用例级 error，不静默吞错；
 * - 契约不满足（缺 executePath/TRANSITIONS）→ TestToolContractError，不可静默回退。
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { parseProtocolContent } from '../../src/parser/index.js';
import { specify } from '../../src/specifier/index.js';
import { generateTestTool } from '../../src/testgen/index.js';
import { generateCases } from '../../src/casegen/index.js';
import { loadTestTool, TestToolContractError } from '../../src/testtool/loader.js';
import { runTestCasesWithTestTool } from '../../src/testtool/runner.js';
import { buildVerificationReportFromTestTool, verify } from '../../src/verifier/index.js';
import type { ProtocolImplementationStubShape, TestCaseSet, TestToolCode } from '../../src/model/types.js';

const FIXTURES = join(process.cwd(), 'tests/fixtures');
function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf-8');
}

async function writeGeneratedProject(): Promise<{
  rootDir: string;
  model: ReturnType<typeof parseProtocolContent>;
  testCases: TestCaseSet;
}> {
  const model = parseProtocolContent(readFixture('approval-flow.md'));
  const specs = specify(model);
  const testTool: TestToolCode = await generateTestTool(model, specs, undefined, undefined, {});
  const testCases = generateCases(model, { criterion: 'state' });

  const rootDir = mkdtempSync(join(tmpdir(), 'protochain-testtool-fixture-'));
  const toolDir = join(rootDir, 'derived', 'test-tool');
  mkdirSync(toolDir, { recursive: true });
  writeFileSync(join(toolDir, 'protocol-model.ts'), testTool.protocolModel, 'utf8');
  writeFileSync(join(toolDir, 'scenario-loader.ts'), testTool.scenarioLoader, 'utf8');
  writeFileSync(join(toolDir, 'protocol-executor.ts'), testTool.protocolExecutor, 'utf8');
  writeFileSync(join(toolDir, 'consistency-asserter.ts'), testTool.consistencyAsserter, 'utf8');
  writeFileSync(
    join(toolDir, 'meta.json'),
    JSON.stringify({
      files: [
        'derived/test-tool/protocol-model.ts',
        'derived/test-tool/scenario-loader.ts',
        'derived/test-tool/protocol-executor.ts',
        'derived/test-tool/consistency-asserter.ts',
      ],
      generatedAt: testTool.generatedAt,
      sourceModel: model.sourcePath,
    }),
    'utf8',
  );
  writeFileSync(join(rootDir, 'derived', 'test-cases.json'), JSON.stringify(testCases), 'utf8');
  return { rootDir, model, testCases };
}

function correctImplementation(model: ReturnType<typeof parseProtocolContent>): ProtocolImplementationStubShape {
  const transitions = model.derivable.transitions;
  const impl: ProtocolImplementationStubShape = {};
  for (const action of new Set(transitions.map((t) => t.action))) {
    impl[action] = async (currentState: string) => {
      const t = transitions.find(
        (x) => x.action === action && (Array.isArray(x.from) ? x.from : [x.from]).includes(currentState),
      );
      if (!t) throw new Error(`实现未找到 ${action}@${currentState} 的转移`);
      return { nextState: t.to, effects: [] };
    };
  }
  return impl;
}

describe('test-tool 可执行入口契约（阶段 A）', () => {
  test('generate-tests 产物可加载、可执行：正确实现全部用例通过', async () => {
    const { rootDir, model, testCases } = await writeGeneratedProject();
    const tool = await loadTestTool(rootDir);

    expect(tool.toolFiles.length).toBe(4);
    expect(tool.model.TRANSITIONS.length).toBeGreaterThan(0);
    expect(typeof tool.executor.executePath).toBe('function');

    const run = await runTestCasesWithTestTool(tool, testCases, correctImplementation(model));
    expect(run.consumed).toBe(true);
    expect(run.executedCases).toBe(testCases.paths.length);
    expect(run.passedCases).toBe(testCases.paths.length);
    expect(run.failedCases).toBe(0);

    const report = buildVerificationReportFromTestTool(run);
    expect(report.authoritative.passed).toBe(true);
    expect(report.authoritative.testTool?.consumed).toBe(true);
    expect(report.authoritative.testTool?.executedCases).toBe(testCases.paths.length);
    expect(report.authoritative.testTool?.passedCases).toBe(testCases.paths.length);
  });

  test('generate-cases 产物（test-cases.json）可加载；逐条执行且 executedCases 等于路径数', async () => {
    const { rootDir, model, testCases } = await writeGeneratedProject();
    const tool = await loadTestTool(rootDir);
    const run = await runTestCasesWithTestTool(tool, testCases, correctImplementation(model));
    expect(run.executedCases).toBe(testCases.paths.length);
    expect(run.caseResults.map((c) => c.pathId)).toEqual(testCases.paths.map((p) => p.id));
  });

  test('失败可见：错误实现 → 用例级 error 与 failedCases 计数', async () => {
    const { rootDir, testCases } = await writeGeneratedProject();
    const tool = await loadTestTool(rootDir);
    const broken: ProtocolImplementationStubShape = {
      submit: async (s) => ({ nextState: s === 'S1' ? 'S3' : s, effects: [] }), // 应到 S2
    };
    const run = await runTestCasesWithTestTool(tool, testCases, broken);
    expect(run.failedCases).toBeGreaterThan(0);
    expect(run.passedCases).toBeLessThan(run.executedCases);
    const failed = run.caseResults.find((c) => !c.passed);
    expect(failed).toBeDefined();
    expect(failed!.error).toContain('与协议预期');
    const report = buildVerificationReportFromTestTool(run);
    expect(report.authoritative.passed).toBe(false);
    expect(report.authoritative.counts.failed).toBe(run.failedCases);
    expect(report.authoritative.caseResults.some((c) => !c.passed && c.deviations?.length)).toBe(true);
  });

  test('契约不满足（缺 executePath）→ TestToolContractError，不静默回退', async () => {
    const { rootDir, testCases } = await writeGeneratedProject();
    const toolDir = join(rootDir, 'derived', 'test-tool');
    writeFileSync(
      join(toolDir, 'protocol-executor.ts'),
      'export const notAnExecutor = 42;\n',
      'utf8',
    );
    await expect(loadTestTool(rootDir)).rejects.toBeInstanceOf(TestToolContractError);
    void testCases;
  });

  test('契约不满足（缺 TRANSITIONS）→ TestToolContractError', async () => {
    const { rootDir } = await writeGeneratedProject();
    const toolDir = join(rootDir, 'derived', 'test-tool');
    writeFileSync(
      join(toolDir, 'protocol-model.ts'),
      'export const STATES = [];\n',
      'utf8',
    );
    await expect(loadTestTool(rootDir)).rejects.toBeInstanceOf(TestToolContractError);
  });

  test('verify() 消费 testToolRun 作为权威层（失败用例带偏差证据，不静默）', async () => {
    const model = parseProtocolContent(readFixture('approval-flow.md'));
    const testCases = generateCases(model, { criterion: 'state' });
    const report = await verify(
      model,
      {
        rootDir: process.cwd(),
        testCases,
        testToolRun: {
          consumed: true,
          executedCases: 2,
          passedCases: 1,
          failedCases: 1,
          caseResults: [
            { pathId: 'CASE_OK', passed: true },
            { pathId: 'CASE_BAD', passed: false, error: '实现返回状态 S3 与协议预期 S2 不一致' },
          ],
          toolFiles: ['derived/test-tool/protocol-executor.ts'],
        },
      },
      undefined,
      { useAISummary: false },
    );
    expect(report.authoritative.passed).toBe(false);
    expect(report.authoritative.counts.failed).toBe(1);
    // 权威层 = test-tool 通过用例 + 消极保证不变量校验
    expect(report.authoritative.counts.passed).toBe(1 + model.derivable.invariants.length);
    expect(report.authoritative.testTool?.consumed).toBe(true);
    expect(report.authoritative.testTool?.executedCases).toBe(2);
    const bad = report.authoritative.caseResults.find((c) => c.pathId === 'CASE_BAD');
    expect(bad?.deviations?.length).toBe(1);
    expect(bad?.deviations?.[0]?.actual).toContain('与协议预期');
  });
});
