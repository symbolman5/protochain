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
  ContractLayerInput,
  ContractEntry,
  ErrorResponseDef,
  JSONSchema,
  RelationAssertion,
  RelationAssertionKind,
  InterfaceSpec,
  InterfaceType,
  ProjectInterfaceDetailData,
} from '../model/types.js';
import { decomposeStateMachines } from '../model/state-machines.js';
import { KIND_RULES } from './kind-rules.js';
import { buildRelations, type RelationKind, type RelationProjectionEntry } from '../webgen/relations.js';
import { tryParseGuardSchema } from '../specifier/schema-builder.js';
import { extractPredicateFieldRefs } from '../specifier/predicates.js';
import { specify } from '../specifier/index.js';
import Ajv from 'ajv';

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
  // 5. E2.1：契约层 contracts[] schema 自检（ajv 编译）
  // ----------------------------------------------------------------------
  checkContractSchemas(model, referenceIssues);

  // ----------------------------------------------------------------------
  // 5b. E11：错误契约一致性校验（唯一性 / 命名 / 异常路径↔契约闭合 / 5xx warning）
  // ----------------------------------------------------------------------
  checkErrorContracts(model, fieldIssues, referenceIssues);

  // ----------------------------------------------------------------------
  // 5c. W1-b：关系断言规则模块（TC2；断言 vs buildRelations 机械投影比对，硬失败）
  // ----------------------------------------------------------------------
  checkRelationAssertions(model, referenceIssues);

  // ----------------------------------------------------------------------
  // 5d. W2：guard schema 自检（TC5；ajv 编译 / 跨字段引用闭合 / invariant 引用存在性）
  // ----------------------------------------------------------------------
  checkGuardSchemaSelfCheck(model, referenceIssues);

  // ----------------------------------------------------------------------
  // 5e. TI4 (C-5)：分型交叉校验 + schema 完整度断言（10 §3-2 / §4 C-5）
  //   - Rule 1 分型一致性（声明 vs 机械可推导）；权威方向 = 契约声明
  //   - Rule 2 schema 完整度（防两层漂移；最小可测版）
  //   - Rule 3 报错分层（引用完整优先，引用不完整则跳过分型交叉校验）
  // ----------------------------------------------------------------------
  checkTypingCrossValidation(model, referenceIssues, fieldIssues, structuralIssues);

  // ----------------------------------------------------------------------
  // 5f. R-KIND-1~9 维度 kind 机械检查规则组（X2 / M10 / X3 / P1-3 判据10 / X7 / X8 / X9 / X17）
  //   规则注册表见 src/checker/kind-rules.ts（沿用 mcheck/rules.ts 组织方式）：
  //   - R-KIND-1（X2）：observed 维度（含人写断言）不得有 role 接口写入 → 硬失败
  //   - R-KIND-2（M10）：W(dim) 混合 / 断言与推导冲突 → 硬失败
  //   - R-KIND-3（X3）：不变量涉及 observed 维度却标 always/缺 boundMs → 硬失败
  //   - R-KIND-4（X7 分支①）：角色无任何接口以它触发 → 告警
  //   - R-KIND-5（X7 分支②）：无触发接口的完全可控组件 → 建议降级实体 → 告警
  //   - R-KIND-6（X7 分支③）：非本系统组件且无程序化交互 → 建议移出模型 → 告警
  //   - R-KIND-7（X8）：未声明状态变更（affectsDimensions 为空）⇒ ③候选 → 告警 + 留痕
  //   - R-KIND-8（X9）：跨 ≥2 实体未声明事务边界 → 新模型硬失败 / 老模型告警（截止 2026-09-30）
  //   - R-KIND-9（X17）：guard 可执行化覆盖率统计 + 未命中显式降级 → 告警
  //   - R-KIND-10（X18）：组件映射段交叉一致 —— 映射表出现的 interface/dimension
  //     必须在 IR 存在（悬空引用 → 硬失败）；IR 未被映射者显式列出（不静默遗漏）→ 告警
  //   - R-KIND-11（X13）：凭证声明完整性 —— 七列 / selfContained 枚举 / name 唯一 / 角色引用闭合
  //   - R-KIND-12~15（V1）：关系段（language.md §2 五种关系）—— onGone 非空 / type 枚举 /
  //     端点存在（状态 ID ∪ 附属实体 ID ∪ 维度名）/ 依赖图无环（绑定/派生/组合/运行依赖）
  //   R-KIND-1~3 与 R-KIND-8（新模型口径）、R-KIND-10（引用悬空侧）、R-KIND-11、
  //   R-KIND-12~15 为 error 级（机械 passed=false）；R-KIND-4~7、R-KIND-8（老模型口径）、
  //   R-KIND-9、R-KIND-10（未映射列出侧）为 warning（不阻断）。
  // ----------------------------------------------------------------------
  checkKindRules(model, referenceIssues);

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

  // 初始状态：每个状态机（连通分量）内必须存在且唯一。
  // 多实体协议（聚合 + 附属实体）允许每台子状态机各有入口 initial（如 P7 US1/PS1/PI1）；
  // 同一状态机内多 initial、或无入口的孤儿组件（既无 initial 也无创建转移目标）仍是建模错误。
  const initialStates = derivable.states.filter((s) => s.type === 'initial');
  if (initialStates.length === 0) {
    issues.push(
      errorIssue('缺少初始状态（type=initial 的状态）', 'derivable.states')
    );
  } else {
    const { main, subMachines, orphanComponents } = decomposeStateMachines(
      derivable.states,
      derivable.transitions,
      derivable.initialStateId
    );
    for (const machine of [main, ...subMachines, ...orphanComponents]) {
      if (!machine) continue;
      const initials = machine.states.filter((s) => s.type === 'initial');
      if (initials.length > 1) {
        issues.push(
          errorIssue(
            `存在 ${initials.length} 个初始状态，同一状态机内初始状态必须唯一`,
            'derivable.states',
            initials[0].id
          )
        );
      }
    }
    for (const orphan of orphanComponents) {
      issues.push(
        errorIssue(
          `存在无入口状态（既无初始状态也无创建转移可达）：${orphan.states.map((s) => s.id).join(', ')}`,
          'derivable.states',
          orphan.states[0]?.id
        )
      );
    }
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
// E2.1：契约层 contracts[] schema 自检（ajv 编译）
// ============================================================================

/**
 * 校验契约层 contracts[] 中每条 requestSchema / responseSchema 是否可被 ajv 编译。
 * - 触发条件：model.contractInput?.contracts 非空
 * - 失败：在 referenceIssues 推 errorIssue（schema 不可编译）
 * - 成功：issues 不变
 *
 * 注：ajv 自检是「schema 是否合法」的最强信号；contract 引用 transition.action 但
 * action 不存在另由 ID 交叉引用段负责（不重复）。
 */
function checkContractSchemas(
  model: SourceProtocolModel,
  issues: CheckIssue[]
): void {
  const contractInput: ContractLayerInput | undefined = model.contractInput;
  const contracts = contractInput?.contracts;
  if (!contracts || contracts.length === 0) return;

  const ajv = new Ajv({ allErrors: true, strict: false });

  for (let i = 0; i < contracts.length; i++) {
    const c = contracts[i];
    if (c.requestSchema) {
      compileOrReport(ajv, c.requestSchema, `contracts[${i}].requestSchema`, c.interface, issues);
    }
    if (c.responseSchema) {
      compileOrReport(ajv, c.responseSchema, `contracts[${i}].responseSchema`, c.interface, issues);
    }
    if (c.preconditions) {
      checkExpressionSchemas(ajv, c.preconditions, `contracts[${i}].preconditions`, c.interface, issues);
    }
    if (c.postconditions) {
      checkExpressionSchemas(ajv, c.postconditions, `contracts[${i}].postconditions`, c.interface, issues);
    }
    if (c.sideEffects) {
      checkExpressionSchemas(ajv, c.sideEffects, `contracts[${i}].sideEffects`, c.interface, issues);
    }
  }
}

function compileOrReport(
  ajv: Ajv,
  schema: JSONSchema,
  path: string,
  iface: string,
  issues: CheckIssue[]
): void {
  try {
    ajv.compile(schema as object);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    issues.push(
      errorIssue(
        `契约层 contracts[${iface}] 的 ${path} 不可被 ajv 编译：${msg}`,
        `contractInput.contracts.${iface}.${path}`,
        iface
      )
    );
  }
}

function checkExpressionSchemas(
  ajv: Ajv,
  exprs: import('../model/types.js').SchemaExpression[],
  path: string,
  iface: string,
  issues: CheckIssue[]
): void {
  for (let i = 0; i < exprs.length; i++) {
    const e = exprs[i];
    if (e.kind === 'json-schema' && e.schema) {
      compileOrReport(ajv, e.schema, `${path}[${i}].schema`, iface, issues);
    }
  }
}

// ============================================================================
// 跨协议引用收集（① 阶段标记，①-C 阶段校验）
// ============================================================================

// ============================================================================
// E11：错误契约一致性校验
// ============================================================================

/**
 * E11 错误契约检查（新增，纯机械）：
 * - R-E1：协议内 errorCode 唯一（异常路径 + 契约 errorResponses 合并去重）
 * - R-E2：errorCode 命名规范 `^[a-z][a-z0-9]*(_[a-z0-9]+)*$`（snake_case）
 * - R-E3：异常路径声明的 errorCode 至少被一个契约 errorResponses 引用（否则 error）
 * - R-E4：契约引用的 errorCode 必须能在异常路径中找到（否则 error；可追溯到 EX-id）
 * - R-E5：httpStatus 5xx → warning（system_fault 不建模为业务错误）
 * 全部为纯机械检查，老协议无 errorCode 列 / 无 errorResponses 段则整段降级空跑。
 */
export function checkErrorContracts(
  model: SourceProtocolModel,
  fieldIssues: CheckIssue[],
  referenceIssues: CheckIssue[]
): void {
  const exceptions: ExceptionPathDef[] = model.derivable.exceptions ?? [];
  const contracts: ContractEntry[] = model.contractInput?.contracts ?? [];

  // 收集异常路径声明的 errorCode
  const exceptionErrorCodes: string[] = [];
  for (const ex of exceptions) {
    if (ex.errorCode) exceptionErrorCodes.push(ex.errorCode);
  }

  // 收集契约层 errorResponses 内的 errorCode
  const contractEntries: Array<{ iface: string; er: ErrorResponseDef }> = [];
  for (const c of contracts) {
    for (const er of c.errorResponses ?? []) {
      contractEntries.push({ iface: c.interface, er });
    }
  }
  const contractErrorCodes: string[] = contractEntries.map((c) => c.er.errorCode);

  // ── R-E1：错误码唯一性（每个错误码在各上下文内仅出现一次）──
  // 唯一性分别检查两个上下文：
  // - 异常路径 declarations（errorCode 字段）：同一 errorCode 在异常路径中只能声明一次
  // - 契约 errorResponses references：同一 errorCode 在契约 errorResponses 中只能引用一次
  // 注：异常路径声明 + 契约引用同一 errorCode 是合法模式（不在此处报 duplicate）
  const seenException = new Set<string>();
  const exceptionDup: string[] = [];
  for (const code of exceptionErrorCodes) {
    if (seenException.has(code)) exceptionDup.push(code);
    else seenException.add(code);
  }
  if (exceptionDup.length > 0) {
    for (const code of Array.from(new Set(exceptionDup))) {
      referenceIssues.push(
        errorIssue(
          `异常路径中错误码 "${code}" 重复声明（同一 errorCode 只能声明一次）`,
          'derivable.exceptions.errorCode',
          code
        )
      );
    }
  }

  const seenContract = new Set<string>();
  const contractDup: string[] = [];
  for (const code of contractErrorCodes) {
    if (seenContract.has(code)) contractDup.push(code);
    else seenContract.add(code);
  }
  if (contractDup.length > 0) {
    for (const code of Array.from(new Set(contractDup))) {
      referenceIssues.push(
        errorIssue(
          `契约 errorResponses 中错误码 "${code}" 重复声明（同一 errorCode 在契约中只能引用一次）`,
          'contractInput.contracts.errorResponses',
          code
        )
      );
    }
  }

  // ── R-E2：命名规范 snake_case ──
  const snakeCaseRe = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
  const allDeclared = new Set<string>();
  for (const code of exceptionErrorCodes) allDeclared.add(code);
  for (const code of contractErrorCodes) allDeclared.add(code);
  for (const code of allDeclared) {
    if (!snakeCaseRe.test(code)) {
      referenceIssues.push(
        errorIssue(
          `错误码 "${code}" 命名不符合 snake_case 规范（正则: ^[a-z][a-z0-9]*(_[a-z0-9]+)*$）`,
          'derivable.exceptions.errorCode',
          code
        )
      );
    }
  }

  // ── R-E3：异常路径声明的每个 errorCode 必须被至少一个契约引用 ──
  const referencedCodes = new Set(contractErrorCodes);
  for (const code of Array.from(new Set(exceptionErrorCodes))) {
    if (!referencedCodes.has(code)) {
      referenceIssues.push(
        errorIssue(
          `异常路径声明的错误码 "${code}" 未在契约层 contracts[].errorResponses 引用（缺少契约覆盖）`,
          'derivable.exceptions.errorCode',
          code
        )
      );
    }
  }

  // ── R-E4：契约引用的 errorCode 必须能在异常路径中找到 ──
  const declaredCodes = new Set(exceptionErrorCodes);
  for (const code of Array.from(new Set(contractErrorCodes))) {
    if (!declaredCodes.has(code)) {
      referenceIssues.push(
        errorIssue(
          `契约层 contracts[].errorResponses 引用了协议未声明的错误码 "${code}"（异常路径缺失 errorCode）`,
          'contractInput.contracts.errorResponses',
          code
        )
      );
    }
  }

  // ── R-E5：httpStatus 5xx warning（system_fault 不建模为业务错误）──
  for (const e of contractEntries) {
    if (e.er.httpStatus >= 500) {
      fieldIssues.push(
        warningIssue(
          `契约 ${e.iface} 的 errorResponses[${e.er.id}] httpStatus=${e.er.httpStatus} 属 5xx；5xx 是系统故障（system_fault），不应建模为业务错误`,
          `contractInput.contracts.${e.iface}.errorResponses`,
          e.er.errorCode
        )
      );
    }
  }

  // ── R-E6：契约 interface 无匹配系统接口 → warning（008-5；非 error，防阻断）──
  // 背景：specifier 按 transition.id / transition.action 匹配 contract.interface（或 sourceId）投影 errorResponses；
  // 未匹配契约的 errorResponses 会被静默丢弃（specs.json 不含 → errorMap 缺口）。
  // specifier 已派生承载接口 IF_CTR_<iface>（kind=system，isContractCarrier=true）补投影，
  // 此处加 warning 让模型作者知道：「该契约无对应 transition，请审视是否需要补系统接口或归并」。
  // 形态：warning（非 error），防阻断已有协议；信息集中暴露便于后续整改。
  const transitionNames = new Set<string>();
  for (const t of model.derivable.transitions) {
    if (t.id) transitionNames.add(t.id);
    if (t.action) transitionNames.add(t.action);
  }
  const seenIface = new Set<string>();
  for (const c of contracts) {
    if (!c.interface || seenIface.has(c.interface)) continue;
    seenIface.add(c.interface);
    // 命中判定：契约 interface 名 或 显式 sourceId 任一被 transition 消费即视为对齐
    if (transitionNames.has(c.interface)) continue;
    if (c.sourceId && transitionNames.has(c.sourceId)) continue;
    // 该契约无任何 transition 消费 → warning
    const erCodes = (c.errorResponses ?? []).map((er) => er.errorCode);
    const codesText = erCodes.length > 0 ? `（涉及错误码：${erCodes.join(', ')}）` : '';
    fieldIssues.push(
      warningIssue(
        `契约 interface "${c.interface}" 未匹配任何 transition.id/action；specifier 已派生承载接口（IF_CTR_*）补 errorResponses 投影，请审视是否需要在 model.md 增加对应系统接口${codesText}`,
        `contractInput.contracts.${c.interface}`,
        c.interface
      )
    );
  }
}

// ============================================================================
// W1-b 关系断言规则模块（07-execution-T3 TC2）
// ============================================================================

/**
 * 断言 → 投影 kind → 比对口径映射表（01-relations-modeling.md §3 W1-b NR1-2 定案，随模块交付）。
 * 规则模块只做机械比对（复用 T2 buildRelations 投影，不建第二事实源），零 AI 判断。
 */
export const RELATION_ASSERTION_RULES: ReadonlyArray<{
  kind: RelationAssertionKind;
  /** 比对的投影 kind */
  projectionKind: RelationKind;
  /** 比对口径（通过条件）：断言 (a,b) 在投影条目上成立 */
  matches: (entry: RelationProjectionEntry, a: string, b: string) => boolean;
  /** 人读口径说明（用于不一致错误消息） */
  describe: (a: string, b: string) => string;
}> = [
  {
    // depends_on a b：b 前置 a → sequence 投影存在 fromId=b、toId=a 条目
    kind: 'depends_on',
    projectionKind: 'sequence',
    matches: (e, a, b) => e.kind === 'sequence' && e.fromId === b && e.toId === a,
    describe: (a, b) =>
      `depends_on ${a} ${b} 声明「${b} 前置 ${a}」，但 relations 投影中不存在 sequence(fromId=${b}, toId=${a}) 条目（${b} 的 to 态 ∩ ${a} 的 from 态 无衔接）`,
  },
  {
    // sequence a b：a 先于 b → sequence 投影存在 fromId=a、toId=b 条目
    kind: 'sequence',
    projectionKind: 'sequence',
    matches: (e, a, b) => e.kind === 'sequence' && e.fromId === a && e.toId === b,
    describe: (a, b) =>
      `sequence ${a} ${b} 声明「${a} 先于 ${b}」，但 relations 投影中不存在 sequence(fromId=${a}, toId=${b}) 条目`,
  },
  {
    // shares_invariant a b：a、b 共享不变量 → invariant_scope 投影存在 scopeStateIds ⊇ {a, b} 条目
    kind: 'shares_invariant',
    projectionKind: 'invariant_scope',
    matches: (e, a, b) =>
      e.kind === 'invariant_scope' &&
      Array.isArray(e.scopeStateIds) &&
      e.scopeStateIds.includes(a) &&
      e.scopeStateIds.includes(b),
    describe: (a, b) =>
      `shares_invariant ${a} ${b} 声明「${a}、${b} 共享不变量」，但 relations 投影中不存在覆盖集合 ⊇ {${a}, ${b}} 的 invariant_scope 条目`,
  },
];

/**
 * 关系断言规则模块：断言 vs buildRelations 机械投影比对（W1-b / TC2）。
 *
 * - 比对对象 = buildRelations(model)（直接调用 T2 纯函数，红线 1：不建第二投影/第二事实源）；
 * - 断言引用不存在的转移/状态 ID → 硬错误（引用闭合，parser 不负责、此处收口）；
 * - 断言与投影不一致 → 硬错误（非 warning），check 不通过——与 invariant 失败同纪律；
 * - 无断言段（老 model.md）→ 零输出（既有 checker 测试全绿，零回归）。
 */
export function checkRelationAssertions(
  model: SourceProtocolModel,
  issues: CheckIssue[]
): void {
  const assertions = model.relationAssertions;
  if (!assertions || assertions.length === 0) return;

  // 复用 T2 buildRelations 机械投影（单一事实源）
  const projections = buildRelations(model);

  const transitionIds = new Set(model.derivable.transitions.map((t) => t.id));
  const stateIds = new Set(model.derivable.states.map((s) => s.id));

  for (const as of assertions) {
    // ── 引用闭合（depends_on/sequence → 转移 ID；shares_invariant → 状态 ID）──
    const elementsAreStates = as.kind === 'shares_invariant';
    const universe = elementsAreStates ? stateIds : transitionIds;
    const elementLabel = elementsAreStates ? '状态' : '转移';
    const closureFailed = [as.a, as.b].some((ref) => !universe.has(ref));
    if (closureFailed) {
      for (const ref of [as.a, as.b]) {
        if (!universe.has(ref)) {
          issues.push(
            errorIssue(
              `关系断言 "${as.id}"（${as.kind} ${as.a} ${as.b}）引用的${elementLabel} ID "${ref}" 在模型中不存在`,
              'derivable.relationAssertions',
              as.id
            )
          );
        }
      }
      continue; // 引用闭合失败时不重复比对（投影比对必然不成立）
    }

    // ── 断言 vs 投影比对（映射表机械执行）──
    const rule = RELATION_ASSERTION_RULES.find((r) => r.kind === as.kind);
    if (!rule) {
      // parser 已按白名单拒绝未知种类（硬错误在前置层）；此处防御性兜底
      issues.push(
        errorIssue(
          `关系断言 "${as.id}" 的种类 "${as.kind}" 不在映射表（无机械校验对象，拒绝解析语义应在 parser 层拦截）`,
          'derivable.relationAssertions',
          as.id
        )
      );
      continue;
    }
    const ok = projections.entries.some((e) => rule.matches(e, as.a, as.b));
    if (!ok) {
      issues.push(
        errorIssue(`关系断言 "${as.id}"：${rule.describe(as.a, as.b)}`, 'derivable.relationAssertions', as.id)
      );
    }
  }
}

// ============================================================================
// W2 guard schema 自检（07-execution-T3 TC5）
// ============================================================================

/**
 * 收集模型中"已声明字段"命名空间（跨字段引用闭合的判定域）：
 * - 状态维度（StateDef.dimensions[].name）
 * - 属性效果字段（TransitionDef.attributeEffects[].field）
 * - 影响维度（TransitionDef.affectsDimensions）
 * - 契约层 requestSchema/responseSchema 的 properties 键
 * guard 谓词引用的字段必须在此命名空间内，否则视为引用不存在的字段（硬错误）。
 */
function collectModelFieldNames(model: SourceProtocolModel): Set<string> {
  const names = new Set<string>();
  for (const s of model.derivable.states) {
    for (const d of s.dimensions ?? []) {
      if (d.name) names.add(d.name);
    }
  }
  for (const t of model.derivable.transitions) {
    for (const e of t.attributeEffects ?? []) {
      if (e.field) names.add(e.field);
    }
    for (const dim of t.affectsDimensions ?? []) {
      if (dim) names.add(dim);
    }
  }
  for (const c of model.contractInput?.contracts ?? []) {
    for (const sch of [c.requestSchema, c.responseSchema]) {
      if (sch?.properties) {
        for (const k of Object.keys(sch.properties)) names.add(k);
      }
    }
  }
  return names;
}

/**
 * 从 guard 文本中机械提取 invariant(INVn) 引用（R2-3 挂载语义的引用侧）。
 * 不做自然语言模式匹配：仅命中受限谓词 `invariant(INVn)` 语法。
 */
function extractInvariantRefsFromGuard(guard: string): string[] {
  const out: string[] = [];
  const re = /invariant\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(guard)) !== null) {
    out.push(m[1]);
  }
  return out;
}

