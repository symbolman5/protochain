/**
 * T2c（判据 D1）：维度 domain（枚举/档位）→ TS 类型/enum 推导
 *
 * 背景：storage.schema.json 的 type 全是 "TODO"——维度 domain 未映射到代码类型
 * （component-model-derivation.md §0.1 ③ D1：类型/枚举推导率 100%）。
 *
 * 规则：
 * - `{a, b}`（值域花括号）→ TS enum/联合类型（如 兑付状态 → ClaimStatus）；
 * - 档位（范围，如 "1..10" / "≤100"）→ number + 约束描述；
 * - 无 domain / 空 → string 缺省 + 显式降级记录（不静默）。
 *
 * 类型名 = 维度名转英文 ID（可配 dict；无 dict 时 ASCII 维度直接 PascalCase，
 * 中文维度保底 Dim<n> + 显式降级记录——未覆盖显式列出，不假装正确）。
 *
 * 产物：derived/types.ts（实体维度类型定义，100% 覆盖或未覆盖显式列出）。
 */

import type { EntityDimensionDef } from '../model/types.js';

// ============================================================================
// 类型定义
// ============================================================================

export interface DomainTypeDef {
  /** TS 类型名（如 ClaimStatus） */
  typeName: string;
  /** 源维度名 */
  dimension: string;
  /** 源实体名 */
  entity: string;
  /** 类型形态：enum（值域花括号）/ number（档位范围）/ string（缺省降级） */
  kind: 'enum' | 'number' | 'string';
  /** enum 值列表（kind=enum） */
  values?: string[];
  /** 档位范围原文（kind=number，如 "1..10"） */
  range?: string;
  /** 降级标记：未全部机械推导（显式记录，不静默） */
  degraded?: boolean;
  /** 降级原因（degraded=true 时） */
  reason?: string;
}

export interface DomainTypesResult {
  defs: DomainTypeDef[];
  /** 显式降级记录 */
  warnings: string[];
}

export interface DeriveDomainTypesOptions {
  /** 维度/实体 → 英文类型名转写字典（如 { 兑付状态: 'ClaimStatus' }） */
  dict?: Record<string, string>;
}

// ============================================================================
// domain → 类型推导
// ============================================================================

/** 解析值域花括号：`{a, b, c}` → ['a','b','c']；非花括号 → null */
export function parseDomainEnum(domain: string): string[] | null {
  const m = domain.match(/^\{\s*([^}]*)\s*\}$/);
  if (!m) return null;
  return m[1]
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 档位/范围判定：数字范围（1..10 / ≤100 / >=0 等）→ number */
export function isNumericDomain(domain: string): boolean {
  return /^\s*(≤|>=?|<=?|==)?\s*[-+]?\d+(\.\d+)?(\s*(\.\.|~|至)\s*[-+]?\d+(\.\d+)?)?\s*$/.test(domain);
}

/** 类型名：dict 命中 → PascalCase；ASCII 维度 → PascalCase；中文无 dict → Dim<n> + 降级 */
export function toTypeName(
  dimension: string,
  index: number,
  dict?: Record<string, string>
): { name: string; degraded: boolean; reason?: string } {
  const d = dict ?? {};
  const direct = d[dimension];
  if (direct) {
    return { name: pascalCase(direct), degraded: false };
  }
  if (/^[A-Za-z0-9_\-]+$/.test(dimension)) {
    return { name: pascalCase(dimension.replace(/[_\-]/g, ' ')), degraded: false };
  }
  return {
    name: `Dim${index + 1}`,
    degraded: true,
    reason: `维度「${dimension}」无英文转写字典（--dict 或程序 dict），类型名保底 Dim${index + 1}，人工确认后改名（T2c）`,
  };
}

function pascalCase(s: string): string {
  const parts = s.split(/[\s_\-/]+/).filter((p) => p.length > 0);
  if (parts.length === 0) return 'T';
  return parts
    .map((p) => {
      const cleaned = p.replace(/[^A-Za-z0-9]/g, '');
      return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
    })
    .join('');
}

/**
 * 实体维度 domain → 类型定义（pure function，确定性）。
 * 覆盖率 100%：每个实体维度必产出定义（enum/number/string 三态；无 domain → string + 降级）。
 */
export function deriveDomainTypes(
  entityDimensions: EntityDimensionDef[] | undefined,
  options: DeriveDomainTypesOptions = {}
): DomainTypesResult {
  const warnings: string[] = [];
  const defs: DomainTypeDef[] = [];
  for (let i = 0; i < (entityDimensions ?? []).length; i++) {
    const d = (entityDimensions ?? [])[i];
    const base: DomainTypeDef = {
      typeName: '',
      dimension: d.dimension,
      entity: d.entity,
      kind: 'string',
    };
    const enumVals = d.domain ? parseDomainEnum(d.domain) : null;
    if (enumVals && enumVals.length > 0) {
      const t = toTypeName(d.dimension, i, options.dict);
      base.typeName = t.name;
      base.kind = 'enum';
      base.values = enumVals;
      if (t.degraded) {
        base.degraded = true;
        base.reason = t.reason;
        warnings.push(t.reason!);
      }
    } else if (d.domain && isNumericDomain(d.domain)) {
      const t = toTypeName(d.dimension, i, options.dict);
      base.typeName = t.name;
      base.kind = 'number';
      base.range = d.domain.trim();
      if (t.degraded) {
        base.degraded = true;
        base.reason = t.reason;
        warnings.push(t.reason!);
      }
    } else {
      // 无 domain / 空 → string 缺省 + 显式降级
      const t = toTypeName(d.dimension, i, options.dict);
      base.typeName = t.name;
      base.kind = 'string';
      base.degraded = true;
      base.reason = t.degraded
        ? t.reason
        : `维度「${d.dimension}」无 domain 声明（值域/档位缺省），类型缺省 string（显式降级，T2c）`;
      warnings.push(base.reason ?? '');
    }
    defs.push(base);
  }
  return { defs, warnings };
}

// ============================================================================
// 产物渲染（derived/types.ts）
// ============================================================================

export function renderTypesFile(defs: DomainTypeDef[], meta: { sourceModelVersion: string }): string {
  const lines: string[] = [
    '/**',
    ' * 实体维度类型定义（derive-storage T2c 机械推导，判据 D1）',
    ' * 来源：model.md 实体维度段 domain（值域/档位）；100% 覆盖或未覆盖显式降级记录',
    ` * 源 model.md version: ${meta.sourceModelVersion}`,
    ' * 自动生成，请勿手动编辑；类型名人工确认后可改名（不影响推导）',
    ' */',
    '',
  ];
  for (const d of defs) {
    const note = d.degraded ? ` // T2c 降级：${d.reason ?? ''}` : '';
    if (d.kind === 'enum' && d.values) {
      lines.push(`// 实体「${d.entity}」维度「${d.dimension}」：${d.values.join(' | ')}`);
      lines.push(`export type ${d.typeName} = ${d.values.map((v) => JSON.stringify(v)).join(' | ')};${note}`);
    } else if (d.kind === 'number') {
      lines.push(`// 实体「${d.entity}」维度「${d.dimension}」档位：${d.range ?? ''}`);
      lines.push(`export type ${d.typeName} = number;${note}`);
    } else {
      lines.push(`// 实体「${d.entity}」维度「${d.dimension}」：无 domain 缺省 string`);
      lines.push(`export type ${d.typeName} = string;${note}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
