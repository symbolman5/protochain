/**
 * Web 检阅界面生成器 —— E7 P0（只读静态检阅，纯机械）
 *
 * 设计依据：
 * - IMPLEMENTATION-PLAN.md §E7、IMPLEMENTATION-ACCEPTANCE.md §E7 P0
 * - verification/acceptance/E7-P0/design-notes.md（设计笔记）
 * - E7-P0-START.txt §2 / §5（启动提示词）
 *
 * 职责（100% 机械、无 AI、不读 process.env、不读 bindings.yaml）：
 * 1. 读 derived/specs.json（Envelope 形态，E2 产物）
 * 2. 读 derived/test-cases.json（E2 产物）
 * 3. 读 derived/verification/verification-report.json（implcheck/verifier 产物）
 * 4. 读 derived/impl-check/impl-check-report.json（implcheck 产物）
 * 5. 读 derived/diff/model-diff.json（versioner/differ 产物，可选）
 * 6. 读 derived/impact-analysis.json（differ 产物，可选）
 * 7. 读 protocol/model.md（仅取元数据 + 状态机图）
 * 8. 构造 WebDataJson（结构化中间表示）
 * 9. 写出 web/data.json + web/docs/public/data.json
 * 10. 写出 web/docs/*.md（VitePress 输入）
 * 11. 调 `npx vitepress build` → web/.vitepress/dist/
 *
 * 与现有命名：
 * - `webgen` = Web 检阅界面生成器（机械）
 * - `bindgen` = binding 骨架生成器（机械）
 * - `binder`  = binding 完整性校验器
 *
 * 安全边界（设计笔记 §5）：
 * - 不读 process.env（即使子进程环境含 SECRET_TOKEN_XYZ，web 产物也不出现）
 * - 不读 bindings.yaml（authConfig.tokenEnv/secretEnv/passwordEnv 完全不入站）
 * - 不调 AI 模块（拒绝工具链 random 性侵入展示层）
 *
 * 不在 P0 范围（明确防范围蔓延，附录 B.4）：
 * - mock 服务 / 团队协作 / 环境管理 / Apifox 克隆
 * - 模型侧输入管理（在线编辑 scenarios / bindings）
 * - Web 服务接触令牌环境变量
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import * as yamlModule from 'yaml';
import { findConfigPath } from '../project/context.js';
import type {
  SourceProtocolModel,
  InterfaceSpec,
  TestCaseSet,
  VerificationReport,
  ImplCheckReport,
  ModelDiff,
  ImpactAnalysis,
  FieldSpec,
  SchemaExpression,
  JSONSchema,
  ErrorResponseDef,
  BindingConfig,
  ErrorMapEntry,
  RelationDef,
  CredentialDeclaration,
  AdversarialCase,
  ComponentMappingDef,
} from '../model/types.js';
import type { DimensionKindEntry } from '../model/dimension-kind.js';
import type { StorageSchema } from '../storagegen/index.js';
import {
  envelopeMigrate,
  isSpecsEnvelope,
  type SpecsEnvelope,
} from '../specifier/envelope.js';
import { buildRelations, type RelationsProjection } from './relations.js';
import { tryParseGuardSchema } from '../specifier/schema-builder.js';

// ============================================================================
// 类型定义
// ============================================================================

/** web/data.json schema 版本 */
export const WEB_DATA_SCHEMA_VERSION = '1.0' as const;

/** web/data.json 顶层 */
export interface WebDataJson {
  schemaVersion: typeof WEB_DATA_SCHEMA_VERSION;
  generatedAt: string;
  sourceModelVersion: string;
  /** 协议元数据（人读） */
  protocol: {
    name: string;
    version: string;
    purpose: string;
    roles: Array<{ id: string; name: string; roleType?: string }>;
  };
  interfaces: WebInterfaceView[];
  testCases: WebTestCaseView[];
  verification: WebVerificationView;
  diff: WebDiffView | null;
  impact: WebImpactView | null;
  implCheck: WebImplCheckView | null;
  /**
   * W3-d（05-execution-T1 TA1）：状态机结构化视图。
   * - mermaid 字符串保留（VitePress 快照页兼容）；
   * - nodes/edges 为 viewer 渲染链路的结构化数据（机械投影，无端内推导）；
   * - edgeCoverage 为验证着色数据（transitionId → pass/fail/uncovered）。
   */
  stateMachine: WebStateMachineView;
  /**
   * W1-a（06-execution-T2 TB1）：关系机械推导投影（relations.json 同源同批产物）。
   * - 四种 kind（sequence / causes_state_change / invariant_scope / timing）；
   * - 顶层 sourceModelVersion 与 WebDataJson.sourceModelVersion 同源（N1 守卫复用）；
   * - 供 viewer 关系展示面板（TB5）与 Web 关系视图消费。
   */
  relations: RelationsProjection;
  /**
   * W3-f ⑦（07-execution-T3 TC9）：演进 diff 机械投影（结构化、viewer 查表）。
   * - 从 diff（derived/diff/model-diff.json）投影变更状态/转移集合；
   * - 受影响接口/用例清单由工具链机械投影（specs 命中变更转移 / testCases 命中变更转移）；
   * - 无 diff 数据 → 字段缺省（既有 data.json 契约不变，零回归）。
   */
  diffView?: WebDiffViewProjection;
  redactionNotice: string[];
  /**
   * E11：绑定视图（bindings.yaml 非敏感投影子集）。
   * - 不读取 authConfig / tls 密钥段
   * - 用于接口详情"传输绑定"表 + "错误映射"表
   * 缺省表示未读取 bindings.yaml（deriver-web 仅 P0 数据生成）。
   */
  binding?: WebBindingView;
  /** E11：异常路径条目（用于接口详情"绑定视图"页的上下文） */
  exceptionPaths?: Array<{
    id: string;
    name: string;
    errorCode?: string;
  }>;
  /**
   * G7-V3（webgen 数据层扩展）：维度 kind 判定投影（S1 产物，specs.json 顶层 dimensions）。
   * - 每条目 owner/dimension/kind/kindSource/writers（DimensionKindEntry 原样投影）；
   * - 缺省 = specs.json 无 dimensions 段（老模型形态）→ 字段不出现（undefined），零回归。
   */
  dimensions?: DimensionKindEntry[];
  /**
   * G7-V4（协议层视图 §11.3 数据源）：不变量投影（DerivableLayer.invariants + timing 关联）。
   * - 每条目 id/name/expression/subject/timing/bound/remedy/level/description/dimensions；
   * - timing：关联 derivable.timing 中 target=inv.id 的 deadline 约束 → 'eventually_within'
   *   （带 bound=boundMs 收敛上界）；无关联 → 'always'（强一致承诺）；
   * - dimensions：expression 文本中出现的模型维度名（viewer 维度↔不变量联动数据源）；
   * - 缺省 = 模型无不变量（老模型形态）→ 字段不出现（undefined），零回归。
   */
  invariants?: WebInvariantView[];
  /**
   * V1 关系段投影（model.md「关系」段，parser parseRelations 产物，DerivableLayer.relations）。
   * - 每条 from/to/type/constraint/onGone（RelationDef 原样投影）；
   * - 与既有 relations（W1-a 拓扑机械推导投影）区分：本字段是模型声明的原始关系段；
   * - 缺省 = 模型无「关系」段（老模型形态）→ 字段不出现（undefined），零回归。
   */
  modelRelations?: RelationDef[];
  /**
   * G7-V3（webgen 数据层扩展）：存储 schema 投影（S3 derive-storage 产物 storage.schema.json）。
   * - 顶层计数 + 按 owner 分组的维度落点（dimensions[].{name,type,kind} 归一投影）；
   * - 缺省 = 未运行 derive-storage（老模型形态）→ 字段不出现（undefined），零回归。
   */
  storage?: WebStorageView;
  /**
   * G7-S6（P2-6）：凭证声明投影（model.md frontmatter credential: 段，parser 解析产物）。
   * - name/issuer/holder/redeemer/selfContained/ttl/revoke/premise 七列（CredentialDeclaration 原样投影）；
   * - 缺省 = 模型未启用凭证机制（老模型形态）→ 字段不出现（undefined），零回归。
   */
  credentials?: CredentialDeclaration[];
  /**
   * S5b X18（G7）：组件映射投影（model.md「组件映射」段，DerivableLayer.componentMapping 三张表）。
   * - interfaceImplementations[].{interface,component} / dimensionStorage[].{dimension,table,field}
   *   / componentTransfers[].{from,to,channel,mode}；
   * - 缺省 = 模型无「组件映射」段（老模型形态）→ 字段不出现（undefined），零回归。
   */
  components?: WebComponentMappingView;
  /**
   * G7-S4/S6（X5/X6/X12/X15）：对抗性用例投影（derived/test-cases.json adversarialCases[]）。
   * - id/kind/source/interfaceId/body + expected* 断言字段（AdversarialCase 原样投影）；
   * - 缺省 = test-cases.json 无 adversarialCases（老模型形态）→ 字段不出现（undefined），零回归。
   */
  adversarialCases?: AdversarialCase[];
}

/**
 * G7-V4（webgen 数据层扩展）：不变量投影视图（协议层视图 §11.3 数据源，viewer 查表零推导）。
 * 时间语义口径：不变量有 derivable.timing 中 target=inv.id 的 deadline 约束 →
 * 该不变量依赖观测/补偿收敛（eventually_within，bound=boundMs）；无关联 → 强一致（always）。
 */
export interface WebInvariantView {
  id: string;
  name: string;
  /** 不变量表达式（形式化/半形式化文本） */
  expression: string;
  /** 作用主体（scopeStateIds，作用状态 ID 列表；空 = 全局不变量） */
  subject: string[];
  /** expression 文本中出现的模型维度名（维度 ↔ 不变量联动数据源） */
  dimensions: string[];
  /** 时间语义：无 deadline 关联 → always；有关联 → eventually_within */
  timing: 'always' | 'eventually_within';
  /** eventually_within 的收敛上界（毫秒；关联 deadline 约束的 boundMs） */
  bound?: number;
  /** 补救声明（P2-8：检测方式/处置动作；缺省 = 模型未声明） */
  remedy?: { action: string; detection?: string };
  /** 校验层级（state-machine / data；缺省 = 模型未声明） */
  level?: 'state-machine' | 'data';
  /** 不变量语义描述（人读） */
  description?: string;
}

/**
 * G7-V3（webgen 数据层扩展）：存储 schema 投影视图（storage.schema.json 的 viewer 友好归一投影）。
 * 归一口径：storage.schema.json 的 entities[].columns[].{dimension,column,kind,type} →
 * dimensions[].{name,type,kind}（机械骨架列名恒等于维度名，column 冗余省略）。
 */
export interface WebStorageView {
  /** 实体维度总数 */
  dimensionCount: number;
  /** 有存储落点的维度数（= dimensionCount，每维度必有一列） */
  coveredDimensionCount: number;
  /** 覆盖率（coveredDimensionCount / dimensionCount；dimensionCount=0 → 1） */
  coverageRate: number;
  /** 按 owner（状态 ID / 附属实体 ID）分组的实体存储落点 */
  entities: Array<{
    /** 实体标识（维度 owner） */
    entity: string;
    /** 该实体维度数 */
    dimensionCount: number;
    /** 维度落点清单（name=维度名 / type=存储类型 / kind=declared|observed|undetermined） */
    dimensions: Array<{
      name: string;
      type: string;
      kind: string;
    }>;
  }>;
}

/**
 * S5b X18（G7）：组件映射投影视图（DerivableLayer.componentMapping 三张映射表）。
 * 只投影 viewer 面板需要的结构化字段；description 为可选说明（人读）。
 */
