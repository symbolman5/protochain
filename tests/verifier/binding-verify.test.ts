/**
 * 绑定驱动验证测试 —— 步骤⑩ 经真实传输执行器（mock 注入）验证接口绑定
 *
 * 覆盖范围：
 * - P0a：HTTP 触发系统接口 + 信任响应 nextState
 * - P0b：触发后经观测接口独立读取状态再比较（三步闭环）
 * - 观测接口降级：目标状态无观测绑定 → 信任动作响应 nextState / 协议预期
 * - Kafka/NSQ：fire-and-forget（responseMode=none）信任协议预期；poll 轮询收敛/超时
 * - 未绑定接口 → missing_action 偏差
 * - 无 bindings 配置时保持原行为（路径用例跳过）
 */

import { parseProtocolContent } from '../../src/parser/index.js';
import { specify } from '../../src/specifier/index.js';
import { generateCases } from '../../src/casegen/index.js';
import { validateBindings } from '../../src/binder/index.js';
import { verify, type VerifyContext } from '../../src/verifier/index.js';
import type {
  SourceProtocolModel,
  BindingConfig,
  TestCaseSet,
} from '../../src/model/types.js';
import type { TransportResult } from '../../src/transport/types.js';
import type { TransportExecutorFn } from '../../src/verifier/binding-runner.js';

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

/** 构造 mock 传输执行器：按 spec.name 分发到 handler */
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

function makeRoleBindingConfig(
  interfaces: BindingConfig['interfaces']
): BindingConfig {
  return {
    roles: {
      R: { roleId: 'R', baseUrl: 'http://mock.local/api', auth: 'none' },
    },
    interfaces,
  };
}

/** 运行一次绑定驱动验证 */
async function runBindingVerify(
  model: SourceProtocolModel,
  bindings: BindingConfig,
  transport: TransportExecutorFn
): Promise<{ report: Awaited<ReturnType<typeof verify>> }> {
  const specs = specify(model);
  const testCases = generateCases(model, { criterion: 'state' });
  const ctx: VerifyContext = {
    rootDir: '.',
    testCases,
    specs,
    bindings,
    transportExecutor: transport,
  };
  return { report: await verify(model, ctx) };
}

function ok(data: unknown, status = 200): TransportResult {
  return { status, data, ok: status >= 200 && status < 300 };
}

function fail(status: number, error: string): TransportResult {
  return { status, data: { error }, ok: false };
}

// ---------------------------------------------------------------------------
// P0a：HTTP 触发 + 信任 nextState
// ---------------------------------------------------------------------------

