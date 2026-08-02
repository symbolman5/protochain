/**
 * 步骤执行器：⑧ 实现完整性检查
 *
 * 设计依据：《协议驱动自验证工具链设计方案》implcheck 模块、AI参与矩阵
 *
 * 执行方：code（代码确定性执行，无 AI）
 * 前置：generate-cases（⑦ 测试用例生成通过）+ 开发者完成 ⑨ 实现编码
 * 产出：derived/impl-check/impl-check-report.json
 *
 * 检查规则：
 * - 扫描 impl-scaffold/interfaces.d.ts 与 src/、impl/ 下的源文件
 * - 校验规格中声明的每个接口是否在实现中存在
 * - 不验证实现语义（语义正确性由 ⑩ 一致性验证负责）
 */

import type { InterfaceSpec } from '../model/types.js';
import { checkImplementation, formatImplCheckSummary } from '../implcheck/index.js';
import { specify } from '../specifier/index.js';
import { readReport } from '../orchestrator/index.js';
import type { StepExecutor } from '../orchestrator/index.js';
import { writeReport } from '../orchestrator/index.js';

export function createImplCheckExecutor(): StepExecutor {
  return {
    async execute(ctx) {
      const { model, rootDir } = ctx;
      const now = new Date().toISOString();

      try {
        // 取得规格：优先从 artifacts，否则从 derived/specs.json 读取，最后重新推导
        let specs: InterfaceSpec[] | undefined = ctx.artifacts.specs;
        if (!specs) {
          specs = readReport<InterfaceSpec[]>(rootDir, 'derived/specs.json');
        }
        if (!specs) {
          specs = specify(model, { degradedAIAssist: true });
          ctx.artifacts.specs = specs;
        }

        const report = checkImplementation(specs, rootDir);
        const path = writeReport(
          rootDir,
          'derived/impl-check/impl-check-report.json',
          report
        );
        ctx.artifacts.implCheck = report;

        return {
          stepId: 'check-impl',
          passed: report.passed,
          outputs: [path],
          executedAt: now,
          error: report.passed ? undefined : '存在缺失的接口实现',
          reportSummary: formatImplCheckSummary(report),
        };
      } catch (err) {
        return {
          stepId: 'check-impl',
          passed: false,
          executedAt: now,
          error: err instanceof Error ? err.message : String(err),
          reportSummary: `实现完整性检查异常：${err instanceof Error ? err.message : err}`,
        };
      }
    },
  };
}
