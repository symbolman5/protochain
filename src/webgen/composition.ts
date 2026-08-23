/**
 * E7-B1 组合层视图 —— 项目级只读机械检阅（v0.3，2026-08-23）
 *
 * 设计依据：IMPLEMENTATION-PLAN.md §E7 v0.4（组合层视图 B1）
 *
 * v0.2 修复（B1-I1 ~ B1-I3）：
 * - B1-I1：删除死代码 composeDataWithProject；组合层 WebDataJson 顶层新增
 *   schemaVersion='1.1' + generatedAt；消费方按 schemaVersion 区分模式
 *   （1.0=单协议 / 1.1=组合层）
 *
 * v0.3 新增（B1-E11：E11 错误断言/绑定视图在组合层接口详情页落表）：
 * - 错误响应契约表：来自 specs.json envelope 的 InterfaceSpec.errorResponses
 * - 绑定视图段：复用单协议 webgen 的 readBindingsFileSafely（已支持向上定位
 *   系统根 bindings.yaml）+ redactSensitiveFields 兜底 + buildBindingView
 *   非敏感投影子集，按接口过滤（transport/errorMap/stateMap/unmappedErrorCodes）
 * - 不读取 authConfig/tls 密钥段；不读取 process.env；不引入新模块依赖
 *
 * 职责（100% 机械、无 AI、不读 process.env；B1-E11 后有限读 bindings.yaml）：
 * 1. 读 protocol/composition.md → CompositionModel（复用 composition-parser，不重写）
 * 2. 逐子协议读 protocol/<Pn>/derived/specs.json（走 envelopeMigrate 老格式兼容）
 * 3. 跨协议引用提取：机械正则匹配 guard/字段描述/不变量表达式中的
 *    `（Pn ...）` / `Pn.xxx`（参照 E1-I2 跨协议引用识别口径）
 * 4. 构造组合层 WebDataJson（顶层 protocols / dependencyGraph / crossRefs /
 *    invariantSpans 字段）
 * 5. 渲染组合层页面（project.md / cross-refs.md / cross-diff.md 骨架 +
 *    每协议接口详情页叠加跨协议引用小节 + 错误响应表 + 绑定视图段）
 *
 * 与既有 webgen 的关系：
 * - 单协议模式（无 composition.md 且无 --project）行为不变（无回归）
 * - 组合层模式（--project）通过顶层 schemaVersion='1.1' + 4 类组合页面与单协议区分
 * - redactSensitiveFields 复用（不接触 authConfig 等敏感字段）
 *
 * 不在 B1 范围（明确防范围蔓延，IMPLEMENTATION-PLAN.md §E7 v0.4）：
 * - E9 跨协议 diff 分析逻辑（cross-diff.md 仅骨架页"待 E9 接通"）
 * - P1 在线编辑 / Express / Fastify / 写回权威源
 * - 不修改 composition.md / 各子协议 derived/*.json / model.md
 * - 不引入 mermaid runtime（沿用 E7-P0：预生成 mermaid 源码）
 * - data.json 不携带 bindings 字段（绑定视图仅在接口详情页展示；完整绑定
 *   视图仍在单协议 webgen 的 bindings.md；B1 强调组合层 data.json 轻量化）
 */

import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { parseCompositionFile } from '../composition-parser/index.js';
import { parseProtocolFile } from '../parser/index.js';
import {
  envelopeMigrate,
  isSpecsEnvelope,
  type SpecsEnvelope,
} from '../specifier/envelope.js';
import type {
  CompositionModel,
  SubProtocolRef,
  DependencyEdge,
  CrossInvariantDef,
} from '../model/types.js';
import type {
  InterfaceSpec,
  FieldSpec,
  ErrorResponseDef,
  SourceProtocolModel,
  BindingConfig,
  TestCaseSet,
  VerificationReport,
  ImplCheckReport,
  ModelDiff,
  ImpactAnalysis,
} from '../model/types.js';
import {
  redactSensitiveFields,
  writeJson,
  writeText,
  ensureVitepressInstalled,
  readBindingsFileSafely,
  readOptionalJson,
  buildBindingView,
  buildWebData,
  renderTestCasesPage,
  renderVerificationPage,
  renderDiffPage,
  renderBindingViewPage,
  type WebBindingView,
} from './index.js';

// ============================================================================
// 类型定义
// ============================================================================

/** 跨协议引用类型（E1-I2 跨协议引用识别口径） */
export type CrossRefKind = 'guard' | 'field' | 'invariant' | 'shared';

/** 一条跨协议引用 */
export interface CrossProtocolRef {
  /** 源协议（如 'P1'） */
  fromProtocol: string;
  /** 源接口 ID（共享台账 / 不变量等组合层声明时为空） */
  fromApi?: string;
  /** 引用出现的文本字段（如 precondition / inputs[].description / 跨协议不变量 expression） */
  sourceField: string;
  /** 引用类型 */
  kind: CrossRefKind;
  /** 目标协议（如 'P2'） */
  toProtocol: string;
  /** 引用目标 ID（如 'S1_active' / 'entry'；P\d 引用时为空表示仅协议级引用） */
  target?: string;
  /** 引用上下文片段（前后各 20 字符，人读） */
  context: string;
}

/** 子协议在项目视图中的元数据卡片 */
export interface SubProtocolSummary {
  id: string;
  name: string;
  version: string;
  modelPath: string;
  /** 接口总数（系统 + 观测） */
  interfaceCount: number;
  systemInterfaceCount: number;
  observationInterfaceCount: number;
  /** specs.json 是否可读（不可读时为 false） */
  specsAvailable: boolean;
  /** 老格式 specs 是否触发迁移（envelopeMigrate 路径） */
  migrated?: boolean;
  /** specs 形态描述（structured / legacy-stub / description-only 数量或 missing） */
  schemaSummary: string;
  /** B1-I5：第一个接口 ID（用于 web-serve 探针首接口详情页）；specs 不可读时为 undefined */
  firstInterfaceId?: string;
  /** B1-I5：所有接口 ID 列表（specs 不可读或为空时为 []） */
  interfaceIds?: string[];
}

/** 关联矩阵：共享实体/台账视图（来自 objectStateFacets + observationInterfaces） */
export interface SharedMatrix {
  /** 共享实体（来自 composition.objectStateFacets）：object + 涉及协议列表 */
  sharedObjects: Array<{
    object: string;
    idKey: string;
    protocols: string[];
    description: string;
  }>;
  /** 跨协议观测接口（来自 composition.observationInterfaces） */
  crossObservations: Array<{
    id: string;
    name: string;
    scope: string;
    observer: string;
    observableProtocols: string[];
  }>;
}

/** 跨协议不变量覆盖映射（invariantId → 涉及协议集合 + 关联接口） */
export interface InvariantSpanView {
  id: string;
  name: string;
  protocols: string[];
  declaredBy: string;
  complexity: CrossInvariantDef['complexity'];
  /** 关联接口：从各子协议 specs.json 中提取 invariantIds 命中的接口 */
  linkedApis: Array<{ protocol: string; interfaceId: string }>;
}

/** 组合层 WebDataJson 顶层（新增结构化数据）
 *
 * schemaVersion 与单协议 WebDataJson 平行（顶层 schemaVersion=1.0 -> 单协议；
 * 顶层 schemaVersion='1.1' -> 组合层；既有消费方读 schemaVersion 即可区分模式）。
 */
export interface CompositionWebData {
  schemaVersion: '1.1';
  generatedAt: string;
  /** 解析得到的组合层模型 */
  composition: {
    systemName: string;
    version: string;
    changeType: string;
    sourcePath?: string;
    parsedAt?: string;
  };
  /** 子协议摘要 */
  protocols: SubProtocolSummary[];
  /** 依赖图（含 Mermaid 源码 + 结构化 edges） */
  dependencyGraph: {
    mermaid: string;
    edges: DependencyEdge[];
  };
  /** 跨协议引用清单 */
  crossRefs: CrossProtocolRef[];
  /** 跨协议不变量覆盖映射 */
  invariantSpans: InvariantSpanView[];
  /** 关联矩阵 */
  sharedMatrix: SharedMatrix;
  /** 数据采集 warnings（specs.json 缺失 / 老格式迁移提示等） */
  warnings: string[];
}

// ============================================================================
// 工具函数（pure）
// ============================================================================

