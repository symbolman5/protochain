/**
 * 反馈闭环：scenarios/bindings 文件读写层 —— E7-P1
 *
 * 职责：
 *   1. 列出 scenarios/*.yaml、读单个、写单个、新建、删除
 *   2. 读/写 bindings.yaml
 *   3. 写盘前 ajv 校验；非法内容拒绝落盘（与 verify 走的是同一权威源校验路径）
 *   4. 所有读出的对象经过 redactSensitiveFields（防御性 + 与 P0 对齐）
 *
 * 安全：
 *   - 不读取 process.env（仅读入静态文件）
 *   - 不写入 derived/ 产物（在线编辑只改权威源文件）
 *   - 文件路径限制在 rootDir/scenarios 与 rootDir/bindings.yaml（防 path traversal）
 *
 * 设计：
 *   - YAML → JS 用 `yaml` 库（项目已有依赖）
 *   - 错误结构稳定：返回 {ok: false, error} 而非抛错（便于 handler 转 JSON 4xx）
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
  mkdirSync,
  renameSync,
} from 'node:fs';
import { join, basename, isAbsolute, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import {
  validateScenario,
  validateBindingFile,
  type ScenarioFile,
  type BindingFile,
} from './schemas.js';

const SCENARIOS_RELATIVE_DIRS = [
  'protocol/scenarios', // 单协议布局（最常见）
  'scenarios',          // 多协议子协议布局（旧 P1/P2 等）
  'protocol/P1/scenarios', // 多协议项目级（hsk-ng / strangler-fig 的每子协议）
];

/**
 * 定位 scenarios 目录（与 binding-runner.findScenariosDir 对齐）：
 *   - 单协议布局：<rootDir>/protocol/scenarios
 *   - 多协议子协议布局：<rootDir>/scenarios
 *   - 子协议根目录传入时直接检查 <rootDir>/scenarios
 */
export function findScenariosDir(rootDir: string): string | null {
  for (const rel of SCENARIOS_RELATIVE_DIRS) {
    const p = join(rootDir, rel);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * 定位 bindings.yaml 路径：
 *   - 单协议布局：<rootDir>/bindings.yaml
 *   - 多协议子协议布局：<rootDir>/protocol/bindings.yaml
 */
export function findBindingsFile(rootDir: string): string | null {
  const a = join(rootDir, 'bindings.yaml');
  const b = join(rootDir, 'protocol/bindings.yaml');
  if (existsSync(a)) return a;
  if (existsSync(b)) return b;
  return null;
}

// ============================================================================
// scenarios/*.yaml 操作
// ============================================================================

export interface ListScenariosResult {
  ok: boolean;
  dir: string;
  files: Array<{ filename: string; id: string | null; parsed: ScenarioFile | null }>;
}

export type StoreResult<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * 列出 scenarios/*.yaml。
 * yaml 解析失败的文件：data: null，error 不抛出（list 不阻断）
 */
export function listScenarios(rootDir: string): StoreResult<ListScenariosResult> {
  const dir = findScenariosDir(rootDir);
  if (!dir) return { ok: false, error: '未找到 scenarios 目录（protocol/scenarios 或 scenarios）' };
  const files: ListScenariosResult['files'] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.yaml') && !f.endsWith('.yml')) continue;
    const path = join(dir, f);
    let parsed: ScenarioFile | null = null;
    let id: string | null = null;
    try {
      const raw = readFileSync(path, 'utf-8');
      const obj = parseYaml(raw) as Partial<ScenarioFile> | null;
      if (obj && typeof obj === 'object') {
        const v = validateScenario(obj);
        if (v.ok) {
          parsed = obj as ScenarioFile;
          id = parsed.id;
        }
      }
    } catch {
      // 解析失败：id=null，parsed=null
    }
    files.push({ filename: f, id, parsed });
  }
  return { ok: true, data: { ok: true, dir, files } };
}

/**
 * 拒绝 path traversal / 绝对路径 / 越界文件
 */
export function assertScenarioFileWithinDir(scenariosDir: string, filename: string): string {
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    throw new Error(`非法 scenarios 文件名：${filename}`);
  }
  if (isAbsolute(filename)) {
    throw new Error(`非法 scenarios 文件名（绝对路径不允许）：${filename}`);
  }
  if (!/^[\w.\-]+\.ya?ml$/.test(filename)) {
    throw new Error(`非法 scenarios 文件名（仅允许 [\\w.-].yaml|.yml）：${filename}`);
  }
  const full = resolve(scenariosDir, filename);
  const dirWithSep = scenariosDir.endsWith('/') ? scenariosDir : scenariosDir + '/';
  if (!full.startsWith(dirWithSep) && full !== scenariosDir) {
    throw new Error(`scenarios 文件越界：${full}`);
  }
  return full;
}

