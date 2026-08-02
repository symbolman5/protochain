/**
 * 完备性检查器 —— 步骤①机械层（代码确定性执行，无 AI）
 *
 * 设计依据：《协议驱动自验证工具链设计方案》AI参与矩阵
 *
 * 检查三类问题：
 * 1. 结构完备性：必需的层/段落是否齐全；必需集合是否非空
 * 2. 字段完整性：每个元素的必填字段是否非空、格式是否合法
 * 3. ID 交叉引用：from/to/scope/transitionIds 等引用是否指向已定义元素
 *
 * 退化模式：对形式化语言做结构检查（如 TLA+ 是否声明 Init/Next、是否有不变量定义）
 */

import type {
  SourceProtocolModel,
  DerivableLayer,
  StateDef,
  TransitionDef,
  InvariantDef,
  TimingDef,
  ExceptionPathDef,
  CheckIssue,
  MechanicalCheckResult,
  CompletenessReport,
  PendingCrossProtocolRef,
} from '../model/types.js';

export function checkCompleteness(
  model: SourceProtocolModel
): CompletenessReport {
  const structuralIssues: CheckIssue[] = [];
  const fieldIssues: CheckIssue[] = [];
  const referenceIssues: CheckIssue[] = [];

  // ----------------------------------------------------------------------
  // 1. 结构完备性
  // ----------------------------------------------------------------------
  checkStructuralCompleteness(model, structuralIssues);

  // ----------------------------------------------------------------------
  // 2. 字段完整性
  // ----------------------------------------------------------------------
  checkFieldIntegrity(model, fieldIssues);

  // ----------------------------------------------------------------------
  // 3. ID 交叉引用
  // ----------------------------------------------------------------------
  // 退化模式下结构化引用可能不全，仍尝试检查已提取的部分
  checkCrossReferences(model, referenceIssues);

  // ----------------------------------------------------------------------
  // 4. 扩展校验规则（决策8 扩展段启用后的 7 条规则）
  // ----------------------------------------------------------------------
  checkExtendedRules(model, referenceIssues);

  // ----------------------------------------------------------------------
  // 5. 跨协议引用收集（① 阶段标记，①-C 阶段在 composition-checker 校验）
  // ----------------------------------------------------------------------
  const pendingCrossProtocolRefs = collectPendingCrossProtocolRefs(model);

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
    // 语义层由 checker-ai 模块填充，此处留空
    semantic: {
      passed: false,
      duplicationIssues: [],
      ambiguityIssues: [],
      semanticIssues: [],
      executed: false,
    },
    passed: mechanical.passed,
    pendingCrossProtocolRefs:
      pendingCrossProtocolRefs.length > 0 ? pendingCrossProtocolRefs : undefined,
    checkedAt: new Date().toISOString(),
  };
}

// ============================================================================
// 结构完备性
// ============================================================================

