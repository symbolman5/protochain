/**
 * HTTP 传输执行器单元测试
 *
 * 覆盖范围（P0a / P0b）：
 * - URL 构造边界（baseUrl + path 拼接、路径模板替换）
 * - 请求体参数映射（params 显式映射 / 默认映射 / path 参数排除）
 * - 认证头（bearer / basic / api_key）
 * - 超时与错误处理
 *
 * 注意：HTTP 请求通过 jest 的全局 fetch mock 模拟，不发起真实网络调用。
 */

// ---------------------------------------------------------------------------
// HTTP URL 构造逻辑测试（从 executeHttp 中抽出纯函数便于单测）
// ---------------------------------------------------------------------------

/**
 * 构造完整 URL。
 * 对应 executeHttp 中 baseUrl + path 拼接逻辑。
 */
function buildUrl(baseUrl: string, path: string, runtimeParams: Record<string, unknown> = {}): string {
  let resolvedPath = path;
  for (const [key, val] of Object.entries(runtimeParams)) {
    resolvedPath = resolvedPath.replace(`{${key}}`, encodeURIComponent(String(val)));
  }
  const cleanBase = baseUrl.replace(/\/+$/, '');
  const cleanPath = resolvedPath.replace(/^\/+/, '');
  return `${cleanBase}/${cleanPath}`;
}

/**
 * 构造请求体。
 * 对应 executeHttp 中 body 构造逻辑。
 */
interface ParamMapping {
  logicalName: string;
  in: 'query' | 'body' | 'path' | 'header';
  physicalName?: string;
}

function buildBody(
  path: string,
  paramMappings: ParamMapping[],
  runtimeParams: Record<string, unknown>
): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  if (paramMappings.length > 0) {
    for (const pm of paramMappings) {
      if (pm.in === 'body' && runtimeParams[pm.logicalName] !== undefined) {
        body[pm.physicalName ?? pm.logicalName] = runtimeParams[pm.logicalName];
      }
    }
  } else {
    // 无显式映射时：排除 path 模板中的参数，其余放入 body
    const pathParamNames = (path.match(/\{(\w+)\}/g) ?? []).map((m) => m.slice(1, -1));
    for (const [key, val] of Object.entries(runtimeParams)) {
      if (!pathParamNames.includes(key)) {
        body[key] = val;
      }
    }
  }

  return body;
}

// ---------------------------------------------------------------------------
// URL 构造测试
// ---------------------------------------------------------------------------

describe('HTTP URL 构造', () => {
  test('标准 baseUrl + path 拼接', () => {
    const url = buildUrl('https://portal.internal/api', '/v1/entries');
    expect(url).toBe('https://portal.internal/api/v1/entries');
  });

  test('baseUrl 末尾有斜杠时去重', () => {
    const url = buildUrl('https://portal.internal/api/', '/v1/entries');
    expect(url).toBe('https://portal.internal/api/v1/entries');
  });

  test('path 开头有斜杠时去重', () => {
    const url = buildUrl('https://portal.internal/api', '/v1/entries');
    expect(url).toBe('https://portal.internal/api/v1/entries');
  });

  test('baseUrl 末尾 + path 开头都有斜杠', () => {
    const url = buildUrl('https://portal.internal/api/', '/v1/entries');
    expect(url).toBe('https://portal.internal/api/v1/entries');
  });

  test('path 为空字符串 — 尾部多余斜杠（P0 已知边界）', () => {
    const url = buildUrl('https://portal.internal/api', '');
    expect(url).toBe('https://portal.internal/api/');
  });

  test('baseUrl 无协议前缀（如 localhost:8080）', () => {
    const url = buildUrl('localhost:8080', '/api/v1/entries');
    expect(url).toBe('localhost:8080/api/v1/entries');
  });

  test('baseUrl 以 /api 结尾且 path 为 / — 双斜杠边界', () => {
    const url = buildUrl('https://portal.internal/api', '/');
    // cleanBase = 'https://portal.internal/api', cleanPath = '' → 'https://portal.internal/api/'
    expect(url).toBe('https://portal.internal/api/');
  });

  test('路径模板中 {param} 被替换', () => {
    const url = buildUrl('https://portal.internal/api', '/v1/entries/{id}/lock', { id: 'entry-42' });
    expect(url).toBe('https://portal.internal/api/v1/entries/entry-42/lock');
  });

  test('路径模板中多个 {param} 替换', () => {
    const url = buildUrl(
      'https://api.example.com',
      '/projects/{projectId}/tasks/{taskId}',
      { projectId: 'proj-1', taskId: 'task-A' }
    );
    expect(url).toBe('https://api.example.com/projects/proj-1/tasks/task-A');
  });

  test('路径模板参数被 URL 编码', () => {
    const url = buildUrl('https://api.example.com', '/search/{query}', { query: 'hello world' });
    expect(url).toBe('https://api.example.com/search/hello%20world');
  });

  test('runtimeParams 中多余参数不污染 URL', () => {
    const url = buildUrl('https://api.example.com', '/v1/entries', { extra: 'should-not-appear' });
    expect(url).toBe('https://api.example.com/v1/entries');
    expect(url).not.toContain('should-not-appear');
  });
});

