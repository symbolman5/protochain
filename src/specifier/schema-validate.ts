/**
 * JSON Schema ajv 自检 —— E2 (specs.json 升级到 JSON Schema)
 *
 * 设计依据：IMPLEMENTATION-PLAN.md §E2、IMPLEMENTATION-ACCEPTANCE.md §E2
 *
 * 用途：
 * - 在 derive-specs 写报告前对每个 spec 的 requestSchema/responseSchema 调用 ajv.compile
 * - 编译失败视为 schema 不合法，step.passed=false 并产出 issues
 * - 复用 package.json 已依赖的 ajv@^8.17.1，无新增依赖
 *
 * 退化兼容：
 * - 若 schema 为 undefined 或 kind=description-only，跳过 ajv 编译
 * - 找不到 ajv（依赖未安装）：返回 passed=false + 明确报错
 */

import Ajv, { type ErrorObject } from 'ajv';
import type { InterfaceSpec, JSONSchema } from '../model/types.js';

export interface SchemaValidationResult {
  /** 是否全部通过 */
  passed: boolean;
  /** 每个 spec 的检查结果（按 id 索引） */
  perSpec: Array<{
    specId: string;
    specName: string;
    requestSchemaCompiled: boolean;
    responseSchemaCompiled: boolean;
    requestSchemaErrors?: string[];
    responseSchemaErrors?: string[];
  }>;
  /** 全局错误（依赖缺失等） */
  fatalError?: string;
}

let cachedAjv: Ajv | undefined;

/**
 * 懒加载 ajv 单例（编译开销只在首次使用时付出）
 */
function getAjv(): Ajv {
  if (!cachedAjv) {
    cachedAjv = new Ajv({
      allErrors: true,
      strict: false,
    });
  }
  return cachedAjv;
}

/** 编译失败 → 友好错误 */
function formatErrors(errs: ErrorObject[] | null | undefined): string[] {
  if (!errs) return [];
  return errs.map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`.trim());
}

/** 对单个 schema 做 ajv 编译，捕获错误 */
function tryCompile(schema: JSONSchema): { ok: boolean; errors?: string[] } {
  try {
    const ajv = getAjv();
    // ajv.compile throws on invalid schema
    ajv.compile(schema);
    return { ok: true };
  } catch (err) {
    if (err instanceof Error) {
      return { ok: false, errors: [err.message] };
    }
    return { ok: false, errors: [String(err)] };
  }
}

/**
 * 对 InterfaceSpec 列表跑 ajv 自检（E2 验收第 1 项）
 *
 * 跳过策略：
 * - 若 spec.schemaKind === 'description-only' → 视为通过（无 schema 不需编译）
 * - 若 schemaKind === 'legacy-stub' → 仍尝试编译（消费方需要确认声明字段是否合法）
 */
export function validateSchemas(specs: InterfaceSpec[]): SchemaValidationResult {
  const perSpec: SchemaValidationResult['perSpec'] = [];
  let anyFail = false;

  for (const spec of specs) {
    const entry: SchemaValidationResult['perSpec'][number] = {
      specId: spec.id,
      specName: spec.name,
      requestSchemaCompiled: true,
      responseSchemaCompiled: true,
    };
    if (spec.schemaKind === 'description-only' && !spec.requestSchema && !spec.responseSchema) {
      perSpec.push(entry);
      continue;
    }
    if (spec.requestSchema) {
      const r = tryCompile(spec.requestSchema);
      entry.requestSchemaCompiled = r.ok;
      if (!r.ok) {
        entry.requestSchemaErrors = r.errors;
        anyFail = true;
      }
    }
    if (spec.responseSchema) {
      const r = tryCompile(spec.responseSchema);
      entry.responseSchemaCompiled = r.ok;
      if (!r.ok) {
        entry.responseSchemaErrors = r.errors;
        anyFail = true;
      }
    }
    perSpec.push(entry);
  }

  return {
    passed: !anyFail,
    perSpec,
  };
}

/** 编译总览：人类可读 */
export function formatSchemaValidationReport(result: SchemaValidationResult): string {
  const lines: string[] = [
    `JSON Schema 自检（ajv）：${result.passed ? '✓ 通过' : '✗ 未通过'}`,
  ];
  if (result.fatalError) {
    lines.push(`  fatal: ${result.fatalError}`);
  }
  if (result.perSpec.length === 0) {
    lines.push('  （无 spec 校验）');
    return lines.join('\n');
  }
  const fail = result.perSpec.filter(
    (p) => !p.requestSchemaCompiled || !p.responseSchemaCompiled
  );
  lines.push(`  共检查 ${result.perSpec.length} 个 spec；失败 ${fail.length}`);
  if (fail.length > 0) {
    for (const f of fail.slice(0, 5)) {
      const r = f.requestSchemaErrors?.join('; ') ?? '(无)';
      const resp = f.responseSchemaErrors?.join('; ') ?? '(无)';
      lines.push(`    - [${f.specId}] ${f.specName}：requestErrors=[${r}] responseErrors=[${resp}]`);
    }
  }
  return lines.join('\n');
}
