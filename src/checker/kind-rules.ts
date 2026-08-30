/**
 * R-KIND-1~9 维度 kind 机械检查规则组（X2 / M10 / X3 / P1-3 判据10 / X7 / X8 / X9 / X17）
 *
 * 设计依据：
 * - refactor-proposal.md P0-1（X2 与 M10 分工，v0.2 二次修正：M10 只看 W(dim)，
 *   X2 以 kind（含人写断言）为判定主体）、P0-2（判据12）、P1-3（判据10）、
 *   P1-4（判据3）、P1-5（判据11）、P1-9（guard 可执行化）、R9、D-2（迁移截止日 2026-09-30）
 * - execution-plan.md §S2（R-KIND-1~4 规则表 + S2-5 死代码自检）、§S5（R-KIND-5~9 +
 *   S5-6 死代码自检）
 *
 * 组织方式：沿用 src/mcheck/rules.ts 的「规则注册表」（ruleId/description/check +
 * 注册表数组导出），非新建 rules/ 目录；checker 主入口（src/checker/index.ts）
 * 遍历注册表执行。
 *
 * 规则分工：
 * - R-KIND-1~4（S2 交付）：维度 kind（X2 / M10 / X3 / P1-3 判据10 分支①）；
 * - R-KIND-5/6（S5a / X7 / P1-3 判据10 分支②③）：角色 vs 实体三分完整，
 *   与 R-KIND-4 去重（R-KIND-4 保留分支①「幽灵角色告警」，本组不再重复报分支①）；
 * - R-KIND-7（S5a / X8 / P1-4 判据3）：机械只筛候选（affectsDimensions 为空 ⇒ ③候选），
 *   ②③之分人工复核留痕（B-2，留痕 = issue 描述字段 / acceptance-record）；
 * - R-KIND-8（S5a / X9 / P1-5 判据11）：跨 ≥2 实体未声明事务边界 ⇒ 新模型硬失败；
 *   老模型（无事务边界段）告警 + 迁移截止日 2026-09-30（决策 D-2）；
 * - R-KIND-9（S5a / X17 / P1-9）：guard 可执行化覆盖率统计 + 未命中显式降级
 *   （口径沿用 W2/G3 与 S4 置否判定）。
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
  SchemaExpression,
  CheckIssue,
  ComponentMappingDef,
} from '../model/types.js';
import type { DimensionKind, DimensionKindSource } from '../model/dimension-kind.js';
import { tryParseGuardSchema } from '../specifier/schema-builder.js';
import Ajv from 'ajv';

// ---------------------------------------------------------------------------
// 类型：规则定义（与 src/mcheck/types.ts 的 MCheckRule 同构，issue 复用 CheckIssue）
// ---------------------------------------------------------------------------

export type KindRuleId =
  | 'R-KIND-1'
  | 'R-KIND-2'
  | 'R-KIND-3'
  | 'R-KIND-4'
  | 'R-KIND-5'
  | 'R-KIND-6'
  | 'R-KIND-7'
  | 'R-KIND-8'
  | 'R-KIND-9'
  | 'R-KIND-10'
  | 'R-KIND-11'
  | 'R-KIND-12'
  | 'R-KIND-13'
  | 'R-KIND-14'
  | 'R-KIND-15';

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
// R-KIND-5/6（X7 / P1-3 判据10 分支②③）：角色 vs 实体三分完整
// ---------------------------------------------------------------------------
//
// 与 R-KIND-4（分支①「幽灵角色告警」）去重：R-KIND-4 保留「无任何接口以该角色为
// 触发者 ⇒ 告警」的基础告警；R-KIND-5/6 只对**无触发接口的角色**做进一步的处置
// 细分建议（分支②③），不再重复报分支①。三条分支全告警级（需人判断，非硬失败）。
//
// 机械信号（IR 层，单一事实源）：
// - 「无以其为发起者的接口」= 无任何转移以该角色为 triggerRoleId/trigger（同 R-KIND-4）；
// - 「完全可控组件」= 该角色出现在某 states[].roleIds（状态归属该角色 = 被系统操作的
//   实体特征，而非行为者）→ 建议降级为实体（分支②）；
// - 「非本系统组件且无程序化交互」= 该角色不出现在任何 states[].roleIds，且不在
//   contractInput.parties（契约方 = 程序化交互方）→ 与系统完全游离 → 建议移出模型（分支③）。

/** 收集「无任何接口以该角色为触发者」的角色 ID 集合（与 R-KIND-4 同一判定口径） */
function roleIdsWithoutTriggerInterface(model: SourceProtocolModel): Set<string> {
  const triggered = new Set<string>();
  for (const t of model.derivable.transitions ?? []) {
    if (t.triggerRoleId) triggered.add(t.triggerRoleId);
    if (t.trigger) triggered.add(t.trigger);
  }
  const roles = model.metadata.roles ?? [];
  const out = new Set<string>();
  for (const r of roles) {
    if (r.id && !triggered.has(r.id)) out.add(r.id);
  }
  return out;
}

