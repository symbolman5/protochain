/**
 * 规格推导器 —— 步骤⑤（代码确定性执行，无 AI）
 *
 * 设计依据：《协议驱动自验证工具链设计方案》specifier 模块、AI参与矩阵
 *
 * 推导规则（机械映射）：
 * - 系统接口：每个 transition 的 action → 一个系统接口
 *   - 输入：from 状态、guard 参数化（若有 guard）
 *   - 输出：to 状态、effects 字段
 *   - 前置条件：guard
 *   - 后置条件：effects
 * - 观测接口：每个状态 → 状态观测接口；每个不变量 → 不变量观测接口
 *   - 状态观测接口输出状态成立的事实
 *   - 不变量观测接口输出不变量当前是否成立
 *
 * 退化模式策略B：
 * - parser 已尽可能提取结构化元素（如 TLA+ 的 VARIABLES/下一状态谓词）
 * - 提取成功的部分由代码确定性执行
 * - 提取失败的部分降级为 AI 辅助，标注 degradedAssist=true
 */

import type {
  SourceProtocolModel,
  DerivableLayer,
  TransitionDef,
  StateDef,
  InvariantDef,
  InterfaceSpec,
  FieldSpec,
  ResourcePoolDef,
} from '../model/types.js';

export interface SpecifyOptions {
  /** 退化模式下是否允许 AI 辅助（由步骤执行器传入） */
  degradedAIAssist?: boolean;
}

export function specify(
  model: SourceProtocolModel,
  options: SpecifyOptions = {}
): InterfaceSpec[] {
  const derivable = model.derivable;
  const specs: InterfaceSpec[] = [];

  if (derivable.degraded) {
    return specifyDegraded(model, options);
  }

  // 1. 系统接口：从 transitions 推导
  for (const t of derivable.transitions) {
    specs.push(deriveSystemInterface(t, derivable));
  }

  // 2. 观测接口：从 states 推导（状态观测）
  for (const s of derivable.states) {
    specs.push(deriveStateObservationInterface(s));
  }

  // 3. 观测接口：从 invariants 推导（不变量观测）
  for (const inv of derivable.invariants) {
    specs.push(deriveInvariantObservationInterface(inv, derivable));
  }

  // 4. 扩展系统接口：attribute_update 转移 → 属性更新接口
  for (const t of derivable.transitions) {
    if (t.actionType === 'attribute_update') {
      specs.push(deriveAttributeUpdateInterface(t, derivable));
    }
  }

  // 5. 扩展观测接口：多维度状态 → 多维观测接口
  for (const s of derivable.states) {
    if (s.dimensions && s.dimensions.length > 0) {
      specs.push(deriveMultiDimensionObservationInterface(s));
    }
  }

  // 6. 扩展观测接口：资源池 → 资源可用性观测接口
  for (const pool of derivable.resourcePools ?? []) {
    specs.push(deriveResourcePoolObservationInterface(pool));
  }

  return specs;
}

// ============================================================================
// 系统接口推导
// ============================================================================

function deriveSystemInterface(
  t: TransitionDef,
  derivable: DerivableLayer
): InterfaceSpec {
  const inputs: FieldSpec[] = [];

  // 输入：from 状态 ID（作为上下文）
  inputs.push({
    name: 'currentState',
    type: 'string',
    description: `当前状态（期望为 ${t.from.join('/')}）`,
    required: true,
  });

  // guard 中的变量作为输入参数（简单解析：识别标识符）
  if (t.guard) {
    const guardParams = extractGuardParams(t.guard);
    for (const param of guardParams) {
      inputs.push({
        name: param,
        type: 'any',
        description: `守卫条件参数（来自 guard: ${t.guard}）`,
        required: true,
      });
    }
  }

  // 输出：to 状态 + effects
  const outputs: FieldSpec[] = [
    {
      name: 'nextState',
      type: 'string',
      description: `转移后状态（${t.to}）`,
    },
  ];

  if (t.effects && t.effects.length > 0) {
    outputs.push({
      name: 'effects',
      type: 'string[]',
      description: `副作用：${t.effects.join('; ')}`,
    });
  }

  return {
    id: `IF_SYS_${t.id}`,
    kind: 'system',
    sourceId: t.action,
    name: t.action,
    inputs,
    outputs,
    precondition: t.guard,
    postconditions: t.effects,
  };
}

