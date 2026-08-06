/**
 * HTTP 传输执行器
 *
 * 完整设计参见 docs/binding-mechanism-plan.md 第 4.3.1 节。
 */

import http from 'node:http';
import https from 'node:https';

import type { ResolvedBinding, HttpTransport } from '../model/types.js';
import type { TransportResult } from './types.js';

/**
 * 构造完整 URL。
 * 拼接逻辑：role.baseUrl（去尾斜杠）+ '/' + transport.path（去首斜杠）
 * 处理路径模板参数：{paramName} 替换为 runtimeParams[paramName]
 */
export function buildUrl(
  baseUrl: string,
  path: string,
  runtimeParams: Record<string, unknown>
): string {
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
 * - 有显式 params 映射时：仅提取 in='body' 的字段
 * - 无显式映射时：排除 path 模板参数，其余全部放入 body
 */
export function buildBody(
  path: string,
  paramMappings: import('../model/types.js').HttpParamBinding[],
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
    const pathParamNames = (path.match(/\{(\w+)\}/g) ?? []).map((m) => m.slice(1, -1));
    for (const [key, val] of Object.entries(runtimeParams)) {
      if (!pathParamNames.includes(key)) {
        body[key] = val;
      }
    }
  }

  return body;
}

/**
 * 构造认证头。
 */
export function buildAuthHeaders(
  role: NonNullable<ResolvedBinding['roleBinding']>
): Record<string, string> {
  const headers: Record<string, string> = {};
  const cfg = role.authConfig ?? {};

  switch (role.auth) {
    case 'bearer': {
      const token = cfg.tokenEnv ? (process.env[cfg.tokenEnv] ?? '') : '';
      if (token) headers['Authorization'] = `Bearer ${token}`;
      break;
    }
    case 'basic': {
      const user = cfg.usernameEnv ? (process.env[cfg.usernameEnv] ?? '') : '';
      const pass = cfg.passwordEnv ? (process.env[cfg.passwordEnv] ?? '') : '';
      const encoded = Buffer.from(`${user}:${pass}`).toString('base64');
      headers['Authorization'] = `Basic ${encoded}`;
      break;
    }
    case 'api_key': {
      const key = cfg.keyEnv ? (process.env[cfg.keyEnv] ?? '') : '';
      const headerName = cfg.headerName ?? 'X-API-Key';
      if (key) headers[headerName] = key;
      break;
    }
    // hmac / mtls 由传输执行器的底层库处理，此版本不展开
  }

  return headers;
}

/**
 * 检测认证所需环境变量是否缺失。
 * 返回缺失提示；全部配置齐备或 auth 不需要环境变量时返回 undefined。
 */
function missingAuthEnvHint(
  role: NonNullable<ResolvedBinding['roleBinding']>
): string | undefined {
  const cfg = role.authConfig ?? {};
  switch (role.auth) {
    case 'bearer':
      if (cfg.tokenEnv && !process.env[cfg.tokenEnv]) {
        return `令牌环境变量 ${cfg.tokenEnv} 未配置`;
      }
      return undefined;
    case 'basic':
      if (cfg.usernameEnv && !process.env[cfg.usernameEnv]) {
        return `用户名环境变量 ${cfg.usernameEnv} 未配置`;
      }
      if (cfg.passwordEnv && !process.env[cfg.passwordEnv]) {
        return `密码环境变量 ${cfg.passwordEnv} 未配置`;
      }
      return undefined;
    case 'api_key':
      if (cfg.keyEnv && !process.env[cfg.keyEnv]) {
        return `API Key 环境变量 ${cfg.keyEnv} 未配置`;
      }
      return undefined;
    default:
      return undefined;
  }
}

/**
 * 用 Node http/https 模块执行请求。
 * 必要场景：bindings 声明了 Host header 时，Node fetch（undici）会忽略自定义 Host，
 * 无法路由到基于虚拟主机的 ingress/nginx——必须用底层 http.request 发送。
 */
function httpRequestRaw(
  urlStr: string,
  opts: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    timeoutMs: number;
  }
): Promise<{ status: number; data: unknown; ok: boolean }> {
  return new Promise((resolve) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;
    const payload = opts.body;
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80,
        path: `${u.pathname}${u.search}`,
        method: opts.method,
        headers: {
          ...opts.headers,
          ...(payload !== undefined
            ? { 'Content-Length': Buffer.byteLength(payload) }
            : {}),
        },
        timeout: opts.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          let data: unknown;
          try {
            data = JSON.parse(text);
          } catch {
            data = text;
          }
          const status = res.statusCode ?? 0;
          resolve({ status, data, ok: status >= 200 && status < 300 });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`请求超时（${opts.timeoutMs}ms）`)));
    req.on('error', (err) => {
      resolve({
        status: 504,
        data: { error: err instanceof Error ? err.message : String(err) },
        ok: false,
      });
    });
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/**
 * 通过 HTTP 执行一次接口调用。
 *
 * @param binding 已解析的绑定（含 spec、binding、roleBinding）
 * @param runtimeParams 运行时参数（当前状态、路径变量等）
 */
export async function executeHttp(
  binding: ResolvedBinding,
  runtimeParams: Record<string, unknown>
): Promise<TransportResult> {
  const transport = binding.binding!.transport as HttpTransport;
  const role = binding.roleBinding!;

  const url = buildUrl(role.baseUrl, transport.path, runtimeParams);

  const body = buildBody(transport.path, transport.params ?? [], runtimeParams);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(role.headers ?? {}),
    ...buildAuthHeaders(role),
  };

  const timeoutMs = transport.timeoutMs ?? 10000;
  const hasHostHeader = Object.keys(headers).some((k) => k.toLowerCase() === 'host');

  const raw: { status: number; data: unknown; ok: boolean } = await (async () => {
    try {
      const payload = ['GET', 'HEAD'].includes(transport.method)
        ? undefined
        : JSON.stringify(body);
      if (hasHostHeader) {
        return httpRequestRaw(url, {
          method: transport.method,
          headers,
          body: payload,
          timeoutMs,
        });
      }
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method: transport.method,
          headers,
          body: payload,
          signal: controller.signal,
        });
        const text = await res.text();
        let data: unknown;
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
        return { status: res.status, data, ok: res.status >= 200 && res.status < 300 };
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      const message = err instanceof Error
        ? (err.name === 'AbortError' ? `请求超时（${timeoutMs}ms）` : err.message)
        : String(err);
      return { status: 504, data: { error: message }, ok: false };
    }
  })();

  // 401 文案区分：认证所需环境变量未配置 vs 令牌已发送但被拒绝（无效/无权限）
  if (raw.status === 401) {
    const record = raw.data && typeof raw.data === 'object' ? (raw.data as Record<string, unknown>) : {};
    const serverMsg = typeof record['error'] === 'string' ? record['error'] : '';
    const hint = missingAuthEnvHint(role);
    if (hint) {
      raw.data = { ...record, error: `认证失败：${hint}` };
    } else if (role.auth === 'bearer' || role.auth === 'basic' || role.auth === 'api_key') {
      raw.data = { ...record, error: `认证失败：令牌无效${serverMsg ? `（${serverMsg}）` : ''}` };
    }
  }

  return { status: raw.status, data: raw.data, ok: raw.ok };
}