export const ruleRKind5ControllableComponentSuggestEntity: KindRule = {
  ruleId: 'R-KIND-5',
  description:
    '无触发接口的角色若为完全可控组件（出现在 states[].roleIds）⇒ 建议降级为实体（X7，P1-3 判据10 分支②）',
  check(ctx: KindRuleContext): CheckIssue[] {
    const issues: CheckIssue[] = [];
    const untriggered = roleIdsWithoutTriggerInterface(ctx.model);
    if (untriggered.size === 0) return issues;
    const ownedRoleIds = new Set<string>();
    for (const s of ctx.model.derivable.states ?? []) {
      for (const rid of s.roleIds ?? []) ownedRoleIds.add(rid);
    }
    const roles = ctx.model.metadata.roles ?? [];
    for (let i = 0; i < roles.length; i++) {
      const role = roles[i];
      if (!role.id || !untriggered.has(role.id)) continue;
      if (!ownedRoleIds.has(role.id)) continue;
      issues.push(
        kindWarning(
          `角色 "${role.id}" 没有任何接口以其为发起者，但它是完全可控组件（出现在状态 roleIds，状态由本系统掌控）；` +
            `它更可能是被系统操作的实体而非行为者，建议降级为实体（P1-3 判据10 分支②，需人判断）[R-KIND-5/X7]`,
          role.id,
          `metadata.roles[${i}].id`
        )
      );
    }
    return issues;
  },
};

export const ruleRKind6NonSystemComponentSuggestRemove: KindRule = {
  ruleId: 'R-KIND-6',
  description:
    '无触发接口、非本系统组件（不在任何 states[].roleIds）且无程序化交互（不在契约 parties）⇒ 建议移出模型（X7，P1-3 判据10 分支③）',
  check(ctx: KindRuleContext): CheckIssue[] {
    const issues: CheckIssue[] = [];
    const untriggered = roleIdsWithoutTriggerInterface(ctx.model);
    if (untriggered.size === 0) return issues;
    const ownedRoleIds = new Set<string>();
    for (const s of ctx.model.derivable.states ?? []) {
      for (const rid of s.roleIds ?? []) ownedRoleIds.add(rid);
    }
    const parties = new Set<string>(ctx.model.contractInput?.parties ?? []);
    const roles = ctx.model.metadata.roles ?? [];
    for (let i = 0; i < roles.length; i++) {
      const role = roles[i];
      if (!role.id || !untriggered.has(role.id)) continue;
      if (ownedRoleIds.has(role.id)) continue;
      if (parties.has(role.id)) continue;
      issues.push(
        kindWarning(
          `角色 "${role.id}" 没有任何接口以其为发起者，不出现在任何状态 roleIds，也不在契约层 parties（无程序化交互）；` +
            `它是非本系统组件，与协议无实质交互，建议移出模型（P1-3 判据10 分支③，需人判断）[R-KIND-6/X7]`,
          role.id,
          `metadata.roles[${i}].id`
        )
      );
    }
    return issues;
  },
};

// ---------------------------------------------------------------------------
// R-KIND-7（X8 / P1-4 判据3）：机械只筛候选（affectsDimensions 为空 ⇒ ③候选）
// ---------------------------------------------------------------------------
//
// 判据3 三分支：①改变状态（affectsDimensions 非空）⇒ 进模型、参与用例生成；
// ②不改状态但行为路径由状态决定 ⇒ 进模型、参与用例生成；
// ③只把状态交给调用方观测 ⇒ 不进模型、不生成用例。
//
// 机械只筛候选（execution-plan §S5）：affectsDimensions 为空 ⇒ ③候选（②③之分无法
// 纯机械判定——「行为路径由状态决定」需要 preconditions 引用 StateDimension 且存在
// 分支语义，超出 IR 可判定范围）→ 告警 + 人工复核留痕（B-2：留痕 = issue 描述字段 /
// acceptance-record），不静默（W2 同款降级口径）。

export const ruleRKind7NoStateChangeCandidate: KindRule = {
  ruleId: 'R-KIND-7',
  description:
    '接口未声明任何状态变更（affectsDimensions 为空）⇒ ③候选，②③之分人工复核留痕（X8，P1-4 判据3）',
  check(ctx: KindRuleContext): CheckIssue[] {
    const issues: CheckIssue[] = [];
    const transitions = ctx.model.derivable.transitions ?? [];
    for (let i = 0; i < transitions.length; i++) {
      const t = transitions[i];
      const dims = t.affectsDimensions ?? [];
      if (dims.length > 0) continue; // 分支①：改变状态 → 进模型，不筛候选
      const hasGuard = Boolean(t.guard && t.guard.trim() !== '');
      const hint = hasGuard
        ? '该接口有 guard（行为可能由状态决定，疑似分支②）'
        : '该接口无 guard（仅把状态交给调用方观测或纯状态推进，疑似分支③）';
      issues.push(
        kindWarning(
          `接口/转移 "${t.id}"（action=${t.action}）未声明任何状态变更（affectsDimensions 为空），按判据3 为 ③候选：` +
            `${hint}；②③之分需人工复核并留痕（B-2：留痕=acceptance-record 或本 issue 描述字段），` +
            `机械层不做②③判定（P1-4 判据3，W2 同款显式降级不静默）[R-KIND-7/X8]`,
          t.id,
          `derivable.transitions[${i}].affectsDimensions`
        )
      );
    }
    return issues;
  },
};

