/**
 * 差分引擎 —— 迭代支撑（结构化 diff + 不变量 AI 辅助）
 *
 * 设计依据：《协议驱动自验证工具链设计方案》differ 模块、第五节迭代支持
 *
 * 职责：
 * 1. 对两个版本的 SourceProtocolModel 做比较，产出 ModelDiff
 * 2. 结构化部分（状态/转移/时序约束/元数据）：代码做语义级比较（结构同构+字段对比）
 * 3. 不变量表达式：代码做文本 diff 标记"表达式已变更"，
 *    表达式的语义等价判断由 AI 辅助（如 not exists p: p>1 与 forall p: p<=1 是否等价）
 * 4. 影响分析：根据 diff 推导受影响的下游步骤与派生产物，建议增量重推导路径
 *
 * 差分同时比较元数据层，感知使用方的声明性意图（如主动声明某不变量需重协商）
 */

import type {
  SourceProtocolModel,
  DerivableLayer,
  ModelDiff,
  FieldChange,
  DerivableChange,
  ImpactAnalysis,
  StepId,
  AIAdapter,
  InvariantDef,
  StateDef,
  TransitionDef,
  TimingDef,
  ExceptionPathDef,
  CompositionModel,
  CrossInvariantDef,
} from '../model/types.js';
import { parseAIJson } from '../ai/adapter.js';

export interface DiffOptions {
  /** 是否启用 AI 辅助不变量语义等价判断 */
  useAIForInvariantEquivalence?: boolean;
}

export interface DiffResult {
  diff: ModelDiff;
  impact: ImpactAnalysis;
  /** 组合层 diff（多协议系统） */
  compositionDiff?: {
    crossInvariantChanges: Array<{ id: string; field: string; oldValue?: string; newValue?: string }>;
    externalDependencyChanges: Array<{ system: string; changes: string[] }>;
  };
}

/**
 * 计算两个协议模型的差分
 */
export async function diffModels(
  oldModel: SourceProtocolModel,
  newModel: SourceProtocolModel,
  aiAdapter?: AIAdapter,
  options: DiffOptions = {}
): Promise<DiffResult> {
  const { useAIForInvariantEquivalence = true } = options;

  // 1. 元数据层 diff
  const metadataChanges = diffMetadata(oldModel.metadata, newModel.metadata);

  // 2. 可读层 diff（仅记录文本变更，不深度比较）
  const readableChanges = diffReadable(oldModel.readable, newModel.readable);

  // 3. 可推演层 diff
  const derivableChanges = await diffDerivable(
    oldModel.derivable,
    newModel.derivable,
    aiAdapter,
    useAIForInvariantEquivalence
  );

  const diff: ModelDiff = {
    metadataChanges,
    readableChanges,
    derivableChanges,
    diffedAt: new Date().toISOString(),
  };

  // 4. 影响分析
  const impact = analyzeImpact(diff);

  return { diff, impact };
}

/**
 * 计算两个组合层模型（CompositionModel）的差分
 *
 * 比较 crossInvariants 和 externalDependencies 的变化，
 * 检测新增/删除/变更的跨协议不变量及其字段变化，以及外部依赖变化。
 */
