/**
 * JSON Schema 推导工具（E2 specs.json 升级）
 *
 * 设计依据：IMPLEMENTATION-PLAN.md §E2
 *
 * 推导规则（机械映射）：
 * - FieldSpec.type 映射到 JSON Schema type
 *   - "string" → {type:'string'}
 *   - "string[]" / "array<string>" → {type:'array', items:{type:'string'}}
 *   - "number" / "integer" 区分
 *   - "boolean" → {type:'boolean'}
 *   - 缺 type 兜底为 {type:'string', description:'...'}
 * - FieldSpec.description → JSONSchema.description
 * - FieldSpec.required=true → 进 properties 且加入 required 数组
 * - guard 表达式机械提取：仅当 guard 是「单标识符 + 比较/逻辑」结构简单表达式（如 `count > 0`、`x == 1 && y >= 0`）时生成结构化子文档；
 *   复杂自然语言 fall back 为 legacy-stub
 */

import type {
  FieldSpec,
  JSONSchema,
  SchemaExpression,
  StateDef,
} from '../model/types.js';

/** 允许映射的 FieldSpec.type → JSON Schema type 名称 */
const TYPE_MAP: Record<string, JSONSchema['type']> = {
  string: 'string',
  number: 'number',
  integer: 'integer',
  boolean: 'boolean',
  object: 'object',
  array: 'array',
};

/**
 * FieldSpec → JSON Schema（单个属性的 schema）
 */
export function fieldToSchema(f: FieldSpec): JSONSchema {
  const rawType = (f.type ?? 'string').trim();
  // string[] / array<string> 形态
  const arrayMatch =
    rawType === 'string[]' ||
    rawType === 'number[]' ||
    rawType === 'integer[]' ||
    rawType === 'boolean[]' ||
    /^array<(.+)>$/.test(rawType);
  if (arrayMatch) {
    const inner = rawType === 'string[]'
      ? 'string'
      : rawType === 'number[]'
      ? 'number'
      : rawType === 'integer[]'
      ? 'integer'
      : rawType === 'boolean[]'
      ? 'boolean'
      : (rawType.match(/^array<(.+)>$/) as RegExpMatchArray)?.[1] ?? 'string';
    return {
      type: 'array',
      items: { type: (TYPE_MAP[inner] ?? inner) as JSONSchema['type'] },
      description: f.description,
    };
  }
  if (rawType in TYPE_MAP) {
    return {
      type: TYPE_MAP[rawType],
      description: f.description,
    };
  }
  // 兜底：任意描述性类型（如 enum[bound, free]）作为 string + description
  return {
    type: 'string',
    description: f.description ? `${f.description}（schema 声明类型 "${f.type}" 作为描述，机械映射为 string）` : `schema 声明类型 "${f.type}" 作为描述，机械映射为 string`,
  };
}

/**
 * fields: list → JSON Schema（object type）
 * - 仅 required=true 的进 required 数组
 * - 未声明 required 时视为可选
 */
export function fieldsToObjectSchema(
  fields: FieldSpec[],
  opts: {
    /** 强制要求字段集合（即使是 required=false，schema 必含字段也加 required） */
    forceRequired?: string[];
  } = {}
): JSONSchema {
  const properties: Record<string, JSONSchema> = {};
  const required: string[] = [];
  for (const f of fields) {
    if (!f.name) continue;
    properties[f.name] = fieldToSchema(f);
    const isRequired = f.required === true || (opts.forceRequired ?? []).includes(f.name);
    if (isRequired) required.push(f.name);
  }
  const schema: JSONSchema = {
    type: 'object',
    properties,
  };
  if (required.length > 0) {
    schema.required = required;
  }
  schema.additionalProperties = true;
  return schema;
}

/**
 * guard 表达式机械提取（结构化）
 *
 * 简化规则（E2-I2 修复后）：
 * - 单标识符（predicate 形 `form_valid` / `has_request` 等）→ legacy-stub（自然语言谓词，不进 schema）
 *   - 注：设计 §4.1：单标识符 guard 是「自然语言谓词」而非算术表达式；按 E2-I2 修复降级为 legacy-stub
 * - 多 token 表达式（`x == 1` / `count > 0 && flag == true`）→ json-schema + {type:'boolean'}
 * - 含中文标点 / 复杂函数调用 / 变量点引用 → legacy-stub
 */