// ---------------------------------------------------------------------------
// R-KIND-8（X9 / P1-5 判据11）：跨 ≥2 实体未声明事务边界
// ---------------------------------------------------------------------------
//
// 机械判定：
// - 维度 → 实体（owner）映射：states[].dimensions[].name → 状态 ID；附属实体
//   stateSpace.dimensions[].name → 附属实体 ID；
// - 转移 affectsDimensions 命中的 owner 集合 ≥ 2 → 跨实体操作；
// - 「已声明事务边界」= 模型声明的事务边界段中存在 interface 匹配该转移的 action/id；
// - 未声明：
//   - 模型已启用事务边界段（transactionBoundaries !== undefined，新模型形态）→ error（硬失败）；
//   - 模型未启用（undefined，老模型形态）→ warning + 迁移截止日 2026-09-30（决策 D-2）。

/** 迁移截止日（决策 D-2，refactor-proposal.md §1）：老模型必须在该日期前声明事务边界 */
export const TRANSACTION_BOUNDARY_MIGRATION_DEADLINE = '2026-09-30';

/** 维度名 → 实体（owner）映射（states + 附属实体，单一事实源） */
export function buildDimensionOwnerMap(model: SourceProtocolModel): Map<string, string> {
  const map = new Map<string, string>();
  for (const s of model.derivable.states ?? []) {
    for (const d of s.dimensions ?? []) {
      if (d.name && !map.has(d.name)) map.set(d.name, s.id);
    }
  }
  for (const ent of model.derivable.subsidiaryEntities ?? []) {
    for (const d of ent.stateSpace.dimensions ?? []) {
      if (d.name && !map.has(d.name)) map.set(d.name, ent.id);
    }
  }
  return map;
}

export const ruleRKind8CrossEntityNeedsTransactionBoundary: KindRule = {
  ruleId: 'R-KIND-8',
  description:
    'affectsDimensions 跨 ≥2 实体未声明事务边界 ⇒ 新模型硬失败；老模型告警至 2026-09-30（X9，P1-5 判据11，决策 D-2）',
  check(ctx: KindRuleContext): CheckIssue[] {
    const issues: CheckIssue[] = [];
    const ownerMap = buildDimensionOwnerMap(ctx.model);
    const boundaries = ctx.model.derivable.transactionBoundaries;
    const declaredIfaces = new Set<string>((boundaries ?? []).map((b) => b.interface));
    const transitions = ctx.model.derivable.transitions ?? [];
    for (let i = 0; i < transitions.length; i++) {
      const t = transitions[i];
      const dims = t.affectsDimensions ?? [];
      if (dims.length < 2) continue; // 单维度或空 → 不可能跨实体
      const owners = new Set<string>();
      for (const dim of dims) {
        const owner = ownerMap.get(dim);
        if (owner) owners.add(owner);
      }
      if (owners.size < 2) continue; // 维度未跨 ≥2 实体（含未知 owner 维度不夸大判定）
      if (declaredIfaces.has(t.action) || declaredIfaces.has(t.id)) continue; // 已声明
      const ownersText = Array.from(owners).join(', ');
      const dimsText = dims.join(', ');
      if (boundaries !== undefined) {
        // 新模型（已启用事务边界段）：未声明 → 硬失败
        issues.push(
          kindError(
            `转移 "${t.id}"（action=${t.action}）的 affectsDimensions（${dimsText}）跨 ${owners.size} 个实体（${ownersText}），` +
              `但未在「事务边界」段声明事务边界（same_transaction / async_compensation）；` +
              `多实体操作的原子性/时间语义未定，直接决定架构，必须显式声明（P1-5 判据11）[R-KIND-8/X9]`,
            t.id,
            `derivable.transitions[${i}].affectsDimensions`
          )
        );
      } else {
        // 老模型（未启用事务边界段）：告警 + 迁移截止日（决策 D-2）
        issues.push(
          kindWarning(
            `转移 "${t.id}"（action=${t.action}）的 affectsDimensions（${dimsText}）跨 ${owners.size} 个实体（${ownersText}），` +
              `未声明事务边界；老模型请在「事务边界」段补充声明（same_transaction / async_compensation），` +
              `迁移截止日 ${TRANSACTION_BOUNDARY_MIGRATION_DEADLINE}（决策 D-2）[R-KIND-8/X9]`,
            t.id,
            `derivable.transitions[${i}].affectsDimensions`
          )
        );
      }
    }
    return issues;
  },
};

// ---------------------------------------------------------------------------
// R-KIND-9（X17 / P1-9）：guard 可执行化 —— 受限谓词覆盖率统计 + 未命中显式降级
// ---------------------------------------------------------------------------
//
// 口径（沿用 W2/G3 与 S4 置否判定，单一事实源 = tryParseGuardSchema/受限谓词翻译）：
// - 「命中」= 该转移的 preconditions（契约层结构化表达式优先，否则 guard 受限谓词翻译）
//   全部 kind='json-schema' 且 ajv 可编译（S4 resolveX6Conjuncts 同一判定方向）；
// - 「未命中」= 任一 preconditions 为 description-only / legacy-stub，或 ajv 编译失败
//   → 显式降级：产生 warning issue 记录 reason（不静默），spec 层 schemaDegradedReasons
//   由 specifier 同步填充（R2-1 既有行为）；
// - 覆盖率 = 命中 guard 数 / 有 guard 的转移总数（机械可查，S5-4）。

