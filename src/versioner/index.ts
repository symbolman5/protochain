/**
 * 版本管理器 —— 迭代支撑（变更分类 + ConfirmationTracker）
 *
 * 设计依据：《协议驱动自验证工具链设计方案》versioner 模块、第五节使用方确认跟踪
 *
 * 职责：
 * 1. 变更分类：结合自动规则、AI 辅助判断、使用方声明覆盖
 *    - 自动规则（按优先级从高到低）：
 *      ① 元数据声明"变更类型=范式重协商" → paradigm_renegotiation（使用方声明覆盖）
 *      ② 不变量表达式已变更（代码文本diff检测）→ 标记待分类，进入 AI 辅助判断
 *      ③ 角色分工变更（新增/删除角色关联的转移）→ paradigm_renegotiation
 *      ④ 状态空间结构性变更（删除终态、新增需新角色参与的状态）→ paradigm_renegotiation
 *      ⑤ 其余 → protocol_tweak
 *    - AI 辅助判断（仅对规则②标记的"不变量表达式已变更"项）：
 *      判断是"语义变更"还是"仅表达形式变更"
 *    - 使用方的元数据声明优先级最高
 *
 * 2. ConfirmationTracker：跟踪四类确认状态
 *    - invariant_declaration：不变量声明确认
 *    - paradigm_renegotiation：范式重协商确认
 *    - self_constructed_scenario：自构造场景确认
 *    - utility_validation：效用验证（仅跟踪状态，系统不执行效用验证）
 *
 * 3. 版本快照：保存协议模型版本到 protocol/versions/
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyYaml, parse as parseYaml } from 'yaml';
import type {
  SourceProtocolModel,
  ModelDiff,
  ChangeClassification,
  ChangeType,
  AIAdapter,
  ConfirmationTracker as IConfirmationTracker,
  Confirmation,
  ConfirmableItem,
  VersionSnapshot,
  DerivableChange,
  CompositionModel,
} from '../model/types.js';
import type { DiffResult } from '../differ/index.js';
import { parseAIJson } from '../ai/adapter.js';

// ============================================================================
// 变更分类
// ============================================================================

export interface ClassifyOptions {
  /** 是否启用 AI 辅助不变量语义判断 */
  useAIForInvariantClassification?: boolean;
}

export interface ClassifyResult {
  classification: ChangeClassification;
  /** 需人工确认的项（AI 判断为语义变更的不变量） */
  pendingConfirmations: ConfirmableItem[];
  /** 需多协议共识方确认的项（跨协议不变量变更且 span > 1） */
  crossProtocolConfirmations?: ConfirmableItem[];
}

/**
 * 对 diff 做变更分类
 *
 * @param diff 差分引擎产出的 ModelDiff
 * @param oldModel 旧版本模型（用于角色关联分析）
 * @param newModel 新版本模型（用于角色关联分析）
 * @param aiAdapter AI 适配器（可选，用于不变量语义判断）
 */
