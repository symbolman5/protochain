/**
 * 修改单 002 回归测试：formalize 适配器 ID 转义 + 多源 fromConditions 拼接加括号
 *
 * 背景（修改单 002）：
 * - protochain formalize 适配器 line 425 之前直接把 inv.id 拼到 TLA+ 表达式里
 *   （如 `INV-PS1 == TRUE`），TLC 把 `-` 当二元减号 → Unknown operator 解析失败。
 * - 同一文件 line 396 多源 fromConditions 拼接缺括号，触发 `\lor` 与 `\land` 优先级冲突。
 *
 * 验证：
 * 1. inv.id 含 `-` 时，TLA+ 表达式位置用 ASCII-safe id（`INV_PS1`），注释保留原 ID。
 * 2. 多源 from（PS2/PS3/PS4 → PS5）拼接后有括号 `(state = "PS2" \/ state = "PS3" \/ state = "PS4")`。
 * 3. 聚合不变量 AllInvariants 引用的也是 ASCII-safe id。
 */

import { parseProtocolContent } from '../../src/parser/index.js';
import { TLAAdapter, asciiSafeId } from '../../src/formalizer/adapters.js';

/** 模拟 P7 PS/PI 维度的不变量 ID 命名风格（连字符） */
const P7_INVARIANT_FIXTURE = `---
name: P7 含连字符 ID 测试
version: 1.0.0
purpose: 修改单 002 回归——验证 inv.id 含连字符时 formalize 不再生成解析失败的 TLA+
roles:
  - id: r1
    name: 测试角色
---

# 背景

测试协议（含连字符不变量 ID 与多源 from 转移）

# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S1 | 初始 | initial |
| S2 | 中间 | normal |
| S3 | 中间2 | normal |
| S4 | 中间3 | normal |
| S5 | 终态 | terminal |

# 转移规则

| ID | 名称 | from | to | action |
|---|---|---|---|---|
| T1 | 开始 | S1 | S2 | start |
| T9a | 多源 A | S2 | S5 | finishA |
| T9b | 多源 B | S3 | S5 | finishB |
| T9c | 多源 C | S4 | S5 | finishC |

# 不变量

| ID | 名称 | 表达式 |
|---|---|---|
| INV-PS1 | PS 不变量 1 | state = "S2" \/ state = "S5" |
| P5-LIC1 | 许可不变量 1 | state /= "S3" |
| INV.PS2 | 命名变体（点号） | state /= "S4" |
`;

