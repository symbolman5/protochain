/**
 * 三层 Markdown 解析器（扩展版）
 *
 * 设计依据：《协议驱动自验证工具链设计方案》2.1 parser 模块、3.1 类型定义、决策8
 *
 * 输入：protocol/model.md（三层 Markdown）
 * 输出：SourceProtocolModel（含 metadata/readable/derivable，单一权威源）
 *
 * 三层结构：
 * - 元数据层：YAML front matter
 * - 可读层：# 背景 / # 核心概念 / # 协作流程 / # 异常处理原则 等散文段
 * - 可推演层：# 状态空间 / # 转移规则 / # 不变量 / # 时序约束 / # 异常路径 表格
 *            或形式化代码块（退化模式）
 *
 * 扩展（决策8）：
 * - 多维度状态 / 扩展转移规则（triggerType/trigger/actionType/affectsDimensions）
 * - continuous·scheduled 时序 / 资源池 / 实例化 / 外部事件 / 消极保证 / 附属实体 / 角色分类
 * - 扩展段检测：段落级可选（语义A）+ 字段级必填（语义B）
 * - 遗留 model.md 迁移补全：triggerType/trigger 从 triggerRoleId 推断等
 */

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type {
  SourceProtocolModel,
  MetadataLayer,
  LivenessMode,
  ReadableLayer,
  DerivableLayer,
  StateDef,
  StateDimension,
  TransitionDef,
  InvariantDef,
  TimingDef,
  ExceptionPathDef,
  RoleDeclaration,
  ChangeDeclaration,
  ConceptDef,
  ContractLayerInput,
  ResourcePoolDef,
  InstantiationDef,
  ExternalEventDef,
  NegativeAssuranceDef,
  SubsidiaryEntityDef,
  GuardTranslationDef,
  AttributeEffect,
} from '../model/types.js';
import {
  parseMarkdownAst,
  splitByHeadings,
  nodeToText,
  findFirstTable,
  findFirstCodeBlock,
  tableToObjects,
  ParseError,
  type MdastNode,
  type Section,
  type Table,
} from './markdown-ast.js';
import {
  detectExtensionSectionList,
  detectExtensionSectionObject,
} from './extension-sections.js';

// 重新导出 ParseError，保持外部 import 兼容
export { ParseError };

// ----------------------------------------------------------------------------
// 主入口
// ----------------------------------------------------------------------------

export interface ParseOptions {
  /** 是否允许退化模式（形式化代码块），默认 true */
  allowDegraded?: boolean;
}

export function parseProtocolFile(
  filePath: string,
  options: ParseOptions = {}
): SourceProtocolModel {
  const content = readFileSync(filePath, 'utf-8');
  return parseProtocolContent(content, filePath, options);
}

export function parseProtocolContent(
  content: string,
  sourcePath?: string,
  options: ParseOptions = {}
): SourceProtocolModel {
  const { frontMatter, body } = splitFrontMatter(content);
  const metadata = parseMetadata(frontMatter);
  const ast = parseMarkdownAst(body);
  const sections = splitByHeadings(ast);

  const readable = parseReadableLayer(sections);
  const { derivable, contractInput } = parseDerivableLayer(
    sections,
    metadata,
    options.allowDegraded ?? true
  );

  return {
    metadata,
    readable,
    derivable,
    contractInput,
    sourcePath,
    parsedAt: new Date().toISOString(),
  };
}

// ----------------------------------------------------------------------------
// Front Matter 解析
// ----------------------------------------------------------------------------

interface FrontMatterResult {
  frontMatter: string | null;
  body: string;
}

function splitFrontMatter(content: string): FrontMatterResult {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontMatter: null, body: content };
  }
  return { frontMatter: match[1], body: match[2] };
}

function parseMetadata(frontMatter: string | null): MetadataLayer {
  if (!frontMatter) {
    throw new ParseError(
      '缺少 YAML front matter（元数据层）。使用 protochain init 生成标准模板。'
    );
  }

  const raw = parseYaml(frontMatter) as Record<string, unknown>;
  if (!raw || typeof raw !== 'object') {
    throw new ParseError('front matter 必须是 YAML 对象');
  }

  const name = requireString(raw, 'name', '元数据层');
  const version = requireString(raw, 'version', '元数据层');
  const purpose = requireString(raw, 'purpose', '元数据层');
  const roles = parseRoles(raw.roles);
  const changeDeclarations = parseChangeDeclarations(raw.changeDeclarations);
  const liveness = parseLivenessMode(raw.liveness);

  return { name, version, purpose, roles, changeDeclarations, liveness };
}

