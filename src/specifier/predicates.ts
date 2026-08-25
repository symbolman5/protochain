/**
 * W2 受限谓词语法 + 机械翻译器（07-execution-T3 TC3）
 *
 * 定案（02-guard-effects-dsl.md §3 W2-a R2-1 语法扩展路线）：
 * - 谓词库 = guard/effects 的「受限书写语法 + 机械翻译表」；
 * - "命中" = 命中受限谓词语法（不是自然语言模式匹配，红线 2——不做任何"聪明"的字符串启发式）；
 * - 未按语法书写（含自然语言中文句子）→ 恒为未命中（返回 null），显式降级挂接由 TC4 做；
 * - 翻译纯函数：同输入同输出（可 diff）。
 *
 * 谓词集（02 §3 W2-a 第 1 点）：
 *   ① 单字段：nonEmpty(field) / nonNegative(field) / unique(field) / matchesPattern(field, "regex")
 *   ② 跨字段：fieldA == fieldB / fieldA < fieldB / sum(f1, f2, ...) == total
 *   ③ 跨接口：invariant(INVn)（挂载 InvariantDef，R2-3；引用存在性由 checker TC5 校验）
 *
 * 翻译口径（JSON Schema 子集，ajv 可编译）：
 * - 单字段值约束 → 对应字段约束 schema；
 * - 跨字段相等/和 → 结构表达（字段必填 + 类型约束）——跨字段相等/求和语义超出单文档
 *   JSON Schema（draft-07 无 $data）可表达范围，由 description 承载语义说明，
 *   机械翻译仍是确定性的（同输入同输出）；不引入 $data（TC5 checker 的 ajv 编译自检
 *   使用标准 Ajv 实例，$data 关键字会破坏可编译性）；
 * - invariant(INVn) → 最小可编译 schema + 引用说明（挂载点 InvariantDef，不新建容器）。
 */
import type { JSONSchema } from '../model/types.js';

/** 谓词翻译产物（命中受限语法） */
export interface PredicateTranslation {
  kind: 'json-schema';
  /** 可被 ajv 编译的 JSON Schema */
  schema: JSONSchema;
  /** 人读说明（保留原文） */
  description: string;
  /** 谓词引用的字段名列表（跨字段引用闭合校验用，TC5） */
  fields: string[];
}

/** 谓词关键字（保留名）：裸字段引用时不得占用（防歧义） */
const PREDICATE_KEYWORDS = new Set([
  'nonEmpty',
  'nonNegative',
  'unique',
  'matchesPattern',
  'invariant',
  'sum',
]);

/** 字段标识符：字母/下划线开头，字母数字下划线 */
const IDENT = '[A-Za-z_][A-Za-z0-9_]*';

function isReserved(name: string): boolean {
  return PREDICATE_KEYWORDS.has(name);
}

// ----------------------------------------------------------------------------
// 语法判定
// ----------------------------------------------------------------------------

/**
 * 判定表达式是否命中受限谓词语法（R2-1 定案：命中 = 命中受限语法）。
 * 不做任何自然语言模式匹配；形近但未按语法书写 → false。
 */
export function matchesPredicateSyntax(expr: string): boolean {
  return translatePredicate(expr) !== null;
}

// ----------------------------------------------------------------------------
// 翻译（命中 → 可编译 JSON Schema；未命中 → null）
// ----------------------------------------------------------------------------

/**
 * 机械翻译受限谓词表达式 → JSON Schema（纯函数，确定性）。
 *
 * @param expr 表达式原文（如 `nonEmpty(order_id)` / `paid_amount == order_amount`）
 * @returns 命中受限语法 → { kind:'json-schema', schema, description }；
 *          未命中（自然语言 / 非受限语法）→ null（不做模式匹配）
 */