describe('修改单 002：formalize 适配器 ID 转义 + 多源 fromConditions 加括号', () => {
  describe('asciiSafeId 助手', () => {
    test('连字符替换为下划线', () => {
      expect(asciiSafeId('INV-PS1')).toBe('INV_PS1');
      expect(asciiSafeId('P5-LIC1')).toBe('P5_LIC1');
    });
    test('点号替换为下划线', () => {
      expect(asciiSafeId('INV.PS2')).toBe('INV_PS2');
    });
    test('字母数字下划线保持不变', () => {
      expect(asciiSafeId('INV1')).toBe('INV1');
      expect(asciiSafeId('INV_PS1')).toBe('INV_PS1');
      expect(asciiSafeId('a_b_c')).toBe('a_b_c');
    });
    test('混合字符：连续非字母数字下划线合并为单个 _', () => {
      // 注：连续 `-` 会被替换为多个 `_`，再被规范化——这里只保证单字符替换
      expect(asciiSafeId('A-B-C')).toBe('A_B_C');
    });
    test('非 ASCII 字符同样替换为 _', () => {
      // 'INV-PS中文' 共 8 个字符（codepoint）：I,N,V,-,P,S,中,文
      // - 与 中 文 各替换为单个 _ → INV_PS__ (2 个尾部下划线)
      expect(asciiSafeId('INV-PS中文')).toBe('INV_PS__');
    });
  });

  describe('inv.id ASCII 转义（line 425 修复）', () => {
    test('TLA+ 表达式位置使用 ASCII-safe id，原 ID 保留在注释', () => {
      const model = parseProtocolContent(P7_INVARIANT_FIXTURE);
      const adapter = new TLAAdapter();
      const spec = adapter.generateSpec(model.derivable);

      // 表达式：`INV_PS1 == state = "S2" \/ state = "S5"`（\lor 已被 translateBooleanExpr 翻译）
      expect(spec).toContain('INV_PS1 ==');

      // 注释保留原 ID：`Invariant: PS 不变量 1 (id=INV-PS1)`
      expect(spec).toContain('(id=INV-PS1)');
      expect(spec).toContain('(id=P5-LIC1)');
      expect(spec).toContain('(id=INV.PS2)');

      // 表达式位置不能出现连字符原 ID（去注释行后再查）
      const lines = spec.split('\n').filter((l) => !l.trimStart().startsWith('(*'));
      const exprPart = lines.join('\n');
      expect(exprPart).not.toMatch(/\bINV-PS1\b/);
      expect(exprPart).not.toMatch(/\bP5-LIC1\b/);
    });

    test('聚合不变量 AllInvariants 引用 ASCII-safe id（不会引用原连字符 ID 引发 Unknown operator）', () => {
      const model = parseProtocolContent(P7_INVARIANT_FIXTURE);
      const adapter = new TLAAdapter();
      const spec = adapter.generateSpec(model.derivable);

      // AllInvariants 段应使用 ASCII-safe id：INV_PS1、P5_LIC1、INV_PS2
      expect(spec).toContain('AllInvariants == /\\ INV_PS1');
      expect(spec).toContain('/\\ P5_LIC1');
      expect(spec).toContain('/\\ INV_PS2');

      // 表达式位置不能出现连字符原 ID（注释中保留 `(id=INV-PS1)` 是允许的）
      // —— TLA+ 解析看的是 `INV-PS1 == ` 这种 token 序列，而注释里 `(id=INV-PS1)` 是注释上下文
      // 提取"表达式位置"行：去除注释行 (`(* ... *)`) 后再检查
      const lines = spec.split('\n').filter((l) => !l.trimStart().startsWith('(*'));
      const exprPart = lines.join('\n');
      expect(exprPart).not.toMatch(/\bINV-PS1\b/);
      expect(exprPart).not.toMatch(/\bP5-LIC1\b/);
      expect(exprPart).not.toMatch(/\bINV\.PS2\b/);
    });
  });

  describe('多源 fromConditions 加括号（line 396 修复）', () => {
    test('单源 from 无括号（语义清晰，无歧义）', () => {
      const model = parseProtocolContent(P7_INVARIANT_FIXTURE);
      const adapter = new TLAAdapter();
      const spec = adapter.generateSpec(model.derivable);

      // T1: from=S1 单源 → `/\\ state = "S1"` 无括号（原行为保留）
      // 用 includes 验证：spec 包含一行带 `/\\ state = "S1"` 的片段（无左右括号包住 from 部分）
      expect(spec).toContain('/\\ state = "S1"');
      // 但不能被多余的括号包住
      expect(spec).not.toContain('(state = "S1")');
    });

    test('转移 ID 本身（含字母数字下划线）保持不变', () => {
      const model = parseProtocolContent(P7_INVARIANT_FIXTURE);
      const adapter = new TLAAdapter();
      const spec = adapter.generateSpec(model.derivable);

      // T9a/T9b/T9c 转移 ID 不动（已是 ASCII-safe）
      expect(spec).toContain('S2');
      expect(spec).toContain('S3');
      expect(spec).toContain('S4');
      expect(spec).toContain('S5');
    });
  });

  describe('多源 from 拼接括号化（修复 Precedence conflict 根因）', () => {
    // 单独的 fixture：多源 from 转移
    const MULTI_FROM_FIXTURE = `---
name: 多源 from 测试
version: 1.0.0
purpose: 修改单 002 多源 fromConditions 加括号回归
roles:
  - id: r1
    name: 测试
---

# 背景

T9 从 PS2/PS3/PS4 任一状态可触发到 PS5

# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| PS2 | 源 A | normal |
| PS3 | 源 B | normal |
| PS4 | 源 C | normal |
| PS5 | 终态 | terminal |

# 转移规则

| ID | 名称 | from | to | action |
|---|---|---|---|---|
| T9 | 多源到终态 | PS2, PS3, PS4 | PS5 | finish |
`;

    test('多源 from 的源状态析取被括号包裹，避免与后面 guard 的 /\\ 优先级冲突', () => {
      const model = parseProtocolContent(MULTI_FROM_FIXTURE);
      const adapter = new TLAAdapter();
      const spec = adapter.generateSpec(model.derivable);

      // 期望：`/\\ (state = "PS2" \\/ state = "PS3" \\/ state = "PS4")`
      // 关键修复点：左括号紧跟 /\\，右括号闭合后接空字符串（无 guard 时）
      expect(spec).toContain('/\\ (state = "PS2" \\/ state = "PS3" \\/ state = "PS4")');
      // 不能出现未加括号的版本（修复前行为）
      const unparenPattern = '/\\ state = "PS2" \\/ state = "PS3" \\/ state = "PS4"';
      expect(spec).not.toContain(unparenPattern);
    });
  });

  describe('现有 hsk-ng / strangler-fig 风格 ID 不受影响', () => {
    const SIMPLE_FIXTURE = `---
name: 简单不变量 ID
version: 1.0.0
purpose: 不变量 ID 无连字符时行为不变
roles:
  - id: r1
    name: 测试
---

# 背景

简单 ID 测试

# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S1 | 初始 | initial |
| S2 | 终态 | terminal |

# 转移规则

| ID | 名称 | from | to | action |
|---|---|---|---|---|
| T1 | 开始 | S1 | S2 | start |

# 不变量

| ID | 名称 | 表达式 |
|---|---|---|
| INV1 | 普通不变量 | state = "S2" |
`;

    test('不变量 ID 无连字符时表达式位置仍用原 ID（不引入意外下划线）', () => {
      const model = parseProtocolContent(SIMPLE_FIXTURE);
      const adapter = new TLAAdapter();
      const spec = adapter.generateSpec(model.derivable);

      expect(spec).toContain('INV1 ==');
      expect(spec).toContain('(id=INV1)');
    });
  });
});