export async function classifyChange(
  diff: ModelDiff,
  oldModel: SourceProtocolModel,
  newModel: SourceProtocolModel,
  aiAdapter?: AIAdapter,
  options: ClassifyOptions = {}
): Promise<ClassifyResult> {
  const { useAIForInvariantClassification = true } = options;

  // 步骤1：使用方声明覆盖（最高优先级）
  const declarations = newModel.metadata.changeDeclarations ?? [];
  const declaredRenegotiation = declarations.some(
    (d) => d.changeType === 'paradigm_renegotiation'
  );
  if (declaredRenegotiation) {
    return {
      classification: {
        changeType: 'paradigm_renegotiation',
        reason: '使用方元数据声明为范式重协商（声明覆盖）',
        triggeredBy: ['metadata_declaration'],
        affectedElements: declarations.map((d) => d.targetId),
      },
      pendingConfirmations: [{
        type: 'paradigm_renegotiation',
        versionRange: [oldModel.metadata.version, newModel.metadata.version],
      }],
    };
  }

  // 步骤2：自动规则检测
  const reasons: string[] = [];
  const triggeredBy: string[] = [];
  const affectedElements: string[] = [];

  // 规则③：角色分工变更
  const roleChange = detectRoleChange(oldModel, newModel);
  if (roleChange.detected) {
    reasons.push('角色分工变更：' + roleChange.detail);
    triggeredBy.push('role_change');
    affectedElements.push(...roleChange.affectedTransitions);
  }

  // 规则④：状态空间结构性变更
  const structuralChange = detectStructuralChange(diff, oldModel, newModel);
  if (structuralChange.detected) {
    reasons.push('状态空间结构性变更：' + structuralChange.detail);
    triggeredBy.push('structural_change');
    affectedElements.push(...structuralChange.affectedStates);
  }

  // 规则②：不变量表达式变更（需 AI 辅助判断）
  const invariantChanges = diff.derivableChanges.filter(
    (c) => c.elementType === 'invariant' && c.kind === 'modified'
  );
  const invariantExpressionChanges = invariantChanges.filter((c) =>
    c.fieldChanges?.some((f) => f.path === 'expression')
  );

  const pendingConfirmations: ConfirmableItem[] = [];
  let invariantSemanticChanged = false;

  if (invariantExpressionChanges.length > 0) {
    if (useAIForInvariantClassification && aiAdapter) {
      // AI 辅助判断每个不变量表达式变更
      for (const change of invariantExpressionChanges) {
        const oldExpr = change.fieldChanges?.find((f) => f.path === 'expression')?.oldValue ?? '';
        const newExpr = change.fieldChanges?.find((f) => f.path === 'expression')?.newValue ?? '';
        const isSemantic = await judgeInvariantSemanticChange(oldExpr, newExpr, aiAdapter);
        if (isSemantic) {
          invariantSemanticChanged = true;
          reasons.push(`不变量 ${change.elementId} 表达式语义变更`);
          triggeredBy.push('invariant_semantic_change');
          affectedElements.push(change.elementId);
          pendingConfirmations.push({
            type: 'invariant_declaration',
            invariantId: change.elementId,
          });
        }
      }
    } else {
      // 无 AI：保守处理，标记为待分类
      invariantSemanticChanged = true;
      reasons.push(`不变量表达式变更（${invariantExpressionChanges.length} 项，待 AI 判断）`);
      triggeredBy.push('invariant_expression_change_pending');
      for (const change of invariantExpressionChanges) {
        affectedElements.push(change.elementId);
        pendingConfirmations.push({
          type: 'invariant_declaration',
          invariantId: change.elementId,
        });
      }
    }
  }

  // 综合判定
  const isParadigmRenegotiation =
    roleChange.detected || structuralChange.detected || invariantSemanticChanged;

  const changeType: ChangeType = isParadigmRenegotiation
    ? 'paradigm_renegotiation'
    : 'protocol_tweak';

  const classification: ChangeClassification = {
    changeType,
    reason: reasons.length > 0 ? reasons.join('; ') : '无重大变更，归类为协议微调',
    triggeredBy: triggeredBy.length > 0
      ? (triggeredBy as Array<'role_change' | 'structural_change' | 'invariant_semantic_change' | 'invariant_expression_change_pending' | 'metadata_declaration'>)
      : ['default'],
    affectedElements,
  };

  // 范式重协商需跟踪确认
  if (changeType === 'paradigm_renegotiation') {
    pendingConfirmations.push({
      type: 'paradigm_renegotiation',
      versionRange: [oldModel.metadata.version, newModel.metadata.version],
    });
  }

  return { classification, pendingConfirmations };
}

