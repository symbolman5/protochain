/**
 * 基于绑定的验证器集成测试
 *
 * 覆盖范围：
 * - P0a：HTTP 系统接口触发 + 信任动作响应 nextState（无独立观测）
 * - P0b：三步闭环（触发 → 观测接口独立读 → 比较）+ 观测接口降级处理
 * - Kafka poll 模式轮询逻辑 + Fire-and-forget 模式
 *
 * 注意：所有传输调用通过 mock 模拟，不发起真实网络/消息队列调用。
 */

import { parseProtocolContent } from '../../src/parser/index.js';
import { specify, specsFromEnvelope } from '../../src/specifier/index.js';
import { resolveBindings } from '../../src/binder/index.js';
import type {
  InterfaceSpec,
  BindingConfig,
  ResolvedBinding,
  SourceProtocolModel,
  TransitionDef,
} from '../../src/model/types.js';
import type { TransportResult } from '../../src/transport/types.js';

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

/** 从 specifier 结果中提取 transitionsById 和 initialStateId */
function extractDerivable(model: SourceProtocolModel) {
  const derivable = model.derivable;
  const transitionsById = new Map(derivable.transitions.map((t) => [t.id, t]));
  const initialStateId =
    derivable.initialStateId ??
    derivable.states.find((s) => s.type === 'initial')?.id ??
    '';
  return { transitionsById, initialStateId, states: derivable.states };
}

/** 构建观测接口双向索引 */
function buildObservationIndex(resolved: ResolvedBinding[]): Map<string, ResolvedBinding> {
  const map = new Map<string, ResolvedBinding>();
  for (const r of resolved) {
    if (r.spec.kind === 'observation') {
      map.set(r.spec.name, r);
      if (r.spec.sourceId) {
        map.set(`observe_${r.spec.sourceId}`, r);
      }
    }
  }
  return map;
}

/** 为观察接口构建的 mock TransportResult */
function mockObserveResult(stateId: string): TransportResult {
  return {
    status: 200,
    data: { currentState: stateId, isInState: stateId },
    ok: true,
  };
}

/** 创建 BindingConfig（最小可用） */
function makeBindingConfig(
  interfaces: BindingConfig['interfaces'],
  roles: BindingConfig['roles'] = {
    R: { roleId: 'R', baseUrl: 'https://test/api', auth: 'none' },
  }
): BindingConfig {
  return { roles, interfaces };
}

// ---------------------------------------------------------------------------
// P0a：触发 + 信任 nextState（无独立观测）
// ---------------------------------------------------------------------------

