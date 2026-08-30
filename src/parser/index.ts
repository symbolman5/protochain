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
  ContractEntry,
  SchemaExpression,
  JSONSchema,
  ResourcePoolDef,
  InstantiationDef,
  ExternalEventDef,
  NegativeAssuranceDef,
  SubsidiaryEntityDef,
  GuardTranslationDef,
  TransactionBoundaryDef,
  ComponentMappingDef,
  InterfaceImplementationMapping,
  DimensionStorageMapping,
  ComponentTransferMapping,
  AttributeEffect,
  ErrorResponseDef,
  RelationAssertion,
  RelationAssertionKind,
  // C-4（10 §4）：契约段分型声明取值类型（TI1 已在 types.ts 定义）
  InterfaceType,
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
  detectExtensionSection,
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
  const { derivable, contractInput, relationAssertions } = parseDerivableLayer(
    sections,
    metadata,
    options.allowDegraded ?? true
  );

  return {
    metadata,
    readable,
    derivable,
    contractInput,
    relationAssertions,
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
): { derivable: DerivableLayer; contractInput?: ContractLayerInput; relationAssertions?: RelationAssertion[] } {
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
  const transactionBoundaries = parseTransactionBoundaries(sections);
  const componentMapping = parseComponentMapping(sections);

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
    transactionBoundaries:
      transactionBoundaries !== undefined ? transactionBoundaries : undefined,
    componentMapping: componentMapping !== undefined ? componentMapping : undefined,
  };

  // 契约层（可选，仅校验用）
  const contractInput = parseContractInput(sections);

  // W1-b 关系断言段（可选声明段；无断言段 → undefined，老 model.md 零回归）
  const relationAssertions = parseRelationAssertions(sections);

  return { derivable, contractInput, relationAssertions };
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
    // 注：原 map 有 `source: 'source'`（时序约束源）；下方的 `source: 'source'` 为
    // E4 不变量的实现保证，重复键违反 TS1117。统一只保留 E4 列（map 去重即可）。
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
    'onviolation': 'onviolation',
    违约转移: 'onviolation',
    schedule: 'schedule',
    定时: 'schedule',
    // ── E4：不变量校验层级 ──
    level: 'level',
    层级: 'level',
    级别: 'level',
    // ── E4：不变量的实现侧责任分类 ──
    source: 'source',
    实现保证: 'source',
    storageref: 'storageref',
    存储表: 'storageref',
    // ── E4：守卫位置（by-design 段展示用） ──
    guardlocation: 'guardlocation',
    守卫位置: 'guardlocation',
    // ── E11：异常路径错误码列（协议错误码，snake_case 唯一） ──
    errorcode: 'errorcode',
    错误码: 'errorcode',
    '协议错误码': 'errorcode',
    // ── G7-S4（P2-8）：不变量 remedy 声明（处置动作 + 检测方式） ──
    remedy: 'remedyaction',
    remedyaction: 'remedyaction',
    处置动作: 'remedyaction',
    remedydetection: 'remedydetection',
    检测方式: 'remedydetection',
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

  // ── E4：数据级不变量字段（level / source / storageRef） ──
  // 旧表无 level 列 → 默认 state-machine（不破坏现有协议）
  const levelRaw = (row.level || '').toLowerCase();
  const level: InvariantDef['level'] | undefined =
    levelRaw === 'state-machine' || levelRaw === 'data' || levelRaw === '状态机' || levelRaw === '数据'
      ? (levelRaw === '状态机' ? 'state-machine' : levelRaw === '数据' ? 'data' : levelRaw) as InvariantDef['level']
      : undefined;
  const sourceRaw = (row.source || '').toLowerCase();
  const source: InvariantDef['source'] | undefined =
    sourceRaw === 'storage' || sourceRaw === 'guard' || sourceRaw === '存储' || sourceRaw === '守卫'
      ? (sourceRaw === '存储' ? 'storage' : sourceRaw === '守卫' ? 'guard' : sourceRaw) as InvariantDef['source']
      : undefined;

  const inv: InvariantDef = {
    id,
    name,
    expression,
    scopeStateIds: scope && scope.length > 0 ? scope : undefined,
    description: row.description || undefined,
    declaredBy: row.declaredby ?? '',
    invariantClass: invariantClass!,
    level,
    source,
    storageRef: row.storageref || undefined,
    // guardLocation 暂不放在 InvariantDef 主字段（避免污染 invariants 列表契约）；
    // 由 verify 阶段从 desc 末段 [guard:<loc>] 解析，归入 by-design 段。
  };
  // ── E4：可选的 guardLocation 行内字段；
  // 若声明，把位置拼到 description 末段，下游 sqlcheck 据此归入 by-design 段。
  if (row.guardlocation && row.guardlocation.trim().length > 0) {
    inv.description = (inv.description ?? '') + ` [guard:${row.guardlocation.trim()}]`;
  }
  // ── G7-S4（P2-8）：不变量 remedy 声明（可选列：处置动作 / 检测方式） ──
  // 老表格无 remedy 列 → 不设 remedy（兼容零回归）；有 remedy_action 无 detection → 显式降级（P2-8）。
  const remedyAction = row.remedyaction?.trim();
  if (remedyAction) {
    const remedyDetection = row.remedydetection?.trim();
    inv.remedy = {
      action: remedyAction,
      ...(remedyDetection
        ? {
            // detection 为可选 SchemaExpression：表格文本形态 → description-only（保留人读原文）
            detection: {
              kind: 'description-only' as const,
              description: remedyDetection,
            },
          }
        : {}),
    };
  }
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
  // E11：异常路径错误码列（旧表无该列 → 不填、不报错、不改变现有行为）
  const errorCode = row.errorcode ? row.errorcode.trim() : undefined;
  return {
    id,
    name,
    trigger,
    transitionIds,
    recovery: row.recovery || undefined,
    errorCode: errorCode && errorCode.length > 0 ? errorCode : undefined,
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
    // ── E4：旧表无 level 列时默认 state-machine（不破坏现有协议） ──
    if (!inv.level) {
      inv.level = 'state-machine';
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
 * G7-S5a（X9 / P1-5 判据11）：事务边界声明段 —— YAML 数组，每项声明一条接口的
 * 多实体操作事务边界（same_transaction / async_compensation）。
 *
 * 三态（与 detectExtensionSectionList 不同，必须区分「未声明」与「声明为空」）：
 * - 段不存在 → undefined（老模型形态：跨实体未声明走告警 + 迁移截止日 2026-09-30）；
 * - 段存在 → TransactionBoundaryDef[]（新模型形态：跨实体未声明者硬失败）。
 */
function parseTransactionBoundaries(sections: Section[]): TransactionBoundaryDef[] | undefined {
  const detection = detectExtensionSection(sections, ['事务边界', 'transactionboundary'], '事务边界');
  if (!detection.enabled) return undefined;
  const yaml = detection.yaml;
  if (yaml === null || yaml === undefined) return [];
  if (!Array.isArray(yaml)) {
    throw new ParseError('扩展段"事务边界"的 YAML 内容必须是数组', '事务边界');
  }
  return yaml.map((item, idx) => {
    const r = asRecord(item, `事务边界[${idx}]`);
    const boundaryType = r.boundaryType;
    if (boundaryType !== 'same_transaction' && boundaryType !== 'async_compensation') {
      throw new ParseError(
        `事务边界[${idx}].boundaryType 必须是 same_transaction 或 async_compensation，实际为 ${String(boundaryType)}`,
        '事务边界'
      );
    }
    return {
      id: requireString(r, 'id', '事务边界'),
      interface: requireString(r, 'interface', '事务边界'),
      boundaryType,
      description: optionalString(r, 'description'),
    };
  });
}

/**
 * G7-S5b（X18 / P1-10）：组件映射段 —— YAML 对象，含三张映射表
 * （interfaceImplementations 接口→组件 / dimensionStorage 维度→存储 /
 * componentTransfers 组件→组件传输）。薄到三张映射表，不发明复杂 DSL
 * （refactor-proposal.md P1-10）。
 *
 * 三态（与 parseTransactionBoundaries 同款，X18 沿用 S5a 模式）：
 * - 段不存在 → undefined（老模型形态：组件归属层数据源缺失，checker 跳过 R-KIND-10）；
 * - 段存在 → ComponentMappingDef（新模型形态：checker 做交叉一致性检查 R-KIND-10）。
 */
function parseComponentMapping(sections: Section[]): ComponentMappingDef | undefined {
  const detection = detectExtensionSection(sections, ['组件映射', 'componentmapping'], '组件映射');
  if (!detection.enabled) return undefined;
  const yaml = detection.yaml;
  if (yaml === null || yaml === undefined) {
    return { interfaceImplementations: [], dimensionStorage: [], componentTransfers: [] };
  }
  const r = asRecord(yaml, '组件映射');

  // 表1：接口 → 实现组件（哪个 service/module 承载哪个 interface）
  const interfaceImplementations = asRecordArray(
    r.interfaceImplementations,
    '组件映射.interfaceImplementations'
  ).map((item, idx) => {
    const path = `组件映射.interfaceImplementations[${idx}]`;
    const mapping: InterfaceImplementationMapping = {
      interface: requireString(item, 'interface', path),
      component: requireString(item, 'component', path),
    };
    const description = optionalString(item, 'description');
    if (description !== undefined) mapping.description = description;
    return mapping;
  });

  // 表2：实体维度 → 存储（维度落到哪张表 / 哪个字段）
  const dimensionStorage = asRecordArray(
    r.dimensionStorage,
    '组件映射.dimensionStorage'
  ).map((item, idx) => {
    const path = `组件映射.dimensionStorage[${idx}]`;
    const mapping: DimensionStorageMapping = {
      dimension: requireString(item, 'dimension', path),
      table: requireString(item, 'table', path),
    };
    const field = optionalString(item, 'field');
    if (field !== undefined) mapping.field = field;
    const description = optionalString(item, 'description');
    if (description !== undefined) mapping.description = description;
    return mapping;
  });

  // 表3：组件 → 组件传输（谁调谁、什么通道、同步/异步）
  const componentTransfers = asRecordArray(
    r.componentTransfers,
    '组件映射.componentTransfers'
  ).map((item, idx) => {
    const path = `组件映射.componentTransfers[${idx}]`;
    const mode = requireString(item, 'mode', path);
    if (mode !== 'sync' && mode !== 'async') {
      throw new ParseError(
        `组件映射.componentTransfers[${idx}].mode 必须是 sync 或 async，实际为 ${mode}`,
        '组件映射'
      );
    }
    const mapping: ComponentTransferMapping = {
      from: requireString(item, 'from', path),
      to: requireString(item, 'to', path),
      channel: requireString(item, 'channel', path),
      mode,
    };
    const description = optionalString(item, 'description');
    if (description !== undefined) mapping.description = description;
    return mapping;
  });

  return { interfaceImplementations, dimensionStorage, componentTransfers };
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

/**
 * W1-b 关系断言段：YAML 数组，每条解析为 RelationAssertion。
 * - 标题关键词：['关系断言', 'relation-assertions']（复用 detectExtensionSectionList）
 * - 断言种类白名单：depends_on / sequence / shares_invariant（NR1-2 映射表）
 * - 不在映射表的种类（如 excludes）→ ParseError 硬错误（无映射即无校验，主动加固，红线 3）
 * - 引用存在性校验（a/b 是否存在于转移/状态）由 checker（TC2）负责，parser 只管语法与种类白名单
 * - 无断言段 → undefined（老 model.md 零回归）
 */
function parseRelationAssertions(sections: Section[]): RelationAssertion[] | undefined {
  const items = detectExtensionSectionList(
    sections,
    ['关系断言', 'relation-assertions'],
    '关系断言',
    (yaml) => {
      const r = asRecord(yaml, '关系断言');
      const id = requireString(r, 'id', '关系断言');
      const kind = validateRelationAssertionKind(
        requireString(r, 'kind', '关系断言'),
        id
      );
      const a = requireString(r, 'a', '关系断言');
      const b = requireString(r, 'b', '关系断言');
      const note = optionalString(r, 'note');
      const assertion: RelationAssertion = {
        id,
        kind,
        a,
        b,
        assert: true,
      };
      if (note !== undefined) assertion.note = note;
      return assertion;
    }
  );
  return items.length > 0 ? items : undefined;
}

/**
 * 断言种类白名单（NR1-2 映射表定案）。
 * 不在映射表内的种类（如 excludes）→ ParseError 硬错误：
 * 无映射即无机械校验对象（W1-a 投影无对应 kind），宽容处理会绕过校验拆护城河。
 */
function validateRelationAssertionKind(raw: string, assertionId: string): RelationAssertionKind {
  const ALLOWED: RelationAssertionKind[] = ['depends_on', 'sequence', 'shares_invariant'];
  const norm = raw.trim().toLowerCase();
  if ((ALLOWED as string[]).includes(norm)) {
    return norm as RelationAssertionKind;
  }
  throw new ParseError(
    `关系断言 "${assertionId}" 的种类 "${raw}" 不在映射表（仅支持 depends_on / sequence / shares_invariant）；` +
      `无映射即无机械校验对象（excludes 等种类首版裁出，R1-1 定案），拒绝解析`,
    '关系断言'
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
    const dim: StateDimension = {
      name: requireString(r, 'name', `${fieldPath}[${idx}]`),
      type: requireString(r, 'type', `${fieldPath}[${idx}]`),
      initial,
      validWhen: optionalString(r, 'validWhen'),
    };
    // X1（P0-1）：可选 kind 断言段——人写断言 → kindSource='asserted'；
    // 缺省 → 不填（老模型零回归），kind 由 buildDimensionKinds 机械推导或走降级。
    const kindRaw = optionalString(r, 'kind');
    if (kindRaw !== undefined) {
      if (kindRaw === 'declared' || kindRaw === 'observed') {
        dim.kind = kindRaw;
        dim.kindSource = 'asserted';
      } else {
        throw new ParseError(
          `${fieldPath}[${idx}].kind 必须是 declared / observed，实际为 ${kindRaw}（X1：人写 kind 断言仅支持两值）`
        );
      }
    }
    return dim;
  });
}

function parseContractInput(sections: Section[]): ContractLayerInput | undefined {
  const contractSection = sections.find((s) =>
    s.heading.includes('契约层') || s.heading.includes('契约')
  );
  if (!contractSection) return undefined;

  // 支持 YAML 代码块形式的契约层输入
  const code = findFirstCodeBlock(contractSection.children, 'yaml');
  let parsedYaml: Record<string, unknown> | undefined;
  const candidates: { value: string }[] = [];
  if (code && code.value) candidates.push({ value: code.value });
  // 尝试任意代码块（兼容非 yaml 标注）
  const anyCode = findFirstCodeBlock(contractSection.children);
  if (anyCode && anyCode.value && (!code || anyCode.value !== code.value)) {
    candidates.push({ value: anyCode.value });
  }
  for (const c of candidates) {
    try {
      const obj = parseYaml(c.value) as Record<string, unknown>;
      if (obj && typeof obj === 'object') {
        parsedYaml = obj;
        break;
      }
    } catch {
      // 忽略解析失败，尝试下一个
    }
  }
  if (parsedYaml) {
    const result: ContractLayerInput = {
      parties: Array.isArray(parsedYaml.parties)
        ? (parsedYaml.parties as string[])
        : [],
      expectedInformationFields: Array.isArray(parsedYaml.expectedInformationFields)
        ? (parsedYaml.expectedInformationFields as string[])
        : undefined,
    };
    // E2.1：消费 contracts 段（结构化字段）
    const contractsRaw = parsedYaml.contracts;
    if (Array.isArray(contractsRaw)) {
      result.contracts = contractsRaw.map((c, idx) =>
        parseContractEntry(c, `contracts[${idx}]`)
      );
    }
    return result;
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

/**
 * E2.1：解析契约层单条接口契约（contracts[] 一项）
 * - interface / sourceId 必填其一（interface 为必填，sourceId 选填）
 * - requestSchema / responseSchema 形态须符合 JSON Schema 子集
 * - preconditions / postconditions / sideEffects 为 SchemaExpression[]；字符串数组自动归一
 * 非法 schema 抛 ParseError（拒绝静默）
 *
 * C-4（10 §4）：可选键 interfaceType（分型声明）——与 E2.1 其余可选键同构解析，
 * 老协议无此键 → undefined（无声明）；非三值抛 ParseError（拒绝静默）。
 */
function parseContractEntry(raw: unknown, path: string): ContractEntry {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ParseError(`${path} 必须是对象`);
  }
  const r = raw as Record<string, unknown>;
  const iface = r.interface;
  if (typeof iface !== 'string' || iface.trim() === '') {
    throw new ParseError(`${path}.interface 必填且非空字符串`);
  }
  const entry: ContractEntry = {
    interface: iface.trim(),
    sourceId:
      typeof r.sourceId === 'string' && r.sourceId.trim() !== ''
        ? r.sourceId.trim()
        : undefined,
    description:
      typeof r.description === 'string' ? r.description : undefined,
  };
  if (r.requestSchema !== undefined && r.requestSchema !== null) {
    entry.requestSchema = parseJsonSchemaValue(r.requestSchema, `${path}.requestSchema`);
  }
  if (r.responseSchema !== undefined && r.responseSchema !== null) {
    entry.responseSchema = parseJsonSchemaValue(r.responseSchema, `${path}.responseSchema`);
  }
  if (r.preconditions !== undefined && r.preconditions !== null) {
    entry.preconditions = parseExpressionArray(r.preconditions, `${path}.preconditions`);
  }
  if (r.postconditions !== undefined && r.postconditions !== null) {
    entry.postconditions = parseExpressionArray(
      r.postconditions,
      `${path}.postconditions`
    );
  }
  if (r.sideEffects !== undefined && r.sideEffects !== null) {
    entry.sideEffects = parseExpressionArray(r.sideEffects, `${path}.sideEffects`);
  }
  // E11：契约层 contracts[].errorResponses 解析（复用 parseJsonSchemaValue 校验 bodySchema）
  if (r.errorResponses !== undefined && r.errorResponses !== null) {
    entry.errorResponses = parseErrorResponses(
      r.errorResponses,
      `${path}.errorResponses`
    );
  }
  // C-4（10 §4）：分型声明（可选键；缺省 → 无声明，兼容老协议）
  if (r.interfaceType !== undefined && r.interfaceType !== null) {
    entry.interfaceType = parseInterfaceTypeValue(
      r.interfaceType,
      `${path}.interfaceType`
    );
  }
  return entry;
}

/**
 * C-4（10 §4）：契约段分型声明取值校验（三值枚举，10 §3-2）。
 * 非三值 → ParseError（与 parseJsonSchemaValue 同口径：拒绝静默）。
 */
function parseInterfaceTypeValue(raw: unknown, path: string): InterfaceType {
  if (raw === 'state_machine' || raw === 'contract_carrier' || raw === 'observation') {
    return raw;
  }
  throw new ParseError(
    `${path} 非法：${String(raw)}（仅允许 state_machine / contract_carrier / observation）`
  );
}

/**
 * E11：解析契约层 errorResponses[] 数组。
 * - 每个条目必填 id / errorCode / httpStatus
 * - bodySchema 复用 parseJsonSchemaValue（与 requestSchema/responseSchema 同语义）
 * - 非法形态抛 ParseError
 */
function parseErrorResponses(raw: unknown, path: string): ErrorResponseDef[] {
  if (!Array.isArray(raw)) {
    throw new ParseError(`${path} 必须是数组`);
  }
  return raw.map((item, idx) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ParseError(`${path}[${idx}] 必须是对象`);
    }
    const r = item as Record<string, unknown>;
    if (typeof r.id !== 'string' || r.id.trim() === '') {
      throw new ParseError(`${path}[${idx}].id 必填且非空字符串`);
    }
    if (typeof r.errorCode !== 'string' || r.errorCode.trim() === '') {
      throw new ParseError(`${path}[${idx}].errorCode 必填且非空字符串`);
    }
    if (typeof r.httpStatus !== 'number' || !Number.isInteger(r.httpStatus)) {
      throw new ParseError(`${path}[${idx}].httpStatus 必填且为整数`);
    }
    const def: ErrorResponseDef = {
      id: r.id.trim(),
      errorCode: r.errorCode.trim(),
      httpStatus: r.httpStatus,
    };
    if (r.bodySchema !== undefined && r.bodySchema !== null) {
      def.bodySchema = parseJsonSchemaValue(r.bodySchema, `${path}[${idx}].bodySchema`);
    }
    if (typeof r.description === 'string') {
      def.description = r.description;
    }
    return def;
  });
}

/**
 * E2.1：把契约段里嵌的 JSON Schema 解析/校验成 JSONSchema 子集
 * - 缺 type 时按 properties/required 推断为 object；其他按声明保留
 * - 非法形态抛 ParseError
 */
function parseJsonSchemaValue(raw: unknown, path: string): JSONSchema {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ParseError(`${path} 必须是对象`);
  }
  const r = raw as Record<string, unknown>;
  const schema: JSONSchema = {};
  // 接受 type / properties / required / items / enum / description / format / default / minItems / maxItems / additionalProperties
  if (r.type !== undefined) {
    const t = r.type;
    if (
      t !== 'string' &&
      t !== 'number' &&
      t !== 'integer' &&
      t !== 'boolean' &&
      t !== 'object' &&
      t !== 'array' &&
      t !== 'null'
    ) {
      throw new ParseError(`${path}.type 非法：${String(t)}`);
    }
    schema.type = t;
  }
  if (r.properties !== undefined) {
    if (!r.properties || typeof r.properties !== 'object' || Array.isArray(r.properties)) {
      throw new ParseError(`${path}.properties 必须是对象`);
    }
    const props: Record<string, JSONSchema> = {};
    for (const [k, v] of Object.entries(r.properties as Record<string, unknown>)) {
      props[k] = parseJsonSchemaValue(v, `${path}.properties.${k}`);
    }
    schema.properties = props;
  }
  if (r.required !== undefined) {
    if (!Array.isArray(r.required)) {
      throw new ParseError(`${path}.required 必须是字符串数组`);
    }
    schema.required = r.required.map((x, i) => {
      if (typeof x !== 'string') {
        throw new ParseError(`${path}.required[${i}] 必须是字符串`);
      }
      return x;
    });
  }
  if (r.items !== undefined) {
    schema.items = parseJsonSchemaValue(r.items, `${path}.items`);
  }
  if (r.enum !== undefined) {
    if (!Array.isArray(r.enum)) {
      throw new ParseError(`${path}.enum 必须是数组`);
    }
    schema.enum = r.enum as unknown[];
  }
  if (typeof r.description === 'string') schema.description = r.description;
  if (typeof r.format === 'string') schema.format = r.format;
  if (r.default !== undefined) schema.default = r.default;
  if (typeof r.minItems === 'number') schema.minItems = r.minItems;
  if (typeof r.maxItems === 'number') schema.maxItems = r.maxItems;
  if (r.additionalProperties !== undefined) {
    if (typeof r.additionalProperties === 'boolean') {
      schema.additionalProperties = r.additionalProperties;
    } else if (r.additionalProperties && typeof r.additionalProperties === 'object') {
      schema.additionalProperties = parseJsonSchemaValue(
        r.additionalProperties,
        `${path}.additionalProperties`
      );
    } else {
      throw new ParseError(`${path}.additionalProperties 必须是 boolean 或 JSONSchema 对象`);
    }
  }
  // 隐式 object 推断：properties 或 required 任一存在 → 强制 type=object
  if (
    schema.type === undefined &&
    (schema.properties !== undefined || schema.required !== undefined)
  ) {
    schema.type = 'object';
  }
  return schema;
}