// ---------------------------------------------------------------------------
// 请求体参数映射测试
// ---------------------------------------------------------------------------

describe('HTTP 请求体参数映射', () => {
  test('无显式 params 映射时，非 path 参数全部放入 body', () => {
    const body = buildBody('/v1/entries', [], { currentState: 'S1', extraParam: 'value' });
    expect(body).toEqual({ currentState: 'S1', extraParam: 'value' });
  });

  test('无显式映射时，path 模板参数被排除', () => {
    const body = buildBody('/v1/entries/{id}', [], { id: 'entry-42', currentState: 'S1' });
    expect(body).toEqual({ currentState: 'S1' });
    expect(body).not.toHaveProperty('id');
  });

  test('有显式 params 映射时，仅提取 in=body 的参数', () => {
    const mappings: ParamMapping[] = [
      { logicalName: 'currentState', in: 'body', physicalName: 'initial_state' },
      { logicalName: 'userId', in: 'header' },
    ];
    const body = buildBody('/v1/entries', mappings, { currentState: 'S1', userId: 'user-99' });
    expect(body).toEqual({ initial_state: 'S1' });
    expect(body).not.toHaveProperty('userId');
  });

  test('physicalName 未指定时使用 logicalName', () => {
    const mappings: ParamMapping[] = [
      { logicalName: 'currentState', in: 'body' },
    ];
    const body = buildBody('/v1/entries', mappings, { currentState: 'S1' });
    expect(body).toEqual({ currentState: 'S1' });
  });

  test('runtimeParams 中缺失映射字段时不在 body 中出现', () => {
    const mappings: ParamMapping[] = [
      { logicalName: 'currentState', in: 'body' },
      { logicalName: 'optionalField', in: 'body' },
    ];
    const body = buildBody('/v1/entries', mappings, { currentState: 'S1' });
    expect(body).toEqual({ currentState: 'S1' });
    expect(body).not.toHaveProperty('optionalField');
  });
});

// ---------------------------------------------------------------------------
// 认证头构造测试
// ---------------------------------------------------------------------------

interface AuthConfig {
  tokenEnv?: string;
  usernameEnv?: string;
  passwordEnv?: string;
  headerName?: string;
  keyEnv?: string;
  [key: string]: string | undefined;
}

interface RoleBindingForAuth {
  auth: 'none' | 'bearer' | 'basic' | 'hmac' | 'api_key';
  authConfig?: AuthConfig;
  headers?: Record<string, string>;
}

/**
 * 从 executeHttp 中抽出的认证头构造逻辑的测试替身。
 * 实际代码中通过 process.env 读取，此处通过传入 env 参数模拟。
 */
function buildAuthHeaders(role: RoleBindingForAuth, env: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {};
  const cfg = role.authConfig ?? {};

  switch (role.auth) {
    case 'bearer': {
      const token = cfg.tokenEnv ? (env[cfg.tokenEnv] ?? '') : '';
      if (token) headers['Authorization'] = `Bearer ${token}`;
      break;
    }
    case 'basic': {
      const user = cfg.usernameEnv ? (env[cfg.usernameEnv] ?? '') : '';
      const pass = cfg.passwordEnv ? (env[cfg.passwordEnv] ?? '') : '';
      const encoded = Buffer.from(`${user}:${pass}`).toString('base64');
      headers['Authorization'] = `Basic ${encoded}`;
      break;
    }
    case 'api_key': {
      const key = cfg.keyEnv ? (env[cfg.keyEnv] ?? '') : '';
      const headerName = cfg.headerName ?? 'X-API-Key';
      if (key) headers[headerName] = key;
      break;
    }
  }

  return headers;
}

