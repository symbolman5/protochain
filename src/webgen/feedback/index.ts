/**
 * 反馈闭环 Express 服务 —— E7-P1
 *
 * 入口策略：高内聚 controller（全部在一个文件里，因为 API 表面积小且 handler 与
 * store/runner/issues 之间是垂直栈）。
 *
 * API 总览：
 *   - 静态（GET /, /scenarios, /bindings, /run, /review, /assets/*）
 *   - 数据（只读 / 写）
 *     GET  /api/scenarios                → 列出 scenarios/*.yaml
 *     GET  /api/scenarios/:filename      → 读单个
 *     POST /api/scenarios                → 新建
 *     PUT  /api/scenarios/:filename      → 更新
 *     DEL  /api/scenarios/:filename      → 删除
 *     GET  /api/bindings                 → 读 bindings.yaml
 *     PUT  /api/bindings                 → 写 bindings.yaml
 *     POST /api/run/generate-cases       → 触发 generate-cases 子进程
 *     POST /api/run/bind                 → 触发 bind 子进程
 *     POST /api/run/verify               → 触发 verify 子进程（含 --skip-probe 标记）
 *     POST /api/issues                   → 评审 → 改单草稿（落 /work）
 *     GET  /api/issues                   → 列出已有改单
 *     GET  /api/health                   → 服务存活 + env-scrub report
 *   - 安全头：X-Content-Type-Options=nosniff, X-Frame-Options=DENY；CSP frame-ancestors 'none'
 *     （P1 编辑页要 POST，但 tokenEnv 等敏感键不写入；CSP 限定自身策略）
 *
 * 环境变量清理（startFeedbackServer 内执行）：
 *   - 调用 `scrubProcessEnv()` 删除服务进程 env 中所有 TOKEN/SECRET/PASSWORD/APIKEY 类键
 *   - 启动后任何 spawn 出去的子进程都仅继承白名单 env（filterEnvForChild）
 *   - 服务进程持有的 env 必不含 token；测试断言：
 *       process.env.LEGACY_TOKEN === undefined after start
 *
 * 写盘策略：
 *   - 在线编辑落权威源（scenarios/*.yaml、bindings.yaml），不直接写 derived/
 *   - 触发 generate-cases / bind / verify 由机械命令重推导
 */

import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import {
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import {
  join,
  extname,
  normalize,
  dirname,
} from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer, type Server as HttpServer } from 'node:http';

import { parse as parseYamlFn } from 'yaml';

import {
  scrubProcessEnv,
  filterEnvForChild,
  isSensitiveEnvKey,
  assertSecretLeak,
  SENSITIVE_ENV_KEY_PATTERNS,
  checkProcEnvironForSecrets,
  maskSensitiveEnvKey,
} from './env-guard.js';
import {
  listScenarios,
  readScenarioFile,
  writeScenarioFile,
  createScenarioFile,
  deleteScenarioFile,
  readBindingsFile,
  writeBindingsFile,
  replaceBindingsFileAtomic,
  mergeBindingsFile,
  type MergeBindingsPatch,
} from './store.js';
import {
  buildScenarioAjv,
  buildBindingAjv,
  validateScenario,
  validateBindingFile,
  type ScenarioFile,
  type BindingFile,
} from './schemas.js';
import { runCliSync, detectCliPath, type RunKind } from './runner.js';
import {
  listIssues,
  writeDraftIssue,
  validateReview,
  nextIssueNumber,
} from './issues.js';

import { redactSensitiveFields, SENSITIVE_FIELD_NAMES } from '../index.js';

// ============================================================================
// 静态资源
// ============================================================================

function feedbackDirName(): string {
  // 优先级（避开 ts-jest 在 CJS 评估时对 import.meta 的语法限制）：
  //   1) CJS 走全局 __dirname（ts-jest 走 CJS 时永远存在）
  //   2) 兜底 process.cwd()
  // 注：dist (Node ESM) 模式不在此函数处理 — 由 caller 通过
  // FeedbackServerOptions.staticDir 显式注入（见 CLI feedback-serve 子命令）。
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = (globalThis as any).__dirname as string | undefined;
    if (typeof d === 'string' && d.length > 0) return d;
  } catch { /* ignore */ }
  return process.cwd();
}

