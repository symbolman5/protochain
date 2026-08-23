/**
 * E11 后续问题 5（008-5）契约承载接口（contract-carrier）— specifier 单测
 *
 * 设计依据：工具链修改单 008 §E11 后续问题 5
 *   - 问题：bindings.yaml errorMap 38 码 vs P1-P4 specs 声明的唯一码 16 个；
 *     差 22 个码（如 domain_taken/port_conflict/endpoint_not_found/site_not_found）
 *     未投影进 specs。
 *   - 根因：model.md 契约层已声明这些码，但 specifier 按 transition.id/action
 *     匹配；P3/P4 系统接口仅覆盖 disable/enable/delete 等状态机动作，
 *     契约的 mappingCreate / domainClaim / endpointRegister 等动作无对应 transition。
 *   - 修复：specifier 对"未匹配任何 transition 的契约"派生承载接口 IF_CTR_*
 *     （kind=system, isContractCarrier=true），把契约 errorResponses 投影到 specs。
 *
 * 覆盖：
 * - 契约 interface 与 transition.action 对齐 → 不派生承载接口（既有路径）
 * - 契约 interface 未匹配 → 派生承载接口 IF_CTR_<iface>，errorResponses 投影
 * - 多契约混合（部分匹配 + 部分未匹配）→ 仅未匹配部分派生承载接口
 * - 退化模式 → 承载接口不派生，但 envelope.migrationWarnings 记录缺口
 * - envelope.migrationWarnings 含契约名 + errorResponses 数 + 错误码列表
 */

import { parseProtocolContent } from '../../src/parser/index.js';
import {
  specify,
  specsFromEnvelope,
  SPECS_ENVELOPE_SCHEMA_VERSION,
} from '../../src/specifier/index.js';
import type { SourceProtocolModel } from '../../src/model/types.js';

const BASE_FRONT_MATTER =
  '---\n' +
  'name: E11 后续问题 5 contract-carrier 测试\n' +
  'version: 1.0.0\n' +
  'purpose: 契约承载接口派生测试\n' +
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
  '| T1 | 注册 | S1 | S2 | register | admin |\n' +
  '| T2 | 停用 | S1 | S1 | disable | admin |\n' +
  '\n' +
  '# 异常路径\n\n' +
  '| ID | 名称 | 触发 | 错误码 |\n' +
  '|---|---|---|---|\n' +
  '| EX1 | 已存在 | create | already_exists |\n' +
  '| EX2 | 端口冲突 | create | port_conflict |\n' +
  '| EX3 | 找不到 | find | not_found |\n' +
  '| EX4 | 状态不符 | disable | state_mismatch |\n';

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

