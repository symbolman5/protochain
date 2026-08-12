/**
 * verify 偏差详情与场景可观测性守卫测试 —— 对应工具链问题清单 #5 / #6
 *
 * #5：失败用例 deviations 应记录结构化 httpStatus / responseBody / stepIndex；
 *     transport 抛异常应被 safeTransport 捕获，不致 verify 整体 reject。
 * #6：场景未命中应记 scenarioMatch=null + scenarioWarnings；命中应记 injectedParams 来源；
 *     无观测绑定的 P0a 盲信应标 degraded=true。
 */

import { parseProtocolContent } from '../../src/parser/index.js';
import { specify } from '../../src/specifier/index.js';
import { generateCases } from '../../src/casegen/index.js';
import { verify, type VerifyContext } from '../../src/verifier/index.js';
import type { ScenarioParamSource, TransportExecutorFn } from '../../src/verifier/binding-runner.js';
import type { BindingConfig, SourceProtocolModel } from '../../src/model/types.js';
import type { TransportResult } from '../../src/transport/types.js';

function makeTransport(
  handlers: Record<string, (params: Record<string, unknown>) => TransportResult>
): TransportExecutorFn {
  return async (resolved, params) => {
    if (!resolved?.binding) {
      return { status: 404, data: { error: '接口未绑定' }, ok: false };
    }
    const handler = handlers[resolved.spec.name];
    if (!handler) {
      return { status: 404, data: { error: `未找到 ${resolved.spec.name} 的 mock` }, ok: false };
    }
    return handler(params);
  };
}

function makeConfig(interfaces: BindingConfig['interfaces']): BindingConfig {
  return {
    roles: { R: { roleId: 'R', baseUrl: 'http://mock.local/api', auth: 'none' } },
    interfaces,
  };
}

function ok(data: unknown, status = 200): TransportResult {
  return { status, data, ok: status >= 200 && status < 300 };
}
function fail(status: number, error: string): TransportResult {
  return { status, data: { error }, ok: false };
}

const MODEL: SourceProtocolModel = parseProtocolContent(`---
name: 简化协议
version: 1.0.0
purpose: 偏差详情测试
roles:
  - id: user
    name: 用户
---
# 背景
测试

# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S1 | 初态 | initial |
| S2 | 终态 | terminal |

# 转移规则

| ID | 名称 | from | to | action | trigger |
|---|---|---|---|---|---|
| T1 | 走 | S1 | S2 | go | user |
`);

async function runVerify(
  bindings: BindingConfig,
  transport: TransportExecutorFn,
  scenarios?: ScenarioParamSource[]
) {
  const specs = specify(MODEL);
  const testCases = generateCases(MODEL, { criterion: 'state' });
  const ctx: VerifyContext = {
    rootDir: '.',
    testCases,
    specs,
    bindings,
    transportExecutor: transport,
    scenarios,
  };
  return verify(MODEL, ctx);
}

const goBinding = makeConfig([
  { action: 'go', roleId: 'R', transport: { type: 'http', method: 'POST', path: '/go', params: [] } },
]);

describe('#5 失败用例偏差详情', () => {
  test('接口 500 → deviation 含 httpStatus/responseBody/stepIndex', async () => {
    const transport = makeTransport({ go: () => fail(500, 'internal error') });
    const report = await runVerify(goBinding, transport);
    const dev = report.authoritative.caseResults[0].deviations?.[0];
    expect(dev).toBeDefined();
    expect(dev!.httpStatus).toBe(500);
    expect(dev!.responseBody).toEqual({ error: 'internal error' });
    expect(dev!.stepIndex).toBe(0);
    expect(dev!.kind).toBe('state_mismatch');
  });

  test('transport 抛异常 → safeTransport 捕获，verify 不崩，deviation 记录', async () => {
    const throwingTransport: TransportExecutorFn = async () => {
      throw new Error('ECONNREFUSED');
    };
    const report = await runVerify(goBinding, throwingTransport);
    const dev = report.authoritative.caseResults[0].deviations?.[0];
    expect(dev).toBeDefined();
    expect(dev!.actual).toContain('传输异常');
    expect(dev!.httpStatus).toBe(0);
    expect(report.authoritative.counts.failed).toBe(1);
  });
});

describe('#6 场景命中可观测性与降级标记', () => {
  test('声明场景但未命中 → scenarioMatch=null + scenarioWarnings 非空', async () => {
    const transport = makeTransport({ go: () => ok({ nextState: 'S2' }) });
    const scenarios: ScenarioParamSource[] = [
      { id: 'SC1', expectedActions: ['nonexistent'], params: {} },
    ];
    const report = await runVerify(goBinding, transport, scenarios);
    expect(report.authoritative.caseResults[0].scenarioMatch).toBeNull();
    expect(report.authoritative.scenarioWarnings?.length).toBeGreaterThan(0);
    expect(report.authoritative.scenarioWarnings![0]).toContain('没有任何测试路径命中');
  });

  test('无观测绑定 + 响应无 nextState → degraded=true（盲信协议预期）', async () => {
    const transport = makeTransport({ go: () => ok({}) });
    const report = await runVerify(goBinding, transport);
    const cr = report.authoritative.caseResults[0];
    expect(cr.passed).toBe(true);
    expect(cr.degraded).toBe(true);
  });

  test('场景命中 → scenarioMatch.id + injectedParams 来源明细', async () => {
    const transport = makeTransport({ go: () => ok({ nextState: 'S2', serverId: 's1' }) });
    const scenarios: ScenarioParamSource[] = [
      { id: 'SC1', expectedActions: ['go'], params: { tenantId: 't1' } },
    ];
    const report = await runVerify(goBinding, transport, scenarios);
    const cr = report.authoritative.caseResults[0];
    expect(cr.scenarioMatch?.id).toBe('SC1');
    expect(cr.injectedParams?.tenantId).toBe('scenario');
    expect(cr.injectedParams?.serverId).toBe('response');
    expect(cr.degraded).toBeUndefined();
  });
});
