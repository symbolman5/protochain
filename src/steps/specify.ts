/**
 * 步骤执行器：⑤ 规格推导
 *
 * 设计依据：《协议驱动自验证工具链设计方案》specifier 模块、AI参与矩阵
 *
 * 执行方：code（代码确定性执行，无 AI）
 * 前置：formalize（③ 形式化验证通过）
 * 产出：derived/specs.json
 *
 * 推导规则：
 * - 系统接口：每个 transition 的 action → 一个系统接口
 * - 观测接口：每个状态 → 状态观测接口；每个不变量 → 不变量观测接口
 */

import type { InterfaceSpec } from '../model/types.js';
import { specify } from '../specifier/index.js';
import type { StepExecutor } from '../orchestrator/index.js';
import { writeReport } from '../orchestrator/index.js';

export function createSpecifyExecutor(): StepExecutor {
  return {
    async execute(ctx) {
      const { model, rootDir } = ctx;
      const now = new Date().toISOString();

      try {
        const specs = specify(model, { degradedAIAssist: true });
        const path = writeReport(rootDir, 'derived/specs.json', specs);
        ctx.artifacts.specs = specs;

        return {
          stepId: 'derive-specs',
          passed: true,
          outputs: [path],
          executedAt: now,
          reportSummary: formatSpecSummary(specs),
        };
      } catch (err) {
        return {
          stepId: 'derive-specs',
          passed: false,
          executedAt: now,
          error: err instanceof Error ? err.message : String(err),
          reportSummary: `规格推导异常：${err instanceof Error ? err.message : err}`,
        };
      }
    },
  };
}

function formatSpecSummary(specs: InterfaceSpec[]): string {
  const systemCount = specs.filter((s) => s.kind === 'system').length;
  const observationCount = specs.filter((s) => s.kind === 'observation').length;
  const degradedCount = specs.filter((s) => s.degradedAssist).length;
  const lines: string[] = [
    `规格推导：✓ 通过`,
    `  系统接口: ${systemCount} 个`,
    `  观测接口: ${observationCount} 个`,
    `  总计: ${specs.length} 个接口`,
  ];
  if (degradedCount > 0) {
    lines.push(`  退化模式 AI 辅助标注: ${degradedCount} 个`);
  }
  // 列出前 5 个接口
  if (specs.length > 0) {
    lines.push('  接口列表（前5个）：');
    for (const s of specs.slice(0, 5)) {
      lines.push(`    - [${s.kind}] ${s.id} ← ${s.sourceId}（${s.name}）`);
    }
    if (specs.length > 5) {
      lines.push(`    ... 还有 ${specs.length - 5} 个`);
    }
  }
  return lines.join('\n');
}
