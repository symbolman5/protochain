/**
 * 接口骨架生成器 —— init 模板生成 + ⑨接口骨架生成
 *
 * 设计依据：《协议驱动自验证工具链设计方案》scaffolder 模块、产出物目录约定
 *
 * 职责：
 * 1. init 生成协议项目骨架：protocol/model.md 模板 + protocol/scenarios/ + protochain.config.yaml
 * 2. ⑨ 从接口规格生成实现类型骨架（interfaces.d.ts），供开发者填充实现逻辑
 *
 * ⑨实现编码本身不在工具链范围内，scaffolder 仅生成类型定义骨架。
 */

import { copyFileSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep, dirname } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import Ajv from 'ajv';
import type { InterfaceSpec, ProtochainConfig, BindingConfig } from '../model/types.js';

// ============================================================================
// init：生成协议项目骨架
// ============================================================================

export interface InitOptions {
  /** 协议名称 */
  name: string;
  /** 目标根目录 */
  rootDir: string;
  /** 是否覆盖已存在的文件 */
  force?: boolean;
}

export interface InitResult {
  createdFiles: string[];
  createdDirs: string[];
}

// ============================================================================
// init-multi：生成多协议系统骨架（组合层 + 各子协议骨架）
// ============================================================================

export interface MultiInitOptions {
  /** 系统名称 */
  systemName: string;
  /** 目标根目录 */
  rootDir: string;
  /** 子协议列表（protocolId 与 name） */
  protocols: { protocolId: string; name: string }[];
  /** 是否覆盖已存在文件 */
  force?: boolean;
}

export interface MultiInitResult {
  createdFiles: string[];
  createdDirs: string[];
}

/**
 * 生成多协议系统骨架：
 * - protocol/composition.md（组合层模板）
 * - protocol/<Pn>/model.md（各子协议模板，复用 initProject）
 * - protocol/<Pn>/derived/（各子协议派生产物目录）
 * - derived/composition/（组合层派生产物目录）
 */
export function initMultiProject(options: MultiInitOptions): MultiInitResult {
  const { systemName, rootDir, protocols, force = false } = options;
  const createdFiles: string[] = [];
  const createdDirs: string[] = [];

  // 组合层目录
  const compositionDerivedDir = join(rootDir, 'derived/composition');
  if (!existsSync(compositionDerivedDir)) {
    mkdirSync(compositionDerivedDir, { recursive: true });
    createdDirs.push('derived/composition');
  }

  // protocol/ 根目录（确保存在，否则 composition.md 写入失败）
  const protocolDir = join(rootDir, 'protocol');
  if (!existsSync(protocolDir)) {
    mkdirSync(protocolDir, { recursive: true });
    createdDirs.push('protocol');
  }

  // protocol/composition.md（组合层模板）
  const compositionPath = join(rootDir, 'protocol/composition.md');
  if (!existsSync(compositionPath) || force) {
    writeFileSync(
      compositionPath,
      generateCompositionTemplate(systemName, protocols),
      'utf-8'
    );
    createdFiles.push('protocol/composition.md');
  }

  // 各子协议骨架
  for (const p of protocols) {
    const subDir = join(rootDir, `protocol/${p.protocolId}`);
    if (!existsSync(subDir)) {
      mkdirSync(subDir, { recursive: true });
      createdDirs.push(`protocol/${p.protocolId}`);
    }
    const subModelPath = join(subDir, 'model.md');
    if (!existsSync(subModelPath) || force) {
      writeFileSync(subModelPath, generateModelTemplate(p.name), 'utf-8');
      createdFiles.push(`protocol/${p.protocolId}/model.md`);
    }
    // 子协议派生产物目录
    const subDerivedDir = join(subDir, 'derived');
    if (!existsSync(subDerivedDir)) {
      mkdirSync(subDerivedDir, { recursive: true });
      createdDirs.push(`protocol/${p.protocolId}/derived`);
    }
    // 子协议 scenarios 目录
    const subScenariosDir = join(subDir, 'scenarios');
    if (!existsSync(subScenariosDir)) {
      mkdirSync(subScenariosDir, { recursive: true });
      createdDirs.push(`protocol/${p.protocolId}/scenarios`);
    }
  }

  // 根配置文件
  const configPath = join(rootDir, 'protochain.config.yaml');
  if (!existsSync(configPath) || force) {
    writeFileSync(configPath, generateConfigTemplate(systemName), 'utf-8');
    createdFiles.push('protochain.config.yaml');
  }

  return { createdFiles, createdDirs };
}

