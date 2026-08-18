/**
 * 生成类步骤可复用 loop —— "生成 → 机械预检 → 修正 → 重试"
 *
 * 设计依据：《Harness 架构设计》§7.1（P3 衔接）：
 * - 只用于纯 AI 生成类步骤（generate-tests / generate-cases 等）；
 * - 预检信号必须来自机械层（编译 / schema 解析 / 覆盖度统计），
 *   循环内只做低风险预检，权威结论仍由步骤边界给出；
 * - 每次失败把机械预检结果作为反馈重新交给 AI；
 * - 受最大修正轮数 + 总 token/tool 预算约束，达到预算仍失败则返回失败，不得无限重试。
 *
 * 不得用于 reason / formalize 等以代码确定性判定为主路径的步骤（红线 §7.3）。
 */
import type { AIAdapter, AIPrompt, AIResponse } from '../model/types.js';

export interface GenerationLoopOptions {
  /** 最大生成轮数（含首次生成；默认 3） */
  maxIterations?: number;
  /** 近似 token 总预算（prompt + response 累计；默认 20000） */
  maxTokens?: number;
  /** 最大 AI 调用次数（tool 预算；默认 10） */
  maxToolCalls?: number;
}

/** 机械预检结果。passed=false 时必须提供 feedback 作为给 AI 的修正信号。 */
export interface PreflightOutcome<T> {
  passed: boolean;
  /** 未通过时的机械反馈（编译错误 / schema 解析错误 / 未覆盖项等） */
  feedback?: string;
  /** 预检校正后的结果（可选；默认为原结果） */
  result?: T;
}

export interface GenerationAttempt<T> {
  /** 第几次生成（从 1 开始） */
  iteration: number;
  response: AIResponse;
  /** 解析后的产物（解析失败时为 undefined） */
  parsed?: T;
  preflight: PreflightOutcome<T>;
}

export interface GenerationLoopCallbacks<T> {
  /** 构造本次 AI 调用的 prompt；可把历史失败反馈拼入 instruction/context */
  buildPrompt: (attempt: {
    iteration: number;
    previousAttempts: GenerationAttempt<T>[];
  }) => AIPrompt;
  /** 把 AI 输出解析为结构化产物；解析失败应 throw（作为一次失败尝试） */
  parse: (content: string) => T | Promise<T>;
  /** 机械预检：编译 / schema 校验 / 覆盖度统计等；未通过时返回 feedback */
  preflight: (
    result: T,
    attempt: { iteration: number }
  ) => PreflightOutcome<T> | Promise<PreflightOutcome<T>>;
}

export interface GenerationLoopSuccess<T> {
  ok: true;
  result: T;
  attempts: GenerationAttempt<T>[];
  /** 成功前经历的失败修正次数 */
  corrections: number;
  /** 累计 AI 调用次数 */
  toolCalls: number;
}

export class GenerationLoopError extends Error {
  readonly attempts: GenerationAttempt<unknown>[];
  readonly toolCalls: number;
  readonly lastFeedback?: string;

  constructor(
    message: string,
    attempts: GenerationAttempt<unknown>[],
    toolCalls: number
  ) {
    super(message);
    this.name = 'GenerationLoopError';
    this.attempts = attempts;
    this.toolCalls = toolCalls;
    const last = attempts[attempts.length - 1];
    this.lastFeedback = last?.preflight.feedback;
  }
}

/**
 * 运行"生成 → 机械预检 → 修正 → 重试"loop。
 *
 * - 每次失败把机械 feedback 交给 buildPrompt，供 AI 修正；
 * - maxIterations / maxTokens / maxToolCalls 任一耗尽仍未通过即抛 GenerationLoopError；
 * - 无 AI 适配器时不应调用本函数（调用方走确定性路径）。
 */
export async function runGenerationLoop<T>(
  aiAdapter: AIAdapter,
  callbacks: GenerationLoopCallbacks<T>,
  options: GenerationLoopOptions = {}
): Promise<GenerationLoopSuccess<T>> {
  const maxIterations = Math.max(1, options.maxIterations ?? 3);
  const maxTokens = Math.max(1, options.maxTokens ?? 20000);
  const maxToolCalls = Math.max(1, options.maxToolCalls ?? 10);

  const attempts: GenerationAttempt<T>[] = [];
  let totalTokens = 0;
  let toolCalls = 0;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    if (toolCalls >= maxToolCalls) {
      break;
    }

    const prompt = callbacks.buildPrompt({ iteration, previousAttempts: attempts });
    const promptTokens = estimateTokens(
      prompt.system,
      prompt.context,
      prompt.instruction,
      prompt.outputFormat
    );
    if (totalTokens + promptTokens >= maxTokens) {
      break;
    }

    const response = await aiAdapter.complete(prompt);
    toolCalls += 1;
    totalTokens += promptTokens + estimateTokens(response.content);

    if (!response.success) {
      attempts.push({
        iteration,
        response,
        preflight: {
          passed: false,
          feedback: `AI 调用失败：${response.error ?? '未知错误'}`,
        },
      });
      continue;
    }

    let parsed: T;
    try {
      parsed = await callbacks.parse(response.content);
    } catch (err) {
      attempts.push({
        iteration,
        response,
        preflight: {
          passed: false,
          feedback: `产物解析失败：${err instanceof Error ? err.message : String(err)}`,
        },
      });
      continue;
    }

    const outcome = await callbacks.preflight(parsed, { iteration });
    attempts.push({ iteration, response, parsed, preflight: outcome });

    if (outcome.passed) {
      const corrections = attempts.filter((a) => !a.preflight.passed).length;
      return {
        ok: true,
        result: outcome.result ?? parsed,
        attempts,
        corrections,
        toolCalls,
      };
    }
  }

  const last = attempts[attempts.length - 1];
  const reason = last?.preflight.feedback
    ? `最后一次失败原因：${last.preflight.feedback}`
    : '预算已耗尽';
  throw new GenerationLoopError(
    `生成结果未通过机械预检（尝试 ${attempts.length} 轮，AI 调用 ${toolCalls} 次）：${reason}`,
    attempts as GenerationAttempt<unknown>[],
    toolCalls
  );
}

/** 粗略 token 估算：按字符数 / 4（足够做预算控制） */
export function estimateTokens(...texts: string[]): number {
  let chars = 0;
  for (const t of texts) {
    if (!t) continue;
    chars += t.length;
  }
  return Math.ceil(chars / 4);
}
