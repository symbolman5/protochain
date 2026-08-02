/**
 * 实现完整性检查器 —— 步骤⑧（代码确定性执行，无 AI）
 *
 * 设计依据：《协议驱动自验证工具链设计方案》implcheck 模块、AI参与矩阵
 *
 * 职责：
 * 校验实现侧是否提供了规格（⑤产出）中声明的所有接口。
 *
 * 检查策略：
 * - 默认策略（structural）：扫描 impl-scaffold/interfaces.d.ts 与实现文件，
 *   检查规格中声明的接口名是否在实现中存在
 * - 不执行实现代码，仅做静态结构检查
 * - 检查每个 InterfaceSpec 的 name 是否在实现中找到对应方法
 *
 * 产出：derived/impl-check/impl-check-report.json
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, extname, isAbsolute } from 'node:path';
import type {
  InterfaceSpec,
  ImplCheckReport,
  InterfaceCheck,
} from '../model/types.js';

export interface ImplCheckOptions {
  /** 实现根目录（默认 impl-scaffold/） */
  implDir?: string;
  /** 额外的实现源文件根目录（默认 src/） */
  sourceDirs?: string[];
  /** 实现文件扩展名（默认 .ts/.tsx/.js/.jsx） */
  extensions?: string[];
  /** composition.md 路径（用于加载组合层，跨协议接口检查） */
  compositionPath?: string;
  /** 是否启用跨协议接口检查 */
  checkCrossProtocol?: boolean;
}

/**
 * 检查实现完整性
 *
 * @param specs 接口规格列表（⑤产出）
 * @param rootDir 项目根目录
 * @param options 检查选项
 */
export function checkImplementation(
  specs: InterfaceSpec[],
  rootDir: string,
  options: ImplCheckOptions = {}
): ImplCheckReport {
  const {
    implDir = 'impl-scaffold',
    sourceDirs = ['src', 'impl'],
    extensions = ['.ts', '.tsx', '.js', '.jsx'],
  } = options;

  const checkedAt = new Date().toISOString();
  const interfaceChecks: InterfaceCheck[] = [];

  // 收集所有实现源文件内容
  const implContents: string[] = [];

  // 1. interfaces.d.ts（骨架文件，含接口名声明）
  const scaffoldPath = join(rootDir, implDir, 'interfaces.d.ts');
  if (existsSync(scaffoldPath)) {
    implContents.push(readFileSync(scaffoldPath, 'utf-8'));
  }

  // 2. 扫描 sourceDirs 下所有源文件（绝对路径直接用，相对路径相对 rootDir）
  for (const srcDir of sourceDirs) {
    const fullPath = isAbsolute(srcDir) ? srcDir : join(rootDir, srcDir);
    if (existsSync(fullPath)) {
      collectSourceFiles(fullPath, extensions, implContents);
    }
  }

  // 合并实现文本（用于接口名搜索）
  const implText = implContents.join('\n');

  // 对每个规格接口做存在性检查
  for (const spec of specs) {
    const found = isInterfaceImplemented(spec, implText, implContents);
    const check: InterfaceCheck = {
      interfaceId: spec.id,
      interfaceName: spec.name,
      found,
    };
    if (!found) {
      check.missingReason = `未在实现中找到接口 "${spec.name}"（规格 ID: ${spec.id}）`;
    }
    interfaceChecks.push(check);
  }

  // 观测接口存在性检查（kind === 'observation'）
  const observationInterfaceChecks: InterfaceCheck[] = [];
  for (const spec of specs) {
    if (spec.kind === 'observation') {
      const found = isInterfaceImplemented(spec, implText, implContents);
      const check: InterfaceCheck = {
        interfaceId: spec.id,
        interfaceName: spec.name,
        found,
      };
      if (!found) {
        check.missingReason = `未在实现中找到观测接口 "${spec.name}"（规格 ID: ${spec.id}）`;
      }
      observationInterfaceChecks.push(check);
    }
  }

  // 资源池观测接口存在性检查（observesResourcePoolId 标记的接口）
  const resourcePoolChecks: InterfaceCheck[] = [];
  for (const spec of specs) {
    if (spec.observesResourcePoolId) {
      const found = isInterfaceImplemented(spec, implText, implContents);
      const check: InterfaceCheck = {
        interfaceId: spec.id,
        interfaceName: spec.name,
        found,
      };
      if (!found) {
        check.missingReason = `未在实现中找到资源池观测接口 "${spec.name}"（资源池 ID: ${spec.observesResourcePoolId}）`;
      }
      resourcePoolChecks.push(check);
    }
  }

  // 跨协议接口检查（启用时检查 composition.md 中声明的观测接口）
  let crossProtocolInterfaceChecks: InterfaceCheck[] | undefined;
  if (options.checkCrossProtocol && options.compositionPath) {
    crossProtocolInterfaceChecks = [];
    const compPath = join(rootDir, options.compositionPath);
    if (existsSync(compPath)) {
      const compContent = readFileSync(compPath, 'utf-8');
      // 从 composition.md 中提取观测接口名（ObservationInterfaceDef 的 name 字段）
      const obsNameRegex = /(?:\*\*名称\*\*|name[:\s]+)[`]?([a-zA-Z_]\w*)[`]?/gm;
      const implTextLower = implText.toLowerCase();
      let obsMatch: RegExpExecArray | null;
      while ((obsMatch = obsNameRegex.exec(compContent)) !== null) {
        const obsName = obsMatch[1];
        const foundInImpl = implTextLower.includes(obsName.toLowerCase());
        crossProtocolInterfaceChecks.push({
          interfaceId: `composition:${obsName}`,
          interfaceName: obsName,
          found: foundInImpl,
          ...(foundInImpl ? {} : { missingReason: `未在实现中找到组合层观测接口 "${obsName}"` }),
        });
      }
    }
  }

  const allChecks = [
    ...interfaceChecks,
    ...observationInterfaceChecks,
    ...resourcePoolChecks,
  ];
  const passed = allChecks.every((c) => c.found);

  return {
    passed,
    interfaceChecks,
    checkedAt,
    observationInterfaceChecks: observationInterfaceChecks.length > 0 ? observationInterfaceChecks : undefined,
    resourcePoolInterfaceChecks: resourcePoolChecks.length > 0 ? resourcePoolChecks : undefined,
    crossProtocolInterfaceChecks,
  } as ImplCheckReport;
}

