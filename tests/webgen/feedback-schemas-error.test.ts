/**
 * E11 expectedError 字段 — feedback schemas 单测
 *
 * 设计依据：IMPLEMENTATION-PLAN.md §E11、docs/error-modeling-plan.md §3.4 / §4.8
 *
 * 覆盖：
 * - scenarios 含 expectedError → ajv 校验通过
 * - expectedError.errorCode 违反 snake_case → 校验失败
 * - expectedError.httpStatus 越界（<100 或 >599） → 校验失败
 * - expectedError 缺 errorCode → 校验失败
 * - 无 expectedError → 校验通过（兼容老协议）
 */

import {
  validateScenario,
  SCENARIO_SCHEMA,
} from '../../src/webgen/feedback/schemas.js';

describe('feedback schemas - E11 expectedError', () => {
  test('正向：合法 expectedError → 校验通过', () => {
    const ok = validateScenario({
      id: 'SC-DOMAIN',
      expectedActions: ['register'],
      expectedError: { errorCode: 'domain_not_owned', httpStatus: 409 },
    });
    expect(ok.ok).toBe(true);
  });

  test('反向：errorCode 违反 snake_case → 校验失败', () => {
    const r = validateScenario({
      id: 'SC-X',
      expectedActions: ['register'],
      expectedError: { errorCode: 'DomainNotOwned', httpStatus: 409 },
    });
    expect(r.ok).toBe(false);
  });

  test('反向：errorCode 含连字符 → 校验失败', () => {
    const r = validateScenario({
      id: 'SC-X',
      expectedActions: ['register'],
      expectedError: { errorCode: 'bad-code', httpStatus: 409 },
    });
    expect(r.ok).toBe(false);
  });

  test('反向：httpStatus 越界（10） → 校验失败', () => {
    const r = validateScenario({
      id: 'SC-X',
      expectedActions: ['register'],
      expectedError: { errorCode: 'good_code', httpStatus: 10 },
    });
    expect(r.ok).toBe(false);
  });

  test('反向：httpStatus 越界（700） → 校验失败', () => {
    const r = validateScenario({
      id: 'SC-X',
      expectedActions: ['register'],
      expectedError: { errorCode: 'good_code', httpStatus: 700 },
    });
    expect(r.ok).toBe(false);
  });

  test('反向：expectedError 缺 errorCode → 校验失败', () => {
    const r = validateScenario({
      id: 'SC-X',
      expectedActions: ['register'],
      expectedError: { httpStatus: 409 },
    });
    expect(r.ok).toBe(false);
  });

  test('兼容：无 expectedError → 校验通过', () => {
    const r = validateScenario({
      id: 'SC-NORMAL',
      expectedActions: ['register'],
    });
    expect(r.ok).toBe(true);
  });

  test('正向：errorCode snake_case（含数字）通过', () => {
    const r = validateScenario({
      id: 'SC-X',
      expectedActions: ['register'],
      expectedError: { errorCode: 'http_500_internal', httpStatus: 500 },
    });
    // 5xx 也允许（schema 仅校验整数范围 100-599）
    expect(r.ok).toBe(true);
  });

  test('schema 元数据：expectedError properties 严格子集（additionalProperties=false）', () => {
    const props = (SCENARIO_SCHEMA.properties as Record<string, { additionalProperties?: boolean }>)
      .expectedError;
    expect(props?.additionalProperties).toBe(false);
  });
});