export interface WebComponentMappingView {
  /** 接口 → 实现组件（哪个 service/module 承载哪个 interface） */
  interfaceImplementations: Array<{ interface: string; component: string; description?: string }>;
  /** 实体维度 → 存储（维度落到哪张表 / 哪个字段） */
  dimensionStorage: Array<{ dimension: string; table: string; field?: string; description?: string }>;
  /** 组件 → 组件传输（谁调谁、什么通道、同步/异步） */
  componentTransfers: Array<{
    from: string;
    to: string;
    channel: string;
    mode: 'sync' | 'async';
    description?: string;
  }>;
}

/** 接口详情视图（人读） */
export interface WebInterfaceView {
  id: string;
  name: string;
  kind: 'system' | 'observation';
  actionType?: 'state_transition' | 'attribute_update';
  description: string;
  requestSchema?: JSONSchema;
  responseSchema?: JSONSchema;
  inputs: FieldSpec[];
  outputs: FieldSpec[];
  precondition?: string;
  postconditions: string[];
  preconditions?: SchemaExpression[];
  postconditionExpressions?: SchemaExpression[];
  sideEffects?: SchemaExpression[];
  schemaKind?: 'structured' | 'legacy-stub' | 'description-only';
  schemaDegradedReasons?: string[];
  invariantIds?: string[];
  observesResourcePoolId?: string;
  /** 触发角色 ID（来自 metadata.roles + transitions.trigger） */
  triggerRoleId?: string;
  /**
   * E11：接口错误响应契约（来自 InterfaceSpec.errorResponses 投影）。
   * 每个错误响应含 id/errorCode/httpStatus/bodySchema——绑定后展示"错误响应"表。
   */
  errorResponses?: ErrorResponseDef[];
  /**
   * E11 后续问题 5：契约承载接口标记（specifier 派生 IF_CTR_* 时为 true）。
   * web 渲染接口详情页头部加注：「承载接口：契约 interface 未匹配 transition，由 specifier 派生」，
   * 让读者区分"状态机系统接口"与"契约投影载体"。
   */
  isContractCarrier?: boolean;
}

/** 测试用例浏览器视图 */
export interface WebTestCaseView {
  id: string;
  length: number;
  stateIds: string[];
  transitionIds: string[];
  description?: string;
  hasException?: boolean;
  verificationPassed?: boolean;
  verificationSkipped?: boolean;
  deviations: Array<{
    action: string;
    state: string;
    kind: string;
    expected: string;
    actual: string;
    field?: string;
    legacy?: string;
    impl?: string;
  }>;
}

/** 验证报告对比视图 */
export interface WebVerificationView {
  hasReport: boolean;
  passed: boolean;
  counts: { passed: number; failed: number; skipped: number };
  verifiedAt?: string;
  deviationSummary: {
    stateMismatch: number;
    fieldMismatch: number;
    missingAction: number;
    invariantViolation: number;
    timingViolation: number;
    errorMismatch: number;
    unexpectedError: number;
    other: number;
  };
  /** 双跑对账（legacy vs impl 并排） */
  sideBySide: Array<{
    action: string;
    state: string;
    field: string;
    legacy: string;
    impl: string;
    matched: boolean;
  }>;
  /**
   * E11：错误契约验证汇总段（按 errorCode → 命中次数 / 未命中 / 系统故障）。
   * - matched：errorCode → 命中 errorMap 次数
   * - unmapped：未命中列表（含 action/httpStatus/protocolErrorCode/systemCode）
   * - systemFault：5xx/504 计数
   * - expected：场景层 expectedError 命中数（errorCode → 次数）
   * 缺省视为兼容老协议（无 errorMap 验证）。
   */
  errorSummary?: {
    matched: Record<string, number>;
    unmapped: Array<{
      action: string;
      httpStatus?: number;
      protocolErrorCode?: string;
      systemCode?: unknown;
    }>;
    systemFault: number;
    expected?: Record<string, number>;
  };
}

// ============================================================================
// W3-d 状态机结构化视图（viewer 渲染链路的机械投影契约）
// ============================================================================

/** 边验证着色状态（W3-d：transitionId → pass/fail/uncovered） */
export type EdgeCoverageStatus = 'pass' | 'fail' | 'uncovered';

/** 状态机节点（StateDef → 机械投影；viewer 只查表显示，不做端内推导） */
export interface WebStateMachineNode {
  id: string;
  name: string;
  type: 'initial' | 'normal' | 'terminal' | 'error';
  /** 状态关联角色 ID（StateDef.roleIds 投影） */
  roleIds?: string[];
  /** 终态标记（terminal 或 error 视为终态；供视图形态区分） */
  terminal: boolean;
}

/** 状态机边（TransitionDef → 机械投影；viewer 只查表显示，不做端内推导） */
export interface WebStateMachineEdge {
  /** 转移 ID（transitionId，edgeCoverage 的键） */
  id: string;
  action: string;
  /** 源状态 ID（多源转移为数组） */
  from: string[];
  /** 目标状态 ID */
  to: string;
  /** 触发角色 ID */
  triggerRoleId?: string;
  /** 守卫条件原文（自然语言；W2 语义层落地前一律 description-only） */
  guard?: string;
  /** guard 的 schemaKind（语法命中 → json-schema；未命中显式降级 → description-only） */
  guardSchemaKind?: 'json-schema' | 'legacy-stub' | 'description-only';
  /** 关联时序约束（timing.source/target === transition.action 或 onViolation 匹配） */
  timing?: Array<{ id: string; type: string; boundMs?: number }>;
  /** 异常/降级路径标记（转移出现在异常路径 transitionIds 中 → true） */
  degraded: boolean;
  /** 溯源：投影来源元素（恒等于 id，供 viewer 展示 derived-from） */
  derivedFrom: string;
}

/** 状态机视图（W3-d 契约补强；mermaid 字符串保留兼容） */
export interface WebStateMachineView {
  mermaid: string;
  nodes: WebStateMachineNode[];
  edges: WebStateMachineEdge[];
  /**
   * 验证着色数据：transitionId → pass/fail/uncovered。
   * 机械投影（与 W1 relations 投影同构）：uncovered 优先取用例覆盖报告；
   * 被覆盖的转移按 verification caseResults 聚合（任一失败 → fail，全过 → pass）；
   * 无验证报告 → 全部 uncovered（无验证证据不谎报 pass）。
   */
  edgeCoverage: Record<string, EdgeCoverageStatus>;
  /**
   * W3-e（06-execution-T2 TB2）：不变量 × 状态 × 角色 的机械投影。
   * - 泳道判据"关键运力类约束由哪个角色承载"需要跨元素聚合，属 viewer 端
   *   被否决的二次推导 → 上移工具链由本字段承载；
   * - carrierRoleIds = scope 状态 roleIds 的并集（scopeStateIds 空 = 全部状态）；
   * - 供泳道面板（TB3）约束承载联动直接查表（零推导）。
   */
  invariantScope: Record<
    string,
    { name: string; scopeStateIds: string[]; carrierRoleIds: string[] }
  >;
}

/**
 * E11：Web 绑定视图（bindings.yaml 非敏感投影子集）。
 * 红线：
 * - authConfig/tls 密钥段不读取；redactSensitiveFields 兜底
 * - errorMap 完整展示（无敏感字段）
 * - 用途：接口详情"传输绑定"表 + "错误映射"表
 */
export interface WebBindingView {
  /** 角色绑定（仅 baseUrl/headers/kafka/nsq 公共段；authConfig 整块不读取） */
  roles: Array<{
    roleId: string;
    baseUrl?: string;
    headers?: Record<string, string>;
    authKind?: string;
  }>;
  /** 接口绑定（仅 action/roleId/protocol/transport.method/path/type） */
  interfaces: Array<{
    action: string;
    roleId?: string;
    protocol?: string;
    transport?: {
      type: string;
      method?: string;
      path?: string;
    };
  }>;
  /** 状态词表（stateMap，非敏感） */
  stateMap?: Record<string, string>;
  /** 错误映射表（errorMap，非敏感） */
  errorMap?: Record<string, ErrorMapEntry>;
  /** 缺绑（specs 中声明但 bindings.errorMap 未覆盖的 errorCode 列表） */
  unmappedErrorCodes?: string[];
  /** 警告（额外 errorCode / 模式不一致） */
  warnings: string[];
  /** 是否读取到了 bindings.yaml（false → 空数据） */
  hasBindings: boolean;
}

/** 模型 diff 视图 */
export interface WebDiffView {
  metadataChanges: Array<{ path: string; kind: string; oldValue?: string; newValue?: string }>;
  readableChanges: Array<{ path: string; kind: string; oldValue?: string; newValue?: string }>;
  derivableChanges: Array<{
    elementType: string;
    elementId: string;
    kind: string;
    fieldChanges?: Array<{ path: string; kind: string; oldValue?: string; newValue?: string }>;
  }>;
  diffedAt: string;
  summary: string;
}

/** 影响分析视图 */
export interface WebImpactView {
  affectedSteps: string[];
  affectedArtifacts: string[];
  incrementalPlan: string[];
  analyzedAt: string;
  humanReadable: Array<{ trigger: string; affected: string[] }>;
}

/**
 * W3-f ⑦（TC9）：演进 diff 机械投影（viewer 查表渲染；不做端内推导）。
 * 变更集合 = model-diff.json derivableChanges 机械投影；受影响接口/用例 = 工具链投影。
 */
export interface WebDiffViewProjection {
  /** 变更的转移 ID 集合（diff.derivableChanges 中 elementType=transition） */
  changedTransitions: string[];
  /** 变更的状态 ID 集合（elementType=state） */
  changedStates: string[];
  /** 变更的其他元素（invariant/timing/exception 等） */
  changedOthers: Array<{ elementType: string; elementId: string; kind: string }>;
  /** 受影响接口 ID 清单（spec.id，sourceId/派生 id 命中变更转移） */
  affectedInterfaces: string[];
  /** 受影响用例 ID 清单（testCases.paths[].transitionIds 命中变更转移） */
  affectedCases: string[];
  /** 人读摘要（复用 summarizeDiff） */
  summary: string;
}

/** 实现完整性视图 */
export interface WebImplCheckView {
  hasReport: boolean;
  passed: boolean;
  total: number;
  found: number;
  missing: number;
  missingActions: Array<{ interfaceId: string; interfaceName: string; location?: string }>;
}

// ============================================================================
// derive-web 输入/输出
// ============================================================================

/** derive-web 选项 */
export interface DeriveWebOptions {
  /** 项目根目录 */
  rootDir: string;
  /** 自定义 web/data.json 输出路径（默认 <rootDir>/web/data.json） */
  dataJsonPath?: string;
  /** 自定义站点工程路径（默认 <rootDir>/web） */
  webDir?: string;
  /** 自定义 VitePress build 产物目录（默认 <webDir>/.vitepress/dist） */
  distDir?: string;
  /** 是否执行 VitePress build（默认 true；测试时可关） */
  buildSite?: boolean;
  /** 站点工程模板目录（默认内置 web/ 模板） */
  templateDir?: string;
  /** 是否覆盖已存在产物（默认 false：提示先清掉） */
  force?: boolean;
}

export interface DeriveWebResult {
  /** WebDataJson（结构化中间表示） */
  data: WebDataJson;
  /** web/data.json 绝对路径 */
  dataJsonPath: string;
  /** 站点工程目录 */
  webDir: string;
  /** VitePress build 产物目录（buildSite=true 且成功时填） */
  distDir: string;
  /** VitePress build 是否执行 */
  built: boolean;
  /** 警告 */
  warnings: string[];
}

// ============================================================================
// 安全边界常量
// ============================================================================

/** 敏感字段名清单（即使出现在 derived/*.json 中也不入 web 产物） */
export const SENSITIVE_FIELD_NAMES = new Set([
  'tokenEnv',
  'secretEnv',
  'passwordEnv',
  'keyEnv',
  'usernameEnv',
  'certPath',
  'keyPath',
  'caPath',
  'token',
  'secret',
  'password',
  'apiKey',
]);