/**
 * 对跨协议不变量变更进行分类，识别需多协议共识方确认的项
 *
 * 遍历 compositionDiff.crossInvariantChanges，对每个变更的跨协议不变量，
 * 在新 composition 中查找该不变量，如果 span.length > 1（涉及多个子协议），
 * 则创建一个 ConfirmableItem（类型为 cross_invariant_renegotiation）。
 *
 * 这是一个简化版，后续可使用 ConsensusFinder 做更精确的共识方匹配。
 *
 * @param diff 组合层 diff（来自 diffCompositionModels 的产出）
 * @param oldComposition 旧组合层模型（用于版本信息）
 * @param newComposition 新组合层模型（用于查找不变量 span）
 */
export function classifyCrossProtocolChanges(
  diff: DiffResult['compositionDiff'],
  oldComposition: CompositionModel | undefined,
  newComposition: CompositionModel
): ClassifyResult['crossProtocolConfirmations'] {
  if (diff === undefined || diff.crossInvariantChanges.length === 0) {
    return undefined;
  }

  const confirmations: ConfirmableItem[] = [];

  for (const change of diff.crossInvariantChanges) {
    const invDef = newComposition.crossInvariants.find((inv) => inv.id === change.id);
    if (invDef && invDef.span.length > 1) {
      confirmations.push({
        type: 'cross_invariant_renegotiation',
        versionRange: [
          oldComposition?.metadata.version ?? 'unknown',
          newComposition.metadata.version,
        ],
        span: invDef.span,
      });
    }
  }

  return confirmations.length > 0 ? confirmations : undefined;
}

// ============================================================================
// 自动规则检测
// ============================================================================

/**
 * 规则③：角色分工变更
 * 检测新增/删除角色关联的转移
 */
function detectRoleChange(
  oldModel: SourceProtocolModel,
  newModel: SourceProtocolModel
): { detected: boolean; detail: string; affectedTransitions: string[] } {
  const oldTransitions = new Map(oldModel.derivable.transitions.map((t) => [t.id, t]));
  const newTransitions = new Map(newModel.derivable.transitions.map((t) => [t.id, t]));

  const affected: string[] = [];
  const details: string[] = [];

  // 角色集合变更
  const oldRoleIds = new Set(oldModel.metadata.roles.map((r) => r.id));
  const newRoleIds = new Set(newModel.metadata.roles.map((r) => r.id));
  for (const rid of newRoleIds) {
    if (!oldRoleIds.has(rid)) {
      details.push(`新增角色 ${rid}`);
    }
  }
  for (const rid of oldRoleIds) {
    if (!newRoleIds.has(rid)) {
      details.push(`删除角色 ${rid}`);
    }
  }

  // 转移的 trigger 角色变更
  for (const [tid, oldT] of oldTransitions) {
    const newT = newTransitions.get(tid);
    if (newT && oldT.triggerRoleId !== newT.triggerRoleId) {
      affected.push(tid);
      details.push(`转移 ${tid} 的触发角色从 ${oldT.triggerRoleId ?? '无'} 变为 ${newT.triggerRoleId ?? '无'}`);
    }
  }

  return {
    detected: details.length > 0,
    detail: details.join('; '),
    affectedTransitions: affected,
  };
}

/**
 * 规则④：状态空间结构性变更
 * 检测删除终态、新增需新角色参与的状态
 */
