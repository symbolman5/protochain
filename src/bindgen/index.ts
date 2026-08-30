/**
 * bindings 骨架自动生成器（步骤 E3）
 *
 * 设计依据：
 * - IMPLEMENTATION-PLAN.md §E3（binding 骨架自动生成）
 * - IMPLEMENTATION-ACCEPTANCE.md §E3（验收标准：40/40 接口、生成率 ≥ 80%、bind 校验通过）
 * - verification/acceptance/E3/design-notes.md（设计笔记）
 *
 * 与 E2 强耦合：specs.json 必须含完整 requestSchema/responseSchema 后才能做
 * method/path/params 推导；老格式（裸数组）触发 envelopeMigrate 后再推导。
 *
 * 与 src/binder/ 的区分：
 * - bindgen = 骨架生成器（机械推导 method/path/params）
 * - binder  = 完整性校验器（校验 binding 配置与 specs 的一致性）
 *
 * 不引入新依赖：复用 `yaml` 包与现有 InterfaceSpec/InterfaceBinding/TransportBinding 类型。
 *
 * 边界（v0.5 / T1）：
 * - HTTP 默认推导；Kafka/NSQ/Grpc/DbQuery 仅生成 TODO 占位骨架
 * - stateMap 初始从 specs.json 的 observe_<stateName> 派生（stateId → stateName）
 * - 不引入 responseMapping 字段（保留现有 TransportBinding 类型稳定）
 */

import { stringify as stringifyYaml } from 'yaml';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  InterfaceSpec,
  InterfaceBinding,
  RoleBinding,
  BindingConfig,
  HttpTransport,
  SourceProtocolModel,
  ErrorMapEntry,
  ErrorResponseDef,
} from '../model/types.js';
import {
  envelopeMigrate,
  isSpecsEnvelope,
} from '../specifier/envelope.js';
import type {
  DimensionKind,
  DimensionKindSource,
  DimensionKindEntry,
} from '../model/dimension-kind.js';

// ============================================================================
// 类型定义
// ============================================================================

/** 骨架标记（写入 YAML 顶部，bind 命令据此识别走 mergeBindings） */
export const SKELETON_MARKER = '__protochain_skeleton__';

/** 默认 baseUrl 占位（人工必须替换） */
export const DEFAULT_BASE_URL_PLACEHOLDER = 'https://TODO.example.com';

/** derive-bindings 输入 */
export interface DeriveBindingsOptions {
  /** 项目根目录（用于读取 derived/specs.json） */
  rootDir: string;
  /** 可选：自定义 specs.json 路径（默认 <rootDir>/derived/specs.json） */
  specsPath?: string;
  /** 可选：自定义 skeleton 输出路径（默认 <rootDir>/derived/bindings.skeleton.yaml） */
  outputPath?: string;
  /** 可选：自定义报告输出路径（默认 <rootDir>/derived/bindings-generation-report.json） */
  reportPath?: string;
  /** 强制覆盖已存在骨架 */
  force?: boolean;
  /** 静默迁移报警（默认 false：打印到 stderr） */
  silentMigration?: boolean;
}

/** derive-bindings 输出统计 */
export interface SkeletonStats {
  /** 接口总数（system + observation） */
  total: number;
  /** 系统接口数 */
  system: number;
  /** 观测接口数 */
  observation: number;
  /** 完整生成（HTTP method/path/params 全部填齐，无需人工调整 transport） */
  generated: number;
  /** 部分生成（method/path/transport 留 TODO，待人工指定） */
  partial: number;
  /**
   * 生成成功率 = generated / total。
   * 验收口径（IMPLEMENTATION-ACCEPTANCE.md §E3）："除 baseUrl/headers/authConfig/stateMap 确认项外，
   * 其余字段无需人工修改"。本指标对应"无需人工调整 transport.method/path/params 的占比"。
   */
  generationRate: number;
  /** 待人工确认项数量（baseUrl/headers/authConfig/stateMap） */
  manualConfirmItems: number;
}

/**
 * 骨架顶层（兼容 BindingConfig + 元数据）。
 * 用 type intersection 而非 extends，避免 BindingConfig 的可选字段
 * （defaultEnv/stateMap）在 skeleton 中必须重声明为 required 才能编译。
 */