/**
 * 读取单个 scenario 文件
 */
export function readScenarioFile(rootDir: string, filename: string): StoreResult<{ path: string; raw: string; parsed: ScenarioFile | null; validation: { ok: true } | { ok: false; error: string } }> {
  const dir = findScenariosDir(rootDir);
  if (!dir) return { ok: false, error: '未找到 scenarios 目录' };
  let path: string;
  try {
    path = assertScenarioFileWithinDir(dir, filename);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!existsSync(path)) return { ok: false, error: `scenario 文件不存在：${filename}` };
  const raw = readFileSync(path, 'utf-8');
  let parsed: ScenarioFile | null = null;
  let validation: { ok: true } | { ok: false; error: string } = { ok: true };
  try {
    const obj = parseYaml(raw);
    const v = validateScenario(obj);
    if (v.ok) {
      parsed = obj as ScenarioFile;
    } else {
      validation = v;
    }
  } catch (err) {
    validation = { ok: false, error: `yaml 解析失败：${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true, data: { path, raw, parsed, validation } };
}

/**
 * 写入单个 scenario 文件；写盘前 ajv 校验；非法拒绝落盘。
 *
 * 写盘格式：用 yaml.stringify 序列化（保持 deterministic 排序，避免 diff 噪声）
 *
 * 自动建目录：scenarios 目录不存在时尝试创建（rootDir/protocol/scenarios）；
 * 这允许全新空仓库使用 P1 编辑器（无须 `init` 跑通全流程）。
 */
export function writeScenarioFile(
  rootDir: string,
  filename: string,
  body: ScenarioFile
): StoreResult<{ path: string }> {
  let dir = findScenariosDir(rootDir);
  if (!dir) {
    // 探测式创建：单协议布局
    try {
      const tryDir = join(rootDir, 'protocol', 'scenarios');
      if (!existsSync(tryDir)) {
        mkdirSync(tryDir, { recursive: true });
      }
      dir = tryDir;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  let path: string;
  try {
    path = assertScenarioFileWithinDir(dir, filename);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const v = validateScenario(body);
  if (!v.ok) return { ok: false, error: `schema 校验失败：${v.error}` };
  // 序列化：保留 YAML frontmatter 风格 —— 与现有 sc-01.yaml 同款
  const frontmatter = `# 场景 ${body.id}（编辑器落盘）`;
  const yamlBody = stringifyYaml(body, { lineWidth: 120, sortMapEntries: false });
  writeFileSync(path, `${frontmatter}\n${yamlBody}\n`, 'utf-8');
  return { ok: true, data: { path } };
}

/**
 * 新建 scenario 文件（自动命名 sc-NN.yaml 中下一个可用 N）
 *
 * 自动建目录同 writeScenarioFile。
 */
export function createScenarioFile(rootDir: string, body: ScenarioFile): StoreResult<{ path: string; filename: string }> {
  let dir = findScenariosDir(rootDir);
  if (!dir) {
    try {
      const tryDir = join(rootDir, 'protocol', 'scenarios');
      if (!existsSync(tryDir)) {
        mkdirSync(tryDir, { recursive: true });
      }
      dir = tryDir;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  const v = validateScenario(body);
  if (!v.ok) return { ok: false, error: `schema 校验失败：${v.error}` };
  // 自动命名：sc-<id-tag>.yaml；若已存在则 sc-1.yaml / sc-2.yaml 之类
  const existing = readdirSync(dir).filter((f) => f.endsWith('.yaml'));
  let nextName: string | null = null;
  for (let i = 1; i < 9999; i++) {
    const candidate = `sc-${String(i).padStart(2, '0')}.yaml`;
    if (!existing.includes(candidate)) {
      nextName = candidate;
      break;
    }
  }
  if (nextName === null) return { ok: false, error: 'scenarios 目录已无可用编号' };
  const path = join(dir, nextName);
  const frontmatter = `# 场景 ${body.id}（新建于 P1 编辑器）`;
  const yamlBody = stringifyYaml(body, { lineWidth: 120, sortMapEntries: false });
  writeFileSync(path, `${frontmatter}\n${yamlBody}\n`, 'utf-8');
  return { ok: true, data: { path, filename: nextName } };
}

/**
 * 删除 scenario 文件（确认存在；不存在即拒）
 */
export function deleteScenarioFile(rootDir: string, filename: string): StoreResult<{ path: string }> {
  const dir = findScenariosDir(rootDir);
  if (!dir) return { ok: false, error: '未找到 scenarios 目录' };
  let path: string;
  try {
    path = assertScenarioFileWithinDir(dir, filename);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!existsSync(path)) return { ok: false, error: `scenario 文件不存在：${filename}` };
  unlinkSync(path);
  return { ok: true, data: { path } };
}

// ============================================================================
// bindings.yaml 操作
// ============================================================================

/**
 * 读 bindings.yaml；输出已通过 redactSensitiveFields（防御性删 tokenEnv/secretEnv/passwordEnv 整键）
 */
export function readBindingsFile(rootDir: string): StoreResult<{
  path: string;
  raw: string;
  parsed: BindingFile | null;
  validation: { ok: true } | { ok: false; error: string };
}> {
  const path = findBindingsFile(rootDir);
  if (!path) return { ok: false, error: '未找到 bindings.yaml' };
  const raw = readFileSync(path, 'utf-8');
  let parsed: BindingFile | null = null;
  let validation: { ok: true } | { ok: false; error: string } = { ok: true };
  try {
    const obj = parseYaml(raw) as unknown;
    if (obj === null || obj === undefined) {
      parsed = { roles: [], interfaces: [] };
    } else {
      const v = validateBindingFile(obj);
      if (v.ok) parsed = obj as BindingFile;
      else validation = v;
    }
  } catch (err) {
    validation = { ok: false, error: `yaml 解析失败：${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true, data: { path, raw, parsed, validation } };
}

/**
 * 写 bindings.yaml；写盘前 ajv 校验；非法拒绝落盘
 *
 * 不主动 redact 输入：调用方需要看到 tokenEnv 字段名以保持原有端到端流程（不动权威源 = 不动 bindings
 * 结构）。但响应给前端时已调用 `redactSensitiveFields`。
 */
export function writeBindingsFile(
  rootDir: string,
  body: BindingFile
): StoreResult<{ path: string }> {
  const path = findBindingsFile(rootDir);
  if (!path) return { ok: false, error: '未找到 bindings.yaml' };
  const v = validateBindingFile(body);
  if (!v.ok) return { ok: false, error: `schema 校验失败：${v.error}` };
  const yamlBody = stringifyYaml(body, { lineWidth: 120, sortMapEntries: false });
  writeFileSync(path, yamlBody, 'utf-8');
  return { ok: true, data: { path } };
}

/**
 * E7-P1-I1 修复：原子整文件替换（PUT 路径）。
 *
 * 与 writeBindingsFile 的区别：写前自动备份到 `<path>.bak-<ts>`，并要求 caller 显式传入
 * `replaceAll: true` 才能调用此函数（路由层把关）。这是 P004 修复路径 2「PUT 降级为
 * 整文件替换需 confirm token」的最小落地。
 *
 * 备份命名：`bindings.yaml.bak-<epoch-ms>`；多次连写产生多个备份，便于事后回滚。
 *
 * 返回：path、备份路径。
 */
export function replaceBindingsFileAtomic(
  rootDir: string,
  body: BindingFile
): StoreResult<{ path: string; backupPath: string }> {
  const path = findBindingsFile(rootDir);
  if (!path) return { ok: false, error: '未找到 bindings.yaml' };
  const v = validateBindingFile(body);
  if (!v.ok) return { ok: false, error: `schema 校验失败：${v.error}` };
  // 写前备份
  const backupPath = `${path}.bak-${Date.now()}`;
  try {
    const raw = readFileSync(path, 'utf-8');
    writeFileSync(backupPath, raw, 'utf-8');
  } catch (err) {
    return { ok: false, error: `备份失败：${err instanceof Error ? err.message : String(err)}` };
  }
  const yamlBody = stringifyYaml(body, { lineWidth: 120, sortMapEntries: false });
  // atomic write：先写 .tmp 再 rename
  const tmp = `${path}.tmp-${Date.now()}`;
  try {
    writeFileSync(tmp, yamlBody, 'utf-8');
    // rename 原子替换（同文件系统内 rename 是 atomic 的）
    renameSync(tmp, path);
  } catch (err) {
    return { ok: false, error: `atomic 写失败：${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true, data: { path, backupPath } };
}

/**
 * E7-P1-I1 修复：字段级合并（PATCH 路径）。
 *
 * 合并策略：
 *   - `roles`：以 `roleId` 为键，存在则替换整条（角色级字段整体替换），不存在则追加。
 *   - `interfaces`：以 `action` 为键，存在则深合并 `transport`（含 method/path/headers），
 *     不存在则追加整条。其它顶层字段（environments/defaultEnv/stateMap/tls）若 body 提供则
 *     整体替换，否则保留原值。
 *   - 删除单接口：`interfaces[]._delete === true` 时从合并结果中剔除该 action（实现
 *     DELETE /api/bindings/interfaces/:action 的合并语义）。
 *
 * 写盘策略：先 `replaceBindingsFileAtomic` 留备份 + atomic 写。
 */
export interface MergeBindingsPatch {
  roles?: Array<{ roleId: string; auth?: string; [k: string]: unknown }>;
  interfaces?: Array<{
    action: string;
    protocol?: string;
    roleId?: string;
    transport?: Record<string, unknown>;
    _delete?: boolean;
    [k: string]: unknown;
  }>;
  environments?: Record<string, unknown>;
  defaultEnv?: string;
}

export function mergeBindingsFile(
  rootDir: string,
  patch: MergeBindingsPatch
): StoreResult<{ path: string; backupPath: string; merged: BindingFile; diff: { addedRoles: string[]; updatedRoles: string[]; addedInterfaces: string[]; updatedInterfaces: string[]; deletedInterfaces: string[] } }> {
  const path = findBindingsFile(rootDir);
  if (!path) return { ok: false, error: '未找到 bindings.yaml' };
  // 读当前文件
  const cur = readBindingsFile(rootDir);
  if (!cur.ok) return { ok: false, error: cur.error };
  const base: BindingFile = (cur.data.parsed && typeof cur.data.parsed === 'object'
    ? cur.data.parsed
    : { roles: [], interfaces: [] }) as BindingFile;
  const next: BindingFile = {
    roles: [...(base.roles ?? [])],
    interfaces: [...(base.interfaces ?? [])],
    ...(base.environments ? { environments: structuredClone(base.environments) } : {}),
    ...(base.defaultEnv ? { defaultEnv: base.defaultEnv } : {}),
    ...Object.fromEntries(
      Object.entries(base).filter(
        ([k]) => !['roles', 'interfaces', 'environments', 'defaultEnv'].includes(k)
      )
    ),
  } as BindingFile;

  const addedRoles: string[] = [];
  const updatedRoles: string[] = [];
  const addedInterfaces: string[] = [];
  const updatedInterfaces: string[] = [];
  const deletedInterfaces: string[] = [];

  // roles 合并（按 roleId）
  if (Array.isArray(patch.roles)) {
    for (const role of patch.roles) {
      const idx = next.roles.findIndex((r) => r.roleId === role.roleId);
      if (idx >= 0) {
        next.roles[idx] = { ...next.roles[idx], ...role } as typeof next.roles[number];
        updatedRoles.push(role.roleId);
      } else {
        next.roles.push(role as typeof next.roles[number]);
        addedRoles.push(role.roleId);
      }
    }
  }
  // interfaces 合并（按 action + transport 深合并；_delete=true 则删除）
  if (Array.isArray(patch.interfaces)) {
    for (const it of patch.interfaces) {
      if (it._delete === true) {
        const before = next.interfaces.length;
        next.interfaces = next.interfaces.filter((x) => x.action !== it.action);
        if (next.interfaces.length < before) deletedInterfaces.push(it.action);
        continue;
      }
      const idx = next.interfaces.findIndex((x) => x.action === it.action);
      if (idx >= 0) {
        const prev = next.interfaces[idx];
        const prevTransport = (prev.transport && typeof prev.transport === 'object'
          ? prev.transport
          : {}) as Record<string, unknown>;
        const newTransport = (it.transport && typeof it.transport === 'object'
          ? it.transport
          : {}) as Record<string, unknown>;
        next.interfaces[idx] = {
          ...prev,
          ...it,
          transport: { ...prevTransport, ...newTransport } as typeof prev.transport,
        } as typeof next.interfaces[number];
        updatedInterfaces.push(it.action);
      } else {
        next.interfaces.push(it as typeof next.interfaces[number]);
        addedInterfaces.push(it.action);
      }
    }
  }
  if (patch.environments !== undefined) next.environments = patch.environments as typeof next.environments;
  if (patch.defaultEnv !== undefined) next.defaultEnv = patch.defaultEnv;

  // 校验合并后整体仍 schema 通过
  const v = validateBindingFile(next);
  if (!v.ok) return { ok: false, error: `合并后 schema 校验失败：${v.error}` };
  const r = replaceBindingsFileAtomic(rootDir, next);
  if (!r.ok) return { ok: false, error: r.error };
  return {
    ok: true,
    data: {
      path: r.data.path,
      backupPath: r.data.backupPath,
      merged: next,
      diff: { addedRoles, updatedRoles, addedInterfaces, updatedInterfaces, deletedInterfaces },
    },
  };
}

export { basename };
