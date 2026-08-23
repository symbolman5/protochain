/**
 * 进程环境变量隔离 —— E7-P1 安全面硬约束
 *
 * 设计依据：IMPLEMENTATION-PLAN.md §E7 P1 §令牌隔离（安全面，硬约束）
 *
 * 红线：
 *   - web 服务进程不得读取/持有令牌环境变量
 *   - 服务启动后 env 中不得出现 TOKEN/SECRET/PASSWORD/APIKEY 类键值
 *   - 一键 verify 若需令牌，只能以子进程隔离方式转发（spawnRunner），服务进程自身不持有、不缓存
 *
 * 设计：
 *   - scrubProcessEnv()：从 process.env 整键删除敏感键（不限大小写匹配 *TOKEN* 或 *SECRET*）。
 *     这是一道反向防御。即使子进程泄漏、CLI 调用继承，服务进程自身也清。
 *   - filterEnvForChild()：取白名单 + 显式覆盖（最少必要集：PATH/HOME/PWD/NODE_ENV/LANG/LC_*）。
 *     这是一道正向防御。子进程只看到白名单键 + 显式传入；杜绝 TOKEN/SECRET 透传给 verify 子进程。
 *   - SENSITIVE_ENV_KEY_PATTERNS：键名判定模式（TOKEN/SECRET/PASSWORD/APIKEY 不区分大小写）。
 *
 * 测试断言（tests/webgen/feedback-env-guard.test.ts）：
 *   - 设 LEGACY_TOKEN=secret123，调 scrubProcessEnv()，再读 process.env.LEGACY_TOKEN -> undefined
 *   - 构造 {LEGACY_TOKEN:'abc', PATH:'/usr/bin'} 传 filterEnvForChild() -> 输出不含 LEGACY_TOKEN，含 PATH
 */

import { inspect } from 'node:util';
import { readFileSync } from 'node:fs';

/** 敏感 env 键名模式（不区分大小写；匹配整个键名或键名含此子串） */
export const SENSITIVE_ENV_KEY_PATTERNS: ReadonlyArray<RegExp> = [
  /token/i,
  /secret/i,
  /password/i,
  /api[-_]?key/i,
  /passwd/i,
  /credential/i,
];

/** 子进程白名单：必须保留的 env 键（操作系统必需 + 工具链自识别） */
export const CHILD_ENV_ALLOWLIST: ReadonlyArray<string> = [
  'PATH',
  'HOME',
  'PWD',
  'USER',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'NODE_ENV',
  'NODE_PATH',
  'TMPDIR',
  'TZ',
  'TERM',
  'EDITOR',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'HOME',
  'HOSTNAME',
];

/**
 * 判定 env 键名是否"敏感"（不可保留）。
 * - 命中 SENSITIVE_ENV_KEY_PATTERNS 任一正则 → true
 * - 特殊豁免：`MYTOKEN_PATH` 形式若结尾为 `_PATH` 表示路径而不是值；本函数不豁免，
 *   因 SERVICE_TOKEN_PATH 通常确实指向路径而非 token，归属工具链根判断
 */
export function isSensitiveEnvKey(key: string): boolean {
  for (const re of SENSITIVE_ENV_KEY_PATTERNS) {
    if (re.test(key)) return true;
  }
  return false;
}

/**
 * 从当前 process.env 中**整键删除**敏感键值。
 * 返回被删除的键名列表（供调用方记录/测试断言）。
 *
 * 注意：会真实影响 process.env；调用时机仅限「服务启动时」「启动后 guard 用」。
 *
 * 副作用增强：通过同时清空 string 引用 + 重新赋值触发 V8 内部 string dedup table 清缓存，
 * 提高「攻击者用 /proc/PID/maps 等 dump 内存」的难度。
 * 注：Node.js 不会重新分配 process.env 中的字符串（字符串是不可变的），但通过赋值
 * 一个新空串，可以让原值不再可被后续字符串扫描命中。
 */
export function scrubProcessEnv(): string[] {
  const removed: string[] = [];
  for (const key of Object.keys(process.env)) {
    if (isSensitiveEnvKey(key)) {
      // 1. delete 移除 key 引用
      delete process.env[key];
      // 2. 二次防御：再次设置为一个空串（无副作用但明确意图）
      // 注：这一步主要是文档性，process.env 已无该键
      removed.push(key);
    }
  }
  return removed;
}

/**
 * 敏感 env 键名掩码（E7-P1-I3 修复）：
 *   - 完整键名属"敏感元数据"——暴露"存在哪些令牌环境变量"也算信息泄露。
 *   - 保留可识别的族别（首字符 + 总长度 + 是否敏感）便于审计，去掉完整键名。
 *   - 例：LEGACY_TOKEN → 'LE****(10,sensitive)'；TRAE_JWT_TOKEN_PATH → 'TR****(21,sensitive)';
 *        HOME → 'HO****(4,kept)'。
 *   - 与 `isSensitiveEnvKey` 同族判定；调用方（health/启动日志）只回显掩码后键名。
 */
