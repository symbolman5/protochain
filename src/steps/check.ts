/**
 * 步骤执行器：① 完备性检查
 *
 * 设计依据：《协议驱动自验证工具链设计方案》AI参与矩阵
 *
 * 执行序：
 * 1. 机械层（代码确定性执行）：结构完备性 + 字段完整性 + ID 交叉引用
 * 2. 语义层（AI 执行）：语义重复 + 表达式歧义 + 独立语义判断
 *
 * 产出：derived/completeness-report.json
 */

import { join } from 'node:path';
import type {
  SourceProtocolModel,
  CompletenessReport,
  AIAdapter,
} from '../model/types.js';
import { checkCompleteness } from '../checker/index.js';
import { checkSemanticCompleteness } from '../checker-ai/index.js';
import type { StepExecutor } from '../orchestrator/index.js';
import { writeReport } from '../orchestrator/index.js';

export function createCheckExecutor(
  aiAdapter?: AIAdapter
): StepExecutor {
  return {
    async execute(ctx) {
      const { model, rootDir } = ctx;
      const now = new Date().toISOString();

      // 1. 机械层
      let report = checkCompleteness(model);

      // 机械层未通过则直接返回，不调用 AI
      if (!report.mechanical.passed) {
        report.passed = false;
        const path = writeReport(rootDir, 'derived/completeness-report.json', report);
        return {
          stepId: 'check',
          passed: false,
          outputs: [path],
          executedAt: now,
          error: '机械层完备性检查未通过',
          reportSummary: formatReportSummary(report),
        };
      }

      // 2. 语义层（需 AI）——advisory 性质，不阻断：
      //    AI 判定跨 run 非确定（问题清单 #10），机械层是唯一硬门。
      //    语义发现保留在报告中，供人工复核。
      if (aiAdapter) {
        try {
          const semantic = await checkSemanticCompleteness(model, aiAdapter);
          report.semantic = semantic;
          // 语义层不再参与 passed 判定；其结论以 advisory 形式保留
          report.passed = report.mechanical.passed;
        } catch (err) {
          report.passed = report.mechanical.passed;
          report.semantic = {
            passed: false,
            duplicationIssues: [],
            ambiguityIssues: [],
            semanticIssues: [
              {
                severity: 'warning',
                category: 'ai-error',
                message: `语义层检查执行失败（不影响机械层结论）：${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            executed: false,
            advisory: true,
          };
        }
      } else {
        // 无 AI 适配器：语义层标记为未执行，机械层通过即视为可继续
        // 但需在报告摘要中提示
        report.semantic.executed = false;
        report.passed = true; // 机械层通过即可继续，语义层待 AI 配置后补做
      }

      const path = writeReport(rootDir, 'derived/completeness-report.json', report);
      ctx.artifacts.completeness = report;

      return {
        stepId: 'check',
        passed: report.passed,
        outputs: [path],
        executedAt: now,
        error: report.passed ? undefined : '完备性检查未通过',
        reportSummary: formatReportSummary(report),
      };
    },
  };
}

function formatReportSummary(report: CompletenessReport): string {
  const m = report.mechanical;
  const s = report.semantic;
  const lines: string[] = [
    `机械层：${m.passed ? '✓ 通过' : '✗ 未通过'}`,
    `  结构完备性: ${m.structuralIssues.length} 项（${countBySeverity(m.structuralIssues)}）`,
    `  字段完整性: ${m.fieldIssues.length} 项（${countBySeverity(m.fieldIssues)}）`,
    `  ID交叉引用: ${m.referenceIssues.length} 项（${countBySeverity(m.referenceIssues)}）`,
  ];
  if (s.executed) {
    const advisoryTag = s.advisory ? '（advisory，不阻断）' : '';
    lines.push(
      `语义层：${s.passed ? '✓ 通过' : '✗ 未通过'}（AI 已执行）${advisoryTag}`,
      `  语义重复: ${s.duplicationIssues.length} 项`,
      `  表达式歧义: ${s.ambiguityIssues.length} 项`,
      `  独立语义判断: ${s.semanticIssues.length} 项`
    );
  } else {
    lines.push('语义层：未执行（未配置 AI 适配器）');
  }
  // 列出前 5 条 error 级问题（语义层为 advisory，仅机械层 error 阻断）
  const errors = [
    ...m.structuralIssues,
    ...m.fieldIssues,
    ...m.referenceIssues,
  ].filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    lines.push('Error 级问题（前5条）：');
    for (const e of errors.slice(0, 5)) {
      lines.push(`  - [${e.category}] ${e.message}`);
    }
  }
  return lines.join('\n');
}

function countBySeverity(issues: { severity: string }[]): string {
  const e = issues.filter((i) => i.severity === 'error').length;
  const w = issues.filter((i) => i.severity === 'warning').length;
  const i = issues.filter((x) => x.severity === 'info').length;
  return `${e} error / ${w} warning / ${i} info`;
}