export type SkeletonBindings = BindingConfig & {
  /** 骨架标记（YAML 顶部键） */
  [SKELETON_MARKER]: true;
  /** 推导时间（ISO） */
  generatedAt: string;
  /** 源 model.md version */
  sourceModelVersion: string;
  /** 源 specs.json 是否 Envelope 形态 */
  sourceEnvelope: boolean;
  /** 是否从老格式 specs.json 迁移而来 */
  sourceMigrated: boolean;
  /** 迁移期报警 */
  sourceMigrationWarnings: string[];
  /** 默认环境名（人工可改；骨架默认 'default'） */
  defaultEnv: string;
  /** 统计 */
  stats: SkeletonStats;
  /** 警告（生成过程中非致命问题） */
  warnings: string[];
  /**
   * X4/X19（G7/S3，P0-1）：维度访问器骨架 —— observed 维度不生成 setter 只生成 reader，
   * 从类型层面落实「角色不能凭意图制造事实」。仅在 specs.json 带出非空 dimensions 时产出
   * （无 kind 标注的老模型不产出，降级路径不改行为，S3-5）。
   */
  dimensions?: DimensionAccessorEntry[];
};

/**
 * 单维度访问器条目（写进 bindings.skeleton.yaml 的 dimensions 段）。
 *
 * 生成规则（机械，逐维度）：
 * - kind='declared' → reader + setter 都生成（角色可凭意图写入）；
 * - kind='observed' → 只生成 reader，不生成 setter（角色不能凭意图制造事实）；
 * - kind 缺省（W(dim)=∅，dimension-kind-undetermined）→ 只生成 reader，
 *   序列化 kind='undetermined' 显式标注 + 记降级 warning（B-1 分流，不得静默）。
 */
export interface DimensionAccessorEntry {
  /** 维度所属上下文标识（状态 ID 或附属实体 ID） */
  owner: string;
  /** 维度名 */
  dimension: string;
  /** kind：declared / observed / undetermined（kind 缺省时序列化为 undetermined，显式降级） */
  kind: DimensionKind | 'undetermined';
  /** 来源：derived / asserted；kind=undetermined 时缺省 */
  kindSource?: DimensionKindSource;
  /** W(dim)：写入该维度的 triggerType 集合（去重排序，specs.json 原样搬运） */
  writers: string[];
  /** reader 方法名（恒生成，如 getRefundStatus） */
  reader: string;
  /** setter 方法名（仅 kind='declared' 生成，如 setRefundStatus；observed/undetermined 缺省） */
  setter?: string;
}

/** derive-bindings 执行结果 */
export interface DeriveBindingsResult {
  skeleton: SkeletonBindings;
  skeletonPath: string;
  reportPath: string;
}

// ============================================================================
// 公共 helper：snake_case 路径推导
// ============================================================================

/**
 * 把 action 名（如 `applyForApproval` / `submit`）映射为 URL path。
 * 规则：
 * - 已含 `/`（如 `v1/entries`）→ 原样返回
 * - camelCase / PascalCase → snake_case
 * - 长度限制 ≤ 64 字符（避免 URL 过长）
 */
export function deriveHttpPath(name: string): string {
  if (!name) return '/TODO';
  if (name.includes('/')) return name.startsWith('/') ? name : `/${name}`;
  // camelCase → snake_case
  const snake = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
  return `/${snake.length > 64 ? snake.slice(0, 64) : snake}`;
}

/** HTTP method 推导：state_transition → POST；attribute_update → PATCH；观测 → GET；兜底 POST */
export function deriveHttpMethod(spec: InterfaceSpec): 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' {
  if (spec.kind === 'observation') return 'GET';
  if (spec.actionType === 'attribute_update') return 'PATCH';
  return 'POST';
}

