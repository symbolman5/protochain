/**
 * W1-b 关系断言 checker 规则模块测试（07-execution-T3 TC2）
 *
 * 机械判据（TC2 验收，01 §3 W1-b 回归保护条款）：
 * ① 正向：断言与投影一致（fixture 含全部三种断言）→ check 通过、零新增 issue；
 * ② 反向（硬失败）：depends_on 声明的转移对在拓扑中无衔接 → 硬错误；
 *    sequence 同构反向；shares_invariant 声明两状态无共同覆盖不变量 → 硬错误；
 * ③ 引用不存在转移/状态 ID → 硬错误；
 * ④ 零回归：无断言 model.md → 规则模块零输出（既有 checker 测试全绿）；
 * ⑤ tsc 0 errors + 新增 suite 全过。
 */

import { parseProtocolContent } from '../../src/parser/index.js';
import { checkCompleteness } from '../../src/checker/index.js';
import type { CheckIssue } from '../../src/model/types.js';

/** 最小协议模型（可配置状态/转移/不变量/断言） */
function buildModel(opts: {
  states: string;
  transitions: string;
  invariants?: string;
  assertions?: string;
}): ReturnType<typeof parseProtocolContent> {
  const invariants = opts.invariants ?? '';
  const assertions = opts.assertions ?? '';
  // 无断言时完全省略"关系断言"段（扩展段机制：段不存在=合法；段存在但无 YAML=ParseError）
  const assertionsSection =
    assertions.length > 0 ? `# 关系断言

\`\`\`yaml
${assertions}
\`\`\`
` : '';
  return parseProtocolContent(`---
name: 断言校验协议
version: 1.0.0
purpose: TC2 checker 断言规则测试
roles:
  - id: system
    name: 系统
    roleType: consensus
---

# 状态空间

${opts.states}

# 转移规则

${opts.transitions}

# 不变量

${invariants || '# 不变量\n\n（无）'}

${assertionsSection}`, 'tc2-model.md');
}

/** 断言相关 error issue（按 elementPath 过滤） */
function assertionErrors(report: ReturnType<typeof checkCompleteness>): CheckIssue[] {
  return report.mechanical.referenceIssues.filter(
    (i) => i.severity === 'error' && i.elementPath === 'derivable.relationAssertions'
  );
}

const STATES = `| ID | 名称 | 类型 | 描述 | 角色 |
|---|---|---|---|---|
| S1 | 态一 | initial | 初始态 | system |
| S2 | 态二 | normal | 中间态 | system |
| S3 | 态三 | terminal | 终态 | system |`;

const TRANSITIONS_LINKED = `| ID | 名称 | from | to | action | trigger | guard | effects | triggerType | actionType | affectsDimensions |
|---|---|---|---|---|---|---|---|---|---|---|---|
| T1 | 转移一 | S1 | S2 | act_one | system | | | system | state_transition | |
| T2 | 转移二 | S2 | S3 | act_two | system | | | system | state_transition | |`;

const TRANSITIONS_UNLINKED = `| ID | 名称 | from | to | action | trigger | guard | effects | triggerType | actionType | affectsDimensions |
|---|---|---|---|---|---|---|---|---|---|---|---|
| T1 | 转移一 | S1 | S2 | act_one | system | | | system | state_transition | |
| T2 | 转移二 | S3 | S4 | act_two | system | | | system | state_transition | |`;