export function tryParseGuardSchema(guard: string | undefined): SchemaExpression | undefined {
  if (!guard || guard.trim() === '') return undefined;
  const trimmed = guard.trim();
  // 含中文标点或非 ASCII 字符 → 标记 legacy-stub
  if (/[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(trimmed)) {
    return {
      kind: 'legacy-stub',
      description: `guard 表达式含中文标点，自然语言未机械提取：${trimmed}`,
    };
  }
  // 单标识符（谓词形 form_valid / has_request）→ 按设计降级 legacy-stub（E2-I2）
  // 判别：snake_case / camelCase 形式的布尔谓词名（短、纯标识符）是 guard 表达式，不是请求参数
  if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmed)) {
    return {
      kind: 'legacy-stub',
      description: `guard 单标识符（${trimmed}）是谓词形式，自然语言未机械提取；guard params 不进 requestSchema`,
    };
  }
  // 多 token 比较 / 逻辑表达式 → 视为 boolean schema
  if (/^[a-zA-Z_0-9><=!&|"\-\+\s\.\(\)]+$/.test(trimmed)) {
    return {
      kind: 'json-schema',
      description: `guard 表达式（${trimmed}），机械抽取为 boolean 类型`,
      schema: { type: 'boolean', description: trimmed },
    };
  }
  // 其他复杂形态
  return {
    kind: 'legacy-stub',
    description: `guard 表达式为自然语言，未机械提取为 JSON Schema：${trimmed}`,
  };
}

/**
 * 判断 guard 表达式是否为「单标识符谓词」（如 form_valid / has_request）。
 * 用于 specifier 决定是否将 guard params 进 requestSchema（E2-I2）：
 * - 单标识符谓词：guard params **不进** requestSchema 必填（仅保留 description）
 * - 多 token / 结构化表达式：可保留 guard params（按 boolean）
 */
export function isIdentifierPredicate(guard: string | undefined): boolean {
  if (!guard) return false;
  const trimmed = guard.trim();
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmed)) return false;
  // 排除纯字面量 / 关键字
  const reserved = new Set(['true', 'false', 'null', 'undefined', 'TRUE', 'FALSE', 'NULL']);
  return !reserved.has(trimmed);
}

/**
 * effects 数组 → SchemaExpression[]（始终是 description-only，effects 是 narrative）
 */
export function effectsToExpressions(effects: string[] | undefined): SchemaExpression[] {
  if (!effects || effects.length === 0) return [];
  return effects.map((e) => ({
    kind: 'description-only',
    description: e,
  }));
}

/**
 * 状态枚举 schema（用于 nextState / isInState 等字段）
 * 仅含真实状态 ID（不含 `-` 占位符），避免假阴性放行。
 */
export function stateEnumSchema(states: StateDef[]): JSONSchema {
  const allStates = states.map((s) => s.id);
  return {
    type: 'string',
    enum: allStates,
    description: `协议状态枚举（${allStates.length} 个）`,
  };
}

/**
 * currentState 枚举（E2-I7 修复：含 `-` 占位 + 全部真实状态 ID）
 * 仅用于 currentState 字段：协议层允许 `-`（前置虚拟状态）作为占位值。
 * nextState 不允许（需落到真实状态）。
 */
export function stateEnumCurrentSchema(states: StateDef[]): JSONSchema {
  const allStates = states.map((s) => s.id);
  return {
    type: 'string',
    enum: ['-', ...allStates],
    description: `currentState 枚举（含前置占位 "-" + ${allStates.length} 个真实状态）`,
  };
}

/**
 * 计算 schemaKind：spec 的最终 schema 完整度分类
 *
 * 规则：
 * - structured：requestSchema + responseSchema 都有 type，且 preconditions 全为 json-schema / 无 preconditions
 * - legacy-stub：preconditions 含 legacy-stub（即 guard 自然语言降级），或 requestSchema 缺 type
 * - description-only：完全无 schema（无 requestSchema 和 responseSchema；仅 inputs/outputs 字段名）
 */
export function classifySchemaKind(spec: {
  requestSchema?: JSONSchema;
  responseSchema?: JSONSchema;
  preconditions?: SchemaExpression[];
  postconditionExpressions?: SchemaExpression[];
  sideEffects?: SchemaExpression[];
}): 'structured' | 'legacy-stub' | 'description-only' {
  const hasInputStruct = spec.requestSchema !== undefined && spec.requestSchema.type !== undefined;
  const hasOutputStruct = spec.responseSchema !== undefined && spec.responseSchema.type !== undefined;
  const hasPrecondLegacy = (spec.preconditions ?? []).some((p) => p.kind === 'legacy-stub');
  const hasPrecondStruct = (spec.preconditions ?? []).some((p) => p.kind === 'json-schema');
  // 都没有 schema 字段 → description-only
  if (!hasInputStruct && !hasOutputStruct) {
    return 'description-only';
  }
  // 有 schema 但 preconditions 含 legacy-stub → 整体降级
  if (hasPrecondLegacy && !hasPrecondStruct) {
    return 'legacy-stub';
  }
  // 缺 schema type 但有字段（如 partial）→ legacy-stub
  if (!hasInputStruct || !hasOutputStruct) {
    return 'legacy-stub';
  }
  return 'structured';
}
