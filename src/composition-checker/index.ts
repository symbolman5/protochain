/**
 * 组合层完备性检查 —— 步骤①-C 机械层（代码确定性执行，无 AI）
 *
 * 设计依据：《协议驱动自验证工具链设计方案》2.1 composition-checker 模块、AI参与矩阵
 *
 * 机械层 4 项校验：
 * 1. 跨协议引用存在性：汇总各子协议 ① 阶段标记的 pendingCrossProtocolRefs，
 *    校验每条引用在组合层（crossInvariants/externalDependencies）或对应子协议中可解析
 * 2. 观测接口覆盖：观测接口声明的 observable 字段须能追溯到对应子协议的状态/不变量
 * 3. 切面约束追溯：对象状态切面的 crossFacetConstraints.tracesToInvariantId 须指向已存在的跨协议不变量
 * 4. 安全前提声明完整性：securityAssumptions 每项的 assumption/description/impactIfViolated 非空
 *
 * 输入：CompositionModel + 各子协议的 pendingCrossProtocolRefs（含来源协议ID）
 * 输出：CompositionCompletenessReport（机械层结果 + 跨协议引用解析结果）
 */

import type {
  CompositionModel,
  SourceProtocolModel,
  PendingCrossProtocolRef,
  CheckIssue,
  MechanicalCheckResult,
  SemanticCheckResult,
  CompositionCompletenessReport,
  CrossProtocolRefCheckResult,
} from '../model/types.js';

/**
 * 带来源协议ID的待校验跨协议引用（① 阶段收集时附加来源）。
 */
export interface PendingRefWithSource extends PendingCrossProtocolRef {
  sourceProtocol: string;
}

export interface CheckCompositionOptions {
  /** 各子协议模型（用于校验跨协议引用的目标解析、观测接口字段追溯） */
  subProtocolModels?: SourceProtocolModel[];
}

/**
 * ①-C 机械层主入口。
 *
 * @param composition 组合层模型
 * @param pendingRefs 各子协议 ① 阶段标记的 pendingCrossProtocolRefs（含来源协议ID）
 * @param options 子协议模型等可选上下文
 */
export function checkCompositionCompleteness(
  composition: CompositionModel,
  pendingRefs: PendingRefWithSource[],
  options: CheckCompositionOptions = {}
): CompositionCompletenessReport {
  const structuralIssues: CheckIssue[] = [];
  const fieldIssues: CheckIssue[] = [];
  const referenceIssues: CheckIssue[] = [];

  // 1. 跨协议引用存在性（结果同时写入 crossProtocolRefResults）
  const crossProtocolRefResults = checkCrossProtocolReferences(
    composition,
    pendingRefs,
    options.subProtocolModels ?? [],
    referenceIssues
  );

  // 2. 观测接口覆盖
  checkObservationInterfaceCoverage(
    composition,
    options.subProtocolModels ?? [],
    referenceIssues
  );

  // 3. 切面约束追溯
  checkFacetConstraintsTraceability(composition, referenceIssues);

  // 4. 安全前提声明完整性
  checkSecurityAssumptionCompleteness(composition, fieldIssues);

  // 组合层结构完备性（必要段落存在性由 composition-parser 保证；此处补充交叉结构检查）
  checkCompositionStructure(composition, structuralIssues);

  const mechanical: MechanicalCheckResult = {
    passed:
      structuralIssues.every((i) => i.severity !== 'error') &&
      fieldIssues.every((i) => i.severity !== 'error') &&
      referenceIssues.every((i) => i.severity !== 'error'),
    structuralIssues,
    fieldIssues,
    referenceIssues,
  };

  return {
    mechanical,
    // 语义层由 composition-checker-ai 填充，此处留空
    semantic: {
      passed: false,
      duplicationIssues: [],
      ambiguityIssues: [],
      semanticIssues: [],
      executed: false,
    },
    passed: mechanical.passed,
    crossProtocolRefResults,
    checkedAt: new Date().toISOString(),
  };
}

// ============================================================================
// 1. 跨协议引用存在性
// ============================================================================

/**
 * 校验各子协议标记的 pendingCrossProtocolRefs 是否在组合层可解析。
 *
 * 解析规则：
 * - refType='composition' + sourceField 含 'crossInvariant' → 在 composition.crossInvariants 找 id
 * - refType='composition' + sourceField='TransitionDef.trigger' → 在 composition.externalDependencies 找 system
 * - refType='cross_protocol' → 在对应子协议模型中解析 targetRef（如 'entry（P2）' → P2 的实体）
 */