/**
 * 跨协议引用识别正则（与 src/mcheck/rules.ts:194 E1-I2 口径一致）
 *
 * 命中条件（任一）：
 * - `P\d` 协议 ID 前缀（如 "P2.account" / "P3.user_domains"）
 * - 全角/半角括号注解（含括号内任意非括号字符，如 "（P2）" / "(P2.entry)"）
 *
 * 注：传入文本后扫描，匹配子串；剥离协议 ID 与括号注解后保留目标（如 P2.account → P2, account）。
 */
const CROSS_REF_PATTERN = /P\d+(?:\.\w+)?|[（(][^()）]*[)）]/g;

/** 协议 ID 正则：剥离 P 前缀数字（P1 / P2 / P10） */
const PROTOCOL_ID_PATTERN = /^P\d+$/;

/**
 * 从单条文本提取跨协议引用片段（机械，正则口径 E1-I2）
 *
 * 输入：文本（如 precondition / 字段描述 / 不变量表达式）
 * 输出：扫描命中的跨协议引用片段（含协议 ID），无命中 → 空数组
 *
 * 注：仅返回协议级引用片段（target 字段为片段原文）。具体的"target entity"识别
 * 留给显示层（站点页面文本展示即可；不做更深层语义抽取——B1 范围纯机械）。
 */
export function extractCrossRefFragments(text: string | undefined): string[] {
  if (!text) return [];
  const matches = text.match(CROSS_REF_PATTERN);
  if (!matches) return [];
  // 去重保序
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matches) {
    if (!seen.has(m)) {
      seen.add(m);
      out.push(m);
    }
  }
  return out;
}

/**
 * 从片段提取目标协议 ID
 *
 * - "P2.account" / "P2" / "P10" → 协议 ID
 * - "（P2）" / "（P2.entry）" / "(P2.account)" → 协议 ID（括号内）
 * - 其他含括号注解（如 "S1（P1 网卡入口归属账户活跃）"）→ 提取第一个 P\d
 */
export function extractProtocolFromFragment(fragment: string): string | null {
  // 优先匹配括号注解内的 P\d
  const innerMatch = fragment.match(/[（(]([^()）]*P\d+[^()）]*)[)）]/);
  if (innerMatch) {
    const inner = innerMatch[1];
    const idMatch = inner.match(/(P\d+)/);
    if (idMatch) return idMatch[1];
  }
  // 否则匹配片段开头的 P\d
  const idMatch = fragment.match(/(P\d+)/);
  if (idMatch) return idMatch[1];
  return null;
}

/**
 * 提取 target ID（去掉 P\d 前缀与括号注解后的实体引用，如 "P2.account" → "account"）
 *
 * 注：仅在片段形如 "Pn.xxx" / "（Pn.xxx）" 时返回 xxx；否则返回 undefined。
 */
export function extractTargetFromFragment(fragment: string): string | undefined {
  const dotMatch = fragment.match(/P\d+\.(\w+)/);
  if (dotMatch) return dotMatch[1];
  const innerMatch = fragment.match(/[（(][^()）]*P\d+\.(\w+)[^()）]*[)）]/);
  if (innerMatch) return innerMatch[1];
  return undefined;
}

/** 抽取文本中某次匹配周围的上下文（前后各 N 字符） */
export function snippet(text: string, match: string, pad = 20): string {
  const idx = text.indexOf(match);
  if (idx < 0) return match;
  const start = Math.max(0, idx - pad);
  const end = Math.min(text.length, idx + match.length + pad);
  const pre = start > 0 ? '…' : '';
  const post = end < text.length ? '…' : '';
  return `${pre}${text.slice(start, end).replace(/\n/g, ' ')}${post}`;
}

// ============================================================================
// 子协议 specs 加载（老格式 → envelopeMigrate）
// ============================================================================

/**
 * 加载单子协议 specs.json（兼容老格式裸数组）
 *
 * 失败原因（specs 文件缺失 / JSON 损坏 / 不可识别形态）以 warnings 形式返回；
 * 不抛错（防阻塞整项目组合视图生成）。
 */
export function loadSubProtocolSpecs(
  rootDir: string,
  sub: SubProtocolRef
): { specs: InterfaceSpec[]; envelope: SpecsEnvelope | null; warnings: string[]; available: boolean } {
  const specsPath = join(rootDir, 'protocol', sub.protocolId, 'derived', 'specs.json');
  const warnings: string[] = [];
  if (!existsSync(specsPath)) {
    return {
      specs: [],
      envelope: null,
      warnings: [`[${sub.protocolId}] derived/specs.json 不存在（${specsPath}）；该子协议接口详情将空`],
      available: false,
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(specsPath, 'utf-8'));
  } catch (err) {
    return {
      specs: [],
      envelope: null,
      warnings: [`[${sub.protocolId}] derived/specs.json JSON 解析失败（${err instanceof Error ? err.message : String(err)}）；该子协议接口详情将空`],
      available: false,
    };
  }
  if (isSpecsEnvelope(raw)) {
    return { specs: raw.specs, envelope: raw, warnings, available: true };
  }
  if (Array.isArray(raw)) {
    // 老格式裸数组 → 自动迁移
    const r = envelopeMigrate(raw, sub.version);
    for (const w of r.warnings) {
      warnings.push(`[${sub.protocolId}] ${w}`);
    }
    return { specs: r.envelope.specs, envelope: r.envelope, warnings, available: true };
  }
  return {
    specs: [],
    envelope: null,
    warnings: [`[${sub.protocolId}] derived/specs.json 形态不可识别（非 Envelope 也非裸数组）；该子协议接口详情将空`],
    available: false,
  };
}

/** summary schemaKind 统计（如 "structured=12 / legacy-stub=3 / description-only=1"） */
function summarizeSchemaKind(specs: InterfaceSpec[]): string {
  if (specs.length === 0) return '(无接口)';
  const counts = { structured: 0, 'legacy-stub': 0, 'description-only': 0, unknown: 0 };
  for (const s of specs) {
    if (s.schemaKind === 'structured') counts.structured++;
    else if (s.schemaKind === 'legacy-stub') counts['legacy-stub']++;
    else if (s.schemaKind === 'description-only') counts['description-only']++;
    else counts.unknown++;
  }
  if (counts.unknown === specs.length) {
    return `unknown=${counts.unknown}（specs 无 schemaKind 标记，schema 形态未分类）`;
  }
  return `structured=${counts.structured} / legacy-stub=${counts['legacy-stub']} / description-only=${counts['description-only']}`;
}

// ============================================================================
// 跨协议引用提取
// ============================================================================

/**
 * 从单个接口的 guard/字段描述中提取跨协议引用（机械正则口径 E1-I2）
 *
 * 扫描范围：
 * - precondition（字符串）
 * - preconditions（SchemaExpression[].description）
 * - inputs[*].description
 * - outputs[*].description
 * - postconditions（字符串[]）
 * - sideEffects（SchemaExpression[].description）
 *
 * 排除：
 * - fromProtocol === toProtocol（自引用，不是跨协议引用）
 * - toProtocol 不在 composition.subProtocols.protocolId 集合（外部系统引用不算）
 */
export function extractRefsFromInterface(
  protocolId: string,
  iface: InterfaceSpec,
  validProtocolIds: Set<string>
): CrossProtocolRef[] {
  const out: CrossProtocolRef[] = [];

  const visit = (text: string | undefined, field: string): void => {
    if (!text) return;
    const fragments = extractCrossRefFragments(text);
    for (const frag of fragments) {
      const toProtocol = extractProtocolFromFragment(frag);
      if (!toProtocol) continue;
      if (toProtocol === protocolId) continue; // 自引用排除
      if (!validProtocolIds.has(toProtocol)) continue; // 外部系统排除
      const target = extractTargetFromFragment(frag);
      const ref: CrossProtocolRef = {
        fromProtocol: protocolId,
        fromApi: iface.id,
        sourceField: field,
        kind: 'guard', // interface 上下文（precondition / fields）统一归 guard 类
        toProtocol,
        context: snippet(text, frag),
      };
      if (target !== undefined) ref.target = target;
      out.push(ref);
    }
  };

  visit(iface.precondition, 'precondition');
  if (iface.preconditions) {
    for (let i = 0; i < iface.preconditions.length; i++) {
      visit(iface.preconditions[i].description, `preconditions[${i}].description`);
    }
  }
  if (iface.inputs) {
    for (let i = 0; i < iface.inputs.length; i++) {
      visit((iface.inputs[i] as FieldSpec).description, `inputs[${i}].description`);
    }
  }
  if (iface.outputs) {
    for (let i = 0; i < iface.outputs.length; i++) {
      visit((iface.outputs[i] as FieldSpec).description, `outputs[${i}].description`);
    }
  }
  if (iface.postconditions) {
    for (let i = 0; i < iface.postconditions.length; i++) {
      visit(iface.postconditions[i], `postconditions[${i}]`);
    }
  }
  if (iface.sideEffects) {
    for (let i = 0; i < iface.sideEffects.length; i++) {
      visit(iface.sideEffects[i].description, `sideEffects[${i}].description`);
    }
  }
  return out;
}