/** 提示给读者的脱敏说明（web/data.json 顶部 redactionNotice 字段） */
export const REDACTION_NOTICE_LINES = [
  '本产物由 derive-web 机械生成；不含 authConfig.token/secret/password 等敏感字段。',
  '本产物不读取 bindings.yaml；不读取进程环境变量。',
  'P0 范围仅只读展示；编辑能力在 P1 提供。',
];

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 过滤敏感字段：从对象中递归**删除**敏感字段名（深度优先）
 *
 * E7-I6 修复：与验收口径"tokenEnv 等字段不出现"严格对齐——
 * 整键删除，不替换为 [REDACTED]（避免键名本身暴露"存在某个令牌环境变量"）。
 *
 * 防御性：即使上游不慎写入敏感字段名，本步骤也会删除。
 * 验收 test 注入 SECRET_TOKEN_XYZ 类键名后能命中此函数。
 */
export function redactSensitiveFields<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map((v) => redactSensitiveFields(v)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (SENSITIVE_FIELD_NAMES.has(k)) {
      // E7-I6 修复：整键删除（而非替换为 [REDACTED]）
      continue;
    }
    out[k] = redactSensitiveFields(v);
  }
  return out as T;
}

/** 状态机图：mermaid stateDiagram-v2 源码 */
export function buildMermaidStateMachine(model: SourceProtocolModel): string {
  const lines: string[] = ['stateDiagram-v2'];
  // 初始状态 + 终态标识
  const initialId = model.derivable.initialStateId;
  for (const s of model.derivable.states) {
    let label = `${s.id}: ${s.name}`;
    if (s.type === 'terminal') label += ' (终态)';
    if (s.id === initialId) label += ' (初始)';
    lines.push(`    ${s.id} : ${label}`);
  }
  // 转移边：from → to : action[guard]
  for (const t of model.derivable.transitions) {
    for (const from of t.from) {
      const action = t.action ?? t.name;
      const guard = t.guard ? `[${t.guard}]` : '';
      lines.push(`    ${from} --> ${t.to} : ${action}${guard}`);
    }
  }
  return lines.join('\n');
}

// ============================================================================
// W3-d 状态机结构化投影（05-execution-T1 TA1）
// 机械投影原则：只做字段搬运 + 既有数据源聚合，不做任何端内推导。
// ============================================================================

/**
 * 边验证着色投影：transitionId → pass/fail/uncovered。
 * - uncovered 优先：testCases.coverage.transitionCoverage.uncoveredIds；
 * - 被覆盖的转移：按 verification.authoritative.caseResults 聚合——
 *   （覆盖该转移的 path 中）任一 failed → fail；存在 passed → pass；
 *   无对应 caseResult（skipped / 未验证）→ uncovered；
 * - 无 verification 报告 → 全部 uncovered（无验证证据不谎报 pass）。
 */
export function buildEdgeCoverage(
  model: SourceProtocolModel,
  testCases?: TestCaseSet,
  verification?: VerificationReport
): Record<string, EdgeCoverageStatus> {
  const result: Record<string, EdgeCoverageStatus> = {};
  // 用例覆盖报告的未覆盖转移集合（可选数据源）
  const uncoveredIds = new Set<string>();
  if (testCases?.coverage?.transitionCoverage?.uncoveredIds) {
    for (const id of testCases.coverage.transitionCoverage.uncoveredIds) {
      uncoveredIds.add(id);
    }
  }
  // verification caseResults 索引（pathId → 结果）
  const caseIndex = new Map<string, { passed: boolean; skipped?: boolean }>();
  if (verification?.authoritative.caseResults) {
    for (const cr of verification.authoritative.caseResults) {
      caseIndex.set(cr.pathId, { passed: cr.passed, skipped: cr.skipped });
    }
  }
  for (const t of model.derivable.transitions) {
    if (uncoveredIds.has(t.id)) {
      result[t.id] = 'uncovered';
      continue;
    }
    // 被用例覆盖：需要 verification 才可能产生 pass/fail
    if (verification && testCases) {
      const paths = testCases.paths.filter((p) => p.transitionIds.includes(t.id));
      const results = paths
        .map((p) => caseIndex.get(p.id))
        .filter((r): r is { passed: boolean; skipped?: boolean } => r !== undefined);
      const anyFailed = results.some((r) => !r.passed && !r.skipped);
      const anyPassed = results.some((r) => r.passed);
      if (anyFailed) result[t.id] = 'fail';
      else if (anyPassed) result[t.id] = 'pass';
      else result[t.id] = 'uncovered';
    } else {
      result[t.id] = 'uncovered';
    }
  }
  return result;
}

/**
 * 状态机结构化视图投影（W3-d）：StateDef → nodes，TransitionDef → edges。
 * - degraded：转移出现在 model.derivable.exceptions[].transitionIds 中 → true；
 * - timing：model.derivable.timing 中 source/target 匹配该转移 action，或
 *   onViolation 匹配转移 id / 目标状态 id 的时序约束（机械关联，不改语义）；
 * - guardSchemaKind：从 specifier 的 guard 表达式 kind 机械投影（TC5）——
 *   语法命中 → 'json-schema'；未命中（legacy-stub / description-only）→ 'description-only'。
 *   由 buildWebData 计算 guardSchemaKinds 传入（单一事实源 tryParseGuardSchema）；
 *   未传 map（直接调用/老数据）→ 缺省 'description-only'（W2 前占位行为，零回归）。
 */
export function buildStateMachineView(
  model: SourceProtocolModel,
  testCases?: TestCaseSet,
  verification?: VerificationReport,
  guardSchemaKinds?: ReadonlyMap<string, 'json-schema' | 'description-only'>
): WebStateMachineView {
  const exceptionTransitionIds = new Set<string>();
  for (const ex of model.derivable.exceptions ?? []) {
    for (const tid of ex.transitionIds) exceptionTransitionIds.add(tid);
  }
  const timingDefs = model.derivable.timing ?? [];
  const nodes: WebStateMachineNode[] = model.derivable.states.map((s) => ({
    id: s.id,
    name: s.name,
    type: s.type,
    roleIds: s.roleIds,
    terminal: s.type === 'terminal' || s.type === 'error',
  }));
  const edges: WebStateMachineEdge[] = model.derivable.transitions.map((t) => {
    const edge: WebStateMachineEdge = {
      id: t.id,
      action: t.action ?? t.name,
      from: t.from.slice(),
      to: t.to,
      triggerRoleId: t.triggerRoleId,
      degraded: exceptionTransitionIds.has(t.id),
      derivedFrom: t.id,
    };
    if (t.guard) {
      edge.guard = t.guard;
      edge.guardSchemaKind = guardSchemaKinds?.get(t.id) ?? 'description-only';
    }
    const relatedTiming = timingDefs
      .filter(
        (tm) =>
          tm.source === t.action ||
          tm.target === t.action ||
          tm.onViolation === t.id ||
          tm.onViolation === t.to
      )
      .map((tm) => {
        const o: { id: string; type: string; boundMs?: number } = {
          id: tm.id,
          type: tm.type,
        };
        if (tm.boundMs !== undefined) o.boundMs = tm.boundMs;
        return o;
      });
    if (relatedTiming.length > 0) edge.timing = relatedTiming;
    return edge;
  });
  // W3-e（TB2）：不变量 × 状态 × 角色 机械投影（invariantScope）
  const stateById = new Map(model.derivable.states.map((s) => [s.id, s]));
  const allStateIds = model.derivable.states.map((s) => s.id);
  const invariantScope: WebStateMachineView['invariantScope'] = {};
  for (const inv of model.derivable.invariants ?? []) {
    const scope =
      inv.scopeStateIds && inv.scopeStateIds.length > 0
        ? inv.scopeStateIds.slice()
        : allStateIds.slice();
    const carrier = new Set<string>();
    for (const sid of scope) {
      const st = stateById.get(sid);
      if (st && st.roleIds) {
        for (const r of st.roleIds) carrier.add(r);
      }
    }
    invariantScope[inv.id] = {
      name: inv.name,
      scopeStateIds: scope,
      carrierRoleIds: [...carrier].sort(),
    };
  }
  return {
    mermaid: buildMermaidStateMachine(model),
    nodes,
    edges,
    edgeCoverage: buildEdgeCoverage(model, testCases, verification),
    invariantScope,
  };
}

/** 摘要派生：diff → 人读文本（最多 200 字符） */
export function summarizeDiff(diff: ModelDiff): string {
  const parts: string[] = [];
  if (diff.metadataChanges.length > 0) {
    parts.push(`元数据 ${diff.metadataChanges.length} 项变更`);
  }
  if (diff.readableChanges.length > 0) {
    parts.push(`可读层 ${diff.readableChanges.length} 项变更`);
  }
  if (diff.derivableChanges.length > 0) {
    parts.push(`可推演层 ${diff.derivableChanges.length} 项变更`);
  }
  return parts.length > 0 ? parts.join('；') : '无变更';
}

/** 影响分析 → 人读视图（变更元素 ID → 受影响步骤/产物） */
export function humanReadableImpact(
  diff: ModelDiff,
  impact: ImpactAnalysis
): Array<{ trigger: string; affected: string[] }> {
  const result: Array<{ trigger: string; affected: string[] }> = [];
  // 每个 added/removed 元素都是一个 trigger
  for (const c of diff.derivableChanges) {
    if (c.kind === 'added') {
      result.push({
        trigger: `新增 ${c.elementType}: ${c.elementId}`,
        affected: impact.affectedSteps.slice(),
      });
    } else if (c.kind === 'removed') {
      result.push({
        trigger: `删除 ${c.elementType}: ${c.elementId}`,
        affected: impact.affectedSteps.slice(),
      });
    } else if (c.kind === 'modified') {
      result.push({
        trigger: `变更 ${c.elementType}: ${c.elementId}`,
        affected: impact.affectedSteps.slice(),
      });
    }
  }
  return result;
}

// ============================================================================
// 视图构造器（pure functions；可独立测试）
// ============================================================================

/** InterfaceSpec[] → WebInterfaceView[] */
export function buildInterfaceViews(specs: InterfaceSpec[]): WebInterfaceView[] {
  return specs.map((s) => {
    const view: WebInterfaceView = {
      id: s.id,
      name: s.name,
      kind: s.kind,
      description: s.precondition ?? s.name,
      requestSchema: s.requestSchema,
      responseSchema: s.responseSchema,
      inputs: s.inputs,
      outputs: s.outputs,
      precondition: s.precondition,
      postconditions: s.postconditions ?? [],
      preconditions: s.preconditions,
      postconditionExpressions: s.postconditionExpressions,
      sideEffects: s.sideEffects,
      schemaKind: s.schemaKind,
      schemaDegradedReasons: s.schemaDegradedReasons,
      invariantIds: s.invariantIds,
      observesResourcePoolId: s.observesResourcePoolId,
    };
    if (s.actionType) view.actionType = s.actionType;
    // 系统接口默认 actionType='state_transition'（状态转移接口：currentState 是 CAS 入参）
    // 显式声明的 attribute_update 走原值；观测接口不设 actionType（currentState 是多余的）
    if (s.kind === 'system' && !view.actionType) {
      view.actionType = 'state_transition';
    }
    // E11：错误响应契约投影（接口详情"错误响应"表）
    if (s.errorResponses && s.errorResponses.length > 0) {
      view.errorResponses = s.errorResponses.slice();
    }
    // E11 后续问题 5：契约承载接口标记透传
    if (s.isContractCarrier) view.isContractCarrier = true;
    return view;
  });
}

/**
 * E11：从 BindingConfig 构造 WebBindingView（非敏感投影子集）。
 * - roles：仅 baseUrl / headers / auth（kind）；authConfig 整块不读取
 * - interfaces：仅 action / roleId / protocol / transport.{type,method,path}
 * - errorMap：完整展示（无敏感字段）
 * - stateMap：完整展示（无敏感字段）
 * 调用方负责：先读取 bindings.yaml → JSON.parse → redactSensitiveFields → 本函数
 * - 未提供 bindings 时返回 hasBindings=false 的空视图
 */
