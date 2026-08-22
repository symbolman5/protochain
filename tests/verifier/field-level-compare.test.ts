/**
 * E2 verify 字段级偏差对比 —— 单测
 *
 * 设计依据：IMPLEMENTATION-ACCEPTANCE.md §E2
 *
 * 覆盖：
 * - field-compare 模块独立逻辑
 * - verify binding-runner 集成：fields mismatch 报告含 field/legacy/impl
 * - 老格式 specs.json（无 schema）→ 沿用原 state_mismatch 路径
 */

import { parseProtocolContent } from '../../src/parser/index.js';
import { specify, specsFromEnvelope } from '../../src/specifier/index.js';
import { compareFields, makeFieldDeviationFn } from '../../src/verifier/field-compare.js';
import { generateCases } from '../../src/casegen/index.js';
import { verify, type VerifyContext } from '../../src/verifier/index.js';
import type { ScenarioParamSource, TransportExecutorFn } from '../../src/verifier/binding-runner.js';
import type { BindingConfig, InterfaceSpec, SourceProtocolModel } from '../../src/model/types.js';
import type { TransportResult } from '../../src/transport/types.js';

// ============================================================================
// 工具
// ============================================================================

function makeTransport(
  handlers: Record<string, (params: Record<string, unknown>) => TransportResult>
): TransportExecutorFn {
  return async (resolved, params) => {
    if (!resolved?.binding) {
      return { status: 404, data: { error: '接口未绑定' }, ok: false };
    }
    const handler = handlers[resolved.spec.name];
    if (!handler) {
      return { status: 404, data: { error: `未找到 ${resolved.spec.name} 的 mock` }, ok: false };
    }
    return handler(params);
  };
}

function ok(data: unknown, status = 200): TransportResult {
  return { status, data, ok: status >= 200 && status < 300 };
}

const MODEL: SourceProtocolModel = parseProtocolContent(`---
name: 字段级协议
version: 1.0.0
purpose: 字段级偏差测试
roles:
  - id: user
    name: 用户
---
# 背景
测试

# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S1 | 初态 | initial |
| S2 | 终态 | terminal |

# 转移规则

| ID | 名称 | from | to | action | trigger |
|---|---|---|---|---|---|
| T1 | 走 | S1 | S2 | go | user |
`);

// ============================================================================
// field-compare 单测
// ============================================================================

