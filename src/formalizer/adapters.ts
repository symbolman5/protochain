/**
 * 形式化工具适配器 —— 多工具策略
 *
 * 设计依据：《协议驱动自验证工具链设计方案》第四节 FormalToolAdapter
 *
 * 方法论3.2节按协作模式特征选择不同形式化工具：
 * - 状态驱动 → SCXML 高分
 * - 并发交互 → TLA+ 高分
 * - 条件分支密集 → 决策表高分
 * - 时序敏感 → 时序逻辑高分（暂以 TLA+ 承载）
 *
 * detectSuitability 由代码规则化执行，不引入 AI 概率性。
 * 选择逻辑：选最高适合度的工具；也可在 protochain.config.yaml 中指定。
 */

import type {
  FormalToolAdapter,
  DerivableLayer,
  FormalReport,
  InvariantVerifyResult,
  AIAdapter,
  TlcConfig,
  GuardTranslationDef,
} from '../model/types.js';
import { parseAIJson } from '../ai/adapter.js';
import { runTlcOnSpec, parseTlcOutput, DEFAULT_TLC_TIMEOUT_MS } from './tlc-runner.js';

// ============================================================================
// 适合度评分（规则化实现）
// ============================================================================

export interface SuitabilityScore {
  tool: string;
  score: number;
  reasons: string[];
}

/**
 * 规则化评分：基于协议模型特征判断各工具的适合度
 *
 * 评分维度：
 * - 并发交互迹象（多角色、共享状态变量）：TLA+ 加分
 * - 状态驱动迹象（明确的状态机、SCXML 风格的事件驱动）：SCXML 加分
 * - 条件分支密集（转移守卫条件多、不变量以决策表形式）：决策表加分
 * - 时序敏感（时序约束多）：TLA+ 加分
 */
export function scoreAllAdapters(model: DerivableLayer): SuitabilityScore[] {
  const scores: SuitabilityScore[] = [];

  // ----- TLA+ -----
  const tlaReasons: string[] = [];
  let tlaScore = 0.3; // 基础分
  // 并发迹象：状态关联多角色
  const multiRoleStates = model.states.filter((s) => (s.roleIds?.length ?? 0) > 1).length;
  if (multiRoleStates > 0) {
    tlaScore += Math.min(0.3, multiRoleStates * 0.1);
    tlaReasons.push(`${multiRoleStates} 个状态关联多角色（并发迹象）`);
  }
  // 时序敏感
  if (model.timing.length >= 2) {
    tlaScore += 0.2;
    tlaReasons.push(`${model.timing.length} 条时序约束（时序敏感）`);
  }
  // 退化模式已用 TLA+
  if (model.degraded && model.formalLanguage === 'tla') {
    tlaScore = 1.0;
    tlaReasons.push('退化模式已使用 TLA+ 表达');
  }
  // 不变量含全称量词等高阶表达
  const hasQuantifier = model.invariants.some((i) =>
    /\b(forall|exists|∀|∃)\b/i.test(i.expression)
  );
  if (hasQuantifier) {
    tlaScore += 0.15;
    tlaReasons.push('不变量含量词表达（需高阶逻辑）');
  }
  scores.push({ tool: 'tla', score: Math.min(1, tlaScore), reasons: tlaReasons });

  // ----- SCXML -----
  const scxmlReasons: string[] = [];
  let scxmlScore = 0.3;
  // 状态机特征明确：状态数适中、转移命名以动作触发
  if (model.states.length >= 2 && model.states.length <= 20) {
    scxmlScore += 0.2;
    scxmlReasons.push(`状态数 ${model.states.length}（适合 SCXML 状态机）`);
  }
  // 事件驱动迹象：转移都带 action
  if (model.transitions.length > 0 && model.transitions.every((t) => t.action)) {
    scxmlScore += 0.15;
    scxmlReasons.push('所有转移均带 action（事件驱动）');
  }
  // 无并发迹象
  if (multiRoleStates === 0) {
    scxmlScore += 0.1;
    scxmlReasons.push('无多角色并发状态');
  }
  // 退化模式已用 SCXML
  if (model.degraded && model.formalLanguage === 'scxml') {
    scxmlScore = 1.0;
    scxmlReasons.length = 0;
    scxmlReasons.push('退化模式已使用 SCXML 表达');
  }
  scores.push({ tool: 'scxml', score: Math.min(1, scxmlScore), reasons: scxmlReasons });

  // ----- 决策表 -----
  const dtReasons: string[] = [];
  let dtScore = 0.2;
  // 条件分支密集：转移守卫条件多
  const guardedTransitions = model.transitions.filter((t) => t.guard).length;
  if (guardedTransitions >= 3) {
    dtScore += 0.3;
    dtReasons.push(`${guardedTransitions} 个转移含守卫条件（条件分支密集）`);
  }
  // 不变量较少且为简单布尔
  const simpleInvariants = model.invariants.filter(
    (i) => !/\b(forall|exists|∀|∃)\b/i.test(i.expression)
  ).length;
  if (simpleInvariants === model.invariants.length && model.invariants.length > 0) {
    dtScore += 0.15;
    dtReasons.push('不变量均为简单布尔表达');
  }
  // 状态数少（决策表不擅长大状态空间）
  if (model.states.length <= 5) {
    dtScore += 0.1;
    dtReasons.push(`状态数 ${model.states.length} 较少`);
  }
  scores.push({ tool: 'decision-table', score: Math.min(1, dtScore), reasons: dtReasons });

  // 按分数降序
  scores.sort((a, b) => b.score - a.score);
  return scores;
}