export function buildBindingView(
  bindings: BindingConfig | undefined,
  specs: InterfaceSpec[],
  options?: { allProjectErrorCodes?: string[] }
): WebBindingView {
  if (!bindings) {
    return { roles: [], interfaces: [], warnings: [], hasBindings: false };
  }
  const warnings: string[] = [];

  const roles: WebBindingView['roles'] = [];
  for (const [roleId, role] of Object.entries(bindings.roles ?? {})) {
    const out: { roleId: string; baseUrl?: string; headers?: Record<string, string>; authKind?: string } = {
      roleId,
    };
    if (role.baseUrl !== undefined) out.baseUrl = role.baseUrl;
    if (role.headers && Object.keys(role.headers).length > 0) out.headers = role.headers;
    // 仅显示 auth 类型，不读取 authConfig
    out.authKind = role.auth;
    roles.push(out);
  }

  const interfaces: WebBindingView['interfaces'] = [];
  for (const ib of bindings.interfaces ?? []) {
    const t = ib.transport;
    const transportOut: { type: string; method?: string; path?: string } = { type: t.type };
    if ('method' in t && t.method) transportOut.method = t.method;
    if ('path' in t && t.path) transportOut.path = t.path;
    const out: { action: string; roleId?: string; protocol?: string; transport?: { type: string; method?: string; path?: string } } = {
      action: ib.action,
      transport: transportOut,
    };
    if (ib.roleId !== undefined) out.roleId = ib.roleId;
    if (ib.protocol !== undefined) out.protocol = ib.protocol;
    interfaces.push(out);
  }

  // 计算 unmappedErrorCodes：specs 中声明但 bindings.errorMap 未覆盖
  const declared = new Set<string>();
  for (const spec of specs) {
    for (const er of spec.errorResponses ?? []) {
      declared.add(er.errorCode);
    }
  }
  const unmappedErrorCodes: string[] = [];
  if (bindings.errorMap) {
    for (const code of declared) {
      if (!(code in bindings.errorMap)) unmappedErrorCodes.push(code);
    }
    // 额外的 errorCode（errorMap 里有但 specs/异常路径没声明）：
    // 多协议项目 errorMap 为组合层全量，其他子协议声明的码归为跨协议共享（预期保留），
    // 不误报"可能是残留"。
    const allProject = new Set(options?.allProjectErrorCodes ?? []);
    for (const code of Object.keys(bindings.errorMap)) {
      if (!declared.has(code) && !allProject.has(code)) {
        warnings.push(
          `errorMap 中的错误码 "${code}" 未在 specs.errorResponses / 异常路径声明（可能是残留）`
        );
      }
    }
  } else {
    for (const code of declared) {
      unmappedErrorCodes.push(code);
    }
  }

  const out: WebBindingView = {
    roles,
    interfaces,
    warnings,
    hasBindings: true,
  };
  if (bindings.stateMap && Object.keys(bindings.stateMap).length > 0) {
    out.stateMap = bindings.stateMap;
  }
  if (bindings.errorMap && Object.keys(bindings.errorMap).length > 0) {
    out.errorMap = bindings.errorMap;
  }
  if (unmappedErrorCodes.length > 0) {
    out.unmappedErrorCodes = unmappedErrorCodes;
  }
  return out;
}

/** ProtocolPath[] → WebTestCaseView[]（合并 verification-report.json caseResults） */
export function buildTestCaseViews(
  testCases: TestCaseSet | undefined,
  verification: VerificationReport | undefined
): WebTestCaseView[] {
  if (!testCases) return [];
  // 用 pathId → CaseResult 索引
  const caseIndex = new Map<string, { passed: boolean; skipped?: boolean; deviations?: NonNullable<typeof verification>['authoritative']['caseResults'][0]['deviations'] }>();
  if (verification?.authoritative.caseResults) {
    for (const cr of verification.authoritative.caseResults) {
      caseIndex.set(cr.pathId, {
        passed: cr.passed,
        skipped: cr.skipped,
        deviations: cr.deviations,
      });
    }
  }
  return testCases.paths.map((p) => {
    const cr = caseIndex.get(p.id);
    const view: WebTestCaseView = {
      id: p.id,
      length: p.length,
      stateIds: p.stateIds,
      transitionIds: p.transitionIds,
      description: p.description,
      hasException: p.hasException,
      deviations: [],
    };
    if (cr) {
      view.verificationPassed = cr.passed;
      view.verificationSkipped = cr.skipped;
      if (cr.deviations) {
        view.deviations = cr.deviations.map((d) => ({
          action: d.action,
          state: d.state,
          kind: d.kind,
          expected: d.expected,
          actual: d.actual,
          field: d.field,
          legacy: d.legacy,
          impl: d.impl,
        }));
      }
    }
    return view;
  });
}

/** VerificationReport → WebVerificationView */
export function buildVerificationView(
  verification: VerificationReport | undefined
): WebVerificationView {
  if (!verification) {
    return {
      hasReport: false,
      passed: false,
      counts: { passed: 0, failed: 0, skipped: 0 },
      deviationSummary: {
        stateMismatch: 0,
        fieldMismatch: 0,
        missingAction: 0,
        invariantViolation: 0,
        timingViolation: 0,
        errorMismatch: 0,
        unexpectedError: 0,
        other: 0,
      },
      sideBySide: [],
    };
  }
  const summary = {
    stateMismatch: 0,
    fieldMismatch: 0,
    missingAction: 0,
    invariantViolation: 0,
    timingViolation: 0,
    errorMismatch: 0,
    unexpectedError: 0,
    other: 0,
  };
  const sideBySide: WebVerificationView['sideBySide'] = [];
  for (const cr of verification.authoritative.caseResults) {
    for (const d of cr.deviations ?? []) {
      if (d.kind === 'state_mismatch') summary.stateMismatch++;
      else if (d.kind === 'field_mismatch') summary.fieldMismatch++;
      else if (d.kind === 'missing_action') summary.missingAction++;
      else if (d.kind === 'invariant_violation') summary.invariantViolation++;
      else if (d.kind === 'timing_violation') summary.timingViolation++;
      else if (d.kind === 'error_mismatch') summary.errorMismatch++;
      else if (d.kind === 'unexpected_error') summary.unexpectedError++;
      else summary.other++;
      // 双跑对账：field_mismatch 时填 legacy/impl；state_mismatch 时填 expected/actual
      sideBySide.push({
        action: d.action,
        state: d.state,
        field: d.field ?? `state.${d.expected}`,
        legacy: d.legacy ?? d.expected,
        impl: d.impl ?? d.actual,
        matched: false,
      });
    }
  }
  const out: WebVerificationView = {
    hasReport: true,
    passed: verification.authoritative.passed,
    counts: verification.authoritative.counts,
    verifiedAt: verification.verifiedAt,
    deviationSummary: summary,
    sideBySide,
  };
  if (verification.errorSummary) out.errorSummary = verification.errorSummary;
  return out;
}

/** ModelDiff → WebDiffView */
export function buildDiffView(
  diff: ModelDiff | undefined
): WebDiffView | null {
  if (!diff) return null;
  return {
    metadataChanges: diff.metadataChanges.map((c) => ({
      path: c.path,
      kind: c.kind,
      oldValue: c.oldValue,
      newValue: c.newValue,
    })),
    readableChanges: diff.readableChanges.map((c) => ({
      path: c.path,
      kind: c.kind,
      oldValue: c.oldValue,
      newValue: c.newValue,
    })),
    derivableChanges: diff.derivableChanges.map((c) => ({
      elementType: c.elementType,
      elementId: c.elementId,
      kind: c.kind,
      fieldChanges: c.fieldChanges?.map((fc) => ({
        path: fc.path,
        kind: fc.kind,
        oldValue: fc.oldValue,
        newValue: fc.newValue,
      })),
    })),
    diffedAt: diff.diffedAt,
    summary: summarizeDiff(diff),
  };
}

/**
 * W3-f ⑦（TC9）：diffView 机械投影（结构化、viewer 查表；无 diff 数据 → undefined）。
 *
 * 投影规则（纯机械，viewer 端零 join/零推导）：
 * - changedTransitions / changedStates / changedOthers：diff.derivableChanges 逐条投影；
 * - affectedInterfaces：specs 中 id/sourceId 命中变更转移的系统接口（IF_SYS_<tid> / action 名）；
 * - affectedCases：testCases.paths[].transitionIds 与变更转移集合相交的用例；
 * - 同输入同输出（可复现）。
 */
export function buildDiffViewProjection(
  diff: ModelDiff | undefined,
  specs: InterfaceSpec[],
  testCases?: TestCaseSet
): WebDiffViewProjection | undefined {
  if (!diff) return undefined;

  const changedTransitions = diff.derivableChanges
    .filter((c) => c.elementType === 'transition')
    .map((c) => c.elementId);
  const changedStates = diff.derivableChanges
    .filter((c) => c.elementType === 'state')
    .map((c) => c.elementId);
  const changedOthers = diff.derivableChanges
    .filter((c) => c.elementType !== 'transition' && c.elementType !== 'state')
    .map((c) => ({ elementType: c.elementType, elementId: c.elementId, kind: c.kind }));

  // 受影响接口：spec.id === `IF_SYS_<changedTransition>` 或 spec.sourceId === changedTransition
  const changedSet = new Set(changedTransitions);
  const affectedInterfaces = specs
    .filter((s) => {
      if (s.id && changedSet.has(s.id.replace(/^IF_SYS_/, ''))) return true;
      if (s.sourceId && changedSet.has(s.sourceId)) return true;
      return false;
    })
    .map((s) => s.id);

  // 受影响用例：paths[].transitionIds ∩ changedTransitions ≠ ∅
  const affectedCases = (testCases?.paths ?? [])
    .filter((p) => p.transitionIds.some((tid) => changedSet.has(tid)))
    .map((p) => p.id);

  return {
    changedTransitions,
    changedStates,
    changedOthers,
    affectedInterfaces,
    affectedCases,
    summary: summarizeDiff(diff),
  };
}

/** ImpactAnalysis + ModelDiff → WebImpactView */
export function buildImpactView(
  impact: ImpactAnalysis | undefined,
  diff: ModelDiff | undefined
): WebImpactView | null {
  if (!impact) return null;
  return {
    affectedSteps: impact.affectedSteps,
    affectedArtifacts: impact.affectedArtifacts,
    incrementalPlan: impact.incrementalPlan,
    analyzedAt: impact.analyzedAt,
    humanReadable: diff ? humanReadableImpact(diff, impact) : [],
  };
}

/** ImplCheckReport → WebImplCheckView */
export function buildImplCheckView(
  report: ImplCheckReport | undefined
): WebImplCheckView | null {
  if (!report) return null;
  const found = report.interfaceChecks.filter((c) => c.found).length;
  const missing = report.interfaceChecks.filter((c) => !c.found);
  return {
    hasReport: true,
    passed: report.passed,
    total: report.interfaceChecks.length,
    found,
    missing: missing.length,
    missingActions: missing.map((c) => {
      const out: { interfaceId: string; interfaceName: string; location?: string } = {
        interfaceId: c.interfaceId,
        interfaceName: c.interfaceName,
      };
      if (c.location) out.location = c.location;
      return out;
    }),
  };
}

// ============================================================================
// 主构造器
// ============================================================================

/**
 * G7-V4（webgen 数据层扩展）：DerivableLayer.invariants → WebInvariantView[]（协议层视图数据源）。
 * - 机械投影：id/name/expression/scopeStateIds(subject)/level/description/remedy；
 * - timing 判定：derivable.timing 中 target=inv.id 的约束 → 'eventually_within'（bound=boundMs）；
 *   无关联 → 'always'（强一致承诺；对应 §11.3 时间语义摘要条的数据源）；
 * - dimensions：expression 文本中出现的模型维度名（dimensionNames 来自 specs.json 维度判定）；
 * - 无不变量（老模型形态）→ undefined（字段缺省，零回归）。
 */
