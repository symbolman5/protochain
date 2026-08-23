/**
 * E2.1 契约层 contracts[] 解析 — parser 单测
 *
 * 设计依据：IMPLEMENTATION-PLAN.md §E2.1
 *
 * 覆盖：
 * - 合法 YAML 解析出 contracts[] 字段（requestSchema / responseSchema + pre/post/sideEffects）
 * - 非法 schema / 非法形态抛 ParseError
 * - 无 contracts 段时行为不变（兼容老协议）
 * - contracts[].interface 必填
 */

import { parseProtocolContent, ParseError } from '../../src/parser/index.js';

const BASE_FRONT_MATTER =
  '---\n' +
  'name: 测试协议\n' +
  'version: 1.0.0\n' +
  'purpose: 测试\n' +
  'roles:\n' +
  '  - id: admin\n' +
  '    name: 管理员\n' +
  '  - id: system\n' +
  '    name: 系统\n' +
  '---\n';

const BASE_DERIVABLE =
  '\n' +
  '# 状态空间\n' +
  '\n' +
  '| ID | 名称 | 类型 |\n' +
  '|---|---|---|\n' +
  '| S1 | 初始 | initial |\n' +
  '| S2 | 终态 | terminal |\n' +
  '\n' +
  '# 转移规则\n' +
  '\n' +
  '| ID | 名称 | from | to | action | trigger |\n' +
  '|---|---|---|---|---|---|\n' +
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

