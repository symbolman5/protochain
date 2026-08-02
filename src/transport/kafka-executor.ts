/**
 * Kafka 传输执行器
 *
 * 完整设计参见 docs/binding-mechanism-plan.md 第 4.3.2 节。
 *
 * 依赖 kafkajs（运行时按需加载，不强制安装）。
 * 对 Kafka 不可用的环境（无 broker、未安装 kafkajs），返回明确错误。
 *
 * 连接管理：按 brokers 地址缓存 producer/consumer 连接，
 * 避免频繁 TCP 握手。连接池在进程退出或空闲超时后清理。
 */

import type { ResolvedBinding, KafkaTransport } from '../model/types.js';
import type { TransportResult } from './types.js';

// ---------------------------------------------------------------------------
// 连接池
// ---------------------------------------------------------------------------

/** Kafka 客户端引用（kafkajs 的 Kafka 类） */
let KafkaCtor: typeof import('kafkajs').Kafka | null = null;
let kafkaLoadError: string | null = null;

/** 缓存的 producer（按 brokers 地址 key） */
const producerCache = new Map<
  string,
  { producer: import('kafkajs').Producer; kafka: import('kafkajs').Kafka }
>();

/** 空闲清理定时器 */
let cleanupTimer: ReturnType<typeof setTimeout> | null = null;

const CONNECTION_IDLE_MS = 120_000; // 2 分钟空闲后清理

/**
 * 尝试加载 kafkajs。成功返回构造函数，失败缓存错误。
 */
async function loadKafkajs(): Promise<typeof import('kafkajs').Kafka> {
  if (KafkaCtor) return KafkaCtor;
  if (kafkaLoadError) throw new Error(kafkaLoadError);

  try {
    const mod = await import('kafkajs');
    KafkaCtor = mod.Kafka;
    return KafkaCtor;
  } catch (err) {
    kafkaLoadError = 'kafkajs 未安装。请运行: npm install kafkajs';
    throw new Error(kafkaLoadError);
  }
}

/**
 * 获取或创建 producer 连接。
 * 按 brokers 地址缓存，同一集群复用。
 */
async function getProducer(brokers: string[], clientId: string): Promise<import('kafkajs').Producer> {
  const key = brokers.sort().join(',');
  const cached = producerCache.get(key);
  if (cached) {
    resetCleanupTimer();
    return cached.producer;
  }

  const Kafka = await loadKafkajs();
  const kafka = new Kafka({ clientId, brokers, connectionTimeout: 5000 });
  const producer = kafka.producer({ allowAutoTopicCreation: false });
  await producer.connect();

  producerCache.set(key, { producer, kafka });
  resetCleanupTimer();
  return producer;
}

/**
 * 重置空闲清理定时器。
 * 每次使用连接时调用，确保活跃连接不被清理。
 */
function resetCleanupTimer(): void {
  if (cleanupTimer) clearTimeout(cleanupTimer);
  cleanupTimer = setTimeout(() => {
    for (const [key, { producer }] of producerCache) {
      producer.disconnect().catch(() => {});
      producerCache.delete(key);
    }
    cleanupTimer = null;
  }, CONNECTION_IDLE_MS);
}

// ---------------------------------------------------------------------------
// SASL 配置
// ---------------------------------------------------------------------------

function buildSaslConfig(
  role: NonNullable<ResolvedBinding['roleBinding']>
): import('kafkajs').SASLOptions | undefined {
  const sasl = role.kafka?.sasl;
  if (!sasl) return undefined;

  const username = process.env[sasl.usernameEnv] ?? '';
  const password = process.env[sasl.passwordEnv] ?? '';

  if (!username && !password) return undefined;

  // 模型仅允许 username/password 类机制（plain / scram-sha-256 / scram-sha-512），
  // 与 kafkajs 的 SASLOptions 判别联合结构一致。
  return {
    mechanism: sasl.mechanism,
    username,
    password,
  } as import('kafkajs').SASLOptions;
}

// ---------------------------------------------------------------------------
// Kafka 执行器
// ---------------------------------------------------------------------------

/**
 * 通过 Kafka 发送一条消息并（按需）等待响应。
 *
 * 响应模式：
 * - 'none'：发送后立即返回 { sent: true }
 * - 'reply_topic'：发送后等待 responseTopic 上的匹配消息（按 correlationIdField 匹配）
 * - 'poll'：发送后立即返回 { sent: true }，由上层 verifier 通过观测接口轮询结果
 *
 * @param binding 已解析的绑定（含 KafkaTransport）
 * @param runtimeParams 运行时参数（消息体内容 + correlation 字段）
 */
