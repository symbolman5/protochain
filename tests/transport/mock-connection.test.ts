/**
 * 模拟 Kafka / NSQ 连接测试
 *
 * 通过 jest.mock 注入 kafkajs / nsqjs 的模拟实现，在无真实 broker 的环境下
 * 验证修复后的 executeKafka / executeNsq 完整逻辑：
 *
 * Kafka（kafka-executor.ts）：
 * - 构造 Kafka 客户端：brokers / ssl / sasl / 超时派生（timeoutMs → connection/requestTimeout）
 * - SASL 配置从环境变量构建（plain / scram-sha-256），环境变量缺失时不启用
 * - 发送消息（keyField 分区键 + JSON value）
 * - responseMode=none / poll / reply_topic（correlationId 匹配、不匹配放行、超时 504）
 * - producer 连接 / 发送失败 → 502
 * - serde=avro / protobuf 未实现 → 400
 *
 * NSQ（nsq-executor.ts）：
 * - Writer 以 (host, port, options) 形式构造（修复点）
 * - 'ready' 事件后 publish（修复点：nsqjs 无回调式 connect）
 * - Reader 以 (topic, channel, options) 形式构造（修复点）
 * - reply_topic 匹配 / 超时 504
 * - publish / 连接错误 → 502（与 Kafka 一致）
 *
 * 运行：npx jest tests/transport/mock-connection.test.ts
 */

import { executeTransport } from '../../src/transport/index.js';
import type {
  InterfaceSpec,
  KafkaTransport,
  NsqTransport,
  ResolvedBinding,
} from '../../src/model/types.js';

// ---------------------------------------------------------------------------
// 模拟模块状态（jest.mock 工厂只允许引用 mock* 前缀的变量）
// ---------------------------------------------------------------------------

interface MockWriterLike {
  host: string;
  port: number;
  options?: Record<string, unknown>;
  closed?: boolean;
}

interface MockReaderLike {
  topic: string;
  channel: string;
  options?: Record<string, unknown>;
  emit(event: string, ...args: unknown[]): void;
}

let mockKafkaConfigs: Record<string, unknown>[] = [];
let mockConsumerConfigs: Record<string, unknown>[] = [];
let mockConsumerSubscribes: { topic: string; fromBeginning: boolean }[] = [];
let mockConsumerRunConfigs: {
  eachMessage?: (payload: { message: { value: Buffer | null } }) => void | Promise<void>;
}[] = [];
let mockProducerSendCalls: { topic: string; messages: { key?: string; value: string }[] }[] = [];
let mockProducerConnectError: Error | null = null;
let mockProducerSendError: Error | null = null;

let mockNsqWriters: MockWriterLike[] = [];
let mockNsqReaders: MockReaderLike[] = [];
let mockNsqPublishCalls: { topic: string; body: string }[] = [];
let mockNsqPublishError: Error | null = null;
let mockNsqConnectError: Error | null = null;

// ---------------------------------------------------------------------------
// kafkajs 模拟实现
// ---------------------------------------------------------------------------

jest.mock('kafkajs', () => {
  class MockProducer {
    async connect(): Promise<void> {
      if (mockProducerConnectError) throw mockProducerConnectError;
    }
    async send(payload: {
      topic: string;
      messages: { key?: string; value: string }[];
    }): Promise<unknown[]> {
      if (mockProducerSendError) throw mockProducerSendError;
      mockProducerSendCalls.push(payload);
      return [];
    }
    async disconnect(): Promise<void> {
      /* noop */
    }
  }

  class MockConsumer {
    constructor(public config: Record<string, unknown>) {
      mockConsumerConfigs.push(config);
    }
    async connect(): Promise<void> {
      /* noop */
    }
    async subscribe(payload: { topic: string; fromBeginning: boolean }): Promise<void> {
      mockConsumerSubscribes.push(payload);
    }
    async run(cfg: {
      eachMessage?: (payload: { message: { value: Buffer | null } }) => void | Promise<void>;
    }): Promise<void> {
      mockConsumerRunConfigs.push(cfg);
    }
    async disconnect(): Promise<void> {
      /* noop */
    }
  }

  class MockKafka {
    constructor(public config: Record<string, unknown>) {
      mockKafkaConfigs.push(config);
    }
    producer(): MockProducer {
      return new MockProducer();
    }
    consumer(config: Record<string, unknown>): MockConsumer {
      return new MockConsumer(config);
    }
  }

  return { Kafka: MockKafka };
});