function detectStructuralChange(
  diff: ModelDiff,
  oldModel: SourceProtocolModel,
  newModel: SourceProtocolModel
): { detected: boolean; detail: string; affectedStates: string[] } {
  const affected: string[] = [];
  const details: string[] = [];

  // 删除终态
  const oldTerminalIds = new Set(oldModel.derivable.terminalStateIds);
  const newTerminalIds = new Set(newModel.derivable.terminalStateIds);
  for (const tid of oldTerminalIds) {
    if (!newTerminalIds.has(tid)) {
      affected.push(tid);
      details.push(`删除终态 ${tid}`);
    }
  }

  // 新增需新角色参与的状态
  const oldRoleIds = new Set(oldModel.metadata.roles.map((r) => r.id));
  const stateChanges = diff.derivableChanges.filter(
    (c) => c.elementType === 'state' && c.kind === 'added'
  );
  for (const change of stateChanges) {
    const newState = newModel.derivable.states.find((s) => s.id === change.elementId);
    if (newState?.roleIds?.some((rid) => !oldRoleIds.has(rid))) {
      affected.push(change.elementId);
      details.push(`新增状态 ${change.elementId} 需新角色参与`);
    }
  }

  // 初始状态变更
  if (oldModel.derivable.initialStateId !== newModel.derivable.initialStateId) {
    affected.push(newModel.derivable.initialStateId ?? '__initial__');
    details.push(`初始状态从 ${oldModel.derivable.initialStateId ?? '无'} 变为 ${newModel.derivable.initialStateId ?? '无'}`);
  }

  return {
    detected: details.length > 0,
    detail: details.join('; '),
    affectedStates: affected,
  };
}

/**
 * AI 判断不变量表达式变更是否为语义变更
 */
async function judgeInvariantSemanticChange(
  oldExpr: string,
  newExpr: string,
  aiAdapter: AIAdapter
): Promise<boolean> {
  const prompt = {
    system:
      '你是形式化方法专家。判断两个不变量表达式是否语义等价。' +
      '语义等价意味着在任何模型下都同时成立或同时不成立。' +
      '输出严格 JSON。',
    context: JSON.stringify({ oldExpression: oldExpr, newExpression: newExpr }, null, 2),
    instruction: [
      '请判断两个表达式是否语义等价：',
      '- 语义等价（仅表达形式不同）→ equivalent: true（视为微调）',
      '- 语义不等价（约束条件变化）→ equivalent: false（视为重协商）',
      '- 无法判断 → equivalent: false（保守处理为重协商）',
    ].join('\n'),
    outputFormat: '返回 JSON：{ "equivalent": true|false, "reason": "..." }',
    temperature: 0.1,
  };

  const response = await aiAdapter.complete(prompt);
  if (!response.success) return true; // 失败时保守处理为语义变更

  try {
    const parsed = parseAIJson<{ equivalent: boolean; reason: string }>(response.content);
    return !parsed.equivalent; // 不等价 → 语义变更
  } catch {
    return true; // 解析失败保守处理
  }
}

// ============================================================================
// ConfirmationTracker
// ============================================================================

class ConfirmationTrackerImpl implements IConfirmationTracker {
  private confirmations: Confirmation[] = [];

  constructor(initial?: Confirmation[]) {
    if (initial) {
      this.confirmations = [...initial];
    }
  }

  get pendingConfirmations(): Confirmation[] {
    return this.getPending();
  }

  addPending(item: ConfirmableItem): void {
    // 去重：相同 itemId 不重复添加
    const itemId = this.makeItemId(item);
    if (this.confirmations.some((c) => c.itemId === itemId && c.status === 'pending')) {
      return;
    }
    this.confirmations.push({
      itemId,
      item,
      status: 'pending',
      createdAt: new Date().toISOString(),
    });
  }

  confirm(itemId: string, confirmedBy: string, note?: string): void {
    const c = this.confirmations.find((c) => c.itemId === itemId);
    if (c) {
      c.status = 'confirmed';
      c.confirmedBy = confirmedBy;
      c.note = note;
      c.confirmedAt = new Date().toISOString();
    }
  }

  reject(itemId: string, reason: string, rejectedBy?: string): void {
    const c = this.confirmations.find((c) => c.itemId === itemId);
    if (c) {
      c.status = 'rejected';
      c.rejectReason = reason;
      c.confirmedBy = rejectedBy;
      c.confirmedAt = new Date().toISOString();
    }
  }

  getPending(): Confirmation[] {
    return this.confirmations.filter((c) => c.status === 'pending');
  }

  getAll(): Confirmation[] {
    return [...this.confirmations];
  }

