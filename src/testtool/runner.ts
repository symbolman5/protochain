/**
 * test-tool 执行器 —— 阶段 A"可执行入口契约"的执行侧。
 *
 * 契约（与 loader 校验一致）：
 * - 已加载的 TestToolModule.executor 暴露 `executePath(transitionIds, implementation)`；
 * - test-cases.json 的每个 path 提供 transitionIds；
 * - implementation 可以是单个 ProtocolImplementation 对象，或按 path 生成对象的工厂
 *   （实例层用它闭包 pathId 注入真实服务参数）。
 *
 * 产出 TestToolRunReport（executedCases/passedCases/failedCases + 用例级结果），
 * 失败以 caseResults[].error 可见，不静默吞错。
 */
import type {
  ProtocolPath,
  ProtocolImplementationStubShape,
  TestCaseSet,
  TestToolCaseResult,
  TestToolModule,
  TestToolRunReport,
} from '../model/types.js';

export type ImplementationProvider =
  | ProtocolImplementationStubShape
  | ((path: ProtocolPath) => ProtocolImplementationStubShape);

export interface TestToolRunOptions {
  /** 只跑前 N 条用例（阶段 B 先 dev 跑通一条的开关） */
  limit?: number;
}

function implementationFor(
  provider: ImplementationProvider,
  path: ProtocolPath,
): ProtocolImplementationStubShape {
  return typeof provider === 'function' ? provider(path) : provider;
}

export async function runTestCasesWithTestTool(
  tool: TestToolModule,
  testCases: TestCaseSet,
  implementation: ImplementationProvider,
  options: TestToolRunOptions = {},
): Promise<TestToolRunReport> {
  const paths = Array.isArray(testCases.paths) ? testCases.paths : [];
  const selected = typeof options.limit === 'number' ? paths.slice(0, options.limit) : paths;
  const caseResults: TestToolCaseResult[] = [];

  for (const path of selected) {
    let passed = false;
    let error: string | undefined;
    try {
      const outcome = await tool.executor.executePath(
        path.transitionIds,
        implementationFor(implementation, path),
      );
      passed = outcome.passed === true;
      if (!passed) {
        error = outcome.error ?? '执行未通过（未给出原因）';
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    caseResults.push({ pathId: path.id, passed, error });
  }

  const passedCases = caseResults.filter((c) => c.passed).length;
  const failedCases = caseResults.filter((c) => !c.passed).length;
  return {
    consumed: true,
    executedCases: caseResults.length,
    passedCases,
    failedCases,
    caseResults,
    toolFiles: tool.toolFiles,
    generatedAt: tool.generatedAt,
  };
}
