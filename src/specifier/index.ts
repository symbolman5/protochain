/**
 * 规格推导器 —— 步骤⑤（代码确定性执行，无 AI）
 *
 * 设计依据：《协议驱动自验证工具链设计方案》specifier 模块、E2 (specs.json 升级到 JSON Schema)
 *
 * E2 变更要点：
 * - 推导产物 specs 嵌入完整 JSON Schema（requestSchema/responseSchema），可被 ajv 编译
 * - guard/effects 由结构化表达式（SchemaExpression[]）承载；自然语言降级为 legacy-stub / description-only
 * - 退化模式下保留 description-only 节点，不进 schema
 * - 写出 always wraps SpecsEnvelope（schemaVersion=1.0）；envelopeMigrate 处理老格式兼容
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
  SchemaExpression,
  JSONSchema,
} from '../model/types.js';
import {
  fieldsToObjectSchema,
  tryParseGuardSchema,
  effectsToExpressions,
  stateEnumSchema,
  stateEnumCurrentSchema,
  classifySchemaKind,
  isIdentifierPredicate,
} from './schema-builder.js';
import {
  envelopeMigrate,
  SPECS_ENVELOPE_SCHEMA_VERSION,
  isSpecsEnvelope,
  specsFromEnvelope,
  type SpecsEnvelope,
} from './envelope.js';

export interface SpecifyOptions {
  /** 退化模式下是否允许 AI 辅助（由步骤执行器传入） */
  degradedAIAssist?: boolean;
}

/**
 * 推导主入口：返回 Envelope（纯 SpecsEnvelope，E2-I6 修复后不再做 duck-type）。
 *
 * E2-I6 修复（替代之前 makeEnvelopeArrayLike 的 duck-type）：
 * - 移除 `specify(model).filter(...)` 等数组方法兼容
 * - 消费方统一走 `specify(model).specs` 或 `specsFromEnvelope(specify(model))`
 * - 既有的 12 个 caller（specifier.test.ts 等）已迁移为 envelopes.specs / specsFromEnvelope
 *
 * 边界：
 * - 退化模式：specs 仍为 InterfaceSpec[]（duck-type 不再依赖）
 * - 强类型消费：返回值即 SpecsEnvelope；envelope.specs 是 InterfaceSpec[]
 */
export function specify(
  model: SourceProtocolModel,
  options: SpecifyOptions = {}
): SpecsEnvelope {
  const derivable = model.derivable;
  let specs: InterfaceSpec[];

  if (derivable.degraded) {
    specs = specifyDegraded(model, options);
  } else {
    specs = [];

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
      specs.push(deriveInvariantObservationInterface(inv));
    }

    // 4. 扩展系统接口：attribute_update
    for (const t of derivable.transitions) {
      if (t.actionType === 'attribute_update') {
        specs.push(deriveAttributeUpdateInterface(t, derivable));
      }
    }

    // 5. 扩展观测接口：多维度状态
    for (const s of derivable.states) {
      if (s.dimensions && s.dimensions.length > 0) {
        specs.push(deriveMultiDimensionObservationInterface(s));
      }
    }

    // 6. 扩展观测接口：资源池
    for (const pool of derivable.resourcePools ?? []) {
      specs.push(deriveResourcePoolObservationInterface(pool));
    }
  }

  return {
    schemaVersion: SPECS_ENVELOPE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    sourceModelVersion: model.metadata.version,
    specs,
  };
}

/**
 * 兼容入口：返回裸 InterfaceSpec[]（供改动极小的 caller 沿用）
 *
 * 当消费方只需 InterfaceSpec 数组时可使用：
 *   const specs = specsList(model);
 * 新代码统一使用 specify() + specsFromEnvelope(env)
 */
export function specsList(model: SourceProtocolModel, options: SpecifyOptions = {}): InterfaceSpec[] {
  return specsFromEnvelope(specify(model, options));
}

/** 兼容 shell：消费方若直接拿到 InterfaceSpec[]，可统一调用此函数获得 Envelope */
export function toEnvelope(
  raw: unknown,
  fallbackSourceModelVersion: string = 'unknown'
): SpecsEnvelope {
  const { envelope } = envelopeMigrate(raw, fallbackSourceModelVersion);
  return envelope;
}