// ---------------------------------------------------------------------------
// nsqjs 模拟实现
// ---------------------------------------------------------------------------

jest.mock('nsqjs', () => {
  class MockWriter {
    public listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    public closed = false;
    constructor(
      public host: string,
      public port: number,
      public options?: Record<string, unknown>
    ) {
      mockNsqWriters.push(this);
    }
    on(event: string, cb: (...args: unknown[]) => void): this {
      (this.listeners[event] ??= []).push(cb);
      return this;
    }
    once(event: string, cb: (...args: unknown[]) => void): this {
      (this.listeners[event] ??= []).push(cb);
      return this;
    }
    emit(event: string, ...args: unknown[]): void {
      for (const cb of this.listeners[event] ?? []) cb(...args);
    }
    connect(): void {
      if (mockNsqConnectError) {
        this.emit('error', mockNsqConnectError);
      } else {
        this.emit('ready');
      }
    }
    publish(topic: string, body: string, cb?: (err?: Error) => void): void {
      mockNsqPublishCalls.push({ topic, body });
      if (mockNsqPublishError) {
        cb?.(mockNsqPublishError);
      } else {
        cb?.();
      }
    }
    close(): void {
      this.closed = true;
    }
  }

  class MockReader {
    public listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    constructor(
      public topic: string,
      public channel: string,
      public options?: Record<string, unknown>
    ) {
      mockNsqReaders.push(this);
    }
    on(event: string, cb: (...args: unknown[]) => void): this {
      (this.listeners[event] ??= []).push(cb);
      return this;
    }
    emit(event: string, ...args: unknown[]): void {
      for (const cb of this.listeners[event] ?? []) cb(...args);
    }
    connect(): void {
      /* noop */
    }
    close(): void {
      /* noop */
    }
  }

  return { Writer: MockWriter, Reader: MockReader };
});

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
  transportOverrides: Partial<KafkaTransport> = {},
  roleOverrides: Partial<{
    brokersEnv: string;
    consumerGroup?: string;
    sasl?: {
      mechanism: 'plain' | 'scram-sha-256' | 'scram-sha-512';
      usernameEnv: string;
      passwordEnv: string;
    };
  }> = {}
): ResolvedBinding {
  return {
    spec: makeSpec(),
    binding: {
      action: 'testAction',
      roleId: 'R',
      transport: {
        type: 'kafka',
        topic: 'user-events',
        serde: 'json',
        responseMode: 'none',
        ...transportOverrides,
      },
    },
    roleBinding: {
      roleId: 'R',
      baseUrl: '',
      auth: 'none',
      kafka: {
        brokersEnv: 'TEST_KAFKA_BROKERS',
        ...roleOverrides,
      },
    },
  };
}

function makeNsqResolved(
  transportOverrides: Partial<NsqTransport> = {},
  roleOverrides: Partial<{
    nsqdTcpEnv: string;
    nsqlookupdHttpEnv?: string;
    responseTimeoutMs?: number;
  }> = {}
): ResolvedBinding {
  return {
    spec: makeSpec(),
    binding: {
      action: 'testAction',
      roleId: 'R',
      transport: {
        type: 'nsq',
        topic: 'test-topic',
        serde: 'json',
        responseMode: 'none',
        ...transportOverrides,
      },
    },
    roleBinding: {
      roleId: 'R',
      baseUrl: '',
      auth: 'none',
      nsq: {
        nsqdTcpEnv: 'TEST_NSQD_TCP',
        ...roleOverrides,
      },
    },
  };
}

/** 构造一个模拟 NSQ 消息（对应 nsqjs 的 Message：body 为 Buffer） */
function makeNsqMessage(data: Record<string, unknown>): {
  body: Buffer;
  finish: jest.Mock;
  requeue: jest.Mock;
} {
  return {
    body: Buffer.from(JSON.stringify(data)),
    finish: jest.fn(),
    requeue: jest.fn(),
  };
}

/**
 * 等待动态 import 与 mock 的异步链（connect/subscribe/run）全部完成。
 * 仅在测试代码主动触发 reply 消息的场景使用。
 */
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

