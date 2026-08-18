/**
 * 生成类步骤可复用 loop 单测 —— P3 衔接
 *
 * 覆盖：
 * - 机械预检失败后能触发一次修正并成功；
 * - 连续失败达到 maxIterations 后返回失败（不无限重试）；
 * - 解析失败 / AI 调用失败同样作为反馈进入修正；
 * - token / tool 预算耗尽即失败。
 */

import {
  runGenerationLoop,
  GenerationLoopError,
  estimateTokens,
  type GenerationAttempt,
} from '../../src/ai/generation-loop.js';
import type { AIAdapter, AIPrompt, AIResponse } from '../../src/model/types.js';

interface ScriptStep {
  content?: string;
  success?: boolean;
  error?: string;
}

class ScriptedAdapter implements AIAdapter {
  name = 'mock';
  calls: AIPrompt[] = [];

  constructor(private script: ScriptStep[]) {}

  async complete(prompt: AIPrompt): Promise<AIResponse> {
    this.calls.push(prompt);
    const step = this.script[Math.min(this.calls.length - 1, this.script.length - 1)];
    if (step.success === false) {
      return { content: '', success: false, error: step.error };
    }
    return { content: step.content ?? '', success: true, attempts: 1 };
  }
}

function identityPrompt({ iteration, previousAttempts }: {
  iteration: number;
  previousAttempts: GenerationAttempt<string>[];
}): AIPrompt {
  const feedback = previousAttempts
    .map((a) => a.preflight.feedback)
    .filter((f): f is string => Boolean(f));
  return {
    system: 'system',
    context: 'context',
    instruction: `iteration=${iteration}` + (feedback.length > 0 ? `\nFIX:${feedback.join('|')}` : ''),
    outputFormat: 'text',
    temperature: 0,
  };
}

describe('generation-loop', () => {
  test('机械预检失败后能触发一次修正并成功', async () => {
    const adapter = new ScriptedAdapter([{ content: 'first' }, { content: 'second' }]);

    const result = await runGenerationLoop<string>(
      adapter,
      {
        buildPrompt: identityPrompt,
        parse: async (c) => c,
        preflight: async (r) =>
          r === 'first'
            ? { passed: false, feedback: '编译错误：TS1001 语法错误' }
            : { passed: true },
      },
      { maxIterations: 3 }
    );

    expect(result.ok).toBe(true);
    expect(result.result).toBe('second');
    expect(result.corrections).toBe(1);
    expect(result.toolCalls).toBe(2);
    expect(adapter.calls).toHaveLength(2);
    // 第二次 prompt 必须携带第一次的机械反馈
    expect(adapter.calls[1].instruction).toContain('编译错误：TS1001 语法错误');
  });

  test('连续失败达到 maxIterations 后返回失败（不无限重试）', async () => {
    const adapter = new ScriptedAdapter([{ content: 'bad' }]);

    const err = await runGenerationLoop<string>(
      adapter,
      {
        buildPrompt: identityPrompt,
        parse: async (c) => c,
        preflight: async () => ({ passed: false, feedback: '仍不达标' }),
      },
      { maxIterations: 3 }
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GenerationLoopError);
    const loopErr = err as GenerationLoopError;
    expect(loopErr.attempts).toHaveLength(3);
    expect(loopErr.toolCalls).toBe(3);
    expect(loopErr.lastFeedback).toContain('仍不达标');
    expect(adapter.calls).toHaveLength(3);
  });

  test('产物解析失败作为一次失败尝试，反馈后可修正成功', async () => {
    const adapter = new ScriptedAdapter([
      { content: 'not-json' },
      { content: '{"ok":true}' },
    ]);

    const result = await runGenerationLoop<Record<string, boolean>>(
      adapter,
      {
        buildPrompt: identityPrompt,
        parse: async (c) => {
          if (!c.startsWith('{')) throw new Error('JSON 解析失败：Unexpected token');
          return JSON.parse(c) as Record<string, boolean>;
        },
        preflight: async () => ({ passed: true }),
      },
      { maxIterations: 2 }
    );

    expect(result.corrections).toBe(1);
    expect(result.result).toEqual({ ok: true });
    expect(adapter.calls[1].instruction).toContain('JSON 解析失败');
  });

  test('AI 调用失败进入反馈并重试', async () => {
    const adapter = new ScriptedAdapter([
      { success: false, error: 'HTTP 500' },
      { content: 'ok' },
    ]);

    const result = await runGenerationLoop<string>(
      adapter,
      {
        buildPrompt: identityPrompt,
        parse: async (c) => c,
        preflight: async () => ({ passed: true }),
      },
      { maxIterations: 3 }
    );

    expect(result.corrections).toBe(1);
    expect(result.result).toBe('ok');
    expect(adapter.calls[1].instruction).toContain('AI 调用失败：HTTP 500');
  });

  test('tool 预算（maxToolCalls）耗尽即失败', async () => {
    const adapter = new ScriptedAdapter([{ content: 'bad' }]);

    const err = await runGenerationLoop<string>(
      adapter,
      {
        buildPrompt: identityPrompt,
        parse: async (c) => c,
        preflight: async () => ({ passed: false, feedback: '不达标' }),
      },
      { maxIterations: 5, maxToolCalls: 1 }
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GenerationLoopError);
    expect((err as GenerationLoopError).toolCalls).toBe(1);
    expect((err as GenerationLoopError).attempts).toHaveLength(1);
  });

  test('token 预算耗尽即失败（不发起更多调用）', async () => {
    const adapter = new ScriptedAdapter([{ content: 'ok' }]);

    const err = await runGenerationLoop<string>(
      adapter,
      {
        buildPrompt: identityPrompt,
        parse: async (c) => c,
        preflight: async () => ({ passed: true }),
      },
      { maxIterations: 3, maxTokens: 1 }
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GenerationLoopError);
    expect((err as GenerationLoopError).toolCalls).toBe(0);
    expect((err as GenerationLoopError).message).toContain('预算已耗尽');
  });

  test('estimateTokens 按字符数估算', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcdefgh')).toBe(2);
  });
});
