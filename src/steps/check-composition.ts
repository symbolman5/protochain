/**
 * 步骤执行器：①-C 组合层完备性检查
 *
 * 设计依据：《协议驱动自验证工具链设计方案》AI参与矩阵、①-C 步骤
 *
 * 执行序：
 * 1. 解析 composition.md → CompositionModel
 * 2. 收集各子协议 ① 阶段标记的 pendingCrossProtocolRefs（从各子协议 derived/completeness-report.json 读取）
 * 3. 机械层（代码）：跨协议引用存在性 + 观测接口覆盖 + 切面约束追溯 + 安全前提完整性
 * 4. 语义层（AI）：跨协议不变量表达式歧义 + 切面约束语义重复
 *
 * 产出：derived/composition/completeness-report.json
 */

import { join } from 'node:path';
import type {
  CompositionModel,
  CompositionCompletenessReport,
  AIAdapter,
  CompletenessReport,
} from '../model/types.js';
import { parseCompositionFile } from '../composition-parser/index.js';
import {
  checkCompositionCompleteness,
  type PendingRefWithSource,
} from '../composition-checker/index.js';
import { checkCompositionSemantic } from '../composition-checker-ai/index.js';
import { parseProtocolFile } from '../parser/index.js';
import type { StepExecutor } from '../orchestrator/index.js';
import { writeReport, readReport } from '../orchestrator/index.js';

export interface CheckCompositionExecutorOptions {
  /** 各子协议根目录（相对项目根；默认按 composition.subProtocols.modelPath 解析） */
  subProtocolDirs?: Record<string, string>;
  aiAdapter?: AIAdapter;
}

export function createCheckCompositionExecutor(
  options: CheckCompositionExecutorOptions = {}
): StepExecutor {
  return {
    async execute(ctx) {
      const { rootDir } = ctx;
      const now = new Date().toISOString();

      // 1. 解析 composition.md
      const compositionPath = join(rootDir, 'protocol/composition.md');
      let composition: CompositionModel;
      try {
        composition = parseCompositionFile(compositionPath);
      } catch (err) {
        return {
          stepId: 'check-composition',
          passed: false,
          outputs: [],
          executedAt: now,
          error: `组合层解析失败：${err instanceof Error ? err.message : String(err)}`,
          reportSummary: '组合层解析失败',
        };
      }

      // 2. 收集各子协议 ① 阶段标记的 pendingCrossProtocolRefs
      const pendingRefs: PendingRefWithSource[] = [];
      const subProtocolModels = [];
      for (const sp of composition.subProtocols) {
        // 读取子协议的 completeness-report.json（① 阶段产物）
        const report = readReport<CompletenessReport>(
          rootDir,
          `protocol/${sp.protocolId}/derived/completeness-report.json`
        );
        if (report?.pendingCrossProtocolRefs) {
          for (const ref of report.pendingCrossProtocolRefs) {
            pendingRefs.push({ ...ref, sourceProtocol: sp.protocolId });
          }
        }
        // 加载子协议模型（用于跨协议引用深度解析与观测接口追溯）
        try {
          const modelPath = join(rootDir, sp.modelPath);
          const model = parseProtocolFile(modelPath);
          subProtocolModels.push(model);
        } catch {
          // 子协议模型加载失败不阻塞，composition-checker 会跳过深度校验
        }
      }

      // 3. 机械层
      let report = checkCompositionCompleteness(composition, pendingRefs, {
        subProtocolModels,
      });

      // 机械层未通过则直接返回，不调用 AI
      if (!report.mechanical.passed) {
        report.passed = false;
        const path = writeReport(
          rootDir,
          'derived/composition/completeness-report.json',
          report
        );
        return {
          stepId: 'check-composition',
          passed: false,
          outputs: [path],
          executedAt: now,
          error: '组合层机械层完备性检查未通过',
          reportSummary: formatReportSummary(report),
        };
      }

      // 4. 语义层（需 AI）
      if (options.aiAdapter) {
        try {
          const semantic = await checkCompositionSemantic(
            composition,
            options.aiAdapter
          );
          report.semantic = semantic;
          report.passed = report.mechanical.passed && semantic.passed;
        } catch (err) {
          report.passed = false;
          report.semantic = {
            passed: false,
            duplicationIssues: [],
            ambiguityIssues: [],
            semanticIssues: [
              {
                severity: 'error',
                category: 'ai-execution',
                message: `AI 语义检查执行失败：${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            executed: false,
          };
        }
      }

      const path = writeReport(
        rootDir,
        'derived/composition/completeness-report.json',
        report
      );
      return {
        stepId: 'check-composition',
        passed: report.passed,
        outputs: [path],
        executedAt: now,
        reportSummary: formatReportSummary(report),
      };
    },
  };
}

function formatReportSummary(report: CompositionCompletenessReport): string {
  const m = report.mechanical;
  const refUnresolved = report.crossProtocolRefResults.filter(
    (r) => !r.resolved
  ).length;
  const lines: string[] = [
    `①-C 组合层完备性检查`,
    `  机械层：${m.passed ? '通过' : '未通过'}`,
    `    结构问题 ${m.structuralIssues.length}、字段问题 ${m.fieldIssues.length}、引用问题 ${m.referenceIssues.length}`,
    `  跨协议引用：${report.crossProtocolRefResults.length} 条，未解析 ${refUnresolved} 条`,
  ];
  if (report.semantic.executed) {
    lines.push(
      `  语义层：${report.semantic.passed ? '通过' : '未通过'}（歧义 ${report.semantic.ambiguityIssues.length}、重复 ${report.semantic.duplicationIssues.length}）`
    );
  } else {
    lines.push(`  语义层：未执行`);
  }
  lines.push(`  总体：${report.passed ? '通过' : '未通过'}`);
  return lines.join('\n');
}
