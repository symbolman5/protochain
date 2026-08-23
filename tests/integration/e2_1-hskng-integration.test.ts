/**
 * E2.1 hsk-ng P1 model.md 集成验证
 *
 * 设计依据：IMPLEMENTATION-PLAN.md §E2.1（数据来源：实例侧）
 *
 * 验证：
 * - hsk-ng P1 model.md 注入 contracts[] 后能被 parser 正常解析
 * - 契约 schema 可被 ajv 编译
 * - specifier 消费契约字段后 schemaKind=structured
 * - 注入的契约字段名/类型/必填与预期一致
 */

import { parseProtocolFile } from '../../src/parser/index.js';
import { specify, specsFromEnvelope } from '../../src/specifier/index.js';
import { checkCompleteness } from '../../src/checker/index.js';

const HSK_NG_P1_MODEL = '/work/hsk-ng/modeling/protocol/P1/model.md';

describe('E2.1 hsk-ng P1 model.md 集成', () => {
  test('model.md 含 contracts[] 段 → parser 解析出全部系统接口契约（E11 B2 落地后 12 条）', () => {
    const model = parseProtocolFile(HSK_NG_P1_MODEL);
    expect(model.contractInput).toBeDefined();
    expect(model.contractInput?.contracts).toBeDefined();
    expect(model.contractInput?.contracts).toHaveLength(12);
    const ifaces = model.contractInput!.contracts!.map((c) => c.interface).sort();
    expect(ifaces).toEqual([
      'bind',
      'certDelete',
      'certImport',
      'certList',
      'deregister',
      'disable',
      'enable',
      'goOffline',
      'listServers',
      'register',
      'reissueSecret',
      'report',
    ]);
  });

  test('契约 schema 可被 ajv 编译（机械自检）', () => {
    const model = parseProtocolFile(HSK_NG_P1_MODEL);
    const report = checkCompleteness(model);
    const schemaErrors = report.mechanical.referenceIssues.filter((i) =>
      i.message.includes('不可被 ajv 编译')
    );
    expect(schemaErrors).toHaveLength(0);
  });

  test('specifier 消费契约字段 → register/bind schemaKind=structured', () => {
    const model = parseProtocolFile(HSK_NG_P1_MODEL);
    const specs = specsFromEnvelope(specify(model));
    const systemSpecs = specs.filter((s) => s.kind === 'system');
    const register = systemSpecs.find((s) => s.sourceId === 'register');
    const bind = systemSpecs.find((s) => s.sourceId === 'bind');
    expect(register).toBeDefined();
    expect(bind).toBeDefined();
    expect(register!.schemaKind).toBe('structured');
    expect(bind!.schemaKind).toBe('structured');
    expect(register!.contractSource).toBe('register');
    expect(bind!.contractSource).toBe('bind');
  });

  test('register 接口契约字段齐全（字段名/类型/必填）', () => {
    const model = parseProtocolFile(HSK_NG_P1_MODEL);
    const specs = specsFromEnvelope(specify(model));
    const register = specs.find((s) => s.sourceId === 'register')!;
    const inputNames = register.inputs.map((i) => i.name).sort();
    expect(inputNames).toEqual(
      expect.arrayContaining([
        'currentState',
        'name',
        'hostDomain',
        'tunnelPort',
        'httpPort',
        'httpsPort',
        'managementPort',
      ])
    );
    // name 必填
    expect(register.inputs.find((i) => i.name === 'name')?.required).toBe(true);
    // responseSchema 含 serverId
    expect(register.responseSchema?.properties?.serverId?.type).toBe('string');
    expect(register.responseSchema?.required).toEqual(
      expect.arrayContaining(['nextState', 'serverId', 'serverSecret'])
    );
  });

  test('bind 接口契约字段齐全（字段名/类型/必填）', () => {
    const model = parseProtocolFile(HSK_NG_P1_MODEL);
    const specs = specsFromEnvelope(specify(model));
    const bind = specs.find((s) => s.sourceId === 'bind')!;
    const inputNames = bind.inputs.map((i) => i.name).sort();
    expect(inputNames).toEqual(
      expect.arrayContaining(['currentState', 'serverSecret', 'version', 'ports'])
    );
    expect(bind.inputs.find((i) => i.name === 'serverSecret')?.required).toBe(true);
    expect(bind.responseSchema?.properties?.instanceToken?.type).toBe('string');
    expect(bind.responseSchema?.required).toEqual(
      expect.arrayContaining(['nextState', 'instanceToken', 'certPem'])
    );
  });

  test('E11 B2 后全部系统接口均有契约 → schemaKind 全部 structured（回归为零）', () => {
    const model = parseProtocolFile(HSK_NG_P1_MODEL);
    const specs = specsFromEnvelope(specify(model));
    const systemSpecs = specs.filter((s) => s.kind === 'system');
    // hsk-ng P1 E11 B2 落地后：全部系统接口注入契约（register/bind/report/disable/
    // enable/deregister/goOffline/certImport/certList/certDelete/reissueSecret）
    const withoutContract = systemSpecs.filter((s) => !s.contractSource);
    expect(withoutContract).toHaveLength(0);
    for (const s of systemSpecs) {
      // 有契约字段 → schemaKind 为 structured
      expect(s.schemaKind).toBe('structured');
    }
  });
});