/** 组合层 composition.md 模板（3.2.1 段落骨架） */
function generateCompositionTemplate(
  systemName: string,
  protocols: { protocolId: string; name: string }[]
): string {
  const subProtocolYaml = protocols
    .map(
      (p) =>
        `  - protocolId: ${p.protocolId}\n    name: ${p.name}\n    version: 0.1.0\n    modelPath: protocol/${p.protocolId}/model.md`
    )
    .join('\n');

  return `# 系统元数据

\`\`\`yaml
systemName: ${systemName}
version: 0.1.0
changeType: protocol_tweak
\`\`\`

# 子协议清单

\`\`\`yaml
${subProtocolYaml}
\`\`\`

# 依赖图

\`\`\`mermaid
graph LR
${protocols.map((p) => `  ${p.protocolId}[${p.name}]`).join('\n')}
\`\`\`

\`\`\`yaml
# edges（结构化依赖关系，工具消费权威源；Mermaid 仅供人读）
# - from: P1
#   to: P2
#   dependencyType: state  # state | event
#   description: TODO 描述依赖关系
\`\`\`

# 跨协议不变量

<!-- 每条不变量一个 ### 标题 + YAML 代码块 -->
<!-- ### <id>: <name>
\`\`\`yaml
id: CI1
name: TODO 跨协议不变量名称
span: [${protocols.map((p) => p.protocolId).join(', ')}]
expression: TODO 跨协议不变量表达式
declaredBy: TODO 共识方角色ID
checkMethod: TODO 检查方法
complexity: simple_boolean  # simple_boolean | first_order
\`\`\`
-->

# 跨协议时序

<!-- ### <id>: <name>
\`\`\`yaml
id: CT1
name: TODO 跨协议时序名称
rule: TODO 时序规则
span: [P1, P2]
boundMs: 0
\`\`\`
-->

# 外部依赖

<!-- ### <system>: <name>
\`\`\`yaml
system: TODO 外部系统名
direction: event_sync  # event_sync | login_receipt | query
protocol: TODO 关联子协议ID
syncSemantics: TODO 同步语义
syncCharacteristics: []
compensation: []
impactOnFailure: TODO 失败影响
# queryObservationInterfaceId: OI1  # direction=query 时必填
\`\`\`
-->

# 观测接口

<!-- ### <id>: <name>
\`\`\`yaml
id: OI1
name: TODO 观测接口名称
observer: TODO 观测方
scope: TODO 观测范围
permissionBoundary: TODO 权限边界
readOnly: true
observable:
  - protocol: P1
    object: TODO 实体ID
    fields: [TODO 字段]
    filter: TODO 可选过滤条件
\`\`\`
-->

# 对象状态切面

<!-- ### <object>: <name>
\`\`\`yaml
object: TODO 对象名
idKey: TODO 主键字段
facets:
  - protocol: P1
    dimensions: [TODO 维度]
    description: TODO 切面描述
crossFacetConstraints:
  - expression: TODO 跨切面约束表达式
    tracesToInvariantId: CI1  # 必须指向已声明的跨协议不变量ID
\`\`\`
-->

# 安全前提

<!-- ### <id>: <name>
\`\`\`yaml
id: SA1
assumption: TODO 安全假设
description: TODO 假设描述
impactIfViolated: TODO 违反时的影响
\`\`\`
-->
`;
}

