/**
 * W1-b 关系断言段解析测试（07-execution-T3 TC1）
 *
 * 机械判据（TC1 验收）：
 * ① 三种断言（depends_on / sequence / shares_invariant）各至少一条正向用例：
 *    解析为 RelationAssertion[] 逐字段一致（含 assert 标记）；
 * ② 反向：excludes 及任意未知 kind → ParseError（硬错误，逐种类断言）；
 * ③ 老模型零回归：无断言段 model.md → relationAssertions 为空/undefined，
 *    且既有全部 parser 测试零改动全绿（本 suite 断言 + 全量基线兜底）；
 * ④ 段存在但无 YAML 块 → ParseError（决策8 语义B 复用）；
 * ⑤ npx tsc --noEmit 0 errors（全量基线）。
 */

import { parseProtocolContent, ParseError } from '../../src/parser/index.js';
import type { RelationAssertion } from '../../src/model/types.js';

/** 最小协议骨架（关系断言段前置条件：角色/状态/转移合法） */
function baseModel(assertionsYaml: string): string {
  return `---
name: 断言测试协议
version: 1.0.0
purpose: W1-b 断言段解析测试
roles:
  - id: system
    name: 系统
    roleType: consensus
---

# 状态空间

| ID | 名称 | 类型 | 描述 | 角色 |
|---|---|---|---|---|
| S1 | 态一 | initial | 初始态 | system |
| S2 | 态二 | normal | 中间态 | system |
| S3 | 态三 | terminal | 终态 | system |

# 转移规则

| ID | 名称 | from | to | action | trigger | guard | effects | triggerType | actionType | affectsDimensions |
|---|---|---|---|---|---|---|---|---|---|---|
| T1 | 转移一 | S1 | S2 | act_one | system | | | system | state_transition | |
| T2 | 转移二 | S2 | S3 | act_two | system | | | system | state_transition | |

# 不变量

| ID | 名称 | 表达式 | 作用状态 | 声明方 | 不变量类别 | 描述 |
|---|---|---|---|---|---|---|
| INV1 | 不变量一 | x = 1 | S1, S2 | system | intra_protocol | 测试不变量 |

# 关系断言

\`\`\`yaml
${assertionsYaml}
\`\`\`
`;
}

describe('TC1 W1-b 关系断言段解析（parser）', () => {
  describe('① 正向：三种断言逐字段解析一致（含 assert 标记）', () => {
    const model = parseProtocolContent(
      baseModel(`- id: A1
  kind: depends_on
  a: T2
  b: T1
  note: T1 是 T2 的前置
- id: A2
  kind: sequence
  a: T1
  b: T2
- id: A3
  kind: shares_invariant
  a: S1
  b: S2
`),
      'assertions-ok.md'
    );

    test('relationAssertions 解析为 3 条', () => {
      expect(model.relationAssertions).toHaveLength(3);
    });

    test('depends_on：id/kind/a/b/note 逐字段一致 + assert: true', () => {
      const a1 = model.relationAssertions!.find((r) => r.id === 'A1')!;
      expect(a1.kind).toBe('depends_on');
      expect(a1.a).toBe('T2');
      expect(a1.b).toBe('T1');
      expect(a1.note).toBe('T1 是 T2 的前置');
      expect(a1.assert).toBe(true);
    });

    test('sequence：a/b 为转移 ID', () => {
      const a2 = model.relationAssertions!.find((r) => r.id === 'A2')!;
      expect(a2.kind).toBe('sequence');
      expect(a2.a).toBe('T1');
      expect(a2.b).toBe('T2');
      expect(a2.assert).toBe(true);
    });

    test('shares_invariant：a/b 为状态 ID；note 缺省不设置', () => {
      const a3 = model.relationAssertions!.find((r) => r.id === 'A3')!;
      expect(a3.kind).toBe('shares_invariant');
      expect(a3.a).toBe('S1');
      expect(a3.b).toBe('S2');
      expect(a3.note).toBeUndefined();
      expect(a3.assert).toBe(true);
    });
  });

  describe('② 反向：不在映射表的种类 → ParseError 硬错误', () => {
    test('excludes 被拒绝解析（R1-1 裁出，NR1-2 无映射硬错误）', () => {
      expect(() =>
        parseProtocolContent(baseModel(`- id: A9
  kind: excludes
  a: T1
  b: T2
`), 'assertions-excludes.md')
      ).toThrow(ParseError);
    });

    test('任意未知 kind（如 mutual_exclusion）→ ParseError', () => {
      expect(() =>
        parseProtocolContent(baseModel(`- id: A9
  kind: mutual_exclusion
  a: T1
  b: T2
`), 'assertions-unknown.md')
      ).toThrow(ParseError);
    });

    test('未知 kind 错误信息含映射表提示（不静默）', () => {
      let caught: unknown;
      try {
        parseProtocolContent(baseModel(`- id: A9
  kind: excludes
  a: T1
  b: T2
`), 'assertions-msg.md');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ParseError);
      const msg = (caught as Error).message;
      expect(msg).toContain('excludes');
      expect(msg).toContain('depends_on');
      expect(msg).toContain('无映射');
    });
  });

  describe('③ 老模型零回归：无断言段 → relationAssertions 为空', () => {
    const content = `---
name: 无断言协议
version: 1.0.0
purpose: 老模型零回归
roles:
  - id: system
    name: 系统
    roleType: consensus
---

# 状态空间

| ID | 名称 | 类型 | 描述 | 角色 |
|---|---|---|---|---|
| S1 | 态一 | initial | 初始态 | system |
| S2 | 态二 | terminal | 终态 | system |

# 转移规则

| ID | 名称 | from | to | action | trigger | guard | effects | triggerType | actionType | affectsDimensions |
|---|---|---|---|---|---|---|---|---|---|---|
| T1 | 转移一 | S1 | S2 | act_one | system | | | system | state_transition | |
`;

    test('无断言段 → relationAssertions 为 undefined（老模型零回归）', () => {
      const model = parseProtocolContent(content, 'no-assertions.md');
      expect(model.relationAssertions).toBeUndefined();
    });
  });

  describe('④ 段存在但无 YAML 块 → ParseError（决策8 语义B 复用）', () => {
    test('关系断言标题下无 YAML 代码块 → ParseError', () => {
      const content = `---
name: 断言缺失协议
version: 1.0.0
purpose: 段存在但内容缺失
roles:
  - id: system
    name: 系统
    roleType: consensus
---

# 状态空间

| ID | 名称 | 类型 | 描述 | 角色 |
|---|---|---|---|---|
| S1 | 态一 | initial | 初始态 | system |
| S2 | 态二 | terminal | 终态 | system |

# 转移规则

| ID | 名称 | from | to | action | trigger | guard | effects | triggerType | actionType | affectsDimensions |
|---|---|---|---|---|---|---|---|---|---|---|
| T1 | 转移一 | S1 | S2 | act_one | system | | | system | state_transition | |

# 关系断言

这里没有 YAML 代码块
`;
      expect(() => parseProtocolContent(content, 'assertions-missing.md')).toThrow(ParseError);
    });

    test('YAML 非数组（单对象）→ ParseError', () => {
      expect(() =>
        parseProtocolContent(baseModel(`id: A1
kind: sequence
a: T1
b: T2
`), 'assertions-not-array.md')
      ).toThrow(ParseError);
    });

    test('必填字段缺失（kind 缺失）→ ParseError', () => {
      expect(() =>
        parseProtocolContent(baseModel(`- id: A1
  a: T1
  b: T2
`), 'assertions-missing-kind.md')
      ).toThrow(ParseError);
    });
  });
});