export interface GuardCoverageStats {
  /** 有 guard（或契约 preconditions）的转移总数 */
  total: number;
  /** 命中：preconditions 全部 json-schema 且 ajv 可编译 */
  hit: number;
  /** 未命中：存在 description-only/legacy-stub 或 ajv 编译失败 */
  miss: number;
  /** 覆盖率（hit/total；total=0 时为 1） */
  hitRate: number;
  /** 未命中明细（显式降级记录，不静默） */
  degraded: Array<{ transitionId: string; action: string; reason: string }>;
}

/** 解析转移的 preconditions 表达式（契约层优先，缺省 guard 受限谓词翻译；同 S4 口径） */
function resolveTransitionPreconditions(
  model: SourceProtocolModel,
  t: { id: string; action: string; guard?: string }
): SchemaExpression[] {
  const contracts = model.contractInput?.contracts ?? [];
  const contract = contracts.find(
    (c) => c.interface === t.action || c.interface === t.id || c.sourceId === t.id
  );
  if (contract?.preconditions && contract.preconditions.length > 0) {
    return contract.preconditions;
  }
  if (t.guard && t.guard.trim() !== '') {
    const expr = tryParseGuardSchema(t.guard);
    if (expr) return [expr];
  }
  return [];
}

/**
 * X17（P1-9）受限谓词对 guard 的覆盖率统计（机械可查，S5-4）。
 * - 有 guard（或契约 preconditions）的转移计入分母；
 * - 命中 = preconditions 全部 kind='json-schema' 且 ajv 可编译；
 * - 未命中 → 显式降级记录（reason），不静默。
 */
export function computeGuardCoverage(model: SourceProtocolModel): GuardCoverageStats {
  const stats: GuardCoverageStats = {
    total: 0,
    hit: 0,
    miss: 0,
    hitRate: 1,
    degraded: [],
  };
  const ajv = new Ajv({ allErrors: true, strict: false });
  const transitions = model.derivable.transitions ?? [];
  for (const t of transitions) {
    const pre = resolveTransitionPreconditions(model, t);
    if (pre.length === 0) continue; // 无 guard → 不计入分母
    stats.total++;
    const allStructured = pre.every((p) => p.kind === 'json-schema' && p.schema != null);
    if (!allStructured) {
      stats.miss++;
      const bad = pre.find((p) => p.kind !== 'json-schema' || p.schema == null);
      stats.degraded.push({
        transitionId: t.id,
        action: t.action,
        reason: `guard preconditions 含 ${bad?.kind ?? 'invalid'} 表达式「${bad?.description ?? ''}」未机械结构化（未按受限谓词语法书写，显式降级不静默，R2-1）`,
      });
      continue;
    }
    // 全部 json-schema：ajv 可编译校验（S5-4：命中 = json-schema 且 ajv 可编译）
    let compileOk = true;
    for (const p of pre) {
      try {
        ajv.compile(p.schema as object);
      } catch (err) {
        compileOk = false;
        stats.degraded.push({
          transitionId: t.id,
          action: t.action,
          reason: `guard preconditions 的 JSON Schema 不可被 ajv 编译：${err instanceof Error ? err.message : String(err)}`,
        });
        break;
      }
    }
    if (compileOk) {
      stats.hit++;
    } else {
      stats.miss++;
    }
  }
  stats.hitRate = stats.total > 0 ? stats.hit / stats.total : 1;
  return stats;
}

export const ruleRKind9GuardExecutableCoverage: KindRule = {
  ruleId: 'R-KIND-9',
  description:
    'guard 可执行化：受限谓词覆盖率统计 + 未命中显式降级记录（X17，P1-9，口径沿用 W2/G3 与 S4 置否判定）',
  check(ctx: KindRuleContext): CheckIssue[] {
    const issues: CheckIssue[] = [];
    const stats = computeGuardCoverage(ctx.model);
    for (const d of stats.degraded) {
      issues.push(
        kindWarning(
          `转移 "${d.transitionId}"（action=${d.action}）的 guard 未可执行化（X17）：${d.reason}` +
            `；spec 层 schemaDegradedReasons 已同步记录，人工只填谓词落地实现，路径/校验/编排由模型生成（P1-9 诚实天花板）[R-KIND-9/X17]`,
          d.transitionId,
          'derivable.transitions.guard'
        )
      );
    }
    return issues;
  },
};