export function buildInvariantsView(
  model: SourceProtocolModel,
  dimensionNames: string[] | undefined
): WebInvariantView[] | undefined {
  const invs = model.derivable.invariants ?? [];
  if (invs.length === 0) return undefined;
  const timingByTarget = new Map<string, { boundMs?: number }>();
  for (const t of model.derivable.timing ?? []) {
    if (t.target && !timingByTarget.has(t.target)) timingByTarget.set(t.target, t);
  }
  const names = dimensionNames ?? [];
  return invs.map((inv) => {
    const tm = timingByTarget.get(inv.id);
    const view: WebInvariantView = {
      id: inv.id,
      name: inv.name,
      expression: inv.expression,
      subject: inv.scopeStateIds && inv.scopeStateIds.length > 0 ? inv.scopeStateIds.slice() : [],
      dimensions: names.filter((n) => n && inv.expression.includes(n)),
      timing: tm ? 'eventually_within' : 'always',
    };
    if (tm && tm.boundMs !== undefined) view.bound = tm.boundMs;
    if (inv.remedy) {
      view.remedy = { action: inv.remedy.action };
      const det = inv.remedy.detection;
      if (det && typeof det === 'object' && 'description' in det && det.description) {
        view.remedy.detection = String(det.description);
      }
    }
    if (inv.level) view.level = inv.level;
    if (inv.description) view.description = inv.description;
    return view;
  });
}

/**
 * G7-V3（webgen 数据层扩展）：storage.schema.json → WebStorageView（归一投影）。
 * - 未提供 storage（老模型未运行 derive-storage）→ undefined（字段缺省，零回归）；
 * - 空骨架（dimensionCount=0，如老模型空 dimensions）→ 空 entities 视图（照常投影）。
 */
export function buildStorageView(storage: StorageSchema | undefined): WebStorageView | undefined {
  if (!storage) return undefined;
  return {
    dimensionCount: storage.dimensionCount,
    coveredDimensionCount: storage.coveredDimensionCount,
    coverageRate: storage.coverageRate,
    entities: storage.entities.map((e) => ({
      entity: e.entity,
      dimensionCount: e.dimensionCount,
      dimensions: e.columns.map((c) => ({
        name: c.dimension,
        type: c.type,
        kind: c.kind,
      })),
    })),
  };
}

/**
 * S5b X18（G7）：DerivableLayer.componentMapping → WebComponentMappingView（三张表投影）。
 * - 无「组件映射」段（老模型形态）→ undefined（字段缺省，零回归）；
 * - 段存在 → 三张表照常投影（parser 保证三表恒存在，可为空数组）。
 */
export function buildComponentsView(
  mapping: ComponentMappingDef | undefined
): WebComponentMappingView | undefined {
  if (!mapping) return undefined;
  return {
    interfaceImplementations: (mapping.interfaceImplementations ?? []).map((m) => {
      const o: { interface: string; component: string; description?: string } = {
        interface: m.interface,
        component: m.component,
      };
      if (m.description) o.description = m.description;
      return o;
    }),
    dimensionStorage: (mapping.dimensionStorage ?? []).map((m) => {
      const o: { dimension: string; table: string; field?: string; description?: string } = {
        dimension: m.dimension,
        table: m.table,
      };
      if (m.field) o.field = m.field;
      if (m.description) o.description = m.description;
      return o;
    }),
    componentTransfers: (mapping.componentTransfers ?? []).map((m) => {
      const o: {
        from: string;
        to: string;
        channel: string;
        mode: 'sync' | 'async';
        description?: string;
      } = { from: m.from, to: m.to, channel: m.channel, mode: m.mode };
      if (m.description) o.description = m.description;
      return o;
    }),
  };
}

export interface DeriveWebInputs {
  /** envelope 形态 specs.json（必有） */
  specsEnvelope: SpecsEnvelope;
  /** model.md（必有；仅取元数据 + 状态机） */
  model: SourceProtocolModel;
  /** test-cases.json（可选） */
  testCases?: TestCaseSet;
  /** verification-report.json（可选） */
  verification?: VerificationReport;
  /** impl-check-report.json（可选） */
  implCheck?: ImplCheckReport;
  /** model-diff.json（可选） */
  diff?: ModelDiff;
  /** impact-analysis.json（可选） */
  impact?: ImpactAnalysis;
  /**
   * E11：bindings.yaml（可选；非敏感投影子集）。
   * 由调用方负责先 redactSensitiveFields 再传，避免敏感字段污染 web 产物。
   * 未提供 → binding 视图标记 hasBindings=false。
   */
  bindings?: BindingConfig;
  /**
   * G7-V3（webgen 数据层扩展）：storage.schema.json（S3 derive-storage 产物，可选）。
   * 未提供（老模型未运行 derive-storage）→ storage 视图缺省（undefined），零回归。
   */
  storage?: StorageSchema;
  /**
   * B6.3：多协议项目全量错误码（各子协议 specs.errorResponses 的并集）。
   * 传递后 buildBindingView 把「其他子协议声明的码」归类为跨协议共享（预期保留），
   * 不误报"可能是残留"。单协议项目不传。
   */
  allProjectErrorCodes?: string[];
  /**
   * T4（09-execution-T4 TD2 / 08 §5.2.2 R17）：warnings 收集通道（可选）。
   * triggerRoleId backfill 遇到同名 action 多条转移且 triggerRoleId 不同（消歧失败）时
   * 推入此处；不传则静默不填充（零回归）。调用方（deriveWeb / deriveProjectWeb）传入
   * 各自 warnings 数组即可复用既有报告通道。
   */
  warnings?: string[];
}

/** 由 inputs 构造 WebDataJson（pure function） */
export function buildWebData(inputs: DeriveWebInputs): WebDataJson {
  const {
    specsEnvelope,
    model,
    testCases,
    verification,
    implCheck,
    diff,
    impact,
    bindings,
    allProjectErrorCodes,
  } = inputs;
  const specs = specsEnvelope.specs;
  const interfaces = buildInterfaceViews(specs);
  const testCaseViews = buildTestCaseViews(testCases, verification);
  const verificationView = buildVerificationView(verification);
  const diffView = buildDiffView(diff);
  const impactView = buildImpactView(impact, diff);
  // W3-f ⑦（TC9）：diffView 机械投影（变更集合 + 受影响接口/用例；无 diff → 缺省，契约不变）
  const diffViewProjection = buildDiffViewProjection(diff, specs, testCases);
  const implCheckView = buildImplCheckView(implCheck);
  const bindingView = buildBindingView(bindings, specs, { allProjectErrorCodes });
  // G7-V3（webgen 数据层扩展）：六个新字段的投影（均可选；老模型无数据 → undefined，零回归）
  const dimensions = specsEnvelope.dimensions;
  // G7-V4（webgen 数据层扩展）：不变量投影（协议层视图 §11.3 数据源；无不变量 → undefined）
  const invariantsView = buildInvariantsView(model, dimensions?.map((d) => d.dimension));
  const modelRelations = model.derivable.relations;
  const storageView = buildStorageView(inputs.storage);
  const credentials = model.metadata.credentials;
  const componentsView = buildComponentsView(model.derivable.componentMapping);
  const adversarialCases = testCases?.adversarialCases;
  const exceptionPaths = (model.derivable.exceptions ?? []).map((e) => {
    const out: { id: string; name: string; errorCode?: string } = {
      id: e.id,
      name: e.name,
    };
    if (e.errorCode) out.errorCode = e.errorCode;
    return out;
  });
  // W1-a：关系机械投影（与 data.json 同批；sourceModelVersion 与 WebDataJson 同源）
  const relations = buildRelations(model);
  // W2（TC5）：guardSchemaKind 端到端——逐转移从 specifier 同一纯函数 tryParseGuardSchema
  // 机械投影 guard 表达式 kind：语法命中 → 'json-schema'；未命中（legacy-stub/description-only）
  // → 'description-only'。viewer 边详情零改动查表显示。
  const guardSchemaKinds = new Map<string, 'json-schema' | 'description-only'>();
  for (const t of model.derivable.transitions) {
    if (!t.guard) continue;
    const expr = tryParseGuardSchema(t.guard);
    guardSchemaKinds.set(t.id, expr?.kind === 'json-schema' ? 'json-schema' : 'description-only');
  }
  // T4（09-execution-T4 TD2 / 08 §5.2.2 R17）：stateMachine 提升为局部常量，
  // 以便在 return 前对 interfaces 做 triggerRoleId backfill（WebInterfaceView.triggerRoleId
  // 类型已声明 L148，此前投影缺失——R11 定案"直接修复"，由死转活，pN.data.json 与
  // interface-details.json 共同受益）。
  const stateMachine = buildStateMachineView(model, testCases, verification, guardSchemaKinds);
  // R17 同名 action 消歧规则：edges.filter(e => e.action === iface.name) 命中集合的
  // triggerRoleId 去重——唯一值 → 填充；多个不同值 → 不填 + warnings（工具链信号，
  // 与 S3"工具链自身一致性"同精神，防静默取首）；零命中（观测接口等）→ 保持空。
  for (const iface of interfaces) {
    if (iface.triggerRoleId !== undefined) continue; // 已有值不覆盖
    const roles = new Set<string>();
    for (const e of stateMachine.edges) {
      if (e.action === iface.name && e.triggerRoleId !== undefined && e.triggerRoleId !== null) {
        roles.add(e.triggerRoleId);
      }
    }
    if (roles.size === 1) {
      iface.triggerRoleId = [...roles][0];
    } else if (roles.size > 1) {
      inputs.warnings?.push(
        `triggerRoleId backfill 跳过：接口 ${iface.id}（action=${iface.name}）命中 ${roles.size} 个不同 triggerRoleId（${[...roles].join(' / ')}），不填充`
      );
    }
  }
  return {
    schemaVersion: WEB_DATA_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    sourceModelVersion: model.metadata.version,
    protocol: {
      name: model.metadata.name,
      version: model.metadata.version,
      purpose: model.metadata.purpose,
      roles: model.metadata.roles.map((r) => {
        const o: { id: string; name: string; roleType?: string } = { id: r.id, name: r.name };
        if (r.roleType) o.roleType = r.roleType;
        return o;
      }),
    },
    interfaces,
    testCases: testCaseViews,
    verification: verificationView,
    diff: diffView,
    impact: impactView,
    implCheck: implCheckView,
    stateMachine,
    relations,
    diffView: diffViewProjection,
    redactionNotice: REDACTION_NOTICE_LINES,
    binding: bindingView.hasBindings ? bindingView : undefined,
    exceptionPaths: exceptionPaths.length > 0 ? exceptionPaths : undefined,
    // G7-V3（webgen 数据层扩展）：六个新字段（可选；老模型无数据 → undefined，JSON 序列化时省略，零回归）
    dimensions: dimensions ?? undefined,
    // G7-V4（webgen 数据层扩展）：不变量投影（协议层视图 §11.3 数据源；可选字段，老模型缺省）
    invariants: invariantsView ?? undefined,
    modelRelations: modelRelations ?? undefined,
    storage: storageView ?? undefined,
    credentials: credentials ?? undefined,
    components: componentsView ?? undefined,
    adversarialCases: adversarialCases ?? undefined,
  };
}

// ============================================================================
// 文件 I/O
// ============================================================================

/**
 * 读取 derived/*.json（不存在返回 undefined；不抛错）
 *
 * 防御性：JSON.parse 失败时返回 undefined（CLI 不阻断；warnings 报告）
 *
 * E7-I7 修复：调用方可通过 readOptionalJsonWithStatus 区分
 * "missing"（未找到）vs "corrupt"（JSON 解析失败）。
 */
export function readOptionalJson<T>(path: string): T | undefined {
  return readOptionalJsonWithStatus<T>(path).value;
}

