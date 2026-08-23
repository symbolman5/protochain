/**
 * E2.1 字段级偏差对比接通 — field-compare 单测
 *
 * 设计依据：IMPLEMENTATION-PLAN.md §E2.1
 *
 * 覆盖：
 * - legacyExpected 是 JSON Schema 类型字符串 → 按类型比对（不是字符串字面量比对）
 * - 字段类型不符 → 产出「字段 X：legacy=<type>, impl=<type>」
 * - 字段缺失 → 产出「字段 X：legacy=<type>, impl=missing」
 * - 普通值（不是类型名）→ 走原 deepEqual 路径
 */

import { compareFields } from '../../src/verifier/field-compare.js';
import type { InterfaceSpec } from '../../src/model/types.js';

const baseSpec: InterfaceSpec = {
  id: 'IF_SYS_T1',
  kind: 'system',
  sourceId: 'register',
  name: 'register',
  inputs: [],
  outputs: [],
  requestSchema: {
    type: 'object',
    properties: {
      currentState: { type: 'string', enum: ['S1'] },
    },
    required: ['currentState'],
  },
  responseSchema: {
    type: 'object',
    properties: {
      nextState: { type: 'string', enum: ['S2'] },
      serverId: { type: 'string' },
      serverSecret: { type: 'string' },
      port: { type: 'integer' },
      isAdmin: { type: 'boolean' },
    },
    required: ['nextState', 'serverId', 'serverSecret'],
  },
};

describe('field-compare - E2.1 类型 sentinel 比对', () => {
  test('legacyExpected=type-name: 字段类型不符 → field_mismatch', () => {
    const devs = compareFields({
      spec: baseSpec,
      action: 'register',
      state: 'S1',
      implResponse: {
        nextState: 'S2',
        serverId: 123, // 应该是 string
        serverSecret: 'secret',
      },
      legacyExpected: {
        serverId: 'string',
        serverSecret: 'string',
      },
    });
    const portDev = devs.find((d) => d.field === 'response.serverId');
    expect(portDev).toBeDefined();
    expect(portDev!.kind).toBe('field_mismatch');
    expect(portDev!.legacy).toBe('string');
    expect(portDev!.impl).toBe('number');
    // serverSecret 匹配 → 不产出偏差
    const secretDev = devs.find((d) => d.field === 'response.serverSecret');
    expect(secretDev).toBeUndefined();
  });

  test('legacyExpected=type-name: 字段缺失 → legacy=<type>, impl=missing', () => {
    const devs = compareFields({
      spec: baseSpec,
      action: 'register',
      state: 'S1',
      implResponse: {
        nextState: 'S2',
        // serverId 缺失
        serverSecret: 'secret',
      },
      legacyExpected: {
        serverId: 'string',
        serverSecret: 'string',
      },
    });
    const dev = devs.find((d) => d.field === 'response.serverId');
    expect(dev).toBeDefined();
    expect(dev!.kind).toBe('field_mismatch');
    expect(dev!.legacy).toBe('string');
    expect(dev!.impl).toBe('missing');
  });

  test('legacyExpected=普通值（非类型名）→ 走原 deepEqual 路径', () => {
    const devs = compareFields({
      spec: baseSpec,
      action: 'register',
      state: 'S1',
      implResponse: {
        nextState: 'S2',
        serverId: 'abc',
        serverSecret: 'secret',
      },
      legacyExpected: {
        // 非 JSON Schema 类型名 → 走 deepEqual
        serverId: 'xyz',
        serverSecret: 'secret',
      },
    });
    const dev = devs.find((d) => d.field === 'response.serverId');
    expect(dev).toBeDefined();
    expect(dev!.kind).toBe('field_mismatch');
    expect(dev!.legacy).toBe('xyz');
    expect(dev!.impl).toBe('abc');
  });

  test('所有类型正确 → 不产出偏差', () => {
    const devs = compareFields({
      spec: baseSpec,
      action: 'register',
      state: 'S1',
      implResponse: {
        nextState: 'S2',
        serverId: 'srv-1',
        serverSecret: 'shh',
        port: 8080,
        isAdmin: true,
      },
      legacyExpected: {
        serverId: 'string',
        serverSecret: 'string',
        port: 'integer',
        isAdmin: 'boolean',
      },
    });
    // 类型全对 → 仅 nextState 不在 legacyExpected 中，不会被比对
    expect(devs.filter((d) => d.field?.startsWith('response.'))).toHaveLength(0);
  });

  test('legacyExpected 未提供 → 类型不符仍报（schema.type 是协议层）', () => {
    // schema 来自 spec 本身（responseSchema），无需 legacyExpected
    // 类型不符由 schema 强制约束 → 仍产出 field_mismatch
    const devs = compareFields({
      spec: baseSpec,
      action: 'register',
      state: 'S1',
      implResponse: {
        nextState: 'S2',
        serverId: 123, // 类型不符（schema 要求 string）
        serverSecret: 'shh',
      },
      // 不传 legacyExpected
    });
    // serverId 类型不符 → 产出 field_mismatch（schema.type 驱动）
    const portDev = devs.find((d) => d.field === 'response.serverId');
    expect(portDev).toBeDefined();
    expect(portDev!.kind).toBe('field_mismatch');
    expect(portDev!.legacy).toBe('string');
    expect(portDev!.impl).toBe('number');
  });
});
