/**
 * R-KIND-1~4 维度 kind 机械检查规则组（X2 / M10 / X3 / P1-3 判据10）
 *
 * 设计依据：
 * - refactor-proposal.md P0-1（X2 与 M10 分工，v0.2 二次修正：M10 只看 W(dim)，
 *   X2 以 kind（含人写断言）为判定主体）、P0-2（判据12）、P1-3（判据10）、R9
 * - execution-plan.md §S2（R-KIND-1~4 规则表 + S2-5 死代码自检）
 *
 * 组织方式：沿用 src/mcheck/rules.ts 的「规则注册表」（ruleId/description/check +
 * 注册表数组导出），非新建 rules/ 目录；checker 主入口（src/checker/index.ts）
 * 遍历注册表执行。
 *
 * 口径要点（与 src/model/dimension-kind.ts 的 buildDimensionKinds 保持单一事实源一致，
 * 但以错误收集替代抛错，避免混合维度中断整轮检查）：
 * - W(dim) = 所有 affectsDimensions 含该维度的转移的 triggerType 集合（去重排序）；
 * - 混合（role + 非 role）→ 模型矛盾（M10 子句1），不产出 kind；
 * - 人写断言（kindSource='asserted'）优先保留；断言 vs 推导冲突 → M10 子句2；
 * - 空集 → 不推导（dimension-kind-undetermined 降级，S1 已显式记录），此处不重复报。
 *
 * R9 口径（refactor-proposal.md R9）：X2 的检查范围应为 affectsDimensions ∪ sideEffects；
 * 但契约层 sideEffects/postconditionExpressions 是 SchemaExpression（JSON Schema 表达式），
 * 工具链无法从中静态判定「写入哪个维度」→ 显式承认该部分不可判定（降级显式）：
 * X2（R-KIND-1）的检查范围 = 转移层 affectsDimensions；sideEffects 侧的写入由 M10
 * （W(dim) 混合 / 断言冲突）兜底拦截，X2 未被 M10 完全收编的独立价值 = 抓
 * 「kind='observed'（含人写断言）却被 role 接口写入」的交叉违规。
 */

import type {
  SourceProtocolModel,
  StateDimension,
  CheckIssue,
} from '../model/types.js';
import type { DimensionKind, DimensionKindSource } from '../model/dimension-kind.js';

// ---------------------------------------------------------------------------
// 类型：规则定义（与 src/mcheck/types.ts 的 MCheckRule 同构，issue 复用 CheckIssue）
// ---------------------------------------------------------------------------

export type KindRuleId = 'R-KIND-1' | 'R-KIND-2' | 'R-KIND-3' | 'R-KIND-4';

export interface KindRuleContext {
  /** 当前模型 */
  model: SourceProtocolModel;
}

export interface KindRule {
  ruleId: KindRuleId;
  description: string;
  /** 校验函数：返回发现的 issue 列表（error=硬失败；warning=告警） */
  check(ctx: KindRuleContext): CheckIssue[];
}

// ---------------------------------------------------------------------------
// 公共：维度 kind 综合视图（错误收集式，不抛错）
// ---------------------------------------------------------------------------

/**
 * 单维度判定视图：
 * - conflict=true → W(dim) 混合（M10 子句1），不产出 kind；
 * - mismatch 非空 → 人写断言与机械推导冲突（M10 子句2）；
 * - kind 缺省 → W(dim)=∅ 未判定（dimension-kind-undetermined，S1 已降级记录）。
 */
export interface DimensionKindView {
  owner: string;
  dimension: string;
  kind?: DimensionKind;
  kindSource?: DimensionKindSource;
  /** W(dim)：写入该维度的 triggerType 集合（去重排序） */
  writers: string[];
  /** W(dim) 混合（role 与非 role 并存）标记 */
  conflict?: boolean;
  /** 断言 kind 与推导 kind 冲突记录 */
  mismatch?: { asserted: DimensionKind; derived: DimensionKind };
}

