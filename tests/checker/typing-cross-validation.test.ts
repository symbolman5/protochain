/**
 * TI4 (C-5) checker 单测 —— 分型交叉校验 + schema 完整度断言 + 报错分层
 *
 * 设计依据：10-interface-view-proposal.md v0.5.1 §3-2（分型权威声明 / 三值映射表 /
 *            交叉校验权威方向 / 报错分层 R2-7）+ §4 C-5 行；11-execution-G5-interface-view.md §2 TI4
 *
 * 覆盖（acceptance 双向 + Rule 2）：
 * - pass：declaredInterfaceType 与机械兜底一致 → 无 TYPING_MISMATCH
 * - fail（反向）：声明 observation 但实际 state_machine → TYPING_MISMATCH（硬失败）
 * - layering：contract.interface 引用不存在的 transition → 引用完整性（R-E6）已报，分型交叉校验不双重报告
 * - old-model：无 declaredInterfaceType → 无 TYPING_MISMATCH（老模型零回归）
 * - Rule 2：state_machine 接口 requestSchema 为 description-only → TYPING_SCHEMA_DRIFT warning
 *           ；structured → 不报 drift
 */

import { parseProtocolContent } from '../../src/parser/index.js';
import { checkCompleteness } from '../../src/checker/index.js';
import type { SourceProtocolModel } from '../../src/model/types.js';

const BASE_FRONT_MATTER =
  '---\n' +
  'name: TI4 分型交叉校验测试\n' +
  'version: 1.0.0\n' +
  'purpose: 契约声明分型 vs 机械可推导分型一致性\n' +
  'roles:\n' +
  '  - id: admin\n' +
  '    name: 管理员\n' +
  '  - id: system\n' +
  '    name: 系统\n' +
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

/** 收集全部 issue 的 message 文本 */
function allMessages(m: SourceProtocolModel): string[] {
  const r = checkCompleteness(m);
  return [
    ...r.mechanical.structuralIssues,
    ...r.mechanical.fieldIssues,
    ...r.mechanical.referenceIssues,
  ].map((i) => i.message);
}

function hasCode(m: SourceProtocolModel, token: string): boolean {
  return allMessages(m).some((msg) => msg.includes(token));
}

describe('TI4 分型交叉校验 (C-5)', () => {
  test('pass：声明 state_machine 且机械兜底为 state_machine → 无 TYPING_MISMATCH', () => {
    const m = build(
      'parties:\n' +
        '  - admin\n' +
        'contracts:\n' +
        '  - interface: register\n' +
        '    interfaceType: state_machine\n' +
        '    requestSchema:\n' +
        '      type: object\n' +
        '      properties:\n' +
        '        name: { type: string }\n' +
        '      required: [name]\n'
    );
    expect(hasCode(m, 'TYPING_MISMATCH')).toBe(false);
  });

  test('fail（反向）：声明 observation 但实际 kind=system/无 carrier → TYPING_MISMATCH 硬失败', () => {
    const m = build(
      'parties:\n' +
        '  - admin\n' +
        'contracts:\n' +
        '  - interface: register\n' +
        '    interfaceType: observation\n' +
        '    requestSchema:\n' +
        '      type: object\n' +
        '      properties:\n' +
        '        name: { type: string }\n' +
        '      required: [name]\n'
    );
    expect(hasCode(m, 'TYPING_MISMATCH')).toBe(true);
    const r = checkCompleteness(m);
    const errors = [
      ...r.mechanical.structuralIssues,
      ...r.mechanical.fieldIssues,
      ...r.mechanical.referenceIssues,
    ].filter((i) => i.severity === 'error' && i.message.includes('TYPING_MISMATCH'));
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].message).toContain('register');
  });

  test('layering：contract.interface 引用不存在的 transition → 引用完整性已报，分型交叉校验不双重报告', () => {
    const m = build(
      'parties:\n' +
        '  - admin\n' +
        'contracts:\n' +
        '  - interface: foo\n' +
        '    interfaceType: state_machine\n' +
        '    requestSchema:\n' +
        '      type: object\n' +
        '      properties:\n' +
        '        x: { type: string }\n' +
        '      required: [x]\n'
    );
    // foo 不指向任何 transition → 引用不完整（既有 R-E6 报 orphan warning）
    const r = checkCompleteness(m);
    const referenceAboutFoo = [
      ...r.mechanical.structuralIssues,
      ...r.mechanical.fieldIssues,
      ...r.mechanical.referenceIssues,
    ].filter((i) => i.message.includes('foo'));
    expect(referenceAboutFoo.length).toBeGreaterThanOrEqual(1);
    // 分型交叉校验不得对 foo 双重报告
    expect(hasCode(m, 'TYPING_MISMATCH')).toBe(false);
  });

  test('old-model：无 declaredInterfaceType → 无 TYPING_MISMATCH（零回归）', () => {
    const m = build(
      'parties:\n' +
        '  - admin\n' +
        'contracts:\n' +
        '  - interface: register\n' +
        '    requestSchema:\n' +
        '      type: object\n' +
        '      properties:\n' +
        '        name: { type: string }\n' +
        '      required: [name]\n'
    );
    expect(hasCode(m, 'TYPING_MISMATCH')).toBe(false);
    expect(hasCode(m, 'TYPING_SCHEMA_DRIFT')).toBe(false);
  });
});

describe('TI4 Rule 2 schema 完整度（防两层漂移）', () => {
  test('state_machine 接口 requestSchema 为 description-only → TYPING_SCHEMA_DRIFT warning', () => {
    const m = build(
      'parties:\n' +
        '  - admin\n' +
        'contracts:\n' +
        '  - interface: register\n' +
        '    interfaceType: state_machine\n' +
        '    requestSchema:\n' +
        '      description: 仅自然语言描述的请求\n'
    );
    expect(hasCode(m, 'TYPING_SCHEMA_DRIFT')).toBe(true);
    // drift 为 warning（非 error），不阻断 check
    const r = checkCompleteness(m);
    const errors = [
      ...r.mechanical.structuralIssues,
      ...r.mechanical.fieldIssues,
      ...r.mechanical.referenceIssues,
    ].filter((i) => i.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  test('state_machine 接口 requestSchema 为 structured → 不报 TYPING_SCHEMA_DRIFT', () => {
    const m = build(
      'parties:\n' +
        '  - admin\n' +
        'contracts:\n' +
        '  - interface: register\n' +
        '    interfaceType: state_machine\n' +
        '    requestSchema:\n' +
        '      type: object\n' +
        '      properties:\n' +
        '        name: { type: string }\n' +
        '      required: [name]\n'
    );
    expect(hasCode(m, 'TYPING_SCHEMA_DRIFT')).toBe(false);
  });
});