export function diffCompositionModels(
  oldComposition: CompositionModel | undefined,
  newComposition: CompositionModel | undefined
): DiffResult['compositionDiff'] {
  if (oldComposition === undefined && newComposition === undefined) {
    return undefined;
  }

  const oldInvariants = oldComposition?.crossInvariants ?? [];
  const newInvariants = newComposition?.crossInvariants ?? [];
  const oldDeps = oldComposition?.externalDependencies ?? [];
  const newDeps = newComposition?.externalDependencies ?? [];

  const crossInvariantChanges: Array<{ id: string; field: string; oldValue?: string; newValue?: string }> = [];
  const externalDependencyChanges: Array<{ system: string; changes: string[] }> = [];

  // 比较 crossInvariants
  const oldInvMap = new Map(oldInvariants.map((i) => [i.id, i]));
  const newInvMap = new Map(newInvariants.map((i) => [i.id, i]));

  for (const [id, oldInv] of oldInvMap) {
    const newInv = newInvMap.get(id);
    if (!newInv) {
      crossInvariantChanges.push({ id, field: 'invariant', oldValue: oldInv.expression });
    } else {
      if (oldInv.expression !== newInv.expression) {
        crossInvariantChanges.push({ id, field: 'expression', oldValue: oldInv.expression, newValue: newInv.expression });
      }
      if (oldInv.span.join(',') !== newInv.span.join(',')) {
        crossInvariantChanges.push({ id, field: 'span', oldValue: oldInv.span.join(','), newValue: newInv.span.join(',') });
      }
      if (oldInv.declaredBy !== newInv.declaredBy) {
        crossInvariantChanges.push({ id, field: 'declaredBy', oldValue: oldInv.declaredBy, newValue: newInv.declaredBy });
      }
      if (oldInv.checkMethod !== newInv.checkMethod) {
        crossInvariantChanges.push({ id, field: 'checkMethod', oldValue: oldInv.checkMethod, newValue: newInv.checkMethod });
      }
      if (oldInv.complexity !== newInv.complexity) {
        crossInvariantChanges.push({ id, field: 'complexity', oldValue: oldInv.complexity, newValue: newInv.complexity });
      }
    }
  }
  for (const [id, newInv] of newInvMap) {
    if (!oldInvMap.has(id)) {
      crossInvariantChanges.push({ id, field: 'invariant', newValue: newInv.expression });
    }
  }

  // 比较 externalDependencies
  const oldDepMap = new Map(oldDeps.map((d) => [d.system, d]));
  const newDepMap = new Map(newDeps.map((d) => [d.system, d]));

  for (const [system, oldDep] of oldDepMap) {
    if (!newDepMap.has(system)) {
      externalDependencyChanges.push({ system, changes: [`外部依赖已删除: ${oldDep.system}`] });
    } else {
      const newDep = newDepMap.get(system)!;
      const changes: string[] = [];
      if (oldDep.direction !== newDep.direction) changes.push(`direction: ${oldDep.direction} → ${newDep.direction}`);
      if (oldDep.protocol !== newDep.protocol) changes.push(`protocol: ${oldDep.protocol} → ${newDep.protocol}`);
      if (oldDep.syncSemantics !== newDep.syncSemantics) changes.push('syncSemantics 已变更');
      if (JSON.stringify(oldDep.syncCharacteristics) !== JSON.stringify(newDep.syncCharacteristics)) changes.push('syncCharacteristics 已变更');
      if (JSON.stringify(oldDep.compensation) !== JSON.stringify(newDep.compensation)) changes.push('compensation 已变更');
      if (oldDep.impactOnFailure !== newDep.impactOnFailure) changes.push('impactOnFailure 已变更');
      if (changes.length > 0) {
        externalDependencyChanges.push({ system, changes });
      }
    }
  }
  for (const [system, newDep] of newDepMap) {
    if (!oldDepMap.has(system)) {
      externalDependencyChanges.push({ system, changes: [`外部依赖已新增: ${newDep.system}`] });
    }
  }

  if (crossInvariantChanges.length === 0 && externalDependencyChanges.length === 0) {
    return undefined;
  }

  return {
    crossInvariantChanges,
    externalDependencyChanges,
  };
}

// ============================================================================
// 元数据层 diff
// ============================================================================