// ---------------------------------------------------------------------------
// 全局环境
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockKafkaConfigs = [];
  mockConsumerConfigs = [];
  mockConsumerSubscribes = [];
  mockConsumerRunConfigs = [];
  mockProducerSendCalls = [];
  mockProducerConnectError = null;
  mockProducerSendError = null;

  mockNsqWriters = [];
  mockNsqReaders = [];
  mockNsqPublishCalls = [];
  mockNsqPublishError = null;
  mockNsqConnectError = null;

  process.env.TEST_KAFKA_BROKERS = 'localhost:9092';
  process.env.TEST_NSQD_TCP = '127.0.0.1:4150';
  process.env.TEST_SASL_USER = '';
  process.env.TEST_SASL_PASS = '';
});

afterEach(() => {
  delete process.env.TEST_KAFKA_BROKERS;
  delete process.env.TEST_NSQD_TCP;
  delete process.env.TEST_SASL_USER;
  delete process.env.TEST_SASL_PASS;
});

// ===========================================================================
// Kafka
// ===========================================================================

describe('模拟 Kafka 连接 — 客户端构造', () => {
  test('brokers 从 env var 解析，超时由 timeoutMs 派生', async () => {
    const resolved = makeKafkaResolved({ timeoutMs: 20000 });
    const result = await executeTransport(resolved, {});

    expect(result.status).toBe(200);
    expect(mockKafkaConfigs).toHaveLength(1);
    expect(mockKafkaConfigs[0]).toMatchObject({
      brokers: ['localhost:9092'],
      ssl: false,
      connectionTimeout: 10000, // timeoutMs/2
      requestTimeout: 20000,
    });
    expect(mockKafkaConfigs[0].clientId).toMatch(/^protochain-verifier-/);
  });

  test('未设置 timeoutMs 时使用默认 10000（connectionTimeout 5000）', async () => {
    await executeTransport(makeKafkaResolved(), {});
    expect(mockKafkaConfigs[0]).toMatchObject({
      connectionTimeout: 5000,
      requestTimeout: 10000,
    });
  });

  test('SASL(plain)：从环境变量读取用户名/密码', async () => {
    process.env.TEST_SASL_USER = 'alice';
    process.env.TEST_SASL_PASS = 's3cret';
    const resolved = makeKafkaResolved(
      {},
      {
        sasl: {
          mechanism: 'plain',
          usernameEnv: 'TEST_SASL_USER',
          passwordEnv: 'TEST_SASL_PASS',
        },
      }
    );
    await executeTransport(resolved, {});
    expect(mockKafkaConfigs[0].sasl).toEqual({
      mechanism: 'plain',
      username: 'alice',
      password: 's3cret',
    });
  });

  test('SASL(scram-sha-256)：机制名原样透传', async () => {
    process.env.TEST_SASL_USER = 'bob';
    process.env.TEST_SASL_PASS = 'pw';
    const resolved = makeKafkaResolved(
      {},
      {
        sasl: {
          mechanism: 'scram-sha-256',
          usernameEnv: 'TEST_SASL_USER',
          passwordEnv: 'TEST_SASL_PASS',
        },
      }
    );
    await executeTransport(resolved, {});
    expect(mockKafkaConfigs[0].sasl).toEqual({
      mechanism: 'scram-sha-256',
      username: 'bob',
      password: 'pw',
    });
  });

  test('SASL：用户名/密码均为空时不启用 SASL', async () => {
    const resolved = makeKafkaResolved(
      {},
      {
        sasl: {
          mechanism: 'plain',
          usernameEnv: 'TEST_SASL_USER',
          passwordEnv: 'TEST_SASL_PASS',
        },
      }
    );
    await executeTransport(resolved, {});
    expect(mockKafkaConfigs[0].sasl).toBeUndefined();
  });
});

