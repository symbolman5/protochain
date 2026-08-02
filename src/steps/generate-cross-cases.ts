/**
 * 步骤执行器：⑦-C 跨协议测试用例生成
 *
 * 设计依据：《协议驱动自验证工具链设计方案》AI参与矩阵、⑦-C 步骤
 *
 * 执行序：
 * 1. 解析 composition.md 获取 CompositionModel
 * 2. 加载各子协议模型
 * 3. 调用 cross-casegen 生成跨协议路径与覆盖度报告
 * 4. 产出 derived/composition/cross-cases.json
 */

import { join } from 'node:path';
import type { SourceProtocolModel } from '../model/types.js';
import { parseCompositionFile } from '../composition-parser/index.js';
import { parseProtocolFile } from '../parser/index.js';
import { generateCrossCases } from '../cross-casegen/index.js';
import type { StepExecutor } from '../orchestrator/index.js';
import { writeReport } from '../orchestrator/index.js';

export function createGenerateCrossCasesExecutor(): StepExecutor {
  return {
    async execute(ctx) {
      const { rootDir } = ctx;
      const now = new Date().toISOString();

      const compositionPath = join(rootDir, 'protocol/composition.md');
      let composition;
      try {
        composition = parseCompositionFile(compositionPath);
      } catch (err) {
        return { stepId: 'generate-cross-cases', passed: false, outputs: [], executedAt: now,
          error: `组合层解析失败：${err instanceof Error ? err.message : String(err)}`,
          reportSummary: '⑦-C 组合层解析失败' };
      }

      const subProtocolModels: SourceProtocolModel[] = [];
      for (const sp of composition.subProtocols) {
        try {
          subProtocolModels.push(parseProtocolFile(join(rootDir, sp.modelPath)));
        } catch { /* 忽略 */ }
      }

      const cases = generateCrossCases(composition, subProtocolModels);

      const path = writeReport(rootDir, 'derived/composition/cross-cases.json', cases);

      return {
        stepId: 'generate-cross-cases',
        passed: true,
        outputs: [path],
        executedAt: now,
        reportSummary: `⑦-C 跨协议测试用例生成完成：${cases.paths.length} 条跨协议路径、事件覆盖 ${cases.coverage.eventCoverage.covered}/${cases.coverage.eventCoverage.total}`,
      };
    },
  };
}