function diffMetadata(
  oldMeta: SourceProtocolModel['metadata'],
  newMeta: SourceProtocolModel['metadata']
): FieldChange[] {
  const changes: FieldChange[] = [];

  if (oldMeta.name !== newMeta.name) {
    changes.push({
      path: 'metadata.name',
      kind: 'modified',
      oldValue: oldMeta.name,
      newValue: newMeta.name,
    });
  }

  if (oldMeta.version !== newMeta.version) {
    changes.push({
      path: 'metadata.version',
      kind: 'modified',
      oldValue: oldMeta.version,
      newValue: newMeta.version,
    });
  }

  if (oldMeta.purpose !== newMeta.purpose) {
    changes.push({
      path: 'metadata.purpose',
      kind: 'modified',
      oldValue: oldMeta.purpose,
      newValue: newMeta.purpose,
    });
  }

  // 角色变更
  const oldRoles = new Map(oldMeta.roles.map((r) => [r.id, r]));
  const newRoles = new Map(newMeta.roles.map((r) => [r.id, r]));
  for (const [id, oldRole] of oldRoles) {
    if (!newRoles.has(id)) {
      changes.push({
        path: `metadata.roles[${id}]`,
        kind: 'removed',
        oldValue: oldRole.name,
      });
    } else if (newRoles.get(id)!.name !== oldRole.name) {
      changes.push({
        path: `metadata.roles[${id}].name`,
        kind: 'modified',
        oldValue: oldRole.name,
        newValue: newRoles.get(id)!.name,
      });
    }
  }
  for (const [id, newRole] of newRoles) {
    if (!oldRoles.has(id)) {
      changes.push({
        path: `metadata.roles[${id}]`,
        kind: 'added',
        newValue: newRole.name,
      });
    }
  }

  // 变更声明变更（使用方声明）
  const oldDecls = oldMeta.changeDeclarations ?? [];
  const newDecls = newMeta.changeDeclarations ?? [];
  if (JSON.stringify(oldDecls) !== JSON.stringify(newDecls)) {
    changes.push({
      path: 'metadata.changeDeclarations',
      kind: 'modified',
      oldValue: JSON.stringify(oldDecls),
      newValue: JSON.stringify(newDecls),
    });
  }

  return changes;
}

// ============================================================================
// 可读层 diff
// ============================================================================

function diffReadable(
  oldReadable: SourceProtocolModel['readable'],
  newReadable: SourceProtocolModel['readable']
): FieldChange[] {
  const changes: FieldChange[] = [];

  if (oldReadable.background !== newReadable.background) {
    changes.push({
      path: 'readable.background',
      kind: 'modified',
      oldValue: oldReadable.background,
      newValue: newReadable.background,
    });
  }

  if (oldReadable.workflow !== newReadable.workflow) {
    changes.push({
      path: 'readable.workflow',
      kind: 'modified',
      oldValue: oldReadable.workflow,
      newValue: newReadable.workflow,
    });
  }

  if (oldReadable.exceptionHandling !== newReadable.exceptionHandling) {
    changes.push({
      path: 'readable.exceptionHandling',
      kind: 'modified',
      oldValue: oldReadable.exceptionHandling,
      newValue: newReadable.exceptionHandling,
    });
  }

  // 概念变更（按 term 匹配）
  const oldConcepts = new Map(oldReadable.concepts.map((c) => [c.term, c.definition]));
  const newConcepts = new Map(newReadable.concepts.map((c) => [c.term, c.definition]));
  for (const [term, oldDef] of oldConcepts) {
    if (!newConcepts.has(term)) {
      changes.push({ path: `readable.concepts[${term}]`, kind: 'removed', oldValue: oldDef });
    } else if (newConcepts.get(term) !== oldDef) {
      changes.push({
        path: `readable.concepts[${term}]`,
        kind: 'modified',
        oldValue: oldDef,
        newValue: newConcepts.get(term),
      });
    }
  }
  for (const [term, newDef] of newConcepts) {
    if (!oldConcepts.has(term)) {
      changes.push({ path: `readable.concepts[${term}]`, kind: 'added', newValue: newDef });
    }
  }

  return changes;
}

// ============================================================================
// 可推演层 diff
// ============================================================================

