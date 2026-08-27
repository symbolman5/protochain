/**
 * G5 TI2 · 契约层分型声明（C-4）— parser 识别 + specs 投影单测
 *
 * 设计依据：plans/10-interface-view-proposal.md §4 变更表 C-4（契约层可选扩展 +
 *   specs 投影字段，specs/WebDataJson 1.0 schemaVersion 不变）、§3-2（分型三值与
 *   "契约声明为权威"口径）；plans/11-execution-G5-interface-view.md §2 TI2。
 *
 * 覆盖：
 * - 带声明 fixture：`interfaceType:` 解析进 ContractEntry.interfaceType，
 *   并投影到 InterfaceSpec.declaredInterfaceType（状态机接口 + 承载接口两条路径）
 * - 不带声明 fixture：缺省 undefined、不报错（老协议零回归，与 E2.1 contracts[] 同构）
 * - specs envelope schemaVersion 恒为 "1.0"（C-4：不变）
 * - 非三值取值 → ParseError（拒绝静默）
 */

import { parseProtocolContent, ParseError } from '../../src/parser/index.js';
import { specify, specsFromEnvelope } from '../../src/specifier/index.js';

const BASE_FRONT_MATTER =
  '---\n' +
  'name: G5 TI2 分型声明测试\n' +
  'version: 1.0.0\n' +
  'purpose: 契约层 interfaceType 声明解析与投影\n' +
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

/** 带声明 fixture：register 命中 T1.action（状态机接口）；queryOrder 无对应 transition（承载接口） */
const MD_WITH_DECLARATION = make(
  'parties:\n  - admin\n' +
    'contracts:\n' +
    '  - interface: register\n' +
    '    interfaceType: state_machine\n' +
    '    requestSchema:\n      type: object\n      properties:\n        name: { type: string }\n      required: [name]\n' +
    '  - interface: queryOrder\n' +
    '    interfaceType: contract_carrier\n' +
    '    requestSchema:\n      type: object\n      properties:\n        orderId: { type: string }\n      required: [orderId]\n'
);

/** 不带声明 fixture：与上者逐字相同、仅去掉 interfaceType 键（老协议缺省） */
const MD_WITHOUT_DECLARATION = make(
  'parties:\n  - admin\n' +
    'contracts:\n' +
    '  - interface: register\n' +
    '    requestSchema:\n      type: object\n      properties:\n        name: { type: string }\n      required: [name]\n' +
    '  - interface: queryOrder\n' +
    '    requestSchema:\n      type: object\n      properties:\n        orderId: { type: string }\n      required: [orderId]\n'
);

describe('G5 TI2 - 契约层分型声明（C-4）', () => {
  test('带声明：interfaceType 解析进 ContractEntry.interfaceType', () => {
    const model = parseProtocolContent(MD_WITH_DECLARATION, 'test.md');
    const contracts = model.contractInput?.contracts;
    expect(contracts).toHaveLength(2);
    expect(contracts?.[0].interface).toBe('register');
    expect(contracts?.[0].interfaceType).toBe('state_machine');
    expect(contracts?.[1].interface).toBe('queryOrder');
    expect(contracts?.[1].interfaceType).toBe('contract_carrier');
  });

  test('带声明：投影到 InterfaceSpec.declaredInterfaceType（状态机接口 + 承载接口）', () => {
    const model = parseProtocolContent(MD_WITH_DECLARATION, 'test.md');
    const specs = specsFromEnvelope(specify(model));

    const sysSpec = specs.find((s) => s.id === 'IF_SYS_T1');
    expect(sysSpec).toBeDefined();
    expect(sysSpec?.contractSource).toBe('register');
    expect(sysSpec?.declaredInterfaceType).toBe('state_machine');

    const carrierSpec = specs.find((s) => s.id === 'IF_CTR_queryOrder');
    expect(carrierSpec).toBeDefined();
    expect(carrierSpec?.isContractCarrier).toBe(true);
    expect(carrierSpec?.declaredInterfaceType).toBe('contract_carrier');
  });

  test('不带声明：ContractEntry.interfaceType 与 declaredInterfaceType 均为 undefined、不报错', () => {
    const model = parseProtocolContent(MD_WITHOUT_DECLARATION, 'test.md');
    const contracts = model.contractInput?.contracts;
    expect(contracts).toHaveLength(2);
    expect(contracts?.[0].interfaceType).toBeUndefined();
    expect(contracts?.[1].interfaceType).toBeUndefined();

    const specs = specsFromEnvelope(specify(model));
    expect(specs.find((s) => s.id === 'IF_SYS_T1')?.declaredInterfaceType).toBeUndefined();
    expect(
      specs.find((s) => s.id === 'IF_CTR_queryOrder')?.declaredInterfaceType
    ).toBeUndefined();
    // 观测接口（无契约）同样缺省
    expect(specs.find((s) => s.kind === 'observation')?.declaredInterfaceType).toBeUndefined();
  });

  test('无契约段的老模型：解析与投影均不受影响（零回归）', () => {
    const model = parseProtocolContent(BASE_FRONT_MATTER + BASE_DERIVABLE, 'test.md');
    expect(model.contractInput).toBeUndefined();
    const specs = specsFromEnvelope(specify(model));
    expect(specs.length).toBeGreaterThan(0);
    expect(specs.every((s) => s.declaredInterfaceType === undefined)).toBe(true);
  });

  test('specs envelope schemaVersion 恒为 "1.0"（C-4：不变）', () => {
    const withDecl = specify(parseProtocolContent(MD_WITH_DECLARATION, 'test.md'));
    const withoutDecl = specify(parseProtocolContent(MD_WITHOUT_DECLARATION, 'test.md'));
    expect(withDecl.schemaVersion).toBe('1.0');
    expect(withoutDecl.schemaVersion).toBe('1.0');
  });

  test('反向：interfaceType 非三值 → ParseError（拒绝静默）', () => {
    const md = make(
      'contracts:\n  - interface: register\n    interfaceType: query\n'
    );
    expect(() => parseProtocolContent(md, 'test.md')).toThrow(ParseError);
  });

  test('正向：observation 声明亦被接受（三值齐备）', () => {
    const md = make(
      'contracts:\n  - interface: register\n    interfaceType: observation\n'
    );
    const model = parseProtocolContent(md, 'test.md');
    expect(model.contractInput?.contracts?.[0].interfaceType).toBe('observation');
  });
});