/**
 * 从跨协议不变量 expression / checkMethod 提取引用（机械正则）
 */
export function extractRefsFromCrossInvariants(
  invariants: CrossInvariantDef[],
  validProtocolIds: Set<string>
): CrossProtocolRef[] {
  const out: CrossProtocolRef[] = [];
  for (const inv of invariants) {
    // expression 中引用了某个 Pn 的实体（除自身 span 外）
    const expr = inv.expression;
    const checkMethod = inv.checkMethod;
    const visit = (text: string | undefined, field: string): void => {
      if (!text) return;
      const fragments = extractCrossRefFragments(text);
      for (const frag of fragments) {
        const toProtocol = extractProtocolFromFragment(frag);
        if (!toProtocol) continue;
        if (!validProtocolIds.has(toProtocol)) continue;
        // 跨协议不变量自身 span 已由 invariantSpans 覆盖；只记录跨 span 的额外引用
        if (inv.span.includes(toProtocol)) continue;
        const target = extractTargetFromFragment(frag);
        const ref: CrossProtocolRef = {
          fromProtocol: inv.declaredBy === 'system' ? 'system' : (inv.span[0] ?? 'system'),
          sourceField: `${inv.id}.${field}`,
          kind: 'invariant',
          toProtocol,
          context: snippet(text, frag),
        };
        if (target !== undefined) ref.target = target;
        out.push(ref);
      }
    };
    visit(expr, 'expression');
    visit(checkMethod, 'checkMethod');
  }
  return out;
}

/**
 * 从依赖图 edges / 不变量 span 提取共享台账引用（依赖边本身就指向跨协议依赖）
 *
 * 这里将每条依赖边视为一对引用（from→to），在 crossRefs 中以 kind='shared' 出现。
 * 注：依赖图本身已在 dependencyGraph.edges 体现；这里把"哪些共享台账/共享语义"
 * 从依赖边 description 中机械抽出片段，作为 crossRefs 的额外维度。
 */
export function extractRefsFromDependencyGraph(
  edges: DependencyEdge[],
  validProtocolIds: Set<string>
): CrossProtocolRef[] {
  const out: CrossProtocolRef[] = [];
  for (const edge of edges) {
    if (!validProtocolIds.has(edge.from) || !validProtocolIds.has(edge.to)) continue;
    const fragments = extractCrossRefFragments(edge.description);
    for (const frag of fragments) {
      const toProtocol = extractProtocolFromFragment(frag);
      if (!toProtocol) continue;
      if (toProtocol === edge.from) continue;
      if (!validProtocolIds.has(toProtocol)) continue;
      const target = extractTargetFromFragment(frag);
      const ref: CrossProtocolRef = {
        fromProtocol: edge.from,
        sourceField: `dependencyGraph.edges[${edge.from}->${edge.to}]`,
        kind: 'shared',
        toProtocol,
        context: snippet(edge.description, frag),
      };
      if (target !== undefined) ref.target = target;
      out.push(ref);
    }
  }
  return out;
}

// ============================================================================
// 不变量 → 接口 反向索引
// ============================================================================

/**
 * 构建 invariantId → 关联接口列表（从各子协议 specs.json 的 invariantIds 字段聚合）
 *
 * 注：specs.json 的 invariantIds 是接口关联的单协议不变量 ID；与跨协议不变量 ID
 * 不一定重合。本函数按"前缀/全等"做模糊匹配，机械识别可能的覆盖关系。
 */
export function buildInvariantSpans(
  composition: CompositionModel,
  subSpecs: Map<string, InterfaceSpec[]>
): InvariantSpanView[] {
  const out: InvariantSpanView[] = [];
  for (const inv of composition.crossInvariants) {
    const linkedApis: Array<{ protocol: string; interfaceId: string }> = [];
    for (const [protoId, specs] of subSpecs.entries()) {
      if (!inv.span.includes(protoId)) continue;
      for (const s of specs) {
        const ids = s.invariantIds ?? [];
        if (ids.includes(inv.id) || ids.some((iid) => iid.startsWith(`${inv.id}:`))) {
          linkedApis.push({ protocol: protoId, interfaceId: s.id });
        }
      }
    }
    out.push({
      id: inv.id,
      name: inv.name,
      protocols: inv.span,
      declaredBy: inv.declaredBy,
      complexity: inv.complexity,
      linkedApis,
    });
  }
  return out;
}

// ============================================================================
// 关联矩阵
// ============================================================================

export function buildSharedMatrix(composition: CompositionModel): SharedMatrix {
  const sharedObjects = composition.objectStateFacets.map((f) => ({
    object: f.object,
    idKey: f.idKey,
    protocols: f.facets.map((ft) => ft.protocol),
    description: f.facets.map((ft) => ft.description).join('；') || f.object,
  }));
  const crossObservations = composition.observationInterfaces.map((o) => ({
    id: o.id,
    name: o.name,
    scope: o.scope,
    observer: o.observer,
    observableProtocols: Array.from(new Set(o.observable.map((ob) => ob.protocol))),
  }));
  return { sharedObjects, crossObservations };
}

// ============================================================================
// 顶层构建器
// ============================================================================

/**
 * 由 composition.md + 各子协议 specs.json 构造 CompositionWebData（pure function）
 *
 * 与既有 WebDataJson 平行：组合层数据本身不参与单协议 WebDataJson 字段，
 * 由 caller 决定是否注入到 data.json 顶层（向后兼容）。
 */
export function buildCompositionWebData(
  composition: CompositionModel,
  subSpecs: Map<string, InterfaceSpec[]>,
  subEnvelopes: Map<string, SpecsEnvelope | null>
): CompositionWebData {
  const validProtocolIds = new Set(composition.subProtocols.map((s) => s.protocolId));
  const warnings: string[] = [];

  // 子协议摘要
  const protocols: SubProtocolSummary[] = composition.subProtocols.map((sub) => {
    const specs = subSpecs.get(sub.protocolId) ?? [];
    const env = subEnvelopes.get(sub.protocolId) ?? null;
    const sysCount = specs.filter((s) => s.kind === 'system').length;
    const obsCount = specs.filter((s) => s.kind === 'observation').length;
    const sum: SubProtocolSummary = {
      id: sub.protocolId,
      name: sub.name,
      version: sub.version,
      modelPath: sub.modelPath,
      interfaceCount: specs.length,
      systemInterfaceCount: sysCount,
      observationInterfaceCount: obsCount,
      specsAvailable: env !== null,
      schemaSummary: specs.length > 0 ? summarizeSchemaKind(specs) : '(无接口)',
    };
    if (env?.migrated) sum.migrated = true;
    // B1-I5：填入接口 ID 列表（web-serve 探针 + UI 跳转用）
    if (specs.length > 0) {
      const ids = specs.map((s) => s.id);
      sum.interfaceIds = ids;
      sum.firstInterfaceId = ids[0];
    }
    return sum;
  });

  // 跨协议引用提取（依次从接口 / 跨协议不变量 / 依赖图）
  const crossRefs: CrossProtocolRef[] = [];
  for (const [protoId, specs] of subSpecs.entries()) {
    for (const iface of specs) {
      crossRefs.push(...extractRefsFromInterface(protoId, iface, validProtocolIds));
    }
  }
  crossRefs.push(...extractRefsFromCrossInvariants(composition.crossInvariants, validProtocolIds));
  crossRefs.push(...extractRefsFromDependencyGraph(composition.dependencyGraph.edges, validProtocolIds));

  // 跨协议不变量覆盖映射
  const invariantSpans = buildInvariantSpans(composition, subSpecs);

  // 关联矩阵
  const sharedMatrix = buildSharedMatrix(composition);

  // 收集迁移 warnings
  for (const env of subEnvelopes.values()) {
    if (env?.migrationWarnings) {
      for (const w of env.migrationWarnings) {
        warnings.push(`[envelopeMigrate] ${w}`);
      }
    }
  }

  return {
    schemaVersion: '1.1',
    generatedAt: new Date().toISOString(),
    composition: {
      systemName: composition.metadata.systemName,
      version: composition.metadata.version,
      changeType: composition.metadata.changeType,
      ...(composition.sourcePath !== undefined ? { sourcePath: composition.sourcePath } : {}),
      ...(composition.parsedAt !== undefined ? { parsedAt: composition.parsedAt } : {}),
    },
    protocols,
    dependencyGraph: {
      mermaid: composition.dependencyGraph.mermaid,
      edges: composition.dependencyGraph.edges,
    },
    crossRefs,
    invariantSpans,
    sharedMatrix,
    warnings,
  };
}

