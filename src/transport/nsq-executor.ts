/**
 * NSQ 传输执行器
 *
 * 完整设计参见 docs/binding-mechanism-plan.md 第 4.3.X 节。
 *
 * 依赖 nsqjs 库（运行时按需加载，不强制安装）。
 * NSQ 与 Kafka 的关键区别：
 * - 无 consumer group 概念：每个 channel 是一份完整消息副本
 * - 无 partition key：消息路由由 nsqd 决定
 * - 更简单的部署拓扑：nsqd（数据节点）+ nsqlookupd（服务发现）
 * - 适合中等吞吐、低运维负担的场景
 */

import type { ResolvedBinding, NsqTransport } from '../model/types.js';
import type { TransportResult } from './types.js';
import type { Message, Reader, Writer } from 'nsqjs';

// ---------------------------------------------------------------------------
// 动态加载（类型来自 @types/nsqjs，运行时仍为按需动态 import）
// ---------------------------------------------------------------------------

let nsqjsModule: typeof import('nsqjs') | null = null;

let nsqjsLoadError: string | null = null;

async function loadNsqjs(): Promise<NonNullable<typeof nsqjsModule>> {
  if (nsqjsModule) return nsqjsModule;
  if (nsqjsLoadError) throw new Error(nsqjsLoadError);

  try {
    const mod = await import('nsqjs');
    nsqjsModule = mod;
    return nsqjsModule;
  } catch {
    nsqjsLoadError = 'nsqjs 未安装。请运行: npm install nsqjs';
    throw new Error(nsqjsLoadError);
  }
}

// ---------------------------------------------------------------------------
// NSQ 执行器
// ---------------------------------------------------------------------------

/**
 * 通过 NSQ 发布一条消息并（按需）等待响应。
 *
 * 响应模式：
 * - 'none'：pub 后立即返回 { sent: true }
 * - 'reply_topic'：pub 后订阅 responseTopic 的 channel，等待匹配消息
 * - 'poll'：pub 后立即返回 { sent: true, pollMode: true }，由上层 verifier 轮询
 *
 * @param binding 已解析的绑定（含 NsqTransport）
 * @param runtimeParams 运行时参数（消息体内容 + correlation 字段）
 */
export async function executeNsq(
  binding: ResolvedBinding,
  runtimeParams: Record<string, unknown>
): Promise<TransportResult> {
  const transport = binding.binding!.transport as NsqTransport;
  const role = binding.roleBinding!;

  // 1. 检查 nsqd 地址
  const nsqdTcpEnv = role.nsq?.nsqdTcpEnv;
  const nsqdTcp = (nsqdTcpEnv ? process.env[nsqdTcpEnv] : undefined)
    ?? process.env['NSQD_TCP_ADDRESS']
    ?? undefined;
  if (!nsqdTcp) {
    return {
      status: 503,
      data: {
        error: `NSQ nsqd 地址未配置。（请设置环境变量 ${nsqdTcpEnv ?? 'NSQD_TCP_ADDRESS'}）`,
      },
      ok: false,
    };
  }

  const [host, portStr] = nsqdTcp.split(':');
  const port = Number(portStr) || 4150;

  // 2. 加载 nsqjs
  let nsqjs: NonNullable<typeof nsqjsModule>;
  try {
    nsqjs = await loadNsqjs();
  } catch (err) {
    return {
      status: 500,
      data: { error: (err as Error).message },
      ok: false,
    };
  }

  // 3. pub 消息
  const writer: Writer = new nsqjs.Writer(host, port, {
    clientId: `protochain-verifier-${Date.now()}`,
  });

  const messageBody = JSON.stringify(runtimeParams);

  try {
    // nsqjs 的 Writer 通过 'ready'/'error' 事件通知连接状态，无回调式 connect
    await new Promise<void>((resolve, reject) => {
      const onReady = (): void => {
        writer.publish(transport.topic, messageBody, (pubErr) => {
          if (pubErr) return reject(pubErr);
          resolve();
        });
      };
      const onError = (err: Error): void => reject(err);
      writer.once('ready', onReady);
      writer.once('error', onError);
      writer.connect();
    });

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
    return await waitForNsqReply(transport, role, runtimeParams, host, port, nsqjs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 502,
      data: { error: `NSQ 传输失败: ${message}` },
      ok: false,
    };
  } finally {
    writer.close();
  }
}

// ---------------------------------------------------------------------------
// reply_topic 响应等待
// ---------------------------------------------------------------------------

async function waitForNsqReply(
  transport: NsqTransport,
  role: NonNullable<ResolvedBinding['roleBinding']>,
  runtimeParams: Record<string, unknown>,
  nsqdHost: string,
  nsqdPort: number,
  nsqjs: NonNullable<typeof nsqjsModule>
): Promise<TransportResult> {
  const responseTopic = transport.responseTopic;
  if (!responseTopic) {
    return {
      status: 400,
      data: { error: 'responseMode=reply_topic 但未配置 responseTopic' },
      ok: false,
    };
  }

  const channel = transport.channel ?? `protochain-verify-${Date.now()}`;

  // nsqlookupd 地址（可选，用于服务发现）
  const nsqlookupdHttpEnv = role.nsq?.nsqlookupdHttpEnv;
  const nsqlookupdHttpStr = nsqlookupdHttpEnv
    ? process.env[nsqlookupdHttpEnv]
    : undefined;
  const lookupdHTTPAddresses = nsqlookupdHttpStr
    ? nsqlookupdHttpStr.split(',').map((s) => s.trim())
    : undefined;

  const reader: Reader = new nsqjs.Reader(
    responseTopic,
    channel,
    {
      lookupdHTTPAddresses,
      nsqdTCPAddresses: [`${nsqdHost}:${nsqdPort}`],
      maxInFlight: 1,
      maxAttempts: 1,
    }
  );

  const timeoutMs = transport.timeoutMs ?? role.nsq?.responseTimeoutMs ?? 30000;
  const correlationIdField = transport.correlationIdField ?? 'correlation_id';
  const correlationId = runtimeParams[correlationIdField];

  return new Promise<TransportResult>((resolve) => {
    const timeoutId = setTimeout(() => {
      reader.close();
      resolve({
        status: 504,
        data: {
          error: `等待 NSQ 响应超时（${timeoutMs}ms），topic: ${responseTopic}`,
        },
        ok: false,
      });
    }, timeoutMs);

    reader.on('message', (msg: Message) => {
      try {
        const parsed = JSON.parse(msg.body.toString());
        if (correlationId !== undefined) {
          const msgCorrelationId = parsed[correlationIdField];
          if (msgCorrelationId !== correlationId) {
            msg.requeue(0, false); // 不是本请求的响应，放回队列
            return;
          }
        }
        clearTimeout(timeoutId);
        msg.finish();
        resolve({ status: 200, data: parsed as Record<string, unknown>, ok: true });
      } catch {
        msg.finish();
        // 非 JSON 消息，跳过
      }
    });

    reader.on('error', (err: Error) => {
      clearTimeout(timeoutId);
      resolve({
        status: 502,
        data: { error: `NSQ 消费失败: ${err.message}` },
        ok: false,
      });
    });

    reader.connect();
  });
}