function checkStructuralCompleteness(
  model: SourceProtocolModel,
  issues: CheckIssue[]
): void {
  // 元数据层
  if (!model.metadata.name) {
    issues.push(errorIssue('metadata.name 为空', 'metadata.name'));
  }
  if (!model.metadata.version) {
    issues.push(errorIssue('metadata.version 为空', 'metadata.version'));
  }
  if (!model.metadata.purpose) {
    issues.push(errorIssue('metadata.purpose 为空', 'metadata.purpose'));
  }
  if (!Array.isArray(model.metadata.roles) || model.metadata.roles.length === 0) {
    issues.push(errorIssue('metadata.roles 为空，至少需声明一个角色', 'metadata.roles'));
  }

  // 可读层
  if (!model.readable.background) {
    issues.push(
      warningIssue('readable.background 为空，建议补充协议背景', 'readable.background')
    );
  }
  if (!model.readable.workflow) {
    issues.push(
      warningIssue('readable.workflow 为空，建议补充协作流程描述', 'readable.workflow')
    );
  }

  // 可推演层
  const derivable = model.derivable;
  if (derivable.degraded) {
    checkDegradedStructure(derivable, issues);
    return;
  }

  // 正常模式结构完备性
  if (derivable.states.length === 0) {
    issues.push(errorIssue('可推演层 states 为空', 'derivable.states'));
  }
  if (derivable.transitions.length === 0) {
    issues.push(
      warningIssue('可推演层 transitions 为空，无转移规则', 'derivable.transitions')
    );
  }

  // 初始状态必须存在且唯一
  const initialStates = derivable.states.filter((s) => s.type === 'initial');
  if (initialStates.length === 0) {
    issues.push(
      errorIssue('缺少初始状态（type=initial 的状态）', 'derivable.states')
    );
  } else if (initialStates.length > 1) {
    issues.push(
      errorIssue(
        `存在 ${initialStates.length} 个初始状态，初始状态必须唯一`,
        'derivable.states',
        initialStates[0].id
      )
    );
  }

  // 终态至少一个
  if (derivable.terminalStateIds.length === 0 && !derivable.states.some((s) => s.type === 'terminal')) {
    issues.push(
      warningIssue('未声明终态（type=terminal），活性质质无法保证', 'derivable.states')
    );
  }

  // initialStateId 与 initial 类型状态一致
  if (derivable.initialStateId) {
    const init = derivable.states.find((s) => s.id === derivable.initialStateId);
    if (!init) {
      issues.push(
        errorIssue(
          `initialStateId "${derivable.initialStateId}" 在 states 中不存在`,
          'derivable.initialStateId'
        )
      );
    } else if (init.type !== 'initial') {
      issues.push(
        errorIssue(
          `initialStateId "${derivable.initialStateId}" 对应状态类型为 ${init.type}，应为 initial`,
          'derivable.initialStateId',
          init.id
        )
      );
    }
  }
}

function checkDegradedStructure(
  derivable: DerivableLayer,
  issues: CheckIssue[]
): void {
  if (!derivable.formalSpecRaw || derivable.formalSpecRaw.trim() === '') {
    issues.push(errorIssue('退化模式 formalSpecRaw 为空', 'derivable.formalSpecRaw'));
    return;
  }

  const lang = derivable.formalLanguage;
  if (!lang || lang === 'unknown') {
    issues.push(
      warningIssue(
        '退化模式 formalLanguage 未知，无法做形式化结构检查',
        'derivable.formalLanguage'
      )
    );
    return;
  }

  // TLA+ 结构检查：是否声明 Init/Next 谓词、是否有不变量定义
  if (lang === 'tla') {
    const spec = derivable.formalSpecRaw;
    if (!/\bInit\b\s*==/.test(spec)) {
      issues.push(
        errorIssue('TLA+ 规格缺少 Init 谓词定义', 'derivable.formalSpecRaw')
      );
    }
    if (!/\bNext\b\s*==/.test(spec)) {
      issues.push(
        errorIssue('TLA+ 规格缺少 Next 谓词定义', 'derivable.formalSpecRaw')
      );
    }
    // 不变量定义：通常以 Inv 或 Invariant 命名，或被 TypeInvariant 标注
    if (!/\b(Inv|Invariant|TypeInvariant)\b\s*==/.test(spec)) {
      issues.push(
        warningIssue(
          'TLA+ 规格未见显式不变量定义（建议命名 Inv/Invariant）',
          'derivable.formalSpecRaw'
        )
      );
    }
    if (!/\bMODULE\b/.test(spec) || !/====/.test(spec)) {
      issues.push(
        warningIssue(
          'TLA+ 规格缺少 MODULE 声明或 ==== 结束标记',
          'derivable.formalSpecRaw'
        )
      );
    }
  }

  // SCXML 结构检查
  if (lang === 'scxml') {
    const spec = derivable.formalSpecRaw;
    if (!/<scxml/i.test(spec)) {
      issues.push(errorIssue('SCXML 规格缺少 <scxml> 根元素', 'derivable.formalSpecRaw'));
    }
    if (!/<initial/i.test(spec)) {
      issues.push(errorIssue('SCXML 规格缺少 <initial> 元素', 'derivable.formalSpecRaw'));
    }
    if (!/<state/i.test(spec) && !/<parallel/i.test(spec)) {
      issues.push(
        warningIssue('SCXML 规格未见 <state>/<parallel> 元素', 'derivable.formalSpecRaw')
      );
    }
  }
}

