/**
 * Web 检阅界面静态服务 —— E7 P0
 *
 * 设计依据：IMPLEMENTATION-PLAN.md §E7、IMPLEMENTATION-ACCEPTANCE.md §E7 P0
 *
 * 纯 stdlib http.createServer；不读 process.env；不引入运行时依赖。
 *
 * 行为：
 * - serve web/.vitepress/dist/ 目录（MIME 由文件扩展名推断）
 * - 4 类 URL 探针（首页 + interfaces/ + interfaces/<id> + test-cases + verification + diff）
 * - 优雅退出（SIGINT/SIGTERM）
 * - 不接受除 --port/--host/--dir 外的任何参数；不接受 token/secret 等敏感字段
 *
 * 安全边界（设计笔记 §5）：
 * - 不读 process.env（即使进程含 AUTH_TOKEN 等也不被使用）
 * - 仅读 web/.vitepress/dist/ 静态文件
 * - 不代理外部请求
 */

import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';

// ============================================================================
// MIME 表（站点服务常用）
// ============================================================================

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

/** URL 路径 → 文件系统路径（防止 path traversal）
 *
 * 防御：
 * - 畸形百分号编码（decodeURIComponent 抛 URIError）→ 返回 null（由 handleRequest 转 400）
 * - 含 `..` 段或 `.` 段 → null
 * - normalize 后超出 distDir → null
 */
export function resolveStaticPath(distDir: string, urlPath: string): string | null {
  // 去除 query string
  const cleanUrl = urlPath.split('?')[0].split('#')[0];
  // 规范化前先做严格防御：含 `..` 段 → 直接拒绝
  let decoded: string;
  try {
    decoded = decodeURIComponent(cleanUrl);
  } catch {
    // 畸形百分号编码（如 /%zz）→ 拒绝，调用方转 400
    return null;
  }
  if (decoded.split(/[/\\]/).some((seg) => seg === '..' || seg === '.')) return null;
  // URL `/` → distDir/index.html（默认首页）
  let normalized = normalize(decoded).replace(/^\/+/, '');
  if (normalized === '' || normalized === '.') normalized = 'index.html';
  if (normalized.split(/[/\\]/).some((seg) => seg === '..' || seg === '.')) return null;
  const fullPath = join(distDir, normalized);
  // 必须在 distDir 下（distDir 必须以 separator 结尾或后跟 separator 才算"下"）
  const distWithSep = distDir.endsWith('/') || distDir.endsWith('\\') ? distDir : distDir + '/';
  if (!fullPath.startsWith(distWithSep) && fullPath !== distDir) return null;
  return fullPath;
}

/** 文件 → MIME；默认 application/octet-stream */
export function mimeOf(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

/** 读取静态文件 + Content-Length；不存在 → null */
export function readStaticFile(distDir: string, urlPath: string): { content: Buffer; mime: string } | null {
  const fullPath = resolveStaticPath(distDir, urlPath);
  if (!fullPath) return null;
  if (!existsSync(fullPath)) return null;
  const stat = statSync(fullPath);
  if (!stat.isFile()) return null;
  const content = readFileSync(fullPath);
  return { content, mime: mimeOf(fullPath) };
}

/** 处理单个 HTTP 请求
 *
 * 错误边界（E7-I3 修复）：try/catch 兜底；任一异常 → 500 + 不崩进程
 */
export function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  distDir: string
): void {
  try {
    handleRequestInner(req, res, distDir);
  } catch (err) {
    // 错误边界：单个畸形请求不应杀死 web-serve 进程
    try {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      }
      res.end(`500 Internal Server Error: ${err instanceof Error ? err.message : String(err)}`);
    } catch {
      // 兜底：socket 已关，不重复 end
    }
  }
}

