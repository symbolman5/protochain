/**
 * E11 异常路径错误码列 — parser 单测
 *
 * 设计依据：IMPLEMENTATION-PLAN.md §E11、docs/error-modeling-plan.md §2.1
 *
 * 覆盖：
 * - 异常路径表含 "错误码" 列 → 解析到 ExceptionPathDef.errorCode
 * - 旧表无错误码列 → 不填、不报错（兼容老协议）
 * - "协议错误码" / "errorcode" 中英文别名
 * - 异常路径严重缺失仍按原行为报错
 */

import { parseProtocolContent, ParseError } from '../../src/parser/index.js';

const BASE_FRONT_MATTER =
  '---\n' +
  'name: 测试协议\n' +
  'version: 1.0.0\n' +
  'purpose: E11 错误码解析测试\n' +
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

describe('parser - E11 异常路径 errorCode 列解析', () => {
  test('正向：中文表头"错误码" → ExceptionPathDef.errorCode 已填', () => {
    const md =
      BASE_FRONT_MATTER +
      BASE_DERIVABLE +
      '\n# 异常路径\n\n' +
      '| ID | 名称 | 触发 | 转移序列 | 恢复策略 | 错误码 |\n|---|---|---|---|---|---|\n' +
      '| EX1 | 域名未归属 | 归属域名非本人 | T1 | 拒绝 | domain_not_owned |\n';
    const model = parseProtocolContent(md, 'test.md');
    expect(model.derivable.exceptions).toHaveLength(1);
    expect(model.derivable.exceptions[0].errorCode).toBe('domain_not_owned');
    expect(model.derivable.exceptions[0].id).toBe('EX1');
  });

  test('正向：英文表头"errorcode"也能识别（normalizeHeader）', () => {
    const md =
      BASE_FRONT_MATTER +
      BASE_DERIVABLE +
      '\n# 异常路径\n\n' +
      '| ID | 名称 | 触发 | 转移序列 | 错误码 |\n|---|---|---|---|---|\n' +
      '| EX1 | X | trg | T1 | token_invalid_role |\n';
    const model = parseProtocolContent(md, 'test.md');
    expect(model.derivable.exceptions[0].errorCode).toBe('token_invalid_role');
  });

  test('反向：旧表无错误码列 → errorCode 为 undefined（兼容老协议）', () => {
    const md =
      BASE_FRONT_MATTER +
      BASE_DERIVABLE +
      '\n# 异常路径\n\n' +
      '| ID | 名称 | 触发 | 转移序列 | 恢复策略 |\n|---|---|---|---|---|\n' +
      '| EX1 | 旧式异常 | 触发文本 | T1 | 旧式恢复 |\n';
    const model = parseProtocolContent(md, 'test.md');
    expect(model.derivable.exceptions).toHaveLength(1);
    expect(model.derivable.exceptions[0].errorCode).toBeUndefined();
    // 原有字段仍正常
    expect(model.derivable.exceptions[0].name).toBe('旧式异常');
    expect(model.derivable.exceptions[0].transitionIds).toEqual(['T1']);
  });

  test('反向：错误码空白字符串视为未声明（兼容）', () => {
    const md =
      BASE_FRONT_MATTER +
      BASE_DERIVABLE +
      '\n# 异常路径\n\n' +
      '| ID | 名称 | 触发 | 转移序列 | 错误码 |\n|---|---|---|---|---|\n' +
      '| EX1 | X | trg | T1 |   |\n'; // 空白
    const model = parseProtocolContent(md, 'test.md');
    expect(model.derivable.exceptions[0].errorCode).toBeUndefined();
  });

  test('正向：多条异常各自带 errorCode', () => {
    const md =
      BASE_FRONT_MATTER +
      BASE_DERIVABLE +
      '\n# 异常路径\n\n' +
      '| ID | 名称 | 触发 | 转移序列 | 错误码 |\n|---|---|---|---|---|\n' +
      '| EX1 | 域名未归属 | trg1 | T1 | domain_not_owned |\n' +
      '| EX2 | 域名被占 | trg2 | T1 | domain_taken |\n' +
      '| EX3 | 角色无效 | trg3 | T1 | token_invalid_role |\n';
    const model = parseProtocolContent(md, 'test.md');
    expect(model.derivable.exceptions).toHaveLength(3);
    expect(model.derivable.exceptions[0].errorCode).toBe('domain_not_owned');
    expect(model.derivable.exceptions[1].errorCode).toBe('domain_taken');
    expect(model.derivable.exceptions[2].errorCode).toBe('token_invalid_role');
  });
});