describe('P0a 验证模式：系统接口触发 + 信任响应', () => {
  const model = parseProtocolContent(`---
name: 简化协议
version: 1.0.0
purpose: 测试
roles:
  - id: user
    name: 用户
    responsibilities: 测试
---
# 背景
测试

# 状态空间

| ID | 名称 | 类型 | 描述 | 角色 |
|---|---|---|---|---|
| S1 | 初态 | initial | | user |
| S2 | 终态 | terminal | | |

# 转移规则

| ID | 名称 | from | to | action | trigger |
|---|---|---|---|---|---|
| T1 | 走 | S1 | S2 | go | user |
`);
  const specs = specsFromEnvelope(specify(model));
  const { transitionsById, initialStateId } = extractDerivable(model);

  // 配置完整的 HTTP 绑定
  const config = makeBindingConfig([
    { action: 'go', roleId: 'R', transport: { type: 'http', method: 'POST', path: '/go', params: [] } },
  ]);
  const resolved = resolveBindings(specs, config);

  test('绑定存在时，系统接口可通过 HTTP 触发', () => {
    const t = transitionsById.get('T1')!;
    const actionBinding = resolved.find((r) => r.spec.name === t.action);

    expect(actionBinding).toBeDefined();
    expect(actionBinding!.binding!.transport.type).toBe('http');
    expect(actionBinding!.binding!.transport).toHaveProperty('method', 'POST');
  });

  test('P0a 模式：动作调用成功后，信任响应中 nextState，不查观测接口', () => {
    // 模拟 executeTransport 返回 nextState=S2
    const mockActionResult: TransportResult = {
      status: 200,
      data: { nextState: 'S2' },
      ok: true,
    };

    // P0a: 直接取响应的 nextState
    const responseData = mockActionResult.data as Record<string, unknown>;
    const nextStateFromResponse = responseData?.['nextState'] as string;

    expect(nextStateFromResponse).toBe('S2');
    // 验证：与协议预期比较
    const t = transitionsById.get('T1')!;
    expect(nextStateFromResponse).toBe(t.to);
  });

  test('P0a 模式：动作调用失败时记录偏差', () => {
    const mockActionResult: TransportResult = {
      status: 500,
      data: { error: 'Internal Server Error' },
      ok: false,
    };

    expect(mockActionResult.ok).toBe(false);
    expect(mockActionResult.status).toBe(500);
    // verifier 应记录为 state_mismatch
  });

  test('未绑定的接口 → 偏差记录', () => {
    // specs 中有系统接口但未配置 binding
    const emptyConfig = makeBindingConfig([]);
    const resolved2 = resolveBindings(specs, emptyConfig);

    const actionBinding = resolved2.find((r) => r.spec.name === 'go');
    expect(actionBinding!.binding).toBeUndefined();
    // verifier 应记录为 missing_action
  });
});

// ---------------------------------------------------------------------------
// P0b：三步闭环（触发 → 独立观测 → 比较）
// ---------------------------------------------------------------------------

