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
  ContractEntry,
  // R1a：六张清单「操作」段 IR
  OperationDef,
  OperationTriggerType,
} from '../model/types.js';
import {
  fieldsToObjectSchema,
  tryParseGuardSchema,
  effectsToExpressions,
  attributeEffectsToExpressions,
  stateEnumSchema,
  stateEnumCurrentSchema,
  classifySchemaKind,
  isIdentifierPredicate,
  invariantToSchemaExpression,
} from './schema-builder.js';
import { buildDimensionKinds } from '../model/dimension-kind.js';
import { translatePredicate } from './predicates.js';
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
 * E11 后续问题 5（008-5）：契约 interface 未匹配任何系统接口时的投影策略
 * - 旧行为：契约 errorResponses 被静默丢弃（specs.json 不含），errorMap 中 22 个错误码
 *   缺失投影；根因：P3/P4 系统接口仅覆盖 disable/enable/delete 等状态机动作，契约层
 *   的 mappingCreate/domainClaim/endpointRegister 等动作无对应 transition。
 * - 新行为：对"未匹配任何 transition.id/action"的契约派生承载接口（contract-carrier），
 *   把契约 errorResponses / requestSchema / responseSchema 投影到该承载 spec；
 *   同时通过 envelope.migrationWarnings 列出缺口细节（契约名 + errorResponses 数 +
 *   涉及错误码），checker 同步新增 warning（非 error，防阻断）。
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
  // E11 后续问题 5：收集"未匹配任何 transition 的契约"详情（承载接口投影依据 + warning 来源）
  const orphanContractReports: OrphanContractReport[] = [];

  // E2.1：契约层 contracts[] → Map（degraded 模式也消费，但 schemaKind 仍 description-only）
  const contractMap = buildContractMap(model.contractInput?.contracts);

  if (derivable.degraded) {
    specs = specifyDegraded(model, options, contractMap);
    // 退化模式：契约未被 transition 消费的情况单独收集（同样视作 orphan）
    // 退化模式不强制承载接口（保持 description-only），仅记录
    const orphans = collectOrphanContracts(contractMap, derivable.transitions);
    for (const entry of orphans) {
      orphanContractReports.push({
        interface: entry.iface,
        carrierId: '(degraded: 未派生承载接口)',
        errorResponseCount: entry.contract.errorResponses?.length ?? 0,
        errorCodes: (entry.contract.errorResponses ?? []).map((er) => er.errorCode),
      });
    }
  } else {
    specs = [];

    // 1. 系统接口：从 transitions 推导（E2.1：合并契约层 contracts[] 字段）
    for (const t of derivable.transitions) {
      specs.push(deriveSystemInterface(t, derivable, contractMap));
    }

    // 1b. 系统接口：R1a 六张清单「操作」段（操作=改实体维度，无状态机轴；
    //     状态机为兼容层——老模型无操作段 → 零新增接口，零回归）
    for (const op of derivable.operations ?? []) {
      specs.push(deriveOperationInterface(op, contractMap));
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

    // 7. E11 后续问题 5：契约承载接口派生
    // - 收集 contractMap 中未被任何 transition.id/action 消费的契约
    // - 对每个 orphan contract 派生一个 IF_CTR_<iface> 形态的承载接口（kind=system）
    // - 承载接口的 requestSchema/responseSchema 来自契约层（直接采用，已对齐 ajv 可编译）
    // - 承载接口的 errorResponses 来自契约层（= 原 errorResponses 列表）
    // - 承载接口不参与状态机（sourceId 与 transition 无对应），仅作"契约投影载体"
    const orphans = collectOrphanContracts(contractMap, derivable.transitions);
    for (const entry of orphans) {
      const carrier = deriveContractCarrierInterface(entry.contract, entry.iface);
      specs.push(carrier);
      orphanContractReports.push({
        interface: entry.iface,
        carrierId: carrier.id,
        errorResponseCount: entry.contract.errorResponses?.length ?? 0,
        errorCodes: (entry.contract.errorResponses ?? []).map((er) => er.errorCode),
      });
    }
  }

  // E11 后续问题 5：把缺口清单写入 envelope.migrationWarnings（warning 语义而非 migration）
  const migrationWarnings: string[] = [];
  if (orphanContractReports.length > 0) {
    migrationWarnings.push(
      `E11 后续问题 5：检测到 ${orphanContractReports.length} 个契约 interface 未匹配任何 transition.id/action，已派生承载接口 IF_CTR_*（kind=system）；承载接口包含契约 errorResponses，建议审视是否需要在 model.md 增加对应系统接口或归并到现有 transition。`
    );
    for (const r of orphanContractReports) {
      const codes = r.errorCodes.length > 0 ? `（涉及错误码：${r.errorCodes.join(', ')}）` : '';
      migrationWarnings.push(
        `  - 契约 "${r.interface}" → 承载接口 ${r.carrierId}，errorResponses=${r.errorResponseCount}${codes}`
      );
    }
  }

  // X1（P0-1）：维度 kind 机械推导（+ parser 人写断言合并）。混合写入方 → 硬失败抛错
  // （dimension-kind-conflict，模型矛盾，不产出 kind）；空集 → 显式降级记录
  // （dimension-kind-undetermined，走 B-1 分流）。specs.json 据此带出维度 kind。
  const dimKinds = buildDimensionKinds(model.derivable);

  return {
    schemaVersion: SPECS_ENVELOPE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    sourceModelVersion: model.metadata.version,
    specs,
    migrationWarnings: migrationWarnings.length > 0 ? migrationWarnings : undefined,
    dimensions: dimKinds.entries,
    schemaDegradedReasons:
      dimKinds.schemaDegradedReasons.length > 0 ? dimKinds.schemaDegradedReasons : undefined,
  };
}