// ============================================================================
// 字段完整性
// ============================================================================

function checkFieldIntegrity(
  model: SourceProtocolModel,
  issues: CheckIssue[]
): void {
  // 角色
  const roleIds = new Set<string>();
  for (const role of model.metadata.roles) {
    if (!role.id) {
      issues.push(errorIssue('roles 存在 id 为空的项', 'metadata.roles'));
    } else {
      if (roleIds.has(role.id)) {
        issues.push(
          errorIssue(`角色 ID "${role.id}" 重复`, 'metadata.roles', role.id)
        );
      }
      roleIds.add(role.id);
    }
    if (!role.name) {
      issues.push(
        errorIssue(`角色 "${role.id}" 的 name 为空`, 'metadata.roles', role.id)
      );
    }
  }

  if (model.derivable.degraded) {
    // 退化模式下不强制检查结构化字段
    return;
  }

  // 状态 ID 唯一性
  const stateIds = new Set<string>();
  for (const s of model.derivable.states) {
    checkStateFields(s, issues);
    if (stateIds.has(s.id)) {
      issues.push(errorIssue(`状态 ID "${s.id}" 重复`, 'derivable.states', s.id));
    }
    stateIds.add(s.id);
  }

  // 转移 ID 唯一性
  const transitionIds = new Set<string>();
  for (const t of model.derivable.transitions) {
    checkTransitionFields(t, issues);
    if (transitionIds.has(t.id)) {
      issues.push(errorIssue(`转移 ID "${t.id}" 重复`, 'derivable.transitions', t.id));
    }
    transitionIds.add(t.id);
  }

  // 不变量 ID 唯一性
  const invariantIds = new Set<string>();
  for (const inv of model.derivable.invariants) {
    checkInvariantFields(inv, issues);
    if (invariantIds.has(inv.id)) {
      issues.push(errorIssue(`不变量 ID "${inv.id}" 重复`, 'derivable.invariants', inv.id));
    }
    invariantIds.add(inv.id);
  }

  // 时序约束 ID 唯一性
  const timingIds = new Set<string>();
  for (const tm of model.derivable.timing) {
    checkTimingFields(tm, issues);
    if (timingIds.has(tm.id)) {
      issues.push(errorIssue(`时序约束 ID "${tm.id}" 重复`, 'derivable.timing', tm.id));
    }
    timingIds.add(tm.id);
  }

  // 异常路径 ID 唯一性
  const exceptionIds = new Set<string>();
  for (const ex of model.derivable.exceptions) {
    checkExceptionFields(ex, issues);
    if (exceptionIds.has(ex.id)) {
      issues.push(errorIssue(`异常路径 ID "${ex.id}" 重复`, 'derivable.exceptions', ex.id));
    }
    exceptionIds.add(ex.id);
  }
}

function checkStateFields(s: StateDef, issues: CheckIssue[]): void {
  if (!s.id) {
    issues.push(errorIssue('状态 id 为空', 'derivable.states'));
  }
  if (!s.name) {
    issues.push(errorIssue(`状态 "${s.id}" 的 name 为空`, 'derivable.states', s.id));
  }
  const validTypes = ['initial', 'normal', 'terminal', 'error'];
  if (!validTypes.includes(s.type)) {
    issues.push(
      errorIssue(
        `状态 "${s.id}" 的 type "${s.type}" 不合法（应为 ${validTypes.join('/')}）`,
        'derivable.states',
        s.id
      )
    );
  }
}

function checkTransitionFields(t: TransitionDef, issues: CheckIssue[]): void {
  if (!t.id) {
    issues.push(errorIssue('转移 id 为空', 'derivable.transitions'));
  }
  if (!t.name) {
    issues.push(errorIssue(`转移 "${t.id}" 的 name 为空`, 'derivable.transitions', t.id));
  }
  if (!t.from || t.from.length === 0) {
    issues.push(errorIssue(`转移 "${t.id}" 的 from 为空`, 'derivable.transitions', t.id));
  }
  if (!t.to) {
    issues.push(errorIssue(`转移 "${t.id}" 的 to 为空`, 'derivable.transitions', t.id));
  }
  if (!t.action) {
    issues.push(errorIssue(`转移 "${t.id}" 的 action 为空`, 'derivable.transitions', t.id));
  }
  if (t.from.length > 0 && t.from.includes(t.to)) {
    issues.push(
      warningIssue(
        `转移 "${t.id}" 的 from 包含 to（${t.to}），为自环`,
        'derivable.transitions',
        t.id
      )
    );
  }
}