async function diffDerivable(
  oldDerivable: DerivableLayer,
  newDerivable: DerivableLayer,
  aiAdapter: AIAdapter | undefined,
  useAI: boolean
): Promise<DerivableChange[]> {
  const changes: DerivableChange[] = [];

  // 1. 状态空间 diff
  changes.push(...diffStates(oldDerivable.states, newDerivable.states));

  // 2. 转移规则 diff
  changes.push(...diffTransitions(oldDerivable.transitions, newDerivable.transitions));

  // 3. 不变量 diff（含 AI 语义等价判断）
  changes.push(...(await diffInvariants(
    oldDerivable.invariants,
    newDerivable.invariants,
    aiAdapter,
    useAI
  )));

  // 4. 时序约束 diff
  changes.push(...diffTiming(oldDerivable.timing, newDerivable.timing));

  // 5. 异常路径 diff
  changes.push(...diffExceptions(oldDerivable.exceptions, newDerivable.exceptions));

  // 6. 初始状态与终态变更
  if (oldDerivable.initialStateId !== newDerivable.initialStateId) {
    changes.push({
      elementType: 'state',
      elementId: newDerivable.initialStateId ?? '__initial__',
      kind: 'modified',
      fieldChanges: [{
        path: 'derivable.initialStateId',
        kind: 'modified',
        oldValue: oldDerivable.initialStateId,
        newValue: newDerivable.initialStateId,
      }],
    });
  }

  return changes;
}

function diffStates(oldStates: StateDef[], newStates: StateDef[]): DerivableChange[] {
  const changes: DerivableChange[] = [];
  const oldMap = new Map(oldStates.map((s) => [s.id, s]));
  const newMap = new Map(newStates.map((s) => [s.id, s]));

  for (const [id, oldS] of oldMap) {
    if (!newMap.has(id)) {
      changes.push({ elementType: 'state', elementId: id, kind: 'removed' });
    } else {
      const newS = newMap.get(id)!;
      const fieldChanges: FieldChange[] = [];
      if (oldS.name !== newS.name) {
        fieldChanges.push({ path: 'name', kind: 'modified', oldValue: oldS.name, newValue: newS.name });
      }
      if (oldS.type !== newS.type) {
        fieldChanges.push({ path: 'type', kind: 'modified', oldValue: oldS.type, newValue: newS.type });
      }
      if (JSON.stringify(oldS.roleIds ?? []) !== JSON.stringify(newS.roleIds ?? [])) {
        fieldChanges.push({
          path: 'roleIds',
          kind: 'modified',
          oldValue: JSON.stringify(oldS.roleIds ?? []),
          newValue: JSON.stringify(newS.roleIds ?? []),
        });
      }
      if (fieldChanges.length > 0) {
        changes.push({
          elementType: 'state',
          elementId: id,
          kind: 'modified',
          fieldChanges,
        });
      }
    }
  }
  for (const [id] of newMap) {
    if (!oldMap.has(id)) {
      changes.push({ elementType: 'state', elementId: id, kind: 'added' });
    }
  }

  return changes;
}

function diffTransitions(
  oldTransitions: TransitionDef[],
  newTransitions: TransitionDef[]
): DerivableChange[] {
  const changes: DerivableChange[] = [];
  const oldMap = new Map(oldTransitions.map((t) => [t.id, t]));
  const newMap = new Map(newTransitions.map((t) => [t.id, t]));

  for (const [id, oldT] of oldMap) {
    if (!newMap.has(id)) {
      changes.push({ elementType: 'transition', elementId: id, kind: 'removed' });
    } else {
      const newT = newMap.get(id)!;
      const fieldChanges: FieldChange[] = [];
      const fields: Array<keyof TransitionDef> = ['name', 'from', 'to', 'action', 'triggerRoleId', 'guard', 'effects'];
      for (const field of fields) {
        const oldVal = JSON.stringify(oldT[field] ?? '');
        const newVal = JSON.stringify(newT[field] ?? '');
        if (oldVal !== newVal) {
          fieldChanges.push({
            path: field as string,
            kind: 'modified',
            oldValue: String(oldT[field] ?? ''),
            newValue: String(newT[field] ?? ''),
          });
        }
      }
      if (fieldChanges.length > 0) {
        changes.push({
          elementType: 'transition',
          elementId: id,
          kind: 'modified',
          fieldChanges,
        });
      }
    }
  }
  for (const [id] of newMap) {
    if (!oldMap.has(id)) {
      changes.push({ elementType: 'transition', elementId: id, kind: 'added' });
    }
  }

  return changes;
}

