import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProtocolContent } from '../../src/parser/index.js';
import { diffModels, formatDiffSummary } from '../../src/differ/index.js';
import type { AIAdapter, AIPrompt, AIResponse, SourceProtocolModel } from '../../src/model/types.js';

const FIXTURES = join(process.cwd(), 'tests/fixtures');
function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf-8');
}

class MockAIAdapter implements AIAdapter {
  name = 'mock';
  constructor(private equivalent: boolean, private succeed = true) {}
  async complete(prompt: AIPrompt): Promise<AIResponse> {
    return {
      content: JSON.stringify({ equivalent: this.equivalent, reason: 'mock 判断' }),
      success: this.succeed,
      attempts: 1,
    };
  }
}

function makeModel(content: string): SourceProtocolModel {
  return parseProtocolContent(content);
}

describe('differ', () => {
  describe('元数据层 diff', () => {
    test('检测 name/version/purpose 变更', async () => {
      const oldModel = makeModel(`---
name: 协议A
version: 1.0.0
purpose: 用途1
roles:
  - id: r1
    name: 角色1
---

# 背景

内容
`);
      const newModel = makeModel(`---
name: 协议B
version: 2.0.0
purpose: 用途2
roles:
  - id: r1
    name: 角色1
---

# 背景

内容
`);
      const result = await diffModels(oldModel, newModel);
      const metaChanges = result.diff.metadataChanges;
      expect(metaChanges.some((c) => c.path === 'metadata.name')).toBe(true);
      expect(metaChanges.some((c) => c.path === 'metadata.version')).toBe(true);
      expect(metaChanges.some((c) => c.path === 'metadata.purpose')).toBe(true);
    });

    test('检测角色新增/删除', async () => {
      const oldModel = makeModel(`---
name: 测试
version: 1.0.0
purpose: 测试
roles:
  - id: r1
    name: 角色1
  - id: r2
    name: 角色2
---

# 背景

测试
`);
      const newModel = makeModel(`---
name: 测试
version: 1.0.0
purpose: 测试
roles:
  - id: r2
    name: 角色2
  - id: r3
    name: 角色3
---

# 背景

测试
`);
      const result = await diffModels(oldModel, newModel);
      const metaChanges = result.diff.metadataChanges;
      expect(metaChanges.some((c) => c.path === 'metadata.roles[r1]' && c.kind === 'removed')).toBe(true);
      expect(metaChanges.some((c) => c.path === 'metadata.roles[r3]' && c.kind === 'added')).toBe(true);
    });

    test('检测变更声明变更', async () => {
      const oldModel = makeModel(`---
name: 测试
version: 1.0.0
purpose: 测试
roles:
  - id: r1
    name: 角色1
---

# 背景

测试
`);
      const newModel = makeModel(`---
name: 测试
version: 1.0.0
purpose: 测试
roles:
  - id: r1
    name: 角色1
changeDeclarations:
  - targetId: INV1
    changeType: paradigm_renegotiation
    reason: 不变量语义变更
---

# 背景

测试
`);
      const result = await diffModels(oldModel, newModel);
      expect(result.diff.metadataChanges.some((c) => c.path === 'metadata.changeDeclarations')).toBe(true);
    });
  });

  describe('可读层 diff', () => {
    test('检测背景/流程/异常处理变更', async () => {
      const oldModel = makeModel(`---
name: 测试
version: 1.0.0
purpose: 测试
roles:
  - id: r1
    name: 角色1
---

# 背景

旧背景

# 协作流程

旧流程
`);
      const newModel = makeModel(`---
name: 测试
version: 1.0.0
purpose: 测试
roles:
  - id: r1
    name: 角色1
---

# 背景

新背景

# 协作流程

新流程
`);
      const result = await diffModels(oldModel, newModel);
      expect(result.diff.readableChanges.some((c) => c.path === 'readable.background')).toBe(true);
      expect(result.diff.readableChanges.some((c) => c.path === 'readable.workflow')).toBe(true);
    });
  });

  describe('可推演层 diff', () => {
    test('检测状态新增/删除/修改', async () => {
      const oldModel = makeModel(`---
name: 测试
version: 1.0.0
purpose: 测试
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
`);
      const newModel = makeModel(`---
name: 测试
version: 1.0.0
purpose: 测试
roles:
  - id: r1
    name: 角色1
---

# 背景

测试

# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S1 | 起始 | initial |
| S2 | 中间 | normal |
| S4 | 新增态 | terminal |
`);
      const result = await diffModels(oldModel, newModel);
      const stateChanges = result.diff.derivableChanges.filter((c) => c.elementType === 'state');
      expect(stateChanges.some((c) => c.elementId === 'S3' && c.kind === 'removed')).toBe(true);
      expect(stateChanges.some((c) => c.elementId === 'S4' && c.kind === 'added')).toBe(true);
      expect(stateChanges.some((c) => c.elementId === 'S1' && c.kind === 'modified')).toBe(true);
    });

    test('检测转移变更', async () => {
      const oldModel = makeModel(`---
name: 测试
version: 1.0.0
purpose: 测试
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

| ID | 名称 | from | to | action | trigger |
|---|---|---|---|---|---|
| T1 | 完成 | S1 | S2 | finish | r1 |
`);
      const newModel = makeModel(`---
name: 测试
version: 1.0.0
purpose: 测试
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

| ID | 名称 | from | to | action | trigger |
|---|---|---|---|---|---|
| T1 | 完成 | S1 | S2 | complete | r1 |
| T2 | 重置 | S2 | S1 | reset | r1 |
`);
      const result = await diffModels(oldModel, newModel);
      const transitionChanges = result.diff.derivableChanges.filter((c) => c.elementType === 'transition');
      expect(transitionChanges.some((c) => c.elementId === 'T1' && c.kind === 'modified')).toBe(true);
      expect(transitionChanges.some((c) => c.elementId === 'T2' && c.kind === 'added')).toBe(true);
    });

    test('检测不变量表达式变更（无 AI 时标记待判断）', async () => {
      const oldModel = makeModel(`---
name: 测试
version: 1.0.0
purpose: 测试
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
| T1 | 完成 | S1 | S2 | finish |

# 不变量

| ID | 名称 | 表达式 |
|---|---|---|
| INV1 | 不变量1 | forall x: x > 0 |
`);
      const newModel = makeModel(`---
name: 测试
version: 1.0.0
purpose: 测试
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
| T1 | 完成 | S1 | S2 | finish |

# 不变量

| ID | 名称 | 表达式 |
|---|---|---|
| INV1 | 不变量1 | forall x: x >= 1 |
`);
      const result = await diffModels(oldModel, newModel, undefined, {
        useAIForInvariantEquivalence: false,
      });
      const invChange = result.diff.derivableChanges.find(
        (c) => c.elementType === 'invariant' && c.elementId === 'INV1'
      );
      expect(invChange).toBeDefined();
      expect(invChange!.needsSemanticJudgment).toBe(true);
    });

    test('AI 判断不变量语义等价时不标记 needsSemanticJudgment', async () => {
      const oldModel = makeModel(`---
name: 测试
version: 1.0.0
purpose: 测试
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
| T1 | 完成 | S1 | S2 | finish |

# 不变量

| ID | 名称 | 表达式 |
|---|---|---|
| INV1 | 不变量1 | not exists p: p > 1 |
`);
      const newModel = makeModel(`---
name: 测试
version: 1.0.0
purpose: 测试
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
| T1 | 完成 | S1 | S2 | finish |

# 不变量

| ID | 名称 | 表达式 |
|---|---|---|
| INV1 | 不变量1 | forall p: p <= 1 |
`);
      const aiAdapter = new MockAIAdapter(true); // 判断为语义等价
      const result = await diffModels(oldModel, newModel, aiAdapter, {
        useAIForInvariantEquivalence: true,
      });
      const invChange = result.diff.derivableChanges.find(
        (c) => c.elementType === 'invariant' && c.elementId === 'INV1'
      );
      expect(invChange).toBeDefined();
      expect(invChange!.needsSemanticJudgment).toBe(false);
    });

    test('AI 判断不变量语义不等价时保留 needsSemanticJudgment', async () => {
      const oldModel = makeModel(`---
name: 测试
version: 1.0.0
purpose: 测试
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
| T1 | 完成 | S1 | S2 | finish |

# 不变量

| ID | 名称 | 表达式 |
|---|---|---|
| INV1 | 不变量1 | forall x: x > 0 |
`);
      const newModel = makeModel(`---
name: 测试
version: 1.0.0
purpose: 测试
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
| T1 | 完成 | S1 | S2 | finish |

# 不变量

| ID | 名称 | 表达式 |
|---|---|---|
| INV1 | 不变量1 | forall x: x > 1 |
`);
      const aiAdapter = new MockAIAdapter(false); // 判断为不等价
      const result = await diffModels(oldModel, newModel, aiAdapter, {
        useAIForInvariantEquivalence: true,
      });
      const invChange = result.diff.derivableChanges.find(
        (c) => c.elementType === 'invariant' && c.elementId === 'INV1'
      );
      expect(invChange).toBeDefined();
      expect(invChange!.needsSemanticJudgment).toBe(true);
    });
  });

  describe('影响分析', () => {
    test('无变更时受影响步骤为空', async () => {
      const model = makeModel(readFixture('approval-flow.md'));
      const result = await diffModels(model, model);
      expect(result.impact.affectedSteps).toEqual([]);
      expect(result.impact.incrementalPlan).toEqual([]);
    });

    test('可推演层变更影响所有下游步骤', async () => {
      const oldModel = makeModel(`---
name: 测试
version: 1.0.0
purpose: 测试
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
| T1 | 完成 | S1 | S2 | finish |
`);
      const newModel = makeModel(`---
name: 测试
version: 1.0.0
purpose: 测试
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
| T1 | 完成 | S1 | S2 | complete |
`);
      const result = await diffModels(oldModel, newModel);
      expect(result.impact.affectedSteps).toEqual(
        expect.arrayContaining([
          'check', 'reason', 'formalize',
          'derive-specs', 'derive-contracts',
          'generate-tests', 'generate-cases',
          'check-impl', 'verify',
        ])
      );
    });

    test('仅可读层变更只影响 check 步骤', async () => {
      const oldModel = makeModel(`---
name: 测试
version: 1.0.0
purpose: 测试
roles:
  - id: r1
    name: 角色1
---

# 背景

旧背景
`);
      const newModel = makeModel(`---
name: 测试
version: 1.0.0
purpose: 测试
roles:
  - id: r1
    name: 角色1
---

# 背景

新背景
`);
      const result = await diffModels(oldModel, newModel);
      expect(result.impact.affectedSteps).toEqual(['check']);
    });

    test('增量重推导路径按 DAG 顺序', async () => {
      const oldModel = makeModel(`---
name: 测试
version: 1.0.0
purpose: 测试
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
| T1 | 完成 | S1 | S2 | finish |
`);
      const newModel = makeModel(`---
name: 测试
version: 1.0.0
purpose: 测试
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
| S2 | 完成 | terminal |
`);
      const result = await diffModels(oldModel, newModel);
      const plan = result.impact.incrementalPlan;
      // 第一个应是 check
      expect(plan[0]).toBe('check');
      // 顺序应符合 DAG
      const checkIdx = plan.indexOf('check');
      const reasonIdx = plan.indexOf('reason');
      const formalizeIdx = plan.indexOf('formalize');
      expect(reasonIdx).toBeGreaterThan(checkIdx);
      expect(formalizeIdx).toBeGreaterThan(reasonIdx);
    });
  });

  describe('报告摘要', () => {
    test('摘要包含元数据/可读层/可推演层变更计数', async () => {
      const oldModel = makeModel(readFixture('approval-flow.md'));
      const newModel = makeModel(`---
name: 审批流协议
version: 2.0.0
purpose: 新的审批流
roles:
  - id: applicant
    name: 申请人
  - id: approver
    name: 审批人
  - id: system
    name: 系统
---

# 背景

新背景
`);
      const result = await diffModels(oldModel, newModel);
      const summary = formatDiffSummary(result);
      expect(summary).toContain('元数据变更');
      expect(summary).toContain('可读层变更');
      expect(summary).toContain('可推演层变更');
      expect(summary).toContain('影响分析');
    });
  });
});