function checkInvariantFields(inv: InvariantDef, issues: CheckIssue[]): void {
  if (!inv.id) {
    issues.push(errorIssue('不变量 id 为空', 'derivable.invariants'));
  }
  if (!inv.name) {
    issues.push(errorIssue(`不变量 "${inv.id}" 的 name 为空`, 'derivable.invariants', inv.id));
  }
  if (!inv.expression) {
    issues.push(
      errorIssue(`不变量 "${inv.id}" 的 expression 为空`, 'derivable.invariants', inv.id)
    );
  }
}

function checkTimingFields(tm: TimingDef, issues: CheckIssue[]): void {
  if (!tm.id) {
    issues.push(errorIssue('时序约束 id 为空', 'derivable.timing'));
  }
  if (!tm.name) {
    issues.push(errorIssue(`时序约束 "${tm.id}" 的 name 为空`, 'derivable.timing', tm.id));
  }
  if (!tm.source) {
    issues.push(errorIssue(`时序约束 "${tm.id}" 的 source 为空`, 'derivable.timing', tm.id));
  }
  if (!tm.target) {
    issues.push(errorIssue(`时序约束 "${tm.id}" 的 target 为空`, 'derivable.timing', tm.id));
  }
  if ((tm.type === 'deadline' || tm.type === 'timeout') && (tm.boundMs === undefined || tm.boundMs < 0)) {
    issues.push(
      errorIssue(
        `时序约束 "${tm.id}" 类型为 ${tm.type}，但 boundMs 缺失或为负`,
        'derivable.timing',
        tm.id
      )
    );
  }
}

function checkExceptionFields(ex: ExceptionPathDef, issues: CheckIssue[]): void {
  if (!ex.id) {
    issues.push(errorIssue('异常路径 id 为空', 'derivable.exceptions'));
  }
  if (!ex.name) {
    issues.push(errorIssue(`异常路径 "${ex.id}" 的 name 为空`, 'derivable.exceptions', ex.id));
  }
  if (!ex.trigger) {
    issues.push(errorIssue(`异常路径 "${ex.id}" 的 trigger 为空`, 'derivable.exceptions', ex.id));
  }
  if (!Array.isArray(ex.transitionIds) || ex.transitionIds.length === 0) {
    issues.push(
      warningIssue(
        `异常路径 "${ex.id}" 的 transitionIds 为空`,
        'derivable.exceptions',
        ex.id
      )
    );
  }
}

// ============================================================================
// ID 交叉引用
// ============================================================================