// ---------------------------------------------------------------------------
// R-KIND-10（X18 / P1-10）：组件映射段交叉一致性
// ---------------------------------------------------------------------------
//
// 触发条件：模型已启用组件映射段（derivable.componentMapping !== undefined，新模型形态）。
// 老模型（段不存在 → undefined）→ 整段零输出（老模型零回归）。
//
// 两个方向（机械验收 S5-5）：
// - A（error，硬失败）：映射表出现的 interface / dimension 必须在 IR 中存在。
//   - interfaceImplementations[].interface ∈ 接口命名空间（transitions[].action ∪ transitions[].id ∪ contracts[].interface）；
//   - dimensionStorage[].dimension ∈ 维度命名空间（states[].dimensions[].name ∪
//     subsidiaryEntities[].stateSpace.dimensions[].name）。
//   引用悬空 = 服务划分 / 存储 schema 推导建立在不存在对象上，与 checkCrossReferences
//   引用闭合口径一致（error 级）。
// - B（warning，不阻断）：IR 中未被映射者显式列出（不静默遗漏，进入报告输出）。
//   段已启用但仍有接口 / 维度未进映射表 → 一条汇总 warning 逐一列出。

/** 收集 IR 接口命名空间：transitions[].action ∪ transitions[].id ∪ contracts[].interface */
export function collectInterfaceUniverse(model: SourceProtocolModel): Set<string> {
  const names = new Set<string>();
  for (const t of model.derivable.transitions ?? []) {
    if (t.id) names.add(t.id);
    if (t.action) names.add(t.action);
  }
  for (const c of model.contractInput?.contracts ?? []) {
    if (c.interface) names.add(c.interface);
  }
  return names;
}

/** 收集 IR 维度命名空间：states[].dimensions[].name ∪ subsidiaryEntities[].stateSpace.dimensions[].name */
export function collectDimensionUniverse(model: SourceProtocolModel): Set<string> {
  const names = new Set<string>();
  for (const s of model.derivable.states ?? []) {
    for (const d of s.dimensions ?? []) {
      if (d.name) names.add(d.name);
    }
  }
  for (const ent of model.derivable.subsidiaryEntities ?? []) {
    for (const d of ent.stateSpace.dimensions ?? []) {
      if (d.name) names.add(d.name);
    }
  }
  return names;
}

/** 组件映射的平铺条目视图（便于 rule 内部遍历三张表） */
export interface ComponentMappingView {
  mapping: ComponentMappingDef;
  interfaceRows: Array<{ interface: string; component: string }>;
  dimensionRows: Array<{ dimension: string; table: string }>;
  transferRows: Array<{ from: string; to: string; channel: string; mode: string }>;
}

export function flattenComponentMapping(mapping: ComponentMappingDef): ComponentMappingView {
  return {
    mapping,
    interfaceRows: (mapping.interfaceImplementations ?? []).map((m) => ({
      interface: m.interface,
      component: m.component,
    })),
    dimensionRows: (mapping.dimensionStorage ?? []).map((m) => ({
      dimension: m.dimension,
      table: m.table,
    })),
    transferRows: (mapping.componentTransfers ?? []).map((m) => ({
      from: m.from,
      to: m.to,
      channel: m.channel,
      mode: m.mode,
    })),
  };
}

export const ruleRKind10ComponentMappingConsistency: KindRule = {
  ruleId: 'R-KIND-10',
  description:
    '组件映射段交叉一致：映射表出现的 interface/dimension 必须在 IR 存在（error）；IR 未被映射者显式列出不静默（warning）（X18，P1-10）',
  check(ctx: KindRuleContext): CheckIssue[] {
    const issues: CheckIssue[] = [];
    const mapping = ctx.model.derivable.componentMapping;
    // 老模型形态（组件映射段不存在 → undefined）：零输出（老模型零回归）
    if (mapping === undefined) return issues;

    const view = flattenComponentMapping(mapping);
    const interfaceUniverse = collectInterfaceUniverse(ctx.model);
    const dimensionUniverse = collectDimensionUniverse(ctx.model);

    // ── A：映射表出现的 interface / dimension 必须在 IR 存在（引用闭合，error）──
    for (let i = 0; i < view.interfaceRows.length; i++) {
      const row = view.interfaceRows[i];
      if (!interfaceUniverse.has(row.interface)) {
        issues.push(
          kindError(
            `组件映射表 interfaceImplementations[${i}] 引用的接口 "${row.interface}" 在 IR 中不存在` +
              `（接口命名空间 = 转移 action/id ∪ 契约 contracts[].interface）；` +
              `服务划分推导不能建立在悬空接口上（X18，P1-10）[R-KIND-10/X18]`,
            row.interface,
            `derivable.componentMapping.interfaceImplementations[${i}].interface`
          )
        );
      }
    }
    for (let i = 0; i < view.dimensionRows.length; i++) {
      const row = view.dimensionRows[i];
      if (!dimensionUniverse.has(row.dimension)) {
        issues.push(
          kindError(
            `组件映射表 dimensionStorage[${i}] 引用的维度 "${row.dimension}" 在 IR 中不存在` +
              `（维度命名空间 = 状态/附属实体声明的 dimensions[].name）；` +
              `存储 schema 推导不能建立在悬空维度上（X18，P1-10）[R-KIND-10/X18]`,
            row.dimension,
            `derivable.componentMapping.dimensionStorage[${i}].dimension`
          )
        );
      }
    }

    // ── B：IR 中未被映射者显式列出（不静默遗漏，进入报告输出，warning）──
    // 口径（与 R-KIND-8「已声明」同宽）：同一接口的 action/id 别名任一被映射即视为已覆盖
    // （如映射 place_order，则其对应 transition 的 id T1 不重复报未映射）。
    const mappedInterfaces = new Set(view.interfaceRows.map((r) => r.interface));
    const coveredInterfaces = new Set(mappedInterfaces);
    for (const t of ctx.model.derivable.transitions ?? []) {
      if (mappedInterfaces.has(t.action) || mappedInterfaces.has(t.id)) {
        if (t.action) coveredInterfaces.add(t.action);
        if (t.id) coveredInterfaces.add(t.id);
      }
    }
    const mappedDimensions = new Set(view.dimensionRows.map((r) => r.dimension));
    const unmappedInterfaces = Array.from(interfaceUniverse)
      .filter((n) => !coveredInterfaces.has(n))
      .sort();
    const unmappedDimensions = Array.from(dimensionUniverse)
      .filter((n) => !mappedDimensions.has(n))
      .sort();
    if (unmappedInterfaces.length > 0 || unmappedDimensions.length > 0) {
      const parts: string[] = [];
      if (unmappedInterfaces.length > 0) {
        parts.push(`未映射接口：${unmappedInterfaces.join(', ')}`);
      }
      if (unmappedDimensions.length > 0) {
        parts.push(`未映射维度：${unmappedDimensions.join(', ')}`);
      }
      issues.push(
        kindWarning(
          `组件映射段已启用但 IR 仍有对象未进映射表（不静默遗漏，请审视是否补齐）：${parts.join('；')}` +
            `（X18，P1-10：组件映射是 viewer 组件视图与代码推导的数据源，缺失者推导不出服务划分/存储 schema）[R-KIND-10/X18]`,
          'derivable.componentMapping'
        )
      );
    }

    return issues;
  },
};