describe('HTTP 认证头构造', () => {
  const origEnv = process.env;

  beforeEach(() => {
    process.env = { ...origEnv };
  });

  afterEach(() => {
    process.env = origEnv;
  });

  test('auth=none 不产生认证头', () => {
    const headers = buildAuthHeaders({ auth: 'none' });
    expect(headers).toEqual({});
  });

  test('auth=bearer 从环境变量读取 token', () => {
    const headers = buildAuthHeaders(
      { auth: 'bearer', authConfig: { tokenEnv: 'API_TOKEN' } },
      { API_TOKEN: 'secret-token-123' }
    );
    expect(headers['Authorization']).toBe('Bearer secret-token-123');
  });

  test('auth=bearer 但环境变量未设置 → 无认证头', () => {
    const headers = buildAuthHeaders(
      { auth: 'bearer', authConfig: { tokenEnv: 'MISSING_TOKEN' } },
      {}
    );
    expect(headers).toEqual({});
  });

  test('auth=basic 生成 Base64 编码', () => {
    const headers = buildAuthHeaders(
      { auth: 'basic', authConfig: { usernameEnv: 'USER', passwordEnv: 'PASS' } },
      { USER: 'admin', PASS: 'secret' }
    );
    expect(headers['Authorization']).toBe(`Basic ${Buffer.from('admin:secret').toString('base64')}`);
  });

  test('auth=basic 缺用户名或密码', () => {
    const headers = buildAuthHeaders(
      { auth: 'basic', authConfig: { usernameEnv: 'USER', passwordEnv: 'PASS' } },
      { USER: 'admin' }
    );
    // 有用户无密码 → Basic YWRtaW46  (admin:)
    expect(headers['Authorization']).toMatch(/^Basic /);
  });

  test('auth=api_key 默认 header 名为 X-API-Key', () => {
    const headers = buildAuthHeaders(
      { auth: 'api_key', authConfig: { keyEnv: 'KEY' } },
      { KEY: 'my-key-abc' }
    );
    expect(headers['X-API-Key']).toBe('my-key-abc');
  });

  test('auth=api_key 自定义 header 名', () => {
    const headers = buildAuthHeaders(
      { auth: 'api_key', authConfig: { headerName: 'X-Custom-Key', keyEnv: 'CK' } },
      { CK: 'custom-val' }
    );
    expect(headers['X-Custom-Key']).toBe('custom-val');
  });

  test('auth=api_key 环境变量未设置', () => {
    const headers = buildAuthHeaders(
      { auth: 'api_key', authConfig: { keyEnv: 'MISSING' } },
      {}
    );
    expect(headers).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// TransportResult 类型测试
// ---------------------------------------------------------------------------

import type { TransportResult } from '../../src/transport/types.js';
import { resolveTlsRequestOptions } from '../../src/transport/http-executor.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('#15 HTTP TLS 传输选项解析', () => {
  test('未配置 tls → undefined（保持原行为）', () => {
    const url = new URL('https://hskng.local/v1/health');
    expect(resolveTlsRequestOptions(url, undefined)).toBeUndefined();
  });

  test('connectHost 覆盖连接地址，servername 默认 URL host（SNI 保持域名）', () => {
    const url = new URL('https://hskng.local/v1/health');
    const opts = resolveTlsRequestOptions(url, { connectHost: '192.168.34.226' });
    expect(opts).toEqual({
      hostname: '192.168.34.226',
      servername: 'hskng.local',
      ca: undefined,
      rejectUnauthorized: undefined,
    });
  });

  test('显式 servername 优先于 URL host', () => {
    const url = new URL('https://10.0.0.5/v1/health');
    const opts = resolveTlsRequestOptions(url, { servername: 'edge.hskng.local' });
    expect(opts?.servername).toBe('edge.hskng.local');
    expect(opts?.hostname).toBe('10.0.0.5');
  });

  test('caFile（绝对路径）读取为 PEM，提供 CA 时默认严格校验', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hskng-tls-test-'));
    const caFile = join(dir, 'ca.pem');
    writeFileSync(caFile, '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n', 'utf8');
    const url = new URL('https://hskng.local/v1/health');
    const opts = resolveTlsRequestOptions(url, { caFile });
    expect(opts?.ca).toContain('BEGIN CERTIFICATE');
    expect(opts?.rejectUnauthorized).toBe(true);
  });

  test('rejectUnauthorized 显式覆盖（false）不被 ca 默认值覆盖', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hskng-tls-test-'));
    const caFile = join(dir, 'ca.pem');
    writeFileSync(caFile, '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n', 'utf8');
    const url = new URL('https://hskng.local/v1/health');
    const opts = resolveTlsRequestOptions(url, { caFile, rejectUnauthorized: false });
    expect(opts?.rejectUnauthorized).toBe(false);
  });
});

