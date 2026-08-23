/**
 * 字段级偏差比较 —— E2 specs.json 升级到 JSON Schema 的衍生能力
 *
 * 设计依据：IMPLEMENTATION-PLAN.md §E2（verify 偏差报告扩展到业务字段）
 *
 * 用途：
 * - 当 spec 拥有 responseSchema（结构化），对 impl 响应做逐字段比对
 * - 输出 Deviation { kind:'field_mismatch', field, legacy, impl, ... }
 *
 * 原则：
 * - 仅当 schema 明确给出 expected 时输出偏差；schema 仅给 type 时仍记录 type 差异（如 string vs number）
 * - 不强制 ajv：ajv 在 derive-specs 已经编译过；本模块只做"按声明字段做有意义的差异记录"
 * - 不进入 binding-runner 主流程内：单独调用，由 caller 决定是否并发
 */

import type {
  Deviation,
  InterfaceSpec,
  JSONSchema,
} from '../model/types.js';

export interface FieldCompareInput {
  spec: InterfaceSpec;
  action: string;
  state: string;
  stepIndex?: number;
  implResponse: Record<string, unknown> | undefined;
  /** 协议侧（legacy）期望值字典 —— 优先来自 specs.json 的 description/expectedInformationFields */
  legacyExpected?: Record<string, unknown>;
  httpStatus?: number;
}

/**
 * 对响应对象做字段级比对，返回偏差列表。
 * 无 responseSchema 时返回空数组（沿用上层 state_mismatch 路径）
 */
export function compareFields(input: FieldCompareInput): Deviation[] {
  const { spec, action, state, stepIndex, implResponse, legacyExpected, httpStatus } = input;
  const deviations: Deviation[] = [];
  const schema = spec.responseSchema;
  if (!schema || !schema.properties) return deviations;
  if (!implResponse || typeof implResponse !== 'object') return deviations;

  // ── 1. 类型校验：ajv 不强制，但简化版类型差异识别 ──
  for (const [fieldName, fieldSchema] of Object.entries(schema.properties)) {
    const expectedType = fieldSchema.type;
    const actual = implResponse[fieldName];
    if (actual === undefined) {
      // required 字段缺失
      if ((schema.required ?? []).includes(fieldName)) {
        deviations.push({
          action,
          state,
          expected: expectedType ?? 'defined',
          actual: 'missing',
          kind: 'field_mismatch',
          stepIndex,
          field: `response.${fieldName}`,
          legacy: legacyExpected?.[fieldName]?.toString() ?? 'required',
          impl: 'missing',
          httpStatus,
        });
      }
      continue;
    }

    if (expectedType && !matchesSimpleType(actual, expectedType)) {
      deviations.push({
        action,
        state,
        expected: expectedType,
        actual: typeof actual,
        kind: 'field_mismatch',
        stepIndex,
        field: `response.${fieldName}`,
        legacy: legacyExpected?.[fieldName]?.toString() ?? expectedType,
        impl: typeof actual,
        httpStatus,
      });
      continue;
    }

    // ── 2. 值比对：与 legacy expected 比较（如有） ──
    if (legacyExpected && fieldName in legacyExpected) {
      const legacyVal = legacyExpected[fieldName];
      // E2.1：legacyExpected 是 JSON Schema 类型字符串（如 "string"/"number"）→
      //   按类型名比对，避免把"string"作为期望值与 impl 实际值 deepEqual
      if (typeof legacyVal === 'string' && isJsonSchemaTypeName(legacyVal)) {
        if (
          !matchesSimpleType(actual, legacyVal as NonNullable<JSONSchema['type']>)
        ) {
          deviations.push({
            action,
            state,
            expected: legacyVal,
            actual: stringifyCompact(actual),
            kind: 'field_mismatch',
            stepIndex,
            field: `response.${fieldName}`,
            legacy: legacyVal,
            impl: stringifyCompact(actual),
            httpStatus,
          });
        }
        continue;
      }
      // 普通值比对
      if (!deepEqual(actual, legacyVal)) {
        deviations.push({
          action,
          state,
          expected: String(legacyVal),
          actual: stringifyCompact(actual),
          kind: 'field_mismatch',
          stepIndex,
          field: `response.${fieldName}`,
          legacy: String(legacyVal),
          impl: stringifyCompact(actual),
          httpStatus,
        });
      }
    }
  }

  return deviations;
}

function matchesSimpleType(value: unknown, type: NonNullable<JSONSchema['type']>): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'null':
      return value === null;
    default:
      return true;
  }
}

const JSON_SCHEMA_TYPE_NAMES = new Set([
  'string', 'number', 'integer', 'boolean', 'object', 'array', 'null',
]);

function isJsonSchemaTypeName(s: string): boolean {
  return JSON_SCHEMA_TYPE_NAMES.has(s);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a === 'object' && typeof b === 'object') {
    const ak = Object.keys(a as object);
    const bk = Object.keys(b as object);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
    }
    return true;
  }
  return false;
}

function stringifyCompact(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v);
  if (typeof v === 'undefined') return 'undefined';
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * 把 comparator 装进 binding-runner 的 path-extension hooks 形态：返回函数式 check（响应回执时调用）
 */
export function makeFieldDeviationFn(spec: InterfaceSpec) {
  return (params: {
    action: string;
    state: string;
    stepIndex: number;
    implResponse: unknown;
    legacyExpected?: Record<string, unknown>;
    httpStatus?: number;
  }): Deviation[] => {
    if (!params.implResponse || typeof params.implResponse !== 'object') return [];
    return compareFields({
      spec,
      action: params.action,
      state: params.state,
      stepIndex: params.stepIndex,
      implResponse: params.implResponse as Record<string, unknown>,
      legacyExpected: params.legacyExpected,
      httpStatus: params.httpStatus,
    });
  };
}