/**
 * W2 guard schema 机械自检（TC5 / 02 §3 W2-b）：
 * - 所有 kind='json-schema' 的 guard 表达式必须可被 ajv 编译（编译失败 → 硬错误；
 *   如 matchesPattern 携带非法正则）；
 * - 跨字段引用闭合：谓词引用的字段必须在模型已声明字段命名空间内（引用不存在字段 → 硬错误）；
 * - invariant(INVn) 引用存在性：引用的不变量必须已声明（不存在 → 硬错误）。
 *
 * 复用 tryParseGuardSchema（specifier 同一纯函数）——单一事实源，与 specifier 判定一致。
 * 老模型（无谓词命中 guard）→ 零输出。
 */
export function checkGuardSchemaSelfCheck(
  model: SourceProtocolModel,
  issues: CheckIssue[]
): void {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const invariantIds = new Set(model.derivable.invariants.map((i) => i.id));
  const fieldUniverse = collectModelFieldNames(model);

  for (const t of model.derivable.transitions) {
    if (!t.guard) continue;
    const trimmed = t.guard.trim();

    // ① ajv 编译自检（json-schema 表达式必须可编译）
    const expr = tryParseGuardSchema(trimmed);
    if (expr?.kind === 'json-schema' && expr.schema) {
      try {
        ajv.compile(expr.schema as object);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        issues.push(
          errorIssue(
            `转移 "${t.id}" 的 guard "${t.guard}" 生成的 JSON Schema 不可被 ajv 编译：${msg}`,
            'derivable.transitions.guard',
            t.id
          )
        );
      }
    }

    // ② 跨字段引用闭合（谓词引用字段必须存在）
    for (const field of extractPredicateFieldRefs(trimmed)) {
      if (!fieldUniverse.has(field)) {
        issues.push(
          errorIssue(
            `转移 "${t.id}" 的 guard "${t.guard}" 引用字段 "${field}"，但该字段未在模型中声明（状态维度 / attributeEffects / affectsDimensions / 契约 schema）`,
            'derivable.transitions.guard',
            t.id
          )
        );
      }
    }

    // ③ invariant(INVn) 引用存在性
    for (const invId of extractInvariantRefsFromGuard(trimmed)) {
      if (!invariantIds.has(invId)) {
        issues.push(
          errorIssue(
            `转移 "${t.id}" 的 guard "${t.guard}" 引用不变量 "${invId}"，但该不变量未在 invariants 中声明`,
            'derivable.transitions.guard',
            t.id
          )
        );
      }
    }
  }
}