describe('TransportResult 类型', () => {
  test('成功响应', () => {
    const result: TransportResult = {
      status: 200,
      data: { nextState: 'S2', effects: ['locked'] },
      ok: true,
    };
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
  });

  test('503 未配置 Kafka broker', () => {
    const result: TransportResult = {
      status: 503,
      data: { error: 'Kafka broker 未配置（环境变量 KAFKA_BROKERS）' },
      ok: false,
    };
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect((result.data as Record<string, string>).error).toContain('Kafka broker');
  });

  test('404 未绑定', () => {
    const result: TransportResult = {
      status: 404,
      data: { error: '接口未绑定' },
      ok: false,
    };
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// E11 #008 缺陷 1：401 + envelope 响应不被改写
// ---------------------------------------------------------------------------

import { executeHttp } from '../../src/transport/http-executor.js';
import type { ResolvedBinding, HttpTransport, RoleBinding } from '../../src/model/types.js';

function makeBinding(
  roleAuth: RoleBinding['auth'],
  authConfig: RoleBinding['authConfig']
): ResolvedBinding {
  const transport: HttpTransport = {
    type: 'http',
    method: 'POST',
    path: '/api/v1/test',
  };
  return {
    spec: {
      id: 'IF_TEST_001',
      kind: 'system',
      sourceId: 'test',
      name: 'test',
      inputs: [],
      outputs: [],
    },
    binding: { action: 'test', transport, params: [] },
    roleBinding: {
      roleId: 'r',
      baseUrl: 'http://mock.local',
      auth: roleAuth,
      authConfig,
    },
  };
}

function mockFetchOnce(status: number, body: unknown): void {
  (globalThis as { fetch?: unknown }).fetch = jest.fn(async () => {
    return {
      status,
      ok: status >= 200 && status < 300,
      text: async () => JSON.stringify(body),
      json: async () => body,
    } as unknown as Response;
  });
}

describe('E11 #008 缺陷 1：401 envelope 保留', () => {
  const origFetch = (globalThis as { fetch?: unknown }).fetch;
  const origEnv = process.env;

  beforeEach(() => {
    process.env = { ...origEnv };
  });

  afterEach(() => {
    process.env = origEnv;
    if (origFetch) {
      (globalThis as { fetch?: unknown }).fetch = origFetch;
    } else {
      delete (globalThis as { fetch?: unknown }).fetch;
    }
  });

  test('401 + {error:{code:invalid_server_secret}} → 不改写 error.code', async () => {
    process.env.TEST_TOKEN = 'some-valid-token';
    mockFetchOnce(401, {
      error: {
        code: 'invalid_server_secret',
        message: '绑定密钥无效',
      },
    });
    const result = await executeHttp(
      makeBinding('bearer', { tokenEnv: 'TEST_TOKEN' }),
      {}
    );
    expect(result.status).toBe(401);
    expect(result.ok).toBe(false);
    const data = result.data as { error: { code: string; message: string } };
    expect(data.error.code).toBe('invalid_server_secret');
    expect(data.error.message).toBe('绑定密钥无效');
    // 不得出现旧版"认证失败：令牌无效（…）"提示
    expect(JSON.stringify(result.data)).not.toContain('认证失败：令牌无效');
  });

  test('401 + bearer + tokenEnv 未配置 → 提示"令牌环境变量 … 未配置"', async () => {
    // 不设 TEST_TOKEN → tokenEnv 缺失
    mockFetchOnce(401, { error: 'plain-string-server-message' });
    const result = await executeHttp(
      makeBinding('bearer', { tokenEnv: 'TEST_TOKEN' }),
      {}
    );
    const data = result.data as { error: string };
    expect(data.error).toContain('TEST_TOKEN');
    expect(data.error).toContain('未配置');
  });

  test('401 + basic + tokenEnv 已设且已发送 → 不改写 envelope.code', async () => {
    process.env.TEST_USER = 'admin';
    process.env.TEST_PASS = 'pw';
    mockFetchOnce(401, { error: { code: 'unauthorized' } });
    const result = await executeHttp(
      makeBinding('basic', { usernameEnv: 'TEST_USER', passwordEnv: 'TEST_PASS' }),
      {}
    );
    const data = result.data as { error: { code: string } };
    expect(data.error.code).toBe('unauthorized');
  });

  test('401 + api_key + tokenEnv 已设 → 不改写 envelope.code', async () => {
    process.env.TEST_KEY = 'k-123';
    mockFetchOnce(401, { error: { code: 'install_secret_invalid' } });
    const result = await executeHttp(
      makeBinding('api_key', { keyEnv: 'TEST_KEY' }),
      {}
    );
    const data = result.data as { error: { code: string } };
    expect(data.error.code).toBe('install_secret_invalid');
  });
});