describe('P0a：HTTP 触发系统接口 + 信任 nextState', () => {
  const model = parseProtocolContent(`---
name: 简化协议
version: 1.0.0
purpose: P0a 测试
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

  test('动作响应 nextState 与协议预期一致 → 通过', async () => {
    const bindings = makeRoleBindingConfig([
      { action: 'go', roleId: 'R', transport: { type: 'http', method: 'POST', path: '/go', params: [] } },
    ]);
    const transport = makeTransport({ go: () => ok({ nextState: 'S2' }) });
    const { report } = await runBindingVerify(model, bindings, transport);
    expect(report.authoritative.counts).toEqual({ passed: 1, failed: 0, skipped: 0 });
    expect(report.authoritative.passed).toBe(true);
  });

  test('动作响应 nextState 与协议预期不一致 → state_mismatch 偏差', async () => {
    const bindings = makeRoleBindingConfig([
      { action: 'go', roleId: 'R', transport: { type: 'http', method: 'POST', path: '/go', params: [] } },
    ]);
    const transport = makeTransport({ go: () => ok({ nextState: 'S1' }) });
    const { report } = await runBindingVerify(model, bindings, transport);
    expect(report.authoritative.counts.failed).toBe(1);
    expect(report.authoritative.caseResults[0].deviations?.[0].kind).toBe('state_mismatch');
  });

  test('接口调用失败（500）→ 偏差', async () => {
    const bindings = makeRoleBindingConfig([
      { action: 'go', roleId: 'R', transport: { type: 'http', method: 'POST', path: '/go', params: [] } },
    ]);
    const transport = makeTransport({ go: () => fail(500, 'Internal Server Error') });
    const { report } = await runBindingVerify(model, bindings, transport);
    expect(report.authoritative.counts.failed).toBe(1);
  });

  test('接口未绑定 → missing_action 偏差', async () => {
    // 系统接口 go 无绑定，但观测接口齐全（避免 validate 语义干扰；验证器只按缺失处理）
    const bindings = makeRoleBindingConfig([
      { action: 'observe_初态', roleId: 'R', transport: { type: 'http', method: 'GET', path: '/s1', params: [] } },
      { action: 'observe_终态', roleId: 'R', transport: { type: 'http', method: 'GET', path: '/s2', params: [] } },
    ]);
    const transport = makeTransport({});
    const { report } = await runBindingVerify(model, bindings, transport);
    expect(report.authoritative.counts.failed).toBe(1);
    expect(report.authoritative.caseResults[0].deviations?.[0].kind).toBe('missing_action');
  });
});

// ---------------------------------------------------------------------------
// P0b：触发 + 观测接口独立读 + 比较
// ---------------------------------------------------------------------------

describe('P0b：触发 + 观测接口独立读 + 比较', () => {
  const model = parseProtocolContent(`---
name: 审批协议
version: 1.0.0
purpose: P0b 测试
roles:
  - id: user
    name: 用户
---
# 背景
测试

# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S1 | 草稿 | initial |
| S2 | 待审批 | normal |
| S3 | 已通过 | terminal |

# 转移规则

| ID | 名称 | from | to | action | trigger |
|---|---|---|---|---|---|
| T1 | 提交 | S1 | S2 | submit | user |
| T2 | 通过 | S2 | S3 | approve | user |
`);

  const bindings = makeRoleBindingConfig([
    { action: 'submit', roleId: 'R', transport: { type: 'http', method: 'POST', path: '/submit', params: [] } },
    { action: 'approve', roleId: 'R', transport: { type: 'http', method: 'POST', path: '/approve', params: [] } },
    { action: 'observe_待审批', roleId: 'R', transport: { type: 'http', method: 'GET', path: '/state/S2', params: [] } },
    { action: 'observe_已通过', roleId: 'R', transport: { type: 'http', method: 'GET', path: '/state/S3', params: [] } },
  ]);

  test('观测接口读取状态与协议预期一致 → 通过（不信任动作响应 nextState）', async () => {
    const transport = makeTransport({
      submit: () => ok({ nextState: 'S2' }),
      approve: () => ok({ nextState: 'S3' }),
      observe_待审批: () => ok({ currentState: 'S2' }),
      observe_已通过: () => ok({ currentState: 'S3' }),
    });
    const { report } = await runBindingVerify(model, bindings, transport);
    expect(report.authoritative.counts).toEqual({ passed: 1, failed: 0, skipped: 0 });
  });

  test('观测接口读取状态与预期不一致 → state_mismatch 偏差（即使动作响应正确）', async () => {
    const transport = makeTransport({
      submit: () => ok({ nextState: 'S2' }),
      observe_待审批: () => ok({ currentState: 'S1' }), // 独立观测发现仍停留在 S1
    });
    const { report } = await runBindingVerify(model, bindings, transport);
    expect(report.authoritative.counts.failed).toBe(1);
    expect(report.authoritative.caseResults[0].deviations?.[0].kind).toBe('state_mismatch');
  });

  test('观测接口返回 isInState 字段也可判定', async () => {
    const transport = makeTransport({
      submit: () => ok({ nextState: 'S2' }),
      approve: () => ok({ nextState: 'S3' }),
      observe_待审批: () => ok({ isInState: 'S2' }),
      observe_已通过: () => ok({ isInState: 'S3' }),
    });
    const { report } = await runBindingVerify(model, bindings, transport);
    expect(report.authoritative.passed).toBe(true);
  });

  test('观测接口失败（500）→ 偏差', async () => {
    const transport = makeTransport({
      submit: () => ok({ nextState: 'S2' }),
      observe_待审批: () => fail(500, 'obs down'),
    });
    const { report } = await runBindingVerify(model, bindings, transport);
    expect(report.authoritative.counts.failed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 观测接口降级
// ---------------------------------------------------------------------------

describe('观测接口降级', () => {
  const model = parseProtocolContent(`---
name: 降级协议
version: 1.0.0
purpose: 降级测试
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

  test('目标状态无观测绑定、响应也无 nextState → 降级信任协议预期', async () => {
    const bindings = makeRoleBindingConfig([
      { action: 'go', roleId: 'R', transport: { type: 'http', method: 'POST', path: '/go', params: [] } },
    ]);
    const transport = makeTransport({ go: () => ok({}) }); // 无 nextState
    const { report } = await runBindingVerify(model, bindings, transport);
    expect(report.authoritative.counts).toEqual({ passed: 1, failed: 0, skipped: 0 });
  });
});

// ---------------------------------------------------------------------------
// Kafka / NSQ 传输模式
// ---------------------------------------------------------------------------

describe('Kafka/NSQ 传输模式', () => {
  const model = parseProtocolContent(`---
name: 消息协议
version: 1.0.0
purpose: 消息测试
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
| T1 | 发消息 | S1 | S2 | fire | user |
`);

  test('fire-and-forget（responseMode=none）：发送后信任协议预期', async () => {
    const bindings = makeRoleBindingConfig([
      { action: 'fire', roleId: 'R', transport: { type: 'kafka', topic: 'events', serde: 'json', responseMode: 'none' } },
    ]);
    const transport = makeTransport({ fire: () => ok({ sent: true }) });
    const { report } = await runBindingVerify(model, bindings, transport);
    expect(report.authoritative.counts).toEqual({ passed: 1, failed: 0, skipped: 0 });
  });

  test('poll 模式：发送后轮询观测接口直至状态收敛', async () => {
    const bindings = makeRoleBindingConfig([
      { action: 'fire', roleId: 'R', transport: { type: 'nsq', topic: 'events', serde: 'json', responseMode: 'poll' } },
      { action: 'observe_终态', roleId: 'R', transport: { type: 'http', method: 'GET', path: '/state/S2', params: [] } },
    ]);
    let calls = 0;
    const transport = makeTransport({
      fire: () => ok({ sent: true, pollMode: true }),
      observe_终态: () => {
        calls++;
        return calls >= 2 ? ok({ currentState: 'S2' }) : ok({ currentState: 'S1' });
      },
    });
    const specs = specify(model);
    const testCases = generateCases(model, { criterion: 'state' });
    const report = await verify(model, {
      rootDir: '.',
      testCases,
      specs,
      bindings,
      transportExecutor: transport,
    });
    expect(report.authoritative.counts).toEqual({ passed: 1, failed: 0, skipped: 0 });
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  test('poll 模式：超时未收敛 → 偏差', async () => {
    const bindings = makeRoleBindingConfig([
      { action: 'fire', roleId: 'R', transport: { type: 'kafka', topic: 'events', serde: 'json', responseMode: 'poll' } },
      { action: 'observe_终态', roleId: 'R', transport: { type: 'http', method: 'GET', path: '/state/S2', params: [] } },
    ]);
    const transport = makeTransport({
      fire: () => ok({ sent: true, pollMode: true }),
      observe_终态: () => ok({ currentState: 'S1' }), // 永远不收敛
    });
    const specs = specify(model);
    const testCases = generateCases(model, { criterion: 'state' });
    const report = await verify(model, {
      rootDir: '.',
      testCases,
      specs,
      bindings,
      transportExecutor: transport,
      pollTimeoutMs: 300,
      pollIntervalMs: 50,
    });
    expect(report.authoritative.counts.failed).toBe(1);
    expect(report.authoritative.caseResults[0].deviations?.[0].kind).toBe('state_mismatch');
  });

  test('poll 模式无观测绑定 → missing_action 偏差', async () => {
    const bindings = makeRoleBindingConfig([
      { action: 'fire', roleId: 'R', transport: { type: 'kafka', topic: 'events', serde: 'json', responseMode: 'poll' } },
    ]);
    const transport = makeTransport({ fire: () => ok({ sent: true, pollMode: true }) });
    const { report } = await runBindingVerify(model, bindings, transport);
    expect(report.authoritative.counts.failed).toBe(1);
    expect(report.authoritative.caseResults[0].deviations?.[0].kind).toBe('missing_action');
  });

  test('reply_topic 模式：按 P0a/P0b 判定响应数据', async () => {
    const bindings = makeRoleBindingConfig([
      { action: 'fire', roleId: 'R', transport: { type: 'kafka', topic: 'req', serde: 'json', responseMode: 'reply_topic', responseTopic: 'resp', correlationIdField: 'correlation_id' } },
    ]);
    const transport = makeTransport({ fire: () => ok({ nextState: 'S2', correlation_id: 'abc' }) });
    const { report } = await runBindingVerify(model, bindings, transport);
    expect(report.authoritative.counts).toEqual({ passed: 1, failed: 0, skipped: 0 });
  });
});

// ---------------------------------------------------------------------------
// 运行时参数来源：响应字段注入 + 场景文件 params + 状态词表
// ---------------------------------------------------------------------------

describe('运行时参数来源（响应注入 / 场景参数 / 状态词表）', () => {
  const model = parseProtocolContent(`---
name: 服务器生命周期
version: 1.0.0
purpose: 运行时参数测试
roles:
  - id: operator
    name: 运维
---
# 背景
测试

# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S0 | 未添加 | initial |
| S1 | 离线 | normal |
| S4 | 已退役 | terminal |

# 转移规则

| ID | 名称 | from | to | action |
|---|---|---|---|---|
| T1 | 添加 | S0 | S1 | add |
| T6 | 退役 | S1 | S4 | retire |
`);
  const specs = specify(model);
  const testCases = generateCases(model, { criterion: 'state' });

  function makeBindings(): BindingConfig {
    return makeRoleBindingConfig([
      { action: 'add', roleId: 'R', transport: { type: 'http', method: 'POST', path: '/v1/servers', params: [] } },
      { action: 'retire', roleId: 'R', transport: { type: 'http', method: 'POST', path: '/v1/servers/{serverId}/retire', params: [] } },
      { action: 'observe_离线', roleId: 'R', transport: { type: 'http', method: 'GET', path: '/v1/servers/{serverId}', params: [] } },
      { action: 'observe_已退役', roleId: 'R', transport: { type: 'http', method: 'GET', path: '/v1/servers/{serverId}', params: [] } },
    ]);
  }

  test('add 响应的 serverId 注入后续 {serverId} 路径模板（P0b 观测经 status 字段判定）', async () => {
    let retireParams: Record<string, unknown> | undefined;
    const transport = makeTransport({
      add: () => ok({ serverId: 'srv-001', status: 'S1' }),
      retire: (params) => {
        retireParams = { ...params };
        return ok({ serverId: 'srv-001', status: 'S4' });
      },
      observe_离线: () => ok({ serverId: 'srv-001', status: 'S1' }),
      observe_已退役: () => ok({ serverId: 'srv-001', status: 'S4' }),
    });
    const report = await verify(model, {
      rootDir: '.',
      testCases,
      specs,
      bindings: makeBindings(),
      transportExecutor: transport,
    });
    expect(report.authoritative.counts).toEqual({ passed: 1, failed: 0, skipped: 0 });
    // retire 调用收到的 runtimeParams 携带注入的 serverId
    expect(retireParams?.serverId).toBe('srv-001');
  });

  test('场景文件 params 优先于响应注入（种子字段不被响应覆盖）', async () => {
    let retireParams: Record<string, unknown> | undefined;
    const transport = makeTransport({
      add: () => ok({ serverId: 'response-id', status: 'S1' }),
      retire: (params) => {
        retireParams = { ...params };
        return ok({ serverId: 'response-id', status: 'S4' });
      },
      observe_离线: () => ok({ serverId: 'response-id', status: 'S1' }),
      observe_已退役: () => ok({ serverId: 'response-id', status: 'S4' }),
    });
    const report = await verify(model, {
      rootDir: '.',
      testCases,
      specs,
      bindings: makeBindings(),
      transportExecutor: transport,
      scenarios: [
        { id: 'SC1', expectedActions: ['add', 'retire'], params: { serverId: 'fixed-id' } },
      ],
    });
    expect(report.authoritative.passed).toBe(true);
    // 场景种子 fixed-id 优先，响应注入的 response-id 不覆盖
    expect(retireParams?.serverId).toBe('fixed-id');
  });

  test('#14 内核修复：场景数组/对象参数注入 body（nics 数组不再被静默跳过）', async () => {
    let addParams: Record<string, unknown> | undefined;
    const transport = makeTransport({
      add: (params) => {
        addParams = { ...params };
        return ok({ serverId: 'srv-001', status: 'S1' });
      },
      retire: () => ok({ serverId: 'srv-001', status: 'S4' }),
      observe_离线: () => ok({ serverId: 'srv-001', status: 'S1' }),
      observe_已退役: () => ok({ serverId: 'srv-001', status: 'S4' }),
    });
    const report = await verify(model, {
      rootDir: '.',
      testCases,
      specs,
      bindings: makeRoleBindingConfig([
        { action: 'add', roleId: 'R', transport: { type: 'http', method: 'POST', path: '/v1/servers', params: [{ logicalName: 'nics', in: 'body' }] } },
        { action: 'retire', roleId: 'R', transport: { type: 'http', method: 'POST', path: '/v1/servers/{serverId}/retire', params: [] } },
        { action: 'observe_离线', roleId: 'R', transport: { type: 'http', method: 'GET', path: '/v1/servers/{serverId}', params: [] } },
        { action: 'observe_已退役', roleId: 'R', transport: { type: 'http', method: 'GET', path: '/v1/servers/{serverId}', params: [] } },
      ]),
      transportExecutor: transport,
      scenarios: [
        { id: 'SC-NICS', expectedActions: ['add', 'retire'], params: { nics: [{ internalIp: '10.0.0.1', publicIp: '203.0.113.1' }] } },
      ],
    });
    expect(report.authoritative.passed).toBe(true);
    expect(addParams?.nics).toEqual([{ internalIp: '10.0.0.1', publicIp: '203.0.113.1' }]);
  });

  test('#14 内核修复：场景种子字段阻止响应注入时产生显式告警（不再静默）', async () => {
    const transport = makeTransport({
      add: () => ok({ serverId: 'response-id', status: 'S1' }),
      retire: () => ok({ serverId: 'response-id', status: 'S4' }),
      observe_离线: () => ok({ serverId: 'response-id', status: 'S1' }),
      observe_已退役: () => ok({ serverId: 'response-id', status: 'S4' }),
    });
    const report = await verify(model, {
      rootDir: '.',
      testCases,
      specs,
      bindings: makeBindings(),
      transportExecutor: transport,
      scenarios: [
        { id: 'SC1', expectedActions: ['add', 'retire'], params: { serverId: 'fixed-id' } },
      ],
    });
    expect(report.authoritative.passed).toBe(true); // 告警不阻断
    expect(report.authoritative.scenarioWarnings?.some((w) => w.includes('serverId') && w.includes('冲突'))).toBe(true);
  });

  test('状态词表映射：观测返回系统词汇（status: online）经 stateMap 归一化后通过', async () => {
    const m = parseProtocolContent(`---
name: 词表协议
version: 1.0.0
purpose: stateMap 测试
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

| ID | 名称 | from | to | action |
|---|---|---|---|---|
| T1 | 上线 | S1 | S2 | go |
`);
    const bindings = makeRoleBindingConfig([
      { action: 'go', roleId: 'R', transport: { type: 'http', method: 'POST', path: '/go', params: [] } },
      { action: 'observe_终态', roleId: 'R', transport: { type: 'http', method: 'GET', path: '/state', params: [] } },
    ]);
    const transport = makeTransport({
      go: () => ok({}),
      observe_终态: () => ok({ status: 'online' }), // 系统词汇
    });
    const report = await verify(m, {
      rootDir: '.',
      testCases: generateCases(m, { criterion: 'state' }),
      specs: specify(m),
      bindings: { ...bindings, stateMap: { S2: 'online' } },
      transportExecutor: transport,
    });
    expect(report.authoritative.counts).toEqual({ passed: 1, failed: 0, skipped: 0 });
  });

  test('状态词表映射不匹配时仍报偏差', async () => {
    const m = parseProtocolContent(`---
name: 词表协议2
version: 1.0.0
purpose: stateMap 负例
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

| ID | 名称 | from | to | action |
|---|---|---|---|---|
| T1 | 上线 | S1 | S2 | go |
`);
    const bindings = makeRoleBindingConfig([
      { action: 'go', roleId: 'R', transport: { type: 'http', method: 'POST', path: '/go', params: [] } },
      { action: 'observe_终态', roleId: 'R', transport: { type: 'http', method: 'GET', path: '/state', params: [] } },
    ]);
    const transport = makeTransport({
      go: () => ok({}),
      observe_终态: () => ok({ status: 'offline' }), // 映射表是 {S2: online}，offline 不匹配
    });
    const report = await verify(m, {
      rootDir: '.',
      testCases: generateCases(m, { criterion: 'state' }),
      specs: specify(m),
      bindings: { ...bindings, stateMap: { S2: 'online' } },
      transportExecutor: transport,
    });
    expect(report.authoritative.counts.failed).toBe(1);
    expect(report.authoritative.caseResults[0].deviations?.[0].kind).toBe('state_mismatch');
  });
});

// ---------------------------------------------------------------------------
// 多协议 bindings 隔离（protocol 字段）
// ---------------------------------------------------------------------------

describe('多协议 bindings 隔离（protocol 字段）', () => {
  const model = parseProtocolContent(`---
name: 通用操作协议
version: 1.0.0
purpose: protocol 隔离测试
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

| ID | 名称 | from | to | action |
|---|---|---|---|---|
| T1 | 操作 | S1 | S2 | enable |
`);
  const specs = specify(model);
  const testCases = generateCases(model, { criterion: 'state' });

  function http(path: string): BindingConfig['interfaces'][number]['transport'] {
    return { type: 'http', method: 'POST', path, params: [] };
  }

  test('verify 按 protocolId 过滤同名 action，命中 P3 绑定而非 P2', async () => {
    const bindings = makeRoleBindingConfig([
      { action: 'enable', roleId: 'R', protocol: 'P2', transport: http('/v2/enable') },
      { action: 'enable', roleId: 'R', protocol: 'P3', transport: http('/v3/enable') },
    ]);
    let hitPath: string | undefined;
    const transport: TransportExecutorFn = async (resolved) => {
      hitPath = (resolved?.binding?.transport as { path: string }).path;
      return ok({ nextState: 'S2' });
    };
    const report = await verify(model, {
      rootDir: '.',
      testCases,
      specs,
      bindings,
      protocolId: 'P3',
      transportExecutor: transport,
    });
    expect(report.authoritative.passed).toBe(true);
    expect(hitPath).toBe('/v3/enable');
  });

  test('protocol 命中优先于未打标兜底条目', async () => {
    const bindings = makeRoleBindingConfig([
      { action: 'enable', roleId: 'R', transport: http('/legacy/enable') },
      { action: 'enable', roleId: 'R', protocol: 'P3', transport: http('/v3/enable') },
    ]);
    let hitPath: string | undefined;
    const transport: TransportExecutorFn = async (resolved) => {
      hitPath = (resolved?.binding?.transport as { path: string }).path;
      return ok({ nextState: 'S2' });
    };
    await verify(model, {
      rootDir: '.',
      testCases,
      specs,
      bindings,
      protocolId: 'P3',
      transportExecutor: transport,
    });
    expect(hitPath).toBe('/v3/enable');
  });

  test('其他协议的绑定被剔除：P3 verify 不用 P2 的 enable → missing_action', async () => {
    const bindings = makeRoleBindingConfig([
      { action: 'enable', roleId: 'R', protocol: 'P2', transport: http('/v2/enable') },
    ]);
    const report = await verify(model, {
      rootDir: '.',
      testCases,
      specs,
      bindings,
      protocolId: 'P3',
      transportExecutor: makeTransport({}),
    });
    expect(report.authoritative.counts.failed).toBe(1);
    expect(report.authoritative.caseResults[0].deviations?.[0].kind).toBe('missing_action');
  });

  test('bind 按协议校验：P3 绑定齐全时 P3 通过、P2 缺失', async () => {
    const bindings = makeRoleBindingConfig([
      { action: 'enable', roleId: 'R', protocol: 'P3', transport: http('/v3/enable') },
      { action: 'observe_初态', roleId: 'R', protocol: 'P3', transport: http('/v3/state') },
      { action: 'observe_终态', roleId: 'R', protocol: 'P3', transport: http('/v3/state') },
    ]);
    const r3 = validateBindings(specs, bindings, 'P3');
    expect(r3.valid).toBe(true);
    const r2 = validateBindings(specs, bindings, 'P2');
    expect(r2.valid).toBe(false);
    expect(r2.missingSystem).toContain('enable');
    expect(r2.missingObservation).toContain('observe_初态');
    expect(r2.missingObservation).toContain('observe_终态');
  });

  test('未打标条目命中时给出打标建议告警', async () => {
    const bindings = makeRoleBindingConfig([
      { action: 'enable', roleId: 'R', transport: http('/legacy/enable') },
      { action: 'observe_初态', roleId: 'R', transport: http('/legacy/state') },
      { action: 'observe_终态', roleId: 'R', transport: http('/legacy/state') },
    ]);
    const report = validateBindings(specs, bindings, 'P3');
    expect(report.valid).toBe(true);
    expect(report.warnings.some((w) => w.includes('protocol: P3'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 无 bindings：保持原行为
// ---------------------------------------------------------------------------

describe('无 bindings 配置', () => {
  const model = parseProtocolContent(`---
name: 无绑定协议
version: 1.0.0
purpose: 回归测试
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

  test('未提供 bindings 与实现时路径用例跳过', async () => {
    const testCases = generateCases(model, { criterion: 'state' });
    const report = await verify(model, { rootDir: '.', testCases });
    expect(report.authoritative.counts.skipped).toBe(testCases.paths.length);
  });
});

// ---------------------------------------------------------------------------
// 多路径用例（P1 生命周期循环类）：绑定模式全量执行
// ---------------------------------------------------------------------------

describe('循环生命周期协议绑定验证', () => {
  const model = parseProtocolContent(`---
name: 生命周期协议
version: 1.0.0
purpose: 绑定验证
roles:
  - id: operator
    name: 运维
---
# 背景
测试

# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S0 | 未添加 | initial |
| S1 | 离线 | normal |
| S2 | 在线 | normal |
| S3 | 维护中 | normal |
| S4 | 已退役 | terminal |

# 转移规则

| ID | 名称 | from | to | action |
|---|---|---|---|---|
| T1 | 添加 | S0 | S1 | add |
| T2 | 上线 | S1 | S2 | go_online |
| T3 | 维护 | S2 | S3 | maintain |
| T4 | 恢复 | S3 | S2 | restore |
| T5 | 下线 | S2 | S1 | go_offline |
| T6 | 退役 | S1 | S4 | retire |
`);
  const specs = specify(model);
  const testCases = generateCases(model, { criterion: 'state' });
  const allBindings: NonNullable<BindingConfig['interfaces']> = [
    { action: 'add', roleId: 'R', transport: { type: 'http', method: 'POST', path: '/add', params: [] } },
    { action: 'go_online', roleId: 'R', transport: { type: 'http', method: 'POST', path: '/online', params: [] } },
    { action: 'maintain', roleId: 'R', transport: { type: 'http', method: 'POST', path: '/maintain', params: [] } },
    { action: 'restore', roleId: 'R', transport: { type: 'http', method: 'POST', path: '/restore', params: [] } },
    { action: 'go_offline', roleId: 'R', transport: { type: 'http', method: 'POST', path: '/offline', params: [] } },
    { action: 'retire', roleId: 'R', transport: { type: 'http', method: 'POST', path: '/retire', params: [] } },
  ];
  const bindings = makeRoleBindingConfig(allBindings);

  test('动作响应均正确时，3 条路径全部通过', async () => {
    const transport = makeTransport({
      add: () => ok({ nextState: 'S1' }),
      go_online: () => ok({ nextState: 'S2' }),
      maintain: () => ok({ nextState: 'S3' }),
      restore: () => ok({ nextState: 'S2' }),
      go_offline: () => ok({ nextState: 'S1' }),
      retire: () => ok({ nextState: 'S4' }),
    });
    const report = await verify(model, { rootDir: '.', testCases, specs, bindings, transportExecutor: transport });
    expect(report.authoritative.counts.passed).toBe(testCases.paths.length);
    expect(report.authoritative.counts.failed).toBe(0);
  });
});