function checkCrossReferences(
  model: SourceProtocolModel,
  issues: CheckIssue[]
): void {
  const roleIds = new Set(model.metadata.roles.map((r) => r.id));
  const stateIds = new Set(model.derivable.states.map((s) => s.id));
  const transitionIds = new Set(model.derivable.transitions.map((t) => t.id));
  const actionNames = new Set(model.derivable.transitions.map((t) => t.action));

  // 状态关联的角色
  for (const s of model.derivable.states) {
    if (s.roleIds) {
      for (const roleId of s.roleIds) {
        if (!roleIds.has(roleId)) {
          issues.push(
            errorIssue(
              `状态 "${s.id}" 引用角色 "${roleId}"，但该角色未在 metadata.roles 中声明`,
              'derivable.states.roleIds',
              s.id
            )
          );
        }
      }
    }
  }

  // 转移的 from/to
  for (const t of model.derivable.transitions) {
    for (const src of t.from) {
      if (src !== '-' && !stateIds.has(src)) {
        issues.push(
          errorIssue(
            `转移 "${t.id}" 的 from "${src}" 在 states 中不存在`,
            'derivable.transitions.from',
            t.id
          )
        );
      }
    }
    if (t.to && !stateIds.has(t.to)) {
      issues.push(
        errorIssue(
          `转移 "${t.id}" 的 to "${t.to}" 在 states 中不存在`,
          'derivable.transitions.to',
          t.id
        )
      );
    }
    if (t.triggerRoleId && !roleIds.has(t.triggerRoleId)) {
      issues.push(
        errorIssue(
          `转移 "${t.id}" 的 triggerRoleId "${t.triggerRoleId}" 在 roles 中不存在`,
          'derivable.transitions.triggerRoleId',
          t.id
        )
      );
    }
  }

  // 不变量作用状态
  for (const inv of model.derivable.invariants) {
    if (inv.scopeStateIds) {
      for (const sid of inv.scopeStateIds) {
        if (!stateIds.has(sid)) {
          issues.push(
            errorIssue(
              `不变量 "${inv.id}" 作用状态 "${sid}" 在 states 中不存在`,
              'derivable.invariants.scopeStateIds',
              inv.id
            )
          );
        }
      }
    }
  }

  // 时序约束 source/target（可以是动作名或状态 ID）
  for (const tm of model.derivable.timing) {
    if (tm.source && !stateIds.has(tm.source) && !actionNames.has(tm.source)) {
      issues.push(
        warningIssue(
          `时序约束 "${tm.id}" 的 source "${tm.source}" 既非状态 ID 也非动作名`,
          'derivable.timing.source',
          tm.id
        )
      );
    }
    if (tm.target && !stateIds.has(tm.target) && !actionNames.has(tm.target)) {
      issues.push(
        warningIssue(
          `时序约束 "${tm.id}" 的 target "${tm.target}" 既非状态 ID 也非动作名`,
          'derivable.timing.target',
          tm.id
        )
      );
    }
  }

  // 异常路径的转移序列
  for (const ex of model.derivable.exceptions) {
    for (const tid of ex.transitionIds) {
      if (!transitionIds.has(tid)) {
        issues.push(
          errorIssue(
            `异常路径 "${ex.id}" 引用转移 "${tid}"，但该转移未在 transitions 中声明`,
            'derivable.exceptions.transitionIds',
            ex.id
          )
        );
      }
    }
  }

  // initialStateId / terminalStateIds
  if (model.derivable.initialStateId && !stateIds.has(model.derivable.initialStateId)) {
    issues.push(
      errorIssue(
        `initialStateId "${model.derivable.initialStateId}" 在 states 中不存在`,
        'derivable.initialStateId'
      )
    );
  }
  for (const tid of model.derivable.terminalStateIds) {
    if (!stateIds.has(tid)) {
      issues.push(
        errorIssue(
          `terminalStateId "${tid}" 在 states 中不存在`,
          'derivable.terminalStateIds'
        )
      );
    }
  }

  // 契约层 parties 引用
  if (model.contractInput) {
    for (const party of model.contractInput.parties) {
      if (!roleIds.has(party)) {
        issues.push(
          errorIssue(
            `契约层 party "${party}" 在 metadata.roles 中不存在`,
            'contractInput.parties'
          )
        );
      }
    }
  }
}

// ============================================================================
// 扩展校验规则（决策8 扩展段启用后）
// ============================================================================

/**
 * 7 条扩展校验规则（仅当对应扩展段启用时检查；未启用则跳过）：
 * R1: scheduled 时序 → triggerType=system（推演层 scheduled 必须由系统触发）
 * R2: 不变量 declaredBy 必须引用 roleType='consensus' 的角色
 * R3: actionType='attribute_update' → affectsDimensions 必须非空
 * R4: continuous 时序 → onViolation 必须声明
 * R5: scheduled 时序 → schedule 必须声明
 * R6: triggerType='external' → trigger 必须引用已定义的 ExternalEventDef（① 阶段标记 pending，①-C 校验）
 * R7: valid_when / cascade_rules / crossInvariantIds 完整性
 */