/** handleRequest 内部实现（E7-I3 修复：被 try/catch 包裹） */
function handleRequestInner(
  req: IncomingMessage,
  res: ServerResponse,
  distDir: string
): void {
  const url = req.url ?? '/';
  // 畸形 URL（decode 失败）→ 400；不再走文件查找
  let file = readStaticFile(distDir, url);
  // 目录形式（/interfaces/）→ 自动追加 index.html
  if (!file && url.endsWith('/')) {
    file = readStaticFile(distDir, `${url}index.html`);
  }
  // SPA fallback：访问路径不含 .html（如 /test-cases /verification /diff）→ /<path>.html
  if (!file && !url.includes('.') && !url.endsWith('/')) {
    file = readStaticFile(distDir, `${url}.html`);
  }
  if (!file) {
    // readStaticFile 返回 null 时区分两种情况：URL 畸形（400）vs 文件不存在（404）
    // 这里用 try-decode 区分：解码失败 → 400
    try {
      decodeURIComponent(url);
    } catch {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('400 Bad Request: malformed URL');
      return;
    }
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('404 Not Found');
    return;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', file.mime);
  res.setHeader('Content-Length', String(file.content.length));
  res.setHeader('Cache-Control', 'no-store'); // P0：避免 CDN 缓存；P1 再按需调整
  res.end(file.content);
}

// ============================================================================
// 服务启动
// ============================================================================

export interface ServeOptions {
  /** 服务端口（默认 5173；同 VitePress 默认） */
  port?: number;
  /** 监听 host（默认 '127.0.0.1'；仅本地） */
  host?: string;
  /** 站点 dist 目录（默认 <rootDir>/web/.vitepress/dist） */
  distDir: string;
  /** 探针 URL 列表（默认 6 类） */
  probePaths?: string[];
}

export interface ServeHandle {
  /** 关闭服务 */
  close(): Promise<void>;
  /** 监听地址（启动后填） */
  address: { host: string; port: number };
}

const DEFAULT_PROBE_PATHS = [
  '/',
  '/interfaces/',
  '/test-cases',
  '/verification',
  '/diff',
];

/**
 * 启动 HTTP 服务 + 探针；返回 ServeHandle
 *
 * 探针：同步访问每个路径，确认 200 状态码。探针失败抛错（供 CLI 报警）。
 */
export async function startServe(opts: ServeOptions): Promise<ServeHandle> {
  const port = opts.port ?? 5173;
  const host = opts.host ?? '127.0.0.1';
  const distDir = opts.distDir;
  const probePaths = opts.probePaths ?? DEFAULT_PROBE_PATHS;

  if (!existsSync(distDir)) {
    throw new Error(`dist 目录不存在: ${distDir}（请先运行 protochain derive-web）`);
  }
  if (!existsSync(join(distDir, 'index.html'))) {
    throw new Error(
      `dist/index.html 不存在: ${distDir}（derive-web 可能未成功执行 vitepress build）`
    );
  }

  const server = createServer((req, res) => handleRequest(req, res, distDir));

  // 异步启动：监听成功后才返回
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  // 取实际绑定地址（port=0 时 server.address() 返回真实端口）
  const address = server.address();
  const boundPort =
    address === null || typeof address === 'string'
      ? port
      : address.port;
  const boundHost =
    address === null || typeof address === 'string'
      ? host
      : address.address;

  // 探针：访问每个 URL 一次；任一非 200 → 抛错
  for (const path of probePaths) {
    const status = await probeUrl(boundHost, boundPort, path);
    if (status !== 200) {
      await new Promise<void>((r) => server.close(() => r()));
      throw new Error(`探针失败: ${path} 返回 ${status}（期望 200）`);
    }
  }

  const addr = { host: boundHost, port: boundPort };

  return {
    address: addr,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** 单 URL 探针：返回 HTTP 状态码 */
export function probeUrl(host: string, port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host, port, path, method: 'GET' },
      (res) => {
        resolve(res.statusCode ?? 0);
        res.resume();
      }
    );
    req.on('error', reject);
    req.end();
  });
}