// ---------------------------------------------------------------------------
// R-KIND-11（X13 / P2-6）：凭证声明完整性（credential: 段）
// ---------------------------------------------------------------------------
//
// 触发条件：模型 frontmatter 已声明 credential: 段（metadata.credentials !== undefined，
// 新模型形态）。老模型（无凭证段 → undefined）→ 整段零输出（老模型零回归，S6-5）。
//
// 校验（机械，X13 检查器）：
// - A（error，硬失败）：七列完整性——name / issuer / holder / redeemer / selfContained /
//   ttl / revoke / premise 任一缺失或为空串 → error（parser 层已拦缺失，此处 IR 级防御
//   手工构造的模型，与 checkFieldIntegrity 同口径）；
// - B（error，硬失败）：selfContained 枚举合法性（local-verify | needs-lookup）——
//   非枚举值 → error（拒绝静默）；
// - C（error，硬失败）：name 唯一性——同一凭证名重复声明 → error（凭证名是协议内标识，
//   与角色 ID / 状态 ID 唯一性同口径）；
// - D（error，硬失败）：issuer / holder / redeemer 引用闭合——三方必须引用 metadata.roles
//   中已声明的角色 ID（与 checkCrossReferences 的契约 party 引用口径一致）；
//   凭证建立在未声明角色上 = 模型内部引用悬空。
export const ruleRKind11CredentialIntegrity: KindRule = {
  ruleId: 'R-KIND-11',
  description:
    '凭证声明完整性：七列完整性 / selfContained 枚举 / name 唯一性 / issuer·holder·redeemer 角色引用闭合（X13，P2-6）',
  check(ctx: KindRuleContext): CheckIssue[] {
    const issues: CheckIssue[] = [];
    const credentials = ctx.model.metadata.credentials;
    // 老模型形态（无 credential: 段 → undefined）：零输出（老模型零回归，S6-5）
    if (credentials === undefined) return issues;

    const roleIds = new Set(ctx.model.metadata.roles.map((r) => r.id));

    // ── C：name 唯一性（先扫重，避免逐条重复报）──
    const seen = new Map<string, number>();
    credentials.forEach((c, i) => {
      if (c.name && !seen.has(c.name)) seen.set(c.name, i);
    });

    credentials.forEach((c, idx) => {
      const path = `metadata.credentials[${idx}]`;

      // ── A：七列完整性（含 name 标识）──
      const required: Array<[keyof typeof c, string]> = [
        ['name', 'name'],
        ['issuer', 'issuer'],
        ['holder', 'holder'],
        ['redeemer', 'redeemer'],
        ['selfContained', 'selfContained'],
        ['ttl', 'ttl'],
        ['revoke', 'revoke'],
        ['premise', 'premise'],
      ];
      for (const [key, label] of required) {
        const v = c[key];
        if (typeof v !== 'string' || v.trim() === '') {
          issues.push(
            kindError(
              `凭证 ${c.name || `[${idx}]`} 缺少必填字段 "${label}" 或字段非空字符串（七列完整性，X13，P2-6）[R-KIND-11/X13]`,
              c.name || `[${idx}]`,
              `${path}.${label}`
            )
          );
        }
      }

      // ── B：selfContained 枚举合法性（IR 级防御；parser 已拦非法值）──
      if (c.selfContained !== 'local-verify' && c.selfContained !== 'needs-lookup') {
        issues.push(
          kindError(
            `凭证 ${c.name || `[${idx}]`} 的 selfContained 必须是 local-verify 或 needs-lookup，实际为 ${String(c.selfContained)}（枚举白名单，X13，P2-6）[R-KIND-11/X13]`,
            c.name || `[${idx}]`,
            `${path}.selfContained`
          )
        );
      }

      // ── C：name 重复（仅首次出现处报一次）──
      if (c.name && seen.get(c.name) !== idx) {
        issues.push(
          kindError(
            `凭证名 "${c.name}" 重复声明（同一凭证名只能声明一次，与角色/状态 ID 唯一性同口径，X13，P2-6）[R-KIND-11/X13]`,
            c.name,
            `${path}.name`
          )
        );
      }

      // ── D：issuer / holder / redeemer 角色引用闭合 ──
      for (const party of ['issuer', 'holder', 'redeemer'] as const) {
        const ref = c[party];
        if (typeof ref !== 'string' || ref.trim() === '') continue; // 缺失已由 A 报
        if (!roleIds.has(ref)) {
          issues.push(
            kindError(
              `凭证 ${c.name || `[${idx}]`} 的 ${party}="${ref}" 未在 metadata.roles 中声明（凭证三方必须引用已声明角色，引用闭合，X13，P2-6）[R-KIND-11/X13]`,
              c.name || `[${idx}]`,
              `${path}.${party}`
            )
          );
        }
      }
    });

    return issues;
  },
};

