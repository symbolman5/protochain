/**
 * 步骤执行器：⑥ 测试工具生成
 *
 * 设计依据：《协议驱动自验证工具链设计方案》testgen 模块、AI参与矩阵
 *
 * 执行方：ai（AI 执行；P3 阶段实现代码确定性骨架，AI 增强可选）
 * 前置：derive-contracts（④ 契约推导通过）
 * 产出：
 *   derived/test-tool/protocol-model.ts
 *   derived/test-tool/scenario-loader.ts
 *   derived/test-tool/protocol-executor.ts
 *   derived/test-tool/consistency-asserter.ts
 *
 * 人工检查点：人审阅生成的代码是否正确反映协议
 *
 * 注：测试工具是"生成代码而非运行时解释"——开发者可审阅调试，不依赖 protochain 运行时。
 */

import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import type { AIAdapter, InterfaceSpec, ContractSet, TestToolCode } from '../model/types.js';
import { generateTestTool } from '../testgen/index.js';
import { specify } from '../specifier/index.js';
import { deriveContracts } from '../contractor/index.js';
import type { StepExecutor } from '../orchestrator/index.js';
import { writeReport } from '../orchestrator/index.js';

export function createTestGenExecutor(aiAdapter?: AIAdapter): StepExecutor {
  return {
    async execute(ctx) {
      const { model, rootDir } = ctx;
      const now = new Date().toISOString();

      try {
        // 取得规格与契约：优先从 artifacts，否则重新推导
        let specs: InterfaceSpec[] | undefined = ctx.artifacts.specs;
        if (!specs) {
          specs = specify(model, { degradedAIAssist: true });
          ctx.artifacts.specs = specs;
        }

        let contracts: ContractSet | undefined = ctx.artifacts.contracts;
        if (!contracts) {
          const result = await deriveContracts(model, specs, aiAdapter, {
            useAIForInvariantRelevance: !!aiAdapter,
            degradedAIAssist: true,
          });
          contracts = result.contracts;
          ctx.artifacts.contracts = contracts;
        }

        const testTool = await generateTestTool(model, specs, contracts, aiAdapter, {
          useAI: false, // P3 阶段：默认纯代码生成；P5 阶段可启用 AI 增强
        });

        // 写入 4 个源文件
        const outputDir = join(rootDir, 'derived/test-tool');
        mkdirSync(outputDir, { recursive: true });
        const files: Record<keyof TestToolCode, string> = {
          protocolModel: 'protocol-model.ts',
          scenarioLoader: 'scenario-loader.ts',
          protocolExecutor: 'protocol-executor.ts',
          consistencyAsserter: 'consistency-asserter.ts',
          generatedAt: '', // 不写入文件
        };
        const outputs: string[] = [];
        for (const key of ['protocolModel', 'scenarioLoader', 'protocolExecutor', 'consistencyAsserter'] as Array<keyof TestToolCode>) {
          const filePath = join(outputDir, files[key]);
          writeFileSync(filePath, testTool[key] as string, 'utf-8');
          outputs.push(filePath);
        }

        // 写入元数据报告
        const metaPath = writeReport(rootDir, 'derived/test-tool/meta.json', {
          files: outputs,
          generatedAt: testTool.generatedAt,
          sourceModel: model.sourcePath,
        });

        ctx.artifacts.testTool = testTool;

        return {
          stepId: 'generate-tests',
          passed: true,
          outputs: [...outputs, metaPath],
          executedAt: now,
          reportSummary: formatTestGenSummary(testTool, outputs),
        };
      } catch (err) {
        return {
          stepId: 'generate-tests',
          passed: false,
          executedAt: now,
          error: err instanceof Error ? err.message : String(err),
          reportSummary: `测试工具生成异常：${err instanceof Error ? err.message : err}`,
        };
      }
    },
  };
}

function formatTestGenSummary(testTool: TestToolCode, outputs: string[]): string {
  const lines: string[] = [
    `测试工具生成：✓ 通过`,
    `  生成时间: ${testTool.generatedAt}`,
    `  生成文件: ${outputs.length} 个`,
  ];
  for (const path of outputs) {
    // 显示相对路径更友好
    const parts = path.replace(/\\/g, '/').split('/');
    const shortPath = parts.slice(-3).join('/');
    lines.push(`    - ${shortPath}`);
  }
  // 代码行数统计
  const lineCounts = {
    'protocol-model.ts': testTool.protocolModel.split('\n').length,
    'scenario-loader.ts': testTool.scenarioLoader.split('\n').length,
    'protocol-executor.ts': testTool.protocolExecutor.split('\n').length,
    'consistency-asserter.ts': testTool.consistencyAsserter.split('\n').length,
  };
  const total = Object.values(lineCounts).reduce((a, b) => a + b, 0);
  lines.push(`  代码行数: ${total} 行`);
  for (const [name, count] of Object.entries(lineCounts)) {
    lines.push(`    - ${name}: ${count} 行`);
  }
  return lines.join('\n');
}