/** 从 requestSchema.properties 中推导 params（必填字段全列，可选字段留空避免请求爆炸） */
export function deriveHttpParams(spec: InterfaceSpec): { logicalName: string; in: 'query' | 'body' | 'path' | 'header'; physicalName?: string }[] {
  const schema = spec.requestSchema;
  if (!schema?.properties) return [];
  const required = new Set(schema.required ?? []);
  const params: { logicalName: string; in: 'query' | 'body' | 'path' | 'header'; physicalName?: string }[] = [];
  for (const [propName, propSchema] of Object.entries(schema.properties)) {
    // 路径参数（如 :id）：约定以 _id 结尾或 schema 含 format=uuid → path
    // 此处保守全部进 body，specifier 已推断 currentState 必填进 body
    if (required.has(propName) || isLikelyIdentifierParam(propName)) {
      const location = isLikelyIdentifierParam(propName) ? 'path' : 'body';
      params.push({ logicalName: propName, in: location });
    }
    // 可选字段不进 params（避免请求爆炸；Impl 自行决定 query/header）
    // 隐式忽略 propSchema（unused）
    void propSchema;
  }
  return params;
}

/**
 * 启发式：字段名以 `_id` 结尾或为 `id` / `name` → 视为路径参数候选。
 * 真正上线时应让 model.md 显式声明 path params；E3 范围仅做启发式。
 */
function isLikelyIdentifierParam(name: string): boolean {
  return name === 'id' || name === 'name' || name.endsWith('_id') || name.endsWith('Id');
}

// ============================================================================
// E11：errorMap 骨架推导（从 specs.errorResponses 派生）
// ============================================================================

/**
 * E11：从 specs.errorResponses 派生 errorMap 骨架（协议码 → ErrorMapEntry）。
 * - 必填字段：httpStatus（直接从契约）
 * - 可空字段：systemCode / bodyField / bodyFieldValue / messageField
 *   留待人工确认（与 roles.baseUrl 同等待遇，计入 manualConfirmItems）
 * - 老协议无 errorResponses → 返回空对象 + warning
 */
export function deriveErrorMap(
  specs: InterfaceSpec[]
): { errorMap: Record<string, ErrorMapEntry>; warnings: string[] } {
  const warnings: string[] = [];
  const errorMap: Record<string, ErrorMapEntry> = {};

  const seen = new Set<string>();
  for (const spec of specs) {
    if (!spec.errorResponses || spec.errorResponses.length === 0) continue;
    for (const er of spec.errorResponses) {
      if (seen.has(er.errorCode)) continue;
      seen.add(er.errorCode);
      errorMap[er.errorCode] = {
        httpStatus: er.httpStatus,
        // 缺省 bodyField='code'（与统一 envelope 一致；人工可改）
        bodyField: 'code',
      };
    }
  }

  if (Object.keys(errorMap).length === 0) {
    warnings.push(
      'specs.json 无 errorResponses；errorMap 初始为空（待人工按外部系统错误结构补全）'
    );
  } else {
    warnings.push(
      `errorMap 骨架已生成 ${Object.keys(errorMap).length} 个 errorCode（systemCode/bodyFieldValue 待人工确认）`
    );
  }
  return { errorMap, warnings };
}

// ============================================================================
// 角色推导
// ============================================================================

/**
 * 从 model.metadata.roles 推导 roles 段。
 * 若 specs 中无系统接口触发（纯观测协议）→ 仅含 default 一个角色 + warning。
 */
export function deriveRoles(
  model: SourceProtocolModel,
  specs: InterfaceSpec[]
): { roles: Record<string, RoleBinding>; warnings: string[] } {
  const warnings: string[] = [];
  const roleIds = model.metadata.roles?.map((r) => r.id) ?? [];
  const hasSystem = specs.some((s) => s.kind === 'system');

  if (roleIds.length === 0) {
    warnings.push('model.metadata.roles 为空，按 default 兜底（人工需替换为真实角色）');
    return {
      roles: {
        default: {
          roleId: 'default',
          baseUrl: DEFAULT_BASE_URL_PLACEHOLDER,
          auth: 'none',
        },
      },
      warnings,
    };
  }

  if (!hasSystem) {
    warnings.push('specs.json 无系统接口，骨架仅生成观测接口；角色按 default 兜底');
  }

  const roles: Record<string, RoleBinding> = {};
  for (const rid of roleIds) {
    roles[rid] = {
      roleId: rid,
      baseUrl: DEFAULT_BASE_URL_PLACEHOLDER,
      auth: 'none',
      headers: {},
    };
  }
  return { roles, warnings };
}

// ============================================================================
// stateMap 初始派生
// ============================================================================