async function diffInvariants(
  oldInvariants: InvariantDef[],
  newInvariants: InvariantDef[],
  aiAdapter: AIAdapter | undefined,
  useAI: boolean
): Promise<DerivableChange[]> {
  const changes: DerivableChange[] = [];
  const oldMap = new Map(oldInvariants.map((i) => [i.id, i]));
  const newMap = new Map(newInvariants.map((i) => [i.id, i]));

  for (const [id, oldInv] of oldMap) {
    if (!newMap.has(id)) {
      changes.push({ elementType: 'invariant', elementId: id, kind: 'removed' });
    } else {
      const newInv = newMap.get(id)!;
      const fieldChanges: FieldChange[] = [];

      if (oldInv.name !== newInv.name) {
        fieldChanges.push({ path: 'name', kind: 'modified', oldValue: oldInv.name, newValue: newInv.name });
      }

      // 表达式变更：先做文本 diff，再 AI 辅助语义等价判断
      if (oldInv.expression !== newInv.expression) {
        const textEqual = false; // 文本不同
        let needsSemanticJudgment = true;

        if (useAI && aiAdapter) {
          const semanticEqual = await judgeInvariantSemanticEquivalence(
            oldInv.expression,
            newInv.expression,
            aiAdapter
          );
          if (semanticEqual) {
            // 语义等价：仅表达形式变更，不视为语义变更
            needsSemanticJudgment = false;
            fieldChanges.push({
              path: 'expression',
              kind: 'modified',
              oldValue: oldInv.expression,
              newValue: newInv.expression,
            });
          } else {
            // 语义变更：保留 needsSemanticJudgment=true 标记
            fieldChanges.push({
              path: 'expression',
              kind: 'modified',
              oldValue: oldInv.expression,
              newValue: newInv.expression,
            });
          }
        } else {
          // 无 AI：仅做文本 diff，标记需 AI 判断
          fieldChanges.push({
            path: 'expression',
            kind: 'modified',
            oldValue: oldInv.expression,
            newValue: newInv.expression,
          });
        }

        changes.push({
          elementType: 'invariant',
          elementId: id,
          kind: 'modified',
          fieldChanges,
          needsSemanticJudgment,
        });
        void textEqual;
        continue;
      }

      if (JSON.stringify(oldInv.scopeStateIds ?? []) !== JSON.stringify(newInv.scopeStateIds ?? [])) {
        fieldChanges.push({
          path: 'scopeStateIds',
          kind: 'modified',
          oldValue: JSON.stringify(oldInv.scopeStateIds ?? []),
          newValue: JSON.stringify(newInv.scopeStateIds ?? []),
        });
      }

      if (fieldChanges.length > 0) {
        changes.push({
          elementType: 'invariant',
          elementId: id,
          kind: 'modified',
          fieldChanges,
        });
      }
    }
  }
  for (const [id] of newMap) {
    if (!oldMap.has(id)) {
      changes.push({ elementType: 'invariant', elementId: id, kind: 'added' });
    }
  }

  return changes;
}

/**
 * AI 判断不变量表达式是否语义等价
 */
