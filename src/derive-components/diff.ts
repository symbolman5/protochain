/**
 * T1c：组件模型同步机制 —— 候选骨架差分（derived 覆盖 / asserted 仲裁 / 未变不动）
 *
 * 协议修改 → 重推骨架（derive-components）→ 与既有骨架/已确认 components.md 差分：
 * - added（derived 项）：协议新增接口/维度/关系 → 新候选，机械自动覆盖（无心理负担）；
 * - removed（asserted 项）：既有映射引用失效（接口/维度/关系被删除）→ 进仲裁清单，
 *   机械只标记不覆盖（组件改名？删映射？由人仲裁）；
 * - unchanged：不动。
 *
 * R-KIND-10 双向失配机械信号沿用既有实现：新增未映射告警（B 侧 warning）/
 * 删除悬空硬失败（A 侧 error），本模块不重复。
 */

import type { DerivedComponentSkeleton } from './index.js';

// ============================================================================
// 类型定义
// ============================================================================

export interface ComponentDiffItem {
  /** 元素类型：interface（接口→组件）/ dimension（维度→存储）/ relation（组件→传输）/ contract（接口契约） */
  elementType: 'interface' | 'dimension' | 'relation' | 'contract';
  /** 元素标识（接口名 / 维度名 / "from→to" / 契约 interface） */
  elementId: string;
  /** derived（机械自动覆盖）/ asserted（进仲裁清单，机械只标记） */
  disposition: 'derived' | 'asserted';
}

export interface ComponentSkeletonDiff {
  added: ComponentDiffItem[];
  removed: ComponentDiffItem[];
  unchanged: ComponentDiffItem[];
  /** 差分时间 */
  diffedAt: string;
}

// ============================================================================
// 差分逻辑
// ============================================================================

function unionKeys(a: Set<string>, b: Set<string>): string[] {
  return Array.from(new Set([...a, ...b])).sort();
}

/**
 * 比较新旧候选骨架（pure function，确定性）。
 * - added：旧无新有 → derived（机械覆盖候选）；
 * - removed：旧有新无 → asserted（既有映射引用失效，进仲裁清单）；
 * - unchanged：两方都有 → 不动。
 */
export function diffComponentSkeletons(
  oldSkeleton: DerivedComponentSkeleton,
  newSkeleton: DerivedComponentSkeleton
): ComponentSkeletonDiff {
  const added: ComponentDiffItem[] = [];
  const removed: ComponentDiffItem[] = [];
  const unchanged: ComponentDiffItem[] = [];

  const oldInterfaces = new Set((oldSkeleton.mapping.interfaceImplementations ?? []).map((m) => m.interface));
  const newInterfaces = new Set((newSkeleton.mapping.interfaceImplementations ?? []).map((m) => m.interface));
  for (const k of unionKeys(oldInterfaces, newInterfaces)) {
    const hasOld = oldInterfaces.has(k);
    const hasNew = newInterfaces.has(k);
    if (hasOld && hasNew) unchanged.push({ elementType: 'interface', elementId: k, disposition: 'derived' });
    else if (hasNew) added.push({ elementType: 'interface', elementId: k, disposition: 'derived' });
    else removed.push({ elementType: 'interface', elementId: k, disposition: 'asserted' });
  }

  const oldDims = new Set((oldSkeleton.mapping.dimensionStorage ?? []).map((m) => m.dimension));
  const newDims = new Set((newSkeleton.mapping.dimensionStorage ?? []).map((m) => m.dimension));
  for (const k of unionKeys(oldDims, newDims)) {
    const hasOld = oldDims.has(k);
    const hasNew = newDims.has(k);
    if (hasOld && hasNew) unchanged.push({ elementType: 'dimension', elementId: k, disposition: 'derived' });
    else if (hasNew) added.push({ elementType: 'dimension', elementId: k, disposition: 'derived' });
    else removed.push({ elementType: 'dimension', elementId: k, disposition: 'asserted' });
  }

  const oldRels = new Set((oldSkeleton.mapping.componentTransfers ?? []).map((m) => `${m.from}→${m.to}`));
  const newRels = new Set((newSkeleton.mapping.componentTransfers ?? []).map((m) => `${m.from}→${m.to}`));
  for (const k of unionKeys(oldRels, newRels)) {
    const hasOld = oldRels.has(k);
    const hasNew = newRels.has(k);
    if (hasOld && hasNew) unchanged.push({ elementType: 'relation', elementId: k, disposition: 'derived' });
    else if (hasNew) added.push({ elementType: 'relation', elementId: k, disposition: 'derived' });
    else removed.push({ elementType: 'relation', elementId: k, disposition: 'asserted' });
  }

  const oldContracts = new Set((oldSkeleton.contracts ?? []).map((c) => c.interface));
  const newContracts = new Set((newSkeleton.contracts ?? []).map((c) => c.interface));
  for (const k of unionKeys(oldContracts, newContracts)) {
    const hasOld = oldContracts.has(k);
    const hasNew = newContracts.has(k);
    if (hasOld && hasNew) unchanged.push({ elementType: 'contract', elementId: k, disposition: 'derived' });
    else if (hasNew) added.push({ elementType: 'contract', elementId: k, disposition: 'derived' });
    else removed.push({ elementType: 'contract', elementId: k, disposition: 'asserted' });
  }

  return { added, removed, unchanged, diffedAt: new Date().toISOString() };
}

/** 差异清单人读摘要（CLI 打印用） */
export function formatComponentDiffSummary(diff: ComponentSkeletonDiff): string {
  const lines: string[] = [
    `  组件模型差异：added(derived 覆盖) ${diff.added.length} · removed(asserted 仲裁) ${diff.removed.length} · unchanged ${diff.unchanged.length}`,
  ];
  if (diff.added.length > 0) {
    lines.push(`  derived（协议新增 → 重推候选覆盖）：`);
    for (const it of diff.added) lines.push(`    + ${it.elementType} ${it.elementId}`);
  }
  if (diff.removed.length > 0) {
    lines.push(`  asserted（引用失效 → 人工仲裁：组件改名？删映射？机械只标记）：`);
    for (const it of diff.removed) lines.push(`    - ${it.elementType} ${it.elementId}`);
  }
  return lines.join('\n');
}