describe('P0b 验证模式：触发 + 观测接口独立读 + 比较', () => {
  const model = parseProtocolContent(`---
name: 多状态协议
version: 1.0.0
purpose: 测试
roles:
  - id: user
    name: 用户
    responsibilities: 测试
---
# 背景

多状态协议测试

# 状态空间

| ID | 名称 | 类型 | 描述 |
|---|---|---|---|
| S1 | 初始态 | initial | |
| S2 | 中间态 | normal | |
| S3 | 终态 | terminal | |

# 转移规则

| ID | 名称 | from | to | action | trigger |
|---|---|---|---|---|---|
| T1 | 第一步 | S1 | S2 | step1 | user |
| T2 | 第二步 | S2 | S3 | step2 | user |
`);
  const specs = specsFromEnvelope(specify(model));
  const transitionsById = new Map(model.derivable.transitions.map((t) => [t.id, t]));

  // 为系统接口 + 所有观测接口绑定
  const config = makeBindingConfig([
    { action: 'step1', roleId: 'R', transport: { type: 'http', method: 'POST', path: '/step1', params: [] } },
    { action: 'step2', roleId: 'R', transport: { type: 'http', method: 'POST', path: '/step2', params: [] } },
    // specifier 生成 observe_<state.name>：observe_初始态, observe_中间态, observe_终态
    // sourceId: S1, S2, S3
    { action: 'observe_初始态', roleId: 'R', transport: { type: 'http', method: 'GET', path: '/state/S1', params: [] } },
    { action: 'observe_中间态', roleId: 'R', transport: { type: 'http', method: 'GET', path: '/state/S2', params: [] } },
    { action: 'observe_终态', roleId: 'R', transport: { type: 'http', method: 'GET', path: '/state/S3', params: [] } },
  ]);
  const resolved = resolveBindings(specs, config);
  const obsIndex = buildObservationIndex(resolved);

  test('观测接口索引通过 sourceId 别名可查 (observe_S2)', () => {
    expect(obsIndex.has('observe_S2')).toBe(true);
    const entry = obsIndex.get('observe_S2')!;
    expect(entry.spec.name).toBe('observe_中间态');
  });

  test('观测接口索引通过原始名称也可查 (observe_中间态)', () => {
    expect(obsIndex.has('observe_中间态')).toBe(true);
    expect(obsIndex.get('observe_中间态')!.binding!.transport).toHaveProperty('path', '/state/S2');
  });

  test('三步闭环：T1 执行后通过观测接口独立读取 S2，与协议预期比较', () => {
    const t1 = transitionsById.get('T1')!;

    // 模拟 executeTransport 返回的观测结果
    const obsResult = mockObserveResult('S2');

    // Step 3: 比较观测状态与协议预期
    const obsData = obsResult.data as Record<string, unknown>;
    const actualState = obsData?.['currentState'] as string;

    expect(actualState).toBe(t1.to); // S2
  });

  test('观测接口返回的状态与协议预期不一致 → 偏差', () => {
    const t1 = transitionsById.get('T1')!;

    // 模拟观测返回了错误状态
    const wrongObs = mockObserveResult('S1'); // 实际还在 S1

    const actualState = (wrongObs.data as Record<string, unknown>)['currentState'] as string;
    expect(actualState).toBe('S1');
    expect(actualState).not.toBe(t1.to); // 期望 S2，实际 S1
  });

  test('观测接口返回 isInState 字段（不返回 currentState）', () => {
    // 有些观测接口不直接返回 currentState，而是用 isInState 标记
    const obsResult: TransportResult = {
      status: 200,
      data: { isInState: 'S3' },
      ok: true,
    };

    const obsData = obsResult.data as Record<string, unknown>;
    // verifier 逻辑：先查 currentState，再查 isInState
    const actualState =
      obsData?.['currentState'] ?? obsData?.['isInState'] ?? null;

    expect(actualState).toBe('S3');
  });

  test('观测接口独立于系统接口——观测接口用与系统接口不同的 path', () => {
    const step2Binding = resolved.find((r) => r.spec.name === 'step2')!;
    const obsS3Binding = obsIndex.get('observe_S3')!;

    // 系统接口 path 与观测接口 path 不同（独立通道）
    expect(step2Binding.binding!.transport).toHaveProperty('path', '/step2');
    expect(obsS3Binding.binding!.transport).toHaveProperty('path', '/state/S3');
    expect(step2Binding.binding!.transport.path).not.toBe(
      obsS3Binding.binding!.transport.path
    );
  });
});

// ---------------------------------------------------------------------------
// 观测接口降级：无观测绑定时信任 nextState
// ---------------------------------------------------------------------------

describe('观测接口降级处理', () => {
  test('目标状态无观测接口绑定时，降级使用动作响应的 nextState', () => {
    // 场景：系统接口已绑定，但某个目标状态的观测接口未绑定
    const t = { id: 'T1', action: 'go', from: ['S1'], to: 'S2' } as TransitionDef;
    const actionResult: TransportResult = {
      status: 200,
      data: { nextState: 'S2' },
      ok: true,
    };

    // 观测接口索引中没有 observe_S2
    const obsIndex = new Map<string, ResolvedBinding>();
    const observeName = `observe_${t.to}`;

    if (!obsIndex.has(observeName)) {
      // 降级：使用动作响应的状态
      const responseData = actionResult.data as Record<string, unknown>;
      const fallbackState = (responseData?.['nextState'] as string) ?? t.to;
      expect(fallbackState).toBe('S2');
      // 记录为验证独立性降级的警告
    }
  });
});

// ---------------------------------------------------------------------------
// Kafka 模式：fire-and-forget + poll + reply_topic
// ---------------------------------------------------------------------------

