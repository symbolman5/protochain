/**
 * E2.1 契约层 contracts[] 合并到 spec — specifier 单测
 *
 * 设计依据：IMPLEMENTATION-PLAN.md §E2.1
 *
 * 覆盖：
 * - 契约层有 requestSchema → 覆盖 guard 派生 inputs，schemaKind=structured
 * - 契约层有 responseSchema → 替换 guard 派生 outputs
 * - 契约层缺字段 → 维持现状（兼容老协议）
 * - InterfaceSpec.contractSource 标识契约来源
 */

import { parseProtocolContent } from '../../src/parser/index.js';
import { specify, specsFromEnvelope } from '../../src/specifier/index.js';
import type { SourceProtocolModel } from '../../src/model/types.js';

const BASE_FRONT_MATTER =
  '---\n' +
  'name: 契约消费测试\n' +
  'version: 1.0.0\n' +
  'purpose: 契约层字段消费单测\n' +
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
  '| ID | 名称 | from | to | action | trigger | guard |\n' +
  '|---|---|---|---|---|---|---|\n' +
  '| T1 | 注册 | S1 | S2 | register | admin | name 和 hostDomain 必填 |\n';

const CODE_FENCE = '```yaml\n';
const CODE_FENCE_END = '```';

function build(contractYaml: string): SourceProtocolModel {
  const content =
    BASE_FRONT_MATTER +
    BASE_DERIVABLE +
    '\n# 契约层\n\n' +
    CODE_FENCE +
    contractYaml +
    '\n' +
    CODE_FENCE_END +
    '\n';
  return parseProtocolContent(content, 'test.md');
}

describe('specifier - E2.1 契约层字段合并', () => {
  describe('契约层 requestSchema 消费', () => {
    test('契约 requestSchema 覆盖 guard 派生 inputs → schemaKind=structured', () => {
      const model = build(
        'parties:\n' +
          '  - admin\n' +
          'contracts:\n' +
          '  - interface: register\n' +
          '    requestSchema:\n' +
          '      type: object\n' +
          '      properties:\n' +
          '        name:\n' +
          '          type: string\n' +
          '        hostDomain:\n' +
          '          type: string\n' +
          '      required:\n' +
          '        - name\n' +
          '        - hostDomain\n'
      );
      const specs = specsFromEnvelope(specify(model));
      const reg = specs.find((s) => s.sourceId === 'register');
      expect(reg).toBeDefined();
      expect(reg!.schemaKind).toBe('structured');
      expect(reg!.contractSource).toBe('register');
      // inputs 应包含契约字段 + currentState
      const inputNames = reg!.inputs.map((i) => i.name).sort();
      expect(inputNames).toEqual(expect.arrayContaining(['currentState', 'name', 'hostDomain']));
      expect(reg!.inputs.find((i) => i.name === 'name')?.type).toBe('string');
      expect(reg!.inputs.find((i) => i.name === 'name')?.required).toBe(true);
      // requestSchema.properties 应含契约字段
      expect(reg!.requestSchema?.properties?.name?.type).toBe('string');
      expect(reg!.requestSchema?.properties?.hostDomain?.type).toBe('string');
      expect(reg!.requestSchema?.required).toEqual(
        expect.arrayContaining(['currentState', 'name', 'hostDomain'])
      );
    });

    test('契约 requestSchema → guard params 不再进 requestSchema（契约覆盖）', () => {
      const model = build(
        'parties:\n' +
          '  - admin\n' +
          'contracts:\n' +
          '  - interface: register\n' +
          '    requestSchema:\n' +
          '      type: object\n' +
          '      properties:\n' +
          '        name:\n' +
          '          type: string\n' +
          '      required:\n' +
          '        - name\n'
      );
      const specs = specsFromEnvelope(specify(model));
      const reg = specs.find((s) => s.sourceId === 'register')!;
      // guard="name 和 hostDomain 必填" 含 name；契约层覆盖后不再单独进 requestSchema
      // （契约字段 name 是契约显式声明的，不是 guard 提取）
      expect(reg.requestSchema?.properties?.hostDomain).toBeUndefined();
      // guard 参数也不应作为独立字段产生（契约覆盖路径）
      expect(reg.inputs.filter((i) => i.name === 'hostDomain')).toHaveLength(0);
    });
  });

  describe('契约层 responseSchema 消费', () => {
    test('契约 responseSchema 替换 outputs 字段', () => {
      const model = build(
        'parties:\n' +
          '  - admin\n' +
          'contracts:\n' +
          '  - interface: register\n' +
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
      const specs = specsFromEnvelope(specify(model));
      const reg = specs.find((s) => s.sourceId === 'register')!;
      expect(reg.schemaKind).toBe('structured');
      const outputNames = reg.outputs.map((o) => o.name).sort();
      expect(outputNames).toEqual(
        expect.arrayContaining(['nextState', 'serverId', 'serverSecret'])
      );
      expect(reg.responseSchema?.properties?.serverId?.type).toBe('string');
      expect(reg.responseSchema?.properties?.serverSecret?.type).toBe('string');
      expect(reg.responseSchema?.required).toEqual(
        expect.arrayContaining(['nextState', 'serverId', 'serverSecret'])
      );
    });
  });

  describe('缺字段降级（兼容老协议）', () => {
    test('契约无 requestSchema/responseSchema → 维持 guard 派生（无 contractSource）', () => {
      const model = build(
        'parties:\n' +
          '  - admin\n' +
          'contracts:\n' +
          '  - interface: register\n' +
          '    description: 注册接口（无字段声明）\n'
      );
      const specs = specsFromEnvelope(specify(model));
      const reg = specs.find((s) => s.sourceId === 'register')!;
      // contractSource 仍记录（消费了 contracts 条目），但 schema 走 guard 派生
      expect(reg.contractSource).toBe('register');
      // schemaKind 受 guard 派生影响 → guard="name 和 hostDomain 必填" 是中文标点 → legacy-stub
      // 当前规则：不破坏既有 legacy-stub 判定
      expect(['legacy-stub', 'description-only']).toContain(reg.schemaKind);
    });

    test('无 contracts 段 → 行为不变（兼容老协议）', () => {
      const model = build(
        'parties:\n' +
          '  - admin\n' +
          'expectedInformationFields:\n' +
          '  - server_id\n'
      );
      const specs = specsFromEnvelope(specify(model));
      const reg = specs.find((s) => s.sourceId === 'register')!;
      // contractSource 缺省
      expect(reg.contractSource).toBeUndefined();
      // 现有 schemaKind 路径不变（与改造前一致）
      expect(reg.schemaKind).toBeDefined();
    });
  });

  describe('sourceId 显式对齐', () => {
    test('sourceId=T1 与 transition.id=T1 对齐', () => {
      const model = build(
        'parties:\n' +
          '  - admin\n' +
          'contracts:\n' +
          '  - interface: register\n' +
          '    sourceId: T1\n' +
          '    requestSchema:\n' +
          '      type: object\n' +
          '      properties:\n' +
          '        name:\n' +
          '          type: string\n' +
          '      required:\n' +
          '        - name\n'
      );
      const specs = specsFromEnvelope(specify(model));
      const reg = specs.find((s) => s.sourceId === 'register')!;
      expect(reg.contractSource).toBe('register');
      expect(reg.schemaKind).toBe('structured');
      expect(reg.inputs.find((i) => i.name === 'name')).toBeDefined();
    });
  });
});