function parseLivenessMode(v: unknown): LivenessMode | undefined {
  if (v === undefined || v === null) return undefined;
  if (v === 'weak' || v === 'strong') return v;
  throw new ParseError(`metadata.liveness 必须是 weak 或 strong，实际为 ${v}`);
}

function parseRoles(raw: unknown): RoleDeclaration[] {
  if (!Array.isArray(raw)) {
    throw new ParseError('元数据层 roles 必须是数组');
  }
  return raw.map((item, idx) => {
    if (!item || typeof item !== 'object') {
      throw new ParseError(`roles[${idx}] 必须是对象`);
    }
    const r = item as Record<string, unknown>;
    const role: RoleDeclaration = {
      id: requireString(r, 'id', `roles[${idx}]`),
      name: requireString(r, 'name', `roles[${idx}]`),
      responsibilities: optionalString(r, 'responsibilities'),
      // 扩展：roleType（遗留迁移补全：未声明默认 participant）
      roleType: parseRoleType(r.roleType),
      anonymous: typeof r.anonymous === 'boolean' ? r.anonymous : undefined,
    };
    if (role.anonymous === undefined) delete role.anonymous;
    return role;
  });
}

function parseRoleType(v: unknown): 'consensus' | 'participant' {
  if (v === undefined || v === null) return 'participant';
  if (v === 'consensus' || v === 'participant') return v;
  throw new ParseError(`roleType 必须是 consensus 或 participant，实际为 ${v}`);
}

function parseChangeDeclarations(raw: unknown): ChangeDeclaration[] | undefined {
  if (!raw) return undefined;
  if (!Array.isArray(raw)) {
    throw new ParseError('changeDeclarations 必须是数组');
  }
  return raw.map((item, idx) => {
    const r = item as Record<string, unknown>;
    const changeType = requireString(r, 'changeType', `changeDeclarations[${idx}]`);
    if (changeType !== 'paradigm_renegotiation' && changeType !== 'protocol_tweak') {
      throw new ParseError(
        `changeDeclarations[${idx}].changeType 必须是 paradigm_renegotiation 或 protocol_tweak`
      );
    }
    return {
      targetId: requireString(r, 'targetId', `changeDeclarations[${idx}]`),
      changeType,
      reason: requireString(r, 'reason', `changeDeclarations[${idx}]`),
    };
  });
}

// ----------------------------------------------------------------------------
// 可读层解析
// ----------------------------------------------------------------------------

const READABLE_SECTIONS = new Map<string, keyof ReadableLayer>([
  ['背景', 'background'],
  ['背景与目标', 'background'],
  ['协议背景', 'background'],
  ['核心概念', 'concepts'],
  ['概念', 'concepts'],
  ['术语', 'concepts'],
  ['协作流程', 'workflow'],
  ['工作流程', 'workflow'],
  ['流程', 'workflow'],
  ['异常处理原则', 'exceptionHandling'],
  ['异常处理', 'exceptionHandling'],
]);

function parseReadableLayer(sections: Section[]): ReadableLayer {
  const result: ReadableLayer = {
    background: '',
    concepts: [],
    workflow: '',
  };

  for (const section of sections) {
    const field = matchReadableSection(section.heading);
    if (!field) continue;

    if (field === 'concepts') {
      result.concepts = parseConcepts(section.children);
    } else if (field === 'background' || field === 'workflow' || field === 'exceptionHandling') {
      result[field] = collectParagraphText(section.children);
    }
  }

  return result;
}

function matchReadableSection(
  heading: string
): keyof ReadableLayer | null {
  for (const [key, field] of READABLE_SECTIONS) {
    if (heading.includes(key)) return field;
  }
  return null;
}

function parseConcepts(nodes: MdastNode[]): ConceptDef[] {
  const concepts: ConceptDef[] = [];
  for (const node of nodes) {
    if (node.type === 'list' && node.children) {
      for (const item of node.children) {
        const text = nodeToText(item);
        const concept = parseConceptLine(text);
        if (concept) concepts.push(concept);
      }
    } else if (node.type === 'paragraph') {
      const text = nodeToText(node);
      const concept = parseConceptLine(text);
      if (concept) concepts.push(concept);
    }
  }
  return concepts;
}