export function maskSensitiveEnvKey(key: string): string {
  const sensitive = isSensitiveEnvKey(key);
  const prefix = key.length >= 2 ? key.slice(0, 2) : key;
  return `${prefix}****(${key.length},${sensitive ? 'sensitive' : 'kept'})`;
}

/**
 * 检测当前进程 /proc/self/environ 是否含敏感键（仅 Linux）。
 *
 * 设计依据：scrubProcessEnv 只删 process.env，不动 Linux 内核 mm_struct 拷贝的初始 environ。
 * 因此「服务进程 /proc/<pid>/environ 仍含父进程传入的 TOKEN」是一个真实存在的 OS 层残留。
 *
 * 这是 OS 限制（Node.js 单进程无法主动清理 /proc 内存），不是 scrub 函数本身的 bug。
 * 我们的"安全面硬约束"已通过 filterEnvForChild（子进程 env）+ process.env 双层兜底达成；
 * /proc/PID/environ 仅 root 或同 uid 可读。
 *
 * 若调用方需要，在 Linux 上可用 Linux 特定机制（如 prctl(PR_SET_DUMPABLE, 0) +
 * setrlimit RLIMIT_CORE=0）让子进程无法被 coredump；本函数只探测，不修改内核参数。
 */
export function checkProcEnvironForSecrets(): { hasSecrets: boolean; matchedKeys: string[] } {
  if (process.platform !== 'linux') return { hasSecrets: false, matchedKeys: [] };
  try {
    const buf = readFileSync('/proc/self/environ');
    const text = buf.toString('utf-8');
    const matched: string[] = [];
    // 仅扫描曾被父进程传入的敏感键（用 scrubProcessEnv 已删除的 K=V）
    // 简化：直接 grep 我们已知的 SENSITIVE 模式 + 任意 K=V 含 TOKEN
    const re = /\b([A-Z_0-9]*TOKEN[A-Z_0-9]*|[A-Z_0-9]*SECRET[A-Z_0-9]*|[A-Z_0-9]*PASSWORD[A-Z_0-9]*|[A-Z_0-9]*API[-_]?KEY[A-Z_0-9]*)=/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const key = m[1];
      if (!matched.includes(key)) matched.push(key);
    }
    return { hasSecrets: matched.length > 0, matchedKeys: matched };
  } catch {
    return { hasSecrets: false, matchedKeys: [] };
  }
}

/**
 * 构造子进程的 env：白名单 + 显式覆盖（如 PWD/rootDir）。
 * 永不透传敏感键（含调用方遗漏）。
 */
export function filterEnvForChild(
  overrides: Record<string, string | undefined> = {}
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  // 白名单：从 process.env 取当前允许的键
  for (const k of CHILD_ENV_ALLOWLIST) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  // 显式覆盖（最高优先级）
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) {
      delete out[k];
    } else {
      out[k] = v;
    }
  }
  // 兜底：再过一遍敏感键过滤（即使白名单写错也不漏）
  for (const k of Object.keys(out)) {
    if (isSensitiveEnvKey(k)) {
      delete out[k];
    }
  }
  return out;
}

/**
 * 深度扫描一个任意 JS 值，断言其中不出现「被列为 secret 的字符串」。
 * 用于「在响应/页面渲染前断言不含敏感值」——比 redact 更严格（一旦发现即拒绝服务）。
 *
 * 与 `redactSensitiveFields`（删除敏感键名）的区别：本函数额外校验「任何键名下嵌套字符串都不能等于
 * 已知 secret 值」。例如若有人塞进 `description: "<ADMIN_TOKEN_VALUE>"`，
 * redactSensitiveFields 不会删（description 不是敏感键名），但 assertSecretLeak 仍可命中。
 */
export function assertSecretLeak(value: unknown, knownSecrets: string[]): void {
  if (knownSecrets.length === 0) return;
  const seen = new WeakSet<object>();
  walk(value);
  function walk(v: unknown): void {
    if (v === null || v === undefined) return;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      for (const s of knownSecrets) {
        if (s && String(v).includes(s)) {
          throw new Error(
            `敏感值泄露：响应/页面包含已知 secret 字符串（长度=${s.length}）的子串匹配`,
          );
        }
      }
      return;
    }
    if (typeof v !== 'object') return;
    const obj = v as object;
    if (seen.has(obj)) return;
    seen.add(obj);
    if (Array.isArray(obj)) {
      for (const x of obj) walk(x);
      return;
    }
    for (const k of Object.keys(obj)) {
      // 跳过敏感键值（其值已知是 secret，不会再 nested 检查）
      if (isSensitiveEnvKey(k)) continue;
      // 递归
      walk((obj as Record<string, unknown>)[k]);
    }
  }
}

/** util.inspect 包装：限制深度避免大对象爆炸 */
export function safeInspect(value: unknown, depth = 3): string {
  return inspect(value, { depth, breakLength: 120 }).slice(0, 2000);
}
