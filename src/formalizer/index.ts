/**
 * 形式化桥接 —— 步骤③（AI 翻译 + 工具验证）
 *
 * 设计依据：《协议驱动自验证工具链设计方案》formalizer 模块
 *
 * 职责：
 * 1. 基于协议特征选择形式化工具（detectSuitability 规则化评分）
 * 2. 生成形式化规格（退化模式直接透传，正常模式由代码生成骨架）
 * 3. 调用形式化工具验证（仅 TLC 未配置时降级为 AI 推演；已配置 TLC 的失败为权威结论）
 * 4. 解析验证报告，提取每个不变量的验证结果
 *
 * 人工检查点：人仲裁是协议缺陷还是 AI 翻译错误
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type {
  AIAdapter,
  SourceProtocolModel,
  DerivableLayer,
  FormalReport,
  FormalToolAdapter,
  InvariantVerifyResult,
  TlcConfig,
} from '../model/types.js';
import { parseAIJson } from '../ai/adapter.js';
import {
  createAllAdapters,
  selectBestAdapter,
  scoreAllAdapters,
} from './adapters.js';

export interface FormalizeOptions {
  /** 指定形式化工具（不指定则自动选择） */
  preferredTool?: string;
  /** 是否允许 AI fallback（工具不可用时降级为 AI 推演） */
  allowAIFallback?: boolean;
  /** TLC 模型检查器配置（portable JRE + tla2tools.jar；配置后 TLA+ 走真实模型检查） */
  tlc?: TlcConfig;
  /** 形式化规格输出目录（如 derived/formal） */
  outputDir?: string;
}

export interface FormalizeResult {
  report: FormalReport;
  /** 规格文件路径 */
  specFilePath?: string;
  /** 选择工具的依据 */
  selectionReasons: string[];
}

export async function formalize(
  model: SourceProtocolModel,
  aiAdapter: AIAdapter,
  options: FormalizeOptions = {}
): Promise<FormalizeResult> {
  const { preferredTool, allowAIFallback = true, outputDir, tlc } = options;
  const derivable = model.derivable;

  // 1. 选择形式化工具
  const adapters = createAllAdapters(aiAdapter, tlc);
  const { adapter, score, reasons } = selectBestAdapter(
    derivable,
    adapters,
    preferredTool
  );

  // 2. 生成形式化规格（确定性代码生成）
  const generatedSpec = adapter.generateSpec(derivable);

  // 3. 写入规格文件
  let specFilePath: string | undefined;
  if (outputDir) {
    const ext = adapter.name === 'scxml' ? '.scxml' : adapter.name === 'decision-table' ? '.yaml' : '.tla';
    const filename = `model${ext}`;
    specFilePath = join(outputDir, filename);
    mkdirSync(dirname(specFilePath), { recursive: true });
    writeFileSync(specFilePath, generatedSpec, 'utf-8');
  }

  // 4. 调用工具验证
  // 已配置 tlc 时调用真实 TLC，其任何结果（通过/解析失败/超时/反例）均为权威结论；
  // 仅 TLC 未配置（工具不可用）时降级为 AI 推演
  let report: FormalReport;
  try {
    const toolReport = await adapter.verify(generatedSpec);
    // 工具真实执行并产出结论（含反例）→ 结果权威；否则仅在通过时采用
    const toolRan = toolReport.toolExecuted === true;

    if (toolReport.passed || !allowAIFallback || toolRan) {
      // 工具验证通过/不允许降级/工具真实执行
      // 工具真实执行时结果权威：不再用 AI 补验不变量；仅工具未运行时用 AI 补全
      const shouldFillWithAI =
        allowAIFallback && !toolRan && toolReport.invariantResults.length === 0;
      report = {
        passed: toolReport.passed,
        tool: adapter.name,
        suitabilityScore: score,
        generatedSpec,
        specFilePath,
        rawOutput: toolReport.rawOutput,
        toolExecuted: toolReport.toolExecuted,
        invariantResults: shouldFillWithAI
          ? await verifyInvariantsWithAI(model, aiAdapter, generatedSpec, adapter.name)
          : toolReport.invariantResults,
        verifiedAt: new Date().toISOString(),
      };
    } else {
      // 工具未配置（verify 返回占位报告）→ 降级为 AI 推演验证
      const toolError = toolReport.rawOutput ? toolReport.rawOutput.split('\n')[0] : undefined;
      report = await aiFallbackVerify(
        model,
        aiAdapter,
        adapter,
        score,
        generatedSpec,
        specFilePath,
        reasons,
        toolError
      );
    }
  } catch (err) {
    if (!allowAIFallback) {
      throw err;
    }
    report = await aiFallbackVerify(
      model,
      aiAdapter,
      adapter,
      score,
      generatedSpec,
      specFilePath,
      reasons,
      err instanceof Error ? err.message : String(err)
    );
  }

  return { report, specFilePath, selectionReasons: reasons };
}

// ============================================================================
// AI Fallback 验证（工具不可用时降级）
// ============================================================================