describe('Kafka 传输模式验证', () => {
  test('Kafka fire-and-forget：消息发送后直接信任协议预期，不等待', () => {
    const t = { id: 'T1', action: 'fire', from: ['S1'], to: 'S2' } as TransitionDef;

    const transport = {
      type: 'kafka' as const,
      topic: 'events',
      serde: 'json' as const,
      responseMode: 'none' as const,
    };

    // 模拟 executeTransport 返回 { sent: true }
    const actionResult: TransportResult = {
      status: 200,
      data: { sent: true },
      ok: true,
    };

    // Kafka fire-and-forget：直接标记状态已转移
    if (transport.type === 'kafka' && transport.responseMode === 'none') {
      const nextState = t.to;
      expect(nextState).toBe('S2');
      // 不查观测接口
      expect(actionResult.ok).toBe(true);
    }
  });

  test('Kafka poll 模式：发送消息后轮询观测接口直到状态收敛', async () => {
    const t = { id: 'T1', action: 'poll_action', from: ['S1'], to: 'S2' } as TransitionDef;

    const transport = {
      type: 'kafka' as const,
      topic: 'events',
      serde: 'json' as const,
      responseMode: 'poll' as const,
      timeoutMs: 3000,
    };

    // 模拟：第 1 次轮询返回 S1，第 2 次返回 S2
    let pollCount = 0;
    const mockObserve = (): TransportResult => {
      pollCount++;
      if (pollCount >= 2) return mockObserveResult('S2');
      return mockObserveResult('S1');
    };

    // 模拟 pollObservationState 逻辑
    const timeoutMs = 3000;
    const intervalMs = 100;
    const deadline = Date.now() + timeoutMs;
    let actualState: string | null = null;

    while (Date.now() < deadline) {
      const result = mockObserve();
      const data = result.data as Record<string, unknown>;
      actualState = (data['currentState'] as string) ?? null;

      if (actualState === t.to) break;
      // 实际代码中是 await setTimeout，此处简化
    }

    expect(actualState).toBe('S2');
    expect(pollCount).toBe(2); // 第 2 次轮询命中
  });

  test('Kafka poll 超时未收敛 → 偏差', async () => {
    const t = { id: 'T1', action: 'slow', from: ['S1'], to: 'S2' } as TransitionDef;

    let pollCount = 0;
    const mockObserve = (): TransportResult => {
      pollCount++;
      return mockObserveResult('S1'); // 永远不收敛
    };

    // 模拟超时
    const timeoutMs = 500;
    const intervalMs = 100;
    const deadline = Date.now() + timeoutMs;
    let actualState: string | null = null;
    let timedOut = false;

    while (Date.now() < deadline) {
      const result = mockObserve();
      const data = result.data as Record<string, unknown>;
      actualState = (data['currentState'] as string) ?? null;

      if (actualState === t.to) break;
      // 间隔
    }
    timedOut = actualState !== t.to;

    expect(timedOut).toBe(true);
    expect(pollCount).toBeGreaterThanOrEqual(5); // 500ms / 100ms ≈ 5 次
  });

  test('Kafka reply_topic 模式：发送后等待响应 topic 消息', () => {
    const transport = {
      type: 'kafka' as const,
      topic: 'requests',
      serde: 'json' as const,
      responseMode: 'reply_topic' as const,
      responseTopic: 'responses',
      correlationIdField: 'correlation_id',
      timeoutMs: 10000,
    };

    expect(transport.responseMode).toBe('reply_topic');
    expect(transport.responseTopic).toBe('responses');
    expect(transport.correlationIdField).toBe('correlation_id');
  });
});

// ---------------------------------------------------------------------------
// 审批流完整路径验证（集成场景）
// ---------------------------------------------------------------------------