export function initProject(options: InitOptions): InitResult {
  const { name, rootDir, force = false } = options;
  const createdFiles: string[] = [];
  const createdDirs: string[] = [];

  const dirs = [
    'protocol',
    'protocol/scenarios',
    'protocol/versions',
    'derived',
    'derived/formal',
    'derived/test-tool',
    'derived/test-cases/paths',
    'derived/impl-check',
    'derived/verification',
    'impl-scaffold',
    'diff',
  ];

  for (const dir of dirs) {
    const fullPath = join(rootDir, dir);
    if (!existsSync(fullPath)) {
      mkdirSync(fullPath, { recursive: true });
      createdDirs.push(dir);
    }
  }

  // protocol/model.md —— 协议模型模板（三层 Markdown）
  const modelPath = join(rootDir, 'protocol/model.md');
  if (!existsSync(modelPath) || force) {
    writeFileSync(modelPath, generateModelTemplate(name), 'utf-8');
    createdFiles.push('protocol/model.md');
  }

  // protocol/scenarios/SC1.yaml —— 场景示例（输入侧，使用方提供）
  const scenarioPath = join(rootDir, 'protocol/scenarios/SC1.yaml');
  if (!existsSync(scenarioPath) || force) {
    writeFileSync(scenarioPath, generateScenarioTemplate(), 'utf-8');
    createdFiles.push('protocol/scenarios/SC1.yaml');
  }

  // protochain.config.yaml —— 配置文件
  const configPath = join(rootDir, 'protochain.config.yaml');
  if (!existsSync(configPath) || force) {
    writeFileSync(configPath, generateConfigTemplate(name), 'utf-8');
    createdFiles.push('protochain.config.yaml');
  }

  // .gitkeep 占位，确保空目录被 git 跟踪
  for (const keepDir of ['derived/formal', 'derived/test-cases/paths', 'diff', 'protocol/versions']) {
    const keepPath = join(rootDir, keepDir, '.gitkeep');
    if (!existsSync(keepPath)) {
      writeFileSync(keepPath, '', 'utf-8');
    }
  }

  return { createdFiles, createdDirs };
}

function generateModelTemplate(name: string): string {
  return `---
name: ${name}
version: 0.1.0
purpose: TODO 描述协议意图——该协议解决什么协作问题，达成什么目标
roles:
  - id: roleA
    name: 角色A
    responsibilities: TODO 角色A的职责
  - id: roleB
    name: 角色B
    responsibilities: TODO 角色B的职责
---

# 背景

TODO 描述协议背景与目标：当前协作存在什么问题，为何需要此协议。

# 核心概念

- **概念1**: TODO 定义
- **概念2**: TODO 定义

# 协作流程

TODO 用自然语言描述端到端协作流程：谁在何时做什么，信息如何流转。

# 异常处理原则

TODO 描述异常处理原则。

# 状态空间

| ID | 名称 | 类型 | 描述 | 角色 |
|---|---|---|---|---|
| S1 | 初始态 | initial | TODO | roleA |
| S2 | 处理中 | normal | TODO | roleB |
| S3 | 完成 | terminal | TODO | |

# 转移规则

| ID | 名称 | from | to | action | trigger | guard | effects |
|---|---|---|---|---|---|---|---|
| T1 | TODO动作 | S1 | S2 | doSomething | roleA | TODO守卫 | TODO副作用 |

# 不变量

| ID | 名称 | 表达式 | 作用状态 | 描述 |
|---|---|---|---|---|
| INV1 | TODO不变量 | forall x: x > 0 | | TODO 语义说明 |

# 时序约束

| ID | 名称 | 类型 | 源 | 目标 | 约束值(ms) | 描述 |
|---|---|---|---|---|---|---|
| TM1 | TODO时序 | response | doSomething | S3 | 86400000 | 24小时响应 |

# 异常路径

| ID | 名称 | 触发 | 转移序列 | 恢复策略 |
|---|---|---|---|---|
| EX1 | TODO异常 | TODO触发条件 | T1 | TODO恢复策略 |

# 契约层

\`\`\`yaml
parties:
  - roleA
  - roleB
expectedInformationFields:
  - TODO字段
\`\`\`
`;
}

function generateScenarioTemplate(): string {
  return `# 场景 SC1
# 使用方提供的场景（输入侧），用于 ⑦测试用例生成 与 ⑩一致性验证
# 工具链不修改此文件，由使用方维护

id: SC1
name: TODO 场景名称
description: TODO 场景描述

# 初始运行时参数（供 ⑩ verify 使用，优先级最高，不被动作响应注入覆盖；
# 按 expectedActions 与测试路径的动作序列匹配）
params:
  TODO: 参数值

# 场景初始事实（覆盖协议初始状态的额外约束）
initialFacts:
  - TODO: 事实值

# 期望的协议路径（动作序列，须与测试路径的动作一致才能命中）
expectedActions:
  - doSomething

# 期望最终状态
expectedFinalState: S3
`;
}

