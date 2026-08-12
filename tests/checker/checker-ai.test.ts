/**
 * 语义层 advisory 化测试 —— 对应工具链问题清单 #10
 *
 * 验证：
 * - AI 判定的语义问题跨 run 漂移不再影响 check 硬门：
 *   AI 输出 error 级 issues 时，语义层仍为 advisory（统一降级 warning）
 * - 语义发现内容保留，供人工复核
 */

import { parseProtocolContent } from '../../src/parser/index.js';
import { checkSemanticCompleteness } from '../../src/checker-ai/index.js';
import type { AIAdapter, AIPrompt, AIResponse } from '../../src/model/types.js';

class MockAIAdapter implements AIAdapter {
  name = 'mock';
  constructor(private responseContent: string, private succeed = true) {}
  async complete(_prompt: AIPrompt): Promise<AIResponse> {
    return { content: this.responseContent, success: this.succeed, attempts: 1 };
  }
}

const MODEL = parseProtocolContent(`---
name: 测试
version: 1.0.0
purpose: 测试语义层 advisory
roles:
  - id: r1
    name: 角色1
---

# 背景

测试

# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S1 | 初始 | initial |
| S2 | 终态 | terminal |

# 转移规则

| ID | 名称 | from | to | action |
|---|---|---|---|---|
| T1 | 动作 | S1 | S2 | act |
`);

// AI 输出含 error 级语义发现（跨 run 漂移的典型输入：同一内容可能被标 error 或 warning）
const AI_WITH_ERRORS = JSON.stringify({
  duplications: [
    { severity: 'error', category: 'semantic-dup', message: 'S1 与 S2 名称语义重复', elementId: 'S2' },
  ],
  ambiguities: [
    { severity: 'error', category: 'expression-ambiguity', message: 'INV1 表达式存在多义解读', elementId: 'INV1' },
  ],
  semanticIssues: [
    { severity: 'warning', category: 'semantic', message: '建议补充异常路径', elementId: 'T1' },
  ],
});

describe('语义层 advisory 化（#10）', () => {
  test('AI 输出 error 级发现 → 全部降级为 warning，advisory=true', async () => {
    const report = await checkSemanticCompleteness(MODEL, new MockAIAdapter(AI_WITH_ERRORS));

    expect(report.advisory).toBe(true);
    expect(report.executed).toBe(true);
    // 无 error 级 issue（AI 的 error 被统一降级，消除 passed 漂移）
    const all = [
      ...report.duplicationIssues,
      ...report.ambiguityIssues,
      ...report.semanticIssues,
    ];
    expect(all.every((i) => i.severity !== 'error')).toBe(true);
    expect(all.every((i) => i.severity === 'warning')).toBe(true);
    // 发现内容保留，供人工复核
    expect(all.length).toBe(3);
    expect(all.some((i) => i.message.includes('INV1'))).toBe(true);
  });

  test('语义层有发现 → passed=false 但仅作 advisory 参考（不阻断 check）', async () => {
    const report = await checkSemanticCompleteness(MODEL, new MockAIAdapter(AI_WITH_ERRORS));
    // passed 语义 =「无任何发现」；有发现即 false，但 check 硬门不受其影响（由 steps/check 保证）
    expect(report.passed).toBe(false);
  });

  test('AI 无发现 → passed=true 且 advisory=true', async () => {
    const clean = JSON.stringify({ duplications: [], ambiguities: [], semanticIssues: [] });
    const report = await checkSemanticCompleteness(MODEL, new MockAIAdapter(clean));
    expect(report.passed).toBe(true);
    expect(report.advisory).toBe(true);
  });

  test('AI 调用失败 → executed=false，advisory=true（不阻断 check）', async () => {
    const report = await checkSemanticCompleteness(MODEL, new MockAIAdapter('', false));
    expect(report.executed).toBe(false);
    expect(report.advisory).toBe(true);
    expect(report.passed).toBe(false);
  });
});