function checkCrossProtocolReferences(
  composition: CompositionModel,
  pendingRefs: PendingRefWithSource[],
  subProtocolModels: SourceProtocolModel[],
  issues: CheckIssue[]
): CrossProtocolRefCheckResult[] {
  const crossInvariantIds = new Set(composition.crossInvariants.map((i) => i.id));
  const externalSystems = new Set(composition.externalDependencies.map((d) => d.system));
  const subProtocolIds = new Set(composition.subProtocols.map((s) => s.protocolId));

  const results: CrossProtocolRefCheckResult[] = [];

  for (const ref of pendingRefs) {
    const result: CrossProtocolRefCheckResult = {
      sourceProtocol: ref.sourceProtocol,
      sourceField: ref.sourceField,
      targetRef: ref.targetRef,
      resolved: false,
    };

    // 来源协议须在子协议清单中
    if (!subProtocolIds.has(ref.sourceProtocol)) {
      result.error = `来源协议 "${ref.sourceProtocol}" 不在 composition.subProtocols 清单中`;
      issues.push(
        errorIssue(
          result.error,
          'composition.crossProtocolRefs',
          ref.sourceProtocol
        )
      );
      results.push(result);
      continue;
    }

    let resolved = false;
    let error: string | undefined;

    if (ref.refType === 'composition') {
      if (ref.sourceField.includes('crossInvariant') || ref.sourceField.includes('crossInstance')) {
        // 引用组合层跨协议不变量
        resolved = crossInvariantIds.has(ref.targetRef);
        if (!resolved) {
          error = `跨协议不变量引用 "${ref.targetRef}" 在 composition.crossInvariants 中不存在`;
        }
      } else if (ref.sourceField === 'TransitionDef.trigger') {
        // 引用组合层外部依赖系统
        resolved = externalSystems.has(ref.targetRef);
        if (!resolved) {
          error = `外部事件源 "${ref.targetRef}" 在 composition.externalDependencies 中不存在`;
        }
      } else {
        // 其他组合层引用：默认在 crossInvariants 中查找
        resolved = crossInvariantIds.has(ref.targetRef);
        if (!resolved) {
          error = `组合层引用 "${ref.targetRef}" 无法解析（sourceField=${ref.sourceField}）`;
        }
      }
    } else if (ref.refType === 'cross_protocol') {
      // 跨协议引用：解析 targetRef 中的协议ID与实体名
      // 格式如 'entry（P2）' 或 'P2.entry'
      const parsed = parseCrossProtocolRef(ref.targetRef);
      if (parsed) {
        const targetModel = subProtocolModels.find(
          (m) => m.metadata.name === parsed.targetProtocol ||
                 composition.subProtocols.find(
                   (sp) => sp.protocolId === parsed.targetProtocol
                 )
        );
        if (!targetModel) {
          error = `跨协议引用目标协议 "${parsed.targetProtocol}" 的模型未提供或不在子协议清单`;
        } else {
          // 校验目标协议中是否存在该实体（状态/附属实体）
          const hasEntity =
            targetModel.derivable.states.some((s) => s.id === parsed.entityName) ||
            (targetModel.derivable.subsidiaryEntities ?? []).some(
              (e) => e.id === parsed.entityName
            );
          resolved = hasEntity;
          if (!resolved) {
            error = `跨协议引用实体 "${parsed.entityName}" 在协议 "${parsed.targetProtocol}" 中不存在`;
          }
        }
      } else {
        error = `跨协议引用 "${ref.targetRef}" 格式无法解析（期望 'entity（Pn）' 或 'Pn.entity'）`;
      }
    }

    result.resolved = resolved;
    result.error = error;
    if (!resolved) {
      issues.push(
        errorIssue(
          error ?? `跨协议引用 "${ref.targetRef}" 解析失败`,
          'composition.crossProtocolRefs',
          ref.sourceProtocol
        )
      );
    }
    results.push(result);
  }

  return results;
}

/** 解析跨协议引用 'entry（P2）' / 'entry(P2)' / 'P2.entry' → { entityName, targetProtocol } */
function parseCrossProtocolRef(
  ref: string
): { entityName: string; targetProtocol: string } | null {
  // 格式1: 'entity（Pn）' 或 'entity(Pn)'
  const m1 = ref.match(/^(.+?)[（(]\s*(P\d+)\s*[)）]$/);
  if (m1) {
    return { entityName: m1[1].trim(), targetProtocol: m1[2].trim() };
  }
  // 格式2: 'Pn.entity'
  const m2 = ref.match(/^(P\d+)\.(.+)$/);
  if (m2) {
    return { entityName: m2[2].trim(), targetProtocol: m2[1].trim() };
  }
  return null;
}

