/**
 * E11 错误契约一致性校验 — checker 单测
 *
 * 设计依据：IMPLEMENTATION-PLAN.md §E11、docs/error-modeling-plan.md §2.3
 *
 * 覆盖：
 * - R-E1：错误码唯一性（异常路径 + 契约 errorResponses 合并去重）
 * - R-E2：错误码命名 snake_case
 * - R-E3：异常路径声明的 errorCode 必须被契约引用（否则 error）
 * - R-E4：契约引用的 errorCode 必须能在异常路径找到（否则 error）
 * - R-E5：httpStatus 5xx → warning（system_fault 不建模为业务错误）
 * - 老模型无 errorCode 列 / 无 errorResponses → 全部降级空跑（兼容）
 */

import { parseProtocolContent } from '../../src/parser/index.js';
import { checkCompleteness } from '../../src/checker/index.js';
import type { SourceProtocolModel } from '../../src/model/types.js';

const BASE_FRONT_MATTER =
  '---\n' +
  'name: E11 checker 测试\n' +
  'version: 1.0.0\n' +
  'purpose: error contract 校验\n' +
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

function build(extra: string, body = ''): SourceProtocolModel {
  const md =
    BASE_FRONT_MATTER +
    BASE_DERIVABLE +
    body +
    '\n# 契约层\n\n' +
    CODE_FENCE +
    extra +
    '\n' +
    CODE_FENCE_END +
    '\n';
  return parseProtocolContent(md, 'test.md');
}

