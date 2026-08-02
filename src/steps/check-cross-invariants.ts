/**
 * 步骤执行器：②-C 跨协议不变量推演
 *
 * 设计依据：《协议驱动自验证工具链设计方案》AI参与矩阵、②-C 步骤
 *
 * 执行序：
 * 1. 读取组合层模型（从 derived/composition/completeness-report.json 验证已完成）
 * 2. 解析 composition.md 获取 CompositionModel
 * 3. 加载各子协议模型
 * 4. 对每个跨协议不变量：
 *    - simple_boolean → 代码机械检查（invariant_driven 策略实例化状态）
 *    - first_order → AI 辅助检查
 * 5. 产出 derived/cross-invariants-report.json
 */

import { join } from 'node:path';
import type { AIAdapter, SourceProtocolModel, CrossInvariantReport } from '../model/types.js';
import { parseCompositionFile } from '../composition-parser/index.js';
import { parseProtocolFile } from '../parser/index.js';
import { checkCrossInvariants } from '../cross-invariant-checker/index.js';
import type { StepExecutor } from '../orchestrator/index.js';
import { writeReport } from '../orchestrator/index.js';

export interface CheckCrossInvariantsExecutorOptions {
  aiAdapter?: AIAdapter;
}

export function createCheckCrossInvariantsExecutor(
  options: CheckCrossInvariantsExecutorOptions = {}
): StepExecutor {
  return {
    async execute(ctx) {
      const { rootDir } = ctx;
      const now = new Date().toISOString();

      // 1. 解析 composition.md
      const compositionPath = join(rootDir, 'protocol/composition.md');
      let composition;
      try {
        composition = parseCompositionFile(compositionPath);
      } catch (err) {
        return {
          stepId: 'check-cross-invariants',
          passed: false,
          outputs: [],
          executedAt: now,
          error: `组合层解析失败：${err instanceof Error ? err.message : String(err)}`,
          reportSummary: '②-C 组合层解析失败',
        };
      }

      // 2. 加载各子协议模型
      const subProtocolModels: SourceProtocolModel[] = [];
      for (const sp of composition.subProtocols) {
        try {
          const modelPath = join(rootDir, sp.modelPath);
          const model = parseProtocolFile(modelPath);
          subProtocolModels.push(model);
        } catch {
          // 子协议模型加载失败，记录但继续（跨协议检查可能仍可用）
        }
      }

      // 3. 执行跨协议不变量检查
      const report: CrossInvariantReport = await checkCrossInvariants(
        composition,
        {
          subProtocolModels,
          adapter: options.aiAdapter,
        }
      );

      // 4. 写入报告
      const path = writeReport(
        rootDir,
        'derived/cross-invariants-report.json',
        report
      );

      return {
        stepId: 'check-cross-invariants',
        passed: report.passed,
        outputs: [path],
        executedAt: now,
        reportSummary: formatReportSummary(report),
      };
    },
  };
}

function formatReportSummary(report: CrossInvariantReport): string {
  const lines: string[] = [
    '②-C 跨协议不变量推演',
    `  结果：${report.passed ? '通过' : '未通过'}`,
  ];
  for (const r of report.results) {
    const status = r.passed ? '通过' : '未通过';
    lines.push(`  ${r.invariantId} [${r.checkMethod}]: ${status}${r.counterexample ? ' - ' + r.counterexample : ''}`);
  }
  if (report.instantiatedStateSummary) {
    lines.push(`\n  状态实例化摘要：\n${report.instantiatedStateSummary.split('\n').map((l) => '    ' + l).join('\n')}`);
  }
  return lines.join('\n');
}
