/**
 * 完备性语义检查 —— 步骤①语义层（AI 执行）
 *
 * 设计依据：《协议驱动自验证工具链设计方案》AI参与矩阵
 *
 * AI 检查三类语义问题：
 * 1. 语义重复：名称或描述语义重复的元素
 * 2. 表达式歧义：不变量/守卫条件表达式语义不清
 * 3. 独立语义判断：AI 根据上下文发现的其他语义问题
 *
 * 人工检查点：人判断哪些是 AI 误报
 */

import type {
  AIAdapter,
  SourceProtocolModel,
  SemanticCheckResult,
  CheckIssue,
} from '../model/types.js';
import { parseAIJson } from '../ai/adapter.js';

interface AISemanticFinding {
  severity: 'error' | 'warning' | 'info';
  category: string;
  message: string;
  elementId?: string;
  suggestion?: string;
}

interface AISemanticReport {
  duplications: AISemanticFinding[];
  ambiguities: AISemanticFinding[];
  semanticIssues: AISemanticFinding[];
}

export async function checkSemanticCompleteness(
  model: SourceProtocolModel,
  adapter: AIAdapter
): Promise<SemanticCheckResult> {
  const prompt = buildSemanticPrompt(model);
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

  let report: AISemanticReport;
  try {
    report = parseAIJson<AISemanticReport>(response.content);
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
  // 不能作为 check 的硬门。所有 AI 发现统一降级为 warning，
  // 消除同一条发现被 AI 标 error/warning 导致的 passed 翻转。
  const duplicationIssues = report.duplications.map(toAdvisoryIssue);
  const ambiguityIssues = report.ambiguities.map(toAdvisoryIssue);
  const semanticIssues = report.semanticIssues.map(toAdvisoryIssue);

  const passed =
    duplicationIssues.length === 0 &&
    ambiguityIssues.length === 0 &&
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

/** AI 发现的语义问题统一降级为 warning（内容保留，供人工参考，不阻断 check） */
function toAdvisoryIssue(f: AISemanticFinding): CheckIssue {
  return {
    severity: 'warning',
    category: f.category,
    message: f.message,
    elementId: f.elementId,
    suggestion: f.suggestion,
  };
}

function buildSemanticPrompt(model: SourceProtocolModel): {
  system: string;
  context: string;
  instruction: string;
  outputFormat: string;
  temperature: number;
} {
  const context = JSON.stringify(
    {
      metadata: {
        name: model.metadata.name,
        version: model.metadata.version,
        purpose: model.metadata.purpose,
        roles: model.metadata.roles,
      },
      derivable: {
        degraded: model.derivable.degraded,
        formalLanguage: model.derivable.formalLanguage,
        states: model.derivable.states,
        transitions: model.derivable.transitions,
        invariants: model.derivable.invariants,
        timing: model.derivable.timing,
        exceptions: model.derivable.exceptions,
      },
    },
    null,
    2
  );

  return {
    system:
      '你是协议完备性语义检查器。你只做语义判断，不做创造性修改。' +
      '你的输出必须是严格的 JSON，不附加任何解释性文字。' +
      '若不确定，severity 用 warning 或 info，不要随意标 error。',
    context,
    instruction: [
      '对上述协议模型做三类语义检查：',
      '1. 语义重复：名称或描述语义重复的元素（如同义状态、同义动作）',
      '2. 表达式歧义：不变量表达式、守卫条件是否存在多义解读',
      '3. 独立语义判断：根据协议目的，发现的其他语义问题（如缺失状态、矛盾约束）',
      '',
      '注意：',
      '- 不要报告纯机械层问题（ID 重复、字段缺失、引用断裂已由代码检查）',
      '- 每个发现须指向具体 elementId',
      '- 若无问题，对应数组返回空',
    ].join('\n'),
    outputFormat: [
      '返回 JSON：',
      '{',
      '  "duplications": [{ "severity": "error|warning|info", "category": "string", "message": "string", "elementId": "string", "suggestion": "string" }],',
      '  "ambiguities": [{ ...同上 }],',
      '  "semanticIssues": [{ ...同上 }]',
      '}',
    ].join('\n'),
    temperature: 0.1,
  };
}
