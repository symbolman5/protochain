/**
 * 公共 specs.json 读取 helper（E2-I1 修复项）
 *
 * 设计依据：IMPLEMENTATION-ISSUES.md §E2-I1
 *
 * 背景：
 * - E2 后 specs.json 升级为 SpecsEnvelope（schemaVersion=1.0）
 * - 老格式（裸 InterfaceSpec[]）经 envelopeMigrate 提升
 * - 多个 caller 各自实现 loadSpecsOrMigrate（cli/index.ts 私有函数、steps/verify.ts 走粗暴 JSON.parse）
 * - 现有 tester 一旦撞 Envelope 作为裸数组使用即 `specs.map is not a function`
 *
 * 收敛：
 * - 单一 loadSpecsEnvelope() 读取 + 兼容迁移入口
 * - 调用方只需 import 单点
 * - 不可识别形态 → 抛出显式错误（不再静默兜底，E2-I5 关联）
 *
 * 行为：
 * - 文件不存在 → 返回 undefined（caller 决定 fallback）
 * - Envelope 形态 → 直接返回 specs
 * - 裸数组 → 浅拷贝 + envelopeMigrate 转 Envelope，再返回 envelope.specs（迁移报警由 caller 决定是否打印）
 * - 其他形态 → 抛 Error（caller 决定阻断或降级）
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { InterfaceSpec } from '../model/types.js';
import {
  envelopeMigrate,
  isSpecsEnvelope,
  type SpecsEnvelope,
} from './envelope.js';

export interface LoadSpecsResult {
  /** 加载得到的规格数组 */
  specs: InterfaceSpec[];
  /** 原始读取形态：envelope（直接读取）/ array-migrated（裸数组提升）/ empty（文件不存在） */
  source: 'envelope' | 'array-migrated' | 'empty';
  /** 是否从老格式迁移而来（与 envelope.migrated 一致） */
  migrated: boolean;
  /** 迁移过程产出的报警（如「老格式自动迁移」），由 caller 决定日志级别 */
  migrationWarnings: string[];
  /** 解析得到的 Envelope（source=empty 时仍返回空 Envelope 占位） */
  envelope: SpecsEnvelope;
}

/**
 * 加载 derived/specs.json，**始终返回** specs 数组或抛错；不做静默兜底。
 *
 * @param rootDir 项目根目录
 * @param fallbackSourceModelVersion 当 Envelope 缺失 sourceModelVersion 时使用
 * @param onMigrationWarning 可选 — 当迁移发生时调用（caller 控制日志级别与是否阻断）
 */
export function loadSpecsEnvelope(
  rootDir: string,
  fallbackSourceModelVersion: string = 'unknown',
  onMigrationWarning?: (warning: string) => void
): LoadSpecsResult | undefined {
  const path = join(rootDir, 'derived/specs.json');
  if (!existsSync(path)) return undefined;
  const raw = JSON.parse(readFileSync(path, 'utf-8'));

  // ── 路径 1：已是 Envelope ──
  if (isSpecsEnvelope(raw)) {
    return {
      specs: raw.specs,
      source: 'envelope',
      migrated: raw.migrated === true,
      migrationWarnings: raw.migrationWarnings ?? [],
      envelope: raw,
    };
  }

  // ── 路径 2：裸数组 → 浅拷贝 + envelopeMigrate（E2-I5 修复：不就地修改输入） ──
  if (Array.isArray(raw)) {
    const r = envelopeMigrate(raw.slice(), fallbackSourceModelVersion); // 浅拷贝避免就地改 raw
    if (r.warnings.length > 0 && onMigrationWarning) {
      for (const w of r.warnings) onMigrationWarning(w);
    }
    return {
      specs: r.envelope.specs,
      source: 'array-migrated',
      migrated: r.migrated,
      migrationWarnings: r.warnings,
      envelope: r.envelope,
    };
  }

  // ── 路径 3：损坏形态 → envelopeMigrate 已返回 parseError；按需抛出 ──
  const r = envelopeMigrate(raw, fallbackSourceModelVersion);
  if (r.parseError) {
    throw new Error(`specs.json 形态无法识别：${r.parseError}`);
  }
  // 不可达：上面两个分支已返回
  throw new Error('specs.json loadSpecsEnvelope 内部异常');
}
