import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProtocolContent } from '../../src/parser/index.js';
import { specify, specsFromEnvelope } from '../../src/specifier/index.js';
import { deriveContracts } from '../../src/contractor/index.js';
import type { AIAdapter, AIPrompt, AIResponse } from '../../src/model/types.js';

const FIXTURES = join(process.cwd(), 'tests/fixtures');
function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf-8');
}

class MockAIAdapter implements AIAdapter {
  name = 'mock';
  constructor(private responseContent: string, private succeed = true) {}
  async complete(prompt: AIPrompt): Promise<AIResponse> {
    return { content: this.responseContent, success: this.succeed, attempts: 1 };
  }
}

describe('contractor', () => {
  describe('信息契约推导', () => {
    const model = parseProtocolContent(readFixture('approval-flow.md'));
    const specs = specsFromEnvelope(specify(model));
    const result = deriveContracts(model, specs, undefined, {
      useAIForInvariantRelevance: false,
    });

    test('契约方 = 协议角色列表', async () => {
      const r = await result;
      expect(r.contracts.parties).toEqual(
        expect.arrayContaining(['applicant', 'approver', 'system'])
      );
    });

    test('每个转移生成请求字段', async () => {
      const r = await result;
      const submitField = r.contracts.information.fields.find(
        (f) => f.name === 'submit_request'
      );
      expect(submitField).toBeDefined();
      // 提交由 applicant 触发
      expect(submitField!.providedBy).toBe('applicant');
    });

    test('effects 生成副作用字段', async () => {
      const r = await result;
      const effectField = r.contracts.information.fields.find(
        (f) => f.name === 'create_request'
      );
      expect(effectField).toBeDefined();
      expect(effectField!.type).toBe('string');
    });

    test('信息流方向正确', async () => {
      const r = await result;
      // submit 的信息流：applicant → approver（待审批状态关联 approver）
      const submitFlow = r.contracts.information.flows.find(
        (f) => f.triggerAction === 'submit'
      );
      expect(submitFlow).toBeDefined();
      expect(submitFlow!.from).toBe('applicant');
      expect(submitFlow!.to).toBe('approver');
    });

    test('消费者为空时降级为其他所有方', async () => {
      // 已通过终态 S3 关联角色为空，则消费者为其他所有方
      const r = await result;
      const approveFlow = r.contracts.information.flows.find(
        (f) => f.triggerAction === 'approve'
      );
      expect(approveFlow).toBeDefined();
      expect(approveFlow!.from).toBe('approver');
    });
  });

  describe('时序契约推导', () => {
    const model = parseProtocolContent(readFixture('approval-flow.md'));
    const specs = specsFromEnvelope(specify(model));
    const result = deriveContracts(model, specs, undefined, {
      useAIForInvariantRelevance: false,
    });

    test('每个时序约束生成一项契约', async () => {
      const r = await result;
      expect(r.contracts.timing.constraints.length).toBe(
        model.derivable.timing.length
      );
    });

    test('时序契约保留 boundMs', async () => {
      const r = await result;
      const tm1 = r.contracts.timing.constraints.find((c) => c.timingId === 'TM1');
      expect(tm1).toBeDefined();
      expect(tm1!.boundMs).toBe(86400000);
      expect(tm1!.type).toBe('timeout');
    });

    test('时序契约涉及受约束方', async () => {
      const r = await result;
      const tm1 = r.contracts.timing.constraints.find((c) => c.timingId === 'TM1');
      // TM1 源=submit, 目标=approve，涉及 applicant 与 approver
      expect(tm1!.parties).toEqual(
        expect.arrayContaining(['applicant', 'approver'])
      );
    });
  });

  describe('约束契约推导', () => {
    const model = parseProtocolContent(readFixture('approval-flow.md'));
    const specs = specsFromEnvelope(specify(model));
    const result = deriveContracts(model, specs, undefined, {
      useAIForInvariantRelevance: false,
    });

    test('为带 guard 的转移生成约束项', async () => {
      const r = await result;
      // 审批流所有转移都有 guard
      expect(r.contracts.constraint.guards.length).toBe(
        model.derivable.transitions.length
      );
    });

    test('保留 guard 表达式与 action', async () => {
      const r = await result;
      const submitGuard = r.contracts.constraint.guards.find(
        (g) => g.action === 'submit'
      );
      expect(submitGuard).toBeDefined();
      expect(submitGuard!.guard).toBe('form_valid');
    });

    test('约束方包含触发者', async () => {
      const r = await result;
      const submitGuard = r.contracts.constraint.guards.find(
        (g) => g.action === 'submit'
      );
      expect(submitGuard!.parties).toContain('applicant');
    });
  });

  describe('不变量契约推导', () => {
    test('无 AI 时使用代码预判相关性', async () => {
      const model = parseProtocolContent(readFixture('approval-flow.md'));
      const specs = specsFromEnvelope(specify(model));
      const r = await deriveContracts(model, specs, undefined, {
        useAIForInvariantRelevance: false,
      });

      // 两个全局不变量：代码预判 parties=[]，note 标识需 AI 判断
      expect(r.contracts.invariant.invariants.length).toBe(2);
      const inv1 = r.contracts.invariant.invariants.find(
        (i) => i.invariantId === 'INV1'
      );
      expect(inv1).toBeDefined();
      expect(inv1!.expression).toContain('active_requests');
      expect(inv1!.relevanceNote).toContain('全局不变量');
    });

    test('AI 辅助判断不变量相关性', async () => {
      const model = parseProtocolContent(readFixture('approval-flow.md'));
      const specs = specsFromEnvelope(specify(model));
      const aiResponse = JSON.stringify({
        results: [
          {
            invariantId: 'INV1',
            parties: ['applicant'],
            note: 'INV1 限制申请人活动请求数，与 applicant 相关',
          },
          {
            invariantId: 'INV2',
            parties: ['system'],
            note: 'INV2 由系统在状态机中保证',
          },
        ],
      });
      const adapter = new MockAIAdapter(aiResponse);
      const r = await deriveContracts(model, specs, adapter, {
        useAIForInvariantRelevance: true,
      });

      const inv1 = r.contracts.invariant.invariants.find(
        (i) => i.invariantId === 'INV1'
      );
      expect(inv1!.parties).toEqual(['applicant']);
      expect(inv1!.relevanceNote).toContain('applicant');
      expect(inv1!.degradedAssist).toBe(true);
    });

    test('AI 调用失败时回退到代码预判', async () => {
      const model = parseProtocolContent(readFixture('approval-flow.md'));
      const specs = specsFromEnvelope(specify(model));
      const adapter = new MockAIAdapter('', false);
      const r = await deriveContracts(model, specs, adapter, {
        useAIForInvariantRelevance: true,
      });

      // AI 失败：回退到代码预判，全局不变量 parties=[]
      const inv1 = r.contracts.invariant.invariants.find(
        (i) => i.invariantId === 'INV1'
      );
      expect(inv1!.parties).toEqual([]);
    });

    test('AI 输出无法解析时回退到代码预判', async () => {
      const model = parseProtocolContent(readFixture('approval-flow.md'));
      const specs = specsFromEnvelope(specify(model));
      const adapter = new MockAIAdapter('不是 JSON');
      const r = await deriveContracts(model, specs, adapter, {
        useAIForInvariantRelevance: true,
      });

      const inv1 = r.contracts.invariant.invariants.find(
        (i) => i.invariantId === 'INV1'
      );
      expect(inv1!.parties).toEqual([]);
    });

    test('局部不变量按作用状态关联角色', async () => {
      const model = parseProtocolContent(`---
name: 测试局部不变量
version: 1.0.0
purpose: 测试不变量作用域
roles:
  - id: r1
    name: 角色1
  - id: r2
    name: 角色2
---

# 背景

测试

# 状态空间

| ID | 名称 | 类型 | 角色 |
|---|---|---|---|
| S1 | 初始 | initial | r1 |
| S2 | 处理中 | normal | r2 |
| S3 | 完成 | terminal | |

# 转移规则

| ID | 名称 | from | to | action | trigger |
|---|---|---|---|---|---|
| T1 | 处理 | S1 | S2 | process | r1 |
| T2 | 完成 | S2 | S3 | finish | r2 |

# 不变量

| ID | 名称 | 表达式 | 作用状态 |
|---|---|---|---|
| INV1 | 处理中不变量 | x > 0 | S2 |
`);
      const specs = specsFromEnvelope(specify(model));
      const r = await deriveContracts(model, specs, undefined, {
        useAIForInvariantRelevance: false,
      });

      const inv1 = r.contracts.invariant.invariants.find(
        (i) => i.invariantId === 'INV1'
      );
      // INV1 作用于 S2，S2 关联 r2
      expect(inv1!.parties).toEqual(['r2']);
    });
  });

  describe('退化模式', () => {
    test('退化模式正常推导（不变量相关性无 AI 时回退）', async () => {
      const model = parseProtocolContent(readFixture('degraded-protocol.md'));
      const specs = specsFromEnvelope(specify(model));
      const r = await deriveContracts(model, specs, undefined, {
        useAIForInvariantRelevance: false,
      });
      // 退化模式：契约方来自角色
      expect(r.contracts.parties).toEqual(['node']);
    });
  });
});