/** E7-I7 修复：带状态返回，区分 missing vs corrupt */
export function readOptionalJsonWithStatus<T>(
  path: string
): { value: T | undefined; status: 'missing' | 'corrupt' | 'ok'; error?: string } {
  if (!existsSync(path)) return { value: undefined, status: 'missing' };
  try {
    return { value: JSON.parse(readFileSync(path, 'utf-8')) as T, status: 'ok' };
  } catch (err) {
    return {
      value: undefined,
      status: 'corrupt',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** 写 JSON（确保目录存在） */
export function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * E11：从项目根读取 bindings.yaml（YAML），尽量宽松（兼容 protochain.config.yaml 内联）。
 * - 优先 <rootDir>/bindings.yaml
 * - 次选 <rootDir>/protochain.config.yaml 的 bindings 段
 * 不存在则返回 undefined（兼容老协议/无 bindings）。
 *
 * 本函数已被 webgen 用来构造 binding 视图。
 * 读取后必须经 redactSensitiveFields 处理（authConfig/tls 密钥段）。
 */
export function readBindingsFileSafely(rootDir: string): BindingConfig | undefined {
  const y1 = readYamlBindings(join(rootDir, 'bindings.yaml'));
  if (y1) return y1;
  const y2 = readYamlBindings(join(rootDir, 'derived', 'bindings.yaml'));
  if (y2) return y2;
  const cfg = readProtochainConfigBindings(rootDir);
  if (cfg) return cfg;
  // #008 补充：多协议项目 rootDir 为协议根（protocol/<Pn>）时，共享 bindings.yaml
  // 在系统根——向上定位 protochain.config.yaml，读其 bindingsFile（或内联 bindings 段）。
  const configPath = findConfigPath(rootDir);
  if (configPath) {
    const systemRoot = dirname(configPath);
    const rootCfg = readProtochainConfigBindings(systemRoot);
    if (rootCfg) return rootCfg;
    const rootBf = readConfigBindingsFile(systemRoot);
    if (rootBf) return rootBf;
  }
  return undefined;
}

/** 读系统根 protochain.config.yaml 的 bindingsFile（如 bindings.yaml）指向的绑定文件 */
function readConfigBindingsFile(systemRoot: string): BindingConfig | undefined {
  const cfgPath = join(systemRoot, 'protochain.config.yaml');
  if (!existsSync(cfgPath)) return undefined;
  try {
    const { parseYaml } = requireYaml();
    const obj = parseYaml(readFileSync(cfgPath, 'utf-8')) as
      | { bindingsFile?: string }
      | null
      | undefined;
    const bf = obj?.bindingsFile;
    if (!bf || typeof bf !== 'string') return undefined;
    return readYamlBindings(join(systemRoot, bf));
  } catch {
    return undefined;
  }
}

function readYamlBindings(path: string): BindingConfig | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, 'utf-8');
    const { parseYaml } = requireYaml();
    const obj = parseYaml(raw);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      return obj as BindingConfig;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function readProtochainConfigBindings(rootDir: string): BindingConfig | undefined {
  const cfgPath = join(rootDir, 'protochain.config.yaml');
  if (!existsSync(cfgPath)) return undefined;
  try {
    const raw = readFileSync(cfgPath, 'utf-8');
    const { parseYaml } = requireYaml();
    const obj = parseYaml(raw);
    if (obj && typeof obj === 'object' && (obj as Record<string, unknown>).bindings) {
      return (obj as Record<string, unknown>).bindings as BindingConfig;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** 延迟加载 yaml 包（避免 webgen 加载链膨胀） */
let _yamlRef: { parseYaml: (s: string) => unknown } | null = null;
function requireYaml(): { parseYaml: (s: string) => unknown } {
  if (_yamlRef) return _yamlRef;
  // ESM 上下文（package.json type=module）下顶层 `require` 未定义；
  // 改用顶层 ESM import `yaml` 即可在 CLI/serve/feedback 任意入口（编译产物 ESM）
  // 都能解析 yaml 包；不再使用 createRequire(import.meta.url)，
  // 避免 ts-jest 默认 CJS transform 模式下 import.meta 触发 SyntaxError（修改单 #008 缺陷 2）。
  const yaml = yamlModule;
  _yamlRef = {
    parseYaml: (s: string) => yaml.parse(s),
  };
  return _yamlRef;
}

/** 写文本 */
export function writeText(path: string, content: string): void {
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, content, 'utf-8');
}

/**
 * 确保 webDir 下安装了 vitepress（站点工程的 devDep）
 *
 * 背景：web/package.json 已声明 vitepress ^1.6.3 作为 devDependency；
 * 用户 `rm -rf web` 或初次使用时 vitepress 不在 node_modules 里，
 * 直接 `npx vitepress build` 会抛 `Cannot find package 'vitepress'`。
 *
 * 行为：
 * - 检测 webDir/node_modules/vitepress/package.json 存在性
 * - 不存在时 spawnSync `npm install --no-audit --no-fund --silent vitepress ^1.6.3`
 *   自动注入到 web/package.json（若缺失）；超时 5 分钟
 * - 失败抛错（不静默兜底——vitepress 没装就没法构建）
 *
 * 返回 warnings（用于 CLI 报告安装状态）。
 */
export async function ensureVitepressInstalled(
  webDir: string,
  warnings: string[]
): Promise<void> {
  const vitepressModule = join(webDir, 'node_modules', 'vitepress', 'package.json');
  if (existsSync(vitepressModule)) return; // 已装

  const pkgPath = join(webDir, 'package.json');
  let needWritePackageJson = !existsSync(pkgPath);
  let pkg: {
    name?: string;
    type?: string;
    devDependencies?: Record<string, string>;
    [k: string]: unknown;
  } = {};
  if (!needWritePackageJson) {
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    } catch {
      // package.json 损坏 → 重建
      needWritePackageJson = true;
    }
  }
  if (!pkg.devDependencies) pkg.devDependencies = {};
  if (!pkg.devDependencies.vitepress) {
    pkg.devDependencies.vitepress = '^1.6.3';
    needWritePackageJson = true;
  }
  if (!pkg.name) pkg.name = 'protochain-web';
  if (!pkg.type) pkg.type = 'module';
  if (needWritePackageJson) {
    mkdirSync(webDir, {recursive: true});
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf-8');
  }

  warnings.push(`首次运行检测到 vitepress 未安装，自动 npm install（web/package.json 已含 devDep）`);
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync('npm install --no-audit --no-fund --silent', {
    cwd: webDir,
    encoding: 'utf-8',
    shell: true,
    timeout: 300000, // 5 分钟（vitepress + vue + 大量依赖首次安装可能慢）
  });
  if (result.status !== 0) {
    throw new Error(
      `vitepress 自动安装失败（webDir=${webDir}）：${(result.stderr ?? '').slice(0, 500)}`
    );
  }
  if (!existsSync(vitepressModule)) {
    throw new Error(
      `vitepress 自动安装完成但仍未找到（webDir=${webDir}）；请手动 \`cd ${webDir} && npm install\``
    );
  }
}

// ============================================================================
// VitePress 页面生成（.md）
// ============================================================================

/** 渲染 Markdown 表格（人读） */
function renderTable(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return '*(无)*';
  const lines: string[] = [];
  lines.push(`| ${headers.map(escapeMdCell).join(' | ')} |`);
  lines.push(`| ${headers.map(() => '---').join(' | ')} |`);
  for (const r of rows) {
    lines.push(`| ${r.map((c) => escapeMdCell(String(c))).join(' | ')} |`);
  }
  return lines.join('\n');
}

/**
 * 转义 markdown 单元格中的管道符和 HTML 标签字符。
 * 类型串（如 `array<object>`）含 `<`/`>`，直接渲染会被 markdown-it 解析成
 * 未闭合 HTML 标签，导致 VitePress build 失败（修改单 #008 缺陷 3）。
 */
function escapeMdCell(s: string): string {
  return s
    .replace(/\|/g, '\\|')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 渲染 JSON Schema 为人读表格（properties 列表）
 *
 * 008-6：currentState 字段 CAS 标注
 * - 仅当 schema 含 `currentState` 属性时附加「CAS 断言」说明列；
 * - 状态转移接口（kind=system + actionType=state_transition）：CAS 是真实入参，断言
 *   "资源当前状态 == currentState 才允许转移"（hsk-ng Disable/Enable/Delete）；
 * - 观测接口（kind=observation 或 system/attribute_update）：CAS 多余但无害，impl
 *   不读取该字段；纯读/观测接口在 web 展示加「CAS 断言（impl 不读取）」标注。
 * - 契约承载接口（isContractCarrier=true）：契约层自带 requestSchema 通常不含 currentState，
 *   此参数化函数对 currentState 列保持默认（无附加标注）。
 */
function renderSchemaTable(
  schema: JSONSchema | undefined,
  ifaceKind: 'system' | 'observation',
  actionType: 'state_transition' | 'attribute_update' | undefined,
  isContractCarrier: boolean | undefined
): string {
  if (!schema?.properties) return '*(无 schema)*';
  const isStateTransition = ifaceKind === 'system' && actionType === 'state_transition';
  const isObservation = ifaceKind === 'observation';
  const rows = Object.entries(schema.properties).map(([k, v]) => {
    const required = schema.required?.includes(k) ? '✓' : '';
    let desc = v.description ?? '';
    // E11 后续问题 6：currentState CAS 标注
    if (k === 'currentState') {
      if (isStateTransition) {
        desc = `${desc ? desc + '\n' : ''}\`CAS 断言\`：状态转移前置校验（resource 实际状态 == currentState 才执行；hsk-ng Disable/Enable/Delete 走 Disable/Enable/Delete(ctx, ownerID, id, req.CurrentState)）。`;
      } else if (isObservation) {
        desc = `${desc ? desc + '\n' : ''}\`CAS 断言（impl 不读取）\`：纯读/观测接口 impl 不使用 currentState；specs 必填仅用于契约对齐，verify 仍会注入（多余但无害）。`;
      } else if (!isContractCarrier) {
        desc = `${desc ? desc + '\n' : ''}\`CAS 断言\`：模型要求；impl 可容忍 currentState=="" 时取实体实际状态。`;
      }
    }
    return [k, v.type ?? 'any', desc, required];
  });
  return renderTable(['字段', '类型', '说明', '必填'], rows);
}

/** 生成首页 index.md */
function renderIndexPage(data: WebDataJson): string {
  const { protocol, interfaces, testCases, verification } = data;
  const sysCount = interfaces.filter((i) => i.kind === 'system').length;
  const obsCount = interfaces.filter((i) => i.kind === 'observation').length;
  const passed = verification.counts.passed;
  const failed = verification.counts.failed;
  return `# ${protocol.name}

> 协议版本：**${protocol.version}** | 检阅时间：${data.generatedAt}

${protocol.purpose}

## 总览

| 指标 | 值 |
| --- | --- |
| 角色数 | ${protocol.roles.length} |
| 系统接口 | ${sysCount} |
| 观测接口 | ${obsCount} |
| 测试用例 | ${testCases.length} |
| 验证通过 / 失败 | ${passed} / ${failed} |

## 快速跳转

- [接口列表](interfaces/) — ${interfaces.length} 个接口的请求/响应结构与守卫
- [测试用例浏览器](test-cases) — 路径覆盖度与偏差
- [验证报告对比](verification) — legacy vs impl 双跑对账
- [模型 diff / impact](diff) — 变更 → 受影响步骤/产物

## 状态机图（mermaid）

\`\`\`mermaid
${data.stateMachine.mermaid}
\`\`\`

> 复制上述 mermaid 段落到 <https://mermaid.live> 可渲染。

## 角色

${renderTable(
  ['ID', '名称', '类型'],
  protocol.roles.map((r) => [r.id, r.name, r.roleType ?? '—']),
)}

## 安全边界

${data.redactionNotice.map((n) => `- ${n}`).join('\n')}
`;
}

/** 生成接口列表 index.md（interfaces/index.md） */
function renderInterfacesIndexPage(data: WebDataJson): string {
  const rows = data.interfaces.map((i) => {
    const kindLabel = i.kind === 'system' ? '系统' : '观测';
    const actionType = i.actionType ?? (i.kind === 'observation' ? 'observe' : 'state_transition');
    const schemaKind = i.schemaKind ?? '—';
    return [
      `[${i.id}](${i.id})`,
      i.name,
      kindLabel,
      actionType,
      schemaKind,
    ];
  });
  return `# 接口列表

> 共 ${data.interfaces.length} 个接口（系统 ${data.interfaces.filter((i) => i.kind === 'system').length} + 观测 ${data.interfaces.filter((i) => i.kind === 'observation').length}）

${renderTable(['ID', '名称', '类型', '动作类型', 'schemaKind'], rows)}
`;
}

/** 生成单个接口详情 .md */
function renderInterfaceDetailPage(view: WebInterfaceView): string {
  const parts: string[] = [];
  parts.push(`# ${view.name}\n`);
  parts.push(`> 接口 ID: \`${view.id}\` | 类型: **${view.kind === 'system' ? '系统' : '观测'}**${
    view.actionType ? ` | 动作类型: \`${view.actionType}\`` : ''
  } | schemaKind: **${view.schemaKind ?? '—'}**\n`);
  // E11 后续问题 5：契约承载接口标注
  if (view.isContractCarrier) {
    parts.push(
      '> **承载接口（contract-carrier）**：契约 interface 未匹配任何 transition.id/action；'
      + 'requestSchema/responseSchema/errorResponses 由契约层直接投影，不参与状态机推演。'
      + '（详见 envelope.migrationWarnings）\n'
    );
  }
  if (view.schemaDegradedReasons && view.schemaDegradedReasons.length > 0) {
    parts.push('## 降级理由\n');
    for (const r of view.schemaDegradedReasons) parts.push(`- ${r}`);
    parts.push('');
  }
  parts.push('## 请求参数 (requestSchema)\n');
  parts.push(renderSchemaTable(view.requestSchema, view.kind, view.actionType, view.isContractCarrier));
  parts.push('');
  parts.push('## 响应体 (responseSchema)\n');
  parts.push(renderSchemaTable(view.responseSchema, view.kind, view.actionType, view.isContractCarrier));
  parts.push('');
  // E11：错误响应契约表（接口详情"错误响应"段）
  if (view.errorResponses && view.errorResponses.length > 0) {
    parts.push('## 错误响应 (errorResponses)\n');
    parts.push(renderErrorResponsesTable(view.errorResponses));
    parts.push('');
  }
  if (view.preconditions && view.preconditions.length > 0) {
    parts.push('## 前置条件 (preconditions)\n');
    for (const p of view.preconditions) {
      parts.push(`- kind=\`${p.kind}\`：${p.description ?? ''}${p.schema ? ` / schema=${JSON.stringify(p.schema)}` : ''}`);
    }
    parts.push('');
  }
  if (view.postconditionExpressions && view.postconditionExpressions.length > 0) {
    parts.push('## 后置条件 (postconditionExpressions)\n');
    for (const p of view.postconditionExpressions) {
      parts.push(`- ${p.description ?? p.kind}`);
    }
    parts.push('');
  }
  if (view.postconditions && view.postconditions.length > 0) {
    parts.push('## 副作用描述 (postconditions)\n');
    for (const p of view.postconditions) parts.push(`- ${p}`);
    parts.push('');
  }
  if (view.invariantIds && view.invariantIds.length > 0) {
    parts.push('## 关联不变量\n');
    for (const id of view.invariantIds) parts.push(`- ${id}`);
    parts.push('');
  }
  return parts.join('\n');
}

/** E11：渲染错误响应表 */
function renderErrorResponsesTable(errors: ErrorResponseDef[]): string {
  const rows = errors.map((er) => {
    const bodySchema = er.bodySchema ? '`已定义`' : '—';
    return [er.id, er.errorCode, String(er.httpStatus), bodySchema, er.description ?? ''];
  });
  return renderTable(['ID', '错误码', 'HTTP Status', 'bodySchema', '说明'], rows);
}

/** 生成 bindings.md（E11：绑定视图——错误响应/传输绑定表/错误映射表） */
export function renderBindingViewPage(data: WebDataJson): string {
  const b = data.binding;
  // 脱敏说明（运行时拼接，避免 `${...}` 字面残留被 VitePress 的 vue 编译误解析）
  const redactionNotice =
    REDACTION_NOTICE_LINES.length > 0 ? `（${REDACTION_NOTICE_LINES[0]}）` : '';
  if (!b || !b.hasBindings) {
    return `# 绑定视图（E11）

> 未读取到 bindings.yaml。本页面仅在 \`<rootDir>/bindings.yaml\` 或
> \`protochain.config.yaml#bindings\` 存在时填充。

非敏感投影子集（roles baseUrl/headers + interfaces transport + errorMap）：
见各接口详情页"绑定视图"段。

## 安全边界

- 不读取 authConfig.tokenEnv/secretEnv/passwordEnv
- 不读取 tls.caFile/keyPath/certPath
- 仅 transport/errorMap/stateMap 入站
`;
  }
  const rolesRows = b.roles.map((r) => [
    r.roleId,
    r.baseUrl ?? '—',
    r.authKind ?? '—',
    String(r.headers ? Object.keys(r.headers).length : 0),
  ]);
  const ifaceRows = b.interfaces.map((i) => [
    i.action,
    i.roleId ?? '—',
    i.protocol ?? '—',
    i.transport?.type ?? '—',
    i.transport?.method ?? '—',
    i.transport?.path ?? '—',
  ]);
  const stateMapRows = b.stateMap ? Object.entries(b.stateMap).map(([k, v]) => [k, String(v)]) : [];
  const errorMapRows = b.errorMap ? Object.entries(b.errorMap).map(([code, e]) => [
    code,
    String(e.httpStatus ?? '—'),
    String(e.systemCode ?? '—'),
    String(e.bodyField ?? 'code'),
    String(e.bodyFieldValue ?? '—'),
    String(e.messageField ?? '—'),
  ]) : [];
  const unmappedRows = (b.unmappedErrorCodes ?? []).map((c) => [c]);

  return `# 绑定视图（E11）

> 安全边界：仅展示非敏感投影子集（roles baseUrl/headers + interfaces transport + errorMap）。
> authConfig/tls 密钥段不读取。${redactionNotice}

## 角色绑定

${renderTable(['roleId', 'baseUrl', 'auth', 'headers 数'], rolesRows.length > 0 ? rolesRows : [['(无)', '—', '—', '—']])}

## 接口绑定（transport）

${renderTable(['action', 'roleId', 'protocol', 'type', 'method', 'path'], ifaceRows.length > 0 ? ifaceRows : [['(无)', '—', '—', '—', '—', '—']])}

## 状态词表 (stateMap)

${stateMapRows.length > 0
  ? renderTable(['协议状态 ID', '系统状态值'], stateMapRows)
  : '*(无)*'}

## 错误映射表 (errorMap)

${errorMapRows.length > 0
  ? renderTable(['错误码', 'httpStatus', 'systemCode', 'bodyField', 'bodyFieldValue', 'messageField'], errorMapRows)
  : '*(无)*'}

## 缺绑错误码 (unmappedErrorCodes)

${unmappedRows.length > 0
  ? renderTable(['错误码'], unmappedRows)
  : '*(无 — 所有错误码均已绑定)*'}

## 警告

${b.warnings.length > 0 ? b.warnings.map((w) => `- ${w}`).join('\n') : '*(无)*'}

## 异常路径

${
  data.exceptionPaths && data.exceptionPaths.length > 0
    ? renderTable(
        ['ID', '名称', '错误码'],
        data.exceptionPaths.map((e) => [
          e.id,
          e.name,
          e.errorCode ?? '—',
        ])
      )
    : '*(无)*'
}
`;
}

/** 生成 test-cases.md（导出：组合层复用生成子协议具体信息页） */
export function renderTestCasesPage(data: WebDataJson): string {
  const rows = data.testCases.map((tc) => {
    const passed = tc.verificationPassed === true ? '✓' : tc.verificationPassed === false ? '✗' : '?';
    const skipped = tc.verificationSkipped ? '(跳过)' : '';
    const deviations = tc.deviations.length;
    return [
      tc.id,
      String(tc.length),
      tc.stateIds.join(' → '),
      tc.transitionIds.join(','),
      tc.hasException ? '是' : '否',
      `${passed}${skipped}`,
      String(deviations),
    ];
  });
  return `# 测试用例浏览器

> 共 ${data.testCases.length} 条路径用例。

${renderTable(
  ['ID', '长度', '状态序列', '转移序列', '含异常', '验证', '偏差数'],
  rows,
)}

## 偏差详情（按用例分组）

${data.testCases
  .filter((tc) => tc.deviations.length > 0)
  .map((tc) => {
    const devTable = renderTable(
      ['动作', '状态', '类型', '期望', '实际', '字段'],
      tc.deviations.map((d) => [d.action, d.state, d.kind, d.expected, d.actual, d.field ?? '—']),
    );
    return `### ${tc.id}\n\n${devTable}`;
  })
  .join('\n\n') || '*（所有用例均无偏差）*'}