/**
 * 从 specs.json 的 observe_<stateName> 派生 stateMap 初始（stateId → stateName）。
 * 兜底：specs.json 无 state 观测接口 → 空 {} + warning。
 */
export function deriveStateMap(
  specs: InterfaceSpec[]
): { stateMap: Record<string, string>; warnings: string[] } {
  const warnings: string[] = [];
  const stateMap: Record<string, string> = {};
  for (const spec of specs) {
    if (spec.kind !== 'observation') continue;
    // 观测接口 name=observe_<stateName> / sourceId=<stateId>
    if (!spec.sourceId) continue;
    // 仅 state 观测（observe_<stateName> + sourceId=<stateId>）→ 进 stateMap
    // 不变量观测（observe_<invId>）不进 stateMap（语义不同）
    const isInvariantObservation = spec.invariantIds && spec.invariantIds.length > 0;
    if (isInvariantObservation) continue;
    const stateName = spec.name.replace(/^observe_/, '');
    stateMap[spec.sourceId] = stateName;
  }
  if (Object.keys(stateMap).length === 0) {
    warnings.push('specs.json 无 state 观测接口，stateMap 初始为空（待人工按外部系统词补全）');
  }
  return { stateMap, warnings };
}

// ============================================================================
// 维度访问器推导（X4/X19，G7/S3，P0-1）
// ============================================================================

