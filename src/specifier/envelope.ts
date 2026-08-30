/**
 * specs.json 顶层 envelope —— E2 (specs.json 升级到 JSON Schema)
 *
 * 设计依据：IMPLEMENTATION-PLAN.md §E2、IMPLEMENTATION-ACCEPTANCE.md §E2
 *
 * 兼容性策略：
 * - derive-specs 写出的 specs.json 始终是 Envelope 形态（含 schemaVersion）
 * - 老格式（裸 InterfaceSpec[]）经 envelopeMigrate 提升为 Envelope，并产出 migrationWarnings
 * - 消费方（verifier、checker、casegen）通过 loadSpecsEnvelope 读取，自动迁移；不要求存量数据手动改写
 *
 * E2-I5 修复要点：
 * - 不可识别形态不再静默兜底；返回 {migrated:false, error:'...'} 显式通知 caller
 * - 裸数组兜底改为浅拷贝，避免就地对输入对象写 schemaKind
 *
 * E2-I3 修复要点：
 * - envelopeMigrate 走 classifySchemaKind 统一 schemaKind 标记口径
 *   （原 envelopeMigrate 自带启发式 → 改为调用 schema-builder.classifySchemaKind 与 specifier 完全对齐）
 */

import type { InterfaceSpec } from '../model/types.js';
import type { DimensionKindEntry } from '../model/dimension-kind.js';
import { classifySchemaKind } from './schema-builder.js';

/** specs.json 顶层 envelope 的 schemaVersion */
export const SPECS_ENVELOPE_SCHEMA_VERSION = '1.0' as const;

/** specs.json 顶层 envelope 形态 */
export interface SpecsEnvelope {
  schemaVersion: typeof SPECS_ENVELOPE_SCHEMA_VERSION;
  /** 生成时间（ISO） */
  generatedAt: string;
  /** 源 model.md version */
  sourceModelVersion: string;
  /** 接口规格（机械推导） */
  specs: InterfaceSpec[];
  /** 是否从老格式（裸数组）迁移而来 */
  migrated?: boolean;
  /** 迁移过程产生的人工可读提示（如「接口 IF_SYS_T1 的 precondition 字段无 JSON Schema 降级为 description-only」） */
  migrationWarnings?: string[];
  /**
   * X1（P0-1）：维度 kind 判定结果（buildDimensionKinds 机械推导 + parser 人写断言合并）。
   * 每个维度有 kind 或有降级记录（见 schemaDegradedReasons）。
   */
  dimensions?: DimensionKindEntry[];
  /** X1：维度 kind 推导的显式降级记录（空集维度 → dimension-kind-undetermined） */
  schemaDegradedReasons?: string[];
  /** 解析致命错误（仅不可识别形态时填，caller 据此决定阻断/降级） */
  parseError?: string;
}

/** 简化类型守卫：判断对象是否为 Envelope 形态 */
export function isSpecsEnvelope(value: unknown): value is SpecsEnvelope {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.schemaVersion === 'string' &&
    Array.isArray(obj.specs)
  );
}

/**
 * 老格式 specs.json → 新 Envelope 自动迁移
 *
 * 修复（E2-I3 / E2-I5）：
 * - 不再就地修改输入的 raw 数组（E2-I5 修复）：拷贝后再标 schemaKind
 * - schemaKind 标记走 classifySchemaKind（E2-I3 修复），与 specifier 主路径口径统一
 * - 不可识别形态返回 migrated:false + parseError 字段，由 caller 决定阻断/降级（不再静默空 Envelope）
 *
 * 行为：
 * - Envelope 形态 → 幂等返回
 * - 裸 InterfaceSpec[] → 浅拷贝 + classifySchemaKind + migrated=true + warnings
 * - 其他形态 → migrated=false + envelope 含 parseError
 */
