/**
 * 绑定机制集成测试 — 完整管线验证
 *
 * 管线：parseProtocolContent → specify → resolveBindings → executeTransport → 状态比较
 *
 * 使用本地 HTTP mock 服务器模拟外部系统接口，验证：
 * - P0a：系统接口 HTTP 触发 + 信任 nextState 响应
 * - P0b：三步闭环（触发 → 独立观测 → 比较）
 * - 未绑定接口的正确报错
 * - Kafka/DB/gRPC 未实现时返回 501
 *
 * 所有 HTTP 调用通过 Node.js 原生 http 模块构建的本地服务器处理，
 * 不依赖外部服务。
 */

import * as http from 'node:http';
import { AddressInfo } from 'node:net';

import { parseProtocolContent } from '../../src/parser/index.js';
import { specify, specsFromEnvelope } from '../../src/specifier/index.js';
import { resolveBindings, validateBindings, findBinding } from '../../src/binder/index.js';
import { executeTransport } from '../../src/transport/index.js';
import type {
  InterfaceSpec,
  BindingConfig,
  ResolvedBinding,
  RoleBinding,
  InterfaceBinding,
} from '../../src/model/types.js';
import type { TransportResult } from '../../src/transport/types.js';

// ---------------------------------------------------------------------------
// Mock HTTP 服务器
// ---------------------------------------------------------------------------

/** 服务器处理函数类型：接收 (method, url, body) → 返回 { status, body } */
type HttpHandler = (
  method: string,
  url: string,
  body: unknown
) => { status: number; body: unknown };

/**
 * 启动本地 mock HTTP 服务器并返回 baseUrl。
 * 服务器按 handler 响应所有请求。
 */
function startMockServer(handler: HttpHandler): Promise<{ server: http.Server; baseUrl: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let rawBody = '';
      req.on('data', (chunk: Buffer) => {
        rawBody += chunk.toString();
      });
      req.on('end', () => {
        let parsed: unknown = undefined;
        if (rawBody) {
          try {
            parsed = JSON.parse(rawBody);
          } catch {
            parsed = rawBody;
          }
        }
        const { status, body } = handler(req.method ?? 'GET', req.url ?? '/', parsed);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });

    server.listen(0, () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://localhost:${addr.port}` });
    });

    server.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// 测试辅助函数
// ---------------------------------------------------------------------------

/** 为给定 baseUrl 创建 BindingConfig */
function createBindingConfig(
  baseUrl: string,
  interfaces: BindingConfig['interfaces']
): BindingConfig {
  return {
    roles: {
      R: { roleId: 'R', baseUrl, auth: 'none' },
    },
    interfaces,
  };
}

/**
 * 运行完整的绑定管线：
 * 1. 解析 → 规格推导
 * 2. 合并绑定 → 按 action 执行
 * 3. 收集每步执行结果 + 观测结果
 */
async function runBindingPipeline(
  modelContent: string,
  config: BindingConfig,
  actionCalls: { action: string; params: Record<string, unknown> }[],
  observationCalls?: { action: string; params: Record<string, unknown> }[]
): Promise<{
  actionResults: TransportResult[];
  obsResults?: TransportResult[];
  specs: InterfaceSpec[];
  resolved: ResolvedBinding[];
}> {
  const model = parseProtocolContent(modelContent);
  const specs = specsFromEnvelope(specify(model));
  const resolved = resolveBindings(specs, config);

  // 执行系统接口动作
  const actionResults: TransportResult[] = [];
  for (const call of actionCalls) {
    const r = findBinding(resolved, call.action);
    const result = await executeTransport(r, call.params);
    actionResults.push(result);
  }

  // 执行观测接口
  let obsResults: TransportResult[] | undefined;
  if (observationCalls) {
    obsResults = [];
    for (const call of observationCalls) {
      const r = findBinding(resolved, call.action);
      const result = await executeTransport(r, call.params);
      obsResults.push(result);
    }
  }

  return { actionResults, obsResults, specs, resolved };
}

// ---------------------------------------------------------------------------
// P0a 集成测试：HTTP 触发 + 信任 nextState
// ---------------------------------------------------------------------------

