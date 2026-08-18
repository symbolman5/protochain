/**
 * reasoner 与生成 loop 隔离测试 —— 红线 §7.3
 *
 * 验证：
 * - reason 步骤不走"生成 -> 修正"loop（adapter 只被调用一次，即使代码预判失败）；
 * - 可达性 / 死锁 / 活性由代码 BFS/SCC 判定主导，AI 结论不可推翻。
 */

import { reason } from '../../src/reasoner/index.js';
import { parseProtocolContent } from '../../src/parser/index.js';
import type { AIAdapter, AIPrompt, AIResponse } from '../../src/model/types.js';

/** AI 谎称一切通过，但模型中存在不可达 + 死锁状态 */
class DisagreeingAdapter implements AIAdapter {
  name = 'mock';
  calls = 0;

  async complete(_prompt: AIPrompt): Promise<AIResponse> {
    this.calls += 1;
    return {
      content: JSON.stringify({
        reachability: { passed: true, unreachableStates: [], unreachableTransitions: [], notes: 'AI：全部可达' },
        deadlock: { passed: true, deadlockStates: [], notes: 'AI：无死锁' },
        liveness: { passed: true, violations: [], notes: 'AI：活性满足' },
        consistency: { passed: true, violations: [], notes: 'AI：一致' },
      }),
      success: true,
      attempts: 1,
    };
  }
}

const MODEL_WITH_UNREACHABLE_DEADLOCK = `---
name: 隔离测试
version: 1.0.0
purpose: 验证代码预判主导
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
| S3 | 孤儿状态 | normal |

# 转移规则

| ID | 名称 | from | to | action |
|---|---|---|---|---|
| T1 | 完成 | S1 | S2 | finish |
`;

describe('reasoner 不被生成 loop 影响（红线）', () => {
  test('reason 只调用 AI 一次（无修正 loop），代码 BFS/SCC 结论不被 AI 推翻', async () => {
    const adapter = new DisagreeingAdapter();
    const report = await reason(
      parseProtocolContent(MODEL_WITH_UNREACHABLE_DEADLOCK),
      adapter
    );

    // 代码预判主导：不可达 + 死锁由 BFS/结构判定，AI 说通过也无效
    expect(report.reachability.passed).toBe(false);
    expect(report.reachability.unreachableStates).toContain('S3');
    expect(report.deadlock.passed).toBe(false);
    expect(report.deadlock.deadlockStates).toContain('S3');
    // 单次调用：reason 主路径不引入生成 loop
    expect(adapter.calls).toBe(1);
  });
});