/**
 * 静态目录：src/webgen/feedback/static/
 *  - 纯 HTML + JS；不依赖构建
 *  - 与 src/webgen/serve.ts 的安全边界同款：cache-control=no-store、read only
 */
function staticDir(): string {
  // find sibling 'static' dir；多种候选路径：
  //   - dist/webgen/feedback/static             (dist 邻近)
  //   - src/webgen/feedback/static              (源码)
  //   - <here>/../../src/webgen/feedback/static (dist 回到 src)
  //   - <here>/../feedback-static               (合并拷贝)
  // 这里不读 import.meta；只用 __dirname（CJS 中永远可用）。
  const here = feedbackDirName();
  const candidates: string[] = [
    join(here, 'static'),
    join(here, '..', 'static'),
    join(here, '..', '..', 'src', 'webgen', 'feedback', 'static'),
    join(here, '..', '..', '..', 'src', 'webgen', 'feedback', 'static'),
    join(here, '..', 'feedback-static'),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, 'index.html'))) return c;
  }
  // 兜底：返回第一项（即使不存在，启动后 handler 会 404 提示文件缺失）
  return candidates[0] ?? here;
}

// ============================================================================
// 响应包装
// ============================================================================

interface ApiOk<T = unknown> { ok: true; data: T }
interface ApiErr { ok: false; error: string }
type ApiResult = ApiOk | ApiErr;

function ok<T>(res: Response, data: T): Response<ApiOk<T>> {
  // 防御：response 序列化前先 redact（即使上游已保证）
  const redacted = redactSensitiveFields(data);
  return res.status(200).json({ ok: true, data: redacted } as ApiOk<T>);
}
function badRequest(res: Response, error: string, status = 400): Response<ApiErr> {
  return res.status(status).json({ ok: false, error } as ApiErr);
}

/** 静态防御：任何 JSON 响应再过一遍 assertSecretLeak（兜底） */
function safeJson<T>(res: Response<unknown>, payload: T, knownSecrets: string[]): Response<unknown> {
  try {
    assertSecretLeak(payload, knownSecrets);
  } catch (err) {
    return res.status(500).json({ ok: false, error: `安全兜底触发：${err instanceof Error ? err.message : String(err)}` } as ApiErr);
  }
  return res.json(payload);
}

// ============================================================================
// App 工厂
// ============================================================================

export interface FeedbackServerOptions {
  /** 项目根目录（--dir 传入；与 web-serve 一致） */
  rootDir: string;
  /** 监听端口 */
  port?: number;
  /** 监听 host（默认 127.0.0.1） */
  host?: string;
  /** 自定义静态目录（默认 src/webgen/feedback/static） */
  staticDir?: string;
  /** 是否跳过 scrubProcessEnv（仅测试用） */
  skipEnvScrub?: boolean;
  /** 测试注入：已知 secrets（应在断言中提供） */
  knownSecrets?: string[];
  /** 测试注入：自定义 CLI 路径 */
  cliPath?: string;
}

export interface FeedbackServerHandle {
  /** 关闭服务 */
  close(): Promise<void>;
  address: { host: string; port: number };
  /** 服务进程 env-scrub 后从 env 中删除的键名（用于断言 / 健康检查） */
  scrubbedKeys: string[];
}

// 用于 startFeedbackServer 与 startDistEntry 共享
let startedApp: Express | null = null;

