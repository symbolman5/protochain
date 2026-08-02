/**
 * 步骤执行器：④ 契约推导
 *
 * 设计依据：《协议驱动自验证工具链设计方案》contractor 模块、AI参与矩阵
 *
 * 执行方：code+ai（代码投影 + AI 辅助不变量相关性判断）
 * 前置：derive-specs（⑤ 规格推导通过；执行序 ⑤→④）
 * 产出：derived/contracts.json
 *
 * 人工检查点：人仲裁不变量相关性判断是否合理
 *
 * 关键设计决策：
 * - ④先调用⑤再投影：从已推导的 InterfaceSpec 投影契约
 * - 若 ctx.artifacts.specs 不存在，则重新调用 specify（容错）
 */

import type { AIAdapter, ContractSet, InterfaceSpec } from '../model/types.js';
import { deriveContracts } from '../contractor/index.js';
import { specify } from '../specifier/index.js';
import type { StepExecutor } from '../orchestrator/index.js';
import { writeReport } from '../orchestrator/index.js';

export function createContractExecutor(aiAdapter?: AIAdapter): StepExecutor {
  return {
    async execute(ctx) {
      const { model, rootDir } = ctx;
      const now = new Date().toISOString();

      try {
        // 取得规格：优先从 artifacts，否则重新推导
        let specs: InterfaceSpec[] | undefined = ctx.artifacts.specs;
        if (!specs) {
          specs = specify(model, { degradedAIAssist: true });
          ctx.artifacts.specs = specs;
        }

        const result = await deriveContracts(model, specs, aiAdapter, {
          useAIForInvariantRelevance: !!aiAdapter,
          degradedAIAssist: true,
        });
        const path = writeReport(rootDir, 'derived/contracts.json', result.contracts);
        ctx.artifacts.contracts = result.contracts;

        return {
          stepId: 'derive-contracts',
          passed: true,
          outputs: [path],
          executedAt: now,
          reportSummary: formatContractSummary(result.contracts, !!aiAdapter),
        };
      } catch (err) {
        return {
          stepId: 'derive-contracts',
          passed: false,
          executedAt: now,
          error: err instanceof Error ? err.message : String(err),
          reportSummary: `契约推导异常：${err instanceof Error ? err.message : err}`,
        };
      }
    },
  };
}

function formatContractSummary(contracts: ContractSet, usedAI: boolean): string {
  const lines: string[] = [
    `契约推导：✓ 通过`,
    `  契约方: ${contracts.parties.join(', ')}`,
    `  信息契约: ${contracts.information.fields.length} 字段 / ${contracts.information.flows.length} 流向`,
    `  时序契约: ${contracts.timing.constraints.length} 项`,
    `  约束契约: ${contracts.constraint.guards.length} 项`,
    `  不变量契约: ${contracts.invariant.invariants.length} 项${usedAI ? '（AI 辅助相关性判断）' : '（仅代码预判）'}`,
  ];

  // 列出前 5 个信息流
  if (contracts.information.flows.length > 0) {
    lines.push('  信息流（前5个）：');
    for (const f of contracts.information.flows.slice(0, 5)) {
      lines.push(`    - ${f.from} → ${f.to}: ${f.fieldName}（${f.triggerAction ?? ''}）`);
    }
    if (contracts.information.flows.length > 5) {
      lines.push(`    ... 还有 ${contracts.information.flows.length - 5} 个`);
    }
  }

  // 列出 AI 辅助判断的不变量
  const aiAssisted = contracts.invariant.invariants.filter((i) => i.degradedAssist);
  if (aiAssisted.length > 0) {
    lines.push(`  AI 辅助标注的不变量（${aiAssisted.length} 项）：`);
    for (const inv of aiAssisted.slice(0, 3)) {
      lines.push(`    - ${inv.invariantId}: ${inv.relevanceNote ?? '无说明'}`);
    }
  }

  return lines.join('\n');
}
