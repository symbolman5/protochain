/**
 * TLC 模型检查器运行器 —— 通过 portable JRE + tla2tools.jar 执行 TLA+ 验证
 *
 * 设计依据：《协议驱动自验证工具链设计方案》第四节 FormalToolAdapter；
 * 风险表「TLA+ 兼容」：Docker 封装 + 无形式化工具降级模式 + 适配器可切换。
 *
 * 职责：
 * 1. 将生成的 TLA+ 规格写入临时目录，并生成 TLC 配置文件（SPECIFICATION + INVARIANTS）
 * 2. 调用 `<javaPath>/bin/java -jar <tla2toolsJar>` 执行模型检查（带超时控制）
 * 3. 解析 TLC 输出为每个不变量的验证结果（InvariantVerifyResult）
 *
 * 工具不可用时由 formalize 流程降级为 AI 推演（tool="tla-ai-fallback"）。
 */

import { spawn } from 'node:child_process';
import { existsSync, statSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { InvariantVerifyResult, TlcConfig } from '../model/types.js';

export const DEFAULT_TLC_TIMEOUT_MS = 60_000;

export interface TlcRunOptions {
  javaPath: string;
  tla2toolsJar: string;
  specFilePath: string;
  cfgFilePath?: string;
  timeoutMs: number;
}

export interface TlcRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** spawn 失败（如 java 不存在）时的错误信息 */
  spawnError?: string;
}

export interface TlcSpecRunResult extends TlcRunResult {
  /** 从规格中提取出的不变量 ID 列表（与输出解析对齐） */
  invariantIds: string[];
}

/**
 * 解析 javaPath：
 * - 直接给 java 可执行文件 → 原样返回
 * - 给 portable JRE 目录 → 自动补全 bin/java
 */
export function resolveJavaExecutable(javaPath: string): string {
  try {
    if (statSync(javaPath).isDirectory() && existsSync(join(javaPath, 'bin', 'java'))) {
      return join(javaPath, 'bin', 'java');
    }
  } catch {
    // 路径不存在或不是目录：按原样交给 spawn（可能是 PATH 中的 java）
  }
  return javaPath;
}

/**
 * 解析 tla2toolsJar：
 * - 直接给 jar 文件 → 原样返回
 * - 给目录 → 自动补全 tla2tools.jar
 */
export function resolveTla2toolsJar(jarPath: string): string {
  try {
    if (statSync(jarPath).isDirectory()) {
      const candidate = join(jarPath, 'tla2tools.jar');
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  } catch {
    // 路径不存在或不是目录：按原样交给 java
  }
  return jarPath;
}

/** 启动 java -jar tla2tools.jar 并收集输出，超时强制终止 */
export function runTlc(opts: TlcRunOptions): Promise<TlcRunResult> {
  return new Promise((resolve) => {
    // 说明：TLC 默认会检查死锁，而协议骨架的终态无出边属正常状态。
    // tla2tools 2.19 实测 `-deadlock` 为关闭死锁检查（`-noDeadlock` 在该版本不识别）。
    const args = ['-jar', opts.tla2toolsJar, '-deadlock'];
    if (opts.cfgFilePath) {
      args.push('-config', opts.cfgFilePath);
    }
    args.push(opts.specFilePath);

    const child = spawn(opts.javaPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ code: null, stdout, stderr, timedOut: true });
    }, opts.timeoutMs);

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, timedOut: false, spawnError: err.message });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut: false });
    });
  });
}

/**
 * 便捷封装：把规格写入临时目录（含生成的 .cfg），运行 TLC 后清理临时文件
 */