`;
}

/** 生成 verification.md */
export function renderVerificationPage(data: WebDataJson): string {
  const v = data.verification;
  const s = v.deviationSummary;
  const rows: string[][] = [];
  rows.push(['state_mismatch', String(s.stateMismatch)]);
  rows.push(['field_mismatch', String(s.fieldMismatch)]);
  rows.push(['missing_action', String(s.missingAction)]);
  rows.push(['invariant_violation', String(s.invariantViolation)]);
  rows.push(['timing_violation', String(s.timingViolation)]);
  rows.push(['error_mismatch', String(s.errorMismatch)]);
  rows.push(['unexpected_error', String(s.unexpectedError)]);
  rows.push(['other', String(s.other)]);
  const sbRows = v.sideBySide.map((r) => [
    r.action,
    r.state,
    r.field,
    r.legacy,
    r.impl,
    r.matched ? '✓' : '✗',
  ]);
  const errorSummarySection = v.errorSummary
    ? renderErrorSummarySection(v.errorSummary)
    : '*(errorMap 未配置或未触发错误场景)*';
  return `# 验证报告对比（legacy vs impl）

> 报告是否可用：${v.hasReport ? '是' : '否'} | 总体：${v.passed ? '✓ 通过' : '✗ 未通过'}
> 通过 / 失败 / 跳过：${v.counts.passed} / ${v.counts.failed} / ${v.counts.skipped}
${v.verifiedAt ? `> 验证时间：${v.verifiedAt}\n` : ''}

## 偏差分类统计

${renderTable(['类型', '数量'], rows)}

## 错误契约验证（E11）

${errorSummarySection}

## 双跑对账（legacy vs impl 并排）

${renderTable(
    ['动作', '状态', '字段', 'legacy', 'impl', '一致'],
    sbRows,
  )}
`;
}

/** E11：错误契约验证汇总段 */
function renderErrorSummarySection(s: NonNullable<WebVerificationView['errorSummary']>): string {
  const matchedRows = Object.entries(s.matched).map(([code, count]) => [
    code,
    String(count),
    String(s.expected?.[code] ?? 0),
  ]);
  const unmappedRows = s.unmapped.map((u) => [
    u.action,
    String(u.httpStatus ?? '—'),
    String(u.protocolErrorCode ?? '—'),
  ]);
  let out = `> matched=${Object.values(s.matched).reduce((a, b) => a + b, 0)} | unmapped=${s.unmapped.length} | systemFault=${s.systemFault}\n\n`;
  out += '### 命中 errorMap（按错误码聚合）\n\n';
  out += renderTable(['错误码', '命中次数', 'expected 命中'], matchedRows.length > 0 ? matchedRows : [['(无)', '—', '—']]);
  out += '\n\n';
  if (unmappedRows.length > 0) {
    out += '### 未命中 errorMap（error_mismatch 偏差）\n\n';
    out += renderTable(['动作', 'HTTP Status', '实际 errorCode'], unmappedRows);
    out += '\n';
  }
  return out;
}

/** 生成 diff.md */
export function renderDiffPage(data: WebDataJson): string {
  const d = data.diff;
  const i = data.impact;
  if (!d) {
    return `# 模型 diff / impact