function checkExtendedRules(
  model: SourceProtocolModel,
  issues: CheckIssue[]
): void {
  const consensusRoleIds = new Set(
    model.metadata.roles.filter((r) => r.roleType === 'consensus').map((r) => r.id)
  );
  const externalEventIds = new Set<string>();
  for (const e of model.derivable.externalEvents ?? []) {
    externalEventIds.add(e.id);
    if (e.source) externalEventIds.add(e.source);
  }

  // R1: scheduled 时序 → triggerType=system
  // scheduled 时序的 source 应为系统触发，关联转移的 triggerType 应为 system
  // 此规则校验：若 timing.type=scheduled，则同名 action 对应的转移 triggerType 应为 system
  const scheduledActions = new Set(
    model.derivable.timing
      .filter((t) => t.type === 'scheduled')
      .map((t) => t.source)
  );
  for (const t of model.derivable.transitions) {
    if (scheduledActions.has(t.action) && t.triggerType !== 'system') {
      issues.push(
        errorIssue(
          `转移 "${t.id}" 被 scheduled 时序引用（action="${t.action}"），但 triggerType="${t.triggerType}"，应为 "system"`,
          'derivable.transitions.triggerType',
          t.id
        )
      );
    }
  }

  // R2: 不变量 declaredBy 必须引用 consensus 角色
  for (const inv of model.derivable.invariants) {
    if (inv.declaredBy && !consensusRoleIds.has(inv.declaredBy)) {
      issues.push(
        errorIssue(
          `不变量 "${inv.id}" 的 declaredBy="${inv.declaredBy}" 不是 consensus 角色ID`,
          'derivable.invariants.declaredBy',
          inv.id
        )
      );
    }
  }

  // R3: actionType='attribute_update' → affectsDimensions 非空
  for (const t of model.derivable.transitions) {
    if (t.actionType === 'attribute_update' && t.affectsDimensions.length === 0) {
      issues.push(
        errorIssue(
          `转移 "${t.id}" 的 actionType="attribute_update"，但 affectsDimensions 为空（属性更新必须声明影响的维度）`,
          'derivable.transitions.affectsDimensions',
          t.id
        )
      );
    }
  }

  // R4: continuous 时序 → onViolation 必须声明
  // R5: scheduled 时序 → schedule 必须声明
  for (const tm of model.derivable.timing) {
    if (tm.type === 'continuous' && !tm.onViolation) {
      issues.push(
        errorIssue(
          `时序 "${tm.id}" 类型为 continuous，但未声明 onViolation（持续约束违约时必须有转移目标）`,
          'derivable.timing.onViolation',
          tm.id
        )
      );
    }
    if (tm.type === 'scheduled' && !tm.schedule) {
      issues.push(
        errorIssue(
          `时序 "${tm.id}" 类型为 scheduled，但未声明 schedule（定时规则必填）`,
          'derivable.timing.schedule',
          tm.id
        )
      );
    }
  }

  // R6: triggerType='external' → trigger 引用已定义的 ExternalEventDef
  // （① 阶段：若未定义 externalEvents 段则标记 pending；若已定义则校验引用存在）
  for (const t of model.derivable.transitions) {
    if (t.triggerType === 'external') {
      // externalEvents 段未启用 → 标记 pending（①-C 阶段校验，此处不报 error）
      if ((model.derivable.externalEvents ?? []).length === 0) {
        // 标记为 pending，由 pendingCrossProtocolRefs 机制处理，不在此报错
        continue;
      }
      if (t.trigger && !externalEventIds.has(t.trigger)) {
        issues.push(
          errorIssue(
            `转移 "${t.id}" 的 triggerType="external"，但 trigger="${t.trigger}" 未在 externalEvents 中定义`,
            'derivable.transitions.trigger',
            t.id
          )
        );
      }
    }
  }

  // R7: valid_when / cascade_rules / crossInvariantIds 完整性
  // R7a: 资源池 crossInvariantIds 若声明，每项须为非空字符串（结构完整性）
  for (const pool of model.derivable.resourcePools ?? []) {
    if (pool.crossInvariantIds) {
      for (const cid of pool.crossInvariantIds) {
        if (!cid || cid.trim() === '') {
          issues.push(
            errorIssue(
              `资源池 "${pool.id}" 的 crossInvariantIds 含空值`,
              'derivable.resourcePools.crossInvariantIds',
              pool.id
            )
          );
        }
      }
    }
  }
  // R7b: 附属实体 cascadeRules 须非空（附属实体的级联规则必填）
  for (const ent of model.derivable.subsidiaryEntities ?? []) {
    if (ent.cascadeRules.length === 0) {
      issues.push(
        errorIssue(
          `附属实体 "${ent.id}" 的 cascadeRules 为空（附属实体必须声明级联规则）`,
          'derivable.subsidiaryEntities.cascadeRules',
          ent.id
        )
      );
    }
  }
  // R7c: 状态维度 validWhen 若声明，须为非空字符串
  for (const s of model.derivable.states) {
    for (const dim of s.dimensions ?? []) {
      if (dim.validWhen !== undefined && dim.validWhen.trim() === '') {
        issues.push(
          errorIssue(
            `状态 "${s.id}" 的维度 "${dim.name}" 声明了 validWhen 但为空`,
            'derivable.states.dimensions.validWhen',
            s.id
          )
        );
      }
    }
  }
}