function parseConceptLine(line: string): ConceptDef | null {
  const cleaned = line.replace(/^[-*]\s*/, '').trim();
  const match = cleaned.match(/^\*?\*?(.+?)\*?\*?\s*[:：]\s*(.+)$/);
  if (!match) return null;
  return {
    term: match[1].replace(/\*/g, '').trim(),
    definition: match[2].trim(),
  };
}

function collectParagraphText(nodes: MdastNode[]): string {
  return nodes
    .filter((n) => n.type === 'paragraph' || n.type === 'list')
    .map((n) => nodeToText(n))
    .join('\n\n')
    .trim();
}

// ----------------------------------------------------------------------------
// 可推演层解析（含退化模式检测 + 扩展段解析 + 遗留迁移补全）
// ----------------------------------------------------------------------------

const DERIVABLE_TABLE_SECTIONS = new Map<string, 'states' | 'transitions' | 'invariants' | 'timing' | 'exceptions'>([
  ['状态空间', 'states'],
  ['状态', 'states'],
  ['转移规则', 'transitions'],
  ['转移', 'transitions'],
  ['不变量', 'invariants'],
  ['时序约束', 'timing'],
  ['时序', 'timing'],
  ['异常路径', 'exceptions'],
  ['异常', 'exceptions'],
]);

// 退化模式：形式化语言代码块所在章节
const DERIVABLE_FORMAL_SECTIONS = new Set([
  '可推演层',
  '可推演层(形式化)',
  '可推演层（形式化）',
  '形式化规格',
  'formalspec',
]);

const FORMAL_LANG_MAP: Record<string, NonNullable<DerivableLayer['formalLanguage']>> = {
  tla: 'tla',
  'tla+': 'tla',
  scxml: 'scxml',
  alloy: 'alloy',
  'decision-table': 'decision-table',
};

function parseDerivableLayer(
  sections: Section[],
  metadata: MetadataLayer,
  allowDegraded: boolean
): { derivable: DerivableLayer; contractInput?: ContractLayerInput } {
  // 检测退化模式：在形式化章节或可推演层章节下出现代码块
  const formalBlock = findFormalCodeBlock(sections);

  let degraded = false;
  let formalSpecRaw: string | undefined;
  let formalLanguage: DerivableLayer['formalLanguage'];

  if (formalBlock) {
    degraded = true;
    formalSpecRaw = formalBlock.value;
    formalLanguage = FORMAL_LANG_MAP[formalBlock.lang] ?? 'unknown';
    if (!allowDegraded) {
      throw new ParseError(
        `检测到形式化代码块（${formalBlock.lang}），但当前配置不允许退化模式`,
        '可推演层'
      );
    }
  }

  // 解析结构化表格（正常模式全量；退化模式尽可能提取——策略B）
  const states: StateDef[] = [];
  const transitions: TransitionDef[] = [];
  const invariants: InvariantDef[] = [];
  const timing: TimingDef[] = [];
  const exceptions: ExceptionPathDef[] = [];

  for (const section of sections) {
    const kind = matchDerivableTableSection(section.heading);
    if (!kind) continue;

    const table = findFirstTable(section.children);
    if (!table) continue;

    const rows = tableToObjects(table, normalizeHeader);
    switch (kind) {
      case 'states':
        states.push(...rows.map(rowToState));
        break;
      case 'transitions':
        transitions.push(...rows.map(rowToTransition));
        break;
      case 'invariants':
        invariants.push(...rows.map(rowToInvariant));
        break;
      case 'timing':
        timing.push(...rows.map(rowToTiming));
        break;
      case 'exceptions':
        exceptions.push(...rows.map(rowToException));
        break;
    }
  }

  // 遗留迁移补全：扩展字段在表格行未声明时按决策8补全
  applyLegacyMigration(states, transitions, invariants, timing, metadata);

  // 扩展段解析（决策8 段落级可选）
  const resourcePools = parseResourcePools(sections);
  const instantiation = parseInstantiation(sections);
  const externalEvents = parseExternalEvents(sections);
  const negativeAssurances = parseNegativeAssurances(sections, metadata);
  const subsidiaryEntities = parseSubsidiaryEntities(sections);
  const guardTranslations = parseGuardTranslations(sections);

  // 推断初始状态与终态
  const initialStateId = states.find((s) => s.type === 'initial')?.id;
  const terminalStateIds = states.filter((s) => s.type === 'terminal').map((s) => s.id);

  const derivable: DerivableLayer = {
    degraded,
    formalSpecRaw,
    formalLanguage,
    states,
    transitions,
    invariants,
    timing,
    exceptions,
    initialStateId,
    terminalStateIds,
    resourcePools: resourcePools.length > 0 ? resourcePools : undefined,
    instantiation,
    externalEvents: externalEvents.length > 0 ? externalEvents : undefined,
    negativeAssurances:
      negativeAssurances.length > 0 ? negativeAssurances : undefined,
    subsidiaryEntities:
      subsidiaryEntities.length > 0 ? subsidiaryEntities : undefined,
    guardTranslations:
      guardTranslations.length > 0 ? guardTranslations : undefined,
  };

  // 契约层（可选，仅校验用）
  const contractInput = parseContractInput(sections);

  return { derivable, contractInput };
}