// ============================================================================
// 实现文件收集
// ============================================================================

function collectSourceFiles(
  dir: string,
  extensions: string[],
  out: string[]
): void {
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      // 跳过 node_modules / dist / .git
      if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
      collectSourceFiles(fullPath, extensions, out);
    } else if (extensions.includes(extname(entry))) {
      // 跳过自动生成的测试工具代码（避免自证）
      if (fullPath.includes('derived/test-tool')) continue;
      try {
        out.push(readFileSync(fullPath, 'utf-8'));
      } catch {
        // 读取失败忽略
      }
    }
  }
}

// ============================================================================
// 接口存在性检查
// ============================================================================

/**
 * 判断规格接口是否在实现中存在
 *
 * 启发式规则：
 * 1. 接口名作为方法名出现：`<name>(` 或 `<name>:` 或 `<name> =`
 * 2. 接口名作为对象属性：`<name>:` 或 `<name> :`
 * 3. 接口名作为函数声明：`function <name>` 或 `async function <name>`
 * 4. 接口名作为箭头函数：`<name> = (` 或 `<name> = async`
 *
 * 注：这是结构性检查，不验证实现语义。语义正确性由 ⑩ 一致性验证负责。
 */
function isInterfaceImplemented(
  spec: InterfaceSpec,
  implText: string,
  implFiles: string[]
): boolean {
  const name = spec.name;
  if (!name) return false;

  // 转义正则特殊字符
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // 多种出现形式的正则模式
  const patterns: RegExp[] = [
    // 函数声明：function name / async function name
    new RegExp(`\\bfunction\\s+${escaped}\\b`),
    new RegExp(`\\basync\\s+function\\s+${escaped}\\b`),
    // 方法/属性：name( / name: / name = / name;
    new RegExp(`\\b${escaped}\\s*\\(`),
    new RegExp(`\\b${escaped}\\s*\\:`),
    new RegExp(`\\b${escaped}\\s*\\=`),
    // 类方法
    new RegExp(`\\b${escaped}\\s*\\([^)]*\\)\\s*\\{`),
    // 接口定义（interfaces.d.ts 中）：interface Name 或 name:
    new RegExp(`\\binterface\\s+${pascalCase(name)}\\b`),
  ];

  for (const pattern of patterns) {
    if (pattern.test(implText)) {
      return true;
    }
  }

  // 额外检查：在 interfaces.d.ts 中作为属性出现
  // （如 `submit: Submit;`）
  const pascalName = pascalCase(name);
  const pascalEscaped = pascalName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const interfaceDefPattern = new RegExp(`\\b${escaped}\\s*:\\s*${pascalEscaped}\\b`);
  if (interfaceDefPattern.test(implText)) {
    return true;
  }

  return false;
}

