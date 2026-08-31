/**
 * X1（P0-1）：StateDimension kind 机械推导 —— 由「写入方集合」推导，不经由人手。
 *
 * 推导表（决策 D-1，维持两类不引入 computed）：
 *
 * | W(dim) = 写入该维度的 triggerType 集合       | 结果                              |
 * |---------------------------------------------|-----------------------------------|
 * | 只含 role                                   | kind='declared', kindSource='derived' |
 * | 只含非 role（system / external）            | kind='observed', kindSource='derived' |
 * | 同时含 role 与非 role（混合）               | 硬失败（模型矛盾），不产出 kind，message 含 dimension-kind-conflict |
 * | 空集                                        | 不推导，schemaDegradedReasons 记 dimension-kind-undetermined |
 *
 * W(dim) 口径：遍历 DerivableLayer.transitions ∪ operations（R1b 扩展，六张清单形态
 * 无 transitions，写入方来自「操作」段接口），凡 `affectsDimensions` 含该维度的
 * 转移/操作，取其 triggerType 入集合（去重排序）。
 * - 转移 triggerType：'role' | 'system' | 'external'；
 * - 操作 triggerType（四值）：role→'role'、observed/scheduled→'system'、cross→'external'
 *   （与 specifier mapOperationTriggerType 同一映射）。
 * 该口径与 P0-1「所有 affectsDimensions 含该维度的接口的 triggerType 集合」一致——
 * 系统接口由转移/操作推导，specifier 未投影 triggerType 到 spec，故在 IR 层直接取来源。
 *
 * 人写断言（kindSource='asserted'）：parser 解析 model.md 可选 kind 断言段后，
 * 维度对象自身带 kind + kindSource='asserted'。本模块对已断言维度保留断言值
 * （断言 vs 推导的比对是 X2/M10（checker）职责，不在本层）。混合（W(dim) 混合）
 * 为写入方集合本身的矛盾（M10），无论是否断言一律硬失败。
 *
 * 降级一律显式记录：空集维度进入 schemaDegradedReasons（dimension-kind-undetermined）。
 */

import type { DerivableLayer, OperationTriggerType, StateDimension } from './types.js';

export type DimensionKind = 'declared' | 'observed';
export type DimensionKindSource = 'derived' | 'asserted';

/** 单个维度的 kind 判定结果（维度级记录，供 specs.json 带出） */
export interface DimensionKindEntry {
  /** 维度所属上下文标识（状态 ID 或附属实体 ID） */
  owner: string;
  /** 维度名 */
  dimension: string;
  /** kind（机械推导或人写断言；未判定时缺省） */
  kind?: DimensionKind;
  /** 来源：derived（机械推导）/ asserted（人写断言） */
  kindSource?: DimensionKindSource;
  /** W(dim)：写入该维度的 triggerType 集合（去重排序） */
  writers: string[];
}

/** buildDimensionKinds 的返回：维度条目 + 显式降级记录 */
export interface DimensionKindsResult {
  entries: DimensionKindEntry[];
  /** 降级记录（空集维度 → dimension-kind-undetermined） */
  schemaDegradedReasons: string[];
}

/** 降级原因标记（B-1 分流：kind 未确定时显式记录） */
export const DIMENSION_KIND_UNDETERMINED = 'dimension-kind-undetermined';
/** 混合写入方硬失败标记 */
export const DIMENSION_KIND_CONFLICT = 'dimension-kind-conflict';

/**
 * 对 IR（DerivableLayer）做维度 kind 机械推导。
 *
 * 覆盖全部 StateDimension 实例：states[].dimensions + subsidiaryEntities[].stateSpace.dimensions。
 * 混合 → 抛 Error（message 含 dimension-kind-conflict）；空集 → 不推导并降级记录。
 */
export function buildDimensionKinds(ir: DerivableLayer): DimensionKindsResult {
  const entries: DimensionKindEntry[] = [];

  for (const s of ir.states) {
    for (const d of s.dimensions ?? []) {
      entries.push(deriveDimensionKind(s.id, d, ir));
    }
  }
  for (const ent of ir.subsidiaryEntities ?? []) {
    for (const d of ent.stateSpace.dimensions) {
      entries.push(deriveDimensionKind(ent.id, d, ir));
    }
  }

  const schemaDegradedReasons: string[] = [];
  for (const e of entries) {
    if (!e.kind) {
      schemaDegradedReasons.push(
        `${DIMENSION_KIND_UNDETERMINED}：维度 ${e.dimension}（${e.owner}）无任何写入方（W(dim)=∅），无法机械判定 kind，显式降级（B-1 分流）`
      );
    }
  }
  return { entries, schemaDegradedReasons };
}

function deriveDimensionKind(
  owner: string,
  dim: StateDimension,
  ir: DerivableLayer
): DimensionKindEntry {
  // W(dim)：写入该维度的 triggerType 集合（去重排序）
  // R1b：transitions ∪ operations（六张清单形态无 transitions，写入方来自操作段接口）
  const writerSet = new Set<string>();
  for (const t of ir.transitions) {
    if ((t.affectsDimensions ?? []).includes(dim.name)) {
      writerSet.add(t.triggerType);
    }
  }
  for (const op of ir.operations ?? []) {
    if ((op.affectsDimensions ?? []).includes(dim.name)) {
      writerSet.add(mapOperationTriggerType(op.triggerType));
    }
  }
  const writers = Array.from(writerSet).sort();

  const hasRole = writers.includes('role');
  const hasNonRole = writers.some((w) => w === 'system' || w === 'external');

  // 混合（同时含 role 与非 role）→ 硬失败（M10：写入方集合本身的矛盾，与是否断言无关）
  if (hasRole && hasNonRole) {
    throw new Error(
      `${DIMENSION_KIND_CONFLICT}：维度 ${dim.name}（${owner}）的写入方集合 W(dim) 同时含 role 与非 role（${writers.join(', ')}），模型矛盾，无法机械推导 kind（P0-1 决策表）`
    );
  }

  // 人写断言优先（X2/M10 在 checker 层做「断言 vs 推导」比对，不在此层）
  if (dim.kind && dim.kindSource === 'asserted') {
    return { owner, dimension: dim.name, kind: dim.kind, kindSource: 'asserted', writers };
  }

  const entry: DimensionKindEntry = { owner, dimension: dim.name, writers };
  if (hasRole) {
    entry.kind = 'declared';
    entry.kindSource = 'derived';
  } else if (hasNonRole) {
    entry.kind = 'observed';
    entry.kindSource = 'derived';
  }
  // 空集：kind/kindSource 缺省，由调用方记降级
  return entry;
}

/**
 * R1b：六张清单操作触发类型（四值）→ W(dim) 集合成员（三值）映射。
 * 与 specifier 的 mapOperationTriggerType 保持同一映射（单一事实源，避免两处漂移）：
 * - role → 'role'（角色意图可写 declared）
 * - observed / scheduled → 'system'（系统观测到的事实）
 * - cross → 'external'（跨域事件）
 */
export function mapOperationTriggerType(
  t: OperationTriggerType
): 'role' | 'system' | 'external' {
  switch (t) {
    case 'role':
      return 'role';
    case 'observed':
    case 'scheduled':
      return 'system';
    case 'cross':
      return 'external';
  }
}