function findFormalCodeBlock(
  sections: Section[]
): { lang: string; value: string } | null {
  for (const section of sections) {
    if (!DERIVABLE_FORMAL_SECTIONS.has(section.heading)) continue;
    for (const node of section.children) {
      if (node.type === 'code' && node.lang) {
        return { lang: node.lang, value: node.value ?? '' };
      }
    }
  }
  return null;
}

function matchDerivableTableSection(
  heading: string
): 'states' | 'transitions' | 'invariants' | 'timing' | 'exceptions' | null {
  for (const [key, field] of DERIVABLE_TABLE_SECTIONS) {
    if (heading.includes(key)) return field;
  }
  return null;
}

function normalizeHeader(s: string): string {
  // 中英文表头统一映射
  const trimmed = s.trim().toLowerCase().replace(/\s+/g, '');
  const map: Record<string, string> = {
    id: 'id',
    名称: 'name',
    名: 'name',
    类型: 'type',
    描述: 'description',
    说明: 'description',
    角色: 'roles',
    角色id: 'roles',
    from: 'from',
    to: 'to',
    action: 'action',
    动作: 'action',
    trigger: 'trigger',
    触发: 'trigger',
    触发者: 'trigger',
    触发角色: 'trigger',
    触发条件: 'trigger',
    guard: 'guard',
    守卫: 'guard',
    条件: 'guard',
    effects: 'effects',
    副作用: 'effects',
    表达式: 'expression',
    作用状态: 'scope',
    作用范围: 'scope',
    type: 'type',
    源: 'source',
    源事件: 'source',
    目标: 'target',
    目标事件: 'target',
    source: 'source',
    target: 'target',
    约束值: 'boundms',
    '约束值(ms)': 'boundms',
    '时长(ms)': 'boundms',
    转移序列: 'transitionids',
    恢复策略: 'recovery',
    // 扩展字段表头
    triggertype: 'triggertype',
    触发类型: 'triggertype',
    actiontype: 'actiontype',
    动作类型: 'actiontype',
    affectsdimensions: 'affectsdimensions',
    影响维度: 'affectsdimensions',
    declaredby: 'declaredby',
    声明方: 'declaredby',
    invariantclass: 'invariantclass',
    不变量类别: 'invariantclass',
    onviolation: 'onviolation',
    违约转移: 'onviolation',
    schedule: 'schedule',
    定时: 'schedule',
  };
  return map[trimmed] ?? trimmed;
}

function rowToState(row: Record<string, string>): StateDef {
  const id = requireRowField(row, 'id', '状态空间');
  const name = requireRowField(row, 'name', '状态空间');
  const typeRaw = (row.type || 'normal').toLowerCase();
  const type: StateDef['type'] =
    typeRaw === 'initial' || typeRaw === '初始'
      ? 'initial'
      : typeRaw === 'terminal' || typeRaw === '终态'
        ? 'terminal'
        : typeRaw === 'error' || typeRaw === '错误'
          ? 'error'
          : 'normal';
  const roles = row.roles ? row.roles.split(/[|,，]/).map((s) => s.trim()).filter(Boolean) : undefined;
  return {
    id,
    name,
    type,
    description: row.description || undefined,
    roleIds: roles && roles.length > 0 ? roles : undefined,
    // 多维度状态在扩展段"状态维度"中声明，此处不解析表格维度列
  };
}