describe('checker - E11 错误契约一致性', () => {
  describe('R-E1：错误码唯一性', () => {
    test('正向：唯一 errorCode 不报错', () => {
      // 只声明一次：异常路径 + 契约各有一个 different errorCode（不重复）
      const m = build(
        'contracts:\n' +
          '  - interface: register\n' +
          '    errorResponses:\n' +
          '      - id: ERR-01\n        errorCode: domain_not_owned\n        httpStatus: 409\n'
      );
      // 异常路径声明同一码（合法——出现在异常路径 + 契约 errorResponses 内，但不算重复的唯一性错误码）
      // 即：异常路径声明的码被契约引用，只出现一次，没必要报"重复"
      m.derivable.exceptions.push({
        id: 'EX1',
        name: 'X',
        trigger: 't',
        transitionIds: ['T1'],
        errorCode: 'domain_not_owned',
      });
      const r = checkCompleteness(m);
      // 单次声明：不报"重复"
      const dupErrs = r.mechanical.referenceIssues.filter(
        (i) => i.severity === 'error' && i.message.includes('重复')
      );
      // 注意：异常路径 + 契约 errorResponses 都声明同一 errorCode 是合法的"声明 + 引用"模式
      // 真正的"重复"是：异常路径声明两次 / 契约 errorResponses 内声明两次（见下两个反向用例）
      expect(dupErrs).toHaveLength(0);
    });

    test('反向：异常路径 + 契约使用同一 errorCode（合法"声明 + 引用"）→ 不报重复', () => {
      const m = build(
        'contracts:\n' +
          '  - interface: register\n' +
          '    errorResponses:\n' +
          '      - id: ERR-01\n        errorCode: domain_taken\n        httpStatus: 409\n'
      );
      m.derivable.exceptions.push({
        id: 'EX1',
        name: 'X',
        trigger: 't',
        transitionIds: ['T1'],
        errorCode: 'domain_taken',
      });
      const r = checkCompleteness(m);
      const dupErrs = r.mechanical.referenceIssues.filter(
        (i) => i.severity === 'error' && i.message.includes('重复')
      );
      expect(dupErrs).toHaveLength(0);
    });

    test('反向：异常路径内相同 errorCode 声明两次 → 报重复', () => {
      const m = build(
        'contracts:\n' +
          '  - interface: register\n' +
          '    errorResponses:\n' +
          '      - id: ERR-01\n        errorCode: domain_taken\n        httpStatus: 409\n'
      );
      // 异常路径中声明同一 errorCode 两次 → 唯一性错误
      m.derivable.exceptions.push({
        id: 'EX1',
        name: 'X1',
        trigger: 't1',
        transitionIds: ['T1'],
        errorCode: 'domain_taken',
      });
      m.derivable.exceptions.push({
        id: 'EX2',
        name: 'X2',
        trigger: 't2',
        transitionIds: ['T1'],
        errorCode: 'domain_taken',
      });
      const r = checkCompleteness(m);
      const dupErrs = r.mechanical.referenceIssues.filter(
        (i) => i.severity === 'error' && i.message.includes('重复声明')
      );
      expect(dupErrs.length).toBeGreaterThan(0);
      expect(dupErrs[0].message).toContain('domain_taken');
    });

    test('反向：同契约内多条 errorResponses 使用相同 errorCode → 报错', () => {
      const m = build(
        'contracts:\n' +
          '  - interface: register\n' +
          '    errorResponses:\n' +
          '      - id: ERR-01\n        errorCode: domain_taken\n        httpStatus: 409\n' +
          '      - id: ERR-02\n        errorCode: domain_taken\n        httpStatus: 409\n'
      );
      m.derivable.exceptions.push({
        id: 'EX1',
        name: 'X',
        trigger: 't',
        transitionIds: ['T1'],
        errorCode: 'domain_taken',
      });
      const r = checkCompleteness(m);
      const dupErrs = r.mechanical.referenceIssues.filter(
        (i) => i.severity === 'error' && i.message.includes('重复')
      );
      expect(dupErrs.length).toBeGreaterThan(0);
    });
  });

  describe('R-E2：命名规范 snake_case', () => {
    test('反向：违反 snake_case（CamelCase）→ 报错', () => {
      const m = build(
        'contracts:\n' +
          '  - interface: register\n' +
          '    errorResponses:\n' +
          '      - id: ERR-01\n        errorCode: DomainNotOwned\n        httpStatus: 409\n'
      );
      m.derivable.exceptions.push({
        id: 'EX1',
        name: 'X',
        trigger: 't',
        transitionIds: ['T1'],
        errorCode: 'DomainNotOwned',
      });
      const r = checkCompleteness(m);
      const nameErrs = r.mechanical.referenceIssues.filter(
        (i) => i.severity === 'error' && i.message.includes('snake_case')
      );
      expect(nameErrs.length).toBeGreaterThan(0);
    });

    test('反向：含连字符 → 报错', () => {
      const m = build(
        'contracts:\n' +
          '  - interface: register\n' +
          '    errorResponses:\n' +
          '      - id: ERR-01\n        errorCode: bad-code\n        httpStatus: 409\n'
      );
      m.derivable.exceptions.push({
        id: 'EX1',
        name: 'X',
        trigger: 't',
        transitionIds: ['T1'],
        errorCode: 'bad-code',
      });
      const r = checkCompleteness(m);
      const nameErrs = r.mechanical.referenceIssues.filter(
        (i) => i.severity === 'error' && i.message.includes('snake_case')
      );
      expect(nameErrs.length).toBeGreaterThan(0);
    });

    test('正向：合法 snake_case（domain_not_owned）→ 不报错', () => {
      const m = build(
        'contracts:\n' +
          '  - interface: register\n' +
          '    errorResponses:\n' +
          '      - id: ERR-01\n        errorCode: domain_not_owned\n        httpStatus: 409\n'
      );
      m.derivable.exceptions.push({
        id: 'EX1',
        name: 'X',
        trigger: 't',
        transitionIds: ['T1'],
        errorCode: 'domain_not_owned',
      });
      const r = checkCompleteness(m);
      const nameErrs = r.mechanical.referenceIssues.filter(
        (i) => i.severity === 'error' && i.message.includes('snake_case')
      );
      expect(nameErrs).toHaveLength(0);
    });
  });

  describe('R-E3：异常路径声明的 errorCode 必须被契约引用', () => {
    test('反向：异常声明了但契约未引用 → 报 error', () => {
      const m = build(
        'contracts:\n' +
          '  - interface: register\n' +
          '    errorResponses:\n' +
          '      - id: ERR-01\n        errorCode: domain_not_owned\n        httpStatus: 409\n'
      );
      m.derivable.exceptions.push({
        id: 'EX1',
        name: 'X',
        trigger: 't',
        transitionIds: ['T1'],
        errorCode: 'domain_undeclared', // 未被契约引用
      });
      const r = checkCompleteness(m);
      const errs = r.mechanical.referenceIssues.filter(
        (i) => i.severity === 'error' && i.message.includes('缺少契约覆盖')
      );
      expect(errs.length).toBeGreaterThan(0);
      expect(errs[0].message).toContain('domain_undeclared');
    });

    test('正向：异常声明 + 契约引用 → 不报 R-E3', () => {
      const m = build(
        'contracts:\n' +
          '  - interface: register\n' +
          '    errorResponses:\n' +
          '      - id: ERR-01\n        errorCode: domain_not_owned\n        httpStatus: 409\n'
      );
      m.derivable.exceptions.push({
        id: 'EX1',
        name: 'X',
        trigger: 't',
        transitionIds: ['T1'],
        errorCode: 'domain_not_owned',
      });
      const r = checkCompleteness(m);
      const errs = r.mechanical.referenceIssues.filter(
        (i) => i.severity === 'error' && i.message.includes('缺少契约覆盖')
      );
      expect(errs).toHaveLength(0);
    });
  });

  describe('R-E4：契约引用的 errorCode 必须能在异常路径找到', () => {
    test('反向：契约引用了协议未声明的错误码 → 报 error', () => {
      const m = build(
        'contracts:\n' +
          '  - interface: register\n' +
          '    errorResponses:\n' +
          '      - id: ERR-01\n        errorCode: domain_phantom\n        httpStatus: 409\n'
      );
      // 异常路径里没有 errorCode（反向兼容）
      const r = checkCompleteness(m);
      const errs = r.mechanical.referenceIssues.filter(
        (i) => i.severity === 'error' && i.message.includes('异常路径缺失 errorCode')
      );
      expect(errs.length).toBeGreaterThan(0);
      expect(errs[0].message).toContain('domain_phantom');
    });
  });

  describe('R-E5：httpStatus 5xx → warning', () => {
    test('反向：5xx 业务错误 → warning（system_fault 边界）', () => {
      const m = build(
        'contracts:\n' +
          '  - interface: register\n' +
          '    errorResponses:\n' +
          '      - id: ERR-01\n        errorCode: bad_internal\n        httpStatus: 500\n'
      );
      // 闭合 R-E3/R-E4
      m.derivable.exceptions.push({
        id: 'EX1',
        name: 'X',
        trigger: 't',
        transitionIds: ['T1'],
        errorCode: 'bad_internal',
      });
      const r = checkCompleteness(m);
      const warns = r.mechanical.fieldIssues.filter(
        (i) => i.severity === 'warning' && i.message.includes('5xx')
      );
      expect(warns.length).toBeGreaterThan(0);
    });

    test('正向：4xx 业务错误 → 不报 5xx warning', () => {
      const m = build(
        'contracts:\n' +
          '  - interface: register\n' +
          '    errorResponses:\n' +
          '      - id: ERR-01\n        errorCode: bad_request\n        httpStatus: 409\n'
      );
      m.derivable.exceptions.push({
        id: 'EX1',
        name: 'X',
        trigger: 't',
        transitionIds: ['T1'],
        errorCode: 'bad_request',
      });
      const r = checkCompleteness(m);
      const warns = r.mechanical.fieldIssues.filter(
        (i) => i.severity === 'warning' && i.message.includes('5xx')
      );
      expect(warns).toHaveLength(0);
    });
  });

  describe('兼容性（老协议零破坏）', () => {
    test('无 errorCode 列 / 无 errorResponses → 整段降级空跑', () => {
      // 没有契约层 → contractInput undefined
      const md = BASE_FRONT_MATTER + BASE_DERIVABLE + '\n# 异常路径\n\n' +
        '| ID | 名称 | 触发 | 转移序列 |\n|---|---|---|---|\n| EX1 | 旧 | trg | T1 |\n';
      const m = parseProtocolContent(md, 'test.md');
      const r = checkCompleteness(m);
      // 老协议应全过（含 m.derivable.exceptions 无 errorCode）
      const errorContractErrs = r.mechanical.referenceIssues.filter(
        (i) => i.severity === 'error' && /errorCode|契约|errorResponses/.test(i.message)
      );
      expect(errorContractErrs).toHaveLength(0);
    });

    test('有契约层但无 errorResponses 段 → 不报 error_contract 错', () => {
      const m = build(
        'contracts:\n  - interface: register\n    requestSchema: { type: object }\n'
      );
      const r = checkCompleteness(m);
      const errorContractErrs = r.mechanical.referenceIssues.filter(
        (i) => i.severity === 'error' && /errorCode|契约|errorResponses/.test(i.message)
      );
      expect(errorContractErrs).toHaveLength(0);
    });
  });
});
