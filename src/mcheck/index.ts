/**
 * m-check 入口（M 单元语义闸门）
 *
 * 设计依据：IMPLEMENTATION-PLAN.md §E1、IMPLEMENTATION-ACCEPTANCE.md §E1
 *
 * 与现有 checker 严格不重叠（REVIEW §5.2）：
 * - checker 做 from/to 存在性校验（src/checker/index.ts:495-512）
 * - m-check 做命名规范 / 跨协议 ID 唯一性 / 附属实体归属 / 旧字符 / ID 转义
 *
 * CLI：`protochain m-check --dir <项目根>` （在 src/cli/index.ts 注册）
 * 退出码：passed → 0；有 error 级 issue → 1；解析失败 → 2
 */

import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SourceProtocolModel } from '../model/types.js';
import { parseProtocolFile } from '../parser/index.js';
import type {
  MCheckReport,
  MCheckContext,
  MCheckRuleResult,
  MCheckIssue,
} from './types.js';
import { MCHECK_RULES } from './rules.js';

/**
 * Load peer protocol models for multi-protocol projects.
 * Used by rule M002 (cross-protocol ID uniqueness).
 *
 * @param rootDir system root, contains protocol/P-N/model.md
 * @param currentModel currently-loaded model, used as comparison source
 * @param currentModelPath absolute path of the currently-loaded model file;
 *                         peer models whose file path matches this are
 *                         considered self (same protocol instance re-parsed)
 *                         and excluded from cross-protocol uniqueness check.
 */
function loadPeerModels(
  rootDir: string,
  currentModel: SourceProtocolModel,
  currentModelPath?: string
): Record<string, SourceProtocolModel> {
  const peers: Record<string, SourceProtocolModel> = {};
  const protocolDir = join(rootDir, 'protocol');
  let entries: string[];
  try {
    entries = readdirSync(protocolDir);
  } catch {
    return peers; // 单协议项目，无 peer
  }
  // USAGE §5.1 多协议项目结构：protocol/P1-用户配额同步/、P2-入口配置/、...
  // 子协议目录以 P 开头 + 数字 ID 为前缀（P1 / P2 / ... P10），
  // 后可跟 `-` 与任意描述。匹配前缀 `^P\d+`；同时排除非目录项。
  const subdirs = entries.filter((d) => /^P\d+/.test(d));
  for (const sub of subdirs) {
    const modelPath = join(protocolDir, sub, 'model.md');
    try {
      const m = parseProtocolFile(modelPath);
      // E1-I7 修复：CLI 多协议场景下，self 协议被从同一文件重新 parse
      // （新对象，引用不同），引用比较 (`m !== model`) 无法识别。
      // 改为按"模型路径一致"排除 self（callers 应传 currentModelPath）。
      if (currentModelPath && resolve(modelPath) === resolve(currentModelPath)) {
        continue;
      }
      // key 用目录名（保留 P1-用户配额同步 形式），便于 issue 中标识来源
      peers[sub] = m;
    } catch {
      // 解析失败的子协议不阻塞当前检查
    }
  }
  // 当前模型也加入，便于 self-comparison
  peers[currentModel.metadata.name] = currentModel;
  return peers;
}

/**
 * 跑 m-check 全部规则
 *
 * @param model 已解析的协议模型
 * @param rootDirOrPeers 项目根目录（多协议场景下用于加载 peer 模型），
 *                       或直接传入 peer 模型字典（key 为协议 ID，如 'P2'）
 * @param currentModelPath 当前 model 文件的绝对路径（CLI 透传，用于 E1-I7 self 排除）
 */
export function runMCheck(
  model: SourceProtocolModel,
  rootDirOrPeers?: string | Record<string, SourceProtocolModel>,
  currentModelPath?: string
): MCheckReport {
  let peerModels: Record<string, SourceProtocolModel> | undefined;
  if (typeof rootDirOrPeers === 'string') {
    peerModels = loadPeerModels(rootDirOrPeers, model, currentModelPath);
  } else if (rootDirOrPeers && typeof rootDirOrPeers === 'object') {
    peerModels = rootDirOrPeers;
  }
  // 过滤掉 self-only peer（同名）；仅保留真 peer
  const filteredPeers: Record<string, SourceProtocolModel> | undefined =
    peerModels
      ? Object.fromEntries(
          Object.entries(peerModels).filter(
            ([, m]) => m !== model
          )
        )
      : undefined;

  const ctx: MCheckContext = {
    model,
    peerModels: filteredPeers,
  };

  const ruleResults: MCheckRuleResult[] = MCHECK_RULES.map((rule) => {
    const issues = rule.check(ctx);
    return {
      ruleId: rule.ruleId,
      passed: !issues.some((i: MCheckIssue) => i.severity === 'error'),
      issues,
    };
  });

  const allIssues = ruleResults.flatMap((r) => r.issues);
  const summary = {
    errors: allIssues.filter((i) => i.severity === 'error').length,
    warnings: allIssues.filter((i) => i.severity === 'warning').length,
    infos: allIssues.filter((i) => i.severity === 'info').length,
  };

  return {
    passed: summary.errors === 0,
    modelVersion: model.metadata.version,
    modelName: model.metadata.name,
    rules: ruleResults,
    summary,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * 人类可读报告打印（CLI 用）
 */
export function formatMCheckReport(report: MCheckReport): string {
  const lines: string[] = [];
  lines.push('═══ M 单元语义闸门（m-check）═══');
  lines.push(`模型: ${report.modelName ?? '(unknown)'} v${report.modelVersion ?? '(unknown)'}`);
  lines.push(`检查时间: ${report.checkedAt}`);
  lines.push('');
  for (const r of report.rules) {
    const status = r.passed ? '✓' : '✗';
    const issueCount = r.issues.length;
    lines.push(`[${status}] ${r.ruleId} (${issueCount} 项)`);
    for (const issue of r.issues) {
      const sevTag =
        issue.severity === 'error'
          ? '[ERROR]'
          : issue.severity === 'warning'
          ? '[WARN]'
          : '[INFO]';
      lines.push(`    ${sevTag} ${issue.elementType} <${issue.elementId}>: ${issue.message}`);
      if (issue.suggestion) lines.push(`        建议: ${issue.suggestion}`);
    }
  }
  lines.push('');
  lines.push(
    `汇总: errors=${report.summary.errors} warnings=${report.summary.warnings} infos=${report.summary.infos}`
  );
  lines.push(`总体: ${report.passed ? '✓ 通过' : '✗ 未通过'}`);
  return lines.join('\n');
}

/**
 * CLI 主入口（被 src/cli/index.ts 调用）：解析 + 跑规则，错误抛给上层
 */
export function mCheckCli(opts: {
  dir: string;
  modelPath?: string;
}): MCheckReport {
  const rootDir = opts.dir;
  const modelPath =
    opts.modelPath ?? join(rootDir, 'protocol', 'model.md');
  const model = parseProtocolFile(modelPath);
  // 透传 modelPath 给 loadPeerModels，让 self 协议（按路径识别）排除
  return runMCheck(model, rootDir, resolve(modelPath));
}

// 类型导出（外层按需 import）
export type { MCheckReport, MCheckContext, MCheckIssue } from './types.js';
export { MCHECK_RULES } from './rules.js';
export {
  ruleM001NamingConvention,
  ruleM002CrossProtocolIdUniqueness,
  ruleM003SubsidiaryEntityOwnership,
  ruleM004ForbiddenCharacters,
  ruleM005IdEscaping,
} from './rules.js';