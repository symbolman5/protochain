/**
 * W1-a relations 关系投影器（06-execution-T2 TB1）
 *
 * 从状态机拓扑 / 不变量 / 时序【机械投影】四种关系 kind：
 *   ① sequence（"A 前置 B"）：转移对衔接——Tm 的 to 态 ∩ Tn 的 from 态 ≠ ∅，
 *      逐转移对独立成条，derived-from 为转移对 [Tm, Tn]；
 *   ② causes_state_change（逐转移）：Tn → to 态，derived-from: [Tn]；
 *   ③ invariant_scope（逐不变量）：INVn → 覆盖状态集合，
 *      scopeStateIds 空 = 全局（全部状态 id），derived-from: [INVn]；
 *   ④ timing（仅含 boundMs 的 deadline/timeout/response 型投影"≤X 时限"）；
 *      ordering/continuous/scheduled 显式 degraded 条目 + 降级原因，derived-from: [TIMn]。
 *
 * 定案（01-relations-modeling.md §3）：
 * - 条目粒度：逐转移（或转移对）独立成条，投影层不预聚合（接口级视图由消费方聚合）；
 * - derived-from 数组化：sequence 跨转移对（Tm+Tn），单来源 kind 退化为长度 1；
 * - 不做 excludes（无机械推导来源，R1-1 定案）；不做断言（W1-b 属 T3）；
 * - 确定性（可 diff）：同输入两次生成逐字节一致（key 顺序稳定）。
 *
 * 纯函数：模型数据 → RelationsProjection；无 I/O、无 AI、无推导外来源。
 */
import type { SourceProtocolModel, TransitionDef, InvariantDef, TimingDef } from '../model/types.js';

/** 关系投影 kind（W1-a；01 §3.1） */
export type RelationKind = 'sequence' | 'causes_state_change' | 'invariant_scope' | 'timing';

/** 单条关系投影条目（逐转移/转移对/不变量/时序独立成条） */
export interface RelationProjectionEntry {
  kind: RelationKind;
  /**
   * 关系起点元素 ID：
   * - sequence：前置转移 Tm（Tm 的 to 态与 Tn 的 from 态衔接）；
   * - causes_state_change：转移 Tn；
   * - invariant_scope：不变量 INVn；
   * - timing：时序源 source（动作名或状态 ID）。
   */
  fromId: string;
  /**
   * 关系终点元素 ID：
   * - sequence：后置转移 Tn；
   * - causes_state_change：目标状态 id；
   * - invariant_scope：覆盖状态集合（scopeStateIds 空 = 全局 → 'GLOBAL'）；
   * - timing：时序目标 target（动作名或状态 ID）。
   */
  toId: string;
  /** 推导来源（数组溯源）：sequence=转移对 [Tm,Tn]；其余单元素 [elementId] */
  derivedFrom: string[];
  /** invariant_scope：覆盖状态 ID 集合（scopeStateIds 空 = 全部状态 id） */
  scopeStateIds?: string[];
  /** timing：时限值（仅 boundMs 型承载） */
  boundMs?: number;
  /** timing 非 boundMs 型（ordering/continuous/scheduled）：显式降级标记 */
  degraded?: boolean;
  /** 降级原因（该类时序的"关系"语义未定义，不机械推导，显式记录） */
  degradedReason?: string;
}

/** relations 投影（W1-a；顶层 sourceModelVersion 与 WebDataJson 同源，供 N1 守卫复用） */
export interface RelationsProjection {
  sourceModelVersion: string;
  entries: RelationProjectionEntry[];
}

/** sequence 衔接条件：Tm 的 to 态 ∈ Tn 的 from 态（多源转移取集合语义） */
function transitionsLink(tm: TransitionDef, tn: TransitionDef): boolean {
  return tn.from.includes(tm.to);
}

/** timing 类型 → 降级原因（R1-3：非 boundMs 型的"关系"语义未定义） */
function degradedReasonFor(tm: TimingDef): string {
  if (tm.type === 'scheduled') {
    return `timing type=scheduled（定时规则 ${tm.schedule ?? '未声明'}）无 boundMs，"≤X 时限"语义未定义，显式降级`;
  }
  if (tm.type === 'continuous') {
    return 'timing type=continuous（onViolation 违约转移）无 boundMs，"≤X 时限"语义未定义，显式降级';
  }
  if (tm.type === 'ordering') {
    return 'timing type=ordering（无界先后序）无 boundMs，"≤X 时限"语义未定义，显式降级';
  }
  return `timing type=${tm.type} 无 boundMs，显式降级`;
}

/**
 * 机械投影 relations（W1-a / 06-execution-T2 TB1）。
 * 确定性：entries 按 (kind, fromId, toId, derivedFrom[0]) 稳定排序，
 * 同输入两次生成逐字节一致（key 顺序稳定 → 可 diff）。
 */
export function buildRelations(model: SourceProtocolModel): RelationsProjection {
  const transitions = model.derivable.transitions ?? [];
  const invariants = model.derivable.invariants ?? [];
  const timing = model.derivable.timing ?? [];
  const allStateIds = model.derivable.states.map((s) => s.id);
  const entries: RelationProjectionEntry[] = [];

  // ① causes_state_change：逐转移 → 目标状态（每条转移至少一条）
  for (const t of transitions) {
    entries.push({
      kind: 'causes_state_change',
      fromId: t.id,
      toId: t.to,
      derivedFrom: [t.id],
    });
  }

  // ② sequence：转移对衔接（Tm.to ∈ Tn.from；Tm ≠ Tn；逐对独立成条）
  for (const tm of transitions) {
    for (const tn of transitions) {
      if (tm.id === tn.id) continue;
      if (transitionsLink(tm, tn)) {
        entries.push({
          kind: 'sequence',
          fromId: tm.id,
          toId: tn.id,
          derivedFrom: [tm.id, tn.id],
        });
      }
    }
  }

  // ③ invariant_scope：逐不变量 → 覆盖状态集合（scopeStateIds 空 = 全部状态）
  for (const inv of invariants) {
    const scope =
      inv.scopeStateIds && inv.scopeStateIds.length > 0
        ? inv.scopeStateIds.slice()
        : allStateIds.slice();
    entries.push({
      kind: 'invariant_scope',
      fromId: inv.id,
      toId: scope.length > 0 ? scope.join(',') : 'GLOBAL',
      derivedFrom: [inv.id],
      scopeStateIds: scope,
    });
  }

  // ④ timing：仅 boundMs 型投影"≤X 时限"；其余显式 degraded（R1-3 定案）
  for (const tm of timing) {
    if (tm.boundMs !== undefined) {
      entries.push({
        kind: 'timing',
        fromId: tm.source,
        toId: tm.target,
        derivedFrom: [tm.id],
        boundMs: tm.boundMs,
      });
    } else {
      entries.push({
        kind: 'timing',
        fromId: tm.source,
        toId: tm.target,
        derivedFrom: [tm.id],
        degraded: true,
        degradedReason: degradedReasonFor(tm),
      });
    }
  }

  // 确定性：稳定排序（可 diff；同输入同输出）
  entries.sort((a, b) => {
    const k = a.kind.localeCompare(b.kind);
    if (k !== 0) return k;
    const f = a.fromId.localeCompare(b.fromId);
    if (f !== 0) return f;
    const t = a.toId.localeCompare(b.toId);
    if (t !== 0) return t;
    return (a.derivedFrom[0] ?? '').localeCompare(b.derivedFrom[0] ?? '');
  });

  return {
    sourceModelVersion: model.metadata.version,
    entries,
  };
}
