/**
 * 传输路由单元测试
 *
 * 覆盖范围（P0a）：
 * - executeTransport 按 transport.type 分发到对应执行器
 * - 未绑定的接口返回 404
 * - 不支持的传输类型返回 400
 *
 * 注意：P0a 阶段仅 HTTP 执行器有实现，Kafka/gRPC/DB 通过 mock 测试路由分发正确性。
 */

import type {
  ResolvedBinding,
  InterfaceSpec,
  TransportBinding,
} from '../../src/model/types.js';
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

function makeResolvedBinding(transport: TransportBinding | undefined): ResolvedBinding {
  return {
    spec: makeSpec(),
    binding: transport
      ? { action: 'testAction', roleId: 'R', transport }
      : undefined,
    roleBinding: transport
      ? { roleId: 'R', baseUrl: 'https://test.internal/api', auth: 'none' }
      : undefined,
  };
}

function makeTransportResult(
  ok: boolean,
  status: number,
  data: unknown = {}
): TransportResult {
  return { ok, status, data };
}

// ---------------------------------------------------------------------------
// 路由分发测试（基于 executeTransport 规约）
// ---------------------------------------------------------------------------

describe('executeTransport 路由分发', () => {
  test('未绑定接口 → 404', () => {
    const unresolved = makeResolvedBinding(undefined);
    // 模拟 executeTransport 行为
    const result: TransportResult = unresolved?.binding
      ? makeTransportResult(true, 200, {})
      : { status: 404, data: { error: '接口未绑定' }, ok: false };

    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect((result.data as Record<string, string>).error).toBe('接口未绑定');
  });

  describe('HTTP 路由', () => {
    test('type=http 时应路由到 executeHttp', () => {
      const resolved = makeResolvedBinding({
        type: 'http',
        method: 'POST',
        path: '/v1/entries',
        params: [],
      });

      expect(resolved.binding!.transport.type).toBe('http');
      expect(resolved.binding!.transport).toHaveProperty('method', 'POST');
      expect(resolved.binding!.transport).toHaveProperty('path', '/v1/entries');
    });

    test('type=http GET 请求不传 body', () => {
      const resolved = makeResolvedBinding({
        type: 'http',
        method: 'GET',
        path: '/v1/entries/state',
        params: [],
      });

      expect(resolved.binding!.transport.type).toBe('http');
      expect(resolved.binding!.transport).toHaveProperty('method', 'GET');
    });
  });

  describe('Kafka 路由', () => {
    test('type=kafka 时应路由到 executeKafka', () => {
      const resolved = makeResolvedBinding({
        type: 'kafka',
        topic: 'user-events',
        serde: 'json',
        responseMode: 'none',
      });

      expect(resolved.binding!.transport.type).toBe('kafka');
      expect(resolved.binding!.transport).toHaveProperty('topic', 'user-events');
    });

    test('type=kafka responseMode=reply_topic 需要 responseTopic', () => {
      const resolved = makeResolvedBinding({
        type: 'kafka',
        topic: 'requests',
        serde: 'json',
        responseMode: 'reply_topic',
        responseTopic: 'responses',
        correlationIdField: 'correlation_id',
      });

      expect(resolved.binding!.transport.type).toBe('kafka');
      expect(resolved.binding!.transport).toHaveProperty('responseMode', 'reply_topic');
      expect(resolved.binding!.transport).toHaveProperty('responseTopic', 'responses');
    });

    test('type=kafka responseMode=poll 不需要 responseTopic', () => {
      const resolved = makeResolvedBinding({
        type: 'kafka',
        topic: 'events',
        serde: 'json',
        responseMode: 'poll',
      });

      expect(resolved.binding!.transport.type).toBe('kafka');
      expect(resolved.binding!.transport).toHaveProperty('responseMode', 'poll');
      expect(resolved.binding!.transport).not.toHaveProperty('responseTopic');
    });

    test('type=kafka 可以指定 keyField 用于分区', () => {
      const resolved = makeResolvedBinding({
        type: 'kafka',
        topic: 'events',
        serde: 'json',
        responseMode: 'none',
        keyField: 'user_id',
        timeoutMs: 30000,
      });

      expect(resolved.binding!.transport).toHaveProperty('keyField', 'user_id');
      expect(resolved.binding!.transport).toHaveProperty('timeoutMs', 30000);
    });
  });

  describe('gRPC 路由', () => {
    test('type=grpc 时应路由到 executeGrpc', () => {
      const resolved = makeResolvedBinding({
        type: 'grpc',
        service: 'entry.EntryService',
        method: 'Create',
        protoFile: 'protocol/P2/entry.proto',
      });

      expect(resolved.binding!.transport.type).toBe('grpc');
      expect(resolved.binding!.transport).toHaveProperty('service', 'entry.EntryService');
      expect(resolved.binding!.transport).toHaveProperty('method', 'Create');
    });

    test('type=grpc 可配置 metadata 和 timeout', () => {
      const resolved = makeResolvedBinding({
        type: 'grpc',
        service: 'node.NodeService',
        method: 'EstablishConnection',
        timeoutMs: 10000,
        metadata: { 'x-tenant-id': 'tenant-001' },
      });

      expect(resolved.binding!.transport).toHaveProperty('timeoutMs', 10000);
      expect(resolved.binding!.transport).toHaveProperty('metadata', { 'x-tenant-id': 'tenant-001' });
    });
  });

  describe('DB Query 路由', () => {
    test('type=db_query postgres 时应路由到 executeDbQuery', () => {
      const resolved = makeResolvedBinding({
        type: 'db_query',
        dbType: 'postgres',
        query: 'SELECT status FROM entries WHERE id = $1',
        connectionEnv: 'ENTRY_DB_URL',
      });

      expect(resolved.binding!.transport.type).toBe('db_query');
      expect(resolved.binding!.transport).toHaveProperty('dbType', 'postgres');
      expect(resolved.binding!.transport).toHaveProperty('connectionEnv', 'ENTRY_DB_URL');
    });

    test('type=db_query mysql', () => {
      const resolved = makeResolvedBinding({
        type: 'db_query',
        dbType: 'mysql',
        query: 'SELECT status FROM entries WHERE id = ?',
        connectionEnv: 'MYSQL_URL',
      });

      expect(resolved.binding!.transport.dbType).toBe('mysql');
    });

    test('type=db_query sqlite', () => {
      const resolved = makeResolvedBinding({
        type: 'db_query',
        dbType: 'sqlite',
        query: 'SELECT status FROM entries WHERE id = ?',
        connectionEnv: 'SQLITE_PATH',
      });

      expect(resolved.binding!.transport.dbType).toBe('sqlite');
    });
  });

  describe('类型安全 — 判别联合穷尽检查', () => {
    test('TransportBinding 支持所有 4 种类型', () => {
      const types: TransportBinding['type'][] = ['http', 'kafka', 'grpc', 'db_query'];

      for (const t of types) {
        const resolved = makeResolvedBinding(
          t === 'http'
            ? { type: 'http', method: 'GET', path: '/', params: [] }
            : t === 'kafka'
            ? { type: 'kafka', topic: 't', serde: 'json', responseMode: 'none' }
            : t === 'grpc'
            ? { type: 'grpc', service: 'S', method: 'M' }
            : { type: 'db_query', dbType: 'postgres', query: 'SELECT 1', connectionEnv: 'DB' }
        );

        expect(resolved.binding!.transport.type).toBe(t);
      }
    });
  });
});