// ============================================================================
// 跨协议引用收集（① 阶段标记，①-C 阶段校验）
// ============================================================================

/**
 * 收集子协议中所有跨协议引用与组合层引用，标记为 pending 供 ①-C 阶段校验。
 *
 * 引用来源：
 * - TransitionDef.trigger 当 triggerType='external'（引用组合层 externalDependencies）
 * - ResourcePoolDef.crossInvariantIds（引用组合层 crossInvariants）
 * - SubsidiaryEntityDef.belongsTo（引用其他协议的实体，如 'entry（P2）'）
 * - InstantiationDef.crossInstanceInvariants（引用组合层 crossInvariants）
 */
function collectPendingCrossProtocolRefs(
  model: SourceProtocolModel
): PendingCrossProtocolRef[] {
  const refs: PendingCrossProtocolRef[] = [];

  // 已知内部触发者：内置系统关键字（不含角色 ID，因角色可代表外部系统）
  const internalTriggers = new Set([
    'system',
    'user',
    'client',
    'operator',
  ]);

  // 转移的 external trigger → 引用组合层
  for (const t of model.derivable.transitions) {
    // 仅当 trigger 不是内部触发者时，挂起为 cross-protocol ref
    if (t.triggerType === 'external' && t.trigger && !internalTriggers.has(t.trigger)) {
      refs.push({
        sourceField: 'TransitionDef.trigger',
        targetRef: t.trigger,
        refType: 'composition',
      });
    }
  }

  // 资源池 crossInvariantIds → 引用组合层 crossInvariants
  for (const pool of model.derivable.resourcePools ?? []) {
    for (const cid of pool.crossInvariantIds ?? []) {
      refs.push({
        sourceField: 'ResourcePoolDef.crossInvariantIds',
        targetRef: cid,
        refType: 'composition',
      });
    }
  }

  // 附属实体 belongsTo → 跨协议引用（格式如 'entry（P2）'）
  for (const ent of model.derivable.subsidiaryEntities ?? []) {
    if (ent.belongsTo) {
      // 检测是否为跨协议引用（含协议ID标记，如 P1/P2 或括号注明协议）
      const isCrossProtocol = /P\d|[（(][^)）]*[)）]/.test(ent.belongsTo);
      if (isCrossProtocol) {
        refs.push({
          sourceField: 'SubsidiaryEntityDef.belongsTo',
          targetRef: ent.belongsTo,
          refType: 'cross_protocol',
        });
      }
    }
  }

  // 实例化 crossInstanceInvariants → 引用组合层 crossInvariants
  const inst = model.derivable.instantiation;
  if (inst) {
    for (const cid of inst.crossInstanceInvariants) {
      refs.push({
        sourceField: 'InstantiationDef.crossInstanceInvariants',
        targetRef: cid,
        refType: 'composition',
      });
    }
  }

  return refs;
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

function warningIssue(
  message: string,
  elementPath?: string,
  elementId?: string
): CheckIssue {
  return { severity: 'warning', category: 'mechanical', message, elementPath, elementId };
}