// ---------------------------------------------------------------------------
// R-KIND-12~15（V1）：关系段（language.md §2 五种关系）完整性检查组
// ---------------------------------------------------------------------------
//
// 触发条件：模型已启用「关系」段（derivable.relations !== undefined，新模型形态）。
// 老模型（段不存在 → undefined）→ 整组零输出（老模型零回归，V1-4）。
//
// 四条机械规则（language.md §2 判据 + 表4 填写规则）：
// - R-KIND-12（error）：onGone 不许空（表4 硬要求：空了就等于默认「不会出问题」）；
// - R-KIND-13（error）：type 枚举合法（绑定/派生/组合/运行依赖/约束关联，五种白名单）；
// - R-KIND-14（error）：from/to 端点必须在 IR 存在（状态 ID ∪ 附属实体 ID ∪ 维度名，
//   悬空引用硬失败，X18 交叉一致口径）；
// - R-KIND-15（error）：绑定/派生/组合/运行依赖构成依赖图须无环（判据8：依赖图无环；
//   约束关联「不互相指向」不构成依赖边，不参与构图）。

/** 关系类型白名单（language.md §2 五种关系，模型语言层枚举） */
export const RELATION_TYPES = ['绑定', '派生', '组合', '运行依赖', '约束关联'] as const;

/** 参与依赖图构图的关系类型（判据8：约束关联不互相指向，不构成依赖边） */
export const RELATION_DEPENDENCY_TYPES: ReadonlySet<string> = new Set([
  '绑定',
  '派生',
  '组合',
  '运行依赖',
]);

/**
 * 关系端点命名空间：状态 ID ∪ 附属实体 ID ∪ 维度名
 * （states[].id / subsidiaryEntities[].id / states[].dimensions[].name /
 *  subsidiaryEntities[].stateSpace.dimensions[].name）。
 */
export function collectRelationEndpointUniverse(model: SourceProtocolModel): Set<string> {
  const names = new Set<string>();
  for (const s of model.derivable.states ?? []) {
    if (s.id) names.add(s.id);
    for (const d of s.dimensions ?? []) {
      if (d.name) names.add(d.name);
    }
  }
  for (const ent of model.derivable.subsidiaryEntities ?? []) {
    if (ent.id) names.add(ent.id);
    for (const d of ent.stateSpace.dimensions ?? []) {
      if (d.name) names.add(d.name);
    }
  }
  return names;
}

export const ruleRKind12RelationOnGoneRequired: KindRule = {
  ruleId: 'R-KIND-12',
  description:
    '关系段 onGone（目标消失或失效时的处置）不许空：空了就等于默认「不会出问题」（language.md §2 表4 硬要求）',
  check(ctx: KindRuleContext): CheckIssue[] {
    const issues: CheckIssue[] = [];
    const relations = ctx.model.derivable.relations;
    // 老模型形态（关系段不存在 → undefined）：零输出（老模型零回归，V1-4）
    if (relations === undefined) return issues;
    relations.forEach((rel, idx) => {
      if (typeof rel.onGone !== 'string' || rel.onGone.trim() === '') {
        issues.push(
          kindError(
            `关系[${idx}]（${rel.from} → ${rel.to}，type=${rel.type}）未声明 onGone：` +
              `「目标消失或失效时」不许空，空了就等于默认「不会出问题」（language.md §2 表4 硬要求）[R-KIND-12/V1]`,
            `${rel.from}→${rel.to}`,
            `derivable.relations[${idx}].onGone`
          )
        );
      }
    });
    return issues;
  },
};