/** 遍历全部 StateDimension 实例（states[].dimensions + subsidiaryEntities[].stateSpace.dimensions） */
export function resolveDimensionKinds(model: SourceProtocolModel): DimensionKindView[] {
  const views: DimensionKindView[] = [];
  const ir = model.derivable;
  const collect = (owner: string, dim: StateDimension): void => {
    // W(dim)：写入该维度的 triggerType 集合（去重排序）——与 buildDimensionKinds 同一口径
    const writerSet = new Set<string>();
    for (const t of ir.transitions) {
      if ((t.affectsDimensions ?? []).includes(dim.name)) {
        writerSet.add(t.triggerType);
      }
    }
    const writers = Array.from(writerSet).sort();
    const hasRole = writers.includes('role');
    const hasNonRole = writers.some((w) => w === 'system' || w === 'external');

    const view: DimensionKindView = { owner, dimension: dim.name, writers };

    // 混合（同时含 role 与非 role）→ 写入方集合本身的矛盾（M10），与是否断言无关
    if (hasRole && hasNonRole) {
      view.conflict = true;
      views.push(view);
      return;
    }

    // 机械推导（仅 W(dim) 非空时有结果）
    const derived: DimensionKind | undefined = hasRole
      ? 'declared'
      : hasNonRole
        ? 'observed'
        : undefined;

    // 人写断言优先；断言 vs 推导不一致 → 冲突（M10 子句2）
    if (dim.kind && dim.kindSource === 'asserted') {
      view.kind = dim.kind;
      view.kindSource = 'asserted';
      if (derived && dim.kind !== derived) {
        view.mismatch = { asserted: dim.kind, derived };
      }
    } else if (derived) {
      view.kind = derived;
      view.kindSource = 'derived';
    }
    // 空集：kind/kindSource 缺省（dimension-kind-undetermined 降级，S1 已记录）
    views.push(view);
  };

  for (const s of ir.states) {
    for (const d of s.dimensions ?? []) collect(s.id, d);
  }
  for (const ent of ir.subsidiaryEntities ?? []) {
    for (const d of ent.stateSpace.dimensions) collect(ent.id, d);
  }
  return views;
}

// ---------------------------------------------------------------------------
// 公共：issue 构造与元素定位辅助
// ---------------------------------------------------------------------------

function kindError(message: string, elementId?: string, elementPath?: string): CheckIssue {
  return { severity: 'error', category: 'mechanical', message, elementId, elementPath };
}

function kindWarning(message: string, elementId?: string, elementPath?: string): CheckIssue {
  return { severity: 'warning', category: 'mechanical', message, elementId, elementPath };
}