export function envelopeMigrate(
  raw: unknown,
  fallbackSourceModelVersion: string = 'unknown'
): { envelope: SpecsEnvelope; migrated: boolean; warnings: string[]; parseError?: string } {
  // ── 路径 1：已是 Envelope → 幂等返回 ──
  if (isSpecsEnvelope(raw)) {
    return { envelope: raw, migrated: raw.migrated === true, warnings: raw.migrationWarnings ?? [] };
  }

  // ── 路径 2：裸 InterfaceSpec[] → 浅拷贝 + classifySchemaKind 统一口径（E2-I3 修复） ──
  if (Array.isArray(raw)) {
    const warnings: string[] = [
      `老格式 specs.json 自动迁移：检测到 ${raw.length} 条 InterfaceSpec 顶层数组，已包裹为 Envelope（schemaVersion=${SPECS_ENVELOPE_SCHEMA_VERSION}）。`,
    ];
    // 浅拷贝 specs：避免就地对 caller 持有的数组写 schemaKind（E2-I5 修复）
    const specs: InterfaceSpec[] = raw.map((s) => ({ ...s }));
    const counts = { structured: 0, legacyStub: 0, descriptionOnly: 0 };
    let triagedUncounted = 0;
    for (const s of specs) {
      if (!s.schemaKind) {
        // E2-I3 修复：用 classifySchemaKind 统一口径（不再自带启发式）
        s.schemaKind = classifySchemaKind(s);
      }
      const kind = s.schemaKind;
      if (kind === 'structured') counts.structured++;
      else if (kind === 'legacy-stub') counts.legacyStub++;
      else if (kind === 'description-only') counts.descriptionOnly++;
      else triagedUncounted++;
    }
    // 统计不在三态的兜底（防御）
    const totalCounted = counts.structured + counts.legacyStub + counts.descriptionOnly;
    const triaged = specs.length - totalCounted + triagedUncounted;
    if (counts.legacyStub > 0) {
      warnings.push(
        `${counts.legacyStub} 个接口标记为 legacy-stub（缺 JSON Schema 仅 name/type/description 三件套，请回到 model.md 增补契约层段）。`
      );
    }
    if (counts.descriptionOnly > 0) {
      warnings.push(
        `${counts.descriptionOnly} 个接口标记为 description-only（无 I/O 字段，仅名字可读）。`
      );
    }
    if (counts.structured > 0) {
      warnings.push(
        `${counts.structured} 个接口维持 structured（recompute by classifySchemaKind）。`
      );
    }
    if (triaged > 0) {
      warnings.push(`${triaged} 个接口 schemaKind 不在 structured/legacy-stub/description-only 三态，分类异常已强制归一。`);
    }
    return {
      envelope: {
        schemaVersion: SPECS_ENVELOPE_SCHEMA_VERSION,
        generatedAt: new Date().toISOString(),
        sourceModelVersion: fallbackSourceModelVersion,
        specs,
        migrated: true,
        migrationWarnings: warnings,
      },
      migrated: true,
      warnings,
    };
  }

  // ── 路径 3：损坏形态 → 显式错误（E2-I5 修复：不再静默兜底空 Envelope） ──
  const snippet = (() => {
    try {
      const s = JSON.stringify(raw);
      return s.length > 80 ? s.slice(0, 80) + '...' : s;
    } catch {
      return '(unstringifiable)';
    }
  })();
  const parseError = `无法识别的 specs.json 形态：期望 Envelope（schemaVersion+specs）或 InterfaceSpec[]，实际 ${snippet}`;
  return {
    envelope: {
      schemaVersion: SPECS_ENVELOPE_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      sourceModelVersion: fallbackSourceModelVersion,
      specs: [],
      migrated: false,
      migrationWarnings: [parseError],
      parseError,
    },
    migrated: false,
    warnings: [parseError],
    parseError,
  };
}

/** 便捷：从 Envelope 取 specs（不做迁移判定时使用） */
export function specsFromEnvelope(env: SpecsEnvelope): InterfaceSpec[] {
  return env.specs;
}