function generateConfigTemplate(name: string): string {
  const config: ProtochainConfig = {
    name,
    ai: {
      provider: 'local',
    },
    formalTool: 'auto',
    coverage: {
      criterion: 'state',
      maxPathLength: 6,
    },
  };
  return `# protochain 配置文件\n${stringifyYaml(config)}`;
}

// ============================================================================
// ⑨ 从接口规格生成实现类型骨架
// ============================================================================

export interface ScaffoldInterfacesOptions {
  /** 接口规格列表 */
  specs: InterfaceSpec[];
  /** 输出文件路径（默认 impl-scaffold/interfaces.d.ts） */
  outputPath?: string;
  /**
   * E5：impl 语言（目前仅 'ts'）。指定时除 interfaces.d.ts 外额外生成
   *   clients/{http,kafka,nsq}.ts；方法名与 bindings.yaml 的 action 100% 对齐。
   */
  lang?: 'ts' | 'go' | 'java';
  /**
   * E5：bindings 配置（用于生成 http/kafka/nsq client）；
   *   缺省时跳过 client 生成（保留旧行为）。
   */
  bindings?: BindingConfig;
  /**
   * E5：client 文件输出根目录（默认 <rootDir>/impl-scaffold/clients/）。
   * 当指定为绝对路径时直接使用。
   */
  clientsOutputDir?: string;
  /** E5：协议名/版本（写入模板头部注释） */
  protocolName?: string;
  protocolVersion?: string;
}

export function scaffoldInterfaces(options: ScaffoldInterfacesOptions): string {
  const code = generateInterfaceTypes(options.specs);
  const outputPath = options.outputPath ?? 'impl-scaffold/interfaces.d.ts';
  if (outputPath) {
    const dir = outputPath.substring(0, outputPath.lastIndexOf('/'));
    if (dir && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(outputPath, code, 'utf-8');
  }

  // ── E5：--lang=ts → 额外生成 transport clients ──
  if (options.lang === 'ts') {
    const tsClients = generateTsClients({
      specs: options.specs,
      bindings: options.bindings,
      protocolName: options.protocolName ?? '(unnamed)',
      protocolVersion: options.protocolVersion ?? '0.0.0',
    });
    const baseDir = options.clientsOutputDir
      ? options.clientsOutputDir
      : outputPath
        ? dirname(outputPath) + '/clients'
        : 'impl-scaffold/clients';
    if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true });
    for (const [name, content] of Object.entries(tsClients)) {
      writeFileSync(join(baseDir, name), content, 'utf-8');
    }
  }

  return code;
}

/**
 * E5：生成 TS transport 客户端（http/kafka/nsq 三传输）。
 *
 * 关键红线：
 *  - 方法名 = bindings.yaml `interfaces[].action`（100% 一致）；
 *  - http/kafka/nsq 三个文件覆盖范围（http 必有；kafka/nsq 仅当 bindings 出现对应
 *    transport 类型才生成）；
 *  - 模板相对路径从此文件所在目录解析（编译后位置变化不影响）。
 */
export function generateTsClients(opts: {
  specs: InterfaceSpec[];
  bindings: BindingConfig | undefined;
  protocolName: string;
  protocolVersion: string;
}): Record<string, string> {
  const out: Record<string, string> = {};
  if (!opts.bindings) return out;

  // 模板目录：源码内 templates/ts/，相对 __dirname（CLI 编译产物 dist/scaffolder/）
  //   调试态：src/scaffolder/templates/ts
  //   生产态：dist/scaffolder/templates/ts（tsc 不复制资源，需 build 时同步；
  //           此处用候选解析，缺失则抛清晰错误）
  const templateDir = resolveTemplatesDir();

  const replace: Array<[RegExp, string]> = [
    [/\{PROTOCOL_NAME\}/g, opts.protocolName],
    [/\{PROTOCOL_VERSION\}/g, opts.protocolVersion],
  ];

  // 1) http.ts：所有 http 类型的 binding
  const httpBindings = opts.bindings.interfaces.filter(
    (b) => (b.transport as { type?: string } | undefined)?.type === 'http'
  );
  if (httpBindings.length > 0) {
    const tpl = readTemplate(templateDir, 'http.ts.tmpl');
    out['http.ts'] = applyTemplate(tpl, replace);
  }

  // 2) kafka.ts
  const kafkaBindings = opts.bindings.interfaces.filter(
    (b) => (b.transport as { type?: string } | undefined)?.type === 'kafka'
  );
  if (kafkaBindings.length > 0) {
    const tpl = readTemplate(templateDir, 'kafka.ts.tmpl');
    out['kafka.ts'] = applyTemplate(tpl, replace);
  }

  // 3) nsq.ts
  const nsqBindings = opts.bindings.interfaces.filter(
    (b) => (b.transport as { type?: string } | undefined)?.type === 'nsq'
  );
  if (nsqBindings.length > 0) {
    const tpl = readTemplate(templateDir, 'nsq.ts.tmpl');
    out['nsq.ts'] = applyTemplate(tpl, replace);
  }

  return out;
}

