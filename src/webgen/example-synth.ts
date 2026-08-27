/**
 * G6 · 示例合成助手（10 §17.2 / §17.3 C-G6-2 / 13-execution-G6 T2）
 *
 * 纯函数（无 DOM / 无运行时依赖 / 无 fetch），仅由 schema 派生——天然过 Gif-3 脱敏（红线⑤）。
 * 两个导出：
 *  - `synthesizeExample(schema, seed)`：递归 JSON Schema → 确定性 mock 值（seed 保 diff 稳定）；
 *  - `buildCodeSamples(spec, transportWithServer)`：基于 transport(method/path/server) + 请求 schema
 *    生成 curl / javascript(fetch) / python(requests) 三语言代码样例。
 *
 * 纪律（10 §17 / 13 §0 红线）：
 *  - 零推导：示例/代码样例由工具链预投影，viewer 只读查表渲染（红线②）；
 *  - 不读 authConfig/tls/真实值（红线⑤ / G6-6）；失败降级：schema 缺失 → 返回 null（不抛）；
 *  - 不引入任何运行时依赖（纯 Node）。
 */

import type { JSONSchema, InterfaceSpec } from '../model/types.js';

/** transport 行（含 server）中间形态（与 ProjectInterfaceBinding.transport[] 口径一致，10 §17.2） */
export interface TransportWithServer {
  type?: string;
  method?: string;
  path?: string;
  roleId?: string;
  protocol?: string;
  /** 按 roleId 查 bindingView.roles[roleId].baseUrl 拼接（T3 完成） */
  server?: string;
}

/** 代码样例条目（10 §17.2：lang/label/code 三元组） */
export interface CodeSample {
  lang: string;
  label: string;
  code: string;
}

// G6-6 红名单键（合成仅 schema 派生，天然不含；此处仅作显式防呆约束的来源口径说明）
const SENSITIVE_KEYS = ['authConfig', 'tls', 'secret', 'token', 'password', 'apiKey', 'privateKey'];

/**
 * 轻量确定性散列（仅用于把 seed 折叠进 string 占位，使同一 schema 在不同
 * 接口/请求响应之间产生稳定但可区分的占位串，不引入任何随机性）。
 */
function shortHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

/**
 * 递归 JSON Schema → 确定性 mock 值（10 §17.3 C-G6-2 / §17.6 未决③=仅顶层示例占位）。
 *  - enum 取首项；string→占位串（带 description 语义提示，非敏感）；integer→0；number→1；
 *    boolean→true；object→递归 properties；array→[itemExample]；null/缺省→null。
 *  - seed = `proto+id+'request'/'response'`（10 §17.3），保证同 schema+seed 同输出（diff 稳定）。
 * 边界：schema 缺失或非 object → 返回 null（不抛，T2 失败降级）。
 */
export function synthesizeExample(schema: JSONSchema | undefined | null, seed: string): unknown {
  if (!schema || typeof schema !== 'object') return null;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  switch (schema.type) {
    case 'string': {
      // 仅含 description 语义提示的非敏感占位；折叠 seed 散列保证确定且可区分
      const hint = schema.description && schema.description.length > 0 ? schema.description : 'string';
      const v = `${hint}-${shortHash(seed)}`;
      return v.length > 64 ? v.slice(0, 64) : v;
    }
    case 'integer':
      return 0;
    case 'number':
      return 1;
    case 'boolean':
      return true;
    case 'object': {
      const obj: Record<string, unknown> = {};
      if (schema.properties && typeof schema.properties === 'object') {
        for (const [k, v] of Object.entries(schema.properties)) {
          obj[k] = synthesizeExample(v, seed + '.' + k);
        }
      }
      return obj;
    }
    case 'array':
      return schema.items ? [synthesizeExample(schema.items, seed + '[]')] : [];
    case 'null':
      return null;
    default:
      return null;
  }
}

/** 拼接 server + path，避免双斜杠（apifox 式完整 URL，G6-3） */
function joinUrl(server: string | undefined, path: string | undefined): string {
  const p = path && path.length > 0 ? path : '/';
  if (!server || server.length === 0) return p;
  const s = server.replace(/\/+$/, '');
  const pp = p.startsWith('/') ? p : '/' + p;
  return s + pp;
}

/** 把合成 request body 转成可内联的 JSON 文本（TS 对象字面量 / Python dict 字面量兼容） */
function bodyLiteral(body: unknown): string {
  if (body === null || body === undefined) return '{}';
  if (typeof body === 'string') return JSON.stringify(body);
  if (typeof body === 'number' || typeof body === 'boolean') return String(body);
  try {
    return JSON.stringify(body, null, 2);
  } catch {
    return '{}';
  }
}

function curlSnippet(method: string, url: string, body: string): string {
  // JSON 中若含单引号，做 shell 转义（占位串不含，纯防御）
  const escaped = body.replace(/'/g, "'\\''");
  return `curl -X ${method} '${url}' \\\n  -H 'Content-Type: application/json' \\\n  -d '${escaped}'`;
}

function jsSnippet(url: string, method: string, body: string): string {
  return `fetch('${url}', {\n  method: '${method}',\n  headers: { 'Content-Type': 'application/json' },\n  body: ${body}\n});`;
}

function pythonSnippet(url: string, method: string, body: string): string {
  return `import requests

resp = requests.${method.toLowerCase()}('${url}', json=${body})
print(resp.status_code, resp.text)`;
}

/**
 * 基于 transport(method/path/server) + 请求 schema 生成三语言代码样例（10 §17.3 C-G6-2 / §17.6 未决④）。
 *  - 每个 transport 行生成 curl/javascript/python 三条（label 携带 method+path 端点便于 tab 切换）；
 *  - 无 transport（无 bindings/无 roleId）→ 单组兜底（method=POST, path=/），保证 codeSamples 非空（G6-2）；
 *  - request body 由 requestSchema 合成（复用 synthesizeExample），纯 schema 派生。
 * 确定性：同输入同输出（diff 稳定）。
 */
export function buildCodeSamples(
  spec: Pick<InterfaceSpec, 'id' | 'requestSchema'> | undefined | null,
  transportWithServer: TransportWithServer[] | undefined | null
): CodeSample[] {
  const requestSchema = spec?.requestSchema;
  const seed = (spec?.id ?? 'unknown') + 'request';
  const body = synthesizeExample(requestSchema, seed);
  const literal = bodyLiteral(body);

  const rows: TransportWithServer[] =
    transportWithServer && transportWithServer.length > 0
      ? transportWithServer
      : [{ method: 'POST', path: '/' }];

  const out: CodeSample[] = [];
  for (const t of rows) {
    const method = (t.method || 'POST').toUpperCase();
    const url = joinUrl(t.server, t.path);
    const ep = `${method} ${t.path || '/'}`;
    out.push({ lang: 'curl', label: `curl · ${ep}`, code: curlSnippet(method, url, literal) });
    out.push({ lang: 'javascript', label: `javascript (fetch) · ${ep}`, code: jsSnippet(url, method, literal) });
    out.push({ lang: 'python', label: `python (requests) · ${ep}`, code: pythonSnippet(url, method, literal) });
  }
  return out;
}

/** 供测试/扫描断言：合成结果是否含红名单键（G6-6 防呆；正常 schema 恒为 false） */
export function containsSensitiveKeys(value: unknown): boolean {
  const scan = (v: unknown): boolean => {
    if (v === null || typeof v !== 'object') return false;
    if (Array.isArray(v)) return v.some(scan);
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.includes(k)) return true;
      if (scan(val)) return true;
    }
    return false;
  };
  return scan(value);
}