export function buildApp(opts: FeedbackServerOptions): {
  app: Express;
  knownSecrets: string[];
  scrubbedKeys: string[];
} {
  const rootDir = opts.rootDir;
  const knownSecrets = opts.knownSecrets ?? [];
  const ajvScenario = buildScenarioAjv();
  const ajvBinding = buildBindingAjv();

  // 1) 服务进程 env scrub（除非测试明确跳过）
  let scrubbedKeys: string[] = [];
  if (!opts.skipEnvScrub) {
    scrubbedKeys = scrubProcessEnv();
  }

  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // 安全头
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // CSP 含 X-Frame-Options=DENY 等价语义（frame-ancestors 'none'），
// 防止页面被 iframe 嵌入；同时禁止外联脚本/连接；CSP 仅允许自身。
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"
    );
    next();
  });

  // 简单请求日志（stdout 截短、不输出 body）
  app.use((req, _res, next) => {
    process.stdout.write(`[feedback] ${req.method} ${req.path}\n`);
    next();
  });

  // ----- 静态（HTML 页面） -----
  const staticPath = opts.staticDir ?? staticDir();

  app.get('/', (_req, res) => {
    const f = join(staticPath, 'index.html');
    if (!existsSync(f)) return res.status(404).send('页面未生成（src/webgen/feedback/static/index.html 缺失）');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.sendFile(f);
  });
  app.get('/scenarios', (_req, res) => res.sendFile(join(staticPath, 'scenarios.html')));
  app.get('/bindings', (_req, res) => res.sendFile(join(staticPath, 'bindings.html')));
  app.get('/run', (_req, res) => res.sendFile(join(staticPath, 'run.html')));
  app.get('/review', (_req, res) => res.sendFile(join(staticPath, 'review.html')));
  // 共享的 /assets/app.js
  app.get('/assets/app.js', (_req, res) => res.sendFile(join(staticPath, 'assets/app.js')));
  app.get('/assets/app.css', (_req, res) => res.sendFile(join(staticPath, 'assets/app.css')));

  // ----- 健康检查（含 env-scrub 状态） -----
  app.get('/api/health', (_req, res) => {
    const procEnvCheck = checkProcEnvironForSecrets();
    res.json({
      ok: true,
      data: {
        service: 'protochain-feedback',
        rootDir,
        // 当前进程 env 残留敏感键（应为 0；掩码输出 E7-P1-I3）
        remainingSensitiveEnvKeys: Object.keys(process.env).filter(isSensitiveEnvKey).map(maskSensitiveEnvKey),
        // scrubbedKeys 列表（掩码：E7-P1-I3 修复，不回显完整键名）
        scrubbedKeyNames: scrubbedKeys.map(maskSensitiveEnvKey),
        // 静态 sensitive field 列表（掩码：仅展示形态，不回显完整键名）
        sensitiveFieldNames: Array.from(SENSITIVE_FIELD_NAMES).map((n) => maskSensitiveEnvKey(n)),
        // 帮助排除：tokenEnv 不存在
        tokenEnvAbsent: process.env.LEGACY_TOKEN === undefined,
        // OS 层 /proc/self/environ 残留（掩码：仅展示族别 + 长度）
        osProcResidualKeys: procEnvCheck.matchedKeys.map(maskSensitiveEnvKey),
        osProcResidualDisclosure: 'OS/kernel 内存；root 或同 uid 可读；不影响子进程 env',
      },
    });
  });

  // ----- scenarios API -----
  app.get('/api/scenarios', (_req, res) => {
    const r = listScenarios(rootDir);
    if (!r.ok) return badRequest(res, r.error, 404);
    return ok(res, r.data);
  });

  app.get('/api/scenarios/:filename', (req, res) => {
    const r = readScenarioFile(rootDir, req.params.filename);
    if (!r.ok) return badRequest(res, r.error, 404);
    const data = r.data;
    // 红线：响应中的任何已知 tokenEnv 字符串不能出现（断言）
    if (knownSecrets.length > 0) {
      try { assertSecretLeak(data.parsed, knownSecrets); assertSecretLeak(data.raw, knownSecrets); }
      catch (err) { return badRequest(res, `敏感内容泄露: ${err instanceof Error ? err.message : String(err)}`, 500); }
    }
    return ok(res, { filename: req.params.filename, path: data.path, raw: data.raw, parsed: data.parsed, validation: data.validation });
  });

  app.post('/api/scenarios', (req, res) => {
    const body = req.body as Partial<ScenarioFile> | undefined;
    if (!body || !body.id || !Array.isArray(body.expectedActions)) {
      return badRequest(res, 'body 必须包含 id(string) + expectedActions(array)');
    }
    const v = validateScenario(body);
    if (!v.ok) {
      return badRequest(res, `schema 校验未通过：${v.error}`);
    }
    const r = createScenarioFile(rootDir, body as ScenarioFile);
    if (!r.ok) return badRequest(res, r.error, 400);
    return ok(res, r.data);
  });

  app.put('/api/scenarios/:filename', (req, res) => {
    const body = req.body as Partial<ScenarioFile> | undefined;
    if (!body || !body.id || !Array.isArray(body.expectedActions)) {
      return badRequest(res, 'body 必须包含 id(string) + expectedActions(array)');
    }
    if (!ajvScenario(body)) {
      return badRequest(res, `schema 校验未通过：${formatAjv(ajvScenario.errors)}`);
    }
    const r = writeScenarioFile(rootDir, req.params.filename, body as ScenarioFile);
    if (!r.ok) return badRequest(res, r.error, 400);
    return ok(res, r.data);
  });

  app.delete('/api/scenarios/:filename', (req, res) => {
    const r = deleteScenarioFile(rootDir, req.params.filename);
    if (!r.ok) return badRequest(res, r.error, 404);
    return ok(res, r.data);
  });

  // ----- bindings API -----
  app.get('/api/bindings', (_req, res) => {
    const r = readBindingsFile(rootDir);
    if (!r.ok) return badRequest(res, r.error, 404);
    return ok(res, { path: r.data.path, raw: r.data.raw, parsed: r.data.parsed, validation: r.data.validation });
  });

  app.put('/api/bindings', (req, res) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== 'object') return badRequest(res, 'body 必填');
    // E7-P1-I1 修复：PUT 整文件替换需 confirm token（防误覆盖，与 P004 修复路径 2 对齐）。
    // 透传语义：前端确认「确认整文件替换」后传 `confirm: 'replace-all'` 才走 PUT；
    // 否则提示「请改用 PATCH /api/bindings 字段级合并 或传 confirm='replace-all'」。
    const explicitReplace = body.confirm === 'replace-all';
    if (!explicitReplace) {
      return badRequest(
        res,
        "PUT /api/bindings 是整文件替换；请改用 PATCH /api/bindings 字段级合并，或在 body 显式加 `confirm: 'replace-all'` 表明你确认覆盖所有现有 roles/interfaces/environments/stateMap/tls",
        400
      );
    }
    // 兼容前端「编辑器是纯文本」：当 body 含 `_rawYAML` 字符串键时，由服务端 yaml 解析
    let obj: unknown;
    if (typeof body._rawYAML === 'string') {
      obj = parseYamlFn(body._rawYAML);
    } else {
      // 去掉 confirm 字段再做 schema 校验（confirm 不是 binding 内容）
      const { confirm: _confirm, ...payload } = body;
      obj = payload;
    }
    if (!ajvBinding(obj)) {
      return badRequest(res, `bindings schema 校验未通过：${formatAjv(ajvBinding.errors)}`);
    }
    // 整文件替换走 atomic + 自动备份（replaceBindingsFileAtomic）
    const r = replaceBindingsFileAtomic(rootDir, obj as BindingFile);
    if (!r.ok) return badRequest(res, r.error, 400);
    return ok(res, r.data);
  });

  // E7-P1-I1 修复：PATCH /api/bindings —— 字段级合并（推荐路径）。
  // body：{ roles?, interfaces?, environments?, defaultEnv? }
  //   - roles：按 roleId 替换/追加
  //   - interfaces：按 action 替换/追加；interfaces[]._delete=true 标记删除
  //   - environments/defaultEnv：顶层整体替换（若提供）
  app.patch('/api/bindings', (req, res) => {
    const body = req.body as MergeBindingsPatch | undefined;
    if (!body || typeof body !== 'object') return badRequest(res, 'body 必填（MergeBindingsPatch）');
    // body 必须至少含 roles / interfaces / environments / defaultEnv 之一
    if (
      !Array.isArray(body.roles) &&
      !Array.isArray(body.interfaces) &&
      body.environments === undefined &&
      body.defaultEnv === undefined
    ) {
      return badRequest(res, 'body 至少含 roles[] / interfaces[] / environments / defaultEnv 之一');
    }
    const r = mergeBindingsFile(rootDir, body);
    if (!r.ok) return badRequest(res, r.error, 400);
    return ok(res, r.data);
  });

  // E7-P1-I1 修复：DELETE /api/bindings/interfaces/:action —— 单接口删除（合并语义）。
  // 不直接 unlink，而是走 mergeBindingsFile({interfaces:[{action,_delete:true}]}) 留备份。
  app.delete('/api/bindings/interfaces/:action', (req, res) => {
    const action = req.params.action;
    if (!action || action.includes('/') || action.includes('\\') || action.includes('..')) {
      return badRequest(res, `非法 action：${action}`);
    }
    const r = mergeBindingsFile(rootDir, {
      interfaces: [{ action, _delete: true }],
    });
    if (!r.ok) return badRequest(res, r.error, 400);
    return ok(res, r.data);
  });

  // ----- 一键执行 API（generate-cases / bind / verify） -----
  app.post('/api/run/:kind', (req, res) => {
    const kind = req.params.kind as RunKind;
    const allowed: RunKind[] = ['generate-cases', 'bind', 'verify', 'derive-specs', 'derive-bindings', 'diff'];
    if (!allowed.includes(kind)) return badRequest(res, `不支持的 kind：${kind}（允许 ${allowed.join(', ')}）`);
    const extra: string[] = Array.isArray(req.body?.args) ? (req.body.args as string[]) : [];
    // 子进程隔离：filterEnvForChild 自身实现，runner.runCliSync 内调用
    const r = runCliSync(rootDir, kind, extra, { cliPath: opts.cliPath });
    if (knownSecrets.length > 0) {
      try {
        assertSecretLeak(r.stdout, knownSecrets);
        assertSecretLeak(r.stderr, knownSecrets);
      } catch (err) {
        return badRequest(res, `子进程输出包含敏感字符串: ${err instanceof Error ? err.message : String(err)}`, 500);
      }
    }
    return ok(res, r);
  });

  // ----- 评审 → 修改单草稿 API -----
  app.post('/api/issues', (req, res) => {
    const v = validateReview(req.body);
    if (!v.ok) return badRequest(res, v.error, 400);
    const ctx = {
      rootDir,
      instanceName: basenameRootDir(rootDir),
      protocolId: detectProtocolId(rootDir),
    };
    const r = writeDraftIssue(v.data, ctx);
    if (!r.ok) return badRequest(res, r.error ?? 'unknown error', 500);
    return ok(res, { draftPath: r.draftPath ?? '', number: r.number ?? -1 });
  });
  app.get('/api/issues', (_req, res) => {
    const items = listIssues();
    return ok(res, items);
  });
  app.get('/api/issues/nextNumber', (_req, res) => {
    return ok(res, { next: nextIssueNumber() });
  });

  // ----- 异常兜底 -----
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // eslint-disable-next-line no-console
    process.stderr.write(`[feedback] uncaught error: ${err instanceof Error ? err.message : String(err)}\n`);
    res.status(500).json({ ok: false, error: 'internal error' } as ApiErr);
  });

  return { app, knownSecrets, scrubbedKeys };
}

