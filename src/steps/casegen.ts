/**
 * 步骤执行器：⑦ 测试用例生成
 *
 * 设计依据：《协议驱动自验证工具链设计方案》casegen 模块、覆盖度准则
 *
 * 执行方：ai（AI 执行者 + 代码翻译者；P3 阶段实现代码确定性路径生成）
 * 前置：generate-tests（⑥ 测试工具生成通过）
 * 产出：derived/test-cases.json
 *
 * 人工检查点：人仲裁覆盖度未覆盖项的处置建议
 *
 * 覆盖度准则：
 * - state（默认）：状态覆盖 + 转移覆盖
 * - transition：转移覆盖
 * - path：路径覆盖（带最大路径长度限制，防止爆炸）
 */

import type { TestCaseSet, AIAdapter, ProtochainConfig } from '../model/types.js';
import { generateCases, generateCasesWithAI, judgeCoveragePass } from '../casegen/index.js';
import type { StepExecutor } from '../orchestrator/index.js';
import { writeReport } from '../orchestrator/index.js';
import { readReport } from '../orchestrator/index.js';

export function createCaseGenExecutor(
  config?: ProtochainConfig,
  aiAdapter?: AIAdapter
): StepExecutor {
  return {
    async execute(ctx) {
      const { model, rootDir } = ctx;
      const now = new Date().toISOString();

      try {
        // 读取配置中的覆盖度准则
        const criterion = config?.coverage?.criterion ?? 'state';
        const maxPathLength = config?.coverage?.maxPathLength;

        // P3：显式启用 AI 生成时走"生成 -> 覆盖度机械预检 -> 修正 -> 重试"loop；
        // 否则保持确定性路径生成（generateCases）。
        const useAI = config?.ai?.useForGeneration === true && !!aiAdapter;
        const testCases = useAI
          ? await generateCasesWithAI(model, aiAdapter!, {
              criterion,
              maxPathLength,
              loop: config?.ai?.loop,
            })
          : generateCases(model, {
              criterion,
              maxPathLength,
            });

        const path = writeReport(rootDir, 'derived/test-cases.json', testCases);
        ctx.artifacts.testCases = testCases;

        // 通过性判断：默认 state 准则下需 100% 状态覆盖；transition 准则下需 100% 转移覆盖
        const passed = judgeCoveragePass(testCases.coverage);

        return {
          stepId: 'generate-cases',
          passed,
          outputs: [path],
          executedAt: now,
          error: passed ? undefined : '测试用例覆盖度未达要求',
          reportSummary: formatCaseSummary(testCases),
        };
      } catch (err) {
        return {
          stepId: 'generate-cases',
          passed: false,
          executedAt: now,
          error: err instanceof Error ? err.message : String(err),
          reportSummary: `测试用例生成异常：${err instanceof Error ? err.message : err}`,
        };
      }
    },
  };
}

function formatCaseSummary(testCases: TestCaseSet): string {
  const c = testCases.coverage;
  const lines: string[] = [
    `测试用例生成：✓ 生成 ${testCases.paths.length} 条路径`,
    `  准则: ${c.criterion}${c.maxPathLength ? `（最大长度 ${c.maxPathLength}）` : ''}`,
    `  状态覆盖: ${c.stateCoverage.covered}/${c.stateCoverage.total}（${(c.stateCoverage.ratio * 100).toFixed(0)}%）`,
    `  转移覆盖: ${c.transitionCoverage.covered}/${c.transitionCoverage.total}（${(c.transitionCoverage.ratio * 100).toFixed(0)}%）`,
  ];
  if (c.pathCoverage) {
    lines.push(`  路径覆盖: ${c.pathCoverage.covered}/${c.pathCoverage.total}`);
  }

  // G7-S4/S6：对抗性用例（X5/X6/X12 + X15 凭证）与差额降级记录
  const adversarial = testCases.adversarialCases ?? [];
  if (adversarial.length > 0) {
    const byKind = (k: string) => adversarial.filter((a) => a.kind === k).length;
    lines.push(
      `  对抗用例: ${adversarial.length} 条（X5 observed 直写违例 ${byKind('observed-write')} / X6 guard 失败后状态不变 ${byKind('guard-failure')} / X12 收敛断言 ${byKind('convergence')} / X15 凭证 ${byKind('credential-expired') + byKind('credential-revoked') + byKind('credential-lookup')}）`
    );
  }
  const degraded = testCases.degradedReasons ?? [];
  if (degraded.length > 0) {
    lines.push(`  降级记录: ${degraded.length} 条（R4 差额 / P2-8 detection 缺省）`);
    for (const d of degraded.slice(0, 5)) {
      lines.push(`    - ${d}`);
    }
    if (degraded.length > 5) {
      lines.push(`    ... 还有 ${degraded.length - 5} 条`);
    }
  }

  // 未覆盖项
  const uncovered = c.uncoveredDispositions;
  if (uncovered.length > 0) {
    lines.push(`  未覆盖项: ${uncovered.length} 项`);
    for (const u of uncovered.slice(0, 5)) {
      lines.push(`    - [${u.elementType}] ${u.elementId}: ${u.reason}`);
    }
    if (uncovered.length > 5) {
      lines.push(`    ... 还有 ${uncovered.length - 5} 项`);
    }
  }

  // 路径列表（前 5 条）
  if (testCases.paths.length > 0) {
    lines.push('  路径用例（前5条）：');
    for (const p of testCases.paths.slice(0, 5)) {
      lines.push(`    - ${p.id}（长度 ${p.length}）: ${p.description ?? ''}`);
    }
    if (testCases.paths.length > 5) {
      lines.push(`    ... 还有 ${testCases.paths.length - 5} 条`);
    }
  }

  return lines.join('\n');
}

// 读取已有 specs/contracts 的辅助函数（避免循环依赖）
export async function loadArtifacts(rootDir: string): Promise<{
  specs?: import('../model/types.js').InterfaceSpec[];
  contracts?: import('../model/types.js').ContractSet;
}> {
  const specs = readReport<import('../model/types.js').InterfaceSpec[]>(
    rootDir,
    'derived/specs.json'
  );
  const contracts = readReport<import('../model/types.js').ContractSet>(
    rootDir,
    'derived/contracts.json'
  );
  return { specs, contracts };
}