export async function runTlcOnSpec(spec: string, tlc: TlcConfig): Promise<TlcSpecRunResult> {
  const dir = mkdtempSync(join(tmpdir(), 'protochain-tlc-'));
  try {
    // TLC 要求输入文件名与模块名一致，临时文件按规格中的 MODULE 名命名
    const moduleName = /----\s+MODULE\s+(\w+)\s+----/.exec(spec)?.[1] ?? 'Protocol';
    const specFilePath = join(dir, `${moduleName}.tla`);
    writeFileSync(specFilePath, spec, 'utf-8');

    const invariantIds = extractInvariantIds(spec);
    const cfgFilePath = join(dir, 'model.cfg');
    writeFileSync(cfgFilePath, buildTlcConfig(spec, invariantIds), 'utf-8');

    const result = await runTlc({
      javaPath: resolveJavaExecutable(tlc.javaPath ?? 'java'),
      tla2toolsJar: resolveTla2toolsJar(tlc.tla2toolsJar ?? 'tla2tools.jar'),
      specFilePath,
      cfgFilePath,
      timeoutMs: tlc.timeoutMs ?? DEFAULT_TLC_TIMEOUT_MS,
    });
    return { ...result, invariantIds };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ============================================================================
// TLC 配置生成与输出解析
// ============================================================================

const TLC_RESERVED_NAMES = new Set([
  'Init',
  'Next',
  'Spec',
  'States',
  'TypeInvariant',
  'AllInvariants',
  'MODULE',
  'EXTENDS',
  'CONSTANTS',
  'CONSTANT',
  'VARIABLES',
  'VARIABLE',
  'ASSUME',
  'THEOREM',
  'LEMMA',
]);

/**
 * 从 TLA+ 规格中提取不变量定义名（顶层 `NAME == expr` 定义，排除保留名）。
 * 骨架生成的不变量（INV1、INV2…）与退化模式规格中的不变量均可命中。
 *
 * 优先返回 AllInvariants 聚合：它只引用真正的不变量（如 INV1/INV2/CT3Invariant），
 * 避免把守卫翻译注入的辅助谓词（如 HasNoMappings）与动作定义（AbstractMappingAdd）误当 INVARIANT。
 * 无 AllInvariants 时退回启发式：仅提取状态谓词（跳过含 prime 的动作与含时序算子的属性）。
 */
export function extractInvariantIds(spec: string): string[] {
  // 聚合不变量存在时只检查它
  if (/^\s*AllInvariants\s*==/m.test(spec)) {
    return ['AllInvariants'];
  }
  const ids: string[] = [];
  const re = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*==/gm;
  const defs: { id: string; bodyStart: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(spec)) !== null) {
    const id = m[1];
    if (TLC_RESERVED_NAMES.has(id)) continue;
    defs.push({ id, bodyStart: m.index + m[0].length });
  }
  for (let i = 0; i < defs.length; i++) {
    const { id, bodyStart } = defs[i];
    const bodyEnd = i + 1 < defs.length ? defs[i + 1].bodyStart : spec.length;
    const body = spec.slice(bodyStart, bodyEnd);
    // 含 prime（动作）或时序算子（属性）的定义不是状态不变量，跳过
    if (/'/.test(body) || /\[.*\]_|<>/.test(body)) continue;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** 生成 TLC 配置文件内容（SPECIFICATION + INVARIANTS） */
export function buildTlcConfig(spec: string, invariantIds: string[]): string {
  const lines: string[] = [];
  if (/^\s*Spec\s*==/m.test(spec)) {
    lines.push('SPECIFICATION Spec');
  }
  if (invariantIds.length > 0) {
    lines.push(`INVARIANTS ${invariantIds.join(' ')}`);
  }
  return lines.join('\n') + '\n';
}

export interface TlcParseResult {
  passed: boolean;
  invariantResults: InvariantVerifyResult[];
  /** TLC 报错行（语法/配置错误等，说明未产出验证结论） */
  errorLines: string[];
}

/** 从反例位置截取一段可读的状态跟踪 */
function extractCounterexample(raw: string, invariantId: string): string | undefined {
  const marker = `Invariant ${invariantId} is violated`;
  const idx = raw.indexOf(marker);
  if (idx < 0) return undefined;
  const start = idx + marker.length;
  const nextError = raw.indexOf('\nError:', start);
  const end = nextError > 0 ? nextError : Math.min(start + 1200, raw.length);
  const snippet = raw.slice(start, end).trim();
  return snippet.length > 0 ? snippet.slice(0, 1200) : undefined;
}

/** 解析 TLC 原始输出为各不变量的验证结果 */
export function parseTlcOutput(raw: string, invariantIds: string[]): TlcParseResult {
  const completedOk = /Model checking completed\. No error has been found\./.test(raw);
  const violated = new Set<string>();
  const re = /Invariant\s+(\S+)\s+is\s+violated/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    violated.add(m[1]);
  }

  // 只保留"未产出验证结论"的错误（语法/配置/资源错误）；
  // 不变量违反 / 行为跟踪 / 时序属性违反属于确定性结论，不算工具错误。
  // SANY 语义错误详情不带 "Error:" 前缀，需额外匹配（Unknown operator / line 定位等）。
  const errorLines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(
      (l) =>
        l.startsWith('Error:') ||
        /^Unknown operator/.test(l) ||
        /^Could not find/.test(l) ||
        /^Couldn't resolve/.test(l) ||
        l.startsWith('Semantic errors') ||
        /^\*\*\* Errors:/.test(l)
    )
    .filter((l) => !/is violated|The behavior up to this point|properties were violated/.test(l))
    .slice(0, 10);

  const invariantResults: InvariantVerifyResult[] = invariantIds.map((id) => {
    if (completedOk || !violated.has(id)) {
      return { invariantId: id, passed: true };
    }
    return {
      invariantId: id,
      passed: false,
      counterexample: extractCounterexample(raw, id),
    };
  });

  const passed = completedOk && invariantResults.every((r) => r.passed);
  return { passed, invariantResults, errorLines };
}