// ============================================================================
// Markdown 页面渲染（VitePress 输入）
// ============================================================================

/** 渲染 Markdown 表格（人读）—— 与 webgen/index.ts 内 renderTable 等价；这里独立避免循环依赖 */
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

/** 转义 markdown 单元格：管道符 + HTML 标签字符（修改单 #008 缺陷 3） */
function escapeMdCell(s: string): string {
  return s
    .replace(/\|/g, '\\|')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 生成 project.md（项目总览：子协议卡片 + 依赖图 + 快速跳转） */
export function renderProjectPage(comp: CompositionWebData): string {
  const parts: string[] = [];
  parts.push(`# ${comp.composition.systemName} —— 项目总览\n`);
  parts.push(`> 版本：**${comp.composition.version}** | 变更类型：\`${comp.composition.changeType}\` | 检阅时间：${new Date().toISOString()}\n`);

  parts.push(`## 子协议概览\n`);
  const cardRows = comp.protocols.map((p) => {
    return [
      p.id,
      p.name,
      p.version,
      String(p.interfaceCount),
      `${p.systemInterfaceCount}+${p.observationInterfaceCount}`,
      p.specsAvailable ? p.schemaSummary : '*(不可读)*',
      p.migrated ? '✓（老格式迁移）' : '',
    ];
  });
  parts.push(renderTable(
    ['ID', '名称', '版本', '接口数', '系统+观测', 'schema 形态', '迁移状态'],
    cardRows,
  ));
  parts.push('');

  parts.push(`## 子协议快速跳转\n`);
  for (const p of comp.protocols) {
    const subDir = encodeURIComponent(p.id);
    // B1-I5 + B1-I3 修复：目录式路由（VitePress cleanUrls 下 protocols/P1/index.md → /protocols/P1/）
    parts.push(`- [${p.id} ${p.name}](protocols/${subDir}/) — ${p.interfaceCount} 个接口`);
  }
  parts.push('');

  parts.push(`## 依赖图（mermaid）\n`);
  parts.push('```mermaid');
  parts.push(comp.dependencyGraph.mermaid || 'graph LR\n  empty[未提供 mermaid]');
  parts.push('```');
  parts.push('');
  parts.push('> 复制上述 mermaid 段落到 <https://mermaid.live> 可渲染。\n');

  if (comp.dependencyGraph.edges.length > 0) {
    parts.push(`### 依赖边清单（结构化，工具消费权威源）\n`);
    parts.push(renderTable(
      ['From', 'To', 'Type', '说明'],
      comp.dependencyGraph.edges.map((e) => [e.from, e.to, e.dependencyType, e.description]),
    ));
    parts.push('');
  }

  parts.push(`## 跨协议引用汇总\n`);
  const totalRefs = comp.crossRefs.length;
  const refByKind: Record<string, number> = {};
  for (const r of comp.crossRefs) {
    refByKind[r.kind] = (refByKind[r.kind] ?? 0) + 1;
  }
  parts.push(`- 跨协议引用总数：**${totalRefs}**`);
  for (const [k, v] of Object.entries(refByKind)) {
    parts.push(`- \`${k}\` 类引用：**${v}**`);
  }
  parts.push('');
  parts.push(`完整清单见 [cross-refs.md](cross-refs)（关联矩阵 + 共享台账 + 双向引用表）。\n`);

  parts.push(`## 跨协议不变量覆盖\n`);
  parts.push(`- 跨协议不变量数：**${comp.invariantSpans.length}**`);
  for (const inv of comp.invariantSpans.slice(0, 5)) {
    parts.push(`- \`${inv.id}\` ${inv.name}（span: ${inv.protocols.join(', ')}；关联接口 ${inv.linkedApis.length}）`);
  }
  if (comp.invariantSpans.length > 5) {
    parts.push(`- ... 详见 [cross-refs.md](cross-refs)`);
  }
  parts.push('');

  parts.push(`## 安全边界\n`);
  parts.push(`- 本产物由 protochain derive-web --project 机械生成`);
  parts.push(`- 不读 process.env / 不读 bindings.yaml / 不调 AI`);
  parts.push(`- 敏感字段（tokenEnv/secretEnv/passwordEnv 等）已在 specs.json envelope 阶段脱敏`);
  parts.push('');
  if (comp.warnings.length > 0) {
    parts.push(`## 警告（数据采集阶段）\n`);
    for (const w of comp.warnings) parts.push(`- ${w}`);
    parts.push('');
  }
  return parts.join('\n');
}

/** 生成 cross-refs.md（关联矩阵 + 共享台账 + 跨协议引用双向表 + 不变量覆盖） */
export function renderCrossRefsPage(comp: CompositionWebData): string {
  const parts: string[] = [];
  parts.push(`# 跨协议引用矩阵 —— ${comp.composition.systemName}\n`);
  parts.push(`> 跨协议引用总数：**${comp.crossRefs.length}**（机械提取，参照 E1-I2 跨协议引用识别口径）\n`);

  parts.push(`## 共享实体 / 关联矩阵\n`);
  if (comp.sharedMatrix.sharedObjects.length === 0) {
    parts.push('*(composition.md 未声明对象状态切面)*\n');
  } else {
    parts.push(renderTable(
      ['对象', 'idKey', '涉及协议', '说明'],
      comp.sharedMatrix.sharedObjects.map((o) => [
        o.object,
        o.idKey,
        o.protocols.join(', '),
        o.description,
      ]),
    ));
    parts.push('');
  }

  parts.push(`## 跨协议观测接口\n`);
  if (comp.sharedMatrix.crossObservations.length === 0) {
    parts.push('*(composition.md 未声明观测接口)*\n');
  } else {
    parts.push(renderTable(
      ['ID', '名称', 'scope', 'observer', '观测协议'],
      comp.sharedMatrix.crossObservations.map((o) => [
        o.id,
        o.name,
        o.scope,
        o.observer,
        o.observableProtocols.join(', '),
      ]),
    ));
    parts.push('');
  }

  parts.push(`## 跨协议守卫 / 字段引用（按引用源→目标分组）\n`);
  if (comp.crossRefs.length === 0) {
    parts.push('*(无跨协议引用)*\n');
  } else {
    // 引用方向分组：fromProtocol → toProtocol
    const grouped = new Map<string, CrossProtocolRef[]>();
    for (const r of comp.crossRefs) {
      const key = `${r.fromProtocol} → ${r.toProtocol}`;
      const arr = grouped.get(key) ?? [];
      arr.push(r);
      grouped.set(key, arr);
    }
    for (const [key, refs] of grouped) {
      parts.push(`### ${key}（${refs.length} 条）\n`);
      parts.push(renderTable(
        ['源接口', '源字段', '类型', '目标', '上下文'],
        refs.map((r) => [
          r.fromApi ?? '—',
          r.sourceField,
          r.kind,
          r.target ? `${r.toProtocol}.${r.target}` : r.toProtocol,
          r.context,
        ]),
      ));
      parts.push('');
    }
  }

  parts.push(`## 跨协议不变量覆盖映射\n`);
  if (comp.invariantSpans.length === 0) {
    parts.push('*(composition.md 未声明跨协议不变量)*\n');
  } else {
    parts.push(renderTable(
      ['不变量', '名称', 'span', '声明方', '复杂度', '关联接口'],
      comp.invariantSpans.map((inv) => [
        inv.id,
        inv.name,
        inv.protocols.join(', '),
        inv.declaredBy,
        inv.complexity,
        inv.linkedApis.length === 0
          ? '*(无)*'
          : inv.linkedApis.map((a) => `${a.protocol}/${a.interfaceId}`).join(', '),
      ]),
    ));
    parts.push('');
  }
  return parts.join('\n');
}

/** 生成 cross-diff.md 骨架（占位："待 E9 接通"） */
export function renderCrossDiffSkeleton(comp: CompositionWebData): string {
  const parts: string[] = [];
  parts.push(`# 跨协议 diff —— ${comp.composition.systemName}\n`);
  parts.push('> 状态：**待 E9 接通**');
  parts.push('');
  parts.push(`本页面为组合视图跨协议 diff 骨架（B1 占位）。`);
  parts.push('数据接口预留：');
  parts.push('- 触发命令：`protochain diff --cross-protocol`（E9 实施后接通）');
  parts.push('- 期望输入：本项目的两个 CompositionModel 快照（diff before/after）');
  parts.push('- 期望输出：跨协议影响分析（哪些子协议 API/绑定受影响）');
  parts.push('');
  parts.push(`当前项目快照：`);
  parts.push(`- 子协议数：${comp.protocols.length}`);
  parts.push(`- 依赖边数：${comp.dependencyGraph.edges.length}`);
  parts.push(`- 跨协议不变量数：${comp.invariantSpans.length}`);
  parts.push(`- 跨协议引用数：${comp.crossRefs.length}`);
  parts.push('');
  parts.push('**禁止**自行实现跨协议 diff 分析逻辑（B1 红线：实现归属 E9）。');
  return parts.join('\n');
}

/**
 * 生成子协议页面（protocols/<id>.md）：子协议摘要 + 接口列表 + 跨协议引用小节
 *
 * B1-I5 修复：接口列表的 ID 列加链接到 `protocols/<proto>/<iface>.md` 详情页
 * （之前只列纯文本，点不开）。
 */
export function renderSubProtocolPage(
  protocol: SubProtocolSummary,
  specs: InterfaceSpec[],
  crossRefs: CrossProtocolRef[]
): string {
  const parts: string[] = [];
  parts.push(`# ${protocol.id} —— ${protocol.name}\n`);
  parts.push(`> 版本：**${protocol.version}** | 接口总数：**${protocol.interfaceCount}**（系统 ${protocol.systemInterfaceCount} + 观测 ${protocol.observationInterfaceCount}）`);
  if (protocol.migrated) parts.push(`> specs.json 状态：**已自动迁移**（老格式 → Envelope）`);
  parts.push('');

  if (specs.length === 0) {
    parts.push('*(specs.json 不可读或为空)*\n');
  } else {
    parts.push(`## 接口列表\n`);
    parts.push(renderTable(
      ['ID', '名称', '类型', 'schemaKind'],
      specs.map((s) => {
        // B1-I5：接口 ID 转链接到 protocols/<proto>/<iface>.md
        const idCell = `[${s.id}](${encodeURIComponent(s.id)})`;
        return [
          idCell,
          s.name,
          s.kind === 'system' ? '系统' : '观测',
          s.schemaKind ?? '—',
        ];
      }),
    ));
    parts.push('');
  }

  parts.push(`## 跨协议引用\n`);
  const outgoing = crossRefs.filter((r) => r.fromProtocol === protocol.id);
  const incoming = crossRefs.filter((r) => r.toProtocol === protocol.id && r.fromProtocol !== protocol.id);
  parts.push(`- 引用其他协议：**${outgoing.length}** 条`);
  parts.push(`- 被其他协议引用：**${incoming.length}** 条`);
  parts.push('');

  if (outgoing.length > 0) {
    parts.push(`### 引用其他协议\n`);
    parts.push(renderTable(
      ['源接口', '源字段', '目标协议', '目标', '类型', '上下文'],
      outgoing.map((r) => [
        r.fromApi ? `[${r.fromApi}](${encodeURIComponent(r.fromApi)})` : '—',
        r.sourceField,
        r.toProtocol,
        r.target ?? '—',
        r.kind,
        r.context,
      ]),
    ));
    parts.push('');
  }

  if (incoming.length > 0) {
    parts.push(`### 被其他协议引用\n`);
    parts.push(renderTable(
      ['源协议', '源接口', '源字段', '目标', '类型', '上下文'],
      incoming.map((r) => [
        r.fromProtocol,
        r.fromApi ?? '—',
        r.sourceField,
        r.target ?? '—',
        r.kind,
        r.context,
      ]),
    ));
    parts.push('');
  }

  // 更多信息：链接到本子协议目录下的具体信息页（test-cases/verification/diff/bindings）。
  // 这些页面由单协议 derive-web 生成后复制到 protocols/<id>/（组合层不重新生成），
  // 此处仅作机械相对链接；文件缺失时链接自然 404，不阻断生成。
  parts.push(`## 更多信息\n`);
  const detailLinks: Array<[string, string, string]> = [
    ['test-cases', '测试用例浏览器', '路径覆盖度与偏差'],
    ['verification', '验证报告对比', 'legacy vs impl 双跑对账'],
    ['diff', '模型 diff / impact', '变更 → 受影响步骤/产物'],
    ['bindings', '绑定视图', '传输绑定与错误映射'],
  ];
  for (const [file, title, desc] of detailLinks) {
    parts.push(`- [${title}](${file}) — ${desc}`);
  }
  parts.push('');
  return parts.join('\n');
}

/**
 * 生成项目级接口详情页（protocols/<proto>/<iface>.md）
 *
 * B1-I5 新增：复用 E7-P0 `renderInterfaceDetailPage` 的内容（request/response schema、
 * precondition/postcondition 等）；额外追加：
 * - 返回上一级（protocols/<proto>）链接
 * - 跨协议引用（intersect：与该接口相关的 outgoing + incoming）
 *
 * v0.3 新增（E11 在组合层落表 —— B1-E11）：
 * - 错误响应契约表（来自 `iface.errorResponses`，仅展示 ID/错误码/HTTP Status/
 *   bodySchema/说明 五列；不展开 bodySchema JSON，避免 web 产物膨胀）
 * - 绑定视图段：
 *   - 传输绑定（命中本接口的 interfaces[].transport，仅展示非敏感投影子集）
 *   - 错误映射表（本接口声明的 errorCode 命中 bindings.errorMap 的行）
 *   - 状态词表 stateMap（全局，标注为非接口级）
 *   - 缺绑错误码（仅展示与本接口相关的 unmappedErrorCodes）
 *   - 警告（errorMap 中未在 specs/异常路径声明的额外 errorCode 全部展示；
 *           跨接口共用一段，避免重复）
 *
 * 注：组合层默认不读 bindings.yaml（B1 红线：100% 机械、无 AI、不读 process.env），
 * E11 在组合层落表属于 B1-E11 接通（沿用单协议 webgen 已有 readBindingsFileSafely
 * + redactSensitiveFields 兜底，不读取 authConfig/tls 密钥段）。bindings 可选：
 * - 未提供 → 错误响应表仍展示（来自 specs.json），绑定视图段提示
 *   "未读取到 bindings.yaml"，符合"安全边界"叙事
 *
 * 注：VitePress 子路径索引路由问题——protocols/P1.md 与 protocols/P1/ 目录式共存会冲突。
 * 因此每个子协议拆出独立目录 protocols/P1/index.md + protocols/P1/<iface>.md，
 * 与 v0.1 的 protocols/P1.md 不兼容。本函数写 protocols/P1/<iface>.md。
 */
export function renderProjectInterfaceDetailPage(
  protocol: SubProtocolSummary,
  iface: InterfaceSpec,
  crossRefs: CrossProtocolRef[],
  bindings?: WebBindingView
): string {
  const parts: string[] = [];
  // 顶部导航：返回子协议列表 + 协议元数据
  parts.push(`# ${iface.name}\n`);
  parts.push(`> [← 返回 ${protocol.id} ${protocol.name}](../${protocol.id}/) | 接口 ID: \`${iface.id}\` | 类型: **${iface.kind === 'system' ? '系统' : '观测'}**${iface.actionType ? ` | 动作类型: \`${iface.actionType}\`` : ''} | schemaKind: **${iface.schemaKind ?? '—'}**\n`);
  // E11 后续问题 5：契约承载接口标注（组合层）
  if (iface.isContractCarrier) {
    parts.push(
      '> **承载接口（contract-carrier）**：契约 interface 未匹配任何 transition.id/action；'
      + 'requestSchema/responseSchema/errorResponses 由契约层直接投影，不参与状态机推演。\n'
    );
  }
  if (iface.schemaDegradedReasons && iface.schemaDegradedReasons.length > 0) {
    parts.push('## 降级理由\n');
    for (const r of iface.schemaDegradedReasons) parts.push(`- ${r}`);
    parts.push('');
  }
  // I/O 字段（结构化展示，沿用 E7-P0 风格）
  // E11 后续问题 6：currentState CAS 标注（组合层）
  if (iface.inputs && iface.inputs.length > 0) {
    parts.push('## 输入字段\n');
    const isStateTransition = iface.kind === 'system' && iface.actionType === 'state_transition';
    const isObservation = iface.kind === 'observation';
    parts.push(renderTable(
      ['字段名', '类型', '必填', '说明'],
      (iface.inputs as FieldSpec[]).map((f) => {
        let desc = f.description ?? '';
        if (f.name === 'currentState') {
          if (isStateTransition) {
            desc = `${desc ? desc + '\n' : ''}\`CAS 断言\`：状态转移前置校验（resource 实际状态 == currentState 才执行；hsk-ng Disable/Enable/Delete 走 Disable/Enable/Delete(ctx, ownerID, id, req.CurrentState)）。`;
          } else if (isObservation) {
            desc = `${desc ? desc + '\n' : ''}\`CAS 断言（impl 不读取）\`：纯读/观测接口 impl 不使用 currentState；specs 必填仅用于契约对齐，verify 仍会注入（多余但无害）。`;
          } else if (!iface.isContractCarrier) {
            desc = `${desc ? desc + '\n' : ''}\`CAS 断言\`：模型要求；impl 可容忍 currentState=="" 时取实体实际状态。`;
          }
        }
        return [
          f.name,
          f.type ?? '—',
          f.required ? '✓' : '',
          desc,
        ];
      }),
    ));
    parts.push('');
  }
  if (iface.outputs && iface.outputs.length > 0) {
    parts.push('## 输出字段\n');
    parts.push(renderTable(
      ['字段名', '类型', '说明'],
      (iface.outputs as FieldSpec[]).map((f) => [
        f.name,
        f.type ?? '—',
        f.description ?? '',
      ]),
    ));
    parts.push('');
  }
  // E11：错误响应契约表（B1-E11 在组合层落表）
  const ifaceErrors = (iface.errorResponses ?? []) as ErrorResponseDef[];
  if (ifaceErrors.length > 0) {
    parts.push(`## 错误响应 (errorResponses)\n`);
    parts.push(renderErrorResponsesTable(ifaceErrors));
    parts.push('');
  }
  // 前置 / 后置条件
  if (iface.precondition) {
    parts.push(`## 前置条件（自然语言）\n\n${iface.precondition}\n`);
  }
  if (iface.preconditions && iface.preconditions.length > 0) {
    parts.push('## 前置条件（结构化）\n');
    for (const p of iface.preconditions) {
      parts.push(`- kind=\`${p.kind}\`：${p.description ?? ''}${p.schema ? ` / schema=${JSON.stringify(p.schema)}` : ''}`);
    }
    parts.push('');
  }
  if (iface.postconditions && iface.postconditions.length > 0) {
    parts.push('## 后置条件（自然语言）\n');
    for (const p of iface.postconditions) parts.push(`- ${p}`);
    parts.push('');
  }
  if (iface.postconditionExpressions && iface.postconditionExpressions.length > 0) {
    parts.push('## 后置条件（结构化）\n');
    for (const p of iface.postconditionExpressions) {
      parts.push(`- ${p.description ?? p.kind}`);
    }
    parts.push('');
  }
  if (iface.invariantIds && iface.invariantIds.length > 0) {
    parts.push('## 关联不变量\n');
    for (const id of iface.invariantIds) parts.push(`- ${id}`);
    parts.push('');
  }
  // 跨协议引用（按接口过滤）
  const ifaceRefs = crossRefs.filter((r) => r.fromApi === iface.id);
  const outgoing = ifaceRefs.filter((r) => r.fromProtocol === protocol.id);
  const incoming = crossRefs.filter((r) => r.toProtocol === protocol.id && r.fromProtocol !== protocol.id);
  parts.push('## 跨协议引用（与本接口相关）\n');
  if (outgoing.length === 0 && incoming.length === 0) {
    parts.push('*(本接口未涉及跨协议引用)*\n');
  } else {
    if (outgoing.length > 0) {
      parts.push(`### 引用其他协议\n`);
      parts.push(renderTable(
        ['源字段', '目标协议', '目标', '类型', '上下文'],
        outgoing.map((r) => [
          r.sourceField,
          r.toProtocol,
          r.target ?? '—',
          r.kind,
          r.context,
        ]),
      ));
      parts.push('');
    }
    if (incoming.length > 0) {
      parts.push(`### 被其他协议接口引用\n`);
      parts.push(renderTable(
        ['源协议', '源接口', '源字段', '类型', '上下文'],
        incoming.map((r) => [
          r.fromProtocol,
          r.fromApi ?? '—',
          r.sourceField,
          r.kind,
          r.context,
        ]),
      ));
      parts.push('');
    }
  }
  // E11：绑定视图段（错误映射/传输绑定/状态词表）—— 沿用单协议 webgen 的非敏感投影子集
  parts.push(renderProjectInterfaceBindingSection(iface, bindings));
  // 底部导航
  parts.push(`---\n\n[← 返回 ${protocol.id} ${protocol.name}](../${protocol.id}/) | [项目总览](../../)\n`);
  return parts.join('\n');
}

