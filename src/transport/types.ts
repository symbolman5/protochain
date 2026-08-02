/**
 * 传输执行器类型定义
 */

import type { ResolvedBinding } from '../model/types.js';

/** 传输执行结果 */
export interface TransportResult {
  /** HTTP 状态码或等价结果码（200=成功） */
  status: number;
  /** 响应体（JSON 解析后） */
  data: unknown;
  /** 是否成功（status 为 2xx 或业务成功标记） */
  ok: boolean;
}

/** 传输执行器接口 */
export interface TransportExecutor {
  /** 执行一次传输调用 */
  execute(
    binding: ResolvedBinding,
    /** 运行时参数（来自测试用例的当前状态及路径变量） */
    runtimeParams: Record<string, unknown>
  ): Promise<TransportResult>;
}
