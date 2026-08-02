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

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type { InterfaceSpec, ProtochainConfig } from '../model/types.js';

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
  return code;
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

  for (const spec of specs) {
    lines.push(`// ${spec.kind === 'system' ? '系统接口' : '观测接口'}: ${spec.name}`);
    if (spec.precondition) {
      lines.push(`// 前置条件: ${spec.precondition}`);
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