function rowToTransition(row: Record<string, string>): TransitionDef {
  const id = requireRowField(row, 'id', '转移规则');
  const name = requireRowField(row, 'name', '转移规则');
  const fromRaw = requireRowField(row, 'from', '转移规则');
  const fromList = fromRaw.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  const to = requireRowField(row, 'to', '转移规则');
  const action = requireRowField(row, 'action', '转移规则');
  const effects = row.effects
    ? row.effects.split(/[|;；]/).map((s) => s.trim()).filter(Boolean)
    : undefined;
  // 扩展字段（表格中声明时直接读取；未声明在 applyLegacyMigration 中补全）
  const triggerTypeRaw = (row.triggertype || '').toLowerCase();
  const triggerType: TransitionDef['triggerType'] | undefined =
    triggerTypeRaw === 'role' || triggerTypeRaw === 'system' || triggerTypeRaw === 'external'
      ? (triggerTypeRaw as TransitionDef['triggerType'])
      : undefined;
  const affectsDimensions = row.affectsdimensions
    ? row.affectsdimensions.split(/[|,，]/).map((s) => s.trim()).filter(Boolean)
    : undefined;
  const actionTypeRaw = (row.actiontype || '').toLowerCase();
  const actionType: TransitionDef['actionType'] | undefined =
    actionTypeRaw === 'state_transition' || actionTypeRaw === 'attribute_update'
      ? (actionTypeRaw as TransitionDef['actionType'])
      : undefined;

  const t: TransitionDef = {
    id,
    name,
    from: fromList,
    to,
    action,
    triggerRoleId: row.trigger || undefined,
    guard: row.guard || undefined,
    effects: effects && effects.length > 0 ? effects : undefined,
    isException: false,
    // 扩展字段（可能为 undefined，由 applyLegacyMigration 补全为必填值）
    triggerType: triggerType!,
    trigger: row.trigger ?? '',
    actionType: actionType!,
    affectsDimensions: affectsDimensions ?? [],
  };
  return t;
}

function rowToInvariant(row: Record<string, string>): InvariantDef {
  const id = requireRowField(row, 'id', '不变量');
  const name = requireRowField(row, 'name', '不变量');
  const expression = requireRowField(row, 'expression', '不变量');
  const scope = row.scope
    ? row.scope.split(/[|,，]/).map((s) => s.trim()).filter(Boolean)
    : undefined;
  // 扩展字段（表格声明时直接读取；未声明在 applyLegacyMigration 补全）
  const invariantClassRaw = (row.invariantclass || '').toLowerCase();
  const invariantClass: InvariantDef['invariantClass'] | undefined =
    invariantClassRaw === 'intra_protocol' ||
    invariantClassRaw === 'cross_protocol' ||
    invariantClassRaw === 'cross_instance'
      ? (invariantClassRaw as InvariantDef['invariantClass'])
      : undefined;

  const inv: InvariantDef = {
    id,
    name,
    expression,
    scopeStateIds: scope && scope.length > 0 ? scope : undefined,
    description: row.description || undefined,
    declaredBy: row.declaredby ?? '',
    invariantClass: invariantClass!,
  };
  return inv;
}

function rowToTiming(row: Record<string, string>): TimingDef {
  const id = requireRowField(row, 'id', '时序约束');
  const name = requireRowField(row, 'name', '时序约束');
  const typeRaw = (row.type || 'response').toLowerCase();
  const type: TimingDef['type'] =
    typeRaw === 'deadline' || typeRaw === '截止'
      ? 'deadline'
      : typeRaw === 'timeout' || typeRaw === '超时'
        ? 'timeout'
        : typeRaw === 'ordering' || typeRaw === '顺序'
          ? 'ordering'
          : typeRaw === 'continuous' || typeRaw === '持续'
            ? 'continuous'
            : typeRaw === 'scheduled' || typeRaw === '定时'
              ? 'scheduled'
              : 'response';
  const boundMs = row.boundms ? parseInt(row.boundms, 10) : undefined;
  const t: TimingDef = {
    id,
    name,
    type,
    source: requireRowField(row, 'source', '时序约束'),
    target: requireRowField(row, 'target', '时序约束'),
    boundMs: Number.isFinite(boundMs) ? boundMs : undefined,
    onViolation: row.onviolation || undefined,
    schedule: row.schedule || undefined,
    description: row.description || undefined,
  };
  return t;
}

