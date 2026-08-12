import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProtocolContent } from '../../src/parser/index.js';
import { reason } from '../../src/reasoner/index.js';
import type { AIAdapter, AIPrompt, AIResponse, SourceProtocolModel } from '../../src/model/types.js';

const FIXTURES = join(process.cwd(), 'tests/fixtures');
function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf-8');
}

// 测试用 AI 适配器：可控返回
class MockAIAdapter implements AIAdapter {
  name = 'mock';
  constructor(private responseContent: string, private succeed = true) {}
  async complete(prompt: AIPrompt): Promise<AIResponse> {
    return {
      content: this.responseContent,
      success: this.succeed,
      attempts: 1,
    };
  }
}

describe('reasoner', () => {
  describe('代码预判（不依赖 AI）', () => {
    test('审批流正常协议：可达性、死锁预判通过', async () => {
      const model = parseProtocolContent(readFixture('approval-flow.md'));
      // 给一个全通过的 AI 响应
      const aiResponse = JSON.stringify({
        reachability: { passed: true, unreachableStates: [], unreachableTransitions: [], notes: 'AI 复核通过' },
        deadlock: { passed: true, deadlockStates: [], notes: 'AI 复核通过' },
        liveness: { passed: true, violations: [], notes: '所有路径可到达终态' },
        consistency: { passed: true, violations: [], notes: '不变量在所有路径成立' },
      });
      const adapter = new MockAIAdapter(aiResponse);
      const report = await reason(model, adapter);

      // 代码预判：审批流所有状态可达、无死锁
      expect(report.reachability.passed).toBe(true);
      expect(report.reachability.unreachableStates).toEqual([]);
      expect(report.deadlock.passed).toBe(true);
      expect(report.deadlock.deadlockStates).toEqual([]);
      // AI 判断活性一致性通过
      expect(report.liveness.passed).toBe(true);
      expect(report.consistency.passed).toBe(true);
      expect(report.passed).toBe(true);
    });

    test('检测不可达状态', async () => {
      // 构造一个有不可达状态的协议：S4 无入边
      const model = parseProtocolContent(`---
name: 测试
version: 1.0.0
purpose: 测试不可达
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
| S2 | 中间 | normal |
| S3 | 终态 | terminal |
| S4 | 孤立 | normal |

# 转移规则

| ID | 名称 | from | to | action |
|---|---|---|---|---|
| T1 | 前进 | S1 | S2 | go |
| T2 | 完成 | S2 | S3 | finish |
`);
      const aiResponse = JSON.stringify({
        reachability: { passed: false, unreachableStates: ['S4'], notes: 'AI 确认 S4 不可达' },
        deadlock: { passed: true, deadlockStates: [], notes: 'S4 不可达不算死锁' },
        liveness: { passed: true, violations: [], notes: '' },
        consistency: { passed: true, violations: [], notes: '' },
      });
      const adapter = new MockAIAdapter(aiResponse);
      const report = await reason(model, adapter);

      expect(report.reachability.passed).toBe(false);
      expect(report.reachability.unreachableStates).toContain('S4');
    });

    test('检测死锁状态（非终态无出边）', async () => {
      const model = parseProtocolContent(`---
name: 测试
version: 1.0.0
purpose: 测试死锁
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
| S2 | 死锁 | normal |
| S3 | 终态 | terminal |

# 转移规则

| ID | 名称 | from | to | action |
|---|---|---|---|---|
| T1 | 进入死锁 | S1 | S2 | go |
`);
      const aiResponse = JSON.stringify({
        reachability: { passed: true, unreachableStates: [], notes: '' },
        deadlock: { passed: false, deadlockStates: ['S2'], notes: 'S2 无出边且非终态' },
        liveness: { passed: false, violations: ['S2 无法到达终态'], notes: '' },
        consistency: { passed: true, violations: [], notes: '' },
      });
      const adapter = new MockAIAdapter(aiResponse);
      const report = await reason(model, adapter);

      expect(report.deadlock.passed).toBe(false);
      expect(report.deadlock.deadlockStates).toContain('S2');
      expect(report.liveness.passed).toBe(false);
      expect(report.passed).toBe(false);
    });
  });

  describe('AI 推演', () => {
    test('强活性模式下含循环的协议活性违反 → 报告未通过（代码确定性判定）', async () => {
      // approval-flow 含 S1↔S2 循环（T1 提交 / T5 超时退回），强活性下存在永不到达终态的路径
      const model = parseProtocolContent(readFixture('approval-flow.md'));
      const aiResponse = JSON.stringify({
        reachability: { passed: true, unreachableStates: [], notes: '' },
        deadlock: { passed: true, deadlockStates: [], notes: '' },
        liveness: { passed: false, violations: [], notes: 'AI 复核' },
        consistency: { passed: true, violations: [], notes: '' },
      });
      const adapter = new MockAIAdapter(aiResponse);
      const report = await reason(model, adapter, { liveness: 'strong' });

      expect(report.liveness.passed).toBe(false);
      expect(report.liveness.violations.length).toBeGreaterThan(0);
      expect(report.liveness.mode).toBe('strong');
      expect(report.passed).toBe(false);
    });

    test('AI 调用失败时：报告未通过，但活性以代码判定为准不受 AI 失败影响', async () => {
      const model = parseProtocolContent(readFixture('approval-flow.md'));
      const adapter = new MockAIAdapter('', false);
      const report = await reason(model, adapter);

      expect(report.passed).toBe(false); // 一致性因 AI 失败而未通过
      expect(report.liveness.passed).toBe(true); // 弱活性由代码判定，不受 AI 失败影响
      expect(report.liveness.mode).toBe('weak');
      expect(report.consistency.passed).toBe(false);
    });

    test('AI 输出无法解析时返回未通过报告', async () => {
      const model = parseProtocolContent(readFixture('approval-flow.md'));
      const adapter = new MockAIAdapter('这不是 JSON');
      const report = await reason(model, adapter);

      expect(report.passed).toBe(false);
    });
  });

  describe('退化模式推演', () => {
    test('退化协议直接交 AI 推演', async () => {
      const model = parseProtocolContent(readFixture('degraded-protocol.md'));
      expect(model.derivable.degraded).toBe(true);

      const aiResponse = JSON.stringify({
        reachability: { passed: true, unreachableStates: [], notes: '形式化规格语义判断' },
        deadlock: { passed: true, deadlockStates: [], notes: '' },
        liveness: { passed: true, violations: [], notes: '' },
        consistency: { passed: true, violations: [], notes: 'Inv 在所有状态成立' },
      });
      const adapter = new MockAIAdapter(aiResponse);
      const report = await reason(model, adapter);

      expect(report.passed).toBe(true);
    });
  });
});
