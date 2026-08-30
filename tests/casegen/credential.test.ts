/**
 * G7-S6（X15 / P2-6）：凭证用例生成测试 —— 过期 / 撤销 / 回查失败三类。
 *
 * 覆盖 execution-plan.md §S6 机械验收：
 * - S6-2 local-verify 凭证：回查失败时仍验证通过（正向，expectedCredentialBehavior='verify'，
 *   body 断言 res.valid === true）；
 * - S6-3 needs-lookup 凭证：回查失败时拒绝而非放行（fail-closed，正向，
 *   expectedCredentialBehavior='reject'，body 断言 res.valid === false）；
 * - S6-4 过期 / 已撤销 ⇒ 必须失效（各一条：credential-expired + credential-revoked，
 *   均 expectFailure=true，body 断言 res.valid === false）；
 * - S6-5 无 credential: 段的老模型 → 0 凭证用例且不降级（凭证机制未启用，非缺口）；
 * - 用例 body 可执行（非空壳：esbuild 语法可解析）；
 * - 确定性：连跑 3 次结果一致（防 flaky）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { transformSync } from 'esbuild';
import { parseProtocolContent } from '../../src/parser/index.js';
import { generateCases, generateAdversarialCases } from '../../src/casegen/index.js';

const EXAMPLES_DIR = join(process.cwd(), 'examples');

/** X15 fixture：两条凭证（local-verify + needs-lookup）+ 契约层 preconditions（验证 X6 共存） */
const CREDENTIAL_MODEL = `---
name: G7-S6 凭证用例 fixture
version: 1.0.0
purpose: 验证 X15 三类凭证用例生成
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

验证 X15 凭证用例。

# 状态空间

| ID | 名称 | 类型 | 描述 | 角色 |
|---|---|---|---|---|
| S0 | 初始 | initial | 初始态 | customer |
| S1 | 运行 | normal | 运行态 | customer |
| S2 | 终态 | terminal | 终态 | customer |

# 转移规则

| ID | 名称 | from | to | action | trigger | guard | effects | triggerType | actionType | affectsDimensions |
|---|---|---|---|---|---|---|---|---|---|---|
| T1 | 启动 | S0 | S1 | start | customer | | | role | state_transition | |
| T2 | 完成 | S1 | S2 | finish | customer | 库存充足且订单已确认 | | role | state_transition | |
`;

