/**
 * G7-S6（X14 / P2-6）：derive-bindings 凭证绑定策略 —— 按自包含性决定可否离线校验。
 *
 * 验收映射：
 * - S6-2 配套：local-verify 凭证 → offlineVerifiable=true、lookupFailurePolicy='fail-open'
 *   （回查失败仍验证通过）；
 * - S6-3 配套：needs-lookup 凭证 → offlineVerifiable=false、lookupFailurePolicy='fail-closed'
 *   （回查失败拒绝而非放行）；
 * - S6-5：无 credential: 段的老模型 → 骨架不产出 credentials 段（降级路径不改行为）。
 */
import { parseProtocolContent } from '../../src/parser/index.js';
import { specify } from '../../src/specifier/index.js';
import {
  deriveCredentialBindings,
  deriveSkeletonBindings,
  SKELETON_MARKER,
  type SkeletonBindings,
} from '../../src/bindgen/index.js';
import type { SourceProtocolModel } from '../../src/model/types.js';

/** 含两条凭证（local-verify + needs-lookup）的模型 */
const CREDENTIAL_MODEL = `---
name: 凭证绑定 fixture
version: 1.0.0
purpose: 验证 X14 离线校验派生
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

验证凭证绑定派生。

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

function loadModel(): SourceProtocolModel {
  return parseProtocolContent(CREDENTIAL_MODEL);
}

function buildSkeleton(): SkeletonBindings {
  const model = loadModel();
  return deriveSkeletonBindings(
    model,
    specify(model).specs,
    {
      sourceEnvelope: false,
      sourceMigrated: false,
      sourceMigrationWarnings: [],
    }
  );
}

describe('deriveCredentialBindings（X14 纯函数）', () => {
  test('local-verify → offlineVerifiable=true、lookupFailurePolicy=fail-open（S6-2 配套）', () => {
    const entries = deriveCredentialBindings(loadModel().metadata.credentials)!;
    const license = entries.find((e) => e.name === 'merchant_license')!;
    expect(license.selfContained).toBe('local-verify');
    expect(license.offlineVerifiable).toBe(true);
    expect(license.lookupFailurePolicy).toBe('fail-open');
    // 七列原样搬运（ttl/revoke/premise 供实现侧对照）
    expect(license.ttl).toBe('365d');
    expect(license.revoke).toBe('吊销后即时失效');
    expect(license.premise).toBe('商家完成资质认证');
  });

  test('needs-lookup → offlineVerifiable=false、lookupFailurePolicy=fail-closed（S6-3 配套）', () => {
    const entries = deriveCredentialBindings(loadModel().metadata.credentials)!;
    const token = entries.find((e) => e.name === 'payment_token')!;
    expect(token.selfContained).toBe('needs-lookup');
    expect(token.offlineVerifiable).toBe(false);
    expect(token.lookupFailurePolicy).toBe('fail-closed');
  });

  test('无凭证段 → undefined（老模型零回归，S6-5）', () => {
    expect(deriveCredentialBindings(undefined)).toBeUndefined();
    expect(deriveCredentialBindings([])).toBeUndefined();
  });
});

describe('deriveSkeletonBindings 集成（X14）', () => {
  test('骨架 credentials 段带出两条凭证的离线校验信息', () => {
    const skeleton = buildSkeleton();
    expect(skeleton[SKELETON_MARKER]).toBe(true);
    const creds = skeleton.credentials!;
    expect(creds).toHaveLength(2);
    const byName = new Map(creds.map((c) => [c.name, c]));
    expect(byName.get('merchant_license')!.offlineVerifiable).toBe(true);
    expect(byName.get('merchant_license')!.lookupFailurePolicy).toBe('fail-open');
    expect(byName.get('payment_token')!.offlineVerifiable).toBe(false);
    expect(byName.get('payment_token')!.lookupFailurePolicy).toBe('fail-closed');
  });

  test('无凭证段的老模型 → skeleton.credentials 为 undefined（S6-5）', () => {
    const noCredModel = parseProtocolContent(`---
name: 无凭证段 fixture
version: 1.0.0
purpose: 验证 X14 老模型降级
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
`);
    const skeleton = deriveSkeletonBindings(
      noCredModel,
      specify(noCredModel).specs,
      { sourceEnvelope: false, sourceMigrated: false, sourceMigrationWarnings: [] }
    );
    expect(skeleton.credentials).toBeUndefined();
  });
});