async function judgeInvariantSemanticEquivalence(
  oldExpr: string,
  newExpr: string,
  aiAdapter: AIAdapter
): Promise<boolean> {
  const prompt = {
    system:
      '你是形式化方法专家。判断两个不变量表达式是否语义等价（即在任何模型下都同时成立或同时不成立）。' +
      '例如 `not exists p: p > 1` 与 `forall p: p <= 1` 是等价的。' +
      '输出严格 JSON。',
    context: JSON.stringify({ oldExpression: oldExpr, newExpression: newExpr }, null, 2),
    instruction: [
      '请判断两个表达式是否语义等价：',
      '- 仅表达形式不同但语义相同 → equivalent: true',
      '- 语义不同（约束条件变化）→ equivalent: false',
      '- 无法判断 → equivalent: false（保守处理）',
    ].join('\n'),
    outputFormat: '返回 JSON：{ "equivalent": true|false, "reason": "..." }',
    temperature: 0.1,
  };

  const response = await aiAdapter.complete(prompt);
  if (!response.success) return false;

  try {
    const parsed = parseAIJson<{ equivalent: boolean; reason: string }>(response.content);
    return parsed.equivalent === true;
  } catch {
    return false;
  }
}

function diffTiming(
  oldTiming: TimingDef[],
  newTiming: TimingDef[]
): DerivableChange[] {
  const changes: DerivableChange[] = [];
  const oldMap = new Map(oldTiming.map((t) => [t.id, t]));
  const newMap = new Map(newTiming.map((t) => [t.id, t]));

  for (const [id, oldT] of oldMap) {
    if (!newMap.has(id)) {
      changes.push({ elementType: 'timing', elementId: id, kind: 'removed' });
    } else {
      const newT = newMap.get(id)!;
      const oldJson = JSON.stringify(oldT);
      const newJson = JSON.stringify(newT);
      if (oldJson !== newJson) {
        changes.push({
          elementType: 'timing',
          elementId: id,
          kind: 'modified',
          fieldChanges: [{
            path: 'timing',
            kind: 'modified',
            oldValue: oldJson,
            newValue: newJson,
          }],
        });
      }
    }
  }
  for (const [id] of newMap) {
    if (!oldMap.has(id)) {
      changes.push({ elementType: 'timing', elementId: id, kind: 'added' });
    }
  }

  return changes;
}

function diffExceptions(
  oldExceptions: ExceptionPathDef[],
  newExceptions: ExceptionPathDef[]
): DerivableChange[] {
  const changes: DerivableChange[] = [];
  const oldMap = new Map(oldExceptions.map((e) => [e.id, e]));
  const newMap = new Map(newExceptions.map((e) => [e.id, e]));

  for (const [id, oldE] of oldMap) {
    if (!newMap.has(id)) {
      changes.push({ elementType: 'exception', elementId: id, kind: 'removed' });
    } else {
      const newE = newMap.get(id)!;
      if (JSON.stringify(oldE) !== JSON.stringify(newE)) {
        changes.push({
          elementType: 'exception',
          elementId: id,
          kind: 'modified',
          fieldChanges: [{
            path: 'exception',
            kind: 'modified',
            oldValue: JSON.stringify(oldE),
            newValue: JSON.stringify(newE),
          }],
        });
      }
    }
  }
  for (const [id] of newMap) {
    if (!oldMap.has(id)) {
      changes.push({ elementType: 'exception', elementId: id, kind: 'added' });
    }
  }

  return changes;
}

// ============================================================================
// 影响分析
// ============================================================================

/**
 * 根据 diff 推导受影响的下游步骤与派生产物
 *
 * 影响传播规则（依据步骤依赖 DAG）：
 * - 元数据/状态/转移变更 → 影响所有下游步骤（check→reason→formalize→derive-specs→...）
 * - 不变量表达式语义变更 → 影响形式化验证 + 契约推导 + 测试工具生成 + 一致性验证
 * - 时序约束变更 → 影响契约推导 + 测试工具生成
 * - 仅可读层变更 → 不影响下游（仅文档）
 */