/** E11 后续问题 5：承载接口派生所需的契约 + 接口名中间结构（specify 内部用） */
interface OrphanContractReport {
  interface: string;
  carrierId: string;
  errorResponseCount: number;
  errorCodes: string[];
}

/** E11 后续问题 5：判定契约 interface 是否被某 transition 消费 */
function isContractConsumedByTransitions(
  contractInterface: string,
  transitions: TransitionDef[]
): boolean {
  for (const t of transitions) {
    if (t.id === contractInterface) return true;
    if (t.action === contractInterface) return true;
  }
  return false;
}

/**
 * E11 后续问题 5：收集"未被任何 transition 消费"的契约条目
 * - 同一契约可能既按 interface 又按 sourceId 进 map（buildContractMap 双键），去重时按
 *   contract.interface 唯一（避免对同一 contract 报两次）
 */
function collectOrphanContracts(
  contractMap: Map<string, ContractEntry>,
  transitions: TransitionDef[]
): Array<{ iface: string; contract: ContractEntry }> {
  const orphans: Array<{ iface: string; contract: ContractEntry }> = [];
  const seen = new Set<string>();
  for (const [key, contract] of contractMap.entries()) {
    // 同一 contract 可能存在 interface + sourceId 两键，仅按 interface 去重
    if (seen.has(contract.interface)) continue;
    if (isContractConsumedByTransitions(key, transitions) || isContractConsumedByTransitions(contract.interface, transitions)) {
      seen.add(contract.interface);
      continue;
    }
    seen.add(contract.interface);
    orphans.push({ iface: contract.interface, contract });
  }
  return orphans;
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
  derivable: DerivableLayer,
  contractMap?: Map<string, ContractEntry>
): InterfaceSpec {
  // E2.1：契约层 contracts[] 按 interface / sourceId 对齐；命中即合并到 spec
  const contract = findContractForTransition(t, contractMap);

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
  // E2.1：契约层存在 requestSchema 时，guard params 跳过（契约字段是权威输入）
  if (!contract?.requestSchema && t.guard && !isIdentifierPredicate(t.guard)) {
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
  // E2.1：契约层 requestSchema / responseSchema 优先覆盖 guard 派生 inputs
  let requestSchema: JSONSchema;
  let responseSchema: JSONSchema;
  if (contract?.requestSchema) {
    // 契约层声明 → 直接采用契约 schema；同步补齐 currentState 强制约束（保留协议层必备）
    requestSchema = mergeContractRequestSchema(contract.requestSchema, stateEnumCurrent, t.from);
    // 重置 inputs：契约 schema 已有 currentState（合并时补齐），不再重复
    inputs.length = 0;
    for (const f of schemaPropertiesToFields(requestSchema, `${t.action} 契约层请求字段`)) {
      inputs.push(f);
    }
  } else {
    requestSchema = fieldsToObjectSchema(requestInputFields, {
      forceRequired: ['currentState'],
    });
    if (requestSchema.properties?.currentState) {
      requestSchema.properties.currentState = {
        ...stateEnumCurrent,
        description: `当前状态（期望 ${t.from.join('/')}，可选枚举值: ${(stateEnumCurrent.enum ?? []).join('/')}）`,
      };
    }
  }

  if (contract?.responseSchema) {
    // 契约层声明 → 直接采用契约 schema；保留 nextState 强制约束
    responseSchema = mergeContractResponseSchema(
      contract.responseSchema,
      stateEnumSchema(derivable.states),
      t.to
    );
    outputs.length = 0;
    for (const f of schemaPropertiesToFields(responseSchema, `${t.action} 契约层响应字段`)) {
      outputs.push(f);
    }
  } else {
    responseSchema = fieldsToObjectSchema(outputs, {
      forceRequired: ['nextState'],
    });
    const stateEnumNext = stateEnumSchema(derivable.states);
    if (responseSchema.properties?.nextState) {
      responseSchema.properties.nextState = {
        ...stateEnumNext,
        description: `转移后状态（期望: ${t.to}，可选枚举值: ${(stateEnumNext.enum ?? []).join('/')}）`,
      };
    }
  }

  // ── E2：结构化前置/后置/副作用 ──
  let preconditions: SchemaExpression[] = [];
  if (contract?.preconditions && contract.preconditions.length > 0) {
    preconditions = contract.preconditions.slice();
  } else if (!contract?.requestSchema && !contract?.responseSchema) {
    // E2.1：契约层未提供 requestSchema/responseSchema 时，guard 派生补 precondition；
    // 提供契约 schema 时契约层是权威，guard 不再被回填（避免因自然语言 guard 拉低 schemaKind）
    const guardExpr = tryParseGuardSchema(t.guard);
    if (guardExpr) {
      preconditions.push(guardExpr);
    } else if (t.guard) {
      preconditions.push({ kind: 'description-only', description: t.guard });
    }
  }
  const postconditionExpressions: SchemaExpression[] =
    contract?.postconditions && contract.postconditions.length > 0
      ? contract.postconditions.slice()
      : [
          // W2 R2-2 两路：① attributeEffects 直接投影为 structured effects（零翻译直通）；
          // ② narrative effects 走谓词翻译仅值约束子集（赋值语义不混入 guard 值约束）
          ...attributeEffectsToExpressions(t.attributeEffects),
          ...effectsToExpressions(t.effects),
        ];
  const sideEffects: SchemaExpression[] =
    contract?.sideEffects && contract.sideEffects.length > 0
      ? contract.sideEffects.slice()
      : [
          ...attributeEffectsToExpressions(t.attributeEffects),
          ...effectsToExpressions(t.effects),
        ];

  // ── W2 R2-3：跨接口谓词 invariant(INVn) 挂载 InvariantDef ──
  // 把 guard 中引用的不变量 ID 机械提取并投影到 spec.invariantIds（复用既有观测接口
  // 的 invariantIds 语义；引用存在性由 checker TC5 校验）。仅当 guard 命中 invariant()
  // 谓词时挂载——老模型无此语法 → 零回归。
  const guardInvariantIds: string[] = [];
  if (!contract && t.guard) {
    const pred = translatePredicate(t.guard.trim());
    if (pred && /^invariant\(/.test(t.guard.trim())) {
      const m = t.guard.trim().match(/^invariant\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)$/);
      if (m) guardInvariantIds.push(m[1]);
    }
  }

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
    // guard 未能机械翻译为 json-schema（natural language / 单标识符谓词 → legacy-stub）
    // → 显式降级并记录理由（不静默，R2-1 / NR-1 定案）。
    if (!contract && t.guard && (tryParseGuardSchema(t.guard)?.kind ?? 'legacy-stub') !== 'json-schema') {
      schemaDegradedReasons.push(
        `guard 表达式 "${t.guard}" 未机械提取为 JSON Schema（未按受限谓词语法书写，显式降级不静默，R2-1）`
      );
    }
  }
  // E2.1 标记：契约层字段消费来源
  if (contract) {
    if (schemaKind === 'structured') {
      // 不增加 degradedReasons（structured 即合规）
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
    // W2 R2-3：guard 引用不变量（invariant(INVn)）挂载到 invariantIds（如有）
    invariantIds: guardInvariantIds.length > 0 ? guardInvariantIds : undefined,
    // E2.1：契约层来源标识（消费方可观测）
    contractSource: contract?.interface,
    // C-4（10 §4）：契约层分型声明投影（无声明 → undefined，机械兜底不在本层）
    declaredInterfaceType: contract?.interfaceType,
    // E11：接口错误响应契约（命中契约的 errorResponses 投影到 spec；无契约时为空）
    errorResponses:
      contract?.errorResponses && contract.errorResponses.length > 0
        ? contract.errorResponses.slice()
        : undefined,
  };
}

// ============================================================================
// R1a：六张清单「操作」段 → 系统接口（操作 = 改实体维度，无状态机轴）
// ============================================================================

/**
 * R1a：六张清单「操作」段 → 系统接口。
 * - 操作 → name/sourceId；role → IR 层 OperationDef.triggerRoleId（spec 投影 triggerType）；
 * - guard → preconditions / precondition；change → affectsDimensions + sideEffects；
 * - trigger 四值映射 InterfaceSpec.triggerType 三值：role→'role'、observed/scheduled→'system'、
 *   cross→'external'（OperationDef.triggerType 保留四值原文，checker 判据 7 等在 IR 层消费）。
 * - 不产生 currentState/nextState（六张清单形态无单一状态轴）。
 */
function deriveOperationInterface(
  op: OperationDef,
  contractMap?: Map<string, ContractEntry>
): InterfaceSpec {
  const contract = contractMap?.get(op.name) ?? contractMap?.get(op.id);

  const inputs: FieldSpec[] = [];
  const outputs: FieldSpec[] = [];
  if (op.sideEffects.length > 0) {
    outputs.push({
      name: 'effects',
      type: 'string[]',
      description: `状态变更副作用：${op.sideEffects.join('; ')}`,
    });
  }

  const requestSchema: JSONSchema = fieldsToObjectSchema(inputs, {});
  const responseSchema: JSONSchema = fieldsToObjectSchema(outputs, {});

  // guard → preconditions（契约层优先，与 deriveSystemInterface 同一口径）
  let preconditions: SchemaExpression[] = [];
  if (contract?.preconditions && contract.preconditions.length > 0) {
    preconditions = contract.preconditions.slice();
  } else {
    const guardExpr = tryParseGuardSchema(op.guard);
    if (guardExpr) preconditions.push(guardExpr);
    else if (op.guard) preconditions.push({ kind: 'description-only', description: op.guard });
  }
  const postconditionExpressions: SchemaExpression[] =
    contract?.postconditions && contract.postconditions.length > 0
      ? contract.postconditions.slice()
      : op.sideEffects.map((s) => ({ kind: 'description-only', description: s }));
  const sideEffects: SchemaExpression[] =
    contract?.sideEffects && contract.sideEffects.length > 0
      ? contract.sideEffects.slice()
      : op.sideEffects.map((s) => ({ kind: 'description-only', description: s }));

  const schemaKind = classifySchemaKind({
    requestSchema,
    responseSchema,
    preconditions,
    postconditionExpressions,
    sideEffects,
  });
  const schemaDegradedReasons: string[] = [];
  if (
    schemaKind !== 'structured' &&
    !contract &&
    op.guard &&
    (tryParseGuardSchema(op.guard)?.kind ?? 'legacy-stub') !== 'json-schema'
  ) {
    schemaDegradedReasons.push(
      `guard 表达式 "${op.guard}" 未机械提取为 JSON Schema（未按受限谓词语法书写，显式降级不静默，R2-1）`
    );
  }

  return {
    id: `IF_SYS_${op.id}`,
    kind: 'system',
    sourceId: op.name,
    name: op.name,
    inputs,
    outputs,
    precondition: op.guard,
    postconditions: op.sideEffects.length > 0 ? op.sideEffects : undefined,
    // R1a：六张清单操作 → 接口（写入方集合数据源，R-KIND 组 / R1b 消费）
    affectsDimensions: op.affectsDimensions,
    triggerType: mapOperationTriggerType(op.triggerType),
    requestSchema,
    responseSchema,
    preconditions,
    postconditionExpressions,
    sideEffects,
    schemaKind,
    schemaDegradedReasons,
    contractSource: contract?.interface,
    declaredInterfaceType: contract?.interfaceType,
    errorResponses:
      contract?.errorResponses && contract.errorResponses.length > 0
        ? contract.errorResponses.slice()
        : undefined,
  };
}

/** R1a：六张清单触发类型（四值）→ InterfaceSpec.triggerType（三值）映射 */
function mapOperationTriggerType(
  t: OperationTriggerType
): 'role' | 'system' | 'external' {
  switch (t) {
    case 'role':
      return 'role';
    case 'observed':
    case 'scheduled':
      return 'system';
    case 'cross':
      return 'external';
  }
}

// ============================================================================
// E11 后续问题 5：契约承载接口（contract-carrier）
// ============================================================================

/**
 * E11 后续问题 5：对"未被任何 transition 消费的契约"派生承载接口。
 *
 * 动机：specifier 旧实现按 transition.action / transition.id 匹配 contract.interface，
 * 未匹配契约的 errorResponses 被静默丢弃（specs.json 不含 → errorMap 中错误码缺失投影，
 * web「错误映射表」每接口页出警告）。新增承载接口机制：
 * - 承载接口 kind=system，但 sourceId/iface 与 transition 解耦（仅作契约投影载体）
 * - requestSchema/responseSchema 直接采用契约层（ajv 可编译）
 * - errorResponses 来自契约层（关键：使 errorMap 22 个缺口码进 specs）
 * - 不参与状态机（无 from/to/guard），故不产生 currentState / nextState 字段
 * - ID 命名空间：IF_CTR_<interface>（避开 IF_SYS_* / IF_OBS_* 既有命名）
 *
 * 退化模式：不派生承载接口（保持 description-only）；但 envelope.migrationWarnings
 * 仍记录缺口，让 checker / web 知道需要人工干预。
 */
function deriveContractCarrierInterface(
  contract: ContractEntry,
  contractIface: string
): InterfaceSpec {
  // 承载接口的 requestSchema / responseSchema 直接采用契约层（已是 ajv 可编译 JSON Schema）
  const requestSchema: JSONSchema = contract.requestSchema ?? fieldsToObjectSchema([], {});
  const responseSchema: JSONSchema = contract.responseSchema ?? fieldsToObjectSchema([], {});

  // inputs / outputs 由 schema properties 机械派生（与 deriveSystemInterface 对齐）
  const inputs: FieldSpec[] = schemaPropertiesToFields(
    requestSchema,
    `${contractIface} 契约层请求字段`
  );
  const outputs: FieldSpec[] = schemaPropertiesToFields(
    responseSchema,
    `${contractIface} 契约层响应字段`
  );

  // 承载接口标识：IF_CTR_<interface>（驼峰→大写下划线仅占位）
  const idSafeIface = contractIface.replace(/[^a-zA-Z0-9_]/g, '_');
  const carrierId = `IF_CTR_${idSafeIface}`;

  // 契约层 preconditions/postconditions/sideEffects 直接采用
  const preconditions: SchemaExpression[] = contract.preconditions?.slice() ?? [];
  const postconditionExpressions: SchemaExpression[] = contract.postconditions?.slice() ?? [];
  const sideEffects: SchemaExpression[] = contract.sideEffects?.slice() ?? [];

  // schemaKind：契约层提供完整 request/response schema + 表达式时 → structured；
  // 否则按 classifySchemaKind 归类（多数契约层均达 structured）。
  const schemaKind = classifySchemaKind({
    requestSchema,
    responseSchema,
    preconditions,
    postconditionExpressions,
    sideEffects,
  });

  // 降级理由：明确标注"承载接口"语义，避免与状态机系统接口混淆
  const schemaDegradedReasons: string[] = [
    `承载接口（contract-carrier）：契约 ${contractIface} 未匹配任何 transition.id/action；requestSchema/responseSchema 直接采用契约层`,
  ];
  if (schemaKind !== 'structured') {
    schemaDegradedReasons.push('契约层未提供完整 JSON Schema 或 preconditions/postconditions，进 description-only 降级');
  }

  return {
    id: carrierId,
    kind: 'system', // 沿用 system 类型（让 web 渲染表/绑定视图正常出现）；用 isContractCarrier 标记区分
    sourceId: contractIface,
    name: contractIface,
    inputs,
    outputs,
    requestSchema,
    responseSchema,
    preconditions,
    postconditionExpressions,
    sideEffects,
    schemaKind,
    schemaDegradedReasons,
    // 契约层来源标识
    contractSource: contractIface,
    // C-4（10 §4）：契约层分型声明投影（无声明 → undefined，机械兜底不在本层）
    declaredInterfaceType: contract.interfaceType,
    // E11：接口错误响应契约（承载：把契约 errorResponses 投影进 specs，补 errorMap 缺口）
    errorResponses:
      contract.errorResponses && contract.errorResponses.length > 0
        ? contract.errorResponses.slice()
        : undefined,
    // 承载接口标记：webgen / checker 可据此区分（不入 verify 状态机推演）
    isContractCarrier: true,
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
// E2.1：契约层 contracts[] 消费（合并到 spec）
// ============================================================================

/**
 * 把契约层 contracts[] 数组按 interface + sourceId 索引到 Map，便于 O(1) 查找。
 * - 主键：interface 名
 * - 同时记一份 sourceId → entry（当 transition.id 被显式声明时）
 */
function buildContractMap(contracts: ContractEntry[] | undefined): Map<string, ContractEntry> {
  const map = new Map<string, ContractEntry>();
  if (!contracts) return map;
  for (const c of contracts) {
    if (!c.interface) continue;
    map.set(c.interface, c);
    if (c.sourceId) {
      map.set(c.sourceId, c);
    }
  }
  return map;
}

/**
 * 在契约 map 中按 transition 查找匹配条目（对齐 interface / sourceId / action / id）
 * 优先级：sourceId 显式匹配 > interface == action > interface == transition.id
 */
function findContractForTransition(
  t: TransitionDef,
  map?: Map<string, ContractEntry>
): ContractEntry | undefined {
  if (!map) return undefined;
  return (
    (t.id && map.get(t.id)) ||
    (t.action && map.get(t.action)) ||
    undefined
  );
}

/**
 * 把契约层 requestSchema 与协议层 currentState 强制约束合并。
 * - 契约 schema 已是权威；保留契约的 properties / required
 * - currentState 必须存在（协议必备），其 schema 用协议层 stateEnum 强制
 */
function mergeContractRequestSchema(
  contractSchema: JSONSchema,
  stateEnum: JSONSchema,
  fromStates: string[]
): JSONSchema {
  const merged: JSONSchema = {
    ...contractSchema,
    type: contractSchema.type ?? 'object',
    properties: { ...(contractSchema.properties ?? {}) },
    required: contractSchema.required ? [...contractSchema.required] : [],
  };
  // currentState 强制约束（协议必备）
  merged.properties = merged.properties ?? {};
  merged.properties.currentState = {
    ...stateEnum,
    description: `当前状态（期望 ${fromStates.join('/')}，可选枚举值: ${(stateEnum.enum ?? []).join('/')}）`,
  };
  if (!merged.required || !merged.required.includes('currentState')) {
    merged.required = [...(merged.required ?? []), 'currentState'];
  }
  return merged;
}

function mergeContractResponseSchema(
  contractSchema: JSONSchema,
  stateEnum: JSONSchema,
  toState: string
): JSONSchema {
  const merged: JSONSchema = {
    ...contractSchema,
    type: contractSchema.type ?? 'object',
    properties: { ...(contractSchema.properties ?? {}) },
    required: contractSchema.required ? [...contractSchema.required] : [],
  };
  // nextState 强制约束（协议必备）
  merged.properties = merged.properties ?? {};
  merged.properties.nextState = {
    ...stateEnum,
    description: `转移后状态（期望: ${toState}，可选枚举值: ${(stateEnum.enum ?? []).join('/')}）`,
  };
  if (!merged.required || !merged.required.includes('nextState')) {
    merged.required = [...(merged.required ?? []), 'nextState'];
  }
  return merged;
}

/**
 * JSONSchema properties → FieldSpec[]
 * 仅取叶子字段（properties 嵌套递归暂不展开为多层结构，保持与现有 spec 形态一致）
 */
function schemaPropertiesToFields(
  schema: JSONSchema,
  baseDescription: string
): FieldSpec[] {
  if (!schema.properties) return [];
  const requiredSet = new Set(schema.required ?? []);
  return Object.entries(schema.properties).map(([name, prop]) => {
    // 数组/对象/嵌套 → 描述形式保留
    const type = fieldTypeFromJsonSchema(prop);
    return {
      name,
      type,
      description:
        prop.description ?? `${baseDescription}（字段 ${name}，类型 ${type}）`,
      required: requiredSet.has(name) || schema.required?.includes(name),
    } satisfies FieldSpec;
  });
}

function fieldTypeFromJsonSchema(s: JSONSchema): string {
  if (s.type === 'array') {
    const innerType = s.items?.type ?? 'any';
    return `array<${innerType}>`;
  }
  if (s.type) return s.type;
  // 无 type：若 enum 存在 → string 兜底
  if (s.enum) return 'string';
  return 'any';
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
  // W2 §5 B / TC4 ④：数据级不变量统一表达——InvariantDef → SchemaExpression 机械生成。
  // 命中受限谓词语法（unique / nonEmpty 等）→ json-schema 进后置表达式（unique 直连 E4 SQL
  // 校验生成器，不重做）；未命中 → 保持原文（description-only 不进表达式，零回归）。
  const invExpr = invariantToSchemaExpression(inv);
  const postconditionExpressions: SchemaExpression[] =
    invExpr.kind === 'json-schema' ? [invExpr] : [];

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
  options: SpecifyOptions,
  contractMap?: Map<string, ContractEntry>
): InterfaceSpec[] {
  const specs: InterfaceSpec[] = [];
  const derivable = model.derivable;

  for (const t of derivable.transitions) {
    const spec = deriveSystemInterface(t, derivable, contractMap);
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