describe('模拟 Kafka 连接 — 发送消息', () => {
  test('responseMode=none：send 携带 JSON 消息体，返回 { sent: true }', async () => {
    const params = { action: 'create', currentState: 'S1', userId: 42 };
    const result = await executeTransport(makeKafkaResolved(), params);

    expect(result).toEqual({ status: 200, data: { sent: true }, ok: true });
    expect(mockProducerSendCalls).toHaveLength(1);
    expect(mockProducerSendCalls[0].topic).toBe('user-events');
    expect(mockProducerSendCalls[0].messages[0].value).toBe(JSON.stringify(params));
    expect(mockProducerSendCalls[0].messages[0].key).toBeUndefined();
  });

  test('keyField：以 runtimeParams 对应字段作为分区键', async () => {
    const resolved = makeKafkaResolved({ keyField: 'user_id' });
    await executeTransport(resolved, { user_id: 42, action: 'create' });
    expect(mockProducerSendCalls[0].messages[0]).toEqual({
      key: '42',
      value: JSON.stringify({ user_id: 42, action: 'create' }),
    });
  });

  test('responseMode=poll：返回 { sent: true, pollMode: true }', async () => {
    const resolved = makeKafkaResolved({ responseMode: 'poll' });
    const result = await executeTransport(resolved, {});
    expect(result).toEqual({
      status: 200,
      data: { sent: true, pollMode: true, observeAfterMs: 200 },
      ok: true,
    });
  });

  test('serde=avro 未实现 → 400', async () => {
    const resolved = makeKafkaResolved({ serde: 'avro' });
    const result = await executeTransport(resolved, {});
    expect(result.status).toBe(400);
    expect((result.data as Record<string, string>).error).toContain('Avro');
  });

  test('producer 连接失败 → 502', async () => {
    mockProducerConnectError = new Error('broker down');
    const result = await executeTransport(makeKafkaResolved(), {});
    expect(result.ok).toBe(false);
    expect(result.status).toBe(502);
    expect((result.data as Record<string, string>).error).toContain('broker down');
  });

  test('producer 发送失败 → 502', async () => {
    mockProducerSendError = new Error('send failed');
    const result = await executeTransport(makeKafkaResolved(), {});
    expect(result.status).toBe(502);
    expect((result.data as Record<string, string>).error).toContain('send failed');
  });
});

describe('模拟 Kafka 连接 — reply_topic 响应匹配', () => {
  test('订阅 responseTopic 并消费匹配 correlationId 的消息', async () => {
    const resolved = makeKafkaResolved(
      {
        responseMode: 'reply_topic',
        responseTopic: 'user-events-response',
        correlationIdField: 'request_id',
        timeoutMs: 5000,
      },
      { consumerGroup: 'verify-group' }
    );

    const promise = executeTransport(resolved, { request_id: 'req-1', action: 'create' });
    await flushAsync();

    // 消费者组与会话超时
    expect(mockConsumerConfigs[0]).toMatchObject({
      groupId: 'verify-group',
      heartbeatInterval: 3000,
      sessionTimeout: 10000, // timeoutMs + 5000
    });
    // 订阅 responseTopic
    expect(mockConsumerSubscribes).toEqual([
      { topic: 'user-events-response', fromBeginning: false },
    ]);

    const cfg = mockConsumerRunConfigs[0];
    expect(cfg).toBeDefined();
    await cfg.eachMessage!({
      message: { value: Buffer.from(JSON.stringify({ request_id: 'req-1', state: 'done' })) },
    });

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.data).toEqual({ request_id: 'req-1', state: 'done' });
  });

  test('不匹配的 correlationId 不 resolve，匹配后才返回', async () => {
    const resolved = makeKafkaResolved({
      responseMode: 'reply_topic',
      responseTopic: 'resp',
      correlationIdField: 'request_id',
      timeoutMs: 5000,
    });

    const promise = executeTransport(resolved, { request_id: 'req-1' });
    await flushAsync();
    const cfg = mockConsumerRunConfigs[0];

    // 先来一条不匹配的响应
    await cfg.eachMessage!({
      message: { value: Buffer.from(JSON.stringify({ request_id: 'other', state: 'ignored' })) },
    });

    // 再来匹配的响应
    await cfg.eachMessage!({
      message: { value: Buffer.from(JSON.stringify({ request_id: 'req-1', state: 'done' })) },
    });

    const result = await promise;
    // 最终结果必须来自匹配的消息，而非被跳过的消息
    expect(result.data).toEqual({ request_id: 'req-1', state: 'done' });
  });

  test('reply_topic 超时 → 504', async () => {
    const resolved = makeKafkaResolved({
      responseMode: 'reply_topic',
      responseTopic: 'resp',
      timeoutMs: 30,
    });
    const result = await executeTransport(resolved, { request_id: 'x' });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(504);
    expect((result.data as Record<string, string>).error).toContain('超时');
  });
});

// ===========================================================================
// NSQ
// ===========================================================================