// ============================================================================
// 5e. TI4 (C-5)：分型交叉校验 + schema 完整度断言（10 §3-2 / §4 C-5）
// ============================================================================

/**
 * TI4 机械可推导分型（与 TI3 投影兜底一致，10 §3-2 三值映射表）。
 * 给定 InterfaceSpec，按以下顺序推导：
 * - kind === 'observation' 或 observesResourcePoolId != null → 'observation'
 * - isContractCarrier === true → 'contract_carrier'
 * - 否则 → 'state_machine'
 *
 * 权威方向（10 §3-2 IR-7）：契约声明（declaredInterfaceType）为权威，
 * 本函数仅为校验基准（机械派生），不得反向约束声明。
 */
function computeMechanicalInterfaceType(spec: InterfaceSpec): InterfaceType {
  if (spec.kind === 'observation' || spec.observesResourcePoolId != null) {
    return 'observation';
  }
  if (spec.isContractCarrier === true) {
    return 'contract_carrier';
  }
  return 'state_machine';
}

/**
 * TI4 (C-5) 入口：分型"契约声明 vs 机械可推导"交叉校验 + schema 完整度断言。
 *
 * 触发条件：model.contractInput.contracts 中至少有一条声明了 interfaceType（C-4 可选扩展）。
 * 老模型（无 interfaceType 声明）→ 整段跳过（零回归，10 §3-2「老模型零回归」）。
 *
 * 报错分层（Rule 3 / 10 §3-2 R2-7）：仅当该契约的 interface/sourceId 引用完整性通过
 * （指向已存在的 transition，或该 spec 为观测接口不引用 transition）时才比对分型；
 * 引用不完整的 orphan 契约由既有 R-E6 报 warning，此处跳过分型交叉校验避免双重报告。
 */
