/**
 * 传输错误处理专项测试
 *
 * 验证 executeTransport 的错误处理：
 * - gRPC / DB 未实现 → 501 Not Implemented
 * - Kafka 无 broker → 503 Service Unavailable（Kafka 已实现但环境不可用）
 * - Kafka json serde 正确执行 → 200
 * - serde=avro/protobuf → 400（序列化不支持）
 * - 未绑定 → 404
 *
 * 注意：Kafka 已在 P1 实现，不再返回 501。
 */

import { executeTransport } from '../../src/transport/index.js';
import type { ResolvedBinding, InterfaceSpec } from '../../src/model/types.js';
import type { TransportResult } from '../../src/transport/types.js';

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

function makeSpec(overrides: Partial<InterfaceSpec> = {}): InterfaceSpec {
  return {
    id: 'IF_SYS_T1',
    kind: 'system',
    sourceId: 'testAction',
    name: 'testAction',
    inputs: [],
    outputs: [],
    ...overrides,
  };
}

function makeKafkaResolved(
  overrides: Partial<{ topic: string; serde: string; responseMode: string; keyField: string }> = {}
): ResolvedBinding {
  return {
    spec: makeSpec(),
    binding: {
      action: 'testAction',
      roleId: 'R',
      transport: {
        type: 'kafka',
        topic: overrides.topic ?? 'test-topic',
        serde: (overrides.serde ?? 'json') as 'json' | 'avro' | 'protobuf',
        responseMode: (overrides.responseMode ?? 'none') as 'none' | 'reply_topic' | 'poll',
        keyField: overrides.keyField,
      },
    },
    roleBinding: { roleId: 'R', baseUrl: '', auth: 'none' },
  };
}

function makeGrpcResolved(overrides: Record<string, unknown> = {}): ResolvedBinding {
  return {
    spec: makeSpec(),
    binding: {
      action: 'testAction',
      roleId: 'R',
      transport: {
        type: 'grpc',
        service: (overrides.service as string) ?? 'test.Service',
        method: (overrides.method as string) ?? 'TestMethod',
        ...overrides,
      },
    },
    roleBinding: { roleId: 'R', baseUrl: '', auth: 'none' },
  };
}

function makeDbResolved(dbType: 'postgres' | 'mysql' | 'mongodb' | 'sqlite'): ResolvedBinding {
  return {
    spec: makeSpec(),
    binding: {
      action: 'testAction',
      roleId: 'R',
      transport: {
        type: 'db_query',
        dbType,
        query: 'SELECT 1',
        connectionEnv: 'TEST_DB',
      },
    },
    roleBinding: { roleId: 'R', baseUrl: '', auth: 'none' },
  };
}

// ---------------------------------------------------------------------------
// Kafka 传输 — 已实现，broker 环境依赖
// ---------------------------------------------------------------------------

