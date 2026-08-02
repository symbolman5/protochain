/**
 * 传输执行器路由器
 *
 * 按 transport.type 分发到对应的执行器。
 */

import type { ResolvedBinding } from '../model/types.js';
import type { TransportResult } from './types.js';
import { executeHttp } from './http-executor.js';
import { executeKafka } from './kafka-executor.js';
import { executeNsq } from './nsq-executor.js';

/**
 * 按传输类型路由到对应的执行器。
 *
 * - type='http'       → executeHttp  (P0 已实现)
 * - type='kafka'      → executeKafka (P1 已实现)
 * - type='nsq'        → executeNsq   (P1 已实现)
 * - type='grpc'       → P2 阶段实现
 * - type='db_query'   → P1 阶段实现
 *
 * @returns TransportResult；若 binding 不存在或类型不支持则返回 error
 */
export async function executeTransport(
  resolved: ResolvedBinding | undefined,
  runtimeParams: Record<string, unknown>
): Promise<TransportResult> {
  if (!resolved?.binding) {
    return {
      status: 404,
      data: { error: '接口未绑定' },
      ok: false,
    };
  }

  const transportType = resolved.binding.transport.type;

  switch (transportType) {
    case 'http':
      return executeHttp(resolved, runtimeParams);

    case 'kafka':
      return executeKafka(resolved, runtimeParams);

    case 'nsq':
      return executeNsq(resolved, runtimeParams);

    case 'grpc':
      return {
        status: 501,
        data: { error: 'gRPC 传输尚未实现（P2 阶段）' },
        ok: false,
      };

    case 'db_query':
      return {
        status: 501,
        data: { error: '数据库查询传输尚未实现（P1 阶段）' },
        ok: false,
      };

    default:
      return {
        status: 400,
        data: { error: `不支持的传输类型: ${String(transportType)}` },
        ok: false,
      };
  }
}