/**
 * E11：渲染错误响应表（id/errorCode/httpStatus/bodySchema/说明 五列）
 *
 * 注：与单协议 webgen 的 `renderErrorResponsesTable` 等价（独立保留以避免
 * webgen index.ts 的私有 helper 跨模块导入）。五列与单协议保持一致。
 */
function renderErrorResponsesTable(errors: ErrorResponseDef[]): string {
  const rows = errors.map((er) => {
    const bodySchema = er.bodySchema ? '`已定义`' : '—';
    return [er.id, er.errorCode, String(er.httpStatus), bodySchema, er.description ?? ''];
  });
  return renderTable(['ID', '错误码', 'HTTP Status', 'bodySchema', '说明'], rows);
}

/**
 * E11：渲染接口详情"绑定视图"段（传输绑定 / 错误映射 / 状态词表 / 缺绑错误码）
 *
 * 行为：
 * - bindings 未提供：输出"未读取到 bindings.yaml"+ 安全边界说明（沿用单协议）
 * - bindings 提供：按接口 ID（specs.id === bindings.interfaces[].action 兼容）
 *   过滤本接口相关的传输绑定行；按 iface.errorResponses[].errorCode 过滤
 *   errorMap 命中行；stateMap 全局展示（项目级共享）
 *
 * 安全边界：
 * - 调用方负责先 redactSensitiveFields（authConfig/tls 密钥段不读取）
 * - 不读取 process.env；不读取 transport 之外的任何字段
 */