function analyzeImpact(diff: ModelDiff): ImpactAnalysis {
  const affectedSteps = new Set<StepId>();
  const affectedArtifacts = new Set<string>();

  const hasDerivableChange = diff.derivableChanges.length > 0;
  const hasMetadataChange = diff.metadataChanges.length > 0;
  const hasReadableChange = diff.readableChanges.length > 0;

  if (hasMetadataChange) {
    affectedSteps.add('check');
    affectedArtifacts.add('derived/completeness-report.json');
  }

  if (hasDerivableChange) {
    // 可推演层变更：影响从 check 开始的所有下游
    const allSteps: StepId[] = [
      'check', 'reason', 'formalize',
      'derive-specs', 'derive-contracts',
      'generate-tests', 'generate-cases',
      'check-impl', 'verify',
    ];
    for (const s of allSteps) affectedSteps.add(s);

    affectedArtifacts.add('derived/completeness-report.json');
    affectedArtifacts.add('derived/reasoning-report.json');
    affectedArtifacts.add('derived/formal/');
    affectedArtifacts.add('derived/specs.json');
    affectedArtifacts.add('derived/contracts.json');
    affectedArtifacts.add('derived/test-tool/');
    affectedArtifacts.add('derived/test-cases.json');
    affectedArtifacts.add('derived/impl-check/');
    affectedArtifacts.add('derived/verification/');
  } else if (hasReadableChange) {
    // 仅可读层变更：影响语义层检查（AI 语义判断）
    affectedSteps.add('check');
    affectedArtifacts.add('derived/completeness-report.json');
  }

  // 不变量表达式语义变更：特别标注
  const hasInvariantSemanticChange = diff.derivableChanges.some(
    (c) => c.elementType === 'invariant' && c.needsSemanticJudgment
  );
  if (hasInvariantSemanticChange) {
    affectedArtifacts.add('derived/formal/');
    affectedArtifacts.add('derived/contracts.json');
  }

  // 增量重推导路径：从最早的受影响步骤开始
  const executionOrder: StepId[] = [
    'check', 'reason', 'formalize',
    'derive-specs', 'derive-contracts',
    'generate-tests', 'generate-cases',
    'check-impl', 'verify',
  ];
  const incrementalPlan = executionOrder.filter((s) => affectedSteps.has(s));

  return {
    affectedSteps: Array.from(affectedSteps),
    affectedArtifacts: Array.from(affectedArtifacts),
    incrementalPlan,
    analyzedAt: new Date().toISOString(),
  };
}

// ============================================================================
// 报告摘要
// ============================================================================

export function formatDiffSummary(result: DiffResult): string {
  const d = result.diff;
  const i = result.impact;
  const lines: string[] = [
    '协议模型差分：',
    `  元数据变更: ${d.metadataChanges.length} 项`,
    `  可读层变更: ${d.readableChanges.length} 项`,
    `  可推演层变更: ${d.derivableChanges.length} 项`,
  ];

  // 分类统计可推演层变更
  const byType = new Map<string, number>();
  for (const c of d.derivableChanges) {
    const key = `${c.elementType}.${c.kind}`;
    byType.set(key, (byType.get(key) ?? 0) + 1);
  }
  if (byType.size > 0) {
    lines.push('  可推演层变更分类：');
    for (const [key, count] of byType) {
      lines.push(`    - ${key}: ${count}`);
    }
  }

  // 语义等价待判断项
  const semanticPending = d.derivableChanges.filter((c) => c.needsSemanticJudgment);
  if (semanticPending.length > 0) {
    lines.push(`  不变量语义等价待判断: ${semanticPending.length} 项`);
    for (const c of semanticPending.slice(0, 3)) {
      lines.push(`    - ${c.elementId}`);
    }
  }

  lines.push('');
  lines.push('影响分析：');
  lines.push(`  受影响步骤: ${i.affectedSteps.join(', ') || '无'}`);
  lines.push(`  受影响产物: ${i.affectedArtifacts.length} 项`);
  lines.push(`  建议增量重推导路径: ${i.incrementalPlan.join(' → ') || '无'}`);

  return lines.join('\n');
}