function rowToException(row: Record<string, string>): ExceptionPathDef {
  const id = requireRowField(row, 'id', '异常路径');
  const name = requireRowField(row, 'name', '异常路径');
  const trigger = requireRowField(row, 'trigger', '异常路径');
  const transitionIds = (row.transitionids || '')
    .split(/[|,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    id,
    name,
    trigger,
    transitionIds,
    recovery: row.recovery || undefined,
  };
}

// ----------------------------------------------------------------------------
// 遗留迁移补全（决策8）
// ----------------------------------------------------------------------------

/**
 * 遗留 model.md（无扩展字段）迁移时补全必填字段：
 * - triggerType/trigger 从 triggerRoleId 推断：
 *   有值 → triggerType='role', trigger=triggerRoleId
 *   无值 → triggerType='system', trigger='system'
 * - actionType 默认 'state_transition'
 * - affectsDimensions 默认 []
 * - roleType 默认 'participant'（在 parseRoles 中已处理）
 * - declaredBy/invariantClass 默认取首个 roleType='consensus' 的角色 ID；
 *   若无共识方则视为校验失败（必须显式声明）—— 此处抛 ParseError
 *
 * 已显式声明的字段不覆盖。
 */
function applyLegacyMigration(
  states: StateDef[],
  transitions: TransitionDef[],
  invariants: InvariantDef[],
  _timing: TimingDef[],
  metadata: MetadataLayer
): void {
  // 转移扩展字段补全
  for (const t of transitions) {
    if (!t.triggerType) {
      if (t.triggerRoleId) {
        t.triggerType = 'role';
        if (!t.trigger) t.trigger = t.triggerRoleId;
      } else {
        t.triggerType = 'system';
        if (!t.trigger) t.trigger = 'system';
      }
    }
    if (!t.actionType) t.actionType = 'state_transition';
    if (!t.affectsDimensions) t.affectsDimensions = [];
  }

  // 不变量扩展字段补全
  let firstConsensus = metadata.roles.find((r) => r.roleType === 'consensus');
  // 向后兼容迁移：遗留 model.md 无 roleType 声明（全部默认 participant），
  // 此时将首个角色提升为 consensus（遗留协议必然存在共识方，仅未显式标注）。
  if (!firstConsensus && metadata.roles.length > 0) {
    firstConsensus = metadata.roles[0];
    firstConsensus.roleType = 'consensus';
  }
  for (const inv of invariants) {
    if (!inv.declaredBy) {
      if (!firstConsensus) {
        throw new ParseError(
          `不变量 "${inv.id}" 未声明 declaredBy，且 metadata.roles 为空。必须显式声明角色与共识方。`,
          '不变量'
        );
      }
      inv.declaredBy = firstConsensus.id;
    }
    if (!inv.invariantClass) {
      inv.invariantClass = 'intra_protocol';
    }
  }
}

// ----------------------------------------------------------------------------
// 扩展段解析（决策8 段落级可选）
// ----------------------------------------------------------------------------

/** 资源池段：每段一个 YAML 数组 */
function parseResourcePools(sections: Section[]): ResourcePoolDef[] {
  return detectExtensionSectionList(
    sections,
    ['资源池', 'resourcepool'],
    '资源池',
    (yaml) => parseResourcePoolItem(yaml)
  );
}

function parseResourcePoolItem(yaml: unknown): ResourcePoolDef {
  const r = asRecord(yaml, '资源池');
  return {
    id: requireString(r, 'id', '资源池'),
    name: requireString(r, 'name', '资源池'),
    type: requireString(r, 'type', '资源池'),
    capacity: (r.capacity as string | number) ?? '',
    allocationRule: requireString(r, 'allocationRule', '资源池'),
    releaseRule: requireString(r, 'releaseRule', '资源池'),
    constraints: asStringArray(r.constraints, '资源池.constraints'),
    checkMethod: requireString(r, 'checkMethod', '资源池'),
    crossInvariantIds: asStringArray(r.crossInvariantIds, '资源池.crossInvariantIds') ?? undefined,
  };
}

/** 实例化段：单对象 */
function parseInstantiation(sections: Section[]): InstantiationDef | undefined {
  return detectExtensionSectionObject(
    sections,
    ['实例化', 'instantiation'],
    '实例化',
    (yaml) => {
      const r = asRecord(yaml, '实例化');
      return {
        type: 'template',
        instanceKey: requireString(r, 'instanceKey', '实例化'),
        instanceLifecycle: requireString(r, 'instanceLifecycle', '实例化'),
        instanceInvariants: asStringArray(r.instanceInvariants, '实例化.instanceInvariants'),
        crossInstanceInvariants: asStringArray(r.crossInstanceInvariants, '实例化.crossInstanceInvariants'),
        crossInstanceInvariantsLocation: 'composition',
      };
    }
  );
}

/** 外部事件段：YAML 数组 */
function parseExternalEvents(sections: Section[]): ExternalEventDef[] {
  return detectExtensionSectionList(
    sections,
    ['外部事件', 'externalevent'],
    '外部事件',
    (yaml) => {
      const r = asRecord(yaml, '外部事件');
      return {
        id: requireString(r, 'id', '外部事件'),
        name: requireString(r, 'name', '外部事件'),
        source: requireString(r, 'source', '外部事件'),
        triggerAction: requireString(r, 'triggerAction', '外部事件'),
        idempotencyKey: optionalString(r, 'idempotencyKey'),
        ordering: r.ordering as ExternalEventDef['ordering'] | undefined,
        onDelay: optionalString(r, 'onDelay'),
        onDuplicate: optionalString(r, 'onDuplicate'),
      };
    }
  );
}

/** 消极保证段：YAML 数组 */
function parseNegativeAssurances(
  sections: Section[],
  metadata: MetadataLayer
): NegativeAssuranceDef[] {
  const items = detectExtensionSectionList(
    sections,
    ['消极保证', 'negativeassurance'],
    '消极保证',
    (yaml) => {
      const r = asRecord(yaml, '消极保证');
      let declaredBy = optionalString(r, 'declaredBy');
      if (!declaredBy) {
        let firstConsensus = metadata.roles.find((rl) => rl.roleType === 'consensus');
        if (!firstConsensus && metadata.roles.length > 0) {
          firstConsensus = metadata.roles[0];
        }
        if (!firstConsensus) {
          throw new ParseError(
            '消极保证段未声明 declaredBy，且 metadata.roles 为空，必须显式声明',
            '消极保证'
          );
        }
        declaredBy = firstConsensus.id;
      }
      return {
        id: requireString(r, 'id', '消极保证'),
        name: requireString(r, 'name', '消极保证'),
        expression: requireString(r, 'expression', '消极保证'),
        scope: requireString(r, 'scope', '消极保证'),
        declaredBy,
        checkMethod: requireString(r, 'checkMethod', '消极保证'),
      };
    }
  );
  return items;
}

/** 附属实体段：YAML 数组 */
function parseSubsidiaryEntities(sections: Section[]): SubsidiaryEntityDef[] {
  return detectExtensionSectionList(
    sections,
    ['附属实体', 'subsidiaryentity'],
    '附属实体',
    (yaml) => {
      const r = asRecord(yaml, '附属实体');
      const stateSpace = r.stateSpace as { dimensions?: unknown } | undefined;
      const dimensions = parseDimensions(stateSpace?.dimensions, '附属实体.stateSpace.dimensions');
      return {
        id: requireString(r, 'id', '附属实体'),
        name: requireString(r, 'name', '附属实体'),
        belongsTo: requireString(r, 'belongsTo', '附属实体'),
        instanceKey: requireString(r, 'instanceKey', '附属实体'),
        lifecycleDependency: requireString(r, 'lifecycleDependency', '附属实体'),
        cascadeRules: asStringArray(r.cascadeRules, '附属实体.cascadeRules'),
        stateSpace: { dimensions },
        invariants: asStringArray(r.invariants, '附属实体.invariants'),
      };
    }
  );
}

/**
 * 守卫翻译声明段：YAML 数组，每项描述一条自然语言守卫的 TLA+ 注入方式。
 * 工具链不解释语义，仅把声明中的 TLA+ 片段机械注入骨架。
 */
function parseGuardTranslations(sections: Section[]): GuardTranslationDef[] {
  return detectExtensionSectionList(
    sections,
    ['守卫翻译', 'guardtranslation'],
    '守卫翻译',
    (yaml) => {
      const r = asRecord(yaml, '守卫翻译');
      const actions = asStringArray(r.actions, '守卫翻译.actions');
      return {
        id: requireString(r, 'id', '守卫翻译'),
        action: optionalString(r, 'action'),
        actions: actions.length > 0 ? actions : undefined,
        guardContains: optionalString(r, 'guardContains'),
        guardExpr: requireString(r, 'guardExpr', '守卫翻译'),
        prologue: asStringArray(r.prologue, '守卫翻译.prologue') ?? [],
        initConjuncts: asStringArray(r.initConjuncts, '守卫翻译.initConjuncts') ?? [],
        nextDisjuncts: asStringArray(r.nextDisjuncts, '守卫翻译.nextDisjuncts') ?? [],
        invariants: (asRecordArray(r.invariants, '守卫翻译.invariants') ?? []).map(
          (inv) => ({
            id: requireString(inv, 'id', '守卫翻译.invariants'),
            expression: requireString(inv, 'expression', '守卫翻译.invariants'),
          })
        ),
        typeConjuncts: asStringArray(r.typeConjuncts, '守卫翻译.typeConjuncts') ?? [],
        stutterVars: asStringArray(r.stutterVars, '守卫翻译.stutterVars') ?? [],
      };
    }
  );
}

/** 解析 StateDimension[]（用于状态维度声明、附属实体 stateSpace） */
function parseDimensions(yaml: unknown, fieldPath: string): StateDimension[] {
  if (!yaml) return [];
  if (!Array.isArray(yaml)) {
    throw new ParseError(`${fieldPath} 必须是数组`);
  }
  return yaml.map((item, idx) => {
    const r = asRecord(item, `${fieldPath}[${idx}]`);
    const initial = r.initial as string | number | boolean;
    if (initial === undefined || initial === null) {
      throw new ParseError(`${fieldPath}[${idx}].initial 必填`);
    }
    return {
      name: requireString(r, 'name', `${fieldPath}[${idx}]`),
      type: requireString(r, 'type', `${fieldPath}[${idx}]`),
      initial,
      validWhen: optionalString(r, 'validWhen'),
    };
  });
}

function parseContractInput(sections: Section[]): ContractLayerInput | undefined {
  const contractSection = sections.find((s) =>
    s.heading.includes('契约层') || s.heading.includes('契约')
  );
  if (!contractSection) return undefined;

  // 支持 YAML 代码块形式的契约层输入
  const code = findFirstCodeBlock(contractSection.children, 'yaml');
  if (code && code.value) {
    try {
      const parsed = parseYaml(code.value) as Record<string, unknown>;
      return {
        parties: Array.isArray(parsed.parties) ? (parsed.parties as string[]) : [],
        expectedInformationFields: Array.isArray(parsed.expectedInformationFields)
          ? (parsed.expectedInformationFields as string[])
          : undefined,
      };
    } catch {
      // 忽略解析失败，尝试列表形式
    }
  } else {
    // 尝试任意代码块（兼容非 yaml 标注）
    const anyCode = findFirstCodeBlock(contractSection.children);
    if (anyCode && anyCode.value) {
      try {
        const parsed = parseYaml(anyCode.value) as Record<string, unknown>;
        return {
          parties: Array.isArray(parsed.parties) ? (parsed.parties as string[]) : [],
          expectedInformationFields: Array.isArray(parsed.expectedInformationFields)
            ? (parsed.expectedInformationFields as string[])
            : undefined,
        };
      } catch {
        // 忽略
      }
    }
  }

  // 支持列表形式
  const parties: string[] = [];
  for (const node of contractSection.children) {
    if (node.type === 'list' && node.children) {
      for (const item of node.children) {
        const text = nodeToText(item).trim();
        if (text) parties.push(text);
      }
    }
  }
  if (parties.length === 0) return undefined;
  return { parties };
}

// ----------------------------------------------------------------------------
// 工具函数
// ----------------------------------------------------------------------------

function requireString(
  obj: Record<string, unknown>,
  key: string,
  section: string
): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new ParseError(`${section} 缺少必填字段 "${key}" 或字段非字符串`);
  }
  return v.trim();
}

