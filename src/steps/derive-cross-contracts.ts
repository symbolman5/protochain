/**
 * 步骤执行器：④-C 跨协议契约推导
 *
 * 设计依据：《协议驱动自验证工具链设计方案》AI参与矩阵、④-C 步骤
 *
 * 执行序：
 * 1. 解析 composition.md 获取 CompositionModel
 * 2. 调用 cross-contractor 推导跨协议边界契约
 * 3. 产出 derived/composition/cross-contracts.json
 */

import { join } from 'node:path';
import type { AIAdapter, CompositionModel, CrossContractSet } from '../model/types.js';
import { parseCompositionFile } from '../composition-parser/index.js';
import { deriveCrossContracts } from '../cross-contractor/index.js';
import type { StepExecutor } from '../orchestrator/index.js';
import { writeReport } from '../orchestrator/index.js';

export function createDeriveCrossContractsExecutor(): StepExecutor {
  return {
    async execute(ctx) {
      const { rootDir } = ctx;
      const now = new Date().toISOString();

      // 解析 composition.md
      const compositionPath = join(rootDir, 'protocol/composition.md');
      let composition;
      try {
        composition = parseCompositionFile(compositionPath);
      } catch (err) {
        return { stepId: 'derive-cross-contracts', passed: false, outputs: [], executedAt: now,
          error: `组合层解析失败：${err instanceof Error ? err.message : String(err)}`,
          reportSummary: '④-C 组合层解析失败' };
      }

      // 调用 cross-contractor
      const contracts = deriveCrossContracts(composition);

      const path = writeReport(rootDir, 'derived/composition/cross-contracts.json', contracts);

      return {
        stepId: 'derive-cross-contracts',
        passed: true,
        outputs: [path],
        executedAt: now,
        reportSummary: `④-C 跨协议契约推导完成：${contracts.eventContracts.length} 事件契约、${contracts.impactContracts.length} 影响范围契约、${contracts.compensationContracts.length} 补偿契约、${contracts.timingContracts.length} 时序契约`,
      };
    },
  };
}