describe('Kafka 传输 — 已实现但 broker 未配置时返回 503', () => {
  test('无 broker 环境变量时返回 503', async () => {
    const resolved = makeKafkaResolved();
    const result = await executeTransport(resolved, {});
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    const error = (result.data as Record<string, string>).error;
    expect(error).toContain('Kafka broker 未配置');
  });

  test('responseMode=none 无 broker → 503', async () => {
    const resolved = makeKafkaResolved({ responseMode: 'none' });
    const result = await executeTransport(resolved, {});
    expect(result.status).toBe(503);
  });

  test('responseMode=reply_topic 无 broker → 503', async () => {
    const resolved = makeKafkaResolved({ responseMode: 'reply_topic' });
    const result = await executeTransport(resolved, {});
    expect(result.status).toBe(503);
  });

  test('responseMode=poll 无 broker → 503', async () => {
    const resolved = makeKafkaResolved({ responseMode: 'poll' });
    const result = await executeTransport(resolved, {});
    expect(result.status).toBe(503);
  });

  test('带 keyField 无 broker → 503', async () => {
    const resolved = makeKafkaResolved({ keyField: 'user_id' });
    const result = await executeTransport(resolved, { user_id: 'u1' });
    expect(result.status).toBe(503);
  });

  test('runtimeParams 对 broker 缺失判断无影响', async () => {
    const resolved = makeKafkaResolved();
    const r1 = await executeTransport(resolved, { currentState: 'S1' });
    const r2 = await executeTransport(resolved, {});
    const r3 = await executeTransport(resolved, { foo: 'bar', extra: 42 });

    // 全部返回 503（broker 未配置），与参数无关
    for (const r of [r1, r2, r3]) {
      expect(r.ok).toBe(false);
      expect(r.status).toBe(503);
      expect((r.data as Record<string, string>).error).toContain('Kafka broker');
    }
  });

  test('serde=avro 不支持的序列化 → 400', async () => {
    // 设置 broker 环境变量使其跳过 503，进入序列化阶段
    process.env.KAFKA_BROKERS = 'localhost:9092';
    try {
      const resolved = makeKafkaResolved({ serde: 'avro' });
      const result = await executeTransport(resolved, {});
      // Avro 序列化不支持 → 400（在连接 Kafka 之前就返回）
      expect(result.ok).toBe(false);
      expect(result.status).toBe(400);
      expect((result.data as Record<string, string>).error).toContain('Avro');
    } finally {
      delete process.env.KAFKA_BROKERS;
    }
  });

  test('serde=protobuf 不支持的序列化 → 400', async () => {
    process.env.KAFKA_BROKERS = 'localhost:9092';
    try {
      const resolved = makeKafkaResolved({ serde: 'protobuf' });
      const result = await executeTransport(resolved, {});
      expect(result.ok).toBe(false);
      expect(result.status).toBe(400);
      expect((result.data as Record<string, string>).error).toContain('Protobuf');
    } finally {
      delete process.env.KAFKA_BROKERS;
    }
  });
});

// ---------------------------------------------------------------------------
// gRPC 未实现 — 501 专项
// ---------------------------------------------------------------------------

describe('gRPC 传输 — 未实现时返回 501 错误', () => {
  test('基本 gRPC 绑定返回 501', async () => {
    const resolved = makeGrpcResolved();
    const result = await executeTransport(resolved, {});
    verify501(result, 'gRPC 传输尚未实现（P2 阶段）');
  });

  test('完整 gRPC 配置（含 protoFile）返回 501', async () => {
    const resolved = makeGrpcResolved({
      service: 'entry.EntryService',
      method: 'Create',
      protoFile: 'protocol/P2/entry.proto',
    });
    const result = await executeTransport(resolved, { currentState: 'S1' });
    verify501(result, 'gRPC');
  });

  test('带 metadata 的 gRPC 返回 501', async () => {
    const resolved = makeGrpcResolved({
      service: 'S',
      method: 'M',
      metadata: { 'x-tenant-id': 'tenant-001' },
    });
    const result = await executeTransport(resolved, {});
    verify501(result, 'gRPC');
  });

  test('带 timeoutMs 的 gRPC 返回 501', async () => {
    const resolved = makeGrpcResolved({
      service: 'S',
      method: 'M',
      timeoutMs: 5000,
    });
    const result = await executeTransport(resolved, {});
    verify501(result, 'gRPC');
  });
});

// ---------------------------------------------------------------------------
// DB 查询未实现 — 501 专项
// ---------------------------------------------------------------------------

