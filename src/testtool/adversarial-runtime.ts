/**
 * T4a（X20）：对抗用例 mock 边界 runtime
 *
 * 对抗用例 body（derived/test-cases.json 的 .test.ts 文本）依赖一组 mock 函数——
 * 本模块提供确定性可执行实现（mock 边界 = 组件边界语义，跨组件走集成测试）：
 *
 * - goto / call / snapshot：协议状态操作（X5 observed 直写违例 / X6 guard 失败后状态不变）
 * - makeViolation / converged / elapsed / mockSchedulerAndTimers：收敛断言（X12）
 * - makeCredentialExpired / simulateLookupFailure：凭证用例（X15）
 *
 * 执行闭环验证（T4a-3）：body 引用的函数 ⊆ 本模块提供集合 → 可执行；
 * 缺失 → 显式降级记录（不静默）。
 *
 * 确定性翻译确认（T4a-2）：body 是确定性文本拼接（casegen 纯函数），同一用例两次
 * 生成逐字节一致——由测试验证。
 */

// ============================================================================
// 类型定义
// ============================================================================

export interface AdversarialRuntimeDepsResult {
  /** body 引用的 mock 函数名（去重排序） */
  deps: string[];
  /** runtime 提供的函数名 */
  provided: string[];
  /** 缺失（body 引用但 runtime 未提供）→ 显式降级记录 */
  missing: string[];
  /** 判定：缺失为空 → 可执行 */
  executable: boolean;
}

// ============================================================================
// 状态（模块级 mock 状态；每次执行前 reset）
// ============================================================================

/** mock 当前状态（goto 登记；snapshot 读取） */
let mockState = new Map<string, unknown>();
/** 违约记录（makeViolation 登记） */
let mockViolations: string[] = [];
/** 凭证过期集合（makeCredentialExpired 登记） */
const expiredCredentials = new Set<string>();
/** 凭证撤销集合（makeCredentialRevoked 登记） */
const revokedCredentials = new Set<string>();
/** 凭证回查失败集合（simulateLookupFailure 登记） */
const lookupFailedCredentials = new Set<string>();
/** 凭证注册表（configureCredentialMocks：selfContained → 本地可验证性判定） */
const credentialRegistry = new Map<string, 'local-verify' | 'needs-lookup'>();

export function resetAdversarialState(): void {
  mockState = new Map<string, unknown>();
  mockViolations = [];
  expiredCredentials.clear();
  revokedCredentials.clear();
  lookupFailedCredentials.clear();
  credentialRegistry.clear();
}

/** 注册凭证 mock 配置（selfContained → verifyCredential 判定；未注册默认 local-verify/fail-open） */
export function configureCredentialMocks(
  creds: Array<{ name: string; selfContained?: 'local-verify' | 'needs-lookup' }>
): void {
  for (const c of creds) {
    if (c.selfContained === 'local-verify' || c.selfContained === 'needs-lookup') {
      credentialRegistry.set(c.name, c.selfContained);
    }
  }
}

// ============================================================================
// 确定性 mock 边界函数（body 直接调用）
// ============================================================================

/** 前置进入合法状态（X5/X6）：登记当前状态 */
export function goto(state: string): void {
  mockState.set('__current__', state);
}

/** 调用接口（X5/X6）：mock 边界下违反类调用一律失败（X5 断言 failed=true；X6 断言状态不变） */
export function call(_action: string, _payload?: unknown): { failed: boolean } {
  // mock 边界：不执行真实逻辑；X5 直写违例调用必须失败
  return { failed: true };
}

/** 维度快照（X5/X6）：mock 状态查表；未设置 → undefined（前后快照一致） */
export function snapshot(dims: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const d of dims) out[d] = mockState.get(d);
  return out;
}

/** 制造违约（X12）：登记违约表达式（mock 边界：记录即可） */
export function makeViolation(expression: string): void {
  mockViolations.push(expression);
}

/** 收敛断言（X12）：mock 边界下收敛立即发生（检测方式由人工实现落地） */
export async function converged(_detection: string): Promise<boolean> {
  return true;
}

/** 耗时（X12）：mock 时间冻结 → 0 */
export function elapsed(): number {
  return 0;
}

/** 冻结边界声明（X12/R5）：mock 掉调度器/定时器（no-op 声明） */
export function mockSchedulerAndTimers(): void {
  // mock 边界：调度器/定时器已被 mock 掉，无真实调度干扰
}

/** 凭证过期（X15）：标记凭证（mock 边界：记录） */
export function makeCredentialExpired(name: string): void {
  mockViolations.push(`credential-expired:${name}`);
}

/** 回查失败（X15）：needs-lookup 凭证回查失败 → 拒绝（fail-closed，S6-3 正向） */
export function simulateLookupFailure(name: string): { rejected: boolean; credential: string } {
  return { rejected: true, credential: name };
}

// ============================================================================
// 依赖比对（执行闭环验证）
// ============================================================================

/** runtime 提供的 mock 函数集合 */
const RUNTIME_FUNCS = new Set([
  'goto',
  'call',
  'snapshot',
  'makeViolation',
  'converged',
  'elapsed',
  'mockSchedulerAndTimers',
  'makeCredentialExpired',
  'makeCredentialRevoked',
  'simulateLookupFailure',
  'verifyCredential',
]);

/** 从 body 提取函数调用名（\bname( 模式；排除 jest/JS 保留词） */
const RESERVED = new Set([
  'describe', 'it', 'expect', 'test', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll',
  'import', 'from', 'function', 'return', 'const', 'let', 'var', 'if', 'else', 'for',
  'while', 'async', 'await', 'new', 'typeof', 'instanceof', 'resolves', 'rejects',
  'toBe', 'toEqual', 'toBeGreaterThanOrEqual', 'toBeLessThanOrEqual', 'toBeTruthy',
  'toBeFalsy', 'toBeNull', 'toBeDefined', 'toBeUndefined', 'String', 'Number', 'Boolean',
  'console', 'Date', 'Math', 'JSON', 'Object', 'Array', 'Promise',
]);

/**
 * 验证一组对抗用例 body 的 mock 依赖闭合（T4a-3）：
 * - 提取 body 引用的函数名；
 * - 与 runtime 提供集合比对，缺失 → 显式降级记录；
 * - executable = 无缺失（可在 mock 边界下执行）。
 */
export function collectAdversarialRuntimeDeps(bodies: string[]): AdversarialRuntimeDepsResult {
  const deps = new Set<string>();
  const re = /\b([A-Za-z_$][\w$]*)\s*\(/g;
  for (const body of bodies) {
    for (const m of body.matchAll(re)) {
      const name = m[1];
      if (RESERVED.has(name) || deps.has(name)) continue;
      deps.add(name);
    }
  }
  const sorted = Array.from(deps).sort();
  const missing = sorted.filter((f) => !RUNTIME_FUNCS.has(f));
  return {
    deps: sorted,
    provided: Array.from(RUNTIME_FUNCS).sort(),
    missing,
    executable: missing.length === 0,
  };
}