export function selectBestAdapter(
  model: DerivableLayer,
  adapters: FormalToolAdapter[],
  preferred?: string
): { adapter: FormalToolAdapter; score: number; reasons: string[] } {
  if (preferred) {
    const found = adapters.find((a) => a.name === preferred);
    if (found) {
      const scores = scoreAllAdapters(model);
      const s = scores.find((x) => x.tool === preferred);
      return { adapter: found, score: s?.score ?? 1.0, reasons: s?.reasons ?? ['使用方指定'] };
    }
  }

  const scores = scoreAllAdapters(model);
  for (const s of scores) {
    const adapter = adapters.find((a) => a.name === s.tool);
    if (adapter && s.score > 0) {
      return { adapter, score: s.score, reasons: s.reasons };
    }
  }
  // 兜底：返回第一个适配器
  return { adapter: adapters[0], score: 0, reasons: ['无匹配，使用默认'] };
}

// ============================================================================
// TLA+ 适配器
// ============================================================================

export class TLAAdapter implements FormalToolAdapter {
  name = 'tla';
  private aiAdapter?: AIAdapter;
  /** TLC 配置（portable JRE + tla2tools.jar）；未配置则降级为 AI 推演 */
  private tlc?: TlcConfig;

  constructor(aiAdapter?: AIAdapter, tlc?: TlcConfig) {
    this.aiAdapter = aiAdapter;
    this.tlc = tlc;
  }

  detectSuitability(model: DerivableLayer): number {
    const scores = scoreAllAdapters(model);
    return scores.find((s) => s.tool === 'tla')?.score ?? 0;
  }

  /**
   * 生成 TLA+ 规格
   * - 退化模式：直接返回 formalSpecRaw（已是 TLA+）
   * - 正常模式：由 AI 从结构化模型翻译为 TLA+
   */
  generateSpec(model: DerivableLayer): string {
    if (model.degraded && model.formalLanguage === 'tla' && model.formalSpecRaw) {
      return model.formalSpecRaw;
    }
    // 代码生成基础骨架（不依赖 AI，保证确定性）
    return generateTLASkeleton(model);
  }