describe('E2 field-compare 单元', () => {
  test('无 responseSchema → 不产出偏差（沿用 state_mismatch）', () => {
    const spec: InterfaceSpec = {
      id: 'X',
      kind: 'system',
      sourceId: 'X',
      name: 'X',
      inputs: [],
      outputs: [],
    };
    const devs = compareFields({
      spec,
      action: 'X',
      state: 'S1',
      implResponse: { foo: 'bar' },
      legacyExpected: { foo: 'bar' },
    });
    expect(devs).toEqual([]);
  });

  test('impl 响应字段类型与 schema 不符 → 产出 field_mismatch', () => {
    const spec: InterfaceSpec = {
      id: 'X',
      kind: 'system',
      sourceId: 'X',
      name: 'X',
      inputs: [],
      outputs: [],
      responseSchema: {
        type: 'object',
        properties: {
          approverId: { type: 'string' },
          total: { type: 'number' },
        },
        required: ['approverId', 'total'],
      },
    };
    const devs = compareFields({
      spec,
      action: 'approve',
      state: 'S2',
      stepIndex: 0,
      implResponse: { approverId: 42, total: 'not-number' }, // 类型均不符
      httpStatus: 200,
    });
    expect(devs.length).toBeGreaterThanOrEqual(2);
    expect(devs.every((d) => d.kind === 'field_mismatch')).toBe(true);
    // 字段路径
    expect(devs.some((d) => d.field === 'response.approverId')).toBe(true);
    expect(devs.some((d) => d.field === 'response.total')).toBe(true);
    // 类型差异：expected='string' actual='number' (etc.)
    expect(devs.find((d) => d.field === 'response.approverId')?.expected).toBe('string');
    expect(devs.find((d) => d.field === 'response.approverId')?.impl).toBe('number');
  });

  test('required 字段缺失 → field_mismatch actual="missing"', () => {
    const spec: InterfaceSpec = {
      id: 'X',
      kind: 'system',
      sourceId: 'X',
      name: 'X',
      inputs: [],
      outputs: [],
      responseSchema: {
        type: 'object',
        properties: { approverId: { type: 'string' } },
        required: ['approverId'],
      },
    };
    const devs = compareFields({
      spec,
      action: 'approve',
      state: 'S2',
      implResponse: {},
    });
    expect(devs.length).toBe(1);
    expect(devs[0].field).toBe('response.approverId');
    expect(devs[0].actual).toBe('missing');
    expect(devs[0].impl).toBe('missing');
  });

  test('legacy expected 不一致 → 输出 field/legacy/impl 三元组', () => {
    const spec: InterfaceSpec = {
      id: 'X',
      kind: 'system',
      sourceId: 'X',
      name: 'X',
      inputs: [],
      outputs: [],
      responseSchema: {
        type: 'object',
        properties: {
          approverId: { type: 'string' },
          result: { type: 'string' },
        },
      },
    };
    const devs = compareFields({
      spec,
      action: 'approve',
      state: 'S2',
      implResponse: { approverId: 'bob', result: 'rejected' }, // 期望 alice/approved
      legacyExpected: { approverId: 'alice', result: 'approved' },
    });
    expect(devs.length).toBe(2);
    const approver = devs.find((d) => d.field === 'response.approverId')!;
    expect(approver.legacy).toBe('alice');
    expect(approver.impl).toBe('bob');
    const result = devs.find((d) => d.field === 'response.result')!;
    expect(result.legacy).toBe('approved');
    expect(result.impl).toBe('rejected');
  });

  test('legacy 一致时不产出偏差', () => {
    const spec: InterfaceSpec = {
      id: 'X',
      kind: 'system',
      sourceId: 'X',
      name: 'X',
      inputs: [],
      outputs: [],
      responseSchema: {
        type: 'object',
        properties: { x: { type: 'string' } },
      },
    };
    const devs = compareFields({
      spec,
      action: 'go',
      state: 'S1',
      implResponse: { x: 'yes' },
      legacyExpected: { x: 'yes' },
    });
    expect(devs).toEqual([]);
  });

  test('makeFieldDeviationFn 工厂函数', () => {
    const spec: InterfaceSpec = {
      id: 'X',
      kind: 'system',
      sourceId: 'X',
      name: 'X',
      inputs: [],
      outputs: [],
      responseSchema: {
        type: 'object',
        properties: { a: { type: 'string' } },
      },
    };
    const fn = makeFieldDeviationFn(spec);
    const devs = fn({
      action: 'X',
      state: 'S1',
      stepIndex: 0,
      implResponse: { a: 123 }, // 类型不符
    });
    expect(devs.length).toBe(1);
    expect(devs[0].kind).toBe('field_mismatch');
  });
});

// ============================================================================
// verify 集成：字段级偏差出现在 verification-report.json
// ============================================================================

