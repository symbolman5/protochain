import { parseProtocolContent } from '../../src/parser/index.js';
import { reason } from '../../src/reasoner/index.js';
import { decomposeStateMachines } from '../../src/model/state-machines.js';
import { checkCompleteness } from '../../src/checker/index.js';
import type { AIAdapter, AIPrompt, AIResponse } from '../../src/model/types.js';

/**
 * 附属实体（SE）状态机隔离回归测试——工具链修改单 001。
 *
 * 复现结构：主状态机（Mapping S1-S4）+ 附属实体子状态机（TempMapping S5-S6，
 * 仅由创建转移 T7（from='-'）进入，与主初始态 S1 不连通）。等价于 P1 model.md
 * 的 SE1 TempMapping 结构与 P7 的 PS/PI 子状态机结构。
 *
 * 回归点：
 * 1. reason.passed=true：子状态机不参与主状态机可达性判定（旧实现把 S5/S6 判为不可达）；
 * 2. AI 若仍报告子状态机状态不可达（旧 AI 复核"确认代码预判"），结果被防御性过滤，
 *    不把主状态机判失败；
 * 3. 子状态机问题记入 notes（advisory），不阻断主结论；
 * 4. 主状态机内真实不可达状态（孤儿）仍判失败（保持既有语义）；
 * 5. checker 支持多状态机各自独立 initial（不再要求全局唯一）。
 */

// 等价于 P1 SE1 TempMapping 结构：主 Mapping S1-S4 + 附属 TempMapping S5-S6
const SE_MODEL = `---
name: 测试协议（含附属实体）
version: 1.0.0
purpose: 主实体 + 附属实体 TempMapping，验证 SE 状态机隔离
roles:
  - id: r1
    name: 角色1
liveness: weak
---

# 背景

主实体生命周期 + 附属实体（临时映射，Redis 态，独立生命周期）。

# 状态空间

| ID | 名称 | 类型 | 描述 |
|---|---|---|---|
| S1 | active | initial | 主实体活跃 |
| S2 | paused | normal | 主实体暂停 |
| S3 | expired | terminal | 主实体过期 |
| S4 | deleted | terminal | 主实体删除 |
| S5 | temp_created | normal | 临时映射已创建（附属实体 TempMapping 生命周期态：非主状态） |
| S6 | temp_expired | terminal | 临时映射已到期（附属实体 TempMapping 终态：非主状态） |

# 转移规则

| ID | 名称 | from | to | action | trigger | guard | effects | triggerType | actionType | affectsDimensions |
|---|---|---|---|---|---|---|---|---|---|---|
| T1 | 创建主实体 | - | S1 | create | r1 | - | 落库 | role | state_transition | |
| T2 | 暂停 | S1 | S2 | pause | r1 | - | - | role | state_transition | |
| T3 | 恢复 | S2 | S1 | resume | r1 | - | - | role | state_transition | |
| T4 | 过期 | S1 | S3 | expire |  | - | - | system | state_transition | |
| T5 | 删除 | S1 | S4 | delete | r1 | - | - | role | state_transition | |
| T7 | 创建临时映射 | - | S5 | tempCreate | r1 | - | 写 Redis | role | state_transition | |
| T8 | 续期临时映射 | S5 | S5 | tempRenew | r1 | - | - | role | state_transition | |
| T10 | 临时映射到期 | S5 | S6 | tempExpire |  | - | - | system | state_transition | |
`;

/** 模拟旧行为 AI：把代码预判（含对子状态机的误判）原样回显，甚至断言 passed=false */
class EchoUnreachableAdapter implements AIAdapter {
  name = 'echo';
  constructor(private echoCodePrecheck: boolean) {}
  async complete(prompt: AIPrompt): Promise<AIResponse> {
    const ctx = JSON.parse(prompt.context);
    const pre = ctx.codePrecheck;
    return {
      content: JSON.stringify({
        reachability: {
          passed: false,
          unreachableStates: this.echoCodePrecheck ? pre.reachability.unreachableStates : ['S5', 'S6'],
          unreachableTransitions: this.echoCodePrecheck
            ? pre.reachability.unreachableTransitions
            : ['T7', 'T8', 'T10'],
          notes: '复核确认代码预判',
        },
        deadlock: { passed: true, deadlockStates: [], notes: '' },
        liveness: { passed: true, violations: [], notes: '' },
        consistency: { passed: true, violations: [], notes: '' },
      }),
      success: true,
      attempts: 1,
    };
  }
}

class PassAllAdapter implements AIAdapter {
  name = 'pass';
  async complete(_prompt: AIPrompt): Promise<AIResponse> {
    return {
      content: JSON.stringify({
        reachability: { passed: true, unreachableStates: [], unreachableTransitions: [], notes: '' },
        deadlock: { passed: true, deadlockStates: [], notes: '' },
        liveness: { passed: true, violations: [], notes: '' },
        consistency: { passed: true, violations: [], notes: '' },
      }),
      success: true,
      attempts: 1,
    };
  }
}

describe('SE 附属实体状态机隔离（修改单 001）', () => {
  test('reason.passed=true：子状态机 S5/S6 不参与主可达性判定（advisory）', async () => {
    const model = parseProtocolContent(SE_MODEL);
    const report = await reason(model, new EchoUnreachableAdapter(true));

    // 核心验收：整体通过，且不可达清单不含子状态机状态
    expect(report.passed).toBe(true);
    expect(report.reachability.unreachableStates).toEqual([]);
    expect(report.reachability.unreachableTransitions).toEqual([]);
    // advisory：子状态机独立分析结果记入 notes
    expect(report.reachability.notes).toContain('附属实体子状态机独立判定');
  });

  test('AI 仍误报子状态机不可达（passed=false + S5/S6）时被防御性过滤，主状态机不判失败', async () => {
    const model = parseProtocolContent(SE_MODEL);
    // AI 明确返回 passed=false 且 unreachableStates=['S5','S6']——旧行为复现
    const report = await reason(model, new EchoUnreachableAdapter(false));

    expect(report.passed).toBe(true);
    expect(report.reachability.unreachableStates).toEqual([]);
  });

  test('主状态机内真实不可达状态（孤儿）仍判失败（保持既有语义）', async () => {
    const model = parseProtocolContent(`---
name: 测试
version: 1.0.0
purpose: 测试孤儿状态仍失败
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
    const report = await reason(model, new PassAllAdapter());
    expect(report.passed).toBe(false);
    expect(report.reachability.unreachableStates).toContain('S4');
  });

  test('checker：多状态机各自独立 initial 合法（不再要求全局唯一）', () => {
    const model = parseProtocolContent(SE_MODEL);
    const check = checkCompleteness(model);
    expect(check.mechanical.passed).toBe(true);
  });

  test('状态机分解：main + subMachines 划分正确', () => {
    const model = parseProtocolContent(SE_MODEL);
    const { main, subMachines, orphanComponents } = decomposeStateMachines(
      model.derivable.states,
      model.derivable.transitions,
      model.derivable.initialStateId
    );
    expect(main?.states.map((s) => s.id).sort()).toEqual(['S1', 'S2', 'S3', 'S4']);
    expect(subMachines.length).toBe(1);
    expect(subMachines[0].states.map((s) => s.id).sort()).toEqual(['S5', 'S6']);
    expect(orphanComponents).toEqual([]);
  });
});