// 兼容 type 与 helper exports
export {
  envelopeMigrate,
  SPECS_ENVELOPE_SCHEMA_VERSION,
  isSpecsEnvelope,
  specsFromEnvelope,
};
export type { SpecsEnvelope };

// ============================================================================
// 系统接口推导（E2：含完整 JSON Schema）
// ============================================================================

function deriveSystemInterface(
  t: TransitionDef,
  derivable: DerivableLayer
): InterfaceSpec {
  const inputs: FieldSpec[] = [];

  // currentState 输入（注意：transition 的 from 含多种状态时仍只产生一个 currentState 字段，
  // 由 invocation 端校验 from matches currentState）
  // E2-I7 修复：currentState enum 含 `-` 占位 + 全部真实状态
  const stateEnumCurrent = stateEnumCurrentSchema(derivable.states);
  inputs.push({
    name: 'currentState',
    type: 'string',
    description: `当前状态（期望为 ${t.from.join('/')}）`,
    required: true,
  });
  const requestInputFields: FieldSpec[] = [...inputs];

  // guard 中的变量作为输入参数（E2-I2 修复）：
  // - guard 是单标识符谓词（form_valid / has_request 等自然语言谓词）→ guard params 不进 requestSchema 必填
  //   因为「谓词名」本身就是 guard 表达式，不应同时作为请求输入字段
  // - guard 是结构化表达式（`x > 0` / `count == 1 && flag` 等）→ guard params 进 requestSchema 必填
  if (t.guard && !isIdentifierPredicate(t.guard)) {
    const guardParams = extractGuardParams(t.guard);
    for (const param of guardParams) {
      const f: FieldSpec = {
        name: param,
        type: 'any',
        description: `守卫条件参数（来自 guard: ${t.guard}）`,
        required: true,
      };
      inputs.push(f);
      requestInputFields.push(f);
    }
  }

  // 输出：to 状态 + effects
  const outputs: FieldSpec[] = [
    {
      name: 'nextState',
      type: 'string',
      description: `转移后状态（${t.to}）`,
      required: true,
    },
  ];
  if (t.effects && t.effects.length > 0) {
    outputs.push({
      name: 'effects',
      type: 'string[]',
      description: `副作用：${t.effects.join('; ')}`,
    });
  }

  // ── E2：构造 JSON Schema ──
  const requestSchema: JSONSchema = fieldsToObjectSchema(requestInputFields, {
    forceRequired: ['currentState'],
  });
  // currentState 强制 string + enum（E2-I7：currentState enum 含 `-` 占位 + 全部真实状态）
  if (requestSchema.properties?.currentState) {
    requestSchema.properties.currentState = {
      ...stateEnumCurrent,
      description: `当前状态（期望 ${t.from.join('/')}，可选枚举值: ${(stateEnumCurrent.enum ?? []).join('/')}）`,
    };
  }
  // nextState 强制 string + enum（E2-I7：不含 `-`，必须是真实状态 ID）
  const responseSchema: JSONSchema = fieldsToObjectSchema(outputs, {
    forceRequired: ['nextState'],
  });
  const stateEnumNext = stateEnumSchema(derivable.states);
  if (responseSchema.properties?.nextState) {
    responseSchema.properties.nextState = {
      ...stateEnumNext,
      description: `转移后状态（期望: ${t.to}，可选枚举值: ${(stateEnumNext.enum ?? []).join('/')}）`,
    };
  }

  // ── E2：结构化前置/后置/副作用 ──
  const preconditions: SchemaExpression[] = [];
  const guardExpr = tryParseGuardSchema(t.guard);
  if (guardExpr) {
    preconditions.push(guardExpr);
  } else if (t.guard) {
    preconditions.push({ kind: 'description-only', description: t.guard });
  }
  const postconditionExpressions: SchemaExpression[] = effectsToExpressions(t.effects);
  const sideEffects: SchemaExpression[] = effectsToExpressions(t.effects);

  // ── E2：schemaKind 分类 + 降级理由 ──
  const schemaKind = classifySchemaKind({
    requestSchema,
    responseSchema,
    preconditions,
    postconditionExpressions,
    sideEffects,
  });
  const schemaDegradedReasons: string[] = [];
  if (schemaKind !== 'structured') {
    if (t.guard && !guardExpr) {
      schemaDegradedReasons.push(`guard 表达式 "${t.guard}" 未机械提取为 JSON Schema`);
    }
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
    requestSchema,
    responseSchema,
    preconditions,
    postconditionExpressions,
    sideEffects,
    schemaKind,
    schemaDegradedReasons,
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
      required: true,
    },
  ];

  if (s.facts && s.facts.length > 0) {
    outputs.push({
      name: 'facts',
      type: 'string[]',
      description: `该状态成立的事实：${s.facts.join('; ')}`,
    });
  }

  const requestSchema: JSONSchema = fieldsToObjectSchema([], {});
  const responseSchema: JSONSchema = fieldsToObjectSchema(outputs, {
    forceRequired: ['isInState'],
  });
  const preconditions: SchemaExpression[] = [];
  const postconditionExpressions: SchemaExpression[] = [];

  const schemaKind = classifySchemaKind({
    requestSchema,
    responseSchema,
    preconditions,
    postconditionExpressions,
  });

  return {
    id: `IF_OBS_STATE_${s.id}`,
    kind: 'observation',
    sourceId: s.id,
    name: `observe_${s.name}`,
    inputs: [],
    outputs,
    requestSchema,
    responseSchema,
    preconditions,
    postconditionExpressions,
    schemaKind,
  };
}

