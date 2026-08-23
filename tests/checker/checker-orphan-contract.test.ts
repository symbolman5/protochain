/**
 * E11 后续问题 5（008-5）checker R-E6 规则 — checker 单测
 *
 * 设计依据：工具链修改单 008 §E11 后续问题 5
 *   - 新增规则 R-E6：契约 interface 未匹配任何 transition.id/action → warning（非 error）
 *   - 防阻断：保留 warning 语义（severity !== 'error'），让 checker 报告仍 passed=true
 *   - 关联信息：错误码列表（让模型作者快速定位需审视的契约）
 *
 * 覆盖：
 * - 契约 interface 未匹配 → warning（非 error），fieldIssues 中
 * - 契约 interface 与 transition.action 对齐 → 不报 R-E6
 * - 多个 orphan 契约 → 每条独立 warning
 * - warning 不会阻断 check（mechanical.passed=true）
 * - 同一契约按 sourceId 显式声明（与 transition.id 对齐）→ 不报 R-E6
 */

import { parseProtocolContent } from '../../src/parser/index.js';
import { checkCompleteness } from '../../src/checker/index.js';
import type { SourceProtocolModel } from '../../src/model/types.js';

const BASE_FRONT_MATTER =
  '---\n' +
  'name: E11 后续问题 5 checker R-E6 测试\n' +
  'version: 1.0.0\n' +
  'purpose: 契约 interface 未匹配 transition → warning\n' +
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
  '| T1 | 注册 | S1 | S2 | register | admin |\n' +
  '| T2 | 停用 | S1 | S1 | disable | admin |\n';

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

describe('checker - E11 后续问题 5 R-E6（契约无匹配 transition）', () => {
  test('正向：契约 interface 与 transition.action 对齐 → 不报 R-E6 warning', () => {
    const m = build(
      'parties:\n' +
        '  - admin\n' +
        'contracts:\n' +
        '  - interface: register\n' +
        '    requestSchema:\n' +
        '      type: object\n' +
        '      properties:\n' +
        '        name: { type: string }\n' +
        '      required: [name]\n' +
        '    errorResponses:\n' +
        '      - id: ERR-01\n        errorCode: already_exists\n        httpStatus: 409\n'
    );
    const r = checkCompleteness(m);
    const rE6 = r.mechanical.fieldIssues.filter(
      (i) => i.severity === 'warning' && i.message.includes('R-E6') === false && i.message.includes('未匹配任何 transition')
    );
    // register 命中 transition.action → 不应触发 R-E6
    expect(rE6).toHaveLength(0);
  });

  test('反向：契约 interface 未匹配任何 transition → 报 warning（非 error）', () => {
    const m = build(
      'parties:\n' +
        '  - admin\n' +
        'contracts:\n' +
        '  - interface: mappingCreate\n' +
        '    requestSchema:\n' +
        '      type: object\n' +
        '      properties:\n' +
        '        protocol: { type: string }\n' +
        '      required: [protocol]\n' +
        '    errorResponses:\n' +
        '      - id: ERR-01\n        errorCode: port_conflict\n        httpStatus: 409\n' +
        '      - id: ERR-02\n        errorCode: domain_taken\n        httpStatus: 409\n'
    );
    const r = checkCompleteness(m);
    const warnings = r.mechanical.fieldIssues.filter(
      (i) => i.severity === 'warning' && i.message.includes('mappingCreate')
    );
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    const w = warnings[0];
    expect(w.message).toContain('mappingCreate');
    expect(w.message).toContain('承载接口');
    // 包含错误码列表（便于定位）
    expect(w.message).toContain('port_conflict');
    expect(w.message).toContain('domain_taken');
    // 路径定位
    expect(w.elementPath).toContain('mappingCreate');
    // 严重度是 warning 而非 error
    expect(w.severity).toBe('warning');
  });

  test('反向：R-E6 warning 不会阻断 check（mechanical.passed=true）', () => {
    const m = build(
      'parties:\n' +
        '  - admin\n' +
        'contracts:\n' +
        '  - interface: mappingCreate\n' +
        '    errorResponses:\n' +
        '      - id: ERR-01\n        errorCode: port_conflict\n        httpStatus: 409\n'
    );
    // 异常路径同步声明 port_conflict，避免 R-E4（契约引用协议未声明码）误报
    m.derivable.exceptions.push({
      id: 'EX1',
      name: '端口冲突',
      trigger: 't',
      transitionIds: [],
      errorCode: 'port_conflict',
    });
    const r = checkCompleteness(m);
    // 仅 warning（无 error）
    const errors = [
      ...r.mechanical.structuralIssues,
      ...r.mechanical.fieldIssues,
      ...r.mechanical.referenceIssues,
    ].filter((i) => i.severity === 'error');
    expect(errors).toHaveLength(0);
    expect(r.mechanical.passed).toBe(true);
  });

  test('多个 orphan 契约 → 每条独立 warning', () => {
    const m = build(
      'parties:\n' +
        '  - admin\n' +
        'contracts:\n' +
        '  - interface: register\n' +
        '    requestSchema: { type: object, properties: { name: { type: string } }, required: [name] }\n' +
        '  - interface: mappingCreate\n' +
        '    errorResponses:\n' +
        '      - id: ERR-01\n        errorCode: port_conflict\n        httpStatus: 409\n' +
        '  - interface: domainClaim\n' +
        '    errorResponses:\n' +
        '      - id: ERR-01\n        errorCode: domain_taken\n        httpStatus: 409\n'
    );
    const r = checkCompleteness(m);
    const wMapping = r.mechanical.fieldIssues.filter(
      (i) => i.severity === 'warning' && i.message.includes('mappingCreate')
    );
    const wDomain = r.mechanical.fieldIssues.filter(
      (i) => i.severity === 'warning' && i.message.includes('domainClaim')
    );
    expect(wMapping.length).toBeGreaterThanOrEqual(1);
    expect(wDomain.length).toBeGreaterThanOrEqual(1);
  });

  test('正向：契约 sourceId 显式对齐 transition.id → 不报 R-E6', () => {
    const m = build(
      'parties:\n' +
        '  - admin\n' +
        'contracts:\n' +
        '  - interface: registerX\n' +
        '    sourceId: T1\n' +
        '    requestSchema:\n' +
        '      type: object\n' +
        '      properties:\n' +
        '        name: { type: string }\n' +
        '      required: [name]\n'
    );
    const r = checkCompleteness(m);
    const rE6 = r.mechanical.fieldIssues.filter(
      (i) => i.severity === 'warning' && i.message.includes('registerX')
    );
    // interface 名 registerX 与 transition.action 不匹配，但 sourceId=T1 与 transition.id=T1 对齐
    // 注意：当前 R-E6 检查 transition.id / transition.action（涵盖两键），sourceId 路径会命中 transition.id
    expect(rE6).toHaveLength(0);
  });

  test('空契约层 → 不报 R-E6 warning（兼容老协议）', () => {
    const m = build('parties:\n  - admin\n');
    const r = checkCompleteness(m);
    const rE6 = r.mechanical.fieldIssues.filter(
      (i) => i.message.includes('未匹配任何 transition')
    );
    expect(rE6).toHaveLength(0);
  });
});