/**
 * 步骤执行器：② AI 推演
 *
 * 设计依据：《协议驱动自验证工具链设计方案》reasoner 模块、AI参与矩阵
 *
 * 输入：SourceProtocolModel（推演通过的权威源来自 ①）
 * 输出：derived/reasoning-report.json
 *
 * 人工检查点：人仲裁推演结论可信度
 */

import { join } from 'node:path';
import type { AIAdapter, LivenessMode, ReasoningReport } from '../model/types.js';
import { reason } from '../reasoner/index.js';
import type { StepExecutor } from '../orchestrator/index.js';
import { writeReport } from '../orchestrator/index.js';

export interface ReasonExecutorOptions {
  /** 活性判定模式覆盖（优先级高于模型声明）；不传则按模型声明/默认 */
  liveness?: LivenessMode;
}

export function createReasonExecutor(
  aiAdapter?: AIAdapter,
  options?: ReasonExecutorOptions
): StepExecutor {
  return {
    async execute(ctx) {
      const { model, rootDir } = ctx;
      const now = new Date().toISOString();

      if (!aiAdapter) {
        // 无 AI 适配器：reason 步骤无法执行（②是 AI 执行步骤）
        return {
          stepId: 'reason',
          passed: false,
          executedAt: now,
          error: '步骤 ② AI 推演需要 AI 适配器，请在 protochain.config.yaml 配置 ai',
          reportSummary: '未配置 AI 适配器，无法执行 AI 推演',
        };
      }

      try {
        const report = await reason(model, aiAdapter, { liveness: options?.liveness });
        const path = writeReport(rootDir, 'derived/reasoning-report.json', report);
        ctx.artifacts.reasoning = report;

        return {
          stepId: 'reason',
          passed: report.passed,
          outputs: [path],
          executedAt: now,
          error: report.passed ? undefined : 'AI 推演未通过',
          reportSummary: formatReportSummary(report),
        };
      } catch (err) {
        return {
          stepId: 'reason',
          passed: false,
          executedAt: now,
          error: err instanceof Error ? err.message : String(err),
          reportSummary: `AI 推演执行异常：${err instanceof Error ? err.message : err}`,
        };
      }
    },
  };
}

function formatReportSummary(report: ReasoningReport): string {
  const lines: string[] = [
    `AI 推演：${report.passed ? '✓ 通过' : '✗ 未通过'}`,
    `  可达性: ${report.reachability.passed ? '✓' : '✗'} ${
      report.reachability.unreachableStates.length > 0
        ? `不可达状态 ${report.reachability.unreachableStates.join(', ')}`
        : ''
    }`,
    `  死锁: ${report.deadlock.passed ? '✓' : '✗'} ${
      report.deadlock.deadlockStates.length > 0
        ? `死锁状态 ${report.deadlock.deadlockStates.join(', ')}`
        : ''
    }`,
    `  活性${report.liveness.mode ? `(${report.liveness.mode})` : ''}: ${report.liveness.passed ? '✓' : '✗'}${
      report.liveness.violations.length > 0 ? `（${report.liveness.violations.length} 项违反）` : ''
    }`,
    `  一致性: ${report.consistency.passed ? '✓' : '✗'}${
      report.consistency.violations.length > 0 ? `（${report.consistency.violations.length} 项违反）` : ''
    }`,
  ];

  if (report.liveness.violations.length > 0) {
    lines.push('  活性违反：');
    for (const v of report.liveness.violations.slice(0, 3)) {
      lines.push(`    - ${v}`);
    }
  }
  if (report.consistency.violations.length > 0) {
    lines.push('  一致性违反：');
    for (const v of report.consistency.violations.slice(0, 3)) {
      lines.push(`    - ${v}`);
    }
  }
  return lines.join('\n');
}