export async function executeKafka(
  binding: ResolvedBinding,
  runtimeParams: Record<string, unknown>
): Promise<TransportResult> {
  const transport = binding.binding!.transport as KafkaTransport;
  const role = binding.roleBinding!;

  // 1. 检查 broker 配置
  const brokersEnv = role.kafka?.brokersEnv;
  // 优先使用显式配置的 env var，fallback 到 KAFKA_BROKERS 默认值
  const brokersStr = (brokersEnv ? process.env[brokersEnv] : undefined)
    ?? process.env['KAFKA_BROKERS']
    ?? undefined;
  if (!brokersStr) {
    return {
      status: 503,
      data: {
        error: `Kafka broker 未配置。（请设置环境变量 ${brokersEnv ?? 'KAFKA_BROKERS'}）`,
      },
      ok: false,
    };
  }

  const brokers = brokersStr.split(',').map((s) => s.trim());

  // 2. 构造消息
  const key = transport.keyField
    ? String(runtimeParams[transport.keyField] ?? '')
    : undefined;

  // 序列化消息体（当前仅支持 JSON）
  const value = serializeMessage(runtimeParams, transport.serde);
  if (typeof value !== 'string') {
    return { status: 400, data: { error: value.error }, ok: false };
  }

  const messages: { key?: string; value: string }[] = [{ key, value }];

  // 3. 发送消息
  try {
    const Kafka = await loadKafkajs();
    const sasl = buildSaslConfig(role);

    const kafka = new Kafka({
      clientId: `protochain-verifier-${Date.now()}`,
      brokers,
      ssl: false,
      sasl,
      connectionTimeout: (transport.timeoutMs ?? 10000) / 2,
      requestTimeout: transport.timeoutMs ?? 10000,
    });

    const producer = kafka.producer({ allowAutoTopicCreation: false });
    await producer.connect();

    try {
      await producer.send({ topic: transport.topic, messages });

      // 4. 处理响应模式
      if (transport.responseMode === 'none') {
        return { status: 200, data: { sent: true }, ok: true };
      }

      if (transport.responseMode === 'poll') {
        return {
          status: 200,
          data: { sent: true, pollMode: true, observeAfterMs: 200 },
          ok: true,
        };
      }

      // responseMode === 'reply_topic': 等待响应
      return await waitForReply(
        kafka,
        transport,
        runtimeParams,
        role.kafka?.consumerGroup
      );

    } finally {
      await producer.disconnect();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 502,
      data: { error: `Kafka 传输失败: ${message}` },
      ok: false,
    };
  }
}

// ---------------------------------------------------------------------------
// reply_topic 响应等待
// ---------------------------------------------------------------------------

async function waitForReply(
  kafka: import('kafkajs').Kafka,
  transport: KafkaTransport,
  runtimeParams: Record<string, unknown>,
  consumerGroup?: string
): Promise<TransportResult> {
  const responseTopic = transport.responseTopic;
  if (!responseTopic) {
    return {
      status: 400,
      data: { error: 'responseMode=reply_topic 但未配置 responseTopic' },
      ok: false,
    };
  }

  const correlationIdField = transport.correlationIdField ?? 'correlation_id';
  const correlationId =
    runtimeParams[correlationIdField] ?? runtimeParams['correlation_id'];

  const consumer = kafka.consumer({
    groupId: consumerGroup ?? `protochain-verifier-${Date.now()}`,
    heartbeatInterval: 3000,
    sessionTimeout: (transport.timeoutMs ?? 30000) + 5000,
  });

  await consumer.connect();
  await consumer.subscribe({ topic: responseTopic, fromBeginning: false });

  const timeoutMs = transport.timeoutMs ?? 30000;

  return new Promise<TransportResult>((resolve) => {
    const timeoutId = setTimeout(() => {
      consumer.disconnect().catch(() => {});
      resolve({
        status: 504,
        data: { error: `等待响应超时（${timeoutMs}ms），topic: ${responseTopic}` },
        ok: false,
      });
    }, timeoutMs);

    consumer.run({
      autoCommit: false,
      eachMessage: async ({ message }) => {
        const rawValue = message.value?.toString() ?? '{}';
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawValue);
        } catch {
          parsed = rawValue;
        }

        // 按 correlationId 匹配
        if (correlationId !== undefined) {
          const msgObj = parsed as Record<string, unknown>;
          const msgCorrelationId = msgObj[correlationIdField];
          if (msgCorrelationId !== correlationId) {
            return; // 不是本请求的响应，继续等待
          }
        }

        clearTimeout(timeoutId);
        consumer.disconnect().catch(() => {});
        resolve({ status: 200, data: parsed as Record<string, unknown>, ok: true });
      },
    });
  });
}

// ---------------------------------------------------------------------------
// 消息序列化
// ---------------------------------------------------------------------------

function serializeMessage(
  data: Record<string, unknown>,
  serde: 'json' | 'avro' | 'protobuf'
): string | { error: string } {
  switch (serde) {
    case 'json':
      return JSON.stringify(data);
    case 'avro':
      return { error: 'Avro 序列化尚未支持' };
    case 'protobuf':
      return { error: 'Protobuf 序列化尚未支持' };
  }
}