export function renderProjectInterfaceBindingSection(
  iface: InterfaceSpec,
  bindings: WebBindingView | undefined
): string {
  const parts: string[] = [];
  parts.push('## 绑定视图（E11）\n');
  if (!bindings || !bindings.hasBindings) {
    parts.push('> 未读取到 bindings.yaml。本段仅在 `<rootDir>/bindings.yaml` 或');
    parts.push('> `protochain.config.yaml#bindings` 存在时填充。\n');
    parts.push('非敏感投影子集（roles baseUrl/headers + interfaces transport + errorMap）：');
    parts.push('见各接口详情页"绑定视图"段。\n');
    parts.push('## 安全边界\n');
    parts.push('- bindings.yaml 由 redactSensitiveFields 兜底过滤（敏感字段名整键删除）');
    parts.push('- 仅 transport/errorMap/stateMap 入站');
    parts.push('');
    return parts.join('\n');
  }

  // 1. 传输绑定：本接口命中行（按 action 匹配）
  //    bindings.interfaces[].action 对应 InterfaceSpec.sourceId（动作名，如 register/bind），
  //    而非 iface.id（接口 ID，如 IF_SYS_T1）。兜底保留 iface.id 以兼容 action 名=ID 的场景。
  const ifaceActionCandidates = new Set<string>([iface.id]);
  if (iface.sourceId) ifaceActionCandidates.add(iface.sourceId);
  if (iface.actionType) ifaceActionCandidates.add(iface.actionType);
  const transportHits = bindings.interfaces.filter((i) => ifaceActionCandidates.has(i.action));
  const ifaceTransportRows = transportHits.length > 0
    ? transportHits.map((i) => [
        i.action,
        i.roleId ?? '—',
        i.protocol ?? '—',
        i.transport?.type ?? '—',
        i.transport?.method ?? '—',
        i.transport?.path ?? '—',
      ])
    : [['(无)', '—', '—', '—', '—', '—']];

  parts.push('### 传输绑定（命中本接口）\n');
  parts.push(renderTable(['action', 'roleId', 'protocol', 'type', 'method', 'path'], ifaceTransportRows));
  parts.push('');

  // 2. 错误映射表：本接口声明的 errorCode 命中行（仅命中项；未命中以"缺绑错误码"段提示）
  const declaredCodes = new Set<string>((iface.errorResponses ?? []).map((er) => er.errorCode));
  const errorMapRows: string[][] = [];
  const ifaceUnmapped: string[] = [];
  if (bindings.errorMap) {
    for (const code of declaredCodes) {
      const entry = bindings.errorMap[code];
      if (entry) {
        errorMapRows.push([
          code,
          String(entry.httpStatus ?? '—'),
          String(entry.systemCode ?? '—'),
          String(entry.bodyField ?? 'code'),
          String(entry.bodyFieldValue ?? '—'),
          String(entry.messageField ?? '—'),
        ]);
      } else {
        ifaceUnmapped.push(code);
      }
    }
  } else {
    for (const code of declaredCodes) ifaceUnmapped.push(code);
  }
  parts.push('### 错误映射表 (errorMap) —— 本接口命中行\n');
  parts.push(errorMapRows.length > 0
    ? renderTable(['错误码', 'httpStatus', 'systemCode', 'bodyField', 'bodyFieldValue', 'messageField'], errorMapRows)
    : '*(本接口 errorResponses 未命中 errorMap 任何条目 — 见下"缺绑错误码")*');
  parts.push('');

  // 3. 状态词表（stateMap）—— 全局，标注为非接口级
  const stateMapRows: string[][] = bindings.stateMap
    ? Object.entries(bindings.stateMap).map(([k, v]) => [k, String(v)])
    : [];
  parts.push('### 状态词表 (stateMap) —— 项目级共享\n');
  parts.push(stateMapRows.length > 0
    ? renderTable(['协议状态 ID', '系统状态值'], stateMapRows)
    : '*(无)*');
  parts.push('');

  // 4. 缺绑错误码（本接口相关）
  parts.push('### 缺绑错误码（本接口相关）\n');
  // 取本接口声明但 errorMap 未覆盖的；同时叠加全局 unmappedErrorCodes 与本接口声明的交集
  const globalUnmapped = new Set(bindings.unmappedErrorCodes ?? []);
  const combined = Array.from(new Set([...ifaceUnmapped, ...declaredCodes].filter((c) => globalUnmapped.has(c) || ifaceUnmapped.includes(c))));
  if (combined.length === 0 && ifaceUnmapped.length === 0) {
    parts.push('*(无 — 本接口 errorResponses 全部命中 errorMap)*');
  } else {
    const rows = (ifaceUnmapped.length > 0 ? ifaceUnmapped : combined).map((c) => [c]);
    parts.push(renderTable(['错误码'], rows));
  }
  parts.push('');

  // 5. 警告（跨接口共用段，全量展示 — 多数错误码声明类警告对全项目都适用）
  parts.push('### 警告\n');
  parts.push(bindings.warnings.length > 0
    ? bindings.warnings.map((w) => `- ${w}`).join('\n')
    : '*(无)*');
  parts.push('');

  // 6. 安全边界
  parts.push('### 安全边界\n');
  parts.push('- bindings.yaml 由 redactSensitiveFields 兜底过滤（敏感字段名整键删除）');
  parts.push('- 仅展示非敏感投影子集（interfaces transport + errorMap + stateMap）');
  parts.push('');

  return parts.join('\n');
}