function checkTypingCrossValidation(
  model: SourceProtocolModel,
  referenceIssues: CheckIssue[],
  fieldIssues: CheckIssue[],
  _structuralIssues: CheckIssue[]
): void {
  const contracts = model.contractInput?.contracts;
  if (!contracts || contracts.length === 0) return;

  // 无任何分型声明 → 无交叉校验基准，整段跳过（老模型零回归）
  const hasDeclaration = contracts.some((c) => c.interfaceType != null);
  if (!hasDeclaration) return;

  // 投影 specs：获取 declaredInterfaceType 与机械派生字段（kind / isContractCarrier / observesResourcePoolId）
  let specs: InterfaceSpec[];
  try {
    specs = specify(model).specs;
  } catch {
    // 投影失败（极少见）→ 稳妥降级，不阻断既有检查
    return;
  }

  // 引用完整性基线：transition.id / transition.action 命名空间
  const transitionRefs = new Set<string>();
  for (const t of model.derivable.transitions) {
    if (t.id) transitionRefs.add(t.id);
    if (t.action) transitionRefs.add(t.action);
  }

  for (const c of contracts) {
    if (c.interfaceType == null) continue; // 无声明 → 无比较基准

    // 找到该契约投影出的 spec（specifier 以 contractSource === c.interface 对齐）
    const spec = specs.find((s) => s.contractSource === c.interface);
    if (!spec) continue; // 该契约未投影出 spec（极少见）→ 跳过

    // ── Rule 3：报错分层（引用完整性优先）──
    const referenceComplete =
      spec.kind === 'observation' ||
      transitionRefs.has(c.interface) ||
      (c.sourceId != null && transitionRefs.has(c.sourceId));
    if (!referenceComplete) {
      // 引用不完整（R-E6 已报 orphan warning）→ 跳过分型交叉校验，避免双重报告
      continue;
    }

    // ── Rule 1：分型一致性（声明为准）──
    const mechanical = computeMechanicalInterfaceType(spec);
    if (mechanical !== c.interfaceType) {
      referenceIssues.push(
        errorIssue(
          `接口 "${c.interface}" 的分型声明 "${c.interfaceType}" 与机械可推导分型 "${mechanical}" 不一致（契约声明为权威，机械推导仅作校验基准） [TYPING_MISMATCH]`,
          `contractInput.contracts.${c.interface}.interfaceType`,
          c.interface
        )
      );
    }

    // ── Rule 2：schema 完整度（防两层漂移）──
    checkTypingSchemaDrift(spec, c, fieldIssues);
  }
}

