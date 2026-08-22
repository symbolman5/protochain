/**
 * 步骤执行器：⑩ 一致性验证
 *
 * 设计依据：《协议驱动自验证工具链设计方案》verifier 模块、AI参与矩阵
 *
 * 执行方：code（代码确定性执行，运行测试工具 + 可选 AI 辅助摘要）
 * 前置：check-impl（⑧ 实现完整性检查通过）
 * 产出：derived/verification/verification-report.json
 *
 * 人工检查点：人审阅偏差报告
 */

import type { AIAdapter, TestCaseSet, InterfaceSpec, ProtochainConfig } from '../model/types.js';
import { verify, formatVerificationSummary, type ProtocolImplementationStub } from '../verifier/index.js';
import { loadScenarioParams, findScenariosDir } from '../verifier/binding-runner.js';
import { writeEnvDepsReport, formatEnvDepsWarnings } from '../verifier/env-deps.js';
import { applyBindingEnvironment } from '../binder/index.js';
import { loadSpecsEnvelope } from '../specifier/load.js'; // E2-I1 修复：走公共 helper 解 Envelope
import { readReport } from '../orchestrator/index.js';
import type { StepExecutor } from '../orchestrator/index.js';
import { writeReport } from '../orchestrator/index.js';

export function createVerifyExecutor(
  aiAdapter?: AIAdapter,
  config?: ProtochainConfig,
  protocolId?: string,
  envName?: string
): StepExecutor {
  return {
    async execute(ctx) {
      const { model, rootDir } = ctx;
      const now = new Date().toISOString();

      try {
        // 读取测试用例
        const testCases = ctx.artifacts.testCases as TestCaseSet | undefined ??
          readReport<TestCaseSet>(rootDir, 'derived/test-cases.json');

        // ── E2-I1 修复：specs 加载走公共 helper（自动解 Envelope + 兼容裸数组） ──
        // 优先 ctx.artifacts.specs（specify 步骤已推导），否则从 derived/specs.json 读
        let specs: InterfaceSpec[] | undefined = ctx.artifacts.specs as InterfaceSpec[] | undefined;
        if (!specs || specs.length === 0) {
          const loaded = loadSpecsEnvelope(rootDir, model.metadata.version, (w) =>
            console.warn(`[specs.json] [migration] ${w}`)
          );
          specs = loaded?.specs;
        }
        const scenariosDir = findScenariosDir(rootDir);

        // 绑定环境解析（--env / defaultEnv）+ 前置环境变量扫描与告警（不阻断）
        const bindings = config?.bindings
          ? applyBindingEnvironment(config.bindings, envName)
          : undefined;
        if (bindings) {
          const envReport = writeEnvDepsReport(rootDir, bindings, protocolId ?? ctx.protocolId, envName);
          const warning = formatEnvDepsWarnings(envReport);
          if (warning) console.warn(`\n[verify] ${warning}\n`);
        }

        // ── E2-I1 修复：管线 verify 步骤透传字段级开关 ──
        const report = await verify(
          model,
          {
            rootDir,
            testCases: testCases ?? undefined,
            implementation: undefined, // CLI 模式无进程内实现，绑定模式经传输执行
            specs,
            bindings,
            protocolId: protocolId ?? ctx.protocolId,
            scenarios: scenariosDir
              ? loadScenarioParams(scenariosDir)
              : undefined,
            // E2 字段级对比：specs 是 envelope 时启用；老格式 array-migrated 时仍可启用（兼容）
            enableFieldLevelCompare: specs !== undefined && specs.length > 0,
            // legacyExpectedResponses 由 caller/CLI 注入；管线默认空对象（E2-I4 数据源后续 E2.1）
            legacyExpectedResponses: {},
          },
          aiAdapter,
          { useAISummary: !!aiAdapter }
        );

        // 场景命中告警（声明了场景但无路径命中 → 可能场景写错被静默回退掩盖）
        const scenarioWarnings = report.authoritative.scenarioWarnings;
        if (scenarioWarnings && scenarioWarnings.length > 0) {
          console.warn(
            `\n[verify] 场景告警：\n${scenarioWarnings.map((w) => `  - ${w}`).join('\n')}\n`
          );
        }

        const path = writeReport(
          rootDir,
          'derived/verification/verification-report.json',
          report
        );
        ctx.artifacts.verification = report;

        return {
          stepId: 'verify',
          passed: report.authoritative.passed,
          outputs: [path],
          executedAt: now,
          error: report.authoritative.passed ? undefined : '一致性验证未通过',
          reportSummary: formatVerificationSummary(report),
        };
      } catch (err) {
        return {
          stepId: 'verify',
          passed: false,
          executedAt: now,
          error: err instanceof Error ? err.message : String(err),
          reportSummary: `一致性验证异常：${err instanceof Error ? err.message : err}`,
        };
      }
    },
  };
}

/**
 * 创建带实现的验证执行器（供 SDK 调用）
 */
export function createVerifyWithImplExecutor(
  implementation: ProtocolImplementationStub,
  aiAdapter?: AIAdapter
): StepExecutor {
  return {
    async execute(ctx) {
      const { model, rootDir } = ctx;
      const now = new Date().toISOString();

      try {
        const testCases = ctx.artifacts.testCases as TestCaseSet | undefined ??
          readReport<TestCaseSet>(rootDir, 'derived/test-cases.json');

        const report = await verify(
          model,
          {
            rootDir,
            testCases: testCases ?? undefined,
            implementation,
          },
          aiAdapter,
          { useAISummary: !!aiAdapter }
        );

        const path = writeReport(
          rootDir,
          'derived/verification/verification-report.json',
          report
        );
        ctx.artifacts.verification = report;

        return {
          stepId: 'verify',
          passed: report.authoritative.passed,
          outputs: [path],
          executedAt: now,
          error: report.authoritative.passed ? undefined : '一致性验证未通过',
          reportSummary: formatVerificationSummary(report),
        };
      } catch (err) {
        return {
          stepId: 'verify',
          passed: false,
          executedAt: now,
          error: err instanceof Error ? err.message : String(err),
          reportSummary: `一致性验证异常：${err instanceof Error ? err.message : err}`,
        };
      }
    },
  };
}