/** 模板目录解析：src/templates/ 或 dist/templates/ 双候选。
 * 与 instanceTemplateDir 同款守卫（typeof __dirname），避免 import.meta 在 CJS 转换上下文不可用 */
function resolveTemplatesDir(): string {
  const candidates: string[] = [
    typeof __dirname !== 'undefined' ? join(__dirname, 'templates', 'ts') : '',
    join(process.cwd(), 'src', 'scaffolder', 'templates', 'ts'),
  ].filter((s) => s.length > 0);
  for (const c of candidates) {
    if (existsSync(join(c, 'http.ts.tmpl'))) return c;
  }
  throw new Error(
    `E5 模板目录未找到（已查 ${ candidates.join(' / ') }）。请确保 src/scaffolder/templates/ts/ 存在且 http.ts.tmpl/kafka.ts.tmpl/nsq.ts.tmpl 三个文件齐备。`
  );
}

function readTemplate(dir: string, name: string): string {
  const path = join(dir, name);
  if (!existsSync(path)) {
    throw new Error(`E5 模板缺失: ${path}`);
  }
  return readFileSync(path, 'utf-8');
}

function applyTemplate(tpl: string, replace: Array<[RegExp, string]>): string {
  let out = tpl;
  for (const [re, v] of replace) out = out.replace(re, v);
  return out;
}

function generateInterfaceTypes(specs: InterfaceSpec[]): string {
  const lines: string[] = [
    '/**',
    ' * 接口实现类型骨架（自动生成，请勿手动编辑）',
    ' * 来源：derived/specs/interface-specs.yaml',
    ' * 开发者在此填充实现逻辑；⑨实现编码本身不在工具链范围内',
    ' */',
    '',
  ];

  // T2a（X17/P1-9，判据 M11）：guard 可执行化——受限谓词（json-schema + ajv 可编译）
  // 命中 → 标注校验调用可生成 + 谓词体待填；未命中 → 显式降级标注（不静默）。
  const ajv = new Ajv({ allErrors: true, strict: false });
  for (const spec of specs) {
    lines.push(`// ${spec.kind === 'system' ? '系统接口' : '观测接口'}: ${spec.name}`);
    if (spec.precondition) {
      lines.push(`// 前置条件: ${spec.precondition}`);
    }
    const pre = spec.preconditions ?? [];
    if (pre.length > 0) {
      const allStructured = pre.every((p) => p.kind === 'json-schema' && p.schema != null);
      if (allStructured) {
        let compileOk = true;
        for (const p of pre) {
          try {
            ajv.compile(p.schema as object);
          } catch {
            compileOk = false;
            break;
          }
        }
        if (compileOk) {
          lines.push(
            `// [T2a] guard 可执行化（M11 命中）：${pre.length} 条 json-schema 谓词全部可被 ajv 编译 → 校验调用可生成，谓词体待填实现`
          );
        } else {
          lines.push(
            `// [T2a] guard 部分谓词不可被 ajv 编译（M11 未命中）→ 显式降级：校验调用不可机械生成，谓词体留 TODO（schemaDegradedReasons 已记录）`
          );
        }
      } else {
        const bad = pre.find((p) => p.kind !== 'json-schema' || p.schema == null);
        lines.push(
          `// [T2a] guard 未可执行化（M11 未命中，显式降级）：谓词 ${bad?.kind ?? 'invalid'}「${bad?.description ?? ''}」未按受限谓词语法书写，不可机械校验；谓词体留 TODO（schemaDegradedReasons 已记录）`
        );
      }
    }
    if (spec.postconditions && spec.postconditions.length > 0) {
      lines.push(`// 后置条件:`);
      for (const pc of spec.postconditions) {
        lines.push(`//   - ${pc}`);
      }
    }

    const inputParams = spec.inputs.map(fieldToTsParam).join(', ');
    const returnType = spec.outputs.length === 0
      ? 'void'
      : spec.outputs.length === 1
        ? tsType(spec.outputs[0].type)
        : `{ ${spec.outputs.map((o) => `${o.name}: ${tsType(o.type)}`).join('; ')} }`;

    lines.push(
      `export interface ${pascalCase(spec.name)} {`,
      `  (${inputParams}): ${returnType} | Promise<${returnType}>;`,
      `}`
    );
    lines.push('');
  }

  // 汇总接口集合
  lines.push('// 实现需提供的接口集合（⑧实现完整性检查按此清单校验）');
  lines.push('export interface ProtocolImplementation {');
  for (const spec of specs) {
    lines.push(`  ${spec.name}: ${pascalCase(spec.name)};`);
  }
  lines.push('}');

  return lines.join('\n');
}

