/**
 * 步骤执行器：③ 形式化验证
 *
 * 设计依据：《协议驱动自验证工具链设计方案》formalizer 模块、AI参与矩阵
 *
 * 输入：SourceProtocolModel（推演通过的权威源来自 ①②）
 * 输出：derived/formal/model.{tla|scxml|yaml} + derived/formal/formal-report.json
 *
 * 人工检查点：人仲裁是协议缺陷还是 AI 翻译错误
 */

import { join } from 'node:path';
import type { AIAdapter, FormalReport, ProtochainConfig } from '../model/types.js';
import { formalize } from '../formalizer/index.js';
import type { StepExecutor } from '../orchestrator/index.js';
import { writeReport } from '../orchestrator/index.js';

export function createFormalizeExecutor(
  aiAdapter?: AIAdapter,
  config?: ProtochainConfig
): StepExecutor {
  return {
    async execute(ctx) {
      const { model, rootDir } = ctx;
      const now = new Date().toISOString();

      if (!aiAdapter) {
        return {
          stepId: 'formalize',
          passed: false,
          executedAt: now,
          error: '步骤 ③ 形式化验证需要 AI 适配器（用于不变量验证与降级）',
          reportSummary: '未配置 AI 适配器，无法执行形式化验证',
        };
      }

      try {
        const outputDir = join(rootDir, 'derived/formal');
        const result = await formalize(model, aiAdapter, {
          preferredTool: config?.formalTool === 'auto' ? undefined : config?.formalTool,
          allowAIFallback: true,
          tlc: config?.tlc,
          outputDir,
        });

        // 写入报告
        const reportPath = writeReport(
          rootDir,
          'derived/formal/formal-report.json',
          result.report
        );
        ctx.artifacts.formal = result.report;

        return {
          stepId: 'formalize',
          passed: result.report.passed,
          outputs: [result.specFilePath, reportPath].filter(Boolean) as string[],
          executedAt: now,
          error: result.report.passed ? undefined : '形式化验证未通过',
          reportSummary: formatReportSummary(result.report, result.selectionReasons),
        };
      } catch (err) {
        return {
          stepId: 'formalize',
          passed: false,
          executedAt: now,
          error: err instanceof Error ? err.message : String(err),
          reportSummary: `形式化验证异常：${err instanceof Error ? err.message : err}`,
        };
      }
    },
  };
}

function formatReportSummary(report: FormalReport, reasons: string[]): string {
  const lines: string[] = [
    `形式化验证：${report.passed ? '✓ 通过' : '✗ 未通过'}`,
    `  工具: ${report.tool}（适合度 ${(report.suitabilityScore * 100).toFixed(0)}%）`,
    `  选择依据: ${reasons.join('; ')}`,
  ];

  if (report.invariantResults.length > 0) {
    const passed = report.invariantResults.filter((r) => r.passed).length;
    const failed = report.invariantResults.filter((r) => !r.passed).length;
    lines.push(`  不变量: ${passed} 通过 / ${failed} 未通过`);
    for (const r of report.invariantResults.filter((r) => !r.passed).slice(0, 3)) {
      lines.push(`    - ${r.invariantId}: ${r.counterexample ?? '未提供反例'}`);
    }
  }

  if (report.rawOutput && report.tool.includes('fallback')) {
    lines.push(`  注意: ${report.rawOutput.split('\n')[0]}`);
  }

  return lines.join('\n');
}