/** snake_case / kebab-case 维度名 → 访问器后缀（PascalCase）；非 ASCII 兜底保首字母大写 */
function toAccessorSuffix(name: string): string {
  if (!name) return 'Dimension';
  const parts = name.split(/[_\-\s]+/).filter((p) => p.length > 0);
  if (parts.length > 1) {
    return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
  }
  const cleaned = name.replace(/[^A-Za-z0-9]/g, '');
  const base = cleaned.length > 0 ? cleaned : name;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/**
 * 从 specs.json 的维度清单（DimensionKindEntry[]，S1 产物）推导访问器骨架。
 *
 * 规则（X4/X19）：observed 维度（含 computed 同口径；本方案无 computed，仅 observed）
 * 不生成 setter 只生成 reader；declared 维度 reader + setter 都生成；
 * kind 缺省（dimension-kind-undetermined）→ 只生成 reader + 显式降级 warning（B-1 分流）。
 *
 * 纯函数：不写文件；返回条目 + 降级 warning（并入 skeleton.warnings）。
 */
export function deriveDimensionAccessors(
  dimensions: DimensionKindEntry[],
  schemaDegradedReasons?: string[]
): { entries: DimensionAccessorEntry[]; warnings: string[] } {
  const warnings: string[] = [];

  // 把 specs.json 已记录的降级原因并入骨架警告（显式，不得静默）
  if (schemaDegradedReasons && schemaDegradedReasons.length > 0) {
    warnings.push(...schemaDegradedReasons);
  }

  const entries: DimensionAccessorEntry[] = [];
  for (const d of dimensions) {
    const suffix = toAccessorSuffix(d.dimension);
    const reader = `get${suffix}`;
    const base: DimensionAccessorEntry = {
      owner: d.owner,
      dimension: d.dimension,
      kind: d.kind ?? 'undetermined',
      writers: d.writers ?? [],
      reader,
    };
    if (d.kindSource) base.kindSource = d.kindSource;

    if (d.kind === 'declared') {
      // 正向对照（S3-3）：declared 维度仍正常生成 setter（角色可凭意图写入）
      base.setter = `set${suffix}`;
    } else if (d.kind === 'observed') {
      // S3-2：observed 维度不生成 setter，只生成 reader
      warnings.push(
        `维度 ${d.dimension}（${d.owner}）kind='observed'，只生成 reader（${reader}），不生成 setter：角色不能凭意图制造事实 [X4/X19]`
      );
    } else {
      // kind 缺省（dimension-kind-undetermined）：显式降级，只生成 reader
      warnings.push(
        `维度 ${d.dimension}（${d.owner}）kind 缺省（dimension-kind-undetermined），显式降级（B-1 分流）：按只读处理，只生成 reader（${reader}），不生成 setter，待人工确认 kind 后修正`
      );
    }
    entries.push(base);
  }
  return { entries, warnings };
}

// ============================================================================
// interface 推导
// ============================================================================

/**
 * 单条 InterfaceSpec → InterfaceBinding（HTTP 路径）
 *
 * 边界：
 * - HTTP 默认推导（method/path/params + transport.type='http'）
 * - Kafka/NSQ/Grpc/DbQuery 留 TODO 占位骨架
 */
export function deriveInterfaceBinding(
  spec: InterfaceSpec,
  defaultRoleId: string
): InterfaceBinding {
  const method = deriveHttpMethod(spec);
  const path = deriveHttpPath(spec.name);
  const params = deriveHttpParams(spec);
  const transport: HttpTransport = {
    type: 'http',
    method,
    path,
    params,
  };

  // actionType=attribute_update → PATCH（已通过 deriveHttpMethod 落地）
  // 观测接口 → GET（已通过 deriveHttpMethod 落地）
  return {
    action: spec.name,
    roleId: defaultRoleId,
    transport,
  };
}

/** 默认角色 ID：取 model.metadata.roles 首个 consensus 角色；无则取首个角色；无则 'default' */
export function selectDefaultRoleId(model: SourceProtocolModel): string {
  const roles = model.metadata.roles ?? [];
  const consensus = roles.find((r) => r.roleType === 'consensus');
  if (consensus) return consensus.id;
  if (roles.length > 0) return roles[0].id;
  return 'default';
}

// ============================================================================
// 主入口
// ============================================================================

/**
 * 推导 bindings 骨架（核心函数）
 *
 * 输入：SourceProtocolModel + InterfaceSpec[]
 * 输出：SkeletonBindings
 *
 * 不做文件 I/O；纯函数；文件 I/O 在 deriveBindings()（CLI 入口）层做。
 *
 * dimensionCtx（可选）：specs.json 的维度清单 + 降级记录（S1 产物）。
 * - 非空 dimensions → 产出 dimensions 访问器段（X4/X19）；
 * - 缺省 / 空 → 不产出（老模型降级路径不改行为，S3-5）。
 */
export function deriveSkeletonBindings(
  model: SourceProtocolModel,
  specs: InterfaceSpec[],
  envelopeMeta: {
    sourceEnvelope: boolean;
    sourceMigrated: boolean;
    sourceMigrationWarnings: string[];
  },
  dimensionCtx?: {
    dimensions?: DimensionKindEntry[];
    schemaDegradedReasons?: string[];
  }
): SkeletonBindings {
  const warnings: string[] = [];
  const { roles, warnings: roleWarnings } = deriveRoles(model, specs);
  warnings.push(...roleWarnings);

  const { stateMap, warnings: stateMapWarnings } = deriveStateMap(specs);
  warnings.push(...stateMapWarnings);

  // E11：从 specs.errorResponses 派生 errorMap 骨架（与 stateMap 同构）
  const { errorMap, warnings: errorMapWarnings } = deriveErrorMap(specs);
  warnings.push(...errorMapWarnings);

  // X4/X19：维度访问器骨架（observed 无 setter；declared 有 setter；undetermined 显式降级）
  let dimensions: DimensionAccessorEntry[] | undefined;
  const dims = dimensionCtx?.dimensions;
  if (dims && dims.length > 0) {
    const { entries, warnings: dimWarnings } = deriveDimensionAccessors(
      dims,
      dimensionCtx?.schemaDegradedReasons
    );
    dimensions = entries;
    warnings.push(...dimWarnings);
  }

  const defaultRoleId = selectDefaultRoleId(model);
  const interfaces: InterfaceBinding[] = [];
  let systemCount = 0;
  let observationCount = 0;
  let generatedCount = 0;
  let partialCount = 0;

  for (const spec of specs) {
    if (spec.kind === 'system') systemCount++;
    else observationCount++;

    const binding = deriveInterfaceBinding(spec, defaultRoleId);
    interfaces.push(binding);

    // HTTP 推导完整 → generated；否则 partial（理论上 E3 v0.5 永远 generated，
    // 但保留 partial 通道供未来 Kafka/NSQ 推导不全时使用）
    if (binding.transport.type === 'http') generatedCount++;
    else partialCount++;
  }

  // 统计 manualConfirmItems：roles 数量（每个角色需人工确认 baseUrl/headers/authConfig）
  // + stateMap 条目数（每个待人工确认系统词）
  // + errorMap 条目数（每个待人工确认 systemCode/bodyFieldValue）
  const manualConfirmItems =
    Object.keys(roles).length +
    Object.keys(stateMap).length +
    Object.keys(errorMap).length;

  const total = specs.length;
  const stats: SkeletonStats = {
    total,
    system: systemCount,
    observation: observationCount,
    generated: generatedCount,
    partial: partialCount,
    generationRate: total > 0 ? generatedCount / total : 0,
    manualConfirmItems,
  };

  return {
    [SKELETON_MARKER]: true,
    generatedAt: new Date().toISOString(),
    sourceModelVersion: model.metadata.version,
    sourceEnvelope: envelopeMeta.sourceEnvelope,
    sourceMigrated: envelopeMeta.sourceMigrated,
    sourceMigrationWarnings: envelopeMeta.sourceMigrationWarnings,
    defaultEnv: 'default',
    roles,
    interfaces,
    stateMap,
    errorMap: Object.keys(errorMap).length > 0 ? errorMap : undefined,
    dimensions,
    stats,
    warnings,
  };
}

/**
 * CLI 入口：从 rootDir 读取 derived/specs.json + model.md，推导并写入骨架。
 *
 * 行为：
 * - specs.json 不存在 → 抛错（提示先 derive-specs）
 * - 老格式 specs.json（裸数组）→ 自动 envelopeMigrate，打印迁移报警（除非 silentMigration）
 * - skeleton 已存在 → 未传 --force 时抛错
 */
export async function deriveBindings(
  options: DeriveBindingsOptions,
  parseModel: (rootDir: string) => SourceProtocolModel
): Promise<DeriveBindingsResult> {
  const rootDir = options.rootDir;
  const specsPath = options.specsPath ?? join(rootDir, 'derived/specs.json');
  const outputPath =
    options.outputPath ?? join(rootDir, 'derived/bindings.skeleton.yaml');
  const reportPath =
    options.reportPath ?? join(rootDir, 'derived/bindings-generation-report.json');

  // 1. 读取 specs.json（兼容 Envelope / 裸数组）
  if (!existsSync(specsPath)) {
    throw new Error(
      `specs.json 不存在: ${specsPath}（请先运行 protochain derive-specs）`
    );
  }
  const rawSpecs = JSON.parse(readFileSync(specsPath, 'utf-8'));
  let specs: InterfaceSpec[];
  let envelopeMeta: {
    sourceEnvelope: boolean;
    sourceMigrated: boolean;
    sourceMigrationWarnings: string[];
  };
  // X4/X19：specs.json 带出的维度清单 + 降级记录（S1 产物；老格式/裸数组无此字段）
  let envelopeDimensions: DimensionKindEntry[] | undefined;
  let envelopeSchemaDegradedReasons: string[] | undefined;

  if (isSpecsEnvelope(rawSpecs)) {
    specs = rawSpecs.specs;
    envelopeMeta = {
      sourceEnvelope: true,
      sourceMigrated: rawSpecs.migrated === true,
      sourceMigrationWarnings: rawSpecs.migrationWarnings ?? [],
    };
    envelopeDimensions = rawSpecs.dimensions;
    envelopeSchemaDegradedReasons = rawSpecs.schemaDegradedReasons;
  } else if (Array.isArray(rawSpecs)) {
    // 老格式裸数组 → 自动 envelopeMigrate
    const r = envelopeMigrate(rawSpecs, 'unknown');
    if (!options.silentMigration) {
      for (const w of r.warnings) {
        // 迁移报警写到 stderr（CLI 友好）；不阻断流程
        console.warn(`[specs.json] [migration] ${w}`);
      }
    }
    specs = r.envelope.specs;
    envelopeMeta = {
      sourceEnvelope: false,
      sourceMigrated: r.migrated,
      sourceMigrationWarnings: r.warnings,
    };
    envelopeDimensions = r.envelope.dimensions;
    envelopeSchemaDegradedReasons = r.envelope.schemaDegradedReasons;
  } else {
    // 不可识别形态（理论上 loadSpecsEnvelope 已抛错；CLI 路径独立再兜底）
    const r = envelopeMigrate(rawSpecs, 'unknown');
    throw new Error(
      `specs.json 形态无法识别：${r.parseError ?? '未知错误'}（请检查 derive-specs 输出）`
    );
  }

  // 2. 读取 model.md
  const model = parseModel(rootDir);

  // 3. 推导骨架
  const skeleton = deriveSkeletonBindings(model, specs, envelopeMeta, {
    dimensions: envelopeDimensions,
    schemaDegradedReasons: envelopeSchemaDegradedReasons,
  });

  // 4. 写出骨架（除非已存在 + 未传 force）
  if (existsSync(outputPath) && !options.force) {
    throw new Error(
      `骨架已存在: ${outputPath}（如需覆盖请传 --force）`
    );
  }

  // YAML 序列化：骨架顶层是 SkeletonBindings（含 BindingConfig 子集）
  // 直接 stringifyYaml 会按字段顺序输出；TS 字段顺序：标记 → 元数据 → roles → interfaces → stateMap → ...
  const yamlContent = stringifySkeleton(skeleton);

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, yamlContent, 'utf-8');

  // 5. 写出生成率报告
  const report = {
    generatedAt: skeleton.generatedAt,
    sourceModelVersion: skeleton.sourceModelVersion,
    stats: skeleton.stats,
    warnings: skeleton.warnings,
    sourceEnvelope: skeleton.sourceEnvelope,
    sourceMigrated: skeleton.sourceMigrated,
    sourceMigrationWarnings: skeleton.sourceMigrationWarnings,
  };
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');

  return {
    skeleton,
    skeletonPath: outputPath,
    reportPath,
  };
}