/**
 * 从守卫条件表达式中提取参数名
 *
 * 简化规则：识别 snake_case / camelCase 标识符，排除关键字
 */
function extractGuardParams(guard: string): string[] {
  const keywords = new Set([
    'forall', 'exists', 'and', 'or', 'not', 'in', 'if', 'then', 'else',
    'true', 'false', 'null', 'undefined',
    'count', 'len', 'length', 'active_requests',
  ]);
  const identifiers = guard.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) ?? [];
  return Array.from(new Set(identifiers.filter((id) => !keywords.has(id.toLowerCase()))));
}

// ============================================================================
// 状态观测接口推导
// ============================================================================

function deriveStateObservationInterface(s: StateDef): InterfaceSpec {
  const outputs: FieldSpec[] = [
    {
      name: 'isInState',
      type: 'boolean',
      description: `当前是否处于 ${s.name}（${s.id}）状态`,
    },
  ];

  if (s.facts && s.facts.length > 0) {
    outputs.push({
      name: 'facts',
      type: 'string[]',
      description: `该状态成立的事实：${s.facts.join('; ')}`,
    });
  }

  return {
    id: `IF_OBS_STATE_${s.id}`,
    kind: 'observation',
    sourceId: s.id,
    name: `observe_${s.name}`,
    inputs: [],
    outputs,
  };
}

// ============================================================================
// 不变量观测接口推导
// ============================================================================

function deriveInvariantObservationInterface(
  inv: InvariantDef,
  derivable: DerivableLayer
): InterfaceSpec {
  return {
    id: `IF_OBS_INV_${inv.id}`,
    kind: 'observation',
    sourceId: inv.id,
    name: `observe_${inv.id}`,
    inputs: [],
    outputs: [
      {
        name: 'holds',
        type: 'boolean',
        description: `不变量 ${inv.name}（${inv.id}）当前是否成立`,
      },
    ],
    invariantIds: [inv.id],
  };
}

// ============================================================================
// 退化模式推导（策略B：尽可能确定性提取）
// ============================================================================

function specifyDegraded(
  model: SourceProtocolModel,
  options: SpecifyOptions
): InterfaceSpec[] {
  const specs: InterfaceSpec[] = [];
  const derivable = model.derivable;

  // 退化模式下：尝试从已提取的 states/transitions 推导（策略B 保留确定性部分）
  for (const t of derivable.transitions) {
    const spec = deriveSystemInterface(t, derivable);
    if (options.degradedAIAssist) {
      spec.degradedAssist = true;
    }
    specs.push(spec);
  }

  for (const s of derivable.states) {
    const spec = deriveStateObservationInterface(s);
    if (options.degradedAIAssist) {
      spec.degradedAssist = true;
    }
    specs.push(spec);
  }

  for (const inv of derivable.invariants) {
    const spec = deriveInvariantObservationInterface(inv, derivable);
    if (options.degradedAIAssist) {
      spec.degradedAssist = true;
    }
    specs.push(spec);
  }

  // 退化模式特有：若 formalSpecRaw 中存在 TLA+ 风格的 ACTIONS，尝试提取
  if (derivable.formalLanguage === 'tla' && derivable.formalSpecRaw) {
    const tlaActions = extractTLAActions(derivable.formalSpecRaw);
    for (const action of tlaActions) {
      // 仅添加未在 transitions 中出现的动作
      if (!specs.some((s) => s.name === action)) {
        specs.push({
          id: `IF_SYS_DEGRADED_${action}`,
          kind: 'system',
          sourceId: action,
          name: action,
          inputs: [
            { name: 'currentState', type: 'string', description: '当前状态', required: true },
          ],
          outputs: [
            { name: 'nextState', type: 'string', description: '转移后状态' },
          ],
          degradedAssist: true,
        });
      }
    }
  }

  return specs;
}

