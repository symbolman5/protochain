/**
 * G7-S6（X13 / P2-6）：credential: 段 parser 解析测试
 *
 * 覆盖：
 * - frontmatter 的 credential: YAML 段与 roles: 段同构解析（可选段）；
 * - 七列完整性（name/issuer/holder/redeemer/selfContained/ttl/revoke/premise）；
 * - selfContained 枚举白名单（local-verify | needs-lookup），非法值抛 ParseError（拒绝静默）；
 * - 非数组形态抛 ParseError；
 * - 无 credential: 段的老模型 → metadata.credentials = undefined（零回归，S6-5）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProtocolContent, ParseError } from '../../src/parser/index.js';

const EXAMPLES_DIR = join(process.cwd(), 'examples');

/** 完整七列凭证 fixture（与 roles 同构的 frontmatter YAML 数组） */
const CREDENTIAL_MODEL = `---
name: 凭证解析 fixture
version: 1.0.0
purpose: 验证凭证段解析
roles:
  - id: ca
    name: 证书中心
    roleType: consensus
  - id: merchant
    name: 商家
    roleType: participant
  - id: customer
    name: 顾客
    roleType: participant
credentials:
  - name: merchant_license
    issuer: ca
    holder: merchant
    redeemer: customer
    selfContained: local-verify
    ttl: 365d
    revoke: 吊销后即时失效
    premise: 商家完成资质认证
  - name: payment_token
    issuer: ca
    holder: customer
    redeemer: merchant
    selfContained: needs-lookup
    ttl: 30d
    revoke: 退款后撤销
    premise: 顾客已完成实名
---

# 背景

验证凭证段解析。

# 状态空间

| ID | 名称 | 类型 | 描述 | 角色 |
|---|---|---|---|---|
| S0 | 初始 | initial | 初始态 | customer |
| S1 | 终态 | terminal | 终态 | customer |

# 转移规则

| ID | 名称 | from | to | action | trigger | guard | effects | triggerType | actionType | affectsDimensions |
|---|---|---|---|---|---|---|---|---|---|---|
| T1 | 完成 | S0 | S1 | finish | customer | | | role | state_transition | |
`;

describe('G7-S6 X13 parser：credential: 段（frontmatter，与 roles 同构）', () => {
  test('解析出 credentials 数组（七列完整）', () => {
    const model = parseProtocolContent(CREDENTIAL_MODEL);
    const creds = model.metadata.credentials;
    expect(creds).toHaveLength(2);

    const license = creds![0];
    expect(license.name).toBe('merchant_license');
    expect(license.issuer).toBe('ca');
    expect(license.holder).toBe('merchant');
    expect(license.redeemer).toBe('customer');
    expect(license.selfContained).toBe('local-verify');
    expect(license.ttl).toBe('365d');
    expect(license.revoke).toBe('吊销后即时失效');
    expect(license.premise).toBe('商家完成资质认证');

    const token = creds![1];
    expect(token.selfContained).toBe('needs-lookup');
  });

  test('selfContained 枚举非法值抛 ParseError（拒绝静默）', () => {
    const bad = CREDENTIAL_MODEL.replace(
      'selfContained: local-verify\n    ttl: 365d',
      'selfContained: online-only\n    ttl: 365d'
    );
    expect(() => parseProtocolContent(bad)).toThrow(ParseError);
    expect(() => parseProtocolContent(bad)).toThrow(/selfContained/);
  });

  test('credentials 非数组形态抛 ParseError', () => {
    // 独立小模型：credentials 为块映射（非数组）→ parser 拒绝
    const bad = `---
name: 凭证非数组 fixture
version: 1.0.0
purpose: 验证 credentials 必须为数组
roles:
  - id: ca
    name: 证书中心
    roleType: consensus
credentials:
  name: merchant_license
  issuer: ca
---

# 背景

无。

# 状态空间

| ID | 名称 | 类型 | 描述 | 角色 |
|---|---|---|---|---|
| S0 | 初始 | initial | 初始态 | ca |
| S1 | 终态 | terminal | 终态 | ca |

# 转移规则

| ID | 名称 | from | to | action | trigger | guard | effects | triggerType | actionType | affectsDimensions |
|---|---|---|---|---|---|---|---|---|---|---|
| T1 | 完成 | S0 | S1 | finish | ca | | | role | state_transition | |
`;
    expect(() => parseProtocolContent(bad)).toThrow(ParseError);
    expect(() => parseProtocolContent(bad)).toThrow(/credentials 必须是数组/);
  });

  test('凭证项缺失必填列抛 ParseError（七列完整性，parser 层前置拦截）', () => {
    const bad = CREDENTIAL_MODEL.replace(
      '    premise: 商家完成资质认证\n  - name: payment_token',
      '  - name: payment_token'
    );
    expect(() => parseProtocolContent(bad)).toThrow(ParseError);
    expect(() => parseProtocolContent(bad)).toThrow(/premise/);
  });

  test('S6-5：无 credential: 段的老模型 → metadata.credentials = undefined（零回归）', () => {
    // 与 roles 同构但无 credentials 键：段可选
    const legacyModel = `---
name: 无凭证段 fixture
version: 1.0.0
purpose: 验证 credential 段可选
roles:
  - id: customer
    name: 顾客
    roleType: consensus
---

# 背景

无凭证。

# 状态空间

| ID | 名称 | 类型 | 描述 | 角色 |
|---|---|---|---|---|
| S0 | 初始 | initial | 初始态 | customer |
| S1 | 终态 | terminal | 终态 | customer |

# 转移规则

| ID | 名称 | from | to | action | trigger | guard | effects | triggerType | actionType | affectsDimensions |
|---|---|---|---|---|---|---|---|---|---|---|
| T1 | 完成 | S0 | S1 | finish | customer | | | role | state_transition | |
`;
    const model = parseProtocolContent(legacyModel);
    expect(model.metadata.credentials).toBeUndefined();
  });

  test('S6-5：两演示实例无 credential 段 → undefined（解析与 S5b 之前一致）', () => {
    const instances: Array<[string, string]> = [
      ['food-delivery', join(EXAMPLES_DIR, 'food-delivery', 'protocol', 'model.md')],
      ['fulfillment-payment/P1', join(EXAMPLES_DIR, 'fulfillment-payment', 'protocol', 'P1', 'model.md')],
      ['fulfillment-payment/P2', join(EXAMPLES_DIR, 'fulfillment-payment', 'protocol', 'P2', 'model.md')],
    ];
    for (const [label, file] of instances) {
      const model = parseProtocolContent(readFileSync(file, 'utf-8'));
      expect(model.metadata.credentials).toBeUndefined();
    }
  });
});