/**
 * TI4 Rule 2：schema 完整度（防契约/模型两层漂移，10 §3-2 末 bullet）。
 *
 * 简化版（按 10 §3-2 容许）：仅对携带契约（contractSource 非空）且机械分型为
 * state_machine / contract_carrier 的接口做断言——当 requestSchema 缺省或仅为自然语言
 * description（无 type 字段，无法承载 JSON Schema）时，guard/effects 引用的状态字段
 * 无法与 requestSchema 断言存在性，报 drift warning。
 *
 * 关键：完整度判定以「契约层原始声明 requestSchema」为准，而非 spec 投影后的 requestSchema。
 * 原因：specifier 的 mergeContractRequestSchema 会把 currentState 字段自动并入，
 * 使仅含 description 的契约 requestSchema 被升级为 structured（丢失"用户仅给自然语言描述"
 * 的语义）。若以 spec.schemaKind 判定会漏报两层漂移，故此处直接看 contract.requestSchema 是否
 * 仍是真正的 JSON Schema（含 type 字段）。
 *
 * 注：完整版应遍历 guard 谓词引用的字段并逐一断言出现在 requestSchema.properties；
 * 本实现按契约采用最小可测版本，聚焦"requestSchema 为真正 JSON Schema 才做字段级断言"的前置门槛，
 * 且因本函数仅在声明了 interfaceType 的契约上触发（见 checkTypingCrossValidation），
 * 对未声明 interfaceType 的老模型零回归。
 */