/**
 * E2.1：解析表达式数组：
 *   - 已是 SchemaExpression[] 形态（含 kind 字段）→ 校验后保留
 *   - 字符串数组 → 自动包装为 { kind:'description-only', description:string }
 * 其他形态抛 ParseError
 */
function parseExpressionArray(raw: unknown, path: string): SchemaExpression[] {
  if (!Array.isArray(raw)) {
    throw new ParseError(`${path} 必须是数组`);
  }
  return raw.map((item, idx) => {
    if (typeof item === 'string') {
      return { kind: 'description-only', description: item };
    }
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const expr = item as Record<string, unknown>;
      const k = expr.kind;
      if (k === 'json-schema') {
        return {
          kind: 'json-schema',
          description:
            typeof expr.description === 'string' ? expr.description : undefined,
          schema:
            expr.schema !== undefined
              ? parseJsonSchemaValue(expr.schema, `${path}[${idx}].schema`)
              : undefined,
        };
      }
      if (k === 'legacy-stub' || k === 'description-only') {
        return {
          kind: k,
          description:
            typeof expr.description === 'string' ? expr.description : undefined,
          schema:
            expr.schema !== undefined
              ? parseJsonSchemaValue(expr.schema, `${path}[${idx}].schema`)
              : undefined,
        };
      }
      throw new ParseError(
        `${path}[${idx}].kind 必须是 json-schema / legacy-stub / description-only，实际为 ${String(k)}`
      );
    }
    throw new ParseError(`${path}[${idx}] 必须是字符串或 SchemaExpression 对象`);
  });
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