/** YAML 序列化（手写以保留字段顺序 + skeleton marker 在顶部） */
function stringifySkeleton(skeleton: SkeletonBindings): string {
  // 优先用 yaml.stringify（保持结构可读）；markers 元数据放顶部
  const ordered = {
    [SKELETON_MARKER]: true,
    generatedAt: skeleton.generatedAt,
    sourceModelVersion: skeleton.sourceModelVersion,
    sourceEnvelope: skeleton.sourceEnvelope,
    sourceMigrated: skeleton.sourceMigrated,
    sourceMigrationWarnings: skeleton.sourceMigrationWarnings,
    defaultEnv: skeleton.defaultEnv,
    roles: skeleton.roles,
    interfaces: skeleton.interfaces,
    stateMap: skeleton.stateMap,
    errorMap: skeleton.errorMap,
    // X4/X19：仅 specs.json 带出非空 dimensions 时产出（老模型降级路径不改行为）
    dimensions: skeleton.dimensions,
    stats: skeleton.stats,
    warnings: skeleton.warnings,
  };
  return stringifyYaml(ordered, { lineWidth: 120, sortMapEntries: false });
}

// ============================================================================
// 公开 helper：CLI 端 envelopeMeta 提取（供测试 / 重用）
// ============================================================================

/**
 * 从 raw specs.json（任意形态）抽取 envelope 元数据，**不抛错**（供测试 / 预览）。
 * 与 deriveBindings 内部逻辑对齐。
 */
export function inspectSpecsEnvelopeMeta(raw: unknown): {
  sourceEnvelope: boolean;
  sourceMigrated: boolean;
  sourceMigrationWarnings: string[];
} {
  if (isSpecsEnvelope(raw)) {
    return {
      sourceEnvelope: true,
      sourceMigrated: raw.migrated === true,
      sourceMigrationWarnings: raw.migrationWarnings ?? [],
    };
  }
  if (Array.isArray(raw)) {
    return {
      sourceEnvelope: false,
      sourceMigrated: true,
      sourceMigrationWarnings: [
        `老格式 specs.json 自动迁移：检测到 ${raw.length} 条 InterfaceSpec 顶层数组。`,
      ],
    };
  }
  return {
    sourceEnvelope: false,
    sourceMigrated: false,
    sourceMigrationWarnings: ['specs.json 形态不可识别'],
  };
}

/** 类型守卫：判断 YAML 加载对象是否为骨架 */
export function isSkeletonBindings(value: unknown): value is SkeletonBindings {
  if (!value || typeof value !== 'object') return false;
  return (value as Record<string, unknown>)[SKELETON_MARKER] === true;
}