describe('P0a 集成：HTTP 系统接口触发 + 验证响应', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    // 构建 mock server：状态机为 S1→S2→S3
    let currentState = 'S1';

    const { server: s, baseUrl: b } = await startMockServer((method, url, body) => {
      if (method === 'POST' && url === '/step1') {
        currentState = 'S2';
        return { status: 200, body: { nextState: 'S2' } };
      }
      if (method === 'POST' && url === '/step2') {
        currentState = 'S3';
        return { status: 200, body: { nextState: 'S3' } };
      }
      if (method === 'GET' && url === '/state') {
        return { status: 200, body: { currentState } };
      }
      return { status: 404, body: { error: 'not found' } };
    });
    server = s;
    baseUrl = b;
  });

  afterAll(() => {
    server.close();
  });

  test('完整管线：模型 → 接口触发 → HTTP 调用 → 状态转移', async () => {
    const config = createBindingConfig(baseUrl, [
      {
        action: 'step1',
        roleId: 'R',
        transport: { type: 'http', method: 'POST', path: '/step1', params: [] },
      },
      {
        action: 'step2',
        roleId: 'R',
        transport: { type: 'http', method: 'POST', path: '/step2', params: [] },
      },
    ]);

    const modelContent = `---
name: 两步协议
version: 1.0.0
purpose: 集成测试
roles:
  - id: user
    name: 用户
    responsibilities: 测试
---
# 背景

测试用协议。

# 状态空间

| ID | 名称 | 类型 | 描述 |
|---|---|---|---|
| S1 | 初态 | initial | |
| S2 | 中态 | normal | |
| S3 | 终态 | terminal | |

# 转移规则

| ID | 名称 | from | to | action | trigger |
|---|---|---|---|---|---|
| T1 | 走 | S1 | S2 | step1 | user |
| T2 | 再走 | S2 | S3 | step2 | user |
`;

    const { actionResults } = await runBindingPipeline(
      modelContent,
      config,
      [
        { action: 'step1', params: { currentState: 'S1' } },
        { action: 'step2', params: { currentState: 'S2' } },
      ]
    );

    // P0a：信任 nextState 响应
    expect(actionResults[0].ok).toBe(true);
    expect((actionResults[0].data as Record<string, unknown>).nextState).toBe('S2');

    expect(actionResults[1].ok).toBe(true);
    expect((actionResults[1].data as Record<string, unknown>).nextState).toBe('S3');
  });

  test('接口调用失败时返回 error', async () => {
    const config = createBindingConfig(baseUrl, [
      {
        action: 'fail',
        roleId: 'R',
        transport: { type: 'http', method: 'GET', path: '/nonexistent', params: [] },
      },
    ]);

    const modelContent = `---
name: 失败协议
version: 1.0.0
purpose: 测试失败
roles:
  - id: user
    name: 用户
    responsibilities: 测试
---
# 背景

测试

# 状态空间

| ID | 名称 | 类型 | 描述 |
|---|---|---|---|
| S1 | 初态 | initial | |

# 转移规则

| ID | 名称 | from | to | action | trigger |
|---|---|---|---|---|---|
| T1 | 失败 | S1 | S1 | fail | user |
`;

    const { actionResults } = await runBindingPipeline(
      modelContent, config, [{ action: 'fail', params: {} }]
    );

    expect(actionResults[0].ok).toBe(false);
    expect(actionResults[0].status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// P0b 集成测试：独立观测接口验证
// ---------------------------------------------------------------------------

describe('P0b 集成：触发 + 独立观测 + 比较', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    // mock 服务器区分系统接口和观测接口
    let state = 'S1';

    const { server: s, baseUrl: b } = await startMockServer((method, url) => {
      // 系统接口：触发状态转移
      if (method === 'POST' && url === '/submit') {
        state = 'S2';
        return { status: 200, body: { nextState: 'S2' } };
      }
      if (method === 'POST' && url === '/approve') {
        state = 'S3';
        return { status: 200, body: { nextState: 'S3' } };
      }
      // 观测接口：独立读取状态（与系统接口不同 path）
      if (method === 'GET' && url === '/observe/state') {
        return { status: 200, body: { currentState: state } };
      }
      return { status: 404, body: { error: 'not found' } };
    });
    server = s;
    baseUrl = b;
  });

  afterAll(() => {
    server.close();
  });

  test('三步闭环：动作触发后通过观测接口独立读取状态并比较', async () => {
    const config = createBindingConfig(baseUrl, [
      {
        action: 'submit',
        roleId: 'R',
        transport: { type: 'http', method: 'POST', path: '/submit', params: [] },
      },
      {
        action: 'approve',
        roleId: 'R',
        transport: { type: 'http', method: 'POST', path: '/approve', params: [] },
      },
      {
        action: 'observe_待审批',
        roleId: 'R',
        transport: { type: 'http', method: 'GET', path: '/observe/state', params: [] },
      },
      {
        action: 'observe_已通过',
        roleId: 'R',
        transport: { type: 'http', method: 'GET', path: '/observe/state', params: [] },
      },
    ]);

    const modelContent = `---
name: 审批协议
version: 1.0.0
purpose: P0b 集成测试
roles:
  - id: user
    name: 用户
    responsibilities: 测试
---
# 背景

测试审批流。

# 状态空间

| ID | 名称 | 类型 | 描述 |
|---|---|---|---|
| S1 | 草稿 | initial | |
| S2 | 待审批 | normal | |
| S3 | 已通过 | terminal | |

# 转移规则

| ID | 名称 | from | to | action | trigger |
|---|---|---|---|---|---|
| T1 | 提交 | S1 | S2 | submit | user |
| T2 | 通过 | S2 | S3 | approve | user |
`;

    // 构建观测接口双向索引
    const model = parseProtocolContent(modelContent);
    const specs = specsFromEnvelope(specify(model));
    const resolved = resolveBindings(specs, config);

    // Step 1: 执行 submit（S1 → S2）
    const submitBinding = resolved.find((r) => r.spec.name === 'submit')!;
    const submitResult = await executeTransport(submitBinding, { currentState: 'S1' });
    expect(submitResult.ok).toBe(true);

    // Step 2: 独立观测 S2（不信任 submit 响应的 nextState）
    const observeS2 = resolved.find((r) => r.spec.name === 'observe_待审批')!;
    const obsS2Result = await executeTransport(observeS2, {});
    expect(obsS2Result.ok).toBe(true);

    const actualS2 = (obsS2Result.data as Record<string, unknown>).currentState as string;
    expect(actualS2).toBe('S2'); // 独立观测验证

    // 系统接口和观测接口使用不同的 path
    const submitPath = (submitBinding.binding!.transport as { path: string }).path;
    const obsPath = (observeS2.binding!.transport as { path: string }).path;
    expect(submitPath).not.toBe(obsPath);

    // Step 1: 执行 approve（S2 → S3）
    const approveBinding = resolved.find((r) => r.spec.name === 'approve')!;
    const approveResult = await executeTransport(approveBinding, { currentState: 'S2' });
    expect(approveResult.ok).toBe(true);

    // Step 2: 独立观测 S3
    const observeS3 = resolved.find((r) => r.spec.name === 'observe_已通过')!;
    const obsS3Result = await executeTransport(observeS3, {});
    const actualS3 = (obsS3Result.data as Record<string, unknown>).currentState as string;
    expect(actualS3).toBe('S3');
  });

  test('bind 命令行为：验证绑定完整性', () => {
    const modelContent = `---
name: 校验测试
version: 1.0.0
purpose: 测试 bind
roles:
  - id: user
    name: 用户
    responsibilities: 测试
---
# 背景

测试

# 状态空间

| ID | 名称 | 类型 | 描述 |
|---|---|---|---|
| S1 | 初态 | initial | |
| S2 | 终态 | terminal | |

# 转移规则

| ID | 名称 | from | to | action | trigger |
|---|---|---|---|---|---|
| T1 | 走 | S1 | S2 | go | user |
`;

    const model = parseProtocolContent(modelContent);
    const specs = specsFromEnvelope(specify(model));

    // 只绑定系统接口，不绑定观测接口
    const partialConfig = createBindingConfig('http://test', [
      {
        action: 'go',
        roleId: 'R',
        transport: { type: 'http', method: 'POST', path: '/go', params: [] },
      },
    ]);

    const report = validateBindings(specs, partialConfig);
    // 观测接口缺失 → valid=false
    expect(report.valid).toBe(false);
    expect(report.missingSystem).toHaveLength(0);
    expect(report.missingObservation.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 传输路由测试：Kafka/DB/gRPC 未实现时返回 501
// ---------------------------------------------------------------------------

describe('传输路由：未实现传输类型的错误处理', () => {
  test('Kafka 传输无 broker 时返回 503', async () => {
    const resolved: ResolvedBinding = {
      spec: { id: 'IF1', kind: 'system', sourceId: 'test', name: 'test', inputs: [], outputs: [] },
      binding: {
        action: 'test',
        roleId: 'R',
        transport: { type: 'kafka', topic: 't', serde: 'json', responseMode: 'none' },
      },
      roleBinding: { roleId: 'R', baseUrl: '', auth: 'none' },
    };
    const result = await executeTransport(resolved, {});
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect((result.data as Record<string, string>).error).toContain('Kafka');
  });

  test('gRPC 传输返回 501', async () => {
    const resolved: ResolvedBinding = {
      spec: { id: 'IF1', kind: 'system', sourceId: 'test', name: 'test', inputs: [], outputs: [] },
      binding: {
        action: 'test',
        roleId: 'R',
        transport: { type: 'grpc', service: 'S', method: 'M' },
      },
      roleBinding: { roleId: 'R', baseUrl: '', auth: 'none' },
    };
    const result = await executeTransport(resolved, {});
    expect(result.ok).toBe(false);
    expect(result.status).toBe(501);
    expect((result.data as Record<string, string>).error).toContain('gRPC');
  });

  test('DB 查询传输返回 501', async () => {
    const resolved: ResolvedBinding = {
      spec: { id: 'IF1', kind: 'system', sourceId: 'test', name: 'test', inputs: [], outputs: [] },
      binding: {
        action: 'test',
        roleId: 'R',
        transport: { type: 'db_query', dbType: 'postgres', query: 'SELECT 1', connectionEnv: 'DB' },
      },
      roleBinding: { roleId: 'R', baseUrl: '', auth: 'none' },
    };
    const result = await executeTransport(resolved, {});
    expect(result.ok).toBe(false);
    expect(result.status).toBe(501);
    expect((result.data as Record<string, string>).error).toContain('数据库');
  });

  test('未绑定接口返回 404', async () => {
    const result = await executeTransport(undefined, {});
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect((result.data as Record<string, string>).error).toContain('未绑定');
  });
});

// ---------------------------------------------------------------------------
// 观测接口独立验证 — 错误路径
// ---------------------------------------------------------------------------

describe('观测接口错误路径', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const { server: s, baseUrl: b } = await startMockServer(() => {
      return { status: 500, body: { error: 'Internal Server Error' } };
    });
    server = s;
    baseUrl = b;
  });

  afterAll(() => {
    server.close();
  });

  test('观测接口 500 时返回错误（不阻塞，记录偏差）', async () => {
    const resolved: ResolvedBinding = {
      spec: { id: 'IF_OBS', kind: 'observation', sourceId: 'S1', name: 'observe_初态', inputs: [], outputs: [] },
      binding: {
        action: 'observe_初态',
        roleId: 'R',
        transport: { type: 'http', method: 'GET', path: '/observe', params: [] },
      },
      roleBinding: { roleId: 'R', baseUrl, auth: 'none' },
    };

    const result = await executeTransport(resolved, {});
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// validateBindings 管线集成
// ---------------------------------------------------------------------------

describe('validateBindings + resolveBindings 管线', () => {
  test('完整绑定通过校验后 valid=true', () => {
    const modelContent = `---
name: 完整绑定
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

| ID | 名称 | 类型 | 描述 |
|---|---|---|---|
| S1 | 初态 | initial | |
| S2 | 终态 | terminal | |

# 转移规则

| ID | 名称 | from | to | action | trigger |
|---|---|---|---|---|---|
| T1 | 走 | S1 | S2 | go | user |
`;

    const model = parseProtocolContent(modelContent);
    const specs = specsFromEnvelope(specify(model));

    const config = createBindingConfig('http://test', [
      { action: 'go', roleId: 'R', transport: { type: 'http', method: 'POST', path: '/go', params: [] } },
      { action: 'observe_初态', roleId: 'R', transport: { type: 'http', method: 'GET', path: '/s1', params: [] } },
      { action: 'observe_终态', roleId: 'R', transport: { type: 'http', method: 'GET', path: '/s2', params: [] } },
    ]);

    const report = validateBindings(specs, config);
    expect(report.valid).toBe(true);
    expect(report.missingSystem).toHaveLength(0);
    expect(report.missingObservation).toHaveLength(0);
    expect(report.warnings).toHaveLength(0);

    const resolved = resolveBindings(specs, config);
    expect(resolved).toHaveLength(specs.length);
    // 所有 resolved 都有 binding
    for (const r of resolved) {
      expect(r.binding).toBeDefined();
    }
  });
});
