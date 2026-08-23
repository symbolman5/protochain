/**
 * E11 ok=false → errorMap 判定 — verifier 单测
 *
 * 设计依据：IMPLEMENTATION-PLAN.md §E11、docs/error-modeling-plan.md §3.4
 *
 * 覆盖：
 * - 命中 errorMap 且场景层 expectedError 匹配 → ✓ 通过
 * - 命中 errorMap 但场景层未声明 expectedError → unexpected_error
 * - 未命中 errorMap → error_mismatch 偏差
 * - httpStatus ≥ 500 → system_fault 计数（不参与失败）
 * - VerificationReport.errorSummary 聚合
 * - 场景加载 expectedError（loadScenarioParams）
 */

import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { parseProtocolContent } from '../../src/parser/index.js';
import { specify, specsFromEnvelope } from '../../src/specifier/index.js';
import { generateCases } from '../../src/casegen/index.js';
import {
  verify,
  type VerifyContext,
} from '../../src/verifier/index.js';
import {
  loadScenarioParams,
  type ScenarioParamSource,
} from '../../src/verifier/binding-runner.js';
import type {
  SourceProtocolModel,
  BindingConfig,
  TestCaseSet,
  ErrorMapEntry,
  TransportResult,
} from '../../src/model/types.js';
import type { TransportExecutorFn } from '../../src/verifier/binding-runner.js';

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

function makeProtocolModel(): SourceProtocolModel {
  const md = `---
name: E11 verifier
version: 1.0.0
purpose: errorMap 判定
roles:
  - id: r
    name: role
---
# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S1 | 初始 | initial |
| S2 | 终态 | terminal |
| S3 | error | error |

# 转移规则

| ID | 名称 | from | to | action | trigger |
|---|---|---|---|---|---|
| T1 | 注册 | S1 | S2 | register | r |
| T2 | 触发错误 | S1 | S3 | trigger_error | r |

# 异常路径

| ID | 名称 | 触发 | 转移序列 | 错误码 |
|---|---|---|---|---|
| EX1 | 域名未归属 | trg | T1 | domain_not_owned |
| EX2 | 域名被占 | trg | T1 | domain_taken |

# 契约层

\`\`\`yaml
parties:
  - r
contracts:
  - interface: register
    errorResponses:
      - id: ERR-01
        errorCode: domain_not_owned
        httpStatus: 409
      - id: ERR-02
        errorCode: domain_taken
        httpStatus: 409
  - interface: trigger_error
    errorResponses:
      - id: ERR-03
        errorCode: domain_taken
        httpStatus: 409
\`\`\`
`;
  return parseProtocolContent(md, 'test.md');
}

function makeTransport(handlerMap: Record<string, (params: Record<string, unknown>) => TransportResult>): TransportExecutorFn {
  return async (resolved, params) => {
    if (!resolved?.binding) return { status: 404, data: { error: 'unbound' }, ok: false };
    const handler = handlerMap[resolved.spec.name];
    if (!handler) return { status: 404, data: { error: `no handler for ${resolved.spec.name}` }, ok: false };
    return handler(params);
  };
}

function makeBindings(): BindingConfig {
  return {
    roles: { r: { roleId: 'r', baseUrl: 'http://mock.local', auth: 'none' } },
    interfaces: [
      { action: 'register', roleId: 'r', transport: { type: 'http', method: 'POST', path: '/r', params: [] } },
      { action: 'trigger_error', roleId: 'r', transport: { type: 'http', method: 'POST', path: '/te', params: [] } },
    ],
    errorMap: {
      domain_not_owned: { httpStatus: 409, bodyField: 'code', systemCode: 'E40901', bodyFieldValue: 'DOMAIN_NOT_OWNED' },
      domain_taken: { httpStatus: 409, bodyField: 'code', systemCode: 'E40902', bodyFieldValue: 'DOMAIN_TAKEN' },
    },
  };
}

async function runVerify(
  model: SourceProtocolModel,
  bindings: BindingConfig,
  transport: TransportExecutorFn,
  scenarios: ScenarioParamSource[] = []
) {
  const specs = specsFromEnvelope(specify(model));
  const testCases: TestCaseSet = generateCases(model, { criterion: 'state' });
  const ctx: VerifyContext = {
    rootDir: '.',
    testCases,
    specs,
    bindings,
    transportExecutor: transport,
    scenarios,
  };
  return verify(model, ctx);
}

// ---------------------------------------------------------------------------
// 1. 命中 errorMap 且场景层 expectedError 匹配 → 通过
// ---------------------------------------------------------------------------

