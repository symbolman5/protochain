/**
 * schemas 单测 —— E7-P1
 *
 * 覆盖：
 *   - SCENARIO_SCHEMA：正向（合法 scenario 通过），反向（缺 id / 缺 expectedActions /
 *     expectedActions 为空数组 / id 不以 SC- 开头）
 *   - BINDING_FILE_SCHEMA：正向（合法 bindings）、反向（缺 roles / 缺 interfaces /
 *     action 为空 / interface items 缺 roleId 等）
 *   - formatAjvErrors 错误格式化
 */

import {
  validateScenario,
  validateBindingFile,
  formatAjvErrors,
  buildScenarioAjv,
  buildBindingAjv,
} from '../../src/webgen/feedback/schemas.js';

describe('feedback/schemas: SCENARIO_SCHEMA', () => {
  test('合法 scenario 通过', () => {
    const v = validateScenario({
      id: 'SC-P1-01',
      expectedActions: ['expire'],
      params: { id: 10001 },
    });
    expect(v.ok).toBe(true);
  });
  test('包含 setup 数组合法', () => {
    const v = validateScenario({
      id: 'SC-P1-02',
      expectedActions: ['reset'],
      setup: [{ action: 'reset' }, { action: 'noop', params: { x: 1 } }],
    });
    expect(v.ok).toBe(true);
  });
  test('缺 id：拒绝', () => {
    const v = validateScenario({ expectedActions: ['expire'] });
    expect(v.ok).toBe(false);
  });
  test('id 不以 SC- 开头：拒绝', () => {
    const v = validateScenario({ id: 'BAD-1', expectedActions: ['expire'] });
    expect(v.ok).toBe(false);
  });
  test('缺 expectedActions：拒绝', () => {
    const v = validateScenario({ id: 'SC-X' });
    expect(v.ok).toBe(false);
  });
  test('expectedActions 为空数组：拒绝', () => {
    const v = validateScenario({ id: 'SC-X', expectedActions: [] });
    expect(v.ok).toBe(false);
  });
  test('expectedActions 含非字符串项：拒绝', () => {
    const v = validateScenario({ id: 'SC-X', expectedActions: [123] });
    expect(v.ok).toBe(false);
  });
  test('setup 缺 action：拒绝', () => {
    const v = validateScenario({
      id: 'SC-X',
      expectedActions: ['x'],
      setup: [{ params: {} }],
    });
    expect(v.ok).toBe(false);
  });
});

describe('feedback/schemas: BINDING_FILE_SCHEMA', () => {
  test('合法 bindings 通过', () => {
    const v = validateBindingFile({
      roles: [{ roleId: 'R-Op' }],
      interfaces: [{ action: 'transfer', transport: { type: 'http', method: 'POST', path: '/v1/transfer' } }],
      defaultEnv: 'dev',
      environments: { dev: { roles: { 'R-Op': { baseUrl: 'http://127.0.0.1:8787' } } } },
    });
    expect(v.ok).toBe(true);
  });
  test('缺 roles：拒绝', () => {
    const v = validateBindingFile({ interfaces: [{ action: 'x' }] });
    expect(v.ok).toBe(false);
  });
  test('缺 interfaces：拒绝', () => {
    const v = validateBindingFile({ roles: [{ roleId: 'R-Op' }] });
    expect(v.ok).toBe(false);
  });
  test('interface 缺 action：拒绝', () => {
    const v = validateBindingFile({ roles: [{ roleId: 'R-Op' }], interfaces: [{ protocol: 'P1' }] });
    expect(v.ok).toBe(false);
  });
  test('role 缺 roleId：拒绝', () => {
    const v = validateBindingFile({ roles: [{ auth: 'bearer' }], interfaces: [{ action: 'x' }] });
    expect(v.ok).toBe(false);
  });
  test('多余字段允许（additionalProperties: true）', () => {
    const v = validateBindingFile({
      roles: [{ roleId: 'R-Op', extra: 'ok' }],
      interfaces: [{ action: 'x', transport: { type: 'http', extraField: 'ok' } }],
      // 顶层多余字段
      _customField: 'ok',
    });
    expect(v.ok).toBe(true);
  });
});

describe('feedback/schemas: formatAjvErrors', () => {
  test('空 errs 返回占位', () => {
    expect(formatAjvErrors([])).toBeTruthy();
    expect(formatAjvErrors(null)).toBeTruthy();
    expect(formatAjvErrors(undefined)).toBeTruthy();
  });
  test('错误对象数组格式化为人读', () => {
    const s = formatAjvErrors([
      { instancePath: '/id', message: 'must match pattern "SC-.*"' },
      { instancePath: '/expectedActions', message: 'must NOT have fewer than 1 items' },
    ]);
    expect(s).toContain('id');
    expect(s).toContain('SC-');
    expect(s).toContain('expectedActions');
  });
  test('ajv 编译错误格式化为 schema-level 错误', () => {
    const v = buildScenarioAjv();
    // 强制 ajv 错误：从自身 schema 拿 errors.length
    expect(typeof formatAjvErrors(v.errors)).toBe('string');
  });
  test('不同 schema 的 ajv 实例独立', () => {
    const a = buildScenarioAjv();
    const b = buildBindingAjv();
    expect(a).not.toBe(b);
    // 调用不再报错
    a({ id: 'SC-X', expectedActions: ['x'] });
    b({ roles: [], interfaces: [] });
  });
});
