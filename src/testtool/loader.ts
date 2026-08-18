/**
 * test-tool 加载器 —— 阶段 A"可执行入口契约"的加载侧。
 *
 * 职责：
 * 1. 读取 derived/test-tool/ 下 4 个生成源文件（protocol-model / scenario-loader /
 *    protocol-executor / consistency-asserter）与 meta.json；
 * 2. 用 TypeScript 编译器把它们编译到临时目录（ESM），symlink 项目 node_modules
 *    使 'yaml' 等依赖可解析，再动态 import 编译产物；
 * 3. 校验契约：protocol-executor 必须导出 `executePath(transitionIds, implementation)`，
 *    protocol-model 必须导出 `TRANSITIONS`（转移表）。不满足即抛 TestToolContractError
 *    （"生成产物可加载"的失败必须可见，不得静默回退）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import type { TestToolModule } from '../model/types.js';

export class TestToolContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestToolContractError';
  }
}

const TEST_TOOL_FILES = [
  'protocol-model.ts',
  'scenario-loader.ts',
  'protocol-executor.ts',
  'consistency-asserter.ts',
] as const;

function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function compileTestTool(fileNames: string[], outDir: string): void {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    // CommonJS 编译：jest（CJS require）与 CLI（ESM import CJS）都能加载；
    // Node10 解析把相对 './x.js' 映射回 './x.ts'，无需 ESM 包声明。
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    outDir,
    rootDir: outDir,
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    declaration: false,
    sourceMap: false,
    // @types 自动包含以 cwd 为基准；这里显式指向工作目录的 node_modules/@types，
    // 使 'node:fs'/'node:path' 等内置类型与调用方 cwd 解耦
    typeRoots: [join(outDir, 'node_modules', '@types')],
  };
  const host = ts.createCompilerHost(options);
  host.getCurrentDirectory = () => outDir;
  const program = ts.createProgram(fileNames, options, host);
  const emitResult = program.emit();
  const diagnostics = ts.getPreEmitDiagnostics(program).concat(emitResult.diagnostics);
  if (diagnostics.length > 0) {
    const messages = diagnostics
      .map((d) => {
        const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n');
        const pos = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : null;
        return pos
          ? `${d.file!.fileName}:${pos.line + 1}:${pos.character + 1} — ${msg}`
          : msg;
      })
      .join('\n');
    throw new TestToolContractError(`test-tool 编译失败（生成产物不可执行）:\n${messages}`);
  }
}

/** CJS（jest）下用 require 加载；ESM（CLI）下 import CJS 后取 default 归一化。 */
async function loadCompiledModule(file: string): Promise<Record<string, unknown>> {
  const cjsRequire = typeof require === 'function' ? (require as (id: string) => unknown) : null;
  const raw = cjsRequire
    ? (cjsRequire(file) as Record<string, unknown>)
    : ((await import(pathToFileURL(file).href)) as Record<string, unknown>);
  const def = raw.default as Record<string, unknown> | undefined;
  if (def && typeof def === 'object' && Object.keys(def).length > 0 && def !== raw) {
    return def;
  }
  return raw;
}

/**
 * 加载生成 test-tool 并编译/import。
 * @param rootDir 协议根目录（含 derived/test-tool/）
 * @param options.nodeModulesDir 项目 node_modules 目录（编译产物解析 'yaml' 等依赖；
 *   缺省取 cwd/node_modules——jest 运行于包根可用；CLI 显式传入包根 node_modules，
 *   避免 import.meta 在 CJS 转换上下文不可用）
 */
export async function loadTestTool(
  rootDir: string,
  options: { nodeModulesDir?: string } = {},
): Promise<TestToolModule> {
  const toolDir = join(rootDir, 'derived', 'test-tool');
  const sourceByName = new Map<string, string>();
  for (const name of TEST_TOOL_FILES) {
    const file = join(toolDir, name);
    if (!existsSync(file)) {
      throw new TestToolContractError(`test-tool 缺失源文件: ${file}`);
    }
    sourceByName.set(name, readFileSync(file, 'utf8'));
  }

  const workDir = mkdtempSync(join(tmpdir(), 'protochain-testtool-'));
  try {
    for (const [name, source] of sourceByName) {
      writeFileSync(join(workDir, name), source, 'utf8');
    }
    const pkgNodeModules = resolve(
      options.nodeModulesDir ?? process.env.PROTOCHAIN_NODE_MODULES ?? join(process.cwd(), 'node_modules'),
    );
    if (existsSync(pkgNodeModules)) {
      try {
        symlinkSync(pkgNodeModules, join(workDir, 'node_modules'), 'dir');
      } catch {
        // 已存在或平台限制：编译产物仍可回退到宿主 node_modules 解析
      }
    }

    compileTestTool(
      TEST_TOOL_FILES.map((n) => join(workDir, n)),
      workDir,
    );

    const executor = await loadCompiledModule(join(workDir, 'protocol-executor.js'));
    const model = await loadCompiledModule(join(workDir, 'protocol-model.js'));
    const scenarioLoader = await loadCompiledModule(join(workDir, 'scenario-loader.js'));
    const consistencyAsserter = await loadCompiledModule(join(workDir, 'consistency-asserter.js'));

    if (typeof executor.executePath !== 'function') {
      throw new TestToolContractError(
        'test-tool 契约不满足：protocol-executor 未导出可执行入口 executePath(transitionIds, implementation)（生成产物不可执行）',
      );
    }
    if (!Array.isArray(model.TRANSITIONS)) {
      throw new TestToolContractError(
        'test-tool 契约不满足：protocol-model 未导出 TRANSITIONS 转移表（用例无法映射）',
      );
    }

    const meta = readJson<{ files?: string[]; generatedAt?: string }>(join(toolDir, 'meta.json'));
    return {
      executor: executor as unknown as TestToolModule['executor'],
      model: {
        TRANSITIONS: model.TRANSITIONS as Array<{ id: string; action: string; from: string[]; to: string }>,
      },
      scenarioLoader,
      consistencyAsserter,
      toolFiles: meta?.files ?? TEST_TOOL_FILES.map((n) => `derived/test-tool/${n}`),
      generatedAt: meta?.generatedAt,
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