describe('E2 verify 字段级偏差集成', () => {
  const goBinding: BindingConfig = {
    roles: { R: { roleId: 'R', baseUrl: 'http://mock.local/api', auth: 'none' } },
    interfaces: [
      { action: 'go', roleId: 'R', transport: { type: 'http', method: 'POST', path: '/go', params: [] } },
    ],
  };

  test('新格式 specs.json + 启用 enableFieldLevelCompare + legacy 期望 → 报告含 field_mismatch (legacy=Y, impl=Z)', async () => {
    // 给 spec 加 responseSchema 与 InputFieldSpec → field-compare 钩子可识别
    const specs = specsFromEnvelope(specify(MODEL));
    // 期望 go 接口响应含 approverId='alice' 但 impl 返回 'bob'
    specs.forEach((s) => {
      if (s.name === 'go') {
        s.outputs.push({
          name: 'approverId',
          type: 'string',
          description: '审批人 ID',
          required: true,
        });
        s.outputs.push({
          name: 'decision',
          type: 'string',
          description: '审批结果',
        });
        s.responseSchema = {
          type: 'object',
          properties: {
            nextState: { type: 'string', enum: ['S1', 'S2', '-'] },
            approverId: { type: 'string', description: '审批人 ID' },
            decision: { type: 'string', description: '审批结果' },
          },
          required: ['nextState', 'approverId'],
          additionalProperties: true,
        };
      }
    });

    const transport = makeTransport({
      go: () => ok({ nextState: 'S2', approverId: 'bob', decision: 'rejected' }),
    });

    const ctx: VerifyContext = {
      rootDir: '.',
      specs,
      bindings: goBinding,
      transportExecutor: transport,
      // 启用 E2 字段级对比
      enableFieldLevelCompare: true,
      // legacy 期望
      legacyExpectedResponses: {
        go: { approverId: 'alice', decision: 'approved' },
      },
    };
    // 注入用例（跑一条 go 路径）
    const testCases = generateCases(MODEL, { criterion: 'state' });
    ctx.testCases = testCases;

    const report = await verify(MODEL, ctx);
    expect(report.authoritative).toBeDefined();
    // expect at least one field_mismatch
    const flat = report.authoritative.caseResults.flatMap((c) => c.deviations ?? []);
    const fieldDevs = flat.filter((d) => d.kind === 'field_mismatch');
    expect(fieldDevs.length).toBeGreaterThan(0);
    // 含 legacy/impl 三元组（验证报告"字段 X：legacy=Y, impl=Z"形态）
    const approverDev = fieldDevs.find((d) => d.field === 'response.approverId');
    expect(approverDev).toBeDefined();
    expect(approverDev?.legacy).toBe('alice');
    expect(approverDev?.impl).toBe('bob');
    const decisionDev = fieldDevs.find((d) => d.field === 'response.decision');
    expect(decisionDev).toBeDefined();
    expect(decisionDev?.legacy).toBe('approved');
    expect(decisionDev?.impl).toBe('rejected');
  });

  test('未启用 enableFieldLevelCompare → 字段级偏差不产出，仍走原 state_mismatch', async () => {
    const specs = specsFromEnvelope(specify(MODEL));
    specs.forEach((s) => {
      if (s.name === 'go') {
        s.responseSchema = {
          type: 'object',
          properties: { magic: { type: 'string' } },
        };
      }
    });
    const transport = makeTransport({
      go: () => ok({ nextState: 'S2', magic: 'X' }),
    });
    const ctx: VerifyContext = {
      rootDir: '.',
      specs,
      bindings: goBinding,
      transportExecutor: transport,
      enableFieldLevelCompare: false, // 关闭
    };
    const testCases = generateCases(MODEL, { criterion: 'state' });
    ctx.testCases = testCases;
    const report = await verify(MODEL, ctx);
    const flat = report.authoritative.caseResults.flatMap((c) => c.deviations ?? []);
    const fieldDevs = flat.filter((d) => d.kind === 'field_mismatch');
    expect(fieldDevs.length).toBe(0);
  });

  test('spec 无 responseSchema → 不产出 field_mismatch（即使启用）', async () => {
    const specs = specsFromEnvelope(specify(MODEL));
    specs.forEach((s) => {
      if (s.name === 'go') delete s.responseSchema; // 模拟老格式
    });
    const transport = makeTransport({
      go: () => ok({ nextState: 'S2', approverId: 'bob' }),
    });
    const ctx: VerifyContext = {
      rootDir: '.',
      specs,
      bindings: goBinding,
      transportExecutor: transport,
      enableFieldLevelCompare: true,
      legacyExpectedResponses: { go: { approverId: 'alice' } },
    };
    const testCases = generateCases(MODEL, { criterion: 'state' });
    ctx.testCases = testCases;
    const report = await verify(MODEL, ctx);
    const flat = report.authoritative.caseResults.flatMap((c) => c.deviations ?? []);
    expect(flat.filter((d) => d.kind === 'field_mismatch').length).toBe(0);
  });
});
