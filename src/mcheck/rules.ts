/**
 * m-check 规则集（5 条首版规则）
 *
 * IMPLEMENTATION-PLAN.md §E1：
 *   - state ID 命名规范 `/^[A-Z]+_\w+$/`
 *   - 跨协议 ID 唯一性
 *   - 附属实体归属
 *   - 旧字符（`-` / `/` / 中文标点）禁用清单
 *   - ID 转义前置（修改单 002）
 *
 * 重要：与现有 checker 严格不重叠（REVIEW §5.2 已确认）。
 * from/to 引用存在性由 checker 负责（src/checker/index.ts:495-512）。
 */

import type {
  SourceProtocolModel,
  DerivableLayer,
  StateDef,
  TransitionDef,
  InvariantDef,
  TimingDef,
  ExceptionPathDef,
  ResourcePoolDef,
  ExternalEventDef,
  NegativeAssuranceDef,
  SubsidiaryEntityDef,
  GuardTranslationDef,
} from '../model/types.js';
import type {
  MCheckRule,
  MCheckContext,
  MCheckIssue,
  MCheckRuleId,
} from './types.js';

// ---------------------------------------------------------------------------
// 公共：状态机元素 ID 命名规范
// ---------------------------------------------------------------------------
//
// 只检查"禁用字符"维度（即含 `-` / `/` / 中文标点等会破坏 SANY 的字符），
// 不强制"必须带下划线"（避免误伤 `S1` / `T1` / `INV1` 这类合规的简洁 ID）。
// "必须带下划线"属于风格检查，不是 M 阶段语义闸门该拦的——PITFALLS #4
//（019 单 INV-PS1 → INV_PS1）关心的是禁用字符。