function optionalString(
  obj: Record<string, unknown>,
  key: string
): string | undefined {
  const v = obj[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

function requireRowField(
  row: Record<string, string>,
  key: string,
  section: string
): string {
  const v = row[key];
  if (!v || v.trim() === '') {
    throw new ParseError(`${section} 表格行缺少必填字段 "${key}"`);
  }
  return v.trim();
}

function asRecord(yaml: unknown, section: string): Record<string, unknown> {
  if (!yaml || typeof yaml !== 'object' || Array.isArray(yaml)) {
    throw new ParseError(`${section} 的 YAML 必须是对象`);
  }
  return yaml as Record<string, unknown>;
}

function asStringArray(yaml: unknown, fieldPath: string): string[] {
  if (yaml === undefined || yaml === null) return [];
  if (!Array.isArray(yaml)) {
    throw new ParseError(`${fieldPath} 必须是字符串数组`);
  }
  return yaml.map((item, idx) => {
    if (typeof item !== 'string') {
      throw new ParseError(`${fieldPath}[${idx}] 必须是字符串`);
    }
    return item;
  });
}

function asRecordArray(yaml: unknown, fieldPath: string): Record<string, unknown>[] {
  if (yaml === undefined || yaml === null) return [];
  if (!Array.isArray(yaml)) {
    throw new ParseError(`${fieldPath} 必须是对象数组`);
  }
  return yaml.map((item, idx) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ParseError(`${fieldPath}[${idx}] 必须是对象`);
    }
    return item as Record<string, unknown>;
  });
}