/** 生成项目级 VitePress config（在单协议 config 基础上加项目页面 + 子协议侧栏） */
export function renderProjectVitePressConfig(): string {
  return `import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'Protochain Project Review',
  description: '协议驱动自验证工具链 —— 项目级组合视图',
  cleanUrls: true,
  srcDir: '.',
  ignoreDeadLinks: true,
  themeConfig: {
    nav: [
      { text: '项目总览', link: '/' },
      { text: '子协议', link: '/protocols/' },
      { text: '跨协议引用', link: '/cross-refs' },
      { text: '跨协议 diff', link: '/cross-diff' },
    ],
    sidebar: [
      {
        text: '组合视图',
        items: [
          { text: '项目总览', link: '/' },
          { text: '子协议列表', link: '/protocols/' },
          { text: '跨协议引用矩阵', link: '/cross-refs' },
          { text: '跨协议 diff', link: '/cross-diff' },
        ],
      },
    ],
    socialIcons: [],
    footer: {
      message: '由 protochain derive-web --project 机械生成',
      copyright: 'Generated at ' + new Date().toISOString(),
    },
  },
});
`;
}

// ============================================================================
// 顶层组合层产出（CLI 入口）
// ============================================================================

/** 组合层产物（项目级 web/data.json + 站点页面） */
export interface CompositionResult {
  /** 组合层 WebDataJson（顶层 protocols/dependencyGraph/crossRefs/invariantSpans） */
  data: CompositionWebData;
  /** web/data.json 绝对路径 */
  dataJsonPath: string;
  /** 站点工程目录 */
  webDir: string;
  /** VitePress build 产物目录（buildProjectSite=true 时） */
  distDir: string;
  /** VitePress build 是否执行 */
  built: boolean;
  /** 警告 */
  warnings: string[];
}

/** 组合层模式选项 */
export interface DeriveProjectWebOptions {
  /** 项目根目录（含 protocol/composition.md 与 protocol/<Pn>/derived/specs.json） */
  rootDir: string;
  /** web/data.json 输出路径（默认 <rootDir>/web/data.json） */
  dataJsonPath?: string;
  /** 站点工程目录（默认 <rootDir>/web） */
  webDir?: string;
  /** VitePress build 产物目录（默认 <webDir>/docs/.vitepress/dist） */
  distDir?: string;
  /** 是否执行 VitePress build（默认 true） */
  buildProjectSite?: boolean;
  /** 覆盖已存在 web 产物（默认 false） */
  force?: boolean;
}

/**
 * 读取 composition.md + 各子协议 specs.json → 构造组合层 WebDataJson + 页面
 *
 * 不直接执行 VitePress build；由 caller 决定（与 deriveWeb 保持一致风格）。
 *
 * 行为：
 * - composition.md 缺失 → 抛错（组合层模式强制要求组合层权威源）
 * - 任一子协议 specs.json 缺失 → warnings 报告（不阻断；该子协议接口详情空）
 * - 任一子协议 specs.json 为老格式 → envelopeMigrate + warnings
 * - redactSensitiveFields 复用（防御性）
 */