async function aiFallbackVerify(
  model: SourceProtocolModel,
  aiAdapter: AIAdapter,
  adapter: FormalToolAdapter,
  score: number,
  generatedSpec: string,
  specFilePath: string | undefined,
  reasons: string[],
  toolError?: string
): Promise<FormalReport> {
  const invariantResults = await verifyInvariantsWithAI(
    model,
    aiAdapter,
    generatedSpec,
    adapter.name
  );

  const allPassed = invariantResults.every((r) => r.passed);

  return {
    passed: allPassed,
    // 标注降级模式
    tool: `${adapter.name}-ai-fallback`,
    suitabilityScore: score,
    generatedSpec,
    specFilePath,
    rawOutput: `形式化工具 ${adapter.name} 不可用（${toolError ?? '未安装'}），降级为 AI 推演验证。` +
      `\n选择依据：${reasons.join('; ')}`,
    invariantResults,
    verifiedAt: new Date().toISOString(),
  };
}

/**
 * 使用 AI 验证每个不变量
 *
 * 给定生成的形式化规格与不变量列表，AI 判断每个不变量在规格中是否成立
 */
async function verifyInvariantsWithAI(
  model: SourceProtocolModel,
  aiAdapter: AIAdapter,
  generatedSpec: string,
  toolName: string
): Promise<InvariantVerifyResult[]> {
  if (model.derivable.invariants.length === 0) {
    return [];
  }

  const prompt = buildInvariantVerificationPrompt(model, generatedSpec, toolName);
  const response = await aiAdapter.complete(prompt);

  if (!response.success) {
    return model.derivable.invariants.map((inv) => ({
      invariantId: inv.id,
      passed: false,
      counterexample: `AI 验证失败：${response.error}`,
    }));
  }

  try {
    const parsed = parseAIJson<{ results: InvariantVerifyResult[] }>(response.content);
    // 补全缺失的不变量结果
    const resultMap = new Map(parsed.results.map((r) => [r.invariantId, r]));
    return model.derivable.invariants.map((inv) => {
      const r = resultMap.get(inv.id);
      return r ?? { invariantId: inv.id, passed: false, counterexample: 'AI 未返回结果' };
    });
  } catch {
    return model.derivable.invariants.map((inv) => ({
      invariantId: inv.id,
      passed: false,
      counterexample: 'AI 输出解析失败',
    }));
  }
}

function buildInvariantVerificationPrompt(
  model: SourceProtocolModel,
  generatedSpec: string,
  toolName: string
): { system: string; context: string; instruction: string; outputFormat: string; temperature: number } {
  const invariants = model.derivable.invariants.map((inv) => ({
    id: inv.id,
    name: inv.name,
    expression: inv.expression,
    description: inv.description,
    scopeStateIds: inv.scopeStateIds,
  }));

  return {
    system:
      `你是形式化规格验证专家。给定 ${toolName} 规格与不变量列表，` +
      '请判断每个不变量在规格中是否成立。若不成立，给出反例。' +
      '若规格因生成器限制包含未声明的标识符而无法直接判定，请基于结构化协议模型（states/transitions 的 guard/effects）判断。' +
      '输出严格 JSON。',
    context: JSON.stringify(
      {
        formalLanguage: toolName,
        formalSpec: generatedSpec,
        invariants,
        // 结构化协议模型：生成器无法翻译的表达式（如自然语言守卫/不变量变量）以模型语义为准
        model: {
          name: model.metadata.name,
          states: model.derivable.states.map((s) => ({
            id: s.id,
            name: s.name,
            type: s.type,
            roleIds: s.roleIds,
          })),
          transitions: model.derivable.transitions.map((t) => ({
            id: t.id,
            name: t.name,
            from: t.from,
            to: t.to,
            action: t.action,
            trigger: t.trigger ?? t.triggerRoleId,
            guard: t.guard,
            effects: t.effects,
          })),
          initialStateId: model.derivable.initialStateId,
          terminalStateIds: model.derivable.terminalStateIds,
        },
      },
      null,
      2
    ),
    instruction: [
      '请对每个不变量判断其在上述规格中是否成立：',
      '- 若成立，passed=true',
      '- 若不成立，passed=false 并提供 counterexample（具体的状态/路径）',
      '- 必须为每个不变量返回结果，invariantId 与输入一致',
      '- 不变量仅在作用状态（scopeStateIds）上成立：只在该状态集上评估，',
      '  未列入 scopeStateIds 的状态不要求该不变量成立',
      '- 当 formalSpec 含未定义的标识符（生成器无法翻译自然语言表达式）时，',
      '  以结构化 model（transitions 的 guard/effects 决定状态可达性）为准判断不变量是否恒成立',
    ].join('\n'),
    outputFormat: [
      '返回 JSON：',
      '{',
      '  "results": [',
      '    { "invariantId": "INV1", "passed": true },',
      '    { "invariantId": "INV2", "passed": false, "counterexample": "状态 S5 时违反..." }',
      '  ]',
      '}',
    ].join('\n'),
    temperature: 0.1,
  };
}

// ============================================================================
// 工具：仅做工具选择分析（不实际验证）
// ============================================================================

export function analyzeToolSuitability(model: DerivableLayer) {
  const scores = scoreAllAdapters(model);
  return scores;
}