> 未检测到 model-diff.json（请先运行 \`protochain diff\`）。

如需触发差异，运行：

\`\`\`bash
protochain version save
# 改 model.md
protochain version save
protochain diff
protochain derive-web
\`\`\`
`;
  }
  const mdRows = d.metadataChanges.map((c) => [c.path, c.kind, c.oldValue ?? '—', c.newValue ?? '—']);
  const rdRows = d.readableChanges.map((c) => [c.path, c.kind, c.oldValue ?? '—', c.newValue ?? '—']);
  const drRows = d.derivableChanges.map((c) => [c.elementType, c.elementId, c.kind]);
  return `# 模型 diff / impact

> 摘要：${d.summary}
> 差分时间：${d.diffedAt}

## 元数据层变更

${renderTable(['路径', '类型', '旧值', '新值'], mdRows)}

## 可读层变更

${renderTable(['路径', '类型', '旧值', '新值'], rdRows)}

## 可推演层变更

${renderTable(['元素类型', '元素 ID', '类型'], drRows)}

${
  i
    ? `## 影响分析

> 分析时间：${i.analyzedAt}

### 受影响步骤

${i.affectedSteps.length > 0 ? i.affectedSteps.map((s) => `- ${s}`).join('\n') : '*（无）*'}

### 受影响产物

${i.affectedArtifacts.length > 0 ? i.affectedArtifacts.map((s) => `- ${s}`).join('\n') : '*（无）*'}

### 增量重推导路径

${i.incrementalPlan.length > 0 ? i.incrementalPlan.join(' → ') : '*（无）*'}

### 人读映射（变更 → 受影响步骤）

${
  i.humanReadable.length > 0
    ? i.humanReadable
        .map(
          (h) => `- **${h.trigger}** → ${h.affected.length > 0 ? h.affected.join(', ') : '(无)'}`
        )
        .join('\n')
    : '*（无）*'
}
`
    : ''
}
`;
}

// ============================================================================
// VitePress 配置文件生成
// ============================================================================

/** 生成 VitePress config.ts（站点工程配置） */
function renderVitePressConfig(): string {
  return `import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'Protochain Review',
  description: '协议驱动自验证工具链 — 模型检阅界面',
  cleanUrls: true,
  srcDir: '.',
  ignoreDeadLinks: true,
  // 不启用搜索框的索引构建（保持构建轻量）
  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      { text: '接口', link: '/interfaces/' },
      { text: '测试用例', link: '/test-cases' },
      { text: '验证报告', link: '/verification' },
      { text: 'diff/impact', link: '/diff' },
    ],
    sidebar: [
      {
        text: '接口',
        items: [{ text: '列表', link: '/interfaces/' }],
      },
      {
        text: '检阅',
        items: [
          { text: '测试用例', link: '/test-cases' },
          { text: '验证报告', link: '/verification' },
          { text: 'diff/impact', link: '/diff' },
        ],
      },
    ],
    socialIcons: [],
    footer: {
      message: '由 protochain derive-web 机械生成',
      copyright: 'Generated at ' + new Date().toISOString(),
    },
  },
});
`;
}

/** 生成 web/package.json（站点工程独立；vitepress 仅 devDep） */
function renderWebPackageJson(): string {
  return JSON.stringify(
    {
      name: 'protochain-web',
      version: '0.1.0',
      private: true,
      type: 'module',
      description: 'Protochain Web 检阅界面（VitePress 站点）',
      scripts: {
        'docs:dev': 'vitepress dev docs',
        'docs:build': 'vitepress build docs',
        'docs:preview': 'vitepress preview docs',
      },
      devDependencies: {
        vitepress: '^1.6.3',
      },
    },
    null,
    2,
  );
}

// ============================================================================
// 主入口
// ============================================================================

/**
 * 推导出 web 站点数据 + 静态页面（CLI 入口）
 *
 * 不直接执行 VitePress build；由 caller 决定是否调 buildSite。
 * 若 buildSite=true → spawnSync npx vitepress build。
 */
export async function deriveWeb(
  options: DeriveWebOptions,
  parseModel: (rootDir: string) => SourceProtocolModel
): Promise<DeriveWebResult> {
  const rootDir = options.rootDir;
  const dataJsonPath = options.dataJsonPath ?? join(rootDir, 'web/data.json');
  const webDir = options.webDir ?? join(rootDir, 'web');
  const docsDir = join(webDir, 'docs');
  const publicDir = join(docsDir, 'public');
  const interfacesDir = join(docsDir, 'interfaces');
  const distDir = options.distDir ?? join(docsDir, '.vitepress/dist');

  const warnings: string[] = [];

  // 1. 读取 specs.json（Envelope 形态）
  const specsPath = join(rootDir, 'derived/specs.json');
  if (!existsSync(specsPath)) {
    throw new Error(
      `specs.json 不存在: ${specsPath}（请先运行 protochain derive-specs）`
    );
  }
  const rawSpecs = JSON.parse(readFileSync(specsPath, 'utf-8')) as unknown;
  let envelope: SpecsEnvelope;
  if (isSpecsEnvelope(rawSpecs)) {
    envelope = rawSpecs;
  } else if (Array.isArray(rawSpecs)) {
    // 老格式 → 自动 migrate
    const r = envelopeMigrate(rawSpecs, 'unknown');
    for (const w of r.warnings) warnings.push(`[specs.json] ${w}`);
    envelope = r.envelope;
  } else {
    throw new Error('specs.json 形态无法识别（既不是 Envelope 也不是裸数组）');
  }

  // 2. 读取 model.md（仅取元数据 + 状态机）
  const model = parseModel(rootDir);

  // 3. 读取可选产物（E7-I7 修复：区分 missing vs corrupt）
  const tcR = readOptionalJsonWithStatus<TestCaseSet>(join(rootDir, 'derived/test-cases.json'));
  const vfR = readOptionalJsonWithStatus<VerificationReport>(join(rootDir, 'derived/verification/verification-report.json'));
  const icR = readOptionalJsonWithStatus<ImplCheckReport>(join(rootDir, 'derived/impl-check/impl-check-report.json'));
  const dfR = readOptionalJsonWithStatus<ModelDiff>(join(rootDir, 'derived/diff/model-diff.json'));
  const imR = readOptionalJsonWithStatus<ImpactAnalysis>(join(rootDir, 'derived/impact-analysis.json'));
  // G7-V3（webgen 数据层扩展）：storage.schema.json（S3 derive-storage 产物，可选）。
  // 缺省（老模型未运行 derive-storage）→ storage 视图缺省，字段不出现（零回归）。
  const storageR = readOptionalJsonWithStatus<StorageSchema>(join(rootDir, 'derived/storage.schema.json'));
  const testCases = tcR.value;
  const verification = vfR.value;
  const implCheck = icR.value;
  const diff = dfR.value;
  const impact = imR.value;
  const storage = storageR.value;
  for (const [name, r] of [
    ['derived/test-cases.json', tcR] as const,
    ['derived/verification/verification-report.json', vfR] as const,
    ['derived/impl-check/impl-check-report.json', icR] as const,
    ['derived/diff/model-diff.json', dfR] as const,
    ['derived/impact-analysis.json', imR] as const,
  ]) {
    if (r.status === 'missing') {
      const msg =
        name === 'derived/diff/model-diff.json'
          ? `未找到 ${name}；diff 页将显示"无差异"`
          : `未找到 ${name}；对应页面将空`;
      warnings.push(msg);
    } else if (r.status === 'corrupt') {
      warnings.push(`${name} 存在但 JSON 解析失败（${r.error}）；对应页面将空`);
    }
  }

  // E11：读取 bindings.yaml（bindingsFile 或 协议内 bindings.yaml）
  const bindingsRaw = readBindingsFileSafely(rootDir);
  let bindingsConfig: BindingConfig | undefined;
  if (bindingsRaw) {
    // E11 红线：authConfig/tls 密钥段不读取 → redactSensitiveFields 兜底
    bindingsConfig = redactSensitiveFields(bindingsRaw) as BindingConfig;
    if (bindingsConfig) warnings.push('bindings.yaml 已读取（仅非敏感投影子集）');
  }

  // 4. 构造 WebDataJson
  let data = buildWebData({
    specsEnvelope: envelope,
    model,
    testCases,
    verification,
    implCheck,
    diff,
    impact,
    bindings: bindingsConfig,
    storage,
  });

  // 5. 防御性：redact sensitive fields（即使上游不慎写入）
  data = redactSensitiveFields(data) as WebDataJson;

  // E7-I8 修复：--force 检查（在所有写出之前；已存在产物时未传 force → 抛错）
  // W1-a（TB1）：relations.json 与 data.json 同批写出，force 语义对齐
  const relationsJsonPath = join(rootDir, 'derived/relations.json');
  if (!options.force && (existsSync(dataJsonPath) || existsSync(relationsJsonPath))) {
    throw new Error(
      `web 产物已存在（${dataJsonPath} 或 ${relationsJsonPath}）；如需覆盖请传 --force`
    );
  }

  // 6. 写出 web/data.json
  writeJson(dataJsonPath, data);
  // 6.1 写出 derived/relations.json（W1-a：与 data.json 同批机械投影，sourceModelVersion 同源）
  writeJson(relationsJsonPath, buildRelations(model));
  // 7. 写出 web/docs/public/data.json（站点工程副本）
  writeJson(join(publicDir, 'data.json'), data);

  // 8. 写出 VitePress 站点配置
  mkdirSync(join(docsDir, '.vitepress'), { recursive: true });
  writeText(join(docsDir, '.vitepress/config.ts'), renderVitePressConfig());

  // 9. 写出 web/package.json（站点工程独立）
  writeText(join(webDir, 'package.json'), renderWebPackageJson());

  // 10. 写出页面 .md
  writeText(join(docsDir, 'index.md'), renderIndexPage(data));
  mkdirSync(interfacesDir, { recursive: true });
  writeText(join(interfacesDir, 'index.md'), renderInterfacesIndexPage(data));
  for (const view of data.interfaces) {
    writeText(join(interfacesDir, `${view.id}.md`), renderInterfaceDetailPage(view));
  }
  writeText(join(docsDir, 'test-cases.md'), renderTestCasesPage(data));
  writeText(join(docsDir, 'verification.md'), renderVerificationPage(data));
  writeText(join(docsDir, 'diff.md'), renderDiffPage(data));
  writeText(join(docsDir, 'bindings.md'), renderBindingViewPage(data));

  // 11. VitePress build（spawnSync npx；不强制成功，失败时 warnings 报告）
  let built = false;
  if (options.buildSite !== false) {
    // B1-I6 修复：vitepress 不在 node_modules 时自动 npm install（防 rm -rf web 后报错）
    await ensureVitepressInstalled(webDir, warnings);
    const { spawnSync } = await import('node:child_process');
    const cmd = `npx --yes vitepress build docs`;
    const result = spawnSync(cmd, {
      cwd: webDir,
      encoding: 'utf-8',
      shell: true,
      timeout: 180000,
    });
    if (result.status !== 0) {
      warnings.push(
        `vitepress build 退出码 ${result.status}（stderr: ${(result.stderr ?? '').slice(0, 500)}）`
      );
    } else if (existsSync(join(distDir, 'index.html'))) {
      built = true;
    } else {
      warnings.push(`vitepress build 完成但未产出 dist/index.html（cwd=${webDir}）`);
    }
  }

  return {
    data,
    dataJsonPath,
    webDir,
    distDir,
    built,
    warnings,
  };
}