describe('specifier - E11 后续问题 5 contract-carrier 派生', () => {
  test('正向：契约 interface 匹配 transition.action → 不派生承载接口', () => {
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
        '        - name\n' +
        '    errorResponses:\n' +
        '      - id: ERR-01\n' +
        '        errorCode: already_exists\n' +
        '        httpStatus: 409\n'
    );
    const envelope = specify(model);
    const specs = specsFromEnvelope(envelope);
    const reg = specs.find((s) => s.sourceId === 'register');
    expect(reg).toBeDefined();
    expect(reg!.isContractCarrier).toBeFalsy();
    expect(reg!.errorResponses?.[0].errorCode).toBe('already_exists');
    // 不应派生 IF_CTR_register
    expect(specs.find((s) => s.id === 'IF_CTR_register')).toBeUndefined();
    // envelope.migrationWarnings 不应记录缺口（无 orphan）
    expect(envelope.migrationWarnings ?? []).toEqual([]);
  });

  test('正向：契约 interface 未匹配任何 transition → 派生承载接口 IF_CTR_<iface>', () => {
    const model = build(
      'parties:\n' +
        '  - admin\n' +
        'contracts:\n' +
        '  - interface: mappingCreate\n' +
        '    requestSchema:\n' +
        '      type: object\n' +
        '      properties:\n' +
        '        protocol:\n' +
        '          type: string\n' +
        '          enum: [http, https, tcp]\n' +
        '        targetHost:\n' +
        '          type: string\n' +
        '        targetPort:\n' +
        '          type: integer\n' +
        '      required:\n' +
        '        - protocol\n' +
        '        - targetHost\n' +
        '        - targetPort\n' +
        '    responseSchema:\n' +
        '      type: object\n' +
        '      properties:\n' +
        '        mappingId:\n' +
        '          type: string\n' +
        '    errorResponses:\n' +
        '      - id: ERR-01\n' +
        '        errorCode: port_conflict\n' +
        '        httpStatus: 409\n' +
        '      - id: ERR-02\n' +
        '        errorCode: domain_taken\n' +
        '        httpStatus: 409\n'
    );
    const envelope = specify(model);
    const specs = specsFromEnvelope(envelope);
    const carrier = specs.find((s) => s.id === 'IF_CTR_mappingCreate');
    expect(carrier).toBeDefined();
    expect(carrier!.kind).toBe('system');
    expect(carrier!.sourceId).toBe('mappingCreate');
    expect(carrier!.name).toBe('mappingCreate');
    expect(carrier!.isContractCarrier).toBe(true);
    expect(carrier!.contractSource).toBe('mappingCreate');
    // 契约 errorResponses 投影
    expect(carrier!.errorResponses).toHaveLength(2);
    expect(carrier!.errorResponses?.[0].errorCode).toBe('port_conflict');
    expect(carrier!.errorResponses?.[1].errorCode).toBe('domain_taken');
    // 契约 requestSchema / responseSchema 投影
    expect(carrier!.requestSchema?.properties?.protocol?.enum).toEqual(['http', 'https', 'tcp']);
    expect(carrier!.responseSchema?.properties?.mappingId?.type).toBe('string');
    // inputs/outputs 由 schema 派生
    expect(carrier!.inputs.map((f) => f.name)).toEqual(
      expect.arrayContaining(['protocol', 'targetHost', 'targetPort'])
    );
    expect(carrier!.outputs.map((f) => f.name)).toEqual(
      expect.arrayContaining(['mappingId'])
    );
    // 不含 currentState（承载接口不参与状态机）
    expect(carrier!.inputs.find((f) => f.name === 'currentState')).toBeUndefined();
    // envelope.migrationWarnings 记录缺口
    expect(envelope.migrationWarnings).toBeDefined();
    const warn = (envelope.migrationWarnings ?? []).join('\n');
    expect(warn).toContain('mappingCreate');
    expect(warn).toContain('IF_CTR_mappingCreate');
    expect(warn).toContain('port_conflict');
    expect(warn).toContain('domain_taken');
  });

  test('多契约混合：部分匹配 + 部分未匹配 → 仅未匹配部分派生承载接口', () => {
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
        '        - name\n' +
        '    errorResponses:\n' +
        '      - id: ERR-01\n' +
        '        errorCode: already_exists\n' +
        '        httpStatus: 409\n' +
        '  - interface: domainClaim\n' +
        '    requestSchema:\n' +
        '      type: object\n' +
        '      properties:\n' +
        '        rootDomain:\n' +
        '          type: string\n' +
        '      required:\n' +
        '        - rootDomain\n' +
        '    errorResponses:\n' +
        '      - id: ERR-01\n' +
        '        errorCode: not_found\n' +
        '        httpStatus: 404\n' +
        '  - interface: endpointRegister\n' +
        '    errorResponses:\n' +
        '      - id: ERR-01\n' +
        '        errorCode: state_mismatch\n' +
        '        httpStatus: 409\n'
    );
    const envelope = specify(model);
    const specs = specsFromEnvelope(envelope);
    // register 命中 → 不派生承载接口
    expect(specs.find((s) => s.id === 'IF_CTR_register')).toBeUndefined();
    // domainClaim 未匹配 → 派生承载接口
    const domainClaimCarrier = specs.find((s) => s.id === 'IF_CTR_domainClaim');
    expect(domainClaimCarrier).toBeDefined();
    expect(domainClaimCarrier!.errorResponses?.[0].errorCode).toBe('not_found');
    // endpointRegister 未匹配 → 派生承载接口
    const epRegCarrier = specs.find((s) => s.id === 'IF_CTR_endpointRegister');
    expect(epRegCarrier).toBeDefined();
    expect(epRegCarrier!.errorResponses?.[0].errorCode).toBe('state_mismatch');
    // migrationWarnings 应记录 2 个 orphan 契约（domainClaim + endpointRegister）
    const warn = (envelope.migrationWarnings ?? []).join('\n');
    expect(warn).toContain('domainClaim');
    expect(warn).toContain('endpointRegister');
    expect(warn).not.toContain('"register"');
  });

  test('退化模式：契约未匹配 → envelope.migrationWarnings 记录缺口但不派生承载接口', () => {
    // 构造退化模式：parser 检测到形式化代码块后走 degraded 分支（带 TLA+ 即可触发）
    const md =
      BASE_FRONT_MATTER +
      '\n' +
      '# 契约层\n\n' +
      CODE_FENCE +
      'parties:\n' +
      '  - admin\n' +
      'contracts:\n' +
      '  - interface: mappingCreate\n' +
      '    errorResponses:\n' +
      '      - id: ERR-01\n' +
      '        errorCode: port_conflict\n' +
      '        httpStatus: 409\n' +
      '\n' +
      CODE_FENCE_END +
      '\n\n' +
      '# 形式化规格\n\n' +
      '```tla\n' +
      '---- MODULE Test ----\n' +
      'Init == TRUE\n' +
      'Next == TRUE\n' +
      '====\n' +
      '```\n';
    const model = parseProtocolContent(md, 'test.md');
    expect(model.derivable.degraded).toBe(true);
    const envelope = specify(model);
    // 退化模式：不派生承载接口
    const specs = specsFromEnvelope(envelope);
    expect(specs.find((s) => s.id === 'IF_CTR_mappingCreate')).toBeUndefined();
    // 但 migrationWarnings 记录缺口
    const warn = (envelope.migrationWarnings ?? []).join('\n');
    expect(warn).toContain('mappingCreate');
    expect(warn).toContain('port_conflict');
    expect(warn).toContain('未派生承载接口');
  });

  test('envelope schemaVersion 不变；migrationWarnings 形态正确', () => {
    const model = build(
      'parties:\n' +
        '  - admin\n' +
        'contracts:\n' +
        '  - interface: orphanApi\n' +
        '    requestSchema: { type: object }\n' +
        '    errorResponses:\n' +
        '      - id: ERR-01\n' +
        '        errorCode: port_conflict\n' +
        '        httpStatus: 409\n'
    );
    const envelope = specify(model);
    expect(envelope.schemaVersion).toBe(SPECS_ENVELOPE_SCHEMA_VERSION);
    expect(envelope.migrationWarnings).toBeDefined();
    const warnings = envelope.migrationWarnings ?? [];
    expect(warnings[0]).toContain('E11 后续问题 5');
    // 包含契约名 / 承载接口 ID / 错误码
    expect(warnings.some((w) => w.includes('orphanApi'))).toBe(true);
    expect(warnings.some((w) => w.includes('IF_CTR_orphanApi'))).toBe(true);
    expect(warnings.some((w) => w.includes('port_conflict'))).toBe(true);
  });

  test('空 contracts 段 → 不派生承载接口，migrationWarnings 为 undefined', () => {
    const model = build('parties:\n  - admin\n');
    const envelope = specify(model);
    const specs = specsFromEnvelope(envelope);
    expect(specs.find((s) => s.id.startsWith('IF_CTR_'))).toBeUndefined();
    expect(envelope.migrationWarnings ?? []).toEqual([]);
  });

  test('所有契约 interface 均匹配 transition → 不派生任何承载接口', () => {
    const model = build(
      'parties:\n' +
        '  - admin\n' +
        'contracts:\n' +
        '  - interface: register\n' +
        '    requestSchema: { type: object, properties: { name: { type: string } }, required: [name] }\n' +
        '    errorResponses:\n' +
        '      - id: ERR-01\n' +
        '        errorCode: already_exists\n' +
        '        httpStatus: 409\n' +
        '  - interface: disable\n' +
        '    requestSchema: { type: object, properties: { id: { type: string } }, required: [id] }\n' +
        '    errorResponses:\n' +
        '      - id: ERR-01\n' +
        '        errorCode: state_mismatch\n' +
        '        httpStatus: 409\n'
    );
    const envelope = specify(model);
    const specs = specsFromEnvelope(envelope);
    expect(specs.find((s) => s.id.startsWith('IF_CTR_'))).toBeUndefined();
    expect(envelope.migrationWarnings ?? []).toEqual([]);
  });
});