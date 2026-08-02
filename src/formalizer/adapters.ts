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
  /** 当前规格是否为退化模式透传（用户自写 TLA+）：其解析/语义错误属用户规格缺陷，保持权威失败 */
  private degradedSpec = false;

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
    this.degradedSpec = model.degraded && model.formalLanguage === 'tla' && !!model.formalSpecRaw;
    if (this.degradedSpec) {
      return model.formalSpecRaw!;
    }
    // 代码生成基础骨架（不依赖 AI，保证确定性）
    return generateTLASkeleton(model);
  }

  /**
   * 验证 TLA+ 规格
   *
   * 配置了 tlc（protochain.config.yaml 的 `tlc` 段）时，通过 portable JRE +
   * tla2tools.jar 真实运行 TLC 模型检查。
   * 一旦 TLC 成功启动，其结果即权威（toolExecuted=true）：
   * - 不变量违反 / 规格解析失败 / 执行超时 → 直接报告失败，不尝试 AI；
   * 仅当 TLC 完全无法启动（未配置 / java 缺失）时返回占位报告（passed=false），
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
      // 工具无法启动（如 java 不存在）→ 允许降级 AI
      if (run.spawnError) {
        return this.buildPlaceholder(spec, `TLC 启动失败：${run.spawnError}`);
      }
      // 工具已启动但超时 → 权威失败（不尝试 AI），rawOutput 保留实际输出
      if (run.timedOut) {
        return {
          passed: false,
          tool: 'tla',
          suitabilityScore: 0,
          generatedSpec: spec,
          rawOutput: [
            `TLC 执行超时（${this.tlc.timeoutMs ?? DEFAULT_TLC_TIMEOUT_MS}ms）`,
            rawOutput,
          ].filter(Boolean).join('\n'),
          invariantResults: [],
          verifiedAt: new Date().toISOString(),
          toolExecuted: true,
        };
      }
      const parsed = parseTlcOutput(rawOutput, run.invariantIds);
      // TLC 已启动但规格解析/语义分析失败：
      // - 退化模式（用户自写 TLA+）：属用户规格缺陷 → 权威失败（toolExecuted: true），不尝试 AI
      // - 正常模式（代码生成的骨架）：未声明的守卫/不变量标识符是生成器翻译限制，
      //   工具未产出验证结论 → toolExecuted: false，由 formalize 降级为 AI 推演验证
      if (parsed.errorLines.length > 0) {
        return {
          passed: false,
          tool: 'tla',
          suitabilityScore: 0,
          generatedSpec: spec,
          rawOutput: parsed.errorLines.join('\n') || rawOutput,
          invariantResults: [],
          verifiedAt: new Date().toISOString(),
          toolExecuted: this.degradedSpec,
        };
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
      return this.buildPlaceholder(spec, err instanceof Error ? err.message : String(err));
    }
  }

  /** 工具不可用时的占位报告（passed=false，formalize 据此降级为 AI 推演） */
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
 */
function generateTLASkeleton(model: DerivableLayer): string {
  const moduleName = 'Protocol';
  const stateIds = model.states.map((s) => s.id);
  const variableName = 'state';
  const initialStateId = model.initialStateId ?? model.states.find((s) => s.type === 'initial')?.id;

  const lines: string[] = [];
  lines.push(`---- MODULE ${moduleName} ----`);
  lines.push('EXTENDS Naturals, Sequences');
  lines.push(`VARIABLES ${variableName}`);
  lines.push('');
  lines.push('(* 状态空间 *)');
  lines.push(`States == {${stateIds.map((id) => `"${id}"`).join(', ')}}`);
  lines.push('');

  // Init
  lines.push('(* 初始状态 *)');
  if (initialStateId) {
    lines.push(`Init == ${variableName} = "${initialStateId}"`);
  } else {
    lines.push(`Init == FALSE (* 缺少初始状态 *)`);
  }
  lines.push('');

  // Next：所有转移的析取
  lines.push('(* 下一状态关系 *)');
  const nextCases: string[] = [];
  for (const t of model.transitions) {
    // 注意：`/\\ ` 必须是双反斜杠 —— 模板字符串里 `\ `（反斜杠+空格）会被 JS 当作转义吃掉反斜杠
    // 多源转移 → 源状态析取；`from: -`（无源入口转移）→ 恒真
    const fromConditions = t.from
      .map((f) => (f === '-' || f === '' ? 'TRUE' : `${variableName} = "${f}"`))
      .join(' \\/ ');
    const guard = t.guard ? `/\\ ${translateBooleanExpr(t.guard)}` : '';
    nextCases.push(
      `(* ${t.name}: ${t.from.join('/')} -> ${t.to} *)\n  /\\ ${fromConditions}${guard}\n  /\\ ${variableName}' = "${t.to}"`
    );
  }
  if (nextCases.length > 0) {
    lines.push(`Next == \\* (转移析取)`);
    lines.push(`  ${nextCases.join('\n  \\/ ')}`);
  } else {
    lines.push(`Next == FALSE (* 无转移 *)`);
  }
  lines.push('');

  // 不变量
  for (const inv of model.invariants) {
    lines.push(`(* 不变量: ${inv.name} *)`);
    lines.push(`${inv.id} == ${translateBooleanExpr(inv.expression)}`);
    lines.push('');
  }

  // TypeInvariant
  lines.push('(* 类型不变量 *)');
  lines.push(`TypeInvariant == ${variableName} \\in States`);
  lines.push('');

  // Spec
  lines.push('(* 完整规格 *)');
  lines.push(`Spec == Init /\\ [][Next]_${variableName}`);
  lines.push('');

  // 聚合不变量
  if (model.invariants.length > 0) {
    lines.push('(* 聚合不变量 *)');
    lines.push(`AllInvariants == /\\ ${model.invariants.map((i) => i.id).join('\n  /\\ ')}`);
    lines.push('');
  }

  lines.push('=============================================');
  return lines.join('\n');
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