function checkTypingSchemaDrift(
  spec: InterfaceSpec,
  contract: ContractEntry,
  issues: CheckIssue[]
): void {
  const mechanical = computeMechanicalInterfaceType(spec);
  if (mechanical !== 'state_machine' && mechanical !== 'contract_carrier') return;
  if (!spec.contractSource) return;

  // 以契约层原始声明 requestSchema 判定：含 type 字段即视为真正的 JSON Schema（可承载字段级断言）；
  // 缺省或仅 description（无 type）则无法校验 guard/effects 引用的状态字段 → 两层漂移风险。
  const reqSchema = contract.requestSchema;
  const reqIsStructured = reqSchema != null && (reqSchema as { type?: unknown }).type != null;
  if (!reqIsStructured) {
    issues.push(
      warningIssue(
        `接口 "${contract.interface}" 的 requestSchema 非 structured（契约层声明缺 type 字段或仅为自然语言 description），guard/effects 引用的状态字段无法与 requestSchema 断言存在性，存在契约/模型两层漂移风险 [TYPING_SCHEMA_DRIFT]`,
        `contractInput.contracts.${contract.interface}.requestSchema`,
        contract.interface
      )
    );
  }
}

// ============================================================================
// 跨协议引用收集（① 阶段标记，①-C 阶段在 composition-checker 校验）
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
// 5f. R-KIND-1~4 维度 kind 机械检查规则组（注册表执行入口）
// ============================================================================