// ============================================================================
// 2. 观测接口覆盖
// ============================================================================

/**
 * 校验 observable.object 能否在目标协议中解析。
 *
 * 4 层优先级精确匹配（===），不使用子串匹配以避免假阳性：
 * 1. 状态 ID（如 S1, S2）
 * 2. 附属实体 ID（如 port, tunnel_connection）
 * 3. 协议 ID 或协议名称（概念级实体匹配）
 * 4. 状态名称（如 "已启用", "活跃"）
 */
function checkObservationObject(
  objectName: string,
  targetProtocolId: string,
  targetModel: SourceProtocolModel
): boolean {
  // 1. 精确匹配状态 ID
  if (targetModel.derivable.states.some((s) => s.id === objectName)) return true;
  // 2. 精确匹配附属实体 ID
  if ((targetModel.derivable.subsidiaryEntities ?? []).some((e) => e.id === objectName)) return true;
  // 3. 精确匹配协议 ID 或协议名称（概念级实体）
  if (targetProtocolId === objectName) return true;
  if (targetModel.metadata.name === objectName) return true;
  // 4. 精确匹配状态名称
  if (targetModel.derivable.states.some((s) => s.name === objectName)) return true;
  return false;
}

/**
 * 校验观测接口的 observable 字段须能追溯到对应子协议的状态/不变量。
 * - observable.protocol 须在 subProtocols 中
 * - observable.object 须可解析（状态ID → 附属实体ID → 协议ID/名 → 状态名）
 * - observable.fields 须为对应子协议状态的事实/维度或附属实体维度
 */
function checkObservationInterfaceCoverage(
  composition: CompositionModel,
  subProtocolModels: SourceProtocolModel[],
  issues: CheckIssue[]
): void {
  const subProtocolIds = new Set(composition.subProtocols.map((s) => s.protocolId));
  const modelByProtocolId = new Map<string, SourceProtocolModel>();
  // 通过 composition.subProtocols 的 protocolId 建立映射
  for (const sp of composition.subProtocols) {
    const model = subProtocolModels.find((m) => m.metadata.name === sp.name);
    if (model) modelByProtocolId.set(sp.protocolId, model);
  }

  for (const oi of composition.observationInterfaces) {
    for (const obs of oi.observable) {
      // protocol 须在子协议清单
      if (!subProtocolIds.has(obs.protocol)) {
        issues.push(
          errorIssue(
            `观测接口 "${oi.id}" 的 observable.protocol="${obs.protocol}" 不在子协议清单`,
            'composition.observationInterfaces.observable.protocol',
            oi.id
          )
        );
        continue;
      }
      const targetModel = modelByProtocolId.get(obs.protocol);
      if (!targetModel) {
        // 子协议模型未提供，无法深度校验，跳过（不报错）
        continue;
      }
      // object 须可解析（4 层优先级匹配）
      if (!checkObservationObject(obs.object, obs.protocol, targetModel)) {
        issues.push(
          errorIssue(
            `观测接口 "${oi.id}" 的 observable.object="${obs.object}" 在协议 "${obs.protocol}" 中无对应状态、附属实体、协议ID/名或状态名`,
            'composition.observationInterfaces.observable.object',
            oi.id
          )
        );
        continue;
      }
      // fields 校验：仅在精确匹配到状态/附属实体时可用
      const state = targetModel.derivable.states.find((s) => s.id === obs.object);
      const subsidiary = (targetModel.derivable.subsidiaryEntities ?? []).find(
        (e) => e.id === obs.object
      );
      if (!state && !subsidiary) {
        // 协议级匹配通过，但无法做字段级校验，跳过
        continue;
      }
      const availableFields = new Set<string>();
      if (state) {
        (state.facts ?? []).forEach((f) => availableFields.add(f));
        (state.dimensions ?? []).forEach((d) => availableFields.add(d.name));
      }
      if (subsidiary) {
        subsidiary.stateSpace.dimensions.forEach((d) => availableFields.add(d.name));
      }
      for (const field of obs.fields) {
        if (availableFields.size > 0 && !availableFields.has(field)) {
          issues.push(
            errorIssue(
              `观测接口 "${oi.id}" 的 observable.fields 含 "${field}"，但在协议 "${obs.protocol}" 的对象 "${obs.object}" 中无对应事实/维度`,
              'composition.observationInterfaces.observable.fields',
              oi.id
            )
          );
        }
      }
    }
  }
}