/**
 * 从 TLA+ 规格中提取动作名
 * 简化：识别 `ActionName ==` 或 `ActionName(state) ==` 形式
 */
function extractTLAActions(spec: string): string[] {
  const actions: string[] = [];
  // 匹配 `Identifier ==` 或 `Identifier(...) ==`，排除 Init/Next/Spec/Inv 等保留名
  const reserved = new Set(['Init', 'Next', 'Spec', 'Inv', 'Invariant', 'TypeInvariant', 'AllInvariants', 'States', 'Variables']);
  const matches = spec.matchAll(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\([^)]*\))?\s*==/gm);
  for (const m of matches) {
    const name = m[1];
    if (!reserved.has(name) && !actions.includes(name)) {
      actions.push(name);
    }
  }
  return actions;
}

// ============================================================================
// 扩展推导（P4：attribute_update 接口 / 多维观测接口 / 资源池观测接口）
// ============================================================================

/**
 * attribute_update 转移 → 属性更新系统接口。
 * 与 state_transition 不同，attribute_update 不改变状态 ID，只更新维度值。
 */
function deriveAttributeUpdateInterface(
  t: TransitionDef,
  derivable: DerivableLayer
): InterfaceSpec {
  const inputs: FieldSpec[] = [
    { name: 'currentState', type: 'string', description: `当前状态（${t.from.join('/')}）`, required: true },
  ];

  // 影响维度作为输入参数
  if (t.affectsDimensions && t.affectsDimensions.length > 0) {
    for (const dim of t.affectsDimensions) {
      // 查找维度类型
      const state = derivable.states.find((s) =>
        s.dimensions?.some((d) => d.name === dim)
      );
      const dimDef = state?.dimensions?.find((d) => d.name === dim);
      inputs.push({
        name: dim,
        type: dimDef?.type ?? 'any',
        description: `更新维度 ${dim} 的新值`,
        required: true,
      });
    }
  }

  return {
    id: `IF_SYS_ATTR_${t.id}`,
    kind: 'system',
    sourceId: t.action,
    name: t.action,
    inputs,
    outputs: [
      { name: 'updatedDimensions', type: 'string[]', description: `更新的维度：${(t.affectsDimensions ?? []).join(', ')}` },
    ],
    precondition: t.guard,
    postconditions: t.effects,
    actionType: 'attribute_update',
    affectsDimensions: t.affectsDimensions,
  };
}

/** 多维度状态 → 多维观测接口 */
function deriveMultiDimensionObservationInterface(
  s: StateDef
): InterfaceSpec {
  const outputs: FieldSpec[] = [
    { name: 'isInState', type: 'boolean', description: `是否处于 ${s.name}（${s.id}）` },
  ];

  if (s.dimensions) {
    for (const dim of s.dimensions) {
      outputs.push({
        name: dim.name,
        type: dim.type,
        description: `维度 ${dim.name} 当前值（初始: ${dim.initial}）${dim.validWhen ? `，有效条件: ${dim.validWhen}` : ''}`,
      });
    }
  }

  return {
    id: `IF_OBS_MULTI_${s.id}`,
    kind: 'observation',
    sourceId: s.id,
    name: `observe_${s.name}_multidim`,
    inputs: [],
    outputs,
  };
}

/** 资源池 → 资源可用性观测接口 */
function deriveResourcePoolObservationInterface(
  pool: ResourcePoolDef
): InterfaceSpec {
  return {
    id: `IF_OBS_POOL_${pool.id}`,
    kind: 'observation',
    sourceId: pool.id,
    name: `observe_pool_${pool.name}`,
    observesResourcePoolId: pool.id,
    inputs: [],
    outputs: [
      { name: 'available', type: 'boolean', description: `资源池 ${pool.name} 当前是否可用` },
      { name: 'capacity', type: 'string', description: `容量：${pool.capacity}` },
      { name: 'allocationRule', type: 'string', description: `分配规则：${pool.allocationRule}` },
    ],
  };
}
