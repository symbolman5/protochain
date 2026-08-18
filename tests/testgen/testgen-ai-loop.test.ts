/**
 * generate-tests AI 生成 loop 测试 —— P3 衔接
 *
 * 覆盖：
 * - AI 生成的 TypeScript 未通过机械预检（tsc --noEmit）时触发一次修正并成功；
 * - 连续失败达到 maxIterations 后返回失败；
 * - 无 AI 适配器 / useAI=false 时保持确定性路径不变。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProtocolContent } from '../../src/parser/index.js';
import { specify } from '../../src/specifier/index.js';
import { generateTestTool } from '../../src/testgen/index.js';
import { GenerationLoopError } from '../../src/ai/generation-loop.js';
import type { AIAdapter, AIPrompt, AIResponse, TestToolCode } from '../../src/model/types.js';

const FIXTURES = join(process.cwd(), 'tests/fixtures');

class ScriptedAdapter implements AIAdapter {
  name = 'mock';
  calls: AIPrompt[] = [];

  constructor(private script: string[]) {}

  async complete(prompt: AIPrompt): Promise<AIResponse> {
    this.calls.push(prompt);
    const content = this.script[Math.min(this.calls.length - 1, this.script.length - 1)];
    return { content, success: true, attempts: 1 };
  }
}

describe('testgen AI 生成 loop', () => {
  const model = parseProtocolContent(readFileSync(join(FIXTURES, 'approval-flow.md'), 'utf-8'));
  const specs = specify(model);

  test('机械预检（tsc --noEmit）失败后能触发一次修正并成功', async () => {
    // 确定性生成结果作为"正确"答案
    const deterministic = await generateTestTool(model, specs, undefined, undefined, {});
    const broken = `${deterministic.protocolExecutor}\nconst __bogus: number = "not-a-number";\n`;

    const adapter = new ScriptedAdapter([broken, deterministic.protocolExecutor]);
    const tool = await generateTestTool(model, specs, undefined, adapter, {
      useAI: true,
      loop: { maxIterations: 3 },
    });

    expect(tool.protocolExecutor).toBe(deterministic.protocolExecutor);
    expect(adapter.calls).toHaveLength(2);
    // 第二次 prompt 携带 tsc 编译反馈
    expect(adapter.calls[1].instruction).toContain('tsc');
    expect(adapter.calls[1].instruction).toContain('TS2322');
  });

  test('连续失败达到 maxIterations 后返回失败', async () => {
    const deterministic = await generateTestTool(model, specs, undefined, undefined, {});
    const broken = `${deterministic.protocolExecutor}\nconst __bogus: number = "not-a-number";\n`;
    const adapter = new ScriptedAdapter([broken]);

    const err = await generateTestTool(model, specs, undefined, adapter, {
      useAI: true,
      loop: { maxIterations: 2 },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GenerationLoopError);
    expect((err as GenerationLoopError).attempts).toHaveLength(2);
    expect((err as GenerationLoopError).toolCalls).toBe(2);
    expect(adapter.calls).toHaveLength(2);
  });

  test('useAI=true 但无 AI 适配器时保持确定性路径', async () => {
    const deterministic = await generateTestTool(model, specs, undefined, undefined, {});
    const noAdapter = await generateTestTool(model, specs, undefined, undefined, {
      useAI: true,
    });
    expect(normalize(noAdapter)).toEqual(normalize(deterministic));
  });

  test('useAI=false 时保持确定性路径（不回退、不破坏）', async () => {
    const deterministic = await generateTestTool(model, specs, undefined, undefined, {});
    const plain = await generateTestTool(model, specs, undefined, undefined, {
      useAI: false,
    });
    expect(normalize(plain)).toEqual(normalize(deterministic));
    expect(plain.protocolExecutor).toContain('export async function executeAction');
    expect(plain.protocolModel).toContain('PROTOCOL_NAME');
  });
});

function withoutTimestamp(tool: TestToolCode): Omit<TestToolCode, 'generatedAt'> {
  const { generatedAt: _generatedAt, ...rest } = tool;
  return rest;
}

/** 归一化：顶层 generatedAt 与源码内嵌的"生成时间"注释均不稳定，比较前固定 */
function normalize(tool: TestToolCode): Omit<TestToolCode, 'generatedAt'> {
  return {
    ...withoutTimestamp(tool),
    protocolModel: tool.protocolModel.replace(
      /生成时间：\d{4}-\d{2}-\d{2}T[\d:.]+Z/,
      '生成时间：<GENERATED>'
    ),
  };
}