export async function deriveProjectWeb(
  options: DeriveProjectWebOptions
): Promise<CompositionResult> {
  const rootDir = options.rootDir;
  const compositionPath = join(rootDir, 'protocol/composition.md');
  if (!existsSync(compositionPath)) {
    throw new Error(
      `组合层模式要求 composition.md 存在: ${compositionPath}（当前项目为单协议；请改用 derive-web 不带 --project）`
    );
  }

  // 1. 解析 composition.md
  const composition = parseCompositionFile(compositionPath);

  // 2. 逐子协议加载 specs.json
  const subSpecs = new Map<string, InterfaceSpec[]>();
  const subEnvelopes = new Map<string, SpecsEnvelope | null>();
  const allWarnings: string[] = [];
  for (const sub of composition.subProtocols) {
    const r = loadSubProtocolSpecs(rootDir, sub);
    subSpecs.set(sub.protocolId, r.specs);
    subEnvelopes.set(sub.protocolId, r.envelope);
    for (const w of r.warnings) allWarnings.push(w);
  }

  // 3. 构造组合层 WebDataJson
  let data = buildCompositionWebData(composition, subSpecs, subEnvelopes);
  for (const w of data.warnings) allWarnings.push(w);

  // 4. 防御性：redact sensitive fields
  data = redactSensitiveFields(data) as CompositionWebData;

  // 4b. E11（B1-E11 在组合层落表）：读 bindings.yaml → redact → buildBindingView
  //     注：仅用于接口详情页"绑定视图"段渲染；data.json 不携带 bindings 字段
  //     （避免组合层 data.json 重复载荷；绑定视图在单协议 webgen 的 bindings.md
  //     已有完整版，本处按接口过滤）。bindings 缺失时各接口详情页降级为
  //     "未读取到 bindings.yaml"提示。
  const allSpecs: InterfaceSpec[] = [];
  for (const arr of subSpecs.values()) allSpecs.push(...arr);
  let bindingView: WebBindingView | undefined;
  const bindingsRaw = readBindingsFileSafely(rootDir);
  if (bindingsRaw) {
    const bindingsRedacted = redactSensitiveFields(bindingsRaw);
    bindingView = buildBindingView(bindingsRedacted, allSpecs);
  } else {
    bindingView = buildBindingView(undefined, allSpecs);
  }

  // 5. 写出 web/data.json（如果不存在或 --force）
  const dataJsonPath = options.dataJsonPath ?? join(rootDir, 'web/data.json');
  if (!options.force && existsSync(dataJsonPath)) {
    throw new Error(
      `web 产物已存在（${dataJsonPath}）；如需覆盖请传 --force`
    );
  }
  writeJson(dataJsonPath, data);

  // 6. 写出 web/docs/public/data.json（站点工程副本）
  const webDir = options.webDir ?? join(rootDir, 'web');
  const docsDir = join(webDir, 'docs');
  const publicDir = join(docsDir, 'public');
  writeJson(join(publicDir, 'data.json'), data);

  // 7. 写出 VitePress config + package.json（与单协议 webgen 保持路径一致）
  //    注意：本模式与单协议模式共用 web/ 目录；CLI 调用方负责在 --project 时不冲突。
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(docsDir, '.vitepress'), { recursive: true });
  writeText(join(docsDir, '.vitepress/config.ts'), renderProjectVitePressConfig());

  // 8. 写出页面 .md
  const protocolsDir = join(docsDir, 'protocols');
  mkdirSync(protocolsDir, { recursive: true });
  // B1-I5 修复：清理 v0.1 遗留的 protocols/<id>.md 文件（避免与 protocols/<id>/index.md
  //   目录式路由冲突；VitePress 在两种文件共存时会把 markdown 链接降级为纯文本）
  for (const proto of composition.subProtocols) {
    const legacy = join(protocolsDir, `${encodeURIComponent(proto.protocolId)}.md`);
    if (existsSync(legacy)) {
      try {
        rmSync(legacy);
      } catch {
        // 忽略清理失败（不该阻塞 derive-web）
      }
    }
  }

  // project.md（首页）
  writeText(join(docsDir, 'index.md'), renderProjectPage(data));

  // protocols/index.md（子协议列表）
  const subListRows = data.protocols.map((p) => {
    const subDir = encodeURIComponent(p.id);
    return [
      `[${p.id}](${subDir})`,
      p.name,
      p.version,
      String(p.interfaceCount),
      p.migrated ? '✓' : '',
    ];
  });
  writeText(join(protocolsDir, 'index.md'),
    `# 子协议列表\n\n> 共 ${data.protocols.length} 个子协议\n\n${renderTable(
      ['ID', '名称', '版本', '接口数', '老格式迁移'],
      subListRows,
    )}\n`,
  );

  // protocols/<id>/index.md + protocols/<id>/<iface>.md
  // B1-I5：拆出独立目录（避免 protocols/<id>.md 与 protocols/<id>/index.md 路由冲突）
  for (const proto of data.protocols) {
    const specs = subSpecs.get(proto.id) ?? [];
    const protoDir = join(protocolsDir, encodeURIComponent(proto.id));
    mkdirSync(protoDir, { recursive: true });
    // 子协议总览：写为 protocols/<id>/index.md（VitePress 目录式路由）
    writeText(
      join(protoDir, 'index.md'),
      renderSubProtocolPage(proto, specs, data.crossRefs)
    );
    // 每个接口详情页：protocols/<id>/<iface>.md
    for (const iface of specs) {
      writeText(
        join(protoDir, `${encodeURIComponent(iface.id)}.md`),
        renderProjectInterfaceDetailPage(proto, iface, data.crossRefs, bindingView)
      );
    }

    // 单协议具体信息页（test-cases/verification/diff/bindings）：
    // 复用单协议 webgen 渲染函数，机械生成该子协议视图并写入组合层
    // protocols/<id>/（替代人工复制单协议产物）。缺 derived 产物/解析失败时
    // 降级为 warnings，不阻断组合层生成。
    try {
      const subRoot = join(rootDir, 'protocol', proto.id);
      const envelope = subEnvelopes.get(proto.id);
      if (envelope) {
        const model: SourceProtocolModel = parseProtocolFile(
          join(subRoot, 'model.md'),
          { allowDegraded: true }
        );
        const subData = buildWebData({
          specsEnvelope: envelope,
          model,
          testCases: readOptionalJson<TestCaseSet>(join(subRoot, 'derived/test-cases.json')),
          verification: readOptionalJson<VerificationReport>(join(subRoot, 'derived/verification/verification-report.json')),
          implCheck: readOptionalJson<ImplCheckReport>(join(subRoot, 'derived/impl-check/impl-check-report.json')),
          diff: readOptionalJson<ModelDiff>(join(subRoot, 'derived/diff/model-diff.json')),
          impact: readOptionalJson<ImpactAnalysis>(join(subRoot, 'derived/impact-analysis.json')),
          bindings: bindingView?.hasBindings
            ? (redactSensitiveFields(bindingsRaw ?? {}) as BindingConfig)
            : undefined,
        });
        const subDataRedacted = redactSensitiveFields(subData) as typeof subData;
        writeText(join(protoDir, 'test-cases.md'), renderTestCasesPage(subDataRedacted));
        writeText(join(protoDir, 'verification.md'), renderVerificationPage(subDataRedacted));
        writeText(join(protoDir, 'diff.md'), renderDiffPage(subDataRedacted));
        writeText(join(protoDir, 'bindings.md'), renderBindingViewPage(subDataRedacted));
      } else {
        allWarnings.push(`[${proto.id}] specs.json 不可读，跳过单协议具体信息页生成`);
      }
    } catch (err) {
      allWarnings.push(
        `[${proto.id}] 单协议具体信息页生成失败：${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // cross-refs.md
  writeText(join(docsDir, 'cross-refs.md'), renderCrossRefsPage(data));

  // cross-diff.md（骨架）
  writeText(join(docsDir, 'cross-diff.md'), renderCrossDiffSkeleton(data));

  // 9. 站点工程 web/package.json（项目级 web/ 不一定存在；保持与单协议 webgen 一致）
  //    注：derive-web 单协议模式已写 web/package.json；这里仅在缺失时补一份（覆盖与否由 --force 控制）
  if (!existsSync(join(webDir, 'package.json'))) {
    writeText(
      join(webDir, 'package.json'),
      JSON.stringify(
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
          devDependencies: { vitepress: '^1.6.3' },
        },
        null,
        2,
      ),
    );
  }

  // 10. VitePress build（可选）
  const distDir = options.distDir ?? join(docsDir, '.vitepress/dist');
  let built = false;
  if (options.buildProjectSite !== false) {
    // B1-I6 修复：vitepress 不在 node_modules 时自动 npm install（防 rm -rf web 后报错）
    await ensureVitepressInstalled(webDir, allWarnings);
    const { spawnSync } = await import('node:child_process');
    const cmd = `npx --yes vitepress build docs`;
    const result = spawnSync(cmd, {
      cwd: webDir,
      encoding: 'utf-8',
      shell: true,
      timeout: 180000,
    });
    if (result.status !== 0) {
      allWarnings.push(
        `vitepress build 退出码 ${result.status}（stderr: ${(result.stderr ?? '').slice(0, 500)}）`
      );
    } else if (existsSync(join(distDir, 'index.html'))) {
      built = true;
    } else {
      allWarnings.push(`vitepress build 完成但未产出 dist/index.html（cwd=${webDir}）`);
    }
  }

  return {
    data,
    dataJsonPath,
    webDir,
    distDir,
    built,
    warnings: allWarnings,
  };
}

// ============================================================================
// 辅助：被父目录 utils 引用的子路径工具（避免外部 import 时找不到 basename）
// ============================================================================

/** 子协议 specs.json 路径（暴露给测试使用） */
export function specsPathFor(rootDir: string, protocolId: string): string {
  return join(rootDir, 'protocol', protocolId, 'derived', 'specs.json');
}

/** 文件名 basename（re-export for convenience） */
export { basename };
/** 路径 dirname（re-export for convenience） */
export { dirname };