describe('parser - E2.1 contracts[] 段解析', () => {
  describe('合法契约字段', () => {
    test('contracts[] 含 requestSchema + responseSchema', () => {
      const content = make(
        'parties:\n' +
          '  - admin\n' +
          '  - system\n' +
          'contracts:\n' +
          '  - interface: register\n' +
          '    requestSchema:\n' +
          '      type: object\n' +
          '      properties:\n' +
          '        currentState:\n' +
          '          type: string\n' +
          '        name:\n' +
          '          type: string\n' +
          '        hostDomain:\n' +
          '          type: string\n' +
          '      required:\n' +
          '        - currentState\n' +
          '        - name\n' +
          '        - hostDomain\n' +
          '    responseSchema:\n' +
          '      type: object\n' +
          '      properties:\n' +
          '        serverId:\n' +
          '          type: string\n' +
          '        serverSecret:\n' +
          '          type: string\n' +
          '      required:\n' +
          '        - serverId\n' +
          '        - serverSecret\n'
      );
      const model = parseProtocolContent(content, 'test.md');
      expect(model.contractInput).toBeDefined();
      expect(model.contractInput?.contracts).toHaveLength(1);
      const c = model.contractInput!.contracts![0];
      expect(c.interface).toBe('register');
      expect(c.requestSchema?.type).toBe('object');
      expect(c.requestSchema?.properties?.name?.type).toBe('string');
      expect(c.requestSchema?.required).toEqual(
        expect.arrayContaining(['currentState', 'name', 'hostDomain'])
      );
      expect(c.responseSchema?.properties?.serverId?.type).toBe('string');
    });

    test('preconditions/postconditions/sideEffects 字符串数组归一', () => {
      const content = make(
        'parties:\n' +
          '  - admin\n' +
          '  - system\n' +
          'contracts:\n' +
          '  - interface: register\n' +
          '    preconditions:\n' +
          '      - "name 非空"\n' +
          '      - "域名合法"\n' +
          '    postconditions:\n' +
          '      - "创建节点记录"\n' +
          '    sideEffects:\n' +
          '      - "签发 server_secret"\n'
      );
      const model = parseProtocolContent(content);
      const c = model.contractInput!.contracts![0];
      expect(c.preconditions).toHaveLength(2);
      expect(c.preconditions![0]).toEqual({
        kind: 'description-only',
        description: 'name 非空',
      });
      expect(c.postconditions![0].description).toBe('创建节点记录');
      expect(c.sideEffects![0].description).toBe('签发 server_secret');
    });

    test('preconditions 结构化表达式（json-schema）', () => {
      const content = make(
        'parties:\n' +
          '  - admin\n' +
          'contracts:\n' +
          '  - interface: register\n' +
          '    preconditions:\n' +
          '      - kind: json-schema\n' +
          '        description: name 非空\n' +
          '        schema:\n' +
          '          type: object\n' +
          '          properties:\n' +
          '            name:\n' +
          '              type: string\n' +
          '              description: 节点名字\n' +
          '          required:\n' +
          '            - name\n'
      );
      const model = parseProtocolContent(content);
      const c = model.contractInput!.contracts![0];
      expect(c.preconditions![0].kind).toBe('json-schema');
      expect(c.preconditions![0].schema?.properties?.name?.description).toBe('节点名字');
      expect(c.preconditions![0].schema?.required).toEqual(['name']);
    });

    test('sourceId 显式声明', () => {
      const content = make(
        'parties:\n' +
          '  - admin\n' +
          'contracts:\n' +
          '  - interface: register\n' +
          '    sourceId: T1\n' +
          '    requestSchema:\n' +
          '      type: object\n'
      );
      const model = parseProtocolContent(content);
      const c = model.contractInput!.contracts![0];
      expect(c.interface).toBe('register');
      expect(c.sourceId).toBe('T1');
    });
  });

  describe('非法形态', () => {
    test('contract 缺 interface → 抛 ParseError', () => {
      const content = make(
        'parties:\n' +
          '  - admin\n' +
          'contracts:\n' +
          '  - requestSchema:\n' +
          '      type: object\n'
      );
      expect(() => parseProtocolContent(content)).toThrow(ParseError);
    });

    test('requestSchema.type 非法 → 抛 ParseError', () => {
      const content = make(
        'parties:\n' +
          '  - admin\n' +
          'contracts:\n' +
          '  - interface: register\n' +
          '    requestSchema:\n' +
          '      type: bogus\n'
      );
      expect(() => parseProtocolContent(content)).toThrow(ParseError);
    });

    test('required 不是数组 → 抛 ParseError', () => {
      const content = make(
        'parties:\n' +
          '  - admin\n' +
          'contracts:\n' +
          '  - interface: register\n' +
          '    requestSchema:\n' +
          '      type: object\n' +
          '      required: name\n'
      );
      expect(() => parseProtocolContent(content)).toThrow(ParseError);
    });

    test('properties 不是对象 → 抛 ParseError', () => {
      const content = make(
        'parties:\n' +
          '  - admin\n' +
          'contracts:\n' +
          '  - interface: register\n' +
          '    requestSchema:\n' +
          '      type: object\n' +
          '      properties:\n' +
          '        - name\n'
      );
      expect(() => parseProtocolContent(content)).toThrow(ParseError);
    });

    test('preconditions 形态非法（数字） → 抛 ParseError', () => {
      const content = make(
        'parties:\n' +
          '  - admin\n' +
          'contracts:\n' +
          '  - interface: register\n' +
          '    preconditions:\n' +
          '      - 42\n'
      );
      expect(() => parseProtocolContent(content)).toThrow(ParseError);
    });
  });

  describe('兼容老协议（无 contracts 段）', () => {
    test('只声明 parties + expectedInformationFields → contracts 为 undefined', () => {
      const content = make(
        'parties:\n' +
          '  - admin\n' +
          '  - system\n' +
          'expectedInformationFields:\n' +
          '  - server_id\n' +
          '  - secret\n'
      );
      const model = parseProtocolContent(content);
      expect(model.contractInput?.parties).toEqual(['admin', 'system']);
      expect(model.contractInput?.expectedInformationFields).toContain('server_id');
      expect(model.contractInput?.contracts).toBeUndefined();
    });

    test('无契约层段 → contractInput 为 undefined', () => {
      const content = BASE_FRONT_MATTER + BASE_DERIVABLE;
      const model = parseProtocolContent(content);
      expect(model.contractInput).toBeUndefined();
    });
  });
});
