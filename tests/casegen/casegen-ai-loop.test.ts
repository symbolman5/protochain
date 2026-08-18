/**
 * generate-cases AI 生成 loop 测试 —— P3 衔接
 *
 * 覆盖：
 * - 覆盖度机械预检不达标（未覆盖状态/转移）时触发一次修正并成功；
 * - 非法路径（未知转移）进入反馈并修正；
 * - 连续失败达到 maxIterations 后返回失败；
 * - 确定性路径（generateCases）不受影响。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProtocolContent } from '../../src/parser/index.js';
import { generateCases, generateCasesWithAI } from '../../src/casegen/index.js';
import { GenerationLoopError } from '../../src/ai/generation-loop.js';
import type { AIAdapter, AIPrompt, AIResponse } from '../../src/model/types.js';

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

describe('casegen AI 生成 loop', () => {
  const model = parseProtocolContent(readFileSync(join(FIXTURES, 'approval-flow.md'), 'utf-8'));

  // 只覆盖 S1/S2 的部分路径
  const PARTIAL = JSON.stringify({
    paths: [{ transitionIds: ['T1'], description: '提交到待审批' }],
  });
  // 覆盖全部 5 个状态（S1-S5）的完整路径
  const FULL = JSON.stringify({
    paths: [
      { transitionIds: ['T1', 'T2'], description: '提交并审批通过' },
      { transitionIds: ['T1', 'T3'], description: '提交并驳回' },
      { transitionIds: ['T1', 'T4'], description: '提交并撤回' },
    ],
  });

  test('覆盖度不达标时反馈未覆盖状态/转移，修正一次后成功', async () => {
    const adapter = new ScriptedAdapter([PARTIAL, FULL]);
    const cases = await generateCasesWithAI(model, adapter, {
      criterion: 'state',
      loop: { maxIterations: 3 },
    });

    expect(cases.coverage.stateCoverage.ratio).toBe(1);
    expect(cases.coverage.stateCoverage.coveredIds).toEqual(
      expect.arrayContaining(['S1', 'S2', 'S3', 'S4', 'S5'])
    );
    expect(adapter.calls).toHaveLength(2);
    // 第二次 prompt 携带未覆盖项反馈
    expect(adapter.calls[1].instruction).toContain('未覆盖项');
    expect(adapter.calls[1].instruction).toContain('S3');
    expect(adapter.calls[1].instruction).toContain('S5');
  });

  test('非法路径（未知转移）作为机械反馈进入修正', async () => {
    const INVALID = JSON.stringify({
      paths: [{ transitionIds: ['T99'], description: '未知转移' }],
    });
    const adapter = new ScriptedAdapter([INVALID, FULL]);
    const cases = await generateCasesWithAI(model, adapter, {
      criterion: 'state',
      loop: { maxIterations: 3 },
    });

    expect(cases.coverage.stateCoverage.ratio).toBe(1);
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[1].instruction).toContain('非法路径');
    expect(adapter.calls[1].instruction).toContain('T99');
  });

  test('连续失败达到 maxIterations 后返回失败', async () => {
    const adapter = new ScriptedAdapter([PARTIAL]);

    const err = await generateCasesWithAI(model, adapter, {
      criterion: 'state',
      loop: { maxIterations: 2 },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GenerationLoopError);
    expect((err as GenerationLoopError).attempts).toHaveLength(2);
    expect((err as GenerationLoopError).toolCalls).toBe(2);
  });

  test('确定性路径不受影响（无 AI 适配器）', () => {
    const cases = generateCases(model, { criterion: 'state' });
    expect(cases.coverage.stateCoverage.ratio).toBe(1);
    expect(cases.paths.every((p) => p.stateIds[0] === 'S1')).toBe(true);
  });
});
