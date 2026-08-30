/**
 * derive-storage（X19 / G7-S3）：实体维度 → 存储 schema 骨架（纯机械）
 *
 * 设计依据：
 * - execution-plan.md §S3（S3-4：schema 覆盖全部实体维度，覆盖率 100%，对应 G8 D3）
 * - refactor-proposal.md §P0-1 影响下游表（「存储 / DTO 骨架：实体维度 → 类型定义与
 *   持久化 schema，可新增一个 derive-storage，输入是表 3 维度清单，纯机械」）
 *
 * 输入：specs.json envelope 的 dimensions（DimensionKindEntry[]，S1 产物）= 表 3 维度清单。
 * 输出：storage.schema.json —— 按 owner（状态 ID / 附属实体 ID）分组的存储骨架。
 *
 * 机械边界（诚实标注）：
 * - 维度清单不含类型/初始值 → 列类型统一 TODO（人工按目标存储确认）；
 * - 列名 = 维度名（不做重命名，骨架级约定）。
 *
 * 降级（B-1 分流，显式不静默）：
 * - kind 缺省（dimension-kind-undetermined，如 food-delivery 4 维度）→ 列照常生成
 *   （存储与 kind 无关），列上 kind='undetermined' 显式标注 + 降级 warning；
 * - specs.json 无 dimensions / 空 → 空 entities + 显式 warning（覆盖率为 1，空集真空成立）。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  DimensionKind,
  DimensionKindSource,
  DimensionKindEntry,
} from '../model/dimension-kind.js';
import {
  isSpecsEnvelope,
  envelopeMigrate,
} from '../specifier/envelope.js';

// ============================================================================
// 类型定义
// ============================================================================

/** storage schema 顶层 kind 标记（判别字段） */
export const STORAGE_SCHEMA_KIND = 'storage-schema' as const;
/** storage schema schemaVersion */
export const STORAGE_SCHEMA_VERSION = '1.0' as const;

/** 单列（单维度）骨架 */
export interface StorageColumn {
  /** 维度名（表 3 维度清单原样） */
  dimension: string;
  /** 存储列名（默认 = 维度名；纯机械骨架不做重命名） */
  column: string;
  /** kind：declared / observed；kind 缺省（W(dim)=∅）→ 'undetermined'（B-1 显式降级） */
  kind: DimensionKind | 'undetermined';
  /** 来源：derived / asserted；kind=undetermined 时缺省 */
  kindSource?: DimensionKindSource;
  /** 纯机械骨架：维度清单不含类型，列类型留 TODO（人工按目标存储确认） */
  type: 'TODO';
}

/** 实体（维度 owner）存储骨架 */
export interface StorageEntity {
  /** 实体标识（维度 owner：状态 ID 或附属实体 ID） */
  entity: string;
  /** 该实体维度数 */
  dimensionCount: number;
  /** 列清单（每维度一列，覆盖率 100%） */
  columns: StorageColumn[];
}

/** derive-storage 输出（storage.schema.json） */
export interface StorageSchema {
  schemaVersion: typeof STORAGE_SCHEMA_VERSION;
  kind: typeof STORAGE_SCHEMA_KIND;
  /** 生成时间（ISO） */
  generatedAt: string;
  /** 源 model.md version（specs.json envelope 搬运） */
  sourceModelVersion: string;
  /** 实体维度总数（表 3 维度清单条目数） */
  dimensionCount: number;
  /** 有存储落点的维度数（= dimensionCount，每维度必有一列） */
  coveredDimensionCount: number;
  /**
   * 覆盖率 = coveredDimensionCount / dimensionCount。
   * dimensionCount=0 → 1（空集真空成立：无维度即全部覆盖，对应 G8 D3）。
   */
  coverageRate: number;
  /** 按 owner 分组的实体存储骨架 */
  entities: StorageEntity[];
  /** specs.json 搬运的显式降级记录（dimension-kind-undetermined 等） */
  schemaDegradedReasons: string[];
  /** 生成期 warning（含 B-1 降级显式记录） */
  warnings: string[];
}

/** derive-storage 输入 */
export interface DeriveStorageOptions {
  /** 项目根目录（用于读取 derived/specs.json） */
  rootDir: string;
  /** 可选：自定义 specs.json 路径（默认 <rootDir>/derived/specs.json） */
  specsPath?: string;
  /** 可选：自定义 schema 输出路径（默认 <rootDir>/derived/storage.schema.json） */
  outputPath?: string;
  /** 强制覆盖已存在 schema */
  force?: boolean;
}

/** derive-storage 执行结果 */
export interface DeriveStorageResult {
  schema: StorageSchema;
  schemaPath: string;
}

// ============================================================================
// 核心推导（纯函数，不写文件）
// ============================================================================

/**
 * 实体维度 → 存储 schema 骨架（纯机械）。
 *
 * 输入是 specs.json 的维度清单（DimensionKindEntry[]）+ envelope 元数据；
 * 输出覆盖全部实体维度（每维度一列，S3-4：覆盖率 100%）。
 *
 * 降级显式：kind 缺省维度列上 kind='undetermined' + warnings 记录（B-1 分流，不静默）。
 */