/**
 * 遍历 KIND_RULES 注册表执行全部规则，把 issue 并入 referenceIssues。
 * 注册表定义见 src/checker/kind-rules.ts（沿用 src/mcheck/rules.ts 组织方式）。
 */
export function checkKindRules(
  model: SourceProtocolModel,
  issues: CheckIssue[]
): void {
  for (const rule of KIND_RULES) {
    issues.push(...rule.check({ model }));
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

function warningIssue(
  message: string,
  elementPath?: string,
  elementId?: string
): CheckIssue {
  return { severity: 'warning', category: 'mechanical', message, elementPath, elementId };
}

// ============================================================================
// G6（C-G6-4 / 10 §17.4 G6-1~G6-2）：interface-details 示例/代码样例断言
// ----------------------------------------------------------------------------
// 校验工具链预投影产物（interface-details.json 1.1）的示例字段，防合成漂移：
//  ① requestExample/responseExample 顶层字段集 ⊆ 对应 schema 叶子 path 集；
//  ② codeSamples 非空数组时每条 code 非空字符串；
//  ③ 老模型无 schema → 示例记 null（不硬失败）。
// 仅做查表式断言，不推导、不读 bindings；与 10 §17 红线②一致。
// ============================================================================

/** 收集 object schema 顶层叶子 key（§17.6 未决③：首版仅顶层示例） */
function topLevelLeafKeys(schema: JSONSchema | undefined): Set<string> {
  const s = schema as { type?: string; properties?: Record<string, unknown> } | undefined;
  if (s && s.type === 'object' && s.properties) return new Set(Object.keys(s.properties));
  return new Set();
}

function checkExampleSubset(
  example: unknown,
  schema: JSONSchema | undefined,
  fieldName: 'requestExample' | 'responseExample',
  protocolId: string,
  interfaceId: string,
  issues: CheckIssue[]
): void {
  // 老模型无 schema / 示例为 null → 不硬失败（G6-1③）
  if (!schema || example === null || example === undefined) return;
  const leaves = topLevelLeafKeys(schema);
  if (leaves.size === 0) return; // 非 object schema 不约束顶层字段集
  if (typeof example !== 'object' || Array.isArray(example)) {
    issues.push(
      errorIssue(
        `${fieldName} 顶层应为 object（与 schema 形态不一致）`,
        `${protocolId}/${interfaceId}.interface.${fieldName}`,
        interfaceId
      )
    );
    return;
  }
  const keys = Object.keys(example as Record<string, unknown>);
  for (const k of keys) {
    if (!leaves.has(k)) {
      issues.push(
        errorIssue(
          `${fieldName} 含 schema 外字段 "${k}"（合成漂移，应 ⊆ schema 叶子）`,
          `${protocolId}/${interfaceId}.interface.${fieldName}.${k}`,
          interfaceId
        )
      );
    }
  }
}

/**
 * G6-4 校验入口：对 interface-details.json 全部条目断言示例/代码样例。
 * @returns MechanicalCheckResult（passed=无 error 级 issue）
 */
export function checkInterfaceDetailsExamples(data: ProjectInterfaceDetailData): MechanicalCheckResult {
  const fieldIssues: CheckIssue[] = [];
  if (!data || !data.entries) {
    return { passed: true, structuralIssues: [], fieldIssues, referenceIssues: [] };
  }
  for (const [protocolId, protoEntries] of Object.entries(data.entries)) {
    for (const [interfaceId, entry] of Object.entries(protoEntries)) {
      const i = entry.interface || {};
      // G6-1：示例字段集 ⊆ schema 叶子
      checkExampleSubset(i.requestExample, i.requestSchema, 'requestExample', protocolId, interfaceId, fieldIssues);
      checkExampleSubset(i.responseExample, i.responseSchema, 'responseExample', protocolId, interfaceId, fieldIssues);
      // G6-2：codeSamples 非空数组时每条 code 非空
      if (Array.isArray(i.codeSamples)) {
        i.codeSamples.forEach((s, idx) => {
          if (!s || typeof s.code !== 'string' || s.code.length === 0) {
            fieldIssues.push(
              errorIssue(
                `codeSamples[${idx}].code 为空（G6-2 要求非空）`,
                `${protocolId}/${interfaceId}.interface.codeSamples[${idx}]`,
                interfaceId
              )
            );
          }
        });
      }
    }
  }
  return { passed: fieldIssues.length === 0, structuralIssues: [], fieldIssues, referenceIssues: [] };
}

// 规则组导出（对齐 src/mcheck/index.ts 的导出风格，供外部/CLI/测试按需 import）
export { KIND_RULES, KIND_RULE_IDS, resolveDimensionKinds } from './kind-rules.js';
export {
  ruleRKind1ObservedNoRoleWriters,
  ruleRKind2MixedWritersAndAssertionConflict,
  ruleRKind3ObservedInvariantNeedsBoundMs,
  ruleRKind4RoleWithoutTriggerInterface,
  ruleRKind5ControllableComponentSuggestEntity,
  ruleRKind6NonSystemComponentSuggestRemove,
  ruleRKind7NoStateChangeCandidate,
  ruleRKind8CrossEntityNeedsTransactionBoundary,
  ruleRKind9GuardExecutableCoverage,
  ruleRKind10ComponentMappingConsistency,
  ruleRKind11CredentialIntegrity,
  ruleRKind12RelationOnGoneRequired,
  ruleRKind13RelationTypeEnum,
  ruleRKind14RelationEndpointExists,
  ruleRKind15RelationDagAcyclic,
  computeGuardCoverage,
  buildDimensionOwnerMap,
  collectInterfaceUniverse,
  collectDimensionUniverse,
  collectRelationEndpointUniverse,
  flattenComponentMapping,
  TRANSACTION_BOUNDARY_MIGRATION_DEADLINE,
  RELATION_TYPES,
  RELATION_DEPENDENCY_TYPES,
} from './kind-rules.js';
