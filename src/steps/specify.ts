/**
 * 步骤执行器：⑤ 规格推导
 *
 * 设计依据：《协议驱动自验证工具链设计方案》specifier 模块、E2 (specs.json 升级到 JSON Schema)
 *
 * 执行方：code（代码确定性执行，无 AI）
 * 前置：formalize（③ 形式化验证通过）
 * 产出：derived/specs.json（SpecEnvelope 形态，含 schemaVersion）
 *
 * E2 变更：
 * - 写报告前调用 ajv 自检；通过才落盘
 * - 输出始终是 SpecsEnvelope（schemaVersion=1.0）
 * - 老格式 specs.json 自动迁移兼容（envelopeMigrate）
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { InterfaceSpec } from '../model/types.js';
import {
  specify,
  specsFromEnvelope,
  envelopeMigrate,
  SPECS_ENVELOPE_SCHEMA_VERSION,
  isSpecsEnvelope,
} from '../specifier/index.js';
import type { SpecsEnvelope } from '../specifier/index.js';
import {
  validateSchemas,
  formatSchemaValidationReport,
} from '../specifier/schema-validate.js';
import type { StepExecutor } from '../orchestrator/index.js';
import { writeReport } from '../orchestrator/index.js';

export function createSpecifyExecutor(): StepExecutor {
  return {
    async execute(ctx) {
      const { model, rootDir } = ctx;
      const now = new Date().toISOString();
      const inputSpecsPath = join(rootDir, 'derived/specs.json');

      // ── 老格式 specs.json 自动迁移 ──
      // 若存在老格式文件（裸 InterfaceSpec[] 或字段缺失），读入 → envelopeMigrate → 
      // 当 specs 短缺或输入文件的 sourceModelVersion 与当前 model 不一致时优先重推导；
      // 老格式仅作 warning，不影响当前重推导结果
      let migratedFromLegacy = false;
      const migrationWarnings: string[] = [];
      if (existsSync(inputSpecsPath)) {
        try {
          const raw = JSON.parse(readFileSync(inputSpecsPath, 'utf-8'));
          if (!isSpecsEnvelope(raw)) {
            migratedFromLegacy = true;
            const r = envelopeMigrate(raw, model.metadata.version);
            migrationWarnings.push(...r.warnings);
          }
        } catch {
          // 解析失败：忽略（继续推导）
        }
      }

      try {
        // 1) 推导
        const envelope = specify(model, { degradedAIAssist: true });

        // 2) ajv 自检（E2 验收第 1 项）
        const validation = validateSchemas(envelope.specs);
        if (!validation.passed) {
          return {
            stepId: 'derive-specs',
            passed: false,
            executedAt: now,
            outputs: [inputSpecsPath],
            error: 'JSON Schema 自检未通过（ajv compile 失败）',
            reportSummary: [
              '规格推导：✗ JSON Schema 自检未通过',
              formatSchemaValidationReport(validation),
              ...(migratedFromLegacy ? ['旧格式 specs.json 自动迁移报警：', ...migrationWarnings] : []),
            ].join('\n'),
          };
        }

        // 3) 准备 envelope（若迁移过，在 envelope 上记录）
        const finalEnvelope: SpecsEnvelope = {
          ...envelope,
        };
        if (migratedFromLegacy) {
          finalEnvelope.migrated = true;
          finalEnvelope.migrationWarnings = migrationWarnings;
        }

        // 4) 落盘
        const path = writeReport(rootDir, 'derived/specs.json', finalEnvelope);
        ctx.artifacts.specs = finalEnvelope.specs;

        return {
          stepId: 'derive-specs',
          passed: true,
          outputs: [path],
          executedAt: now,
          reportSummary: formatSpecSummary(finalEnvelope, validation, migratedFromLegacy),
        };
      } catch (err) {
        return {
          stepId: 'derive-specs',
          passed: false,
          executedAt: now,
          error: err instanceof Error ? err.message : String(err),
          reportSummary: `规格推导异常：${err instanceof Error ? err.message : err}`,
        };
      }
    },
  };
}

function formatSpecSummary(
  envelope: SpecsEnvelope,
  validation: { passed: boolean; perSpec: { requestSchemaCompiled: boolean; responseSchemaCompiled: boolean }[] },
  migratedFromLegacy: boolean
): string {
  const specs = envelope.specs;
  const systemCount = specs.filter((s) => s.kind === 'system').length;
  const observationCount = specs.filter((s) => s.kind === 'observation').length;
  const structuredCount = specs.filter((s) => s.schemaKind === 'structured').length;
  const legacyStubCount = specs.filter((s) => s.schemaKind === 'legacy-stub').length;
  const descriptionOnlyCount = specs.filter((s) => s.schemaKind === 'description-only').length;
  const degradedCount = specs.filter((s: InterfaceSpec) => s.degradedAssist).length;

  const lines: string[] = [
    `规格推导：✓ 通过`,
    `  schemaVersion: ${SPECS_ENVELOPE_SCHEMA_VERSION}`,
    `  系统接口: ${systemCount} 个`,
    `  观测接口: ${observationCount} 个`,
    `  schema 分类: structured=${structuredCount} legacy-stub=${legacyStubCount} description-only=${descriptionOnlyCount}`,
    `  JSON Schema 自检（ajv）：${validation.passed ? '✓ 全部通过' : '✗ 失败'}（${validation.perSpec.length} 个 schema）`,
  ];
  if (degradedCount > 0) {
    lines.push(`  退化模式 AI 辅助标注: ${degradedCount} 个`);
  }
  if (migratedFromLegacy) {
    lines.push(`  旧格式 specs.json 已迁移（migrated=true），见 envelope.migrationWarnings`);
  }
  if (envelope.migrationWarnings && envelope.migrationWarnings.length > 0) {
    for (const w of envelope.migrationWarnings) lines.push(`    [migration] ${w}`);
  }
  // 列出前 5 个接口
  if (specs.length > 0) {
    lines.push('  接口列表（前5个）：');
    for (const s of specs.slice(0, 5)) {
      lines.push(
        `    - [${s.kind}] ${s.id} (schemaKind=${s.schemaKind ?? 'unknown'}) ← ${s.sourceId}（${s.name}）`
      );
    }
    if (specs.length > 5) {
      lines.push(`    ... 还有 ${specs.length - 5} 个`);
    }
  }
  return lines.join('\n');
}

// 兼容旧 importer：specsFromEnvelope 重导出（spec.ts / casegen 等已用 specify 返回 InterfaceSpec[]）
export { specsFromEnvelope };