describe('模拟 NSQ 连接 — Writer 发布', () => {
  test('Writer 以 (host, port, options) 构造，ready 事件后 publish（修复点验证）', async () => {
    const params = { action: 'create', userId: 7 };
    const result = await executeTransport(makeNsqResolved(), params);

    expect(result).toEqual({ status: 200, data: { sent: true }, ok: true });

    // 修复点：构造函数签名从 {host,port,clientId} 对象改为 (host, port, options)
    expect(mockNsqWriters).toHaveLength(1);
    expect(mockNsqWriters[0].host).toBe('127.0.0.1');
    expect(mockNsqWriters[0].port).toBe(4150);
    expect(mockNsqWriters[0].options).toHaveProperty('clientId');

    expect(mockNsqPublishCalls).toEqual([
      { topic: 'test-topic', body: JSON.stringify(params) },
    ]);
  });

  test('nsqd 地址带端口时正确解析', async () => {
    process.env.TEST_NSQD_TCP = 'nsqd.internal:4151';
    await executeTransport(makeNsqResolved(), {});
    expect(mockNsqWriters[0].host).toBe('nsqd.internal');
    expect(mockNsqWriters[0].port).toBe(4151);
  });

  test('responseMode=poll：返回 { sent: true, pollMode: true }', async () => {
    const resolved = makeNsqResolved({ responseMode: 'poll' });
    const result = await executeTransport(resolved, {});
    expect(result).toEqual({
      status: 200,
      data: { sent: true, pollMode: true, observeAfterMs: 200 },
      ok: true,
    });
  });

  test('发布失败 → 502（与 Kafka 错误风格一致）', async () => {
    mockNsqPublishError = new Error('publish failed');
    const result = await executeTransport(makeNsqResolved(), {});
    expect(result.ok).toBe(false);
    expect(result.status).toBe(502);
    expect((result.data as Record<string, string>).error).toContain('publish failed');
  });

  test('连接失败（writer 发 error 事件）→ 502（与 Kafka 错误风格一致）', async () => {
    mockNsqConnectError = new Error('connection refused');
    const result = await executeTransport(makeNsqResolved(), {});
    expect(result.ok).toBe(false);
    expect(result.status).toBe(502);
    expect((result.data as Record<string, string>).error).toContain('connection refused');
  });
});

describe('模拟 NSQ 连接 — reply_topic 响应匹配', () => {
  test('Reader 以 (topic, channel, options) 构造并消费匹配消息（修复点验证）', async () => {
    const resolved = makeNsqResolved({
      responseMode: 'reply_topic',
      responseTopic: 'resp-topic',
      correlationIdField: 'request_id',
      channel: 'verify-channel',
      timeoutMs: 5000,
    });

    const promise = executeTransport(resolved, { request_id: 'c1' });
    await flushAsync();

    // 修复点：构造函数签名从 {topic, channel, ...} 对象改为 (topic, channel, options)
    expect(mockNsqReaders).toHaveLength(1);
    expect(mockNsqReaders[0].topic).toBe('resp-topic');
    expect(mockNsqReaders[0].channel).toBe('verify-channel');
    expect(mockNsqReaders[0].options).toMatchObject({
      nsqdTCPAddresses: ['127.0.0.1:4150'],
      maxInFlight: 1,
      maxAttempts: 1,
    });

    const msg = makeNsqMessage({ request_id: 'c1', state: 'done' });
    mockNsqReaders[0].emit('message', msg);

    const result = await promise;
    expect(result.status).toBe(200);
    expect(result.data).toEqual({ request_id: 'c1', state: 'done' });
    expect(msg.finish).toHaveBeenCalled();
  });

  test('不匹配的 correlationId 放回队列（requeue），匹配后才 finish', async () => {
    const resolved = makeNsqResolved({
      responseMode: 'reply_topic',
      responseTopic: 'resp',
      correlationIdField: 'request_id',
      timeoutMs: 5000,
    });

    const promise = executeTransport(resolved, { request_id: 'c1' });
    await flushAsync();
    const reader = mockNsqReaders[0];

    const wrong = makeNsqMessage({ request_id: 'other' });
    reader.emit('message', wrong);
    expect(wrong.requeue).toHaveBeenCalledWith(0, false);
    expect(wrong.finish).not.toHaveBeenCalled();

    const right = makeNsqMessage({ request_id: 'c1', state: 'done' });
    reader.emit('message', right);

    const result = await promise;
    expect(result.data).toEqual({ request_id: 'c1', state: 'done' });
    expect(right.finish).toHaveBeenCalled();
  });

  test('reply_topic 超时 → 504', async () => {
    const resolved = makeNsqResolved({
      responseMode: 'reply_topic',
      responseTopic: 'resp',
      timeoutMs: 30,
    });
    const result = await executeTransport(resolved, { request_id: 'x' });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(504);
    expect((result.data as Record<string, string>).error).toContain('超时');
  });
});