export function deriveStorageSchema(opts: {
  dimensions: DimensionKindEntry[] | undefined;
  sourceModelVersion: string;
  schemaDegradedReasons: string[] | undefined;
}): StorageSchema {
  const dimensions = opts.dimensions ?? [];
  const warnings: string[] = [];
  const schemaDegradedReasons = opts.schemaDegradedReasons ?? [];

  // 显式记录 specs.json 已声明降级（搬运，不静默）
  warnings.push(...schemaDegradedReasons);

  if (dimensions.length === 0) {
    warnings.push(
      'specs.json 无维度声明（dimensions 为空或缺省）：存储 schema 为空骨架，待实体维度声明后重跑 derive-storage'
    );
  }

  // 按 owner 分组（保持 specs.json 顺序稳定）
  const byOwner = new Map<string, DimensionKindEntry[]>();
  for (const d of dimensions) {
    const list = byOwner.get(d.owner) ?? [];
    list.push(d);
    byOwner.set(d.owner, list);
  }

  const entities: StorageEntity[] = [];
  for (const [owner, dims] of byOwner) {
    const columns: StorageColumn[] = dims.map((d) => {
      const col: StorageColumn = {
        dimension: d.dimension,
        column: d.dimension,
        kind: d.kind ?? 'undetermined',
        type: 'TODO',
      };
      if (d.kindSource) col.kindSource = d.kindSource;
      if (!d.kind) {
        // kind 缺省：列照常生成（存储与 kind 无关），显式降级标注（B-1 分流）
        warnings.push(
          `维度 ${d.dimension}（${owner}）kind 缺省（dimension-kind-undetermined），存储列已生成（type=TODO），kind 标 undetermined 待人工确认`
        );
      }
      return col;
    });
    entities.push({ entity: owner, dimensionCount: dims.length, columns });
  }

  const dimensionCount = dimensions.length;
  const coveredDimensionCount = dimensionCount;
  const coverageRate = dimensionCount === 0 ? 1 : coveredDimensionCount / dimensionCount;

  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    kind: STORAGE_SCHEMA_KIND,
    generatedAt: new Date().toISOString(),
    sourceModelVersion: opts.sourceModelVersion,
    dimensionCount,
    coveredDimensionCount,
    coverageRate,
    entities,
    schemaDegradedReasons,
    warnings,
  };
}

// ============================================================================
// CLI 入口：读 specs.json（envelope）→ 推导 → 写 storage.schema.json
// ============================================================================

/**
 * CLI 入口：从 rootDir 读取 derived/specs.json，机械推导并写入存储 schema 骨架。
 *
 * 行为：
 * - specs.json 不存在 → 抛错（提示先 derive-specs）
 * - 老格式 specs.json（裸数组）→ 自动 envelopeMigrate（迁移产物的 dimensions 缺省 → 空骨架 + warning）
 * - schema 已存在 → 未传 --force 时抛错
 */
export async function deriveStorage(
  options: DeriveStorageOptions
): Promise<DeriveStorageResult> {
  const rootDir = options.rootDir;
  const specsPath = options.specsPath ?? join(rootDir, 'derived/specs.json');
  const outputPath =
    options.outputPath ?? join(rootDir, 'derived/storage.schema.json');

  if (!existsSync(specsPath)) {
    throw new Error(
      `specs.json 不存在: ${specsPath}（请先运行 protochain derive-specs）`
    );
  }
  const rawSpecs = JSON.parse(readFileSync(specsPath, 'utf-8'));

  let dimensions: DimensionKindEntry[] | undefined;
  let schemaDegradedReasons: string[] | undefined;
  let sourceModelVersion: string;

  if (isSpecsEnvelope(rawSpecs)) {
    dimensions = rawSpecs.dimensions;
    schemaDegradedReasons = rawSpecs.schemaDegradedReasons;
    sourceModelVersion = rawSpecs.sourceModelVersion ?? 'unknown';
  } else if (Array.isArray(rawSpecs)) {
    // 老格式裸数组 → 自动 envelopeMigrate（迁移不产维度清单，显式空骨架）
    const r = envelopeMigrate(rawSpecs, 'unknown');
    dimensions = r.envelope.dimensions;
    schemaDegradedReasons = r.envelope.schemaDegradedReasons;
    sourceModelVersion = r.envelope.sourceModelVersion ?? 'unknown';
  } else {
    const r = envelopeMigrate(rawSpecs, 'unknown');
    throw new Error(
      `specs.json 形态无法识别：${r.parseError ?? '未知错误'}（请检查 derive-specs 输出）`
    );
  }

  const schema = deriveStorageSchema({
    dimensions,
    sourceModelVersion,
    schemaDegradedReasons,
  });

  if (existsSync(outputPath) && !options.force) {
    throw new Error(
      `存储 schema 已存在: ${outputPath}（如需覆盖请传 --force）`
    );
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(schema, null, 2), 'utf-8');

  return { schema, schemaPath: outputPath };
}