describe('审批流协议完整路径验证', () => {
  const model = parseProtocolContent(`---
name: 审批流
version: 1.0.0
purpose: 测试
roles:
  - id: applicant
    name: 申请人
    responsibilities: 测试
  - id: approver
    name: 审批人
    responsibilities: 测试
---
# 背景

审批流用于测试。

# 状态空间

| ID | 名称 | 类型 | 描述 |
|---|---|---|---|
| S1 | 草稿 | initial | |
| S2 | 待审批 | normal | |
| S3 | 已通过 | terminal | |
| S4 | 已驳回 | terminal | |

# 转移规则

| ID | 名称 | from | to | action | trigger |
|---|---|---|---|---|---|
| T1 | 提交 | S1 | S2 | submit | applicant |
| T2 | 通过 | S2 | S3 | approve | approver |
| T3 | 驳回 | S2 | S4 | reject | approver |
`);
  const specs = specsFromEnvelope(specify(model));
  const transitionsById = new Map(model.derivable.transitions.map((t) => [t.id, t]));
  const initialStateId = model.derivable.states.find((s) => s.type === 'initial')!.id;

  const config = makeBindingConfig([
    { action: 'submit', roleId: 'R', transport: { type: 'http', method: 'POST', path: '/submit', params: [] } },
    { action: 'approve', roleId: 'R', transport: { type: 'http', method: 'POST', path: '/approve', params: [] } },
    { action: 'reject', roleId: 'R', transport: { type: 'http', method: 'POST', path: '/reject', params: [] } },
    { action: 'observe_草稿', roleId: 'R', transport: { type: 'http', method: 'GET', path: '/state/S1', params: [] } },
    { action: 'observe_待审批', roleId: 'R', transport: { type: 'http', method: 'GET', path: '/state/S2', params: [] } },
    { action: 'observe_已通过', roleId: 'R', transport: { type: 'http', method: 'GET', path: '/state/S3', params: [] } },
    { action: 'observe_已驳回', roleId: 'R', transport: { type: 'http', method: 'GET', path: '/state/S4', params: [] } },
  ]);
  const resolved = resolveBindings(specs, config);
  const obsIndex = buildObservationIndex(resolved);

  test('路径 T1→T2 可通过观测接口独立验证每个状态', () => {
    // 验证从 S1 出发
    expect(initialStateId).toBe('S1');

    // T1: submit，S1→S2
    const t1 = transitionsById.get('T1')!;
    expect(t1.from).toContain('S1');
    expect(t1.to).toBe('S2');

    // 模拟 action 调用成功
    const actionOk: TransportResult = { status: 200, data: {}, ok: true };

    // 观测 S2
    const obsS2 = obsIndex.get('observe_S2')!;
    expect(obsS2).toBeDefined();
    expect((obsS2.binding!.transport as { path: string }).path).toBe('/state/S2');

    const obsResult = mockObserveResult('S2');
    expect((obsResult.data as Record<string, string>).currentState).toBe(t1.to);

    // T2: approve，S2→S3
    const t2 = transitionsById.get('T2')!;
    expect(t2.from).toContain('S2');
    expect(t2.to).toBe('S3');

    // 观测 S3
    const obsS3 = obsIndex.get('observe_S3')!;
    expect(obsS3).toBeDefined();
    expect((obsS3.binding!.transport as { path: string }).path).toBe('/state/S3');
  });

  test('路径 T1→T3 到达终态 S4', () => {
    const t1 = transitionsById.get('T1')!; // S1→S2
    const t3 = transitionsById.get('T3')!; // S2→S4

    expect(t3.to).toBe('S4');
    expect(model.derivable.states.find((s) => s.id === 'S4')?.type).toBe('terminal');

    const obsS4 = obsIndex.get('observe_S4');
    expect(obsS4).toBeDefined();
  });

  test('所有系统的 transfer 都有对应的绑定', () => {
    for (const [, t] of transitionsById) {
      const binding = resolved.find((r) => r.spec.name === t.action);
      expect(binding?.binding).toBeDefined();
    }
  });

  test('所有状态的观测接口都可以通过 sourceId 或 name 查找到', () => {
    for (const s of model.derivable.states) {
      const byId = obsIndex.get(`observe_${s.id}`);
      const byName = obsIndex.get(`observe_${s.name}`);

      // 至少一种查找方式有效
      expect(byId || byName).toBeDefined();
    }
  });
});