export function translatePredicate(expr: string): PredicateTranslation | null {
  if (!expr || expr.trim() === '') return null;
  const trimmed = expr.trim();

  // ── ① 单字段谓词 ──
  const nonEmpty = trimmed.match(new RegExp(`^nonEmpty\\(\\s*(${IDENT})\\s*\\)$`));
  if (nonEmpty) {
    const field = nonEmpty[1];
    return {
      kind: 'json-schema',
      schema: { type: 'string', minLength: 1, description: `${field} 非空` },
      description: `谓词 nonEmpty(${field})：${field} 非空（minLength ≥ 1）`,
      fields: [field],
    };
  }

  const nonNegative = trimmed.match(new RegExp(`^nonNegative\\(\\s*(${IDENT})\\s*\\)$`));
  if (nonNegative) {
    const field = nonNegative[1];
    return {
      kind: 'json-schema',
      schema: { type: 'number', minimum: 0, description: `${field} 非负` },
      description: `谓词 nonNegative(${field})：${field} ≥ 0`,
      fields: [field],
    };
  }

  const unique = trimmed.match(new RegExp(`^unique\\(\\s*(${IDENT})\\s*\\)$`));
  if (unique) {
    const field = unique[1];
    return {
      kind: 'json-schema',
      schema: { type: 'array', uniqueItems: true, description: `${field} 值唯一` },
      description: `谓词 unique(${field})：${field} 元素唯一（uniqueItems；数据级不变量直连 E4 SQL 校验生成器）`,
      fields: [field],
    };
  }

  const matchesPattern = trimmed.match(
    new RegExp(`^matchesPattern\\(\\s*(${IDENT})\\s*,\\s*"([^"]*)"\\s*\\)$`)
  );
  if (matchesPattern) {
    const field = matchesPattern[1];
    const pattern = matchesPattern[2];
    return {
      kind: 'json-schema',
      schema: { type: 'string', pattern, description: `${field} 匹配 ${pattern}` },
      description: `谓词 matchesPattern(${field}, "${pattern}")：${field} 匹配正则 ${pattern}`,
      fields: [field],
    };
  }

  // ── ③ 跨接口谓词：invariant(INVn)（R2-3 挂载 InvariantDef）──
  const invariantRef = trimmed.match(new RegExp(`^invariant\\(\\s*(${IDENT})\\s*\\)$`));
  if (invariantRef) {
    const invId = invariantRef[1];
    return {
      kind: 'json-schema',
      schema: {
        type: 'object',
        description: `guard 引用不变量 ${invId}（跨接口约束挂载 InvariantDef，复用 level/scopeStateIds 语义）`,
      },
      description: `谓词 invariant(${invId})：guard 引用不变量 ${invId}（引用存在性由 checker 校验）`,
      fields: [],
    };
  }

  // ── ② 跨字段谓词 ──
  const sumEq = trimmed.match(
    new RegExp(`^sum\\(\\s*(${IDENT}(?:\\s*,\\s*${IDENT})*)\\s*\\)\\s*==\\s*(${IDENT})$`)
  );
  if (sumEq) {
    const fields = sumEq[1].split(',').map((s) => s.trim());
    const total = sumEq[2];
    if (!isReserved(total) && fields.every((f) => !isReserved(f))) {
      const properties: Record<string, JSONSchema> = {};
      const required: string[] = [];
      for (const f of fields) {
        properties[f] = { type: 'number', description: `sum 加数` };
        required.push(f);
      }
      properties[total] = { type: 'number', description: `sum 总和` };
      required.push(total);
      return {
        kind: 'json-schema',
        schema: {
          type: 'object',
          properties,
          required,
          description: `跨字段和约束：sum(${fields.join(', ')}) == ${total}`,
        },
        description: `谓词 sum(${fields.join(', ')}) == ${total}：求和约束（结构表达：字段必填 + number；和语义由不变量级校验承接）`,
        fields: [...fields, total],
      };
    }
  }

  const fieldEq = trimmed.match(new RegExp(`^(${IDENT})\\s*==\\s*(${IDENT})$`));
  if (fieldEq && !isReserved(fieldEq[1]) && !isReserved(fieldEq[2])) {
    const a = fieldEq[1];
    const b = fieldEq[2];
    return {
      kind: 'json-schema',
      schema: {
        type: 'object',
        properties: { [a]: {}, [b]: {} },
        required: [a, b],
        description: `跨字段相等约束：${a} == ${b}`,
      },
      description: `谓词 ${a} == ${b}：跨字段相等（结构表达：字段必填；相等语义超出单文档 JSON Schema 范围，由不变量级校验承接）`,
      fields: [a, b],
    };
  }

  const fieldLt = trimmed.match(new RegExp(`^(${IDENT})\\s*<\\s*(${IDENT})$`));
  if (fieldLt && !isReserved(fieldLt[1]) && !isReserved(fieldLt[2])) {
    const a = fieldLt[1];
    const b = fieldLt[2];
    return {
      kind: 'json-schema',
      schema: {
        type: 'object',
        properties: { [a]: { type: 'number' }, [b]: { type: 'number' } },
        required: [a, b],
        description: `跨字段小于约束：${a} < ${b}`,
      },
      description: `谓词 ${a} < ${b}：跨字段小于（结构表达：字段必填 + number；小于语义由不变量级校验承接）`,
      fields: [a, b],
    };
  }

  // ── 未命中：自然语言 / 非受限语法 → null（不做模式匹配，红线 2）──
  return null;
}

/**
 * 提取谓词引用的字段名（跨字段引用闭合校验用，TC5）。
 * 未命中谓词语法 → 空数组（不做模式匹配）。
 */
export function extractPredicateFieldRefs(expr: string): string[] {
  const t = translatePredicate(expr);
  return t ? t.fields : [];
}