function pascalCase(s: string): string {
  return s
    .split(/[_\s-]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

// ============================================================================
// 报告摘要
// ============================================================================

export function formatImplCheckSummary(report: ImplCheckReport & {
  observationInterfaceChecks?: InterfaceCheck[];
  resourcePoolInterfaceChecks?: InterfaceCheck[];
  crossProtocolInterfaceChecks?: InterfaceCheck[];
}): string {
  const lines: string[] = [
    `实现完整性检查：${report.passed ? '✓ 通过' : '✗ 未通过'}`,
    `  检查接口数: ${report.interfaceChecks.length}`,
    `  通过: ${report.interfaceChecks.filter((c) => c.found).length}`,
    `  缺失: ${report.interfaceChecks.filter((c) => !c.found).length}`,
  ];

  const missing = report.interfaceChecks.filter((c) => !c.found);
  if (missing.length > 0) {
    lines.push('  缺失接口：');
    for (const m of missing.slice(0, 10)) {
      lines.push(`    - [${m.interfaceId}] ${m.interfaceName}`);
    }
    if (missing.length > 10) {
      lines.push(`    ... 还有 ${missing.length - 10} 个`);
    }
  }

  // 观测接口检查摘要
  if (report.observationInterfaceChecks && report.observationInterfaceChecks.length > 0) {
    const obsPassed = report.observationInterfaceChecks.filter((c) => c.found).length;
    const obsMissing = report.observationInterfaceChecks.filter((c) => !c.found);
    lines.push(`  观测接口检查: ${obsPassed}/${report.observationInterfaceChecks.length} 通过`);
    if (obsMissing.length > 0) {
      for (const m of obsMissing.slice(0, 5)) {
        lines.push(`    - [${m.interfaceId}] ${m.interfaceName}`);
      }
      if (obsMissing.length > 5) {
        lines.push(`    ... 还有 ${obsMissing.length - 5} 个缺失的观测接口`);
      }
    }
  }

  // 资源池观测接口检查摘要
  if (report.resourcePoolInterfaceChecks && report.resourcePoolInterfaceChecks.length > 0) {
    const rpPassed = report.resourcePoolInterfaceChecks.filter((c) => c.found).length;
    lines.push(`  资源池观测接口检查: ${rpPassed}/${report.resourcePoolInterfaceChecks.length} 通过`);
  }

  // 跨协议接口检查摘要
  if (report.crossProtocolInterfaceChecks && report.crossProtocolInterfaceChecks.length > 0) {
    const cpPassed = report.crossProtocolInterfaceChecks.filter((c) => c.found).length;
    const cpMissing = report.crossProtocolInterfaceChecks.filter((c) => !c.found);
    lines.push(`  跨协议接口检查: ${cpPassed}/${report.crossProtocolInterfaceChecks.length} 通过`);
    if (cpMissing.length > 0) {
      for (const m of cpMissing.slice(0, 5)) {
        lines.push(`    - [${m.interfaceId}] ${m.interfaceName}`);
      }
      if (cpMissing.length > 5) {
        lines.push(`    ... 还有 ${cpMissing.length - 5} 个缺失的跨协议接口`);
      }
    }
  }

  return lines.join('\n');
}