// ============================================================================
// 3. 切面约束追溯
// ============================================================================

/**
 * 校验对象状态切面的 crossFacetConstraints.tracesToInvariantId 须指向已存在的跨协议不变量。
 */
function checkFacetConstraintsTraceability(
  composition: CompositionModel,
  issues: CheckIssue[]
): void {
  const crossInvariantIds = new Set(composition.crossInvariants.map((i) => i.id));
  for (const facet of composition.objectStateFacets) {
    for (const constraint of facet.crossFacetConstraints) {
      if (!crossInvariantIds.has(constraint.tracesToInvariantId)) {
        issues.push(
          errorIssue(
            `对象状态切面 "${facet.object}" 的 crossFacetConstraint.tracesToInvariantId="${constraint.tracesToInvariantId}" 在 composition.crossInvariants 中不存在`,
            'composition.objectStateFacets.crossFacetConstraints.tracesToInvariantId',
            facet.object
          )
        );
      }
    }
  }
}

// ============================================================================
// 4. 安全前提声明完整性
// ============================================================================

function checkSecurityAssumptionCompleteness(
  composition: CompositionModel,
  issues: CheckIssue[]
): void {
  for (const sa of composition.securityAssumptions) {
    if (!sa.assumption || sa.assumption.trim() === '') {
      issues.push(
        errorIssue(
          `安全前提 "${sa.id}" 的 assumption 为空`,
          'composition.securityAssumptions.assumption',
          sa.id
        )
      );
    }
    if (!sa.description || sa.description.trim() === '') {
      issues.push(
        errorIssue(
          `安全前提 "${sa.id}" 的 description 为空`,
          'composition.securityAssumptions.description',
          sa.id
        )
      );
    }
    if (!sa.impactIfViolated || sa.impactIfViolated.trim() === '') {
      issues.push(
        errorIssue(
          `安全前提 "${sa.id}" 的 impactIfViolated 为空`,
          'composition.securityAssumptions.impactIfViolated',
          sa.id
        )
      );
    }
  }
}

// ============================================================================
// 组合层结构完备性（补充交叉检查）
// ============================================================================

function checkCompositionStructure(
  composition: CompositionModel,
  issues: CheckIssue[]
): void {
  // 依赖图 edges 的 from/to 须在子协议清单中
  const subProtocolIds = new Set(composition.subProtocols.map((s) => s.protocolId));
  for (const edge of composition.dependencyGraph.edges) {
    if (!subProtocolIds.has(edge.from)) {
      issues.push(
        errorIssue(
          `依赖图 edge.from="${edge.from}" 不在子协议清单`,
          'composition.dependencyGraph.edges.from'
        )
      );
    }
    if (!subProtocolIds.has(edge.to)) {
      issues.push(
        errorIssue(
          `依赖图 edge.to="${edge.to}" 不在子协议清单`,
          'composition.dependencyGraph.edges.to'
        )
      );
    }
  }

  // 跨协议不变量的 span 须全部在子协议清单中
  for (const inv of composition.crossInvariants) {
    for (const pid of inv.span) {
      if (!subProtocolIds.has(pid)) {
        issues.push(
          errorIssue(
            `跨协议不变量 "${inv.id}" 的 span 含 "${pid}"，不在子协议清单`,
            'composition.crossInvariants.span',
            inv.id
          )
        );
      }
    }
  }

  // externalDependencies 的 protocol 须在子协议清单
  for (const dep of composition.externalDependencies) {
    if (!subProtocolIds.has(dep.protocol)) {
      issues.push(
        errorIssue(
          `外部依赖 "${dep.system}" 的 protocol="${dep.protocol}" 不在子协议清单`,
          'composition.externalDependencies.protocol'
        )
      );
    }
    // direction='query' 时必须引用观测接口
    if (dep.direction === 'query' && !dep.queryObservationInterfaceId) {
      issues.push(
        errorIssue(
          `外部依赖 "${dep.system}" direction="query"，但未声明 queryObservationInterfaceId`,
          'composition.externalDependencies.queryObservationInterfaceId'
        )
      );
    }
  }
}

// ============================================================================
// 工具
// ============================================================================

function errorIssue(
  message: string,
  elementPath?: string,
  elementId?: string
): CheckIssue {
  return { severity: 'error', category: 'mechanical', message, elementPath, elementId };
}