  private makeItemId(item: ConfirmableItem): string {
    switch (item.type) {
      case 'invariant_declaration':
        return `inv:${item.invariantId}`;
      case 'paradigm_renegotiation':
        return `paradigm:${item.versionRange[0]}->${item.versionRange[1]}`;
      case 'self_constructed_scenario':
        return `scenario:${item.scenarioId}`;
      case 'utility_validation':
        return `utility:${item.version}`;
      case 'cross_invariant_declaration':
        return `cross-inv:${item.invariantId}:${item.span.join(',')}`;
      case 'cross_invariant_renegotiation':
        return `cross-paradigm:${item.versionRange[0]}->${item.versionRange[1]}:${item.span.join(',')}`;
      case 'negative_assurance_declaration':
        return `neg-assurance:${item.assuranceId}`;
      case 'security_assumption_change':
        return `sec-assumption:${item.assumptionId}`;
    }
  }

  toJSON(): Confirmation[] {
    return [...this.confirmations];
  }
}

export function createConfirmationTracker(initial?: Confirmation[]): IConfirmationTracker {
  return new ConfirmationTrackerImpl(initial);
}

// ============================================================================
// 版本快照
// ============================================================================

export interface SaveVersionOptions {
  /** 版本目录（默认 protocol/versions/） */
  versionsDir?: string;
  /** 是否覆盖已存在的版本 */
  force?: boolean;
}

/**
 * 保存协议模型版本快照
 */
export function saveVersionSnapshot(
  model: SourceProtocolModel,
  rootDir: string,
  options: SaveVersionOptions = {}
): string {
  const { versionsDir = 'protocol/versions', force = false } = options;
  const version = model.metadata.version;
  const fullPath = join(rootDir, versionsDir);
  if (!existsSync(fullPath)) {
    mkdirSync(fullPath, { recursive: true });
  }

  const snapshotPath = join(fullPath, `v${version}.md`);
  if (existsSync(snapshotPath) && !force) {
    throw new Error(`版本快照已存在：${snapshotPath}（使用 force=true 覆盖）`);
  }

  // 保存原始 model.md 内容（如果有 sourcePath）
  if (model.sourcePath && existsSync(model.sourcePath)) {
    const content = readFileSync(model.sourcePath, 'utf-8');
    writeFileSync(snapshotPath, content, 'utf-8');
  } else {
    // 无 sourcePath：保存序列化后的模型
    writeFileSync(snapshotPath, stringifyYaml(model), 'utf-8');
  }

  // 保存元数据索引
  const indexPath = join(fullPath, 'index.json');
  const index = loadVersionIndex(fullPath);
  const snapshot: VersionSnapshot = {
    version,
    name: model.metadata.name,
    snapshotPath: `v${version}.md`,
    savedAt: new Date().toISOString(),
  };
  // 去重：相同版本只保留最新
  const existingIdx = index.findIndex((s) => s.version === version);
  if (existingIdx >= 0) {
    index[existingIdx] = snapshot;
  } else {
    index.push(snapshot);
  }
  writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8');

  return snapshotPath;
}

function loadVersionIndex(versionsDir: string): VersionSnapshot[] {
  const indexPath = join(versionsDir, 'index.json');
  if (!existsSync(indexPath)) return [];
  try {
    return JSON.parse(readFileSync(indexPath, 'utf-8')) as VersionSnapshot[];
  } catch {
    return [];
  }
}

/**
 * 列出所有版本快照
 */
export function listVersions(rootDir: string, versionsDir = 'protocol/versions'): VersionSnapshot[] {
  const fullPath = join(rootDir, versionsDir);
  return loadVersionIndex(fullPath);
}

/**
 * 读取指定版本的协议模型
 */
export function loadVersion(
  rootDir: string,
  version: string,
  versionsDir = 'protocol/versions'
): SourceProtocolModel | undefined {
  const fullPath = join(rootDir, versionsDir);
  const snapshotPath = join(fullPath, `v${version}.md`);
  if (!existsSync(snapshotPath)) return undefined;

  // 复用 parser 解析
  // 延迟导入避免循环依赖
  const { parseProtocolFile } = require('../parser/index.js') as typeof import('../parser/index.js');
  return parseProtocolFile(snapshotPath);
}