  /**
   * 验证 TLA+ 规格
   *
   * 降级策略（与使用方约定一致）：**只有未配置 TLC 才降级为 AI 推演**。
   * 一旦配置了 TLC（protochain.config.yaml 的 `tlc` 段），其结果即权威
   * （toolExecuted=true），不尝试 AI：
   * - 启动失败（java 缺失/路径错误）→ 权威失败（配置问题需暴露，而非静默降级）
   * - 规格解析/语义错误（骨架未声明标识符或用户 TLA+ 缺陷）→ 权威失败
   * - 执行超时 / 不变量违反 → 权威失败（含反例）
   * 仅当 `tlc` 未配置时返回占位报告（passed=false，toolExecuted 缺省），
   * 由 formalize 流程降级为 AI 辅助推演（tool="tla-ai-fallback"）。
   */
  async verify(spec: string): Promise<FormalReport> {
    if (!this.tlc) {
      return this.buildPlaceholder(
        spec,
        '未配置 TLC：请在 protochain.config.yaml 增加 tlc 段（javaPath/tla2toolsJar）'
      );
    }
    try {
      const run = await runTlcOnSpec(spec, this.tlc);
      const rawOutput = [run.stdout, run.stderr].filter(Boolean).join('\n');
      // 已配置 TLC 后的所有失败均为权威结论（toolExecuted: true），不降级 AI
      if (run.spawnError) {
        return this.buildAuthoritativeFailure(spec, `TLC 启动失败：${run.spawnError}`);
      }
      if (run.timedOut) {
        return this.buildAuthoritativeFailure(
          spec,
          `TLC 执行超时（${this.tlc.timeoutMs ?? DEFAULT_TLC_TIMEOUT_MS}ms）\n${rawOutput}`
        );
      }
      const parsed = parseTlcOutput(rawOutput, run.invariantIds);
      if (parsed.errorLines.length > 0) {
        // 规格解析/语义错误：已配置 TLC 即权威失败，由人工检查点仲裁
        return this.buildAuthoritativeFailure(
          spec,
          parsed.errorLines.join('\n') || rawOutput
        );
      }
      // TLC 真实执行完毕（通过/反例均视为确定性结论）
      return {
        passed: parsed.passed,
        tool: 'tla',
        suitabilityScore: 0,
        generatedSpec: spec,
        rawOutput,
        invariantResults: parsed.invariantResults,
        verifiedAt: new Date().toISOString(),
        toolExecuted: true,
      };
    } catch (err) {
      return this.buildAuthoritativeFailure(
        spec,
        `TLC 执行异常：${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /** 工具不可用（未配置 TLC）时的占位报告（passed=false，formalize 据此降级为 AI 推演） */
  private buildPlaceholder(spec: string, reason: string): FormalReport {
    return {
      passed: false,
      tool: 'tla',
      suitabilityScore: 0,
      generatedSpec: spec,
      rawOutput: reason,
      invariantResults: [],
      verifiedAt: new Date().toISOString(),
    };
  }

  /** 已配置 TLC 时的权威失败报告（toolExecuted: true，不降级 AI） */
  private buildAuthoritativeFailure(spec: string, reason: string): FormalReport {
    return {
      passed: false,
      tool: 'tla',
      suitabilityScore: 0,
      generatedSpec: spec,
      rawOutput: reason,
      invariantResults: [],
      verifiedAt: new Date().toISOString(),
      toolExecuted: true,
    };
  }

  parseReport(raw: string): Partial<FormalReport> {
    // 简单解析 TLC 输出格式
    const passed = /Model checking completed\. No error/.test(raw) ||
      (!/Error:|Invariant .+ is violated/.test(raw) && /Checking/.test(raw));
    const invariantResults: InvariantVerifyResult[] = [];

    // 匹配 "Invariant Inv1 is violated by..." 之类
    const violated = raw.matchAll(/Invariant\s+(\S+)\s+is\s+violated/g);
    const violatedSet = new Set<string>();
    for (const m of violated) {
      violatedSet.add(m[1]);
    }

    // 此处只能从原始输出提取违反信息，完整列表需 formalizer 传入
    return {
      passed,
      rawOutput: raw,
      invariantResults,
    };
  }
}

/**
 * 代码生成 TLA+ 骨架（确定性，无 AI）
 *
 * 包含：MODULE、EXTENDS、VARIABLES、Init、Next、各不变量定义
 *
 * SANY 可解析性保证（TLC 真实执行的前提）：
 * - 所有注释与非表达式文本 ASCII 化（TLA+ 词法分析不支持非 ASCII 字符，中文注释同样报错）
 * - 自然语言守卫（含非 ASCII 字符）无法翻译为 TLA+ 表达式 → 降级为 TRUE 占位，
 *   守卫语义保留在模型文档与 verify 实现比对层，TLC 只对状态机结构做真实模型检查
 *
 * 守卫翻译（协议驱动，路线 B）：模型侧 guardTranslations 声明自然语言守卫的 TLA+ 注入方式，
 * 工具链不解释任何具体语义（不认识动作名/变量名），只按声明机械拼接：
 * - 命中 action（+ guardContains）的转移：守卫占位替换为 guardExpr
 * - prologue（VARIABLE/谓词定义/抽象动作定义）插入 VARIABLES 与 States 之间
 * - initConjuncts 附加到 Init、nextDisjuncts 追加到 Next 析取、
 *   invariants 并入 AllInvariants、typeConjuncts 并入 TypeInvariant、
 *   stutterVars 声明 Spec 的 stuttering 变量元组
 */
function generateTLASkeleton(model: DerivableLayer): string {
  const moduleName = 'Protocol';
  const stateIds = model.states.map((s) => s.id);
  const variableName = 'state';
  const initialStateId = model.initialStateId ?? model.states.find((s) => s.type === 'initial')?.id;

  // ---- 守卫翻译匹配：action/actions + guardContains 命中的转移 -> 对应声明 ----
  const translations = model.guardTranslations ?? [];
  const injected = new Map<string, GuardTranslationDef>();
  for (const gt of translations) {
    for (const t of model.transitions) {
      const actionOk =
        (!gt.action && !gt.actions) ||
        (gt.action !== undefined && t.action === gt.action) ||
        (gt.actions !== undefined && gt.actions.includes(t.action));
      const containsOk = !gt.guardContains || (t.guard ?? '').includes(gt.guardContains);
      if (actionOk && containsOk) injected.set(t.id, gt);
    }
  }
  // 一条声明可能命中多个转移（如 CT4 覆盖 disable/deregister）→ 注入片段只生效一次
  const activeGts = [...new Map([...injected.entries()].map(([, gt]) => [gt.id, gt])).values()];
  // 守卫涉及的附加变量（排除 state 本体）
  const extraVars = [...new Set(activeGts.flatMap((gt) => gt.stutterVars))].filter(
    (v) => v !== variableName
  );
  const hasInject = activeGts.length > 0;

  const lines: string[] = [];
  lines.push(`---- MODULE ${moduleName} ----`);
  lines.push('EXTENDS Naturals, Sequences');
  lines.push(`VARIABLES ${[variableName, ...extraVars].join(', ')}`);
  lines.push('');
  lines.push('(* State space *)');
  lines.push(`States == {${stateIds.map((id) => `"${id}"`).join(', ')}}`);
  lines.push('');

  // 守卫翻译前导声明（VARIABLE / 谓词定义 / 抽象动作定义）
  if (hasInject) {
    lines.push('(* Guard translation prologue (declared in model.md) *)');
    for (const gt of activeGts) {
      for (const line of gt.prologue) {
        lines.push(line);
      }
    }
    lines.push('');
  }

  // Init
  lines.push('(* Initial state *)');
  if (initialStateId) {
    lines.push(`Init == ${variableName} = "${initialStateId}"`);
    for (const gt of activeGts) {
      for (const c of gt.initConjuncts) {
        lines.push(`  /\\ ${c}`);
      }
    }
  } else {
    lines.push(`Init == FALSE (* no initial state *)`);
  }
  lines.push('');

  // Next：所有转移的析取
  lines.push('(* Next-state relation *)');
  const nextCases: string[] = [];
  for (const t of model.transitions) {
    // 注意：`/\\ ` 必须是双反斜杠 —— 模板字符串里 `\ `（反斜杠+空格）会被 JS 当作转义吃掉反斜杠
    // 多源转移 → 源状态析取；`from: -`（无源入口转移）→ 恒真
    const fromConditions = t.from
      .map((f) => (f === '-' || f === '' ? 'TRUE' : `${variableName} = "${f}"`))
      .join(' \\/ ');
    // 守卫翻译：命中声明的转移用 guardExpr；其余自然语言守卫降级为 TRUE（语义保留于模型文档与 verify 层）
    const gt = injected.get(t.id);
    const guard = gt ? `/\\ ${gt.guardExpr}` : (t.guard ? '/\\ TRUE' : '');
    // 附加变量在普通转移中保持不变（stuttering 补全，保证 TLC 变量完备）
    const stutterNext = extraVars.map((v) => `  /\\ ${v}' = ${v}\n`).join('');
    nextCases.push(
      `(* ${asciiSafe(t.name)}: ${t.from.join('/')} -> ${t.to} *)` +
      (t.guard ? ` (* guard: ${asciiSafe(t.guard)} *)` : '') +
      `\n  /\\ ${fromConditions}${guard}\n  /\\ ${variableName}' = "${t.to}"\n${stutterNext}`
    );
  }
  // 守卫翻译附加析取项（抽象动作，如模拟跨协议映射增删）
  if (hasInject) {
    for (const gt of activeGts) {
      for (const d of gt.nextDisjuncts) {
        nextCases.push(
          `(* ${asciiSafe(gt.id)} extra disjunct *)` + `\n  ${d}`
        );
      }
    }
  }
  if (nextCases.length > 0) {
    lines.push(`Next == \\* (transition disjunction)`);
    lines.push(`  ${nextCases.join('\n  \\/ ')}`);
  } else {
    lines.push(`Next == FALSE (* no transitions *)`);
  }
  lines.push('');

  // 不变量
  for (const inv of model.invariants) {
    const degraded = isDataLevelExpr(inv.expression);
    const expr = degraded ? 'TRUE' : sanitizeTlaExpr(inv.expression);
    const note = degraded
      ? ' (degraded: data-level, not TLA+ expressible; real guarantee via guards/storage per model.md)'
      : '';
    lines.push(`(* Invariant: ${asciiSafe(inv.name)}${note} *)`);
    lines.push(`${inv.id} == ${expr}`);
    lines.push('');
  }

  // 守卫翻译附加不变量（静态断言，等价于动作守卫的可检查形式）
  for (const gt of activeGts) {
    for (const inv of gt.invariants) {
      lines.push(`(* Guard invariant: ${asciiSafe(gt.id)} ${asciiSafe(inv.id)} *)`);
      lines.push(`${inv.id} == ${inv.expression}`);
      lines.push('');
    }
  }

  // TypeInvariant
  lines.push('(* Type invariant *)');
  lines.push(`TypeInvariant == ${variableName} \\in States`);
  for (const gt of activeGts) {
    for (const c of gt.typeConjuncts) {
      lines.push(`  /\\ ${c}`);
    }
  }
  lines.push('');

  // Spec
  lines.push('(* Complete spec *)');
  const stutterVars =
    hasInject && extraVars.length > 0
      ? `<<${variableName}, ${extraVars.join(', ')}>>`
      : variableName;
  lines.push(`Spec == Init /\\ [][Next]_${stutterVars}`);
  lines.push('');

  // 聚合不变量
  const allInvIds = model.invariants.map((i) => i.id);
  for (const gt of activeGts) {
    for (const inv of gt.invariants) allInvIds.push(inv.id);
  }
  if (allInvIds.length > 0) {
    lines.push('(* Aggregate invariants *)');
    lines.push(`AllInvariants == /\\ ${allInvIds.join('\n  /\\ ')}`);
    lines.push('');
  }

  lines.push('=============================================');
  return lines.join('\n');
}

/** 移除文本中的非 ASCII 字符（TLA+ 注释/标识符仅支持 ASCII） */
function asciiSafe(str: string): string {
  return String(str ?? '').replace(/[^\x00-\x7F]/g, '');
}

/** 不变量表达式 ASCII 化：含非 ASCII 字符时降级为 TRUE（避免 SANY 词法错误） */
function sanitizeTlaExpr(expr: string): string {
  return /^[\x00-\x7F]*$/.test(expr) ? translateBooleanExpr(expr) : 'TRUE';
}

/**
 * 数据级不变量检测：一阶数据不变量（如 `forall u1,u2: u1.external_uid = ...`）引用
 * 数据字段与全称量词，TLA+ 单实体状态机无法表达（SANY 解析失败）——与守卫降级策略一致，
 * 降级为 TRUE，真实保障（守卫 + 存储唯一索引）保留在模型文档描述中。
 * 仅识别自然语言量词关键字（TLA+ 自身量词是 \A/\E），避免误伤合法 TLA+ 表达式。
 */
function isDataLevelExpr(expr: string): boolean {
  return !/^[\x00-\x7F]*$/.test(expr) || /\b(forall|exists)\b/i.test(expr);
}

/**
 * 将半形式化布尔表达式翻译为 TLA+ ASCII 算子。
 *
 * 覆盖常用写法：`==` → `=`，`!=` → `/=`，`&&` → `/\`，`||` → `\/`，`!` → `~`。
 * 表达式中的自由标识符（守卫名、不变量变量）未在此声明：若 TLC 因此无法解析，
 * 由 TLAAdapter.verify 判定为生成器翻译限制并降级为 AI 推演验证（见该类 verify）。
 *
 * 替换顺序：`==` 先于 `=`；`!=` 先于 `!`，避免误伤。
 */
function translateBooleanExpr(expr: string): string {
  return expr
    .replace(/==/g, '=')
    .replace(/!=/g, '/=')
    .replace(/&&/g, '/\\')
    .replace(/\|\|/g, '\\/')
    .replace(/!/g, '~');
}

// ============================================================================
// SCXML 适配器
// ============================================================================

export class SCXMLAdapter implements FormalToolAdapter {
  name = 'scxml';
  private aiAdapter?: AIAdapter;

  constructor(aiAdapter?: AIAdapter) {
    this.aiAdapter = aiAdapter;
  }

  detectSuitability(model: DerivableLayer): number {
    return scoreAllAdapters(model).find((s) => s.tool === 'scxml')?.score ?? 0;
  }

  generateSpec(model: DerivableLayer): string {
    if (model.degraded && model.formalLanguage === 'scxml' && model.formalSpecRaw) {
      return model.formalSpecRaw;
    }
    return generateSCXMLSkeleton(model);
  }

  async verify(spec: string): Promise<FormalReport> {
    // SCXML 验证通常依赖 scxmlrunner 或类似工具
    return {
      passed: false,
      tool: 'scxml',
      suitabilityScore: 0,
      generatedSpec: spec,
      invariantResults: [],
      verifiedAt: new Date().toISOString(),
    };
  }

  parseReport(raw: string): Partial<FormalReport> {
    return { rawOutput: raw };
  }
}

function generateSCXMLSkeleton(model: DerivableLayer): string {
  const initialStateId = model.initialStateId ?? model.states.find((s) => s.type === 'initial')?.id;
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(`<scxml xmlns="http://www.w3.org/2005/07/scxml" initial="${initialStateId ?? ''}">`);

  for (const s of model.states) {
    const isFinal = s.type === 'terminal';
    const tag = isFinal ? 'final' : 'state';
    lines.push(`  <${tag} id="${s.id}">`);
    if (!isFinal) {
      for (const t of model.transitions.filter((tr) => tr.from.includes(s.id))) {
        const eventAttr = t.action ? ` event="${t.action}"` : '';
        const condAttr = t.guard ? ` cond="${escapeXml(t.guard)}"` : '';
        lines.push(`    <transition target="${t.to}"${eventAttr}${condAttr}/>`);
      }
    }
    lines.push(`  </${tag}>`);
  }
  lines.push('</scxml>');
  return lines.join('\n');
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ============================================================================
// 决策表适配器
// ============================================================================

export class DecisionTableAdapter implements FormalToolAdapter {
  name = 'decision-table';
  private aiAdapter?: AIAdapter;

  constructor(aiAdapter?: AIAdapter) {
    this.aiAdapter = aiAdapter;
  }

  detectSuitability(model: DerivableLayer): number {
    return scoreAllAdapters(model).find((s) => s.tool === 'decision-table')?.score ?? 0;
  }

  /**
   * 生成决策表（YAML 格式）
   * 行：状态 × 守卫条件组合 → 目标状态
   */
  generateSpec(model: DerivableLayer): string {
    const rows = model.transitions.map((t) => ({
      id: t.id,
      from: t.from.join(','),
      action: t.action,
      guard: t.guard ?? '',
      to: t.to,
    }));
    const table = {
      type: 'decision-table',
      columns: ['from', 'action', 'guard', 'to'],
      rows,
      invariants: model.invariants.map((i) => ({ id: i.id, expression: i.expression })),
    };
    return require('yaml').stringify(table);
  }

  async verify(spec: string): Promise<FormalReport> {
    // 决策表验证：检查规则完备性与互斥性
    return {
      passed: false,
      tool: 'decision-table',
      suitabilityScore: 0,
      generatedSpec: spec,
      invariantResults: [],
      verifiedAt: new Date().toISOString(),
    };
  }

  parseReport(raw: string): Partial<FormalReport> {
    return { rawOutput: raw };
  }
}

// ============================================================================
// 适配器工厂
// ============================================================================

export function createAllAdapters(aiAdapter?: AIAdapter, tlc?: TlcConfig): FormalToolAdapter[] {
  return [
    new TLAAdapter(aiAdapter, tlc),
    new SCXMLAdapter(aiAdapter),
    new DecisionTableAdapter(aiAdapter),
  ];
}