describe('DB 查询传输 — 未实现时返回 501 错误', () => {
  test('postgres 查询返回 501', async () => {
    const resolved = makeDbResolved('postgres');
    const result = await executeTransport(resolved, { id: '1' });
    verify501(result, '数据库查询传输尚未实现（P1 阶段）');
  });

  test('mysql 查询返回 501', async () => {
    const resolved = makeDbResolved('mysql');
    const result = await executeTransport(resolved, {});
    verify501(result, '数据库');
  });

  test('sqlite 查询返回 501', async () => {
    const resolved = makeDbResolved('sqlite');
    const result = await executeTransport(resolved, {});
    verify501(result, '数据库');
  });

  test('mongodb 查询返回 501', async () => {
    const resolved = makeDbResolved('mongodb');
    const result = await executeTransport(resolved, {});
    verify501(result, '数据库');
  });

  test('DB 查询在 observation 场景下也返回 501', async () => {
    const resolved: ResolvedBinding = {
      spec: {
        id: 'IF_OBS_S1',
        kind: 'observation',
        sourceId: 'S1',
        name: 'observe_初态',
        inputs: [],
        outputs: [{ name: 'isInState', type: 'boolean' }],
      },
      binding: {
        action: 'observe_初态',
        roleId: 'R',
        transport: {
          type: 'db_query',
          dbType: 'postgres',
          query: 'SELECT status FROM entries WHERE id = $1',
          connectionEnv: 'ENTRY_DB_URL',
        },
      },
      roleBinding: { roleId: 'R', baseUrl: '', auth: 'none' },
    };
    const result = await executeTransport(resolved, { id: 'entry-42' });
    verify501(result, '数据库');
  });
});

// ---------------------------------------------------------------------------
// 边界情况
// ---------------------------------------------------------------------------

describe('未实现传输类型 — 边界情况', () => {
  test('gRPC + DB 连续调用均返回 501', async () => {
    const grpc = makeGrpcResolved();
    const db = makeDbResolved('postgres');

    const [r1, r2] = await Promise.all([
      executeTransport(grpc, {}),
      executeTransport(db, {}),
    ]);

    verify501(r1, 'gRPC');
    verify501(r2, '数据库');
  });

  test('未实现类型与未绑定对比：未绑定返回 404', async () => {
    const result = await executeTransport(undefined, {});
    expect(result.status).toBe(404);
    expect(result.ok).toBe(false);
    expect((result.data as Record<string, string>).error).toBe('接口未绑定');
  });

  test('gRPC 501 的错误消息包含阶段信息', async () => {
    const result = await executeTransport(makeGrpcResolved(), {});
    const msg = (result.data as Record<string, string>).error;
    expect(msg).toContain('gRPC');
    expect(msg).toContain('P2');
  });

  test('DB 501 的错误消息包含阶段信息', async () => {
    const result = await executeTransport(makeDbResolved('postgres'), {});
    const msg = (result.data as Record<string, string>).error;
    expect(msg).toContain('数据库');
    expect(msg).toContain('P1');
  });

  test('501 返回的 TransportResult 结构一致', async () => {
    const results = await Promise.all([
      executeTransport(makeGrpcResolved(), {}),
      executeTransport(makeDbResolved('postgres'), {}),
    ]);

    for (const r of results) {
      expect(r).toHaveProperty('status', 501);
      expect(r).toHaveProperty('ok', false);
      expect(r).toHaveProperty('data');
      expect(typeof r.data).toBe('object');
      expect(r.data).toHaveProperty('error');
      expect(typeof (r.data as Record<string, string>).error).toBe('string');
    }
  });

  test('503（Kafka 无 broker）与 501（未实现）结构一致', async () => {
    const kafka = await executeTransport(makeKafkaResolved(), {});
    const grpc = await executeTransport(makeGrpcResolved(), {});

    // 两种错误都返回 ok=false + data.error
    expect(kafka.ok).toBe(false);
    expect(grpc.ok).toBe(false);
    expect(kafka.data).toHaveProperty('error');
    expect(grpc.data).toHaveProperty('error');

    // 但状态码不同：503（服务不可用）vs 501（未实现）
    expect(kafka.status).toBe(503);
    expect(grpc.status).toBe(501);
  });
});

// ---------------------------------------------------------------------------
// 验证辅助
// ---------------------------------------------------------------------------

/**
 * 验证 TransportResult 符合 501 错误规范：
 * - status === 501
 * - ok === false
 * - data.error 包含指定的子串
 */
function verify501(result: TransportResult, expectedSubstr: string): void {
  expect(result.ok).toBe(false);
  expect(result.status).toBe(501);
  const error = (result.data as Record<string, string>).error;
  expect(error).toBeDefined();
  expect(typeof error).toBe('string');
  expect(error.length).toBeGreaterThan(0);
  expect(error).toContain(expectedSubstr);
}