// ============================================================================
// 不变量观测接口推导
// ============================================================================

function deriveInvariantObservationInterface(inv: InvariantDef): InterfaceSpec {
  const outputs: FieldSpec[] = [
    {
      name: 'holds',
      type: 'boolean',
      description: `不变量 ${inv.name}（${inv.id}）当前是否成立`,
      required: true,
    },
  ];

  const requestSchema: JSONSchema = fieldsToObjectSchema([], {});
  const responseSchema: JSONSchema = fieldsToObjectSchema(outputs, {
    forceRequired: ['holds'],
  });
  const preconditions: SchemaExpression[] = [];
  const postconditionExpressions: SchemaExpression[] = [];

  const schemaKind = classifySchemaKind({
    requestSchema,
    responseSchema,
    preconditions,
    postconditionExpressions,
  });

  return {
    id: `IF_OBS_INV_${inv.id}`,
    kind: 'observation',
    sourceId: inv.id,
    name: `observe_${inv.id}`,
    inputs: [],
    outputs,
    invariantIds: [inv.id],
    requestSchema,
    responseSchema,
    preconditions,
    postconditionExpressions,
    schemaKind,
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

  for (const t of derivable.transitions) {
    const spec = deriveSystemInterface(t, derivable);
    if (options.degradedAIAssist) spec.degradedAssist = true;
    // 退化模式下，默认标 description-only（model 来源未必可靠）
    spec.schemaKind = 'description-only';
    spec.schemaDegradedReasons = ['退化模式：仅作 description-only 投影，不进 schema'];
    specs.push(spec);
  }
  for (const s of derivable.states) {
    const spec = deriveStateObservationInterface(s);
    if (options.degradedAIAssist) spec.degradedAssist = true;
    spec.schemaKind = 'description-only';
    spec.schemaDegradedReasons = ['退化模式：仅作 description-only 投影'];
    specs.push(spec);
  }
  for (const inv of derivable.invariants) {
    const spec = deriveInvariantObservationInterface(inv);
    if (options.degradedAIAssist) spec.degradedAssist = true;
    spec.schemaKind = 'description-only';
    spec.schemaDegradedReasons = ['退化模式：仅作 description-only 投影'];
    specs.push(spec);
  }

  // 退化模式特有：若 formalSpecRaw 中存在 TLA+ ACTIONS，尝试提取
  if (derivable.formalLanguage === 'tla' && derivable.formalSpecRaw) {
    const tlaActions = extractTLAActions(derivable.formalSpecRaw);
    for (const action of tlaActions) {
      if (!specs.some((s) => s.name === action)) {
        const out: InterfaceSpec = {
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
        };
        out.requestSchema = fieldsToObjectSchema(out.inputs, { forceRequired: ['currentState'] });
        out.responseSchema = fieldsToObjectSchema(out.outputs, { forceRequired: ['nextState'] });
        out.schemaKind = 'description-only';
        out.schemaDegradedReasons = ['退化模式：从 TLA+ ACTIONS 中提取的接口，仅作 description-only'];
        specs.push(out);
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
// 扩展推导
// ============================================================================

function deriveAttributeUpdateInterface(
  t: TransitionDef,
  derivable: DerivableLayer
): InterfaceSpec {
  const inputs: FieldSpec[] = [
    { name: 'currentState', type: 'string', description: `当前状态（${t.from.join('/')}）`, required: true },
  ];

  if (t.affectsDimensions && t.affectsDimensions.length > 0) {
    for (const dim of t.affectsDimensions) {
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

  const outputs: FieldSpec[] = [
    { name: 'updatedDimensions', type: 'string[]', description: `更新的维度：${(t.affectsDimensions ?? []).join(', ')}` },
  ];

  const requestSchema: JSONSchema = fieldsToObjectSchema(inputs, {
    forceRequired: ['currentState', ...(t.affectsDimensions ?? [])],
  });
  const responseSchema: JSONSchema = fieldsToObjectSchema(outputs, {});
  const preconditions: SchemaExpression[] = [];
  if (t.guard) {
    const guardExpr = tryParseGuardSchema(t.guard);
    if (guardExpr) preconditions.push(guardExpr);
    else preconditions.push({ kind: 'description-only', description: t.guard });
  }
  const postconditionExpressions: SchemaExpression[] = effectsToExpressions(t.effects);
  const sideEffects: SchemaExpression[] = effectsToExpressions(t.effects);

  const schemaKind = classifySchemaKind({
    requestSchema,
    responseSchema,
    preconditions,
    postconditionExpressions,
    sideEffects,
  });

  return {
    id: `IF_SYS_ATTR_${t.id}`,
    kind: 'system',
    sourceId: t.action,
    name: t.action,
    inputs,
    outputs,
    precondition: t.guard,
    postconditions: t.effects,
    actionType: 'attribute_update',
    affectsDimensions: t.affectsDimensions,
    requestSchema,
    responseSchema,
    preconditions,
    postconditionExpressions,
    sideEffects,
    schemaKind,
  };
}

function deriveMultiDimensionObservationInterface(s: StateDef): InterfaceSpec {
  const outputs: FieldSpec[] = [
    { name: 'isInState', type: 'boolean', description: `是否处于 ${s.name}（${s.id}）`, required: true },
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

  const requestSchema: JSONSchema = fieldsToObjectSchema([], {});
  const responseSchema: JSONSchema = fieldsToObjectSchema(outputs, {
    forceRequired: ['isInState'],
  });
  const preconditions: SchemaExpression[] = [];
  const postconditionExpressions: SchemaExpression[] = [];

  const schemaKind = classifySchemaKind({
    requestSchema,
    responseSchema,
    preconditions,
    postconditionExpressions,
  });

  return {
    id: `IF_OBS_MULTI_${s.id}`,
    kind: 'observation',
    sourceId: s.id,
    name: `observe_${s.name}_multidim`,
    inputs: [],
    outputs,
    requestSchema,
    responseSchema,
    preconditions,
    postconditionExpressions,
    schemaKind,
  };
}

function deriveResourcePoolObservationInterface(pool: ResourcePoolDef): InterfaceSpec {
  const outputs: FieldSpec[] = [
    { name: 'available', type: 'boolean', description: `资源池 ${pool.name} 当前是否可用`, required: true },
    { name: 'capacity', type: 'string', description: `容量：${pool.capacity}` },
    { name: 'allocationRule', type: 'string', description: `分配规则：${pool.allocationRule}` },
  ];

  const requestSchema: JSONSchema = fieldsToObjectSchema([], {});
  const responseSchema: JSONSchema = fieldsToObjectSchema(outputs, {
    forceRequired: ['available'],
  });
  const preconditions: SchemaExpression[] = [];
  const postconditionExpressions: SchemaExpression[] = [];

  const schemaKind = classifySchemaKind({
    requestSchema,
    responseSchema,
    preconditions,
    postconditionExpressions,
  });

  return {
    id: `IF_OBS_POOL_${pool.id}`,
    kind: 'observation',
    sourceId: pool.id,
    name: `observe_pool_${pool.name}`,
    observesResourcePoolId: pool.id,
    inputs: [],
    outputs,
    requestSchema,
    responseSchema,
    preconditions,
    postconditionExpressions,
    schemaKind,
  };
}

// ============================================================================
// 兼容导出
// ============================================================================

// E2 起 specify() 返回 SpecsEnvelope；保留旧的 InterfaceSpec[] 入参接口供 verifier 等用例调用
// （caller 仍可使用 specify().specs 或经 specsFromEnvelope 提取）
