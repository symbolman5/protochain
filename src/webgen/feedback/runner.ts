/**
 * 反馈闭环：子进程隔离触发 —— E7-P1
 *
 * 职责：
 *   - 在隔离子进程中跑 generate-cases / bind / verify
 *   - 不在服务进程持有/缓存任何 TOKEN/SECRET/PASSWORD/APIKEY 类环境变量
 *   - 子进程仅看到白名单 env（filterEnvForChild）
 *   - 若父进程 scrubProcessEnv 已执行（移除敏感键），子进程更不可能泄
 *
 * 子进程模型：
 *   - spawnSync node <cliPath> <args> --dir <rootDir>
 *   - 输出截断（30KB）；超时 5 分钟（generate-cases/verify 可重）
 *   - exit 0 = 通过；非 0 = 失败；121 / null = 超时
 *
 * 设计参考：
 *   - src/cli/index.ts 已注册的命令：generate-cases / bind / verify 等
 *   - 服务进程启动时 CLI 已被 npm run build 或 npx tsc 编译到 dist/cli/index.js
 *   - 路径探测：node 进程 argv[1] 找到 dist/cli/index.js，再回退到相对路径
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';

import { filterEnvForChild } from './env-guard.js';

/**
 * 取「当前模块所在的目录」。
 * CJS (ts-jest) 走 __dirname；ESM 走 import.meta.url 但不直接读（避免 ts-jest 报错）。
 * 改用 process.argv[1]：node 起动脚本是 dist/cli/index.js 时，argv[1] = 该路径。
 * 测试时 argv[1] = jest runner；此时 fall back CWD。
 */
function getProcessArgv1Dir(): string | null {
  const p = process.argv[1];
  if (typeof p === 'string' && p.length > 0) {
    // 排除 node 内置脚本
    if (p.endsWith('node') || p.endsWith('jest') || p.endsWith('jest.js')) return null;
    try {
      return dirname(resolve(p));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 探测 CLI 入口（dist/cli/index.js）
 *
 * 顺序（与 fs 实际位置无关；只取决于调用进程上下文）：
 *   1. env PROTOCHAIN_CLI_PATH
 *   2. process.argv[1] dirname（CLI 通常以 node /work/protochain/dist/cli/index.js ... 启动）
 *   3. cwd 向上找 dist/cli/index.js（最多 6 层）
 *   4. __dirname 向上找
 *   5. /work/protochain/dist/cli/index.js 兜底（开发环境）
 */
export function detectCliPath(): string | null {
  // 1. env
  const envPath = process.env.PROTOCHAIN_CLI_PATH;
  if (envPath && existsSync(envPath)) return envPath;

  // 2. argv[1]
  const argvDir = getProcessArgv1Dir();
  if (argvDir) {
    const direct = join(argvDir, 'index.js');
    if (existsSync(direct)) return direct;
  }

  // 3. cwd 向上探测
  let cur = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = join(cur, 'dist/cli/index.js');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  // 4. argv[1] dirname 向上
  if (argvDir) {
    let cur2 = argvDir;
    for (let i = 0; i < 6; i++) {
      const candidate = join(cur2, 'dist/cli/index.js');
      if (existsSync(candidate)) return candidate;
      const parent = dirname(cur2);
      if (parent === cur2) break;
      cur2 = parent;
    }
    // argv[1]/cli/index.js 同层（CLI 启动时 argv[1] = dist/cli/index.js）
    let cur3 = argvDir;
    for (let i = 0; i < 4; i++) {
      // argvDir 自身 / 上 4 层
      const direct = join(cur3, 'index.js');
      if (existsSync(direct) && cur3.endsWith('cli')) return direct;
      const parent = dirname(cur3);
      if (parent === cur3) break;
      cur3 = parent;
    }
  }

  // 5. 兜底：/work/protochain/dist/cli/index.js（开发环境固定路径）
  const fallback = '/work/protochain/dist/cli/index.js';
  if (existsSync(fallback)) return fallback;

  return null;
}

export type RunKind = 'generate-cases' | 'bind' | 'verify' | 'derive-specs' | 'derive-bindings' | 'diff';

export interface RunResult {
  ok: boolean;
  /** stdout（截断 30KB） */
  stdout: string;
  /** stderr（截断 30KB） */
  stderr: string;
  /** exit code（null = 进程被信号终止 / 超时） */
  exitCode: number | null;
  /** 实际命令行（用于诊断） */
  argv: string[];
  /** 墙钟 ms */
  durationMs: number;
  /** 路径截断标记 */
  truncated: boolean;
}

/**
 * 在子进程中跑一个 protochain 命令。env 隔离：filterEnvForChild（白名单 + 显式覆盖）。
 *
 * timeoutMs 默认 5 分钟；generate-cases / verify 都可能有 AI 调用场景，留足时间。
 */
export function runCliSync(
  rootDir: string,
  kind: RunKind,
  extraArgs: string[] = [],
  options: {
    cliPath?: string;
    timeoutMs?: number;
    extraEnv?: Record<string, string | undefined>;
  } = {}
): RunResult {
  const cliPath = options.cliPath ?? detectCliPath();
  if (!cliPath) {
    return {
      ok: false,
      stdout: '',
      stderr: '无法定位 CLI 入口 dist/cli/index.js；请先运行 `npm run build`',
      exitCode: null,
      argv: [],
      durationMs: 0,
      truncated: false,
    };
  }
  if (!existsSync(cliPath)) {
    return {
      ok: false,
      stdout: '',
      stderr: `CLI 入口不存在：${cliPath}`,
      exitCode: null,
      argv: [],
      durationMs: 0,
      truncated: false,
    };
  }
  // 子进程 args：explicit = ["generate-cases", "--dir", rootDir, ...extra]
  const argv = [cliPath, kind, '--dir', rootDir, ...extraArgs];
  const env = filterEnvForChild({
    ...(options.extraEnv ?? {}),
    PWD: rootDir,
    PROTOCHAIN_FEEDBACK_CHILD: '1', // 供子进程识别被 web 触发
  });
  const t0 = Date.now();
  const result: SpawnSyncReturns<Buffer> = spawnSync('node', argv, {
    cwd: rootDir,
    env,
    encoding: 'buffer',
    timeout: options.timeoutMs ?? 5 * 60 * 1000,
    maxBuffer: 30 * 1024 * 1024,
  });
  const t1 = Date.now();
  const decode = (b: Buffer | null): { text: string; truncated: boolean } => {
    if (!b) return { text: '', truncated: false };
    const MAX = 30 * 1024;
    const truncated = b.length > MAX;
    return { text: b.toString('utf-8', 0, Math.min(b.length, MAX)), truncated };
  };
  const out = decode(result.stdout);
  const err = decode(result.stderr);
  return {
    ok: result.status === 0,
    stdout: out.text,
    stderr: err.text,
    exitCode: result.status,
    argv,
    durationMs: t1 - t0,
    truncated: out.truncated || err.truncated,
  };
}

/**
 * 读取最近一次产物（如 verify-report.json / test-cases.json）的元信息。
 *
 * 用 fs.statSync 拿 mtime 与 size，前端无需载入完整文件。
 */
export function statArtifact(rootDir: string, relPath: string): { exists: boolean; size: number; mtime: string | null } | null {
  const full = isAbsolute(relPath) ? relPath : resolve(rootDir, relPath);
  if (!existsSync(full)) return { exists: false, size: 0, mtime: null };
  try {
    const s = statSync(full);
    return { exists: true, size: s.size, mtime: s.mtime.toISOString() };
  } catch {
    return null;
  }
}
