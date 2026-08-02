import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProtocolContent } from '../../src/parser/index.js';
import { checkCompleteness } from '../../src/checker/index.js';

const FIXTURES = join(process.cwd(), 'tests/fixtures');

function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf-8');
}

describe('checker (机械层)', () => {
  describe('审批流正常协议', () => {
    const model = parseProtocolContent(readFixture('approval-flow.md'));
    const report = checkCompleteness(model);

    test('机械层通过', () => {
      expect(report.mechanical.passed).toBe(true);
    });

    test('结构完备性无 error', () => {
      const errors = report.mechanical.structuralIssues.filter((i) => i.severity === 'error');
      expect(errors).toHaveLength(0);
    });

    test('字段完整性无 error', () => {
      const errors = report.mechanical.fieldIssues.filter((i) => i.severity === 'error');
      expect(errors).toHaveLength(0);
    });

    test('ID 交叉引用无 error', () => {
      const errors = report.mechanical.referenceIssues.filter((i) => i.severity === 'error');
      expect(errors).toHaveLength(0);
    });

    test('语义层未执行（无 AI 适配器）', () => {
      expect(report.semantic.executed).toBe(false);
    });

    test('总体通过', () => {
      expect(report.passed).toBe(true);
    });
  });

  describe('退化模式 TLA+ 结构检查', () => {
    const model = parseProtocolContent(readFixture('degraded-protocol.md'));
    const report = checkCompleteness(model);

    test('TLA+ 结构检查通过（含 Init/Next/Inv）', () => {
      const errors = report.mechanical.structuralIssues.filter((i) => i.severity === 'error');
      expect(errors).toHaveLength(0);
    });
  });

  describe('ID 交叉引用错误检测', () => {
    const badModel = parseProtocolContent(`---
name: 测试
version: 1.0.0
purpose: 测试引用错误
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
| S3 | 终态 | terminal |

# 转移规则

| ID | 名称 | from | to | action | trigger |
|---|---|---|---|---|---|
| T1 | 转移到不存在 | S1 | S2 | act | r1 |
| T2 | 角色不存在 | S1 | S3 | act | r2 |
`);

    test('检测到不存在的状态引用', () => {
      const report = checkCompleteness(badModel);
      const stateRefErrors = report.mechanical.referenceIssues.filter(
        (i) => i.severity === 'error' && i.message.includes('S2')
      );
      expect(stateRefErrors.length).toBeGreaterThan(0);
    });

    test('检测到不存在的角色引用', () => {
      const report = checkCompleteness(badModel);
      const roleRefErrors = report.mechanical.referenceIssues.filter(
        (i) => i.severity === 'error' && i.message.includes('r2')
      );
      expect(roleRefErrors.length).toBeGreaterThan(0);
    });

    test('机械层不通过', () => {
      const report = checkCompleteness(badModel);
      expect(report.mechanical.passed).toBe(false);
    });
  });

  describe('字段完整性错误检测', () => {
    test('检测重复 ID', () => {
      const model = parseProtocolContent(`---
name: 测试
version: 1.0.0
purpose: 测试重复ID
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
      const report = checkCompleteness(model);
      const dupErrors = report.mechanical.fieldIssues.filter(
        (i) => i.severity === 'error' && i.message.includes('重复')
      );
      expect(dupErrors.length).toBeGreaterThan(0);
      expect(report.mechanical.passed).toBe(false);
    });

    test('检测多个初始状态', () => {
      const model = parseProtocolContent(`---
name: 测试
version: 1.0.0
purpose: 测试多初始状态
roles:
  - id: r1
    name: 角色1
---

# 背景

测试

# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S1 | 初始1 | initial |
| S2 | 初始2 | initial |
| S3 | 终态 | terminal |
`);
      const report = checkCompleteness(model);
      const initErrors = report.mechanical.structuralIssues.filter(
        (i) => i.severity === 'error' && i.message.includes('初始状态')
      );
      expect(initErrors.length).toBeGreaterThan(0);
    });

    test('检测 deadline 缺少 boundMs', () => {
      const model = parseProtocolContent(`---
name: 测试
version: 1.0.0
purpose: 测试时序约束
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

# 时序约束

| ID | 名称 | 类型 | 源 | 目标 |
|---|---|---|---|---|
| TM1 | 缺少约束值 | deadline | act | S2 |
`);
      const report = checkCompleteness(model);
      const timingErrors = report.mechanical.fieldIssues.filter(
        (i) => i.severity === 'error' && i.message.includes('boundMs')
      );
      expect(timingErrors.length).toBeGreaterThan(0);
    });
  });

  describe('异常路径引用检查', () => {
    test('检测异常路径引用不存在的转移', () => {
      const model = parseProtocolContent(`---
name: 测试
version: 1.0.0
purpose: 测试异常路径
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

# 异常路径

| ID | 名称 | 触发 | 转移序列 |
|---|---|---|---|
| EX1 | 异常 | 超时 | T1,T99 |
`);
      const report = checkCompleteness(model);
      const exErrors = report.mechanical.referenceIssues.filter(
        (i) => i.severity === 'error' && i.message.includes('T99')
      );
      expect(exErrors.length).toBeGreaterThan(0);
    });
  });
});