export const ruleRKind13RelationTypeEnum: KindRule = {
  ruleId: 'R-KIND-13',
  description:
    '关系段 type 必须是五种合法枚举：绑定 / 派生 / 组合 / 运行依赖 / 约束关联（language.md §2 五种关系白名单）',
  check(ctx: KindRuleContext): CheckIssue[] {
    const issues: CheckIssue[] = [];
    const relations = ctx.model.derivable.relations;
    // 老模型形态（关系段不存在 → undefined）：零输出（老模型零回归，V1-4）
    if (relations === undefined) return issues;
    relations.forEach((rel, idx) => {
      if (!(RELATION_TYPES as readonly string[]).includes(rel.type)) {
        issues.push(
          kindError(
            `关系[${idx}]（${rel.from} → ${rel.to}）的 type="${String(rel.type)}" 非法：` +
              `仅支持 绑定 / 派生 / 组合 / 运行依赖 / 约束关联（language.md §2 五种关系；无映射即无判据，拒绝静默）[R-KIND-13/V1]`,
            `${rel.from}→${rel.to}`,
            `derivable.relations[${idx}].type`
          )
        );
      }
    });
    return issues;
  },
};

export const ruleRKind14RelationEndpointExists: KindRule = {
  ruleId: 'R-KIND-14',
  description:
    '关系段 from/to 端点必须在 IR 存在（状态 ID ∪ 附属实体 ID ∪ 维度名；悬空引用硬失败，X18 交叉一致口径）',
  check(ctx: KindRuleContext): CheckIssue[] {
    const issues: CheckIssue[] = [];
    const relations = ctx.model.derivable.relations;
    // 老模型形态（关系段不存在 → undefined）：零输出（老模型零回归，V1-4）
    if (relations === undefined) return issues;
    const universe = collectRelationEndpointUniverse(ctx.model);
    relations.forEach((rel, idx) => {
      for (const field of ['from', 'to'] as const) {
        const value = rel[field];
        if (!universe.has(value)) {
          issues.push(
            kindError(
              `关系[${idx}]（${rel.from} → ${rel.to}，type=${rel.type}）的 ${field}="${value}" 在 IR 中不存在` +
                `（端点命名空间 = 状态 ID ∪ 附属实体 ID ∪ 维度名）；` +
                `关系图不能建立在悬空端点上（X18 交叉一致口径）[R-KIND-14/V1]`,
              value,
              `derivable.relations[${idx}].${field}`
            )
          );
        }
      }
    });
    return issues;
  },
};

export const ruleRKind15RelationDagAcyclic: KindRule = {
  ruleId: 'R-KIND-15',
  description:
    '绑定/派生/组合/运行依赖构成依赖图须无环（判据8：依赖图无环）；约束关联不互相指向、不参与构图（language.md §2）',
  check(ctx: KindRuleContext): CheckIssue[] {
    const issues: CheckIssue[] = [];
    const relations = ctx.model.derivable.relations;
    // 老模型形态（关系段不存在 → undefined）：零输出（老模型零回归，V1-4）
    if (relations === undefined) return issues;

    // 构图：仅参与类型连边（from → to 依赖方向）；约束关联跳过
    const adj = new Map<string, string[]>();
    for (const rel of relations) {
      if (!RELATION_DEPENDENCY_TYPES.has(rel.type)) continue;
      const list = adj.get(rel.from) ?? [];
      list.push(rel.to);
      adj.set(rel.from, list);
    }
    if (adj.size === 0) return issues;

    // DFS 三色标记（0=未访问 1=访问中 2=已完成）检测有向环
    const color = new Map<string, number>();
    const stack: string[] = [];
    const cycleNodes = new Set<string>();
    const visit = (node: string): boolean => {
      color.set(node, 1);
      stack.push(node);
      for (const next of adj.get(node) ?? []) {
        const c = color.get(next) ?? 0;
        if (c === 1) {
          // 回边 → 环：栈中从 next 到栈顶的节点构成环
          const start = stack.indexOf(next);
          for (let i = start; i < stack.length; i++) cycleNodes.add(stack[i]);
          return true;
        }
        if (c === 0 && visit(next)) return true;
      }
      stack.pop();
      color.set(node, 2);
      return false;
    };
    for (const node of adj.keys()) {
      if ((color.get(node) ?? 0) === 0) visit(node);
    }
    if (cycleNodes.size > 0) {
      issues.push(
        kindError(
          `关系依赖图存在环（参与类型：绑定/派生/组合/运行依赖）：${Array.from(cycleNodes).join(' → ')}；` +
            `判据8 要求依赖图无环（language.md §2 运行依赖行），否则被依赖方失效时的补偿无法收敛 [R-KIND-15/V1]`,
          Array.from(cycleNodes).join('→'),
          'derivable.relations'
        )
      );
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
  ruleRKind5ControllableComponentSuggestEntity,
  ruleRKind6NonSystemComponentSuggestRemove,
  ruleRKind7NoStateChangeCandidate,
  ruleRKind8CrossEntityNeedsTransactionBoundary,
  ruleRKind9GuardExecutableCoverage,
  ruleRKind10ComponentMappingConsistency,
  ruleRKind11CredentialIntegrity,
  ruleRKind12RelationOnGoneRequired,
  ruleRKind13RelationTypeEnum,
  ruleRKind14RelationEndpointExists,
  ruleRKind15RelationDagAcyclic,
];

export const KIND_RULE_IDS: KindRuleId[] = KIND_RULES.map((r) => r.ruleId);

// 类型导出（外层按需 import）
export type { DimensionKind, DimensionKindSource };