function fieldToTsParam(field: { name: string; type: string; required?: boolean }): string {
  const optional = field.required === false ? '?' : '';
  return `${field.name}${optional}: ${tsType(field.type)}`;
}

function tsType(type: string): string {
  const lower = type.toLowerCase();
  if (lower === 'string' || lower === '文本') return 'string';
  if (lower === 'number' || lower === '数值' || lower === '数字') return 'number';
  if (lower === 'boolean' || lower === '布尔') return 'boolean';
  if (lower === 'void' || lower === '无') return 'void';
  return type;
}

function pascalCase(s: string): string {
  return s
    .split(/[_\s-]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

// ============================================================================
// init-runner：初始化协议建模工程 + protocol-runner 编排实例（协议建模驱动开发完整起步）
// 实例模板位于 templates/protocol-runner-instance（可移植：相对路径、工具走 PATH、自带手册文档）
// ============================================================================

export interface InitRunnerOptions {
  /** 系统名称 */
  systemName: string;
  /** 子协议列表 */
  protocols: { protocolId: string; name: string }[];
  /** 项目根目录（建模目录 = rootDir/modelingDir） */
  rootDir: string;
  /** 建模目录（相对项目根，默认 modeling） */
  modelingDir?: string;
  /** 实现目录（相对项目根，默认 impl） */
  implDir?: string;
  /** 编排实例目录（相对项目根，默认 protocol-runner） */
  instanceDir?: string;
  /** 是否覆盖已存在的实例 */
  force?: boolean;
  /** 实例模板目录（默认多候选解析；CLI 显式传入） */
  templateDir?: string;
}

export interface InitRunnerResult {
  /** 建模骨架结果（复用 initMultiProject） */
  modeling: MultiInitResult;
  /** 实例内创建目录（相对项目根） */
  createdDirs: string[];
  /** 实例内创建文件（相对项目根） */
  createdFiles: string[];
  /** 模板来源目录 */
  templateDir: string;
}

/** 实例模板绝对路径（多候选解析，避免 import.meta 在 CJS 转换上下文不可用）：
 * 1) 显式传入（InitRunnerOptions.templateDir，CLI 用 import.meta 解析）；2) env 覆盖；
 * 3) cwd/templates；4) 本文件相对路径（__dirname，CJS 可用）。 */
function instanceTemplateDir(): string {
  const candidates: string[] = [
    process.env.PROTOCHAIN_INSTANCE_TEMPLATE || '',
    join(process.cwd(), 'templates', 'protocol-runner-instance'),
    typeof __dirname !== 'undefined' ? join(__dirname, '..', '..', 'templates', 'protocol-runner-instance') : '',
  ].filter((s) => s.length > 0);
  for (const c of candidates) {
    if (existsSync(join(c, 'project.yaml'))) return c;
  }
  return candidates[0] ?? join(process.cwd(), 'templates', 'protocol-runner-instance');
}

/** 递归复制目录，记录相对项目根的路径 */
function copyTree(src: string, dst: string, createdDirs: string[], createdFiles: string[], base: string): void {
  mkdirSync(dst, { recursive: true });
  createdDirs.push(relative(base, dst));
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, e.name);
    const d = join(dst, e.name);
    if (e.isDirectory()) {
      copyTree(s, d, createdDirs, createdFiles, base);
    } else {
      copyFileSync(s, d);
      createdFiles.push(relative(base, d));
    }
  }
}