describe('TC2 W1-b checker 关系断言规则模块', () => {
  describe('① 正向：断言与投影一致 → check 通过、零新增 issue', () => {
    const model = buildModel({
      states: STATES,
      transitions: TRANSITIONS_LINKED,
      invariants: `| ID | 名称 | 表达式 | 作用状态 | 声明方 | 不变量类别 | 描述 |
|---|---|---|---|---|---|---|
| INV1 | 不变量一 | x = 1 | S1, S2 | system | intra_protocol | 覆盖 S1/S2 |`,
      assertions: `- id: A1
  kind: depends_on
  a: T2
  b: T1
- id: A2
  kind: sequence
  a: T1
  b: T2
- id: A3
  kind: shares_invariant
  a: S1
  b: S2
`,
    });

    test('机械层通过、零新增 error（三种断言全过）', () => {
      const report = checkCompleteness(model);
      expect(report.mechanical.passed).toBe(true);
      expect(assertionErrors(report)).toHaveLength(0);
    });

    test('depends_on T2 T1 命中投影 sequence(fromId=T1, toId=T2)（T1.to=S2 ∈ T2.from）', () => {
      const report = checkCompleteness(model);
      expect(assertionErrors(report).some((i) => i.message.includes('A1'))).toBe(false);
    });

    test('shares_invariant S1 S2 命中 INV1 覆盖集合 ⊇ {S1,S2}', () => {
      const report = checkCompleteness(model);
      expect(assertionErrors(report).some((i) => i.message.includes('A3'))).toBe(false);
    });
  });

  describe('② 反向（硬失败）：断言与投影不一致 → error（非 warning）', () => {
    test('depends_on 转移对无拓扑衔接（T1.to=S2 ∉ T2.from=[S3]）→ 硬错误', () => {
      const model = buildModel({
        states: STATES + `\n| S4 | 态四 | terminal | 终态 | system |`,
        transitions: TRANSITIONS_UNLINKED,
        invariants: `| ID | 名称 | 表达式 | 作用状态 | 声明方 | 不变量类别 | 描述 |
|---|---|---|---|---|---|---|
| INV1 | 不变量一 | x = 1 | S1, S2 | system | intra_protocol | 覆盖 S1/S2 |`,
        assertions: `- id: A1
  kind: depends_on
  a: T2
  b: T1
`,
      });
      const report = checkCompleteness(model);
      expect(report.mechanical.passed).toBe(false);
      const errs = assertionErrors(report);
      expect(errs.length).toBe(1);
      expect(errs[0].severity).toBe('error');
      expect(errs[0].message).toContain('A1');
      expect(errs[0].message).toContain('sequence(fromId=T1, toId=T2)');
    });

    test('sequence 反向（sequence T2 T1 但投影仅 T1 前置 T2）→ 硬错误', () => {
      const model = buildModel({
        states: STATES,
        transitions: TRANSITIONS_LINKED,
        invariants: `| ID | 名称 | 表达式 | 作用状态 | 声明方 | 不变量类别 | 描述 |
|---|---|---|---|---|---|---|
| INV1 | 不变量一 | x = 1 | S1, S2 | system | intra_protocol | 覆盖 S1/S2 |`,
        assertions: `- id: A2
  kind: sequence
  a: T2
  b: T1
`,
      });
      const report = checkCompleteness(model);
      expect(report.mechanical.passed).toBe(false);
      const errs = assertionErrors(report);
      expect(errs.length).toBe(1);
      expect(errs[0].message).toContain('sequence(fromId=T2, toId=T1)');
    });

    test('shares_invariant 两状态无共同覆盖不变量（S3 ∉ INV1 作用域）→ 硬错误', () => {
      const model = buildModel({
        states: STATES,
        transitions: TRANSITIONS_LINKED,
        invariants: `| ID | 名称 | 表达式 | 作用状态 | 声明方 | 不变量类别 | 描述 |
|---|---|---|---|---|---|---|
| INV1 | 不变量一 | x = 1 | S1, S2 | system | intra_protocol | 覆盖 S1/S2 |`,
        assertions: `- id: A3
  kind: shares_invariant
  a: S1
  b: S3
`,
      });
      const report = checkCompleteness(model);
      expect(report.mechanical.passed).toBe(false);
      const errs = assertionErrors(report);
      expect(errs.length).toBe(1);
      expect(errs[0].message).toContain('A3');
      expect(errs[0].message).toContain('S1');
      expect(errs[0].message).toContain('S3');
    });

    test('共享不变量作用域为空（全局）也满足 ⊇ {a,b}（正向补充：全局不变量覆盖全部状态）', () => {
      const model = buildModel({
        states: STATES,
        transitions: TRANSITIONS_LINKED,
        invariants: `| ID | 名称 | 表达式 | 作用状态 | 声明方 | 不变量类别 | 描述 |
|---|---|---|---|---|---|---|
| INV1 | 不变量一 | x = 1 | | system | intra_protocol | 全局不变量 |`,
        assertions: `- id: A3
  kind: shares_invariant
  a: S1
  b: S3
`,
      });
      const report = checkCompleteness(model);
      expect(assertionErrors(report)).toHaveLength(0);
    });
  });

  describe('③ 引用不存在 ID → 硬错误（引用闭合）', () => {
    test('sequence 引用不存在的转移 T9 → 硬错误', () => {
      const model = buildModel({
        states: STATES,
        transitions: TRANSITIONS_LINKED,
        assertions: `- id: A9
  kind: sequence
  a: T9
  b: T1
`,
      });
      const report = checkCompleteness(model);
      expect(report.mechanical.passed).toBe(false);
      const errs = assertionErrors(report);
      expect(errs.length).toBe(1);
      expect(errs[0].message).toContain('T9');
      expect(errs[0].message).toContain('不存在');
    });

    test('shares_invariant 引用不存在的状态 S9 → 硬错误', () => {
      const model = buildModel({
        states: STATES,
        transitions: TRANSITIONS_LINKED,
        invariants: `| ID | 名称 | 表达式 | 作用状态 | 声明方 | 不变量类别 | 描述 |
|---|---|---|---|---|---|---|
| INV1 | 不变量一 | x = 1 | S1, S2 | system | intra_protocol | 覆盖 S1/S2 |`,
        assertions: `- id: A9
  kind: shares_invariant
  a: S9
  b: S1
`,
      });
      const report = checkCompleteness(model);
      expect(report.mechanical.passed).toBe(false);
      const errs = assertionErrors(report);
      expect(errs.length).toBe(1);
      expect(errs[0].message).toContain('S9');
    });
  });

  describe('④ 零回归：无断言段 → 规则模块零输出', () => {
    test('无断言段 model.md → 无 relationAssertions、规则零输出、check 通过', () => {
      const model = buildModel({
        states: STATES,
        transitions: TRANSITIONS_LINKED,
        invariants: `| ID | 名称 | 表达式 | 作用状态 | 声明方 | 不变量类别 | 描述 |
|---|---|---|---|---|---|---|
| INV1 | 不变量一 | x = 1 | S1, S2 | system | intra_protocol | 覆盖 S1/S2 |`,
      });
      expect(model.relationAssertions).toBeUndefined();
      const report = checkCompleteness(model);
      expect(report.mechanical.passed).toBe(true);
      expect(assertionErrors(report)).toHaveLength(0);
    });
  });
});
