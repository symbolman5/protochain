/**
 * 生成类步骤的机械预检能力
 *
 * 设计依据：《Harness 架构设计》§7.1 —— loop 内的预检信号必须来自机械层：
 * - 生成 TypeScript 后运行 tsc --noEmit；
 * - 生成 JSON/YAML 后解析 schema（由各调用方在 parse/preflight 中执行）；
 * - 测试用例覆盖度不达标时反馈未覆盖状态/转移（casegen 内执行）。
 *
 * 这些预检都是只读、低风险的；权威结论仍由步骤边界（orchestrator/verify）给出。
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import type { TestToolCode } from '../model/types.js';

const execFileP = promisify(execFile);

/**
 * 定位 protochain 包内的 node_modules（tsc / yaml / @types/node）：
 * 1) 显式环境变量覆盖（安装为 CLI 依赖时由宿主注入）；
 * 2) CJS 上下文（jest/ts-node CJS）按 __dirname 上溯两级；
 * 3) 从 cwd 向上查找含 tsc+yaml 的 node_modules（ts-node ESM dev 运行）；
 * 4) 兜底 cwd。
 */
function resolveNodeModulesDir(): string {
  const envOverride = process.env.PROTOCHAIN_PREFLIGHT_NODE_MODULES;
  if (envOverride && existsSync(join(envOverride, 'yaml'))) {
    return envOverride;
  }
  if (typeof __dirname !== 'undefined') {
    const candidate = join(__dirname, '..', '..', 'node_modules');
    if (existsSync(join(candidate, 'yaml'))) {
      return candidate;
    }
  }
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'node_modules');
    if (existsSync(join(candidate, '.bin', 'tsc')) && existsSync(join(candidate, 'yaml'))) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(process.cwd(), 'node_modules');
}

const NODE_MODULES = resolveNodeModulesDir();
const TSC_BIN = join(NODE_MODULES, '.bin', 'tsc');

export interface MechanicalPreflightResult {
  passed: boolean;
  /** 未通过时的机械反馈（编译错误等），作为给 AI 的修正信号 */
  feedback?: string;
}

export interface TypeScriptPreflightOptions {
  /** tsc 运行超时（毫秒，默认 30000） */
  timeoutMs?: number;
}

const PREFLIGHT_TSCONFIG = {
  compilerOptions: {
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'Bundler',
    lib: ['ES2022'],
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    esModuleInterop: true,
    resolveJsonModule: true,
    types: ['node'],
    isolatedModules: true,
  },
  include: ['*.ts'],
};

/**
 * 把生成的 TypeScript 源文件写入临时目录并运行 tsc --noEmit。
 *
 * 通过 -> { passed: true }；
 * 编译错误 -> { passed: false, feedback: 诊断摘要 }（作为 AI 修正反馈）；
 * tsc 不可用 -> 保守返回通过（环境无编译能力时退化为仅结构预检，不阻断确定性路径）。
 */
export async function preflightTypeScript(
  files: Record<string, string>,
  options: TypeScriptPreflightOptions = {}
): Promise<MechanicalPreflightResult> {
  const entries = Object.entries(files);
  if (entries.length === 0) {
    return { passed: false, feedback: '没有需要编译的 TypeScript 文件' };
  }
  for (const [name, content] of entries) {
    if (!content || content.trim().length === 0) {
      return { passed: false, feedback: `生成文件 ${name} 为空` };
    }
  }

  const dir = mkdtempSync(join(tmpdir(), 'protochain-preflight-'));
  try {
    for (const [name, content] of entries) {
      writeFileSync(join(dir, name), content, 'utf-8');
    }
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(PREFLIGHT_TSCONFIG, null, 2), 'utf-8');

    // 解析 'yaml' 等依赖与 node 类型：优先软链包内 node_modules
    let nodeModulesLinked = false;
    try {
      symlinkSync(NODE_MODULES, join(dir, 'node_modules'), 'dir');
      nodeModulesLinked = true;
    } catch {
      nodeModulesLinked = false;
    }
    if (!nodeModulesLinked) {
      // 回退：通过 baseUrl/paths 指向包内 node_modules（跨平台软链不可用时）
      const relNodeModules = relative(dir, NODE_MODULES).replaceAll('\\', '/');
      const relTypes = relative(dir, join(NODE_MODULES, '@types')).replaceAll('\\', '/');
      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify(
          {
            ...PREFLIGHT_TSCONFIG,
            compilerOptions: {
              ...PREFLIGHT_TSCONFIG.compilerOptions,
              baseUrl: '.',
              typeRoots: [relTypes],
              paths: {
                '*': [`${relNodeModules}/*`],
              },
            },
          },
          null,
          2
        ),
        'utf-8'
      );
    }

    try {
      await execFileP(TSC_BIN, ['-p', dir], { timeout: options.timeoutMs ?? 30000 });
      return { passed: true };
    } catch (err) {
      if (isErrnoENOENT(err)) {
        // tsc 二进制不可用：环境无编译能力，退化为仅结构预检
        return { passed: true, feedback: 'tsc 不可用，跳过编译预检（仅做结构预检）' };
      }
      const stdout = (err as { stdout?: string }).stdout ?? '';
      const stderr = (err as { stderr?: string }).stderr ?? '';
      const raw = `${stdout}\n${stderr}`.trim();
      const feedback = raw.length > 0 ? truncate(raw, 4000) : `tsc 预检失败：${String(err)}`;
      return { passed: false, feedback: formatTscDiagnostics(feedback, dir) };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 测试工具代码的结构预检（机械层）：
 * 四个源文件非空且包含约定的导出符号。编译预检由 preflightTypeScript 承担。
 */
export function preflightTestToolCode(code: TestToolCode): MechanicalPreflightResult {
  type ToolCodeKey = 'protocolModel' | 'scenarioLoader' | 'protocolExecutor' | 'consistencyAsserter';
  const checks: Array<[ToolCodeKey, string, string]> = [
    ['protocolModel', 'protocol-model.ts', 'export const PROTOCOL_NAME'],
    ['scenarioLoader', 'scenario-loader.ts', 'export function loadScenarios'],
    ['protocolExecutor', 'protocol-executor.ts', 'export async function executeScenario'],
    ['consistencyAsserter', 'consistency-asserter.ts', 'export function assertConsistency'],
  ];
  const failures: string[] = [];
  for (const [key, fileName, marker] of checks) {
    const content = code[key];
    if (!content || content.trim().length === 0) {
      failures.push(`${fileName} 为空`);
    } else if (!content.includes(marker)) {
      failures.push(`${fileName} 缺少导出符号 ${marker}`);
    }
  }
  if (failures.length > 0) {
    return {
      passed: false,
      feedback: `结构预检失败：${failures.join('；')}`,
    };
  }
  return { passed: true };
}

function formatTscDiagnostics(raw: string, tempDir: string): string {
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  // 压缩为 TS<code> 行摘要，保留文件名:行号:列号 信息
  const summarized = lines
    .filter((l) => /^.*\.ts\(\d+,\d+\): error TS\d+/.test(l))
    .map((l) => l.replaceAll(tempDir + '/', '').replace(/^.*node_modules\//, 'node_modules/'));
  const body = summarized.length > 0 ? summarized : lines;
  return `tsc --noEmit 未通过：\n${body.slice(0, 60).join('\n')}`;
}

function isErrnoENOENT(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'ENOENT'
  );
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…（已截断）`;
}