describe('verifier - E11 errorMap 判定', () => {
  test('正向：expectedError 命中 → 路径通过 + errorSummary.expected 计数', async () => {
    const model = makeProtocolModel();
    const bindings = makeBindings();

    // 场景：register → 触发 domain_not_owned（业务错误）
    const transport = makeTransport({
      register: () => ({ status: 409, data: { code: 'domain_not_owned', message: '...' }, ok: false }),
    });
    const scenarios: ScenarioParamSource[] = [
      {
        id: 'SC-DOMAIN',
        expectedActions: ['register'],
        params: {},
        expectedError: { errorCode: 'domain_not_owned', httpStatus: 409 },
      },
    ];

    const report = await runVerify(model, bindings, transport, scenarios);

    // errorSummary 已聚合
    expect(report.errorSummary).toBeDefined();
    expect(report.errorSummary?.matched.domain_not_owned).toBeGreaterThanOrEqual(1);
    expect(report.errorSummary?.expected?.domain_not_owned).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // 2. 命中 errorMap 但场景层未声明 expectedError → unexpected_error
  // -------------------------------------------------------------------------

  test('反向：未声明 expectedError + 收到业务错误 → unexpected_error 偏差', async () => {
    const model = makeProtocolModel();
    const bindings = makeBindings();

    const transport = makeTransport({
      register: () => ({ status: 409, data: { code: 'domain_not_owned', message: '...' }, ok: false }),
    });
    // 无 expectedError → 老协议路径仍期望成功

    const report = await runVerify(model, bindings, transport, []);
    // 应该有 unexpected_error 偏差
    const unexpected = report.authoritative.caseResults
      .flatMap((c) => c.deviations ?? [])
      .filter((d) => d.kind === 'unexpected_error');
    expect(unexpected.length).toBeGreaterThan(0);
    expect(report.errorSummary?.matched.domain_not_owned).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // 3. 未命中 errorMap → error_mismatch 偏差 + unmapped 计数
  // -------------------------------------------------------------------------

  test('反向：未命中 errorMap → error_mismatch 偏差 + unmapped 计数', async () => {
    const model = makeProtocolModel();
    const bindings = makeBindings();
    const transport = makeTransport({
      register: () => ({ status: 422, data: { code: 'unknown_error', message: '...' }, ok: false }),
    });
    const report = await runVerify(model, bindings, transport, []);
    const mismatches = report.authoritative.caseResults
      .flatMap((c) => c.deviations ?? [])
      .filter((d) => d.kind === 'error_mismatch');
    expect(mismatches.length).toBeGreaterThan(0);
    expect(report.errorSummary?.unmapped.length).toBeGreaterThan(0);
    expect(report.errorSummary?.unmapped[0].protocolErrorCode).toBe('unknown_error');
  });

  // -------------------------------------------------------------------------
  // 4. httpStatus ≥ 500 → systemFault 计数（不参与失败）
  // -------------------------------------------------------------------------

  test('反向：≥500 → system_fault（不计失败）', async () => {
    const model = makeProtocolModel();
    const bindings = makeBindings();
    // 5xx 是 system_fault；其余（trigger_error）走异常路径也用 5xx 表达统一归类
    const transport = makeTransport({
      register: () => ({ status: 504, data: { error: 'gateway timeout' }, ok: false }),
      trigger_error: () => ({ status: 504, data: { error: 'gateway timeout' }, ok: false }),
    });
    const report = await runVerify(model, bindings, transport, []);
    expect(report.errorSummary?.systemFault).toBeGreaterThanOrEqual(1);
    // 5xx 不入 matched / unmapped
    expect(report.errorSummary?.matched.domain_not_owned ?? 0).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 5. 兼容：errorMap 缺省 → 老协议路径不变
  // -------------------------------------------------------------------------

  test('兼容：errorMap 缺省 → 老协议路径不变（fallback state_mismatch）', async () => {
    const model = makeProtocolModel();
    const bindings = makeBindings();
    delete (bindings as { errorMap?: ErrorMapEntry }).errorMap;
    const transport = makeTransport({
      register: () => ({ status: 422, data: { error: 'some err' }, ok: false }),
    });
    const report = await runVerify(model, bindings, transport, []);
    // errorSummary 不挂在报告（因为 errorMap 缺省）
    expect(report.errorSummary).toBeUndefined();
    // 老协议：state_mismatch 偏差
    const stateMismatch = report.authoritative.caseResults
      .flatMap((c) => c.deviations ?? [])
      .filter((d) => d.kind === 'state_mismatch');
    expect(stateMismatch.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// loadScenarioParams：expectedError 字段解析
// ---------------------------------------------------------------------------

describe('loadScenarioParams - E11 expectedError', () => {
  test('正向：scenarios/sc-01.yaml 含 expectedError → 完整解析', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'scenarios-'));
    mkdirSync(join(tmp, 'protocol/scenarios'), { recursive: true });
    writeFileSync(
      join(tmp, 'protocol/scenarios/sc-01.yaml'),
      `id: SC-DOMAIN-1
expectedActions: [register]
params: {}
expectedError:
  errorCode: domain_not_owned
  httpStatus: 409
`
    );
    const loaded = loadScenarioParams(join(tmp, 'protocol/scenarios'));
    expect(loaded).toHaveLength(1);
    expect(loaded[0].expectedError?.errorCode).toBe('domain_not_owned');
    expect(loaded[0].expectedError?.httpStatus).toBe(409);
  });

  test('反向：scenarios 缺 expectedError → 兼容（undefined）', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'scenarios-'));
    mkdirSync(join(tmp, 'protocol/scenarios'), { recursive: true });
    writeFileSync(
      join(tmp, 'protocol/scenarios/sc-01.yaml'),
      `id: SC-01
expectedActions: [register]
params: {}
`
    );
    const loaded = loadScenarioParams(join(tmp, 'protocol/scenarios'));
    expect(loaded[0].expectedError).toBeUndefined();
  });

  test('反向：scenarios expectedError 非法形态 → 解析后 undefined（不抛错）', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'scenarios-'));
    mkdirSync(join(tmp, 'protocol/scenarios'), { recursive: true });
    writeFileSync(
      join(tmp, 'protocol/scenarios/sc-01.yaml'),
      `id: SC-01
expectedActions: [register]
expectedError: "not-an-object"
`
    );
    const loaded = loadScenarioParams(join(tmp, 'protocol/scenarios'));
    expect(loaded[0].expectedError).toBeUndefined();
  });
});
