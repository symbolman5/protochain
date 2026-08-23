/**
 * ① 完备性检查执行器测试 —— 语义层 advisory 不阻断（问题清单 #10）
 *
 * 验证：机械层是唯一硬门；AI 语义层输出 error 级发现/失败时，
 * check 仍通过（语义结论以 advisory 保留在报告中）。
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseProtocolContent } from '../../src/parser/index.js';
import { createCheckExecutor } from '../../src/steps/check.js';
import type {
  AIAdapter,
  AIPrompt,
  AIResponse,
  CompletenessReport,
  DerivedArtifacts,
} from '../../src/model/types.js';
import type { StepContext } from '../../src/orchestrator/index.js';

class MockAIAdapter implements AIAdapter {
  name = 'mock';
  constructor(private responseContent: string, private succeed = true) {}
  async complete(_prompt: AIPrompt): Promise<AIResponse> {
    return { content: this.responseContent, success: this.succeed, attempts: 1 };
  }
}

// 机械层合法的模型
const GOOD_MODEL = parseProtocolContent(`---
name: 测试
version: 1.0.0
purpose: 测试语义层不阻断
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

// AI 返回 error 级语义发现（典型漂移输入）
const AI_ERRORS = JSON.stringify({
  duplications: [{ severity: 'error', category: 'dup', message: '语义重复', elementId: 'S2' }],
  ambiguities: [{ severity: 'error', category: 'amb', message: '表达式歧义', elementId: 'INV1' }],
  semanticIssues: [],
});

function makeCtx(rootDir: string, model = GOOD_MODEL): StepContext {
  return {
    model,
    rootDir,
    artifacts: {} as DerivedArtifacts,
  };
}

describe('createCheckExecutor（#10 语义层不阻断）', () => {
  test('AI 输出 error 级语义发现 → check 仍通过（机械层硬门）', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'check-exec-'));
    const executor = createCheckExecutor(new MockAIAdapter(AI_ERRORS));
    const result = await executor.execute(makeCtx(rootDir));

    expect(result.passed).toBe(true);
    expect(result.error).toBeUndefined();

    const report = JSON.parse(
      readFileSync(join(rootDir, 'derived/completeness-report.json'), 'utf8')
    ) as CompletenessReport;
    expect(report.mechanical.passed).toBe(true);
    // 语义层以 advisory 保留：发现问题、统一 warning、不阻断
    expect(report.semantic.advisory).toBe(true);
    expect(report.semantic.ambiguityIssues.every((i) => i.severity === 'warning')).toBe(true);
  });

  test('AI 调用失败 → check 仍通过（语义层执行失败不影响机械层结论）', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'check-exec-'));
    const executor = createCheckExecutor(new MockAIAdapter('', false));
    const result = await executor.execute(makeCtx(rootDir));

    expect(result.passed).toBe(true);

    const report = JSON.parse(
      readFileSync(join(rootDir, 'derived/completeness-report.json'), 'utf8')
    ) as CompletenessReport;
    expect(report.semantic.executed).toBe(false);
    expect(report.semantic.advisory).toBe(true);
  });

  test('机械层失败 → check 未通过（机械层仍是硬门）', async () => {
    const badModel = parseProtocolContent(`---
name: 测试
version: 1.0.0
purpose: 测试机械层硬门
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
| S1 | 重复 | normal |
| S2 | 终态 | terminal |
`);
    const rootDir = mkdtempSync(join(tmpdir(), 'check-exec-'));
    const executor = createCheckExecutor(new MockAIAdapter(AI_ERRORS));
    const result = await executor.execute(makeCtx(rootDir, badModel));

    expect(result.passed).toBe(false);
    expect(result.error).toBe('机械层完备性检查未通过');
  });
});
