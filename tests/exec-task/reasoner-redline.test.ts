/**
 * exec-task 层 reasoner 红线测试（§7.3）：
 *
 * - 代码 BFS/SCC 预判结论不可被 AI 推翻：AI 谎称全部通过时，
 *   不可达状态 / 死锁 / 强活性循环仍必须让 reason 失败并传导到任务失败；
 * - reason 不得走"生成 -> 修正"loop：即使代码预判失败，AI 也只调用一次
 *   （不重试、不伪造通过），成本账本 modelCalls=1。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTask, type ExecTaskInput } from '../../src/exec-task/index.js';
import type { AIRole } from '../../src/ai/router.js';
import type { AIAdapter, AIPrompt, AIResponse } from '../../src/model/types.js';

const CONFIG_AI = `name: 红线测试项目
ai:
  provider: local
  useForGeneration: true
  loop:
    maxIterations: 3
    maxTokens: 20000
    maxToolCalls: 10
`;

/** AI 谎称一切通过：用于验证代码预判主导（不可被 AI 推翻） */
class DisagreeingAdapter implements AIAdapter {
  name = 'mock-disagree';
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

function createProject(model: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'protochain-reason-redline-'));
  mkdirSync(join(dir, 'protocol'), { recursive: true });
  writeFileSync(join(dir, 'protocol', 'model.md'), model, 'utf-8');
  writeFileSync(join(dir, 'protochain.config.yaml'), CONFIG_AI, 'utf-8');
  return dir;
}

/** 含不可达+死锁状态（S3 孤儿）的模型：代码 BFS 预判必须失败 */
const MODEL_UNREACHABLE_DEADLOCK = `---
name: 红线-不可达死锁
version: 1.0.0
purpose: 验证代码 BFS 预判不可被 AI 推翻
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

/** 强活性 + 非终态循环（S0↔S1）的模型：代码 SCC 预判必须失败 */
const MODEL_STRONG_LIVENESS_CYCLE = `---
name: 红线-强活性循环
version: 1.0.0
purpose: 验证强活性 SCC 代码判定不可被 AI 推翻
liveness: strong
roles:
  - id: r1
    name: 角色1
---

# 背景

测试

# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S0 | 初始 | initial |
| S1 | 运行中 | normal |
| S2 | 终态 | terminal |

# 转移规则

| ID | 名称 | from | to | action |
|---|---|---|---|---|
| T1 | 前进 | S0 | S1 | go |
| T2 | 回环 | S1 | S0 | back |
| T3 | 完成 | S1 | S2 | finish |
`;

async function runReasonRedline(model: string, taskId: string): Promise<{ result: Awaited<ReturnType<typeof executeTask>>; adapter: DisagreeingAdapter; dir: string }> {
  const dir = createProject(model);
  const adapter = new DisagreeingAdapter();
  const input: ExecTaskInput = {
    taskId,
    steps: ['reason'],
    useAI: true,
    goal: '验证 reason 步骤的代码预判红线',
  };
  const result = await executeTask(input, {
    projectDir: dir,
    adapterFor: (_role: AIRole) => adapter,
  });
  return { result, adapter, dir };
}

describe('exec-task reasoner 红线', () => {
  test('代码 BFS 预判失败不可被 AI 推翻：reason 失败传导为任务失败，且不重试', async () => {
    const { result, adapter, dir } = await runReasonRedline(MODEL_UNREACHABLE_DEADLOCK, 'redline-bfs');

    expect(result.status).toBe('failed');
    expect(result.reason).toContain('AI 推演未通过');
    // reason 单次调用：代码预判失败不触发生成/修正 loop（失败步的修正计数=本次尝试）
    expect(adapter.calls).toBe(1);
    expect(result.cost.modelCalls).toBe(1);
    expect(result.cost.loop?.iterations).toBe(1);
    expect(result.cost.loop?.corrections).toBe(1);
    // 失败即终止，不继续后续步骤
    expect(result.facts.some((f) => f.subject === 'derive-specs')).toBe(false);
    // AI 说"全部通过"无效：reasoning-report 仍记录代码判定失败
    const report = JSON.parse(readFileSync(join(dir, 'derived', 'reasoning-report.json'), 'utf8'));
    expect(report.passed).toBe(false);
    expect(report.reachability.passed).toBe(false);
    expect(report.reachability.unreachableStates).toContain('S3');
    expect(report.deadlock.passed).toBe(false);
    expect(report.deadlock.deadlockStates).toContain('S3');
    // 确定性 BFS 结论原样保留（未被 AI 清空）
    expect(report.rawOutput).toContain('AI：全部可达');
  });

  test('强活性 SCC 循环由代码判定主导：AI 谎称活性满足也无效', async () => {
    const { result, adapter, dir } = await runReasonRedline(MODEL_STRONG_LIVENESS_CYCLE, 'redline-scc');

    expect(result.status).toBe('failed');
    expect(result.reason).toContain('AI 推演未通过');
    expect(adapter.calls).toBe(1);
    expect(result.cost.modelCalls).toBe(1);
    const report = JSON.parse(readFileSync(join(dir, 'derived', 'reasoning-report.json'), 'utf8'));
    expect(report.liveness.passed).toBe(false);
    expect(report.liveness.mode).toBe('strong');
    expect(report.liveness.violations.length).toBeGreaterThan(0);
    // 代码判定主导：AI 的 passed=true 未进入最终活性结论
    expect(JSON.parse(report.rawOutput).liveness.passed).toBe(true);
    expect(report.passed).toBe(false);
  });

  test('AI-only 步骤在适配器不可用时仍显式跳过（不伪造通过）', async () => {
    const dir = createProject(MODEL_UNREACHABLE_DEADLOCK);
    const result = await executeTask(
      { taskId: 'redline-no-adapter', steps: ['reason'], useAI: true, goal: '验证无适配器跳过' },
      { projectDir: dir, adapterFor: () => undefined },
    );
    expect(result.status).toBe('completed');
    const reasonFact = result.facts.find((f) => f.subject === 'reason');
    expect(reasonFact?.kind).toBe('assumption');
    expect(reasonFact?.detail).toContain('适配器不可用');
    expect(result.cost.modelCalls).toBe(0);
    expect(existsSync(join(dir, 'derived', 'reasoning-report.json'))).toBe(false);
  });
});
