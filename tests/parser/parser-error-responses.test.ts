/**
 * E11 契约层 contracts[].errorResponses — parser 单测
 *
 * 设计依据：IMPLEMENTATION-PLAN.md §E11、docs/error-modeling-plan.md §2.2
 *
 * 覆盖：
 * - contracts[].errorResponses 解析（含 bodySchema 用 parseJsonSchemaValue）
 * - 非法形态抛 ParseError
 * - 无 errorResponses 段 → 不破坏（兼容老协议）
 */

import { parseProtocolContent, ParseError } from '../../src/parser/index.js';

const BASE_FRONT_MATTER =
  '---\n' +
  'name: E11 errorResponses 测试\n' +
  'version: 1.0.0\n' +
  'purpose: contracts[] errorResponses 解析\n' +
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

function make(contractYaml: string): string {
  return (
    BASE_FRONT_MATTER +
    BASE_DERIVABLE +
    '\n# 契约层\n\n' +
    CODE_FENCE +
    contractYaml +
    '\n' +
    CODE_FENCE_END +
    '\n'
  );
}

describe('parser - E11 contracts[].errorResponses', () => {
  test('正向：errorResponses 含 errorCode / httpStatus / bodySchema', () => {
    const md = make(
      'parties:\n  - admin\n' +
        'contracts:\n' +
        '  - interface: register\n' +
        '    requestSchema:\n      type: object\n      properties:\n        name: { type: string }\n      required: [name]\n' +
        '    errorResponses:\n' +
        '      - id: ERR-01\n' +
        '        errorCode: domain_not_owned\n' +
        '        httpStatus: 409\n' +
        '        bodySchema:\n' +
        '          type: object\n' +
        '          properties:\n' +
        '            code: { type: string, enum: [domain_not_owned] }\n' +
        '            message: { type: string }\n' +
        '          required: [code, message]\n'
    );
    const model = parseProtocolContent(md, 'test.md');
    const c = model.contractInput?.contracts?.[0];
    expect(c?.errorResponses).toHaveLength(1);
    expect(c?.errorResponses?.[0].id).toBe('ERR-01');
    expect(c?.errorResponses?.[0].errorCode).toBe('domain_not_owned');
    expect(c?.errorResponses?.[0].httpStatus).toBe(409);
    expect(c?.errorResponses?.[0].bodySchema?.type).toBe('object');
    expect(c?.errorResponses?.[0].bodySchema?.properties?.code?.enum).toEqual([
      'domain_not_owned',
    ]);
  });

  test('正向：多条 errorResponses（ERR-01 / ERR-02 同一接口）', () => {
    const md = make(
      'contracts:\n' +
        '  - interface: create_mapping\n' +
        '    errorResponses:\n' +
        '      - id: ERR-01\n        errorCode: domain_not_owned\n        httpStatus: 409\n' +
        '      - id: ERR-02\n        errorCode: domain_taken\n        httpStatus: 409\n'
    );
    const model = parseProtocolContent(md, 'test.md');
    const c = model.contractInput?.contracts?.[0];
    expect(c?.errorResponses).toHaveLength(2);
    expect(c?.errorResponses?.map((e) => e.errorCode)).toEqual([
      'domain_not_owned',
      'domain_taken',
    ]);
  });

  test('反向：无 errorResponses 字段 → 兼容（数组保持 undefined）', () => {
    const md = make(
      'contracts:\n  - interface: register\n    requestSchema:\n      type: object\n'
    );
    const model = parseProtocolContent(md, 'test.md');
    const c = model.contractInput?.contracts?.[0];
    expect(c?.errorResponses).toBeUndefined();
  });

  test('反向：错误码缺 id → ParseError', () => {
    const md = make(
      'contracts:\n' +
        '  - interface: register\n' +
        '    errorResponses:\n' +
        '      - errorCode: domain_not_owned\n        httpStatus: 409\n'
    );
    expect(() => parseProtocolContent(md, 'test.md')).toThrow(ParseError);
  });

  test('反向：错误码缺 errorCode → ParseError', () => {
    const md = make(
      'contracts:\n' +
        '  - interface: register\n' +
        '    errorResponses:\n' +
        '      - id: ERR-01\n        httpStatus: 409\n'
    );
    expect(() => parseProtocolContent(md, 'test.md')).toThrow(ParseError);
  });

  test('反向：错误码缺 httpStatus → ParseError', () => {
    const md = make(
      'contracts:\n' +
        '  - interface: register\n' +
        '    errorResponses:\n' +
        '      - id: ERR-01\n        errorCode: domain_not_owned\n'
    );
    expect(() => parseProtocolContent(md, 'test.md')).toThrow(ParseError);
  });

  test('反向：错误码 httpStatus 非整数 → ParseError', () => {
    const md = make(
      'contracts:\n' +
        '  - interface: register\n' +
        '    errorResponses:\n' +
        '      - id: ERR-01\n        errorCode: bad_code\n        httpStatus: "409"\n'
    );
    expect(() => parseProtocolContent(md, 'test.md')).toThrow(ParseError);
  });

  test('反向：错误体 bodySchema 非对象 → ParseError', () => {
    const md = make(
      'contracts:\n' +
        '  - interface: register\n' +
        '    errorResponses:\n' +
        '      - id: ERR-01\n        errorCode: bad_code\n        httpStatus: 409\n' +
        '        bodySchema: "not an object"\n'
    );
    expect(() => parseProtocolContent(md, 'test.md')).toThrow(ParseError);
  });
});