// ============================================================================
// 启动服务
// ============================================================================

export async function startFeedbackServer(
  opts: FeedbackServerOptions
): Promise<FeedbackServerHandle> {
  const port = opts.port ?? 5174; // 与 web-serve 5173 错开
  const host = opts.host ?? '127.0.0.1';
  const { app, knownSecrets, scrubbedKeys } = buildApp(opts);

  const server: HttpServer = createServer(app);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const boundPort = address === null || typeof address === 'string' ? port : address.port;
  const boundHost = address === null || typeof address === 'string' ? host : address.address;

  return {
    address: { host: boundHost, port: boundPort },
    scrubbedKeys,
    close: () =>
      new Promise<void>((res) => {
        server.close(() => res());
      }),
  };
}

// ============================================================================
// 辅助函数
// ============================================================================

/** env 键名脱敏：旧实现保留以备兼容；新实现统一走 maskSensitiveEnvKey。 */
function redactEnvKeyName(k: string): string {
  return maskSensitiveEnvKey(k);
}

/** 取 rootDir 的父目录名作为实例名（hsk-ng / strangler-fig） */
function basenameRootDir(rootDir: string): string {
  const norm = normalize(rootDir).replace(/[\\/]+$/, '');
  const parts = norm.split(/[\\/]/);
  return parts[parts.length - 1] ?? 'unknown-instance';
}

/** 在 /work/<instance>/modeling/protocol/composition.md 探测多协议 project 取 P1 default */
function detectProtocolId(rootDir: string): string | undefined {
  const comp = join(rootDir, 'protocol', 'composition.md');
  if (existsSync(comp)) return 'composition (multi-protocol)';
  const md = join(rootDir, 'protocol', 'model.md');
  if (existsSync(md)) return 'single';
  return undefined;
}

function formatAjv(errs: unknown): string {
  if (!Array.isArray(errs)) return 'unknown ajv errors';
  return errs
    .map((e) => {
      const ee = e as { instancePath?: string; message?: string };
      return `${ee.instancePath ?? '(root)'} ${ee.message ?? ''}`.trim();
    })
    .join('；');
}
