/**
 * 组合层完备性语义检查 —— 步骤①-C 语义层（AI 执行）
 *
 * 设计依据：《协议驱动自验证工具链设计方案》2.1 composition-checker-ai 模块、AI参与矩阵
 *
 * AI 检查两类组合层语义问题：
 * 1. 跨协议不变量表达式歧义：crossInvariants.expression 是否存在多义解读
 * 2. 切面约束语义重复：objectStateFacets.crossFacetConstraints 是否与某条跨协议不变量语义重复
 *
 * 人工检查点：人判断哪些是 AI 误报
 */

import type {
  AIAdapter,
  CompositionModel,
  SemanticCheckResult,
  CheckIssue,
} from '../model/types.js';
import { parseAIJson } from '../ai/adapter.js';

interface AICompositionSemanticFinding {
  severity: 'error' | 'warning' | 'info';
  category: string;
  message: string;
  elementId?: string;
  suggestion?: string;
}

interface AICompositionSemanticReport {
  ambiguities: AICompositionSemanticFinding[]; // 不变量表达式歧义
  duplications: AICompositionSemanticFinding[]; // 切面约束语义重复
  semanticIssues: AICompositionSemanticFinding[]; // 其他独立语义判断
}

export async function checkCompositionSemantic(
  composition: CompositionModel,
  adapter: AIAdapter
): Promise<SemanticCheckResult> {
  const prompt = buildCompositionSemanticPrompt(composition);
  const response = await adapter.complete(prompt);

  if (!response.success) {
    return {
      passed: false,
      duplicationIssues: [],
      ambiguityIssues: [],
      semanticIssues: [],
      executed: false,
      advisory: true,
    };
  }

  let report: AICompositionSemanticReport;
  try {
    report = parseAIJson<AICompositionSemanticReport>(response.content);
  } catch {
    return {
      passed: false,
      duplicationIssues: [
        {
          severity: 'error',
          category: 'ai-parse',
          message: 'AI 输出无法解析为 JSON，需人工复核原始输出',
        },
      ],
      ambiguityIssues: [],
      semanticIssues: [],
      executed: true,
      advisory: true,
    };
  }

  // 语义层为 advisory（问题清单 #10）：AI 判定跨 run 非确定，
  // 不能作为 check-composition 的硬门。所有 AI 发现统一降级为 warning。
  const ambiguityIssues = report.ambiguities.map(toAdvisoryIssue);
  const duplicationIssues = report.duplications.map(toAdvisoryIssue);
  const semanticIssues = report.semanticIssues.map(toAdvisoryIssue);

  const passed =
    ambiguityIssues.length === 0 &&
    duplicationIssues.length === 0 &&
    semanticIssues.length === 0;

  return {
    passed,
    duplicationIssues,
    ambiguityIssues,
    semanticIssues,
    executed: true,
    advisory: true,
  };
}

/** AI 发现的语义问题统一降级为 warning（内容保留，供人工参考，不阻断） */
function toAdvisoryIssue(f: AICompositionSemanticFinding): CheckIssue {
  return {
    severity: 'warning',
    category: f.category,
    message: f.message,
    elementId: f.elementId,
    suggestion: f.suggestion,
  };
}

function buildCompositionSemanticPrompt(composition: CompositionModel): {
  system: string;
  context: string;
  instruction: string;
  outputFormat: string;
  temperature: number;
} {
  const context = JSON.stringify(
    {
      metadata: composition.metadata,
      subProtocols: composition.subProtocols,
      crossInvariants: composition.crossInvariants,
      crossTiming: composition.crossTiming,
      objectStateFacets: composition.objectStateFacets,
      securityAssumptions: composition.securityAssumptions,
    },
    null,
    2
  );

  return {
    system:
      '你是组合层完备性语义检查器。你只做语义判断，不做创造性修改。' +
      '你的输出必须是严格的 JSON，不附加任何解释性文字。' +
      '若不确定，severity 用 warning 或 info，不要随意标 error。',
    context,
    instruction: [
      '对上述组合层模型做三类语义检查：',
      '1. 跨协议不变量表达式歧义（ambiguities）：crossInvariants.expression 是否存在多义解读、量词范围不清、跨协议状态引用不明',
      '2. 切面约束语义重复（duplications）：objectStateFacets.crossFacetConstraints 是否与某条 crossInvariants 语义重复（即同一约束被声明两次）',
      '3. 独立语义判断（semanticIssues）：根据系统目的，发现的其他组合层语义问题（如缺失的跨协议不变量、矛盾的切面约束）',
    ].join('\n'),
    outputFormat: JSON.stringify(
      {
        ambiguities: [
          {
            severity: 'error|warning|info',
            category: 'cross-invariant-ambiguity',
            message: '问题描述',
            elementId: '相关不变量ID',
            suggestion: '可选改进建议',
          },
        ],
        duplications: [
          {
            severity: 'error|warning|info',
            category: 'facet-constraint-duplication',
            message: '问题描述',
            elementId: '相关切面对象',
            suggestion: '可选改进建议',
          },
        ],
        semanticIssues: [
          {
            severity: 'error|warning|info',
            category: 'composition-semantic',
            message: '问题描述',
            elementId: '相关元素ID',
            suggestion: '可选改进建议',
          },
        ],
      },
      null,
      2
    ),
    temperature: 0.2,
  };
}
