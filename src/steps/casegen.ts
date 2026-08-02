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

import type { TestCaseSet, CoverageReport } from '../model/types.js';
import { generateCases } from '../casegen/index.js';
import type { StepExecutor } from '../orchestrator/index.js';
import { writeReport } from '../orchestrator/index.js';
import { readReport } from '../orchestrator/index.js';
import type { ProtochainConfig } from '../model/types.js';

export function createCaseGenExecutor(config?: ProtochainConfig): StepExecutor {
  return {
    async execute(ctx) {
      const { model, rootDir } = ctx;
      const now = new Date().toISOString();

      try {
        // 读取配置中的覆盖度准则
        const criterion = config?.coverage?.criterion ?? 'state';
        const maxPathLength = config?.coverage?.maxPathLength;

        const testCases = generateCases(model, {
          criterion,
          maxPathLength,
        });

        const path = writeReport(rootDir, 'derived/test-cases.json', testCases);
        ctx.artifacts.testCases = testCases;

        // 通过性判断：默认 state 准则下需 100% 状态覆盖；transition 准则下需 100% 转移覆盖
        const passed = judgePass(testCases.coverage);

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

function judgePass(coverage: CoverageReport): boolean {
  // 状态覆盖准则：状态覆盖率 100%
  if (coverage.criterion === 'state') {
    return coverage.stateCoverage.ratio === 1;
  }
  // 转移覆盖准则：转移覆盖率 100%
  if (coverage.criterion === 'transition') {
    return coverage.transitionCoverage.ratio === 1;
  }
  // 路径覆盖：路径数 > 0 即视为通过（路径覆盖本身无明确"完整"目标）
  if (coverage.criterion === 'path') {
    return coverage.stateCoverage.ratio > 0;
  }
  return false;
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