describe('G7-S6 X15 凭证用例生成', () => {
  const model = parseProtocolContent(CREDENTIAL_MODEL);

  test('每条凭证生成三条用例（过期/撤销/回查失败），S6-4 各一条', () => {
    const { cases } = generateAdversarialCases(model);
    const credCases = cases.filter((c) => c.kind.startsWith('credential-'));
    // 2 凭证 × 3 类 = 6 条
    expect(credCases).toHaveLength(6);

    const expired = cases.filter((c) => c.kind === 'credential-expired');
    const revoked = cases.filter((c) => c.kind === 'credential-revoked');
    const lookup = cases.filter((c) => c.kind === 'credential-lookup');
    // S6-4：过期 / 已撤销各一条（每凭证一条）
    expect(expired).toHaveLength(2);
    expect(revoked).toHaveLength(2);
    // S6-2/3：回查失败一条（每凭证一条）
    expect(lookup).toHaveLength(2);
  });

  test('S6-2：local-verify 凭证回查失败仍验证通过（正向）', () => {
    const { cases } = generateAdversarialCases(model);
    const licenseLookup = cases.find(
      (c) => c.kind === 'credential-lookup' && c.credential === 'merchant_license'
    )!;
    expect(licenseLookup.selfContained).toBe('local-verify');
    expect(licenseLookup.expectedCredentialBehavior).toBe('verify');
    expect(licenseLookup.expectFailure).toBe(false);
    expect(licenseLookup.source).toContain('selfContained=local-verify');
    // 用例正文：断言验证通过（非空壳）
    expect(licenseLookup.body).toContain('simulateLookupFailure');
    expect(licenseLookup.body).toContain('expect(res.valid).toBe(true)');
    expect(licenseLookup.body).toContain('S6-2');
  });

  test('S6-3：needs-lookup 凭证回查失败拒绝而非放行（fail-closed，正向）', () => {
    const { cases } = generateAdversarialCases(model);
    const tokenLookup = cases.find(
      (c) => c.kind === 'credential-lookup' && c.credential === 'payment_token'
    )!;
    expect(tokenLookup.selfContained).toBe('needs-lookup');
    expect(tokenLookup.expectedCredentialBehavior).toBe('reject');
    expect(tokenLookup.expectFailure).toBe(true);
    expect(tokenLookup.source).toContain('selfContained=needs-lookup');
    // 用例正文：断言拒绝（fail-closed，非空壳）
    expect(tokenLookup.body).toContain('simulateLookupFailure');
    expect(tokenLookup.body).toContain('expect(res.valid).toBe(false)');
    expect(tokenLookup.body).toContain('S6-3');
  });

  test('S6-4：过期/已撤销 ⇒ 必须失效（各一条，断言 res.valid=false）', () => {
    const { cases } = generateAdversarialCases(model);
    const expired = cases.filter((c) => c.kind === 'credential-expired');
    const revoked = cases.filter((c) => c.kind === 'credential-revoked');
    for (const c of [...expired, ...revoked]) {
      expect(c.expectFailure).toBe(true);
      expect(c.expectedCredentialBehavior).toBe('reject');
      expect(c.body).toContain('expect(res.valid).toBe(false)');
    }
    // 每条凭证各一条（2 凭证 → 各 2 条）
    expect(new Set(expired.map((c) => c.credential)).size).toBe(2);
    expect(new Set(revoked.map((c) => c.credential)).size).toBe(2);
    // 数据源可指回具体声明（J2 口径：source 含凭证名与对应列）
    expect(expired[0].source).toContain('ttl=');
    expect(revoked[0].source).toContain('revoke=');
  });

  test('用例数 = 凭证数 × 3（理论上限无差额，S6-2/3/4 全正向）', () => {
    const { cases, degradedReasons } = generateAdversarialCases(model);
    const credCases = cases.filter((c) => c.kind.startsWith('credential-'));
    expect(credCases).toHaveLength(model.metadata.credentials!.length * 3);
    // 无 X15 差额降级（每条凭证三类全生成）
    expect(degradedReasons.some((d) => d.includes('X15'))).toBe(false);
  });

  test('全部凭证用例 body 可被 TypeScript 语法解析（esbuild，非空壳）', () => {
    const { cases } = generateAdversarialCases(model);
    const credCases = cases.filter((c) => c.kind.startsWith('credential-'));
    expect(credCases.length).toBeGreaterThan(0);
    for (const c of credCases) {
      expect(() => {
        const code = transformSync(c.body, { loader: 'ts' }).code;
        expect(code.length).toBeGreaterThan(0);
      }).not.toThrow();
    }
  });

  test('确定性：连跑 3 次凭证用例完全一致（防 flaky）', () => {
    const norm = (r: { cases: unknown[] }) =>
      JSON.stringify(r.cases.filter((c) => (c as { kind: string }).kind.startsWith('credential-')));
    const r1 = generateAdversarialCases(model);
    const r2 = generateAdversarialCases(model);
    const r3 = generateAdversarialCases(model);
    expect(norm(r1)).toBe(norm(r2));
    expect(norm(r2)).toBe(norm(r3));
  });
});

describe('G7-S6 S6-5：无 credential 段的老模型零回归', () => {
  const instances: Array<{ name: string; file: string }> = [
    { name: 'food-delivery', file: join(EXAMPLES_DIR, 'food-delivery/protocol/model.md') },
    { name: 'fulfillment-payment/P1', file: join(EXAMPLES_DIR, 'fulfillment-payment/protocol/P1/model.md') },
    { name: 'fulfillment-payment/P2', file: join(EXAMPLES_DIR, 'fulfillment-payment/protocol/P2/model.md') },
  ];

  for (const inst of instances) {
    test(`${inst.name}：generateCases 不产生任何凭证用例、不降级（凭证机制未启用，非缺口）`, () => {
      const model = parseProtocolContent(readFileSync(inst.file, 'utf-8'));
      expect(model.metadata.credentials).toBeUndefined();
      const result = generateAdversarialCases(model);
      expect(result.cases.filter((c) => c.kind.startsWith('credential-'))).toHaveLength(0);
      expect(result.degradedReasons.some((d) => d.includes('X15'))).toBe(false);
      // 整体 generateCases 仍跑通（路径 + 覆盖度结构完整）
      const full = generateCases(model);
      expect(full.paths.length).toBeGreaterThan(0);
    });
  }
});
