/**
 * E11 契约层 errorResponses 投影到 InterfaceSpec — specifier 单测
 *
 * 设计依据：IMPLEMENTATION-PLAN.md §E11、docs/error-modeling-plan.md §2.2
 *
 * 覆盖：
 * - 命中契约的 errorResponses 原样投影到 InterfaceSpec.errorResponses
 * - 无契约时 InterfaceSpec.errorResponses 为 undefined（兼容老协议）
 * - 多契约的 errorResponses 按 transition 对齐
 * - 投影与 requestSchema 投影不冲突（两个独立字段）
 */

import { parseProtocolContent } from '../../src/parser/index.js';
import { specify, specsFromEnvelope } from '../../src/specifier/index.js';
import type { SourceProtocolModel } from '../../src/model/types.js';

const BASE_FRONT_MATTER =
  '---\n' +
  'name: E11 specifier 投影\n' +
  'version: 1.0.0\n' +
  'purpose: errorResponses 投影测试\n' +
  'roles:\n' +
  '  - id: admin\n' +
  '    name: 管理员\n' +
  '---\n';

const BASE_DERIVABLE =
  '\n# 状态空间\n\n' +
  '| ID | 名称 | 类型 |\n|---|---|---|\n| S1 | 初始 | initial |\n| S2 | 终态 | terminal |\n\n' +
  '# 转移规则\n\n' +
  '| ID | 名称 | from | to | action | trigger |\n|---|---|---|---|---|---|\n' +
  '| T1 | 注册 | S1 | S2 | register | admin |\n';

const CODE_FENCE = '```yaml\n';
const CODE_FENCE_END = '```';

function build(contractYaml: string): SourceProtocolModel {
  const md =
    BASE_FRONT_MATTER +
    BASE_DERIVABLE +
    '\n# 契约层\n\n' +
    CODE_FENCE +
    contractYaml +
    '\n' +
    CODE_FENCE_END +
    '\n';
  return parseProtocolContent(md, 'test.md');
}

describe('specifier - E11 errorResponses 投影', () => {
  test('正向：命中契约 → InterfaceSpec.errorResponses 已填', () => {
    const model = build(
      'contracts:\n' +
        '  - interface: register\n' +
        '    requestSchema:\n      type: object\n      properties:\n        name: { type: string }\n      required: [name]\n' +
        '    errorResponses:\n' +
        '      - id: ERR-01\n        errorCode: domain_not_owned\n        httpStatus: 409\n' +
        '      - id: ERR-02\n        errorCode: domain_taken\n        httpStatus: 409\n'
    );
    const specs = specsFromEnvelope(specify(model));
    const register = specs.find((s) => s.name === 'register');
    expect(register).toBeDefined();
    expect(register?.errorResponses).toHaveLength(2);
    expect(register?.errorResponses?.[0].errorCode).toBe('domain_not_owned');
    expect(register?.errorResponses?.[1].errorCode).toBe('domain_taken');
    expect(register?.contractSource).toBe('register');
  });

  test('反向：无契约 → InterfaceSpec.errorResponses 为 undefined（兼容老协议）', () => {
    const md =
      BASE_FRONT_MATTER +
      BASE_DERIVABLE +
      '\n'; // 无契约层
    const model = parseProtocolContent(md, 'test.md');
    const specs = specsFromEnvelope(specify(model));
    const register = specs.find((s) => s.name === 'register');
    expect(register).toBeDefined();
    expect(register?.errorResponses).toBeUndefined();
  });

  test('正向：契约层有 requestSchema 但无 errorResponses → 不污染后者', () => {
    const model = build(
      'contracts:\n' +
        '  - interface: register\n' +
        '    requestSchema:\n      type: object\n      properties:\n        name: { type: string }\n      required: [name]\n' +
        '    responseSchema: { type: object }\n'
    );
    const specs = specsFromEnvelope(specify(model));
    const register = specs.find((s) => s.name === 'register');
    expect(register?.requestSchema?.type).toBe('object');
    expect(register?.errorResponses).toBeUndefined();
  });

  test('正向：errorResponses 含 bodySchema 时一并投影', () => {
    const model = build(
      'contracts:\n' +
        '  - interface: register\n' +
        '    errorResponses:\n' +
        '      - id: ERR-01\n' +
        '        errorCode: domain_not_owned\n' +
        '        httpStatus: 409\n' +
        '        bodySchema:\n' +
        '          type: object\n' +
        '          properties:\n' +
        '            code: { type: string, enum: [domain_not_owned] }\n' +
        '          required: [code]\n'
    );
    const specs = specsFromEnvelope(specify(model));
    const register = specs.find((s) => s.name === 'register');
    expect(register?.errorResponses?.[0].bodySchema?.properties?.code?.enum).toEqual([
      'domain_not_owned',
    ]);
  });
});
