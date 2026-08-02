/**
 * 步骤执行器：③-C 跨协议形式化验证
 *
 * 设计依据：《协议驱动自验证工具链设计方案》AI参与矩阵、③-C 步骤
 *
 * 执行序：
 * 1. 解析 composition.md 获取 CompositionModel
 * 2. 加载各子协议模型
 * 3. ③-C cross-formalizer：生成全局 TLA+ 骨架 + AI 辅助填充
 * 4. 产出 derived/composition/formal-report.json
 *
 * 降低期望：③-C 为可选步骤，未通过不阻塞下游。verifyResult='unverified' 时仍标记 passed=true，
 * 但标注"未经确定性验证"。
 */

import { join } from 'node:path';
import type { AIAdapter, SourceProtocolModel, FormalReport } from '../model/types.js';
import { parseCompositionFile } from '../composition-parser/index.js';
import { parseProtocolFile } from '../parser/index.js';
import { crossFormalize } from '../cross-formalizer/index.js';
import type { StepExecutor } from '../orchestrator/index.js';
import { writeReport } from '../orchestrator/index.js';

export interface FormalizeCrossExecutorOptions {
  aiAdapter?: AIAdapter;
}

export function createFormalizeCrossExecutor(
  options: FormalizeCrossExecutorOptions = {}
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
          stepId: 'formalize-cross',
          passed: false,
          outputs: [],
          executedAt: now,
          error: `组合层解析失败：${err instanceof Error ? err.message : String(err)}`,
          reportSummary: '③-C 组合层解析失败',
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
          // 子协议模型加载失败，继续
        }
      }

      // 3. 执行 cross-formalizer
      const report: FormalReport = await crossFormalize(composition, {
        subProtocolModels,
        adapter: options.aiAdapter,
      });

      // 4. ③-C 为可选步骤，不阻塞下游
      const passed = true;

      const path = writeReport(
        rootDir,
        'derived/composition/formal-report.json',
        report
      );

      return {
        stepId: 'formalize-cross',
        passed,
        outputs: [path],
        executedAt: now,
        reportSummary: formatReportSummary(report),
      };
    },
  };
}

function formatReportSummary(report: FormalReport): string {
  const lines: string[] = [
    '③-C 跨协议形式化验证',
    `  工具：${report.tool}`,
    `  适合度评分：${report.suitabilityScore}`,
    `  通过：${report.passed ? '是' : '否'}`,
    `  规格长度：${report.generatedSpec.length} 字符`,
  ];
  return lines.join('\n');
}