// ============================================================================
// 变更传播
// ============================================================================

export interface PropagateResult {
  /** 受影响步骤（按 DAG 顺序） */
  affectedSteps: import('../model/types.js').StepId[];
  /** 受影响产物路径 */
  affectedArtifacts: string[];
  /** 建议的增量重推导路径 */
  incrementalPlan: import('../model/types.js').StepId[];
  /** 需清理的旧产物（需重新生成） */
  staleArtifacts: string[];
  propagatedAt: string;
}

/**
 * 根据影响分析结果生成变更传播计划
 *
 * @param impact 影响分析结果（来自 differ.analyzeImpact）
 * @param rootDir 项目根目录
 */
export function propagate(
  impact: import('../model/types.js').ImpactAnalysis,
  rootDir: string
): PropagateResult {
  const staleArtifacts: string[] = [];

  // 检查受影响产物是否存在，存在则标记为 stale
  for (const artifact of impact.affectedArtifacts) {
    const fullPath = join(rootDir, artifact);
    if (existsSync(fullPath)) {
      staleArtifacts.push(artifact);
    }
  }

  return {
    affectedSteps: impact.affectedSteps,
    affectedArtifacts: impact.affectedArtifacts,
    incrementalPlan: impact.incrementalPlan,
    staleArtifacts,
    propagatedAt: new Date().toISOString(),
  };
}

// ============================================================================
// 报告摘要
// ============================================================================

export function formatClassificationSummary(result: ClassifyResult): string {
  const c = result.classification;
  const lines: string[] = [
    `变更分类：${c.changeType === 'paradigm_renegotiation' ? '范式重协商' : '协议微调'}`,
    `  触发原因: ${c.reason}`,
    `  触发规则: ${c.triggeredBy.join(', ')}`,
    `  受影响元素: ${c.affectedElements.length} 项`,
  ];

  if (result.pendingConfirmations.length > 0) {
    lines.push(`  待确认项: ${result.pendingConfirmations.length} 项`);
    for (const p of result.pendingConfirmations.slice(0, 5)) {
      switch (p.type) {
        case 'invariant_declaration':
          lines.push(`    - [不变量声明] ${p.invariantId}`);
          break;
        case 'paradigm_renegotiation':
          lines.push(`    - [范式重协商] ${p.versionRange[0]} → ${p.versionRange[1]}`);
          break;
        case 'self_constructed_scenario':
          lines.push(`    - [自构造场景] ${p.scenarioId}`);
          break;
        case 'utility_validation':
          lines.push(`    - [效用验证] 版本 ${p.version}`);
          break;
      }
    }
    if (result.pendingConfirmations.length > 5) {
      lines.push(`    ... 还有 ${result.pendingConfirmations.length - 5} 项`);
    }
  }

  return lines.join('\n');
}

export function formatPropagateSummary(result: PropagateResult): string {
  const lines: string[] = [
    '变更传播分析：',
    `  受影响步骤: ${result.affectedSteps.join(', ') || '无'}`,
    `  受影响产物: ${result.affectedArtifacts.length} 项`,
    `  需清理的旧产物: ${result.staleArtifacts.length} 项`,
  ];
  if (result.staleArtifacts.length > 0) {
    lines.push('  需清理产物列表：');
    for (const s of result.staleArtifacts.slice(0, 10)) {
      lines.push(`    - ${s}`);
    }
    if (result.staleArtifacts.length > 10) {
      lines.push(`    ... 还有 ${result.staleArtifacts.length - 10} 项`);
    }
  }
  lines.push(`  建议增量重推导路径: ${result.incrementalPlan.join(' → ') || '无'}`);
  return lines.join('\n');
}