/** 遍历文本文件并替换占位符 */
function replaceInTree(dir: string, replacements: Array<[RegExp, string]>): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      replaceInTree(p, replacements);
    } else if (/\.(yaml|yml|mjs|js|md|json|env|txt|ts)$/.test(e.name)) {
      const text = readFileSync(p, 'utf8');
      let out = text;
      for (const [re, v] of replacements) out = out.replace(re, v);
      if (out !== text) writeFileSync(p, out, 'utf8');
    }
  }
}

/**
 * 初始化协议建模工程 + protocol-runner 编排实例：
 * 1) 建模骨架（复用 initMultiProject）置于 <root>/<modelingDir>；
 * 2) 确保 protochain.config.yaml 含 bindings（实例 check-real-bind 依赖）；
 * 3) 复制实例模板至 <root>/<instanceDir>（可移植：不含任何工具链源码路径，自带 README 手册）；
 * 4) 替换占位符：{{PROJECT_NAME}}、{{MODELING_DIR}}（相对实例目录）、{{IMPL_DIR}}。
 */
export function initRunnerProject(options: InitRunnerOptions): InitRunnerResult {
  const {
    systemName,
    protocols,
    rootDir,
    modelingDir = 'modeling',
    implDir = 'impl',
    instanceDir = 'protocol-runner',
    force = false,
    templateDir: explicitTemplate,
  } = options;

  // 1) 建模骨架
  const modelingRoot = join(rootDir, modelingDir);
  const modeling = initMultiProject({ systemName, rootDir: modelingRoot, protocols, force });

  // 2) 确保 config 含 bindings（check-real-bind 依赖）
  const configPath = join(modelingRoot, 'protochain.config.yaml');
  if (existsSync(configPath)) {
    const cfg = readFileSync(configPath, 'utf8');
    if (!/^bindings:/m.test(cfg)) {
      writeFileSync(
        configPath,
        cfg + '\nbindings:\n  defaultEnv: dev\n  roles:\n    R-Op: { roleId: R-Op, baseUrl: http://127.0.0.1:8787, auth: bearer }\n  interfaces: []\n',
        'utf8',
      );
    }
  }

  // 3) 复制实例模板
  const templateDir = explicitTemplate ?? instanceTemplateDir();
  const instanceRoot = join(rootDir, instanceDir);
  const createdDirs: string[] = [];
  const createdFiles: string[] = [];
  if (existsSync(instanceRoot) && !force) {
    throw new Error(`实例目录已存在: ${instanceDir}（使用 -f 覆盖）`);
  }
  copyTree(templateDir, instanceRoot, createdDirs, createdFiles, rootDir);

  // 4) 替换占位符（相对路径以实例目录为锚点）
  const relModeling = relative(join(rootDir, instanceDir), join(rootDir, modelingDir)).split(sep).join('/');
  const relImpl = relative(join(rootDir, instanceDir), join(rootDir, implDir)).split(sep).join('/');
  replaceInTree(instanceRoot, [
    [/\{\{PROJECT_NAME\}\}/g, systemName],
    [/\{\{MODELING_DIR\}\}/g, relModeling],
    [/\{\{IMPL_DIR\}\}/g, relImpl],
  ]);

  // 5) 项目根工具环境（启动 protocol-runner 引擎用；实例内部脚本环境见 <instanceDir>/env/dev.env）
  const rootEnvPath = join(rootDir, '.env');
  if (!existsSync(rootEnvPath) || force) {
    writeFileSync(
      rootEnvPath,
      [
        '# 项目根工具环境（启动 protocol-runner 引擎用）',
        '# 留空则用 PATH 中的命令；实例内部脚本环境见 ' + instanceDir + '/env/dev.env',
        'PROTOCOL_RUNNER=protocol-runner   # 或 node /path/to/protocol-runner/dist/runner.js',
        'NODE=',
        'PROTOCHAIN=',
        '',
      ].join('\n'),
      'utf8',
    );
    createdFiles.push('.env');
  }

  // 6.5) 工程级架构文档 + 实现规范占位（工程资产；实例通过相对路径引用）
  const docsDir = join(rootDir, 'docs');
  const archPath = join(docsDir, 'architecture.md');
  if (!existsSync(archPath) || force) {
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(
      archPath,
      [
        '# 架构（实现侧）',
        '',
        '> 工程级技术选型与部署拓扑；具体实现规范见 impl/CONVENTIONS.md。',
        '> 协议语义见 modeling/protocol/*/model.md（与实现解耦）。',
        '',
        '## 技术栈',
        '',
        '- 语言：<Go / …>',
        '- 运行环境：<k8s 集群 / …>',
        '',
        '## 组件',
        '',
        '| 组件 | 职责 | 部署形态 |',
        '|---|---|---|',
        '| <portal（控制面）> | <REST API / 状态机 / 守卫> | <k8s Deployment 多副本> |',
        '| <forward（数据面）> | <端口转发 / 域名路由 / TLS 终止> | <各转发服务器> |',
        '| <存储> | <持久化> | <k8s StatefulSet + PVC> |',
        '',
        '## 部署拓扑',
        '',
        '- Ingress → Service → Pod；组件间连接（如 portal → DB）',
        '- 镜像构建与推送方式',
        '',
        '## 存储与密钥',
        '',
        '- 密钥（JWT_SECRET / DB 口令）→ k8s Secret',
        '- 数据分布（端口/域名/证书等）',
        '',
      ].join('\n'),
      'utf8',
    );
    createdFiles.push('docs/architecture.md');
  }
  const implAssetDir = join(rootDir, 'impl');
  const convPath = join(implAssetDir, 'CONVENTIONS.md');
  if (!existsSync(convPath) || force) {
    mkdirSync(implAssetDir, { recursive: true });
    writeFileSync(
      convPath,
      [
        '# 实现规范（CONVENTIONS）',
        '',
        '> I 实现单元遵循本规范；可机械化的规范已固化为机械检查（scripts/check-mysql-naming.mjs 等），',
        '> 违反 → I 验收失败 → 回退 I。',
        '',
        '## MySQL 命名规范（示例）',
        '',
        '- 表名：snake_case（如 `user_accounts`）',
        '- 索引前缀：唯一索引 `uk_`、普通索引 `idx_`（如 `uk_accounts_username`）',
        '- 字符集：`utf8mb4`；时间列用 `DATETIME`；需要时用 JSON 列并显式标注',
        '- 外键/主键：主键 `id`，外键 `*_id`',
        '',
        '## Go 风格（示例）',
        '',
        '- 目录按职责分包；导出符号有注释；错误处理显式（不吞错）',
        '- 通过 `gofmt` / `go vet` / `golint`',
        '',
        '## 其他约束',
        '',
        '- <按项目补充：目录约定、命名、提交规范等>',
        '',
      ].join('\n'),
      'utf8',
    );
    createdFiles.push('impl/CONVENTIONS.md');
  }

  // 6) 项目根需求变更单（第一个需求的输入落点；M 单元按本单写模型）
  const requirementsDir = join(rootDir, 'requirements');
  const orderPath = join(requirementsDir, 'order.md');
  if (!existsSync(orderPath) || force) {
    mkdirSync(requirementsDir, { recursive: true });
    writeFileSync(
      orderPath,
      [
        '# 变更单（需求输入）',
        '',
        '> 每个需求的输入落点：填写下面的 目标 / 范围 / 验收 / 涉及协议，然后运行',
        '> `source .env && "$PROTOCOL_RUNNER" --project protocol-runner/`，M 单元按本单写模型。',
        '',
        '## 目标',
        '',
        '- 一句话描述：<首个需求，如"设备管理协议：注册/启用/停用/注销">',
        '',
        '## 范围',
        '',
        '- 涉及的子协议：P1（<名称>）',
        '- 本期实现/不实现：<如"本期仅建模与推演；实现与参考实现后置">',
        '',
        '## 验收',
        '',
        '- 推演通过：check → reason（弱活性）→ formalize（TLC）',
        '- 派生产物：specs / contracts / test-cases 生成',
        '- 真实 verify 在参考实现接入后启用',
        '',
        '## 备注',
        '',
        '- <可选：约束、依赖、风险>',
        '',
      ].join('\n'),
      'utf8',
    );
    createdFiles.push('requirements/order.md');
  }

  return { modeling, createdDirs, createdFiles, templateDir };
}
