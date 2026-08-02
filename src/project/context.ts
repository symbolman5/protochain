/**
 * 项目上下文解析
 *
 * 统一"系统根"与"协议定位"两种语义，解决多协议项目下各子协议操作割裂的问题
 * （见 BUGS.md BUG-001/BUG-002）：
 *
 * - 配置：从 --dir 向上查找 protochain.config.yaml（systemRoot）
 * - 模型：单协议 protocol/model.md；多协议 protocol/<Pn>/model.md
 * - 产物/状态：协议根（protocolRoot）下的 derived/，子协议为 protocol/<Pn>/derived
 *
 * 子协议可作为独立协议单元操作：对 protocolRoot 运行完整十步流程，
 * 产物落在 protocol/<Pn>/derived，组合层命令从同路径读取，天然闭环。
 */

import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const CONFIG_FILE = 'protochain.config.yaml';
export const COMPOSITION_FILE = 'protocol/composition.md';

/** 向上查找的最大层数（防止无配置时无限回溯） */
const MAX_ANCESTOR_DEPTH = 10;

export interface ProjectContext {
  /** 系统根（含 protochain.config.yaml 与 protocol/ 的目录） */
  systemRoot: string;
  /** single：单协议项目；multi：多协议系统 */
  mode: 'single' | 'multi';
  /** multi 模式下命中的子协议（如 P1） */
  protocolId?: string;
  /** 本次操作的协议根（single 为 systemRoot；multi 为 systemRoot/protocol/<Pn>） */
  protocolRoot: string;
  /** protochain.config.yaml 绝对路径（恒为 systemRoot 下） */
  configPath: string;
  /** 本次操作的协议模型 */
  modelPath: string;
  /** 派生产物根（协议根下 derived） */
  derivedDir: string;
  /** 版本快照目录（相对 protocolRoot） */
  versionsDir: string;
}

export type ContextRole = 'protocol' | 'composition';

export interface ResolveOptions {
  /** 多协议项目中指定子协议（如 P1） */
  protocol?: string;
  /** protocol：单协议命令（multi 下需 --protocol）；composition：组合层命令（作用于系统根） */
  role?: ContextRole;
}

/**
 * 从 startDir 向上查找 protochain.config.yaml，返回其绝对路径。
 * 找不到返回 undefined。
 */
export function findConfigPath(startDir: string): string | undefined {
  let dir = resolve(startDir);
  for (let i = 0; i <= MAX_ANCESTOR_DEPTH; i++) {
    const candidate = join(dir, CONFIG_FILE);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break; // 到达文件系统根
    dir = parent;
  }
  return undefined;
}

/**
 * 解析项目上下文。
 *
 * - 单协议：protocolRoot = systemRoot，modelPath = systemRoot/protocol/model.md
 * - 多协议：需 --protocol <Pn>；兼容旧用法 --dir protocol/<Pn>（自动识别子协议目录）
 * - 组合层命令（role='composition'）：始终作用于系统根
 */
export function resolveProjectContext(
  dirArg: string,
  opts: ResolveOptions = {}
): ProjectContext {
  const role = opts.role ?? 'protocol';
  const absDir = resolve(dirArg);

  const configPath = findConfigPath(absDir);
  if (!configPath) {
    throw new Error(
      `无法定位项目根：在 ${absDir} 及向上 ${MAX_ANCESTOR_DEPTH} 层未找到 ${CONFIG_FILE}。` +
        `请先运行 protochain init / init-multi 初始化项目。`
    );
  }
  const systemRoot = dirname(configPath);
  const compositionPath = join(systemRoot, COMPOSITION_FILE);
  const isMulti = existsSync(compositionPath);

  // 组合层命令：作用于系统根
  if (role === 'composition') {
    return {
      systemRoot,
      mode: isMulti ? 'multi' : 'single',
      protocolRoot: systemRoot,
      configPath,
      modelPath: compositionPath,
      derivedDir: join(systemRoot, 'derived'),
      versionsDir: 'protocol/versions',
    };
  }

  // 单协议：协议根 = 系统根
  if (!isMulti) {
    return {
      systemRoot,
      mode: 'single',
      protocolRoot: systemRoot,
      configPath,
      modelPath: join(systemRoot, 'protocol/model.md'),
      derivedDir: join(systemRoot, 'derived'),
      versionsDir: 'protocol/versions',
    };
  }

  // 多协议：定位子协议
  let protocolId = opts.protocol;
  let protocolRoot: string;
  if (protocolId) {
    protocolRoot = join(systemRoot, 'protocol', protocolId);
  } else {
    // 兼容旧用法：--dir 直接指向子协议目录（protocol/<Pn>）
    const subDir = join(systemRoot, 'protocol');
    const matched = readdirSync(subDir).find(
      (entry) => resolve(join(subDir, entry)) === absDir
    );
    if (matched) {
      protocolId = matched;
      protocolRoot = absDir;
    } else {
      const available = readdirSync(subDir)
        .filter((entry) => existsSync(join(subDir, entry, 'model.md')))
        .join(', ');
      throw new Error(
        `多协议项目需通过 --protocol <Pn> 指定子协议，例如：\n` +
          `  protochain check --dir ${systemRoot} --protocol P1\n` +
          `可用子协议：${available || '（protocol/ 下未找到含 model.md 的子协议目录）'}\n` +
          `组合层操作用 check-composition / check-cross-invariants 等命令。`
      );
    }
  }

  const modelPath = join(protocolRoot, 'model.md');
  if (!existsSync(modelPath)) {
    throw new Error(
      `子协议模型不存在：${modelPath}（可用子协议见 protocol/ 目录）`
    );
  }

  return {
    systemRoot,
    mode: 'multi',
    protocolId,
    protocolRoot,
    configPath,
    modelPath,
    derivedDir: join(protocolRoot, 'derived'),
    versionsDir: 'versions',
  };
}