/** 禁止在 ID 中出现的字符（与 SANY / TLA+ 不兼容） */
const ID_FORBIDDEN_CHARS: Array<{ re: RegExp; label: string }> = [
  { re: /-/g, label: '连字符 `-`' },
  { re: /\//g, label: '斜杠 `/`' },
  { re: /，/g, label: '中文逗号 `，`' },
  { re: /。/g, label: '中文句号 `。`' },
  { re: /；/g, label: '中文分号 `；`' },
  { re: /：/g, label: '中文冒号 `：`' },
  { re: /（/g, label: '中文左括号 `（`' },
  { re: /）/g, label: '中文右括号 `）`' },
  { re: /\u3000/g, label: '全角空格（U+3000）' },
];

/** 元素类型 → ID 字段路径（derivable 子层） */
const DERIVABLE_ID_FIELDS: Array<{ key: keyof DerivableLayer; elementType: string }> = [
  { key: 'states', elementType: 'state' },
  { key: 'transitions', elementType: 'transition' },
  { key: 'invariants', elementType: 'invariant' },
  { key: 'timing', elementType: 'timing' },
  { key: 'exceptions', elementType: 'exception' },
  { key: 'resourcePools', elementType: 'resourcePool' },
  { key: 'externalEvents', elementType: 'externalEvent' },
  { key: 'negativeAssurances', elementType: 'negativeAssurance' },
  { key: 'subsidiaryEntities', elementType: 'subsidiaryEntity' },
  { key: 'guardTranslations', elementType: 'guardTranslation' },
];

// ---------------------------------------------------------------------------
// M001：命名规范（state ID 必须 `/^[A-Z]+_\w+$/`）
// ---------------------------------------------------------------------------

export const ruleM001NamingConvention: MCheckRule = {
  ruleId: 'M001',
  description:
    '状态机核心元素 ID 禁用 `-` / `/` / 中文标点 / 全角空格 / 空白字符等导致 SANY 解析异常的字符',
  check(ctx: MCheckContext): MCheckIssue[] {
    const issues: MCheckIssue[] = [];
    const d = ctx.model.derivable;
    for (const { key, elementType } of DERIVABLE_ID_FIELDS) {
      const arr = d[key];
      if (!Array.isArray(arr)) continue;
      for (let i = 0; i < arr.length; i++) {
        const elem = arr[i] as { id?: unknown };
        const id = elem?.id;
        if (typeof id !== 'string' || id.length === 0) continue;
        for (const { re, label } of ID_FORBIDDEN_CHARS) {
          if (re.test(id)) {
            issues.push({
              ruleId: 'M001',
              severity: 'error',
              elementId: id,
              elementType,
              elementPath: `derivable.${String(key)}[${i}].id`,
              message: `${elementType} ID "${id}" 含禁用字符 ${label}`,
              suggestion:
                '将 `-` 改为 `_`、去除中文标点与空白字符',
            });
            break; // 同一 ID 不重复报
          }
        }
      }
    }
    return issues;
  },
};

// ---------------------------------------------------------------------------
// M002：跨协议 ID 唯一性（多协议项目下 INV_/T_/S_ 等不撞名）
// ---------------------------------------------------------------------------

export const ruleM002CrossProtocolIdUniqueness: MCheckRule = {
  ruleId: 'M002',
  description:
    '多协议项目下，各子协议的可推演层 ID 不能撞名（同一 ID 在两个子协议中出现视为冲突）',
  check(ctx: MCheckContext): MCheckIssue[] {
    const issues: MCheckIssue[] = [];
    const peers = ctx.peerModels;
    if (!peers || Object.keys(peers).length === 0) return issues;

    // 收集当前模型的 ID → 类型
    const currentIds = new Map<string, string>();
    collectIds(ctx.model.derivable, currentIds);

    // 对每个 peer 模型，ID 撞名则报错
    for (const [peerId, peerModel] of Object.entries(peers)) {
      if (peerModel === ctx.model) continue;
      const peerIds = new Map<string, string>();
      collectIds(peerModel.derivable, peerIds);
      for (const [id, elementType] of currentIds) {
        if (peerIds.has(id)) {
          issues.push({
            ruleId: 'M002',
            severity: 'error',
            elementId: id,
            elementType,
            elementPath: `derivable (peer ${peerId} 同名)`,
            message: `${elementType} ID "${id}" 在子协议 ${peerId} 中已存在，跨协议 ID 必须唯一`,
            suggestion: `将本协议的 "${id}" 重命名为 "${ctx.model.metadata.name}-${id}" 形式`,
          });
        }
      }
    }
    return issues;
  },
};

function collectIds(
  d: DerivableLayer,
  out: Map<string, string>
): void {
  for (const { key, elementType } of DERIVABLE_ID_FIELDS) {
    const arr = d[key];
    if (!Array.isArray(arr)) continue;
    for (const elem of arr as Array<{ id?: unknown }>) {
      if (typeof elem?.id === 'string' && elem.id.length > 0) {
        if (!out.has(elem.id)) out.set(elem.id, elementType);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// M003：附属实体归属（subsidiaryEntities[].belongsTo 必须指向已存在 state）
// ---------------------------------------------------------------------------
//
// 职责边界（与 checker 的差异）：
// - checker 校验 transition.from/to 在 states 中存在（src/checker/index.ts:495-512）
// - m-check（本规则）校验 subsidiaryEntities[].belongsTo 在 states 中存在
// - checker 还识别 belongsTo 跨协议引用并标记 pendingCrossProtocolRefs
//   （src/checker/index.ts:828-841），M003 在跨协议情形下跳过单协议存在性校验，
//   与 checker 协作避免双份重复报错。

export const ruleM003SubsidiaryEntityOwnership: MCheckRule = {
  ruleId: 'M003',
  description:
    'subsidiaryEntities[].belongsTo 必须指向已存在的 state ID（跨协议引用除外）',
  check(ctx: MCheckContext): MCheckIssue[] {
    const issues: MCheckIssue[] = [];
    const stateIds = new Set<string>(
      ctx.model.derivable.states.map((s: StateDef) => s.id)
    );
    const seList: SubsidiaryEntityDef[] | undefined =
      ctx.model.derivable.subsidiaryEntities;
    if (!seList) return issues;
    for (let i = 0; i < seList.length; i++) {
      const se = seList[i];
      // 借鉴 checker 的跨协议引用识别（src/checker/index.ts:832）：
      // 含协议 ID 标记（如 P1/P2）或括号注明协议时视为跨协议引用，跳过单协议检查
      const isCrossProtocol =
        /P\d|[（(][^)）]*[)）]/.test(se.belongsTo ?? '');
      if (isCrossProtocol) continue;

      // 单协议引用：剥离括号注解后检查是否在本协议 states 中
      const ref = se.belongsTo?.replace(/[（(].*?[)）]/g, '').trim();
      if (!ref) {
        issues.push({
          ruleId: 'M003',
          severity: 'error',
          elementId: se.id,
          elementType: 'subsidiaryEntity',
          elementPath: `derivable.subsidiaryEntities[${i}].belongsTo`,
          message: `附属实体 "${se.id}" 缺少 belongsTo 声明`,
          suggestion: '在 belongsTo 字段填写主实体对应的 state ID',
        });
        continue;
      }
      if (!stateIds.has(ref)) {
        issues.push({
          ruleId: 'M003',
          severity: 'error',
          elementId: se.id,
          elementType: 'subsidiaryEntity',
          elementPath: `derivable.subsidiaryEntities[${i}].belongsTo`,
          message: `附属实体 "${se.id}" 的 belongsTo "${ref}" 不在 states 中（指向不存在的 state）`,
          suggestion: `确认 ref 实际指向的 state ID，或在 states 中新增该 state`,
        });
      }
    }
    return issues;
  },
};

// ---------------------------------------------------------------------------
// M004：旧字符 / 中文标点禁用（ID、表达式、状态机核心字段）
// ---------------------------------------------------------------------------
//
// 与 M001 区别：M001 只扫 ID；M004 扫 invariant.expression / transition.guard /
// transition.action 等"将进入 SANY / formalize"的字段内容。
// 两规则共用同一禁字符列表，确保报错口径一致。

export const ruleM004ForbiddenCharacters: MCheckRule = {
  ruleId: 'M004',
  description:
    '状态机核心字段禁用连字符/斜杠/中文标点/全角空格（进入 SANY 与 formalize 前置拦截）',
  check(ctx: MCheckContext): MCheckIssue[] {
    const issues: MCheckIssue[] = [];
    const d = ctx.model.derivable;

    // invariants.expression / name
    for (let i = 0; i < d.invariants.length; i++) {
      const inv = d.invariants[i];
      scanField(inv.expression, `derivable.invariants[${i}].expression`, inv.id, 'invariant', issues);
      scanField(inv.name, `derivable.invariants[${i}].name`, inv.id, 'invariant', issues);
    }

    // transitions.guard / action / name
    for (let i = 0; i < d.transitions.length; i++) {
      const tr = d.transitions[i];
      scanField(tr.guard, `derivable.transitions[${i}].guard`, tr.id, 'transition', issues);
      scanField(tr.action, `derivable.transitions[${i}].action`, tr.id, 'transition', issues);
      scanField(tr.name, `derivable.transitions[${i}].name`, tr.id, 'transition', issues);
    }

    // states.name
    for (let i = 0; i < d.states.length; i++) {
      const s = d.states[i];
      scanField(s.name, `derivable.states[${i}].name`, s.id, 'state', issues);
    }

    // timing.name
    for (let i = 0; i < d.timing.length; i++) {
      const t = d.timing[i];
      scanField(t.name, `derivable.timing[${i}].name`, t.id, 'timing', issues);
    }

    return issues;
  },
};

function scanField(
  value: unknown,
  path: string,
  elementId: string,
  elementType: string,
  issues: MCheckIssue[]
): void {
  if (typeof value !== 'string' || value.length === 0) return;
  for (const { re, label } of ID_FORBIDDEN_CHARS) {
    if (re.test(value)) {
      issues.push({
        ruleId: 'M004',
        severity: 'error',
        elementId,
        elementType,
        elementPath: path,
        message: `${path} 含禁用字符 ${label}`,
        suggestion:
          '将 `-` 改为 `_`、中文标点改为英文或空格、全角空格改为半角空格',
      });
      // 同一字段不再重复报
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// M005：ID 转义前置（SANY 解析层异常前置到 M 阶段）
// ---------------------------------------------------------------------------
//
// 修改单 002 描述：formalize 在 ID 含 `-` 时 SANY 解析失败并被 adaptor 强行
// rename 成下划线。把该检查前置到 M 阶段，避免到 formalize 才"硬改名"导致
// 模型与推导产物 ID 偷偷不一致。
//
// 具体实现：与 M001 重叠检查（M001 已覆盖 `-`），本规则额外覆盖：
// - ID 与 TLA+ 关键字撞名（如 TRUE / FALSE / VARIABLE / Init / Next）
// - ID 与 invariant.expression 内出现的 TLA+ 关键字撞名（形如 `TRUE` 直接出现）
//
// 设计取舍：本规则只报"明确的 SANY 异常"，不试图列举全部 TLA+ 语法
// （避免与 formalize 职责重叠）。详细转义仍由 formalizer 处理。

const TLA_PLUS_KEYWORDS = new Set([
  'TRUE',
  'FALSE',
  'VARIABLE',
  'VARIABLES',
  'CONSTANT',
  'CONSTANTS',
  'ASSUME',
  'ASSUMPTION',
  'AXIOM',
  'THEOREM',
  'LEMMA',
  'COROLLARY',
  'PROOF',
  'OBVIOUS',
  'OMITTED',
  'ONLY',
  'USE',
  'HIDE',
  'DEFINE',
  'RECURSIVE',
  'LOCAL',
  'INSTANCE',
  'WITH',
  'LET',
  'IN',
  'IF',
  'THEN',
  'ELSE',
  'CASE',
  'CHOOSE',
  'EXCEPT',
  'DOMAIN',
  'SUBSET',
  'UNION',
  'INTERSECT',
  'ENABLED',
  'UNCHANGED',
  'WF_',
  'SF_',
  'Init',
  'Next',
  'Spec',
  'TypeOK',
  'TypeInvariant',
  'AllInvariants',
]);

export const ruleM005IdEscaping: MCheckRule = {
  ruleId: 'M005',
  description:
    'ID / 不变量表达式禁用 TLA+ 关键字（SANY 解析层异常前置到 M 阶段，参考修改单 002）',
  check(ctx: MCheckContext): MCheckIssue[] {
    const issues: MCheckIssue[] = [];
    const d = ctx.model.derivable;

    // 1) 元素 ID 与 TLA+ 关键字撞名
    for (const { key, elementType } of DERIVABLE_ID_FIELDS) {
      const arr = d[key];
      if (!Array.isArray(arr)) continue;
      for (let i = 0; i < arr.length; i++) {
        const elem = arr[i] as { id?: unknown };
        const id = elem?.id;
        if (typeof id !== 'string' || id.length === 0) continue;
        if (TLA_PLUS_KEYWORDS.has(id)) {
          issues.push({
            ruleId: 'M005',
            severity: 'error',
            elementId: id,
            elementType,
            elementPath: `derivable.${String(key)}[${i}].id`,
            message: `${elementType} ID "${id}" 与 TLA+ 关键字撞名，会导致 SANY 解析失败`,
            suggestion: `在 ID 前缀加协议缩写（如 MyProtocol_${id}）`,
          });
        }
      }
    }

    // 2) invariant.expression 内若整段只写 `TRUE` / `FALSE`，报 warning
    //
    // 等级说明（E1-I3）：
    // - warning 而非 error 的原因：IMPLEMENTATION-PLAN §E4 允许数据级不变量写
    //   `TRUE`（"由 impl 守卫 + 存储约束保证"，属 by-design）。
    // - warning 起到"提醒但不阻断 M 阶段"的作用，与数据级不变量降级语义兼容。
    // - 后续 E4 落地后，本警告会与 verify 报告中的 `by-design-not-tested-by-toolchain`
    //   段形成联动：M005 报"写了裸 TRUE" → verify 报"该条不变量 by-design"。
    for (let i = 0; i < d.invariants.length; i++) {
      const inv = d.invariants[i];
      const trimmed = (inv.expression ?? '').trim();
      if (trimmed === 'TRUE' || trimmed === 'FALSE') {
        issues.push({
          ruleId: 'M005',
          severity: 'warning',
          elementId: inv.id,
          elementType: 'invariant',
          elementPath: `derivable.invariants[${i}].expression`,
          message: `不变量 "${inv.id}" 表达式为 "${trimmed}"，无实质断言作用`,
          suggestion:
            '改写为可机械检查的表达式；若必须由 impl 守卫保证，请在 description 中标注 by-design（E4 落地后由 verify 显式列出）',
        });
      }
    }

    return issues;
  },
};

// ---------------------------------------------------------------------------
// 规则注册表（CLI / orchestrator 按此顺序调用）
// ---------------------------------------------------------------------------

export const MCHECK_RULES: MCheckRule[] = [
  ruleM001NamingConvention,
  ruleM002CrossProtocolIdUniqueness,
  ruleM003SubsidiaryEntityOwnership,
  ruleM004ForbiddenCharacters,
  ruleM005IdEscaping,
];

export const MCHECK_RULE_IDS: MCheckRuleId[] = MCHECK_RULES.map((r) => r.ruleId);

// 防 lint：保留未使用类型（便于外层按需 import）
export type {
  StateDef,
  TransitionDef,
  InvariantDef,
  TimingDef,
  ExceptionPathDef,
  ResourcePoolDef,
  ExternalEventDef,
  NegativeAssuranceDef,
  GuardTranslationDef,
};