/** 定位维度声明位置（states[i].dimensions[j] 或 subsidiaryEntities[i].stateSpace.dimensions[j]） */
function locateDimensionPath(
  model: SourceProtocolModel,
  owner: string,
  dimension: string
): string | undefined {
  const states = model.derivable.states;
  for (let i = 0; i < states.length; i++) {
    const dims = states[i].dimensions ?? [];
    const j = dims.findIndex((d) => d.name === dimension);
    if (j >= 0) return `derivable.states[${i}].dimensions[${j}].kind`;
  }
  const ents = model.derivable.subsidiaryEntities ?? [];
  for (let i = 0; i < ents.length; i++) {
    const dims = ents[i].stateSpace.dimensions ?? [];
    const j = dims.findIndex((d) => d.name === dimension);
    if (j >= 0) return `derivable.subsidiaryEntities[${i}].stateSpace.dimensions[${j}].kind`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// R-KIND-1（X2）：kind='observed'（含人写断言）⇒ 不得有任何 triggerType='role' 的接口写入
// ---------------------------------------------------------------------------
//
// 判定主体 = kind（含人写断言），检查范围 = 转移层 affectsDimensions（R9 口径：
// sideEffects 无法静态判定写入维度，显式降级）。正向命中即硬失败。

export const ruleRKind1ObservedNoRoleWriters: KindRule = {
  ruleId: 'R-KIND-1',
  description:
    'kind=observed 的维度（含人写断言）不得有任何 triggerType=role 的接口写入（X2，P0-1）',
  check(ctx: KindRuleContext): CheckIssue[] {
    const issues: CheckIssue[] = [];
    const views = resolveDimensionKinds(ctx.model);
    for (const v of views) {
      if (v.kind !== 'observed') continue;
      for (const t of ctx.model.derivable.transitions) {
        if (t.triggerType === 'role' && (t.affectsDimensions ?? []).includes(v.dimension)) {
          const sourceLabel = v.kindSource === 'asserted' ? '人写断言' : '机械推导';
          issues.push(
            kindError(
              `维度 "${v.dimension}"（${v.owner}）kind='observed'（${sourceLabel}），但转移 "${t.id}"（action=${t.action}）以 triggerType='role' 写入它；` +
                `observed 维度只能由事实侧（system/external）写入，角色不能凭意图制造事实 [R-KIND-1/X2]`,
              v.dimension,
              locateDimensionPath(ctx.model, v.owner, v.dimension)
            )
          );
        }
      }
    }
    return issues;
  },
};

// ---------------------------------------------------------------------------
// R-KIND-2（M10）：W(dim) 混合 ⇒ 硬失败；断言 kind 与推导 kind 冲突 ⇒ 硬失败
// ---------------------------------------------------------------------------
//
// 两条触发路径分别实现（S2-3 验收要求）：
// - 子句1：W(dim) 同时含 role 与非 role → dimension-kind-conflict（写入方集合矛盾）；
// - 子句2：人写断言 kind ≠ 机械推导 kind → dimension-kind-mismatch（断言与推导冲突）。
// 混合时优先子句1（模型矛盾），子句2 跳过（无推导基准）。

export const ruleRKind2MixedWritersAndAssertionConflict: KindRule = {
  ruleId: 'R-KIND-2',
  description:
    'W(dim) 混合（role 与非 role 并存）⇒ 硬失败；断言 kind 与推导 kind 冲突 ⇒ 硬失败（M10，P0-1）',
  check(ctx: KindRuleContext): CheckIssue[] {
    const issues: CheckIssue[] = [];
    const views = resolveDimensionKinds(ctx.model);
    for (const v of views) {
      const dimPath = locateDimensionPath(ctx.model, v.owner, v.dimension);
      if (v.conflict) {
        issues.push(
          kindError(
            `维度 "${v.dimension}"（${v.owner}）的写入方集合 W(dim) 同时含 role 与非 role（${v.writers.join(', ')}），` +
              `一个维度不可能既是「角色说了算」又是「只能观测」，模型矛盾 [R-KIND-2/M10-子句1:dimension-kind-conflict]`,
            v.dimension,
            dimPath
          )
        );
        continue;
      }
      if (v.mismatch) {
        issues.push(
          kindError(
            `维度 "${v.dimension}"（${v.owner}）人写断言 kind='${v.mismatch.asserted}'，` +
              `但机械推导为 '${v.mismatch.derived}'（W(dim)=${v.writers.length > 0 ? v.writers.join(',') : '∅'}），断言与推导冲突 [R-KIND-2/M10-子句2:dimension-kind-mismatch]`,
            v.dimension,
            dimPath
          )
        );
      }
    }
    return issues;
  },
};

// ---------------------------------------------------------------------------
// R-KIND-3（X3 / P0-2 判据12）：不变量涉及 observed 维度却标 always（或缺 boundMs）⇒ 硬失败
// ---------------------------------------------------------------------------
//
// 机械判定：
// - 「涉及 observed 维度」= 不变量 expression 文本包含 observed 维度名（ASCII 标识符词边界），
//   或 scopeStateIds 中某状态拥有 observed 维度（observedByOwner 命中）；
// - 「标 always / 缺 boundMs」= 无任何 timing 条目以该不变量 ID 为 source/target（等价 always），
//   或有关联 timing 但均未声明 boundMs（缺时限）。
// 合规形态 = 关联 timing 且至少一条带 boundMs（eventually_within）。

const OBSERVED_DIM_TOKEN_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** expression 是否包含维度名（ASCII 标识符按词边界；中文等直接包含判断） */
function expressionContainsDimension(expr: string, dimension: string): boolean {
  if (!dimension) return false;
  if (OBSERVED_DIM_TOKEN_RE.test(dimension)) {
    return new RegExp(
      `(?<![A-Za-z0-9_])${escapeRegExp(dimension)}(?![A-Za-z0-9_])`
    ).test(expr);
  }
  return expr.includes(dimension);
}

export const ruleRKind3ObservedInvariantNeedsBoundMs: KindRule = {
  ruleId: 'R-KIND-3',
  description:
    '不变量涉及 observed 维度却标 always（或缺 boundMs）⇒ 硬失败，须改为 eventually_within 并给出 boundMs（X3，P0-2 判据12）',
  check(ctx: KindRuleContext): CheckIssue[] {
    const issues: CheckIssue[] = [];
    const views = resolveDimensionKinds(ctx.model);
    const observedNames = new Set<string>();
    const observedByOwner = new Map<string, string[]>();
    for (const v of views) {
      if (v.kind !== 'observed') continue;
      observedNames.add(v.dimension);
      const list = observedByOwner.get(v.owner) ?? [];
      list.push(v.dimension);
      observedByOwner.set(v.owner, list);
    }
    if (observedNames.size === 0) return issues;

    const invs = ctx.model.derivable.invariants ?? [];
    const timings = ctx.model.derivable.timing ?? [];
    for (let i = 0; i < invs.length; i++) {
      const inv = invs[i];
      const expr = inv.expression ?? '';
      const viaExpr = Array.from(observedNames).filter((n) =>
        expressionContainsDimension(expr, n)
      );
      const viaScope = (inv.scopeStateIds ?? [])
        .flatMap((sid) => observedByOwner.get(sid) ?? [])
        .filter((n, idx, arr) => arr.indexOf(n) === idx);
      const involved = [...viaExpr, ...viaScope];
      if (involved.length === 0) continue;

      // timing 判定：存在关联 timing（source/target === inv.id）且至少一条带 boundMs → 合规
      const related = timings.filter((t) => t.source === inv.id || t.target === inv.id);
      if (related.some((t) => t.boundMs !== undefined)) continue;

      const reason =
        related.length === 0
          ? '未关联任何时序约束（timing.source/target 未指向该不变量），等价于声明为 always'
          : `关联的时序约束（${related.map((r) => r.id).join(', ')}）均未声明 boundMs`;
      issues.push(
        kindError(
          `不变量 "${inv.id}" 涉及 observed 维度（${involved.join(', ')}），但${reason}；` +
            `依赖 observed 维度的不变量必然 eventually_within，须给出 boundMs（P0-2 判据12）[R-KIND-3/X3]`,
          inv.id,
          `derivable.invariants[${i}].expression`
        )
      );
    }
    return issues;
  },
};

// ---------------------------------------------------------------------------
// R-KIND-4（X7 / P1-3 判据10）：roleId 无任何接口以其为 triggerRoleId ⇒ 告警（非硬失败）
// ---------------------------------------------------------------------------
//
// specifier 未把 triggerRoleId 投影到 InterfaceSpec（spec.triggerType 仅三值），
// 故在 IR 层（transition.triggerRoleId / transition.trigger）判定「有接口以该角色为触发者」，
// 与「角色发起的接口存在」语义等价。level=warning（角色 vs 实体三分需要人判断）。

export const ruleRKind4RoleWithoutTriggerInterface: KindRule = {
  ruleId: 'R-KIND-4',
  description:
    'roleId 无任何接口以其为 triggerRoleId ⇒ 告警（可疑：它不该是角色，P1-3 判据10）',
  check(ctx: KindRuleContext): CheckIssue[] {
    const issues: CheckIssue[] = [];
    const roles = ctx.model.metadata.roles ?? [];
    const triggered = new Set<string>();
    for (const t of ctx.model.derivable.transitions ?? []) {
      if (t.triggerRoleId) triggered.add(t.triggerRoleId);
      if (t.trigger) triggered.add(t.trigger);
    }
    for (let i = 0; i < roles.length; i++) {
      const role = roles[i];
      if (role.id && !triggered.has(role.id)) {
        issues.push(
          kindWarning(
            `角色 "${role.id}" 没有任何接口以其为触发者（triggerRoleId/trigger 均未引用）；` +
              `它可能只是实体而非角色，请判断是否应降级为实体或移出模型（P1-3 判据10）[R-KIND-4/X7]`,
            role.id,
            `metadata.roles[${i}].id`
          )
        );
      }
    }
    return issues;
  },
};

// ---------------------------------------------------------------------------
// 规则注册表（src/checker/index.ts 按此顺序调用）
// ---------------------------------------------------------------------------

export const KIND_RULES: KindRule[] = [
  ruleRKind1ObservedNoRoleWriters,
  ruleRKind2MixedWritersAndAssertionConflict,
  ruleRKind3ObservedInvariantNeedsBoundMs,
  ruleRKind4RoleWithoutTriggerInterface,
];

export const KIND_RULE_IDS: KindRuleId[] = KIND_RULES.map((r) => r.ruleId);

// 类型导出（外层按需 import）
export type { DimensionKind, DimensionKindSource };
