/**
 * AI 推演桥接 —— 步骤②（AI 执行）
 *
 * 设计依据：《协议驱动自验证工具链设计方案》reasoner 模块、AI参与矩阵
 *
 * 推演四类性质：
 * 1. 可达性：每个状态/转移是否从初始状态可达
 * 2. 死锁：是否存在无出边的非终态（死锁状态）
 * 3. 活性：是否总能最终到达终态
 * 4. 一致性：不变量是否在所有路径上成立
 *
 * 分工策略：
 * - 结构化可达性、死锁检测由代码做确定性预判（图遍历）
 * - 活性、一致性、复杂可达性交由 AI 推演
 * - 退化模式下 AI 直接消费形式化语言
 *
 * 人工检查点：人仲裁推演结论可信度
 */

import type {
  AIAdapter,
  SourceProtocolModel,
  StateDef,
  TransitionDef,
  ReasoningReport,
  ReachabilityResult,
  DeadlockResult,
  LivenessResult,
  ConsistencyResult,
  LivenessMode,
} from '../model/types.js';
import { parseAIJson } from '../ai/adapter.js';
import {
  decomposeStateMachines,
  isCreationTransition,
  type StateMachine,
} from '../model/state-machines.js';

export interface ReasonOptions {
  /** 是否启用代码预判（默认 true，退化模式关闭） */
  useCodePrecheck?: boolean;
  /** 活性判定模式：weak=弱活性（终态可达，默认）；strong=强活性（所有路径终达终态）。
   * 优先级：本选项 > 模型 metadata.liveness 声明 > prose 扫描 > 默认 weak */
  liveness?: LivenessMode;
}

export async function reason(
  model: SourceProtocolModel,
  adapter: AIAdapter,
  options: ReasonOptions = {}
): Promise<ReasoningReport> {
  const { useCodePrecheck = true } = options;
  const derivable = model.derivable;
  const livenessMode = resolveLivenessMode(model, options.liveness);

  // 退化模式：直接交 AI 推演（按声明的活性模式引导 AI）
  if (derivable.degraded) {
    return reasonDegraded(model, adapter, livenessMode);
  }

  // 状态机分解（附属实体隔离）：主状态机 + 附属实体子状态机 + 孤儿组件。
  // 多实体协议（如 P7 US×PS×PI、P1 Mapping+TempMapping SE1）的子状态机各有独立入口，
  // 不参与主状态机的可达性判定（否则从主初始态 BFS 会把子状态机误判为"不可达"）。
  const { main, subMachines, orphanComponents } = decomposeStateMachines(
    derivable.states,
    derivable.transitions,
    derivable.initialStateId
  );

  // 主分析集合 = 主状态机 + 孤儿组件（孤儿无入口必然不可达，按建模错误参与主判定）。
  // 无初始状态（main=null）时回退到全量状态空间，保持既有"无初始状态"失败语义。
  const mainStates = main
    ? [...main.states, ...orphanComponents.flatMap((o) => o.states)]
    : derivable.states;
  const mainTransitions = main
    ? [...main.transitions, ...orphanComponents.flatMap((o) => o.transitions)]
    : derivable.transitions;
  const mainTerminalIds = main
    ? [...main.terminalStateIds, ...orphanComponents.flatMap((o) => o.terminalStateIds)]
    : derivable.terminalStateIds;
  const initialId = derivable.initialStateId ?? mainStates.find((s) => s.type === 'initial')?.id;

  // 正常模式：代码预判 + AI 推演（仅针对主状态机）
  const reachability = useCodePrecheck
    ? codeCheckReachability(mainStates, mainTransitions, initialId)
    : emptyReachability();

  const deadlock = useCodePrecheck
    ? codeCheckDeadlock(mainStates, mainTransitions, mainTerminalIds)
    : emptyDeadlock();

  // 活性：代码确定性判定（弱/强），AI 仅复核
  const liveness = useCodePrecheck
    ? codeCheckLiveness(mainStates, mainTransitions, mainTerminalIds, initialId, livenessMode)
    : { passed: false, violations: [], notes: '未做代码预判', mode: livenessMode };

  // 附属实体子状态机独立分析（advisory，不阻断主状态机结论）
  const subEntitySummary = analyzeSubMachines(subMachines, livenessMode);

  // AI 推演：复核代码预判（含活性），并判断一致性
  const aiResult = await reasonWithAI(model, adapter, {
    reachability,
    deadlock,
    liveness,
    mainStateIds: new Set(mainStates.map((s) => s.id)),
    mainTransitionIds: new Set(mainTransitions.map((t) => t.id)),
    machines: { main, subMachines, orphanComponents },
    subEntitySummary,
  });

  return aiResult;
}

/**
 * 解析活性模式。优先级：CLI 选项 > metadata.liveness 声明 > prose 扫描 > 默认 weak。
 * 默认 weak：终态可达是更实用的业务语义（循环是合法业务）。
 */
function resolveLivenessMode(model: SourceProtocolModel, cliMode?: LivenessMode): LivenessMode {
  if (cliMode === 'weak' || cliMode === 'strong') return cliMode;
  if (model.metadata.liveness) return model.metadata.liveness;
  const prose = [
    model.readable?.background,
    model.readable?.workflow,
    model.metadata.purpose,
  ]
    .filter(Boolean)
    .join('\n');
  const scanned = scanLivenessFromProse(prose);
  if (scanned) return scanned;
  return 'weak';
}

/** 从 prose 扫描活性声明（best-effort，仅匹配显式"采用 X 活性"） */
function scanLivenessFromProse(prose: string): LivenessMode | undefined {
  if (!prose) return undefined;
  const adoptWeak = /采用\s*弱活性/.test(prose) || /弱活性[（(]?终态可达/.test(prose);
  const adoptStrong = /采用\s*强活性/.test(prose) || /强活性[（(]?全路径/.test(prose);
  const notWeak = /不\s*采用\s*弱活性/.test(prose);
  const notStrong = /不\s*采用\s*强活性/.test(prose);
  if (adoptWeak && !notWeak) return 'weak';
  if (adoptStrong && !notStrong) return 'strong';
  return undefined;
}

// ============================================================================
// 代码确定性预判
// ============================================================================

/**
 * 可达性预判：从初始状态 BFS 遍历，标记不可达状态与转移
 */
function codeCheckReachability(
  states: StateDef[],
  transitions: TransitionDef[],
  initialStateId?: string
): ReachabilityResult {
  if (states.length === 0) {
    return { passed: false, unreachableStates: [], unreachableTransitions: [], notes: '状态空间为空' };
  }

  const initialId = initialStateId ?? states.find((s) => s.type === 'initial')?.id;
  if (!initialId) {
    return {
      passed: false,
      unreachableStates: states.map((s) => s.id),
      unreachableTransitions: transitions.map((t) => t.id),
      notes: '无初始状态，无法做可达性分析',
    };
  }

  // BFS
  const reachable = new Set<string>([initialId]);
  const queue: string[] = [initialId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const t of transitions) {
      if (t.from.includes(cur) && !reachable.has(t.to)) {
        reachable.add(t.to);
        queue.push(t.to);
      }
    }
  }

  const unreachableStates = states.filter((s) => !reachable.has(s.id)).map((s) => s.id);
  // 创建转移（from='-'/空，外部入口）不参与"从初始态不可达"判定——它不从任何状态触发
  const unreachableTransitions = transitions
    .filter((t) => !isCreationTransition(t))
    .filter((t) => t.from.some((f) => !reachable.has(f)))
    .map((t) => t.id);

  return {
    passed: unreachableStates.length === 0 && unreachableTransitions.length === 0,
    unreachableStates,
    unreachableTransitions,
    notes: unreachableStates.length === 0 ? '所有状态可达' : `${unreachableStates.length} 个状态不可达`,
  };
}

function emptyReachability(): ReachabilityResult {
  return { passed: true, unreachableStates: [], unreachableTransitions: [], notes: '未做代码预判' };
}

/**
 * 死锁检测：无出边的非终态视为死锁
 */
function codeCheckDeadlock(
  states: StateDef[],
  transitions: TransitionDef[],
  terminalStateIds: string[]
): DeadlockResult {
  const terminalIds = new Set(terminalStateIds);
  const hasOutgoing = new Set<string>();
  for (const t of transitions) {
    for (const f of t.from) hasOutgoing.add(f);
  }

  const deadlockStates = states
    .filter((s) => !terminalIds.has(s.id) && !hasOutgoing.has(s.id) && s.type !== 'terminal')
    .map((s) => s.id);

  return {
    passed: deadlockStates.length === 0,
    deadlockStates,
    notes: deadlockStates.length === 0 ? '无死锁状态' : `${deadlockStates.length} 个死锁状态`,
  };
}

function emptyDeadlock(): DeadlockResult {
  return { passed: true, deadlockStates: [], notes: '未做代码预判' };
}

/**
 * 活性判定（代码确定性，消除 AI 非确定性）：
 * - weak（弱活性/终态可达）：每个可达状态存在一条到达终态的路径。逆向 BFS 从终态沿反向边传播"能到终态"。
 * - strong（强活性/全路径终达）：所有路径最终到达终态。对有限状态机等价于"可达非终态子图无环"，用 Tarjan SCC 检测环。
 *
 * 带循环（如停用/启用环）的模型：弱活性通常满足（环能经出口到终态），强活性不满足（可无限循环）。
 */
function codeCheckLiveness(
  states: StateDef[],
  transitions: TransitionDef[],
  terminalStateIds: string[],
  initialStateId: string | undefined,
  mode: LivenessMode
): LivenessResult {
  const terminalIds = new Set(terminalStateIds);

  const initialId = initialStateId ?? states.find((s) => s.type === 'initial')?.id;
  if (!initialId) {
    return { passed: false, violations: ['无初始状态，无法做活性分析'], notes: '无初始状态', mode };
  }
  if (terminalIds.size === 0) {
    return { passed: false, violations: ['未声明终态，活性质质无法保证'], notes: '无终态', mode };
  }

  // 可达状态（正向 BFS）
  const reachable = new Set<string>([initialId]);
  const queue: string[] = [initialId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const t of transitions) {
      if (t.from.includes(cur) && !reachable.has(t.to)) {
        reachable.add(t.to);
        queue.push(t.to);
      }
    }
  }

  if (mode === 'weak') {
    // 逆向传播：能到终态的状态集（从终态出发沿反向边）
    const canReachTerminal = new Set<string>([...terminalIds]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const t of transitions) {
        if (canReachTerminal.has(t.to)) {
          for (const f of t.from) {
            if (!canReachTerminal.has(f)) {
              canReachTerminal.add(f);
              changed = true;
            }
          }
        }
      }
    }
    const violating = [...reachable].filter((s) => !canReachTerminal.has(s));
    return {
      passed: violating.length === 0,
      violations: violating.map((s) => `状态 ${s} 可达但不存在到达终态的路径（弱活性违反）`),
      notes:
        violating.length === 0
          ? `弱活性满足：所有可达状态均可到达终态（${terminalIds.size} 个终态）`
          : `${violating.length} 个可达状态无法到达终态`,
      mode,
    };
  }

  // strong：可达非终态子图无环
  const nonTerminalReachable = [...reachable].filter((s) => !terminalIds.has(s));
  const ntSet = new Set(nonTerminalReachable);
  const adj = new Map<string, string[]>();
  for (const s of nonTerminalReachable) adj.set(s, []);
  for (const t of transitions) {
    if (ntSet.has(t.to)) {
      for (const f of t.from) {
        if (ntSet.has(f)) adj.get(f)!.push(t.to);
      }
    }
  }
  const cyclic = findCyclicStates(adj);
  return {
    passed: cyclic.length === 0,
    violations: cyclic.map((s) => `状态 ${s} 处于非终态循环中，存在永不到达终态的路径（强活性违反）`),
    notes:
      cyclic.length === 0
        ? '强活性满足：可达非终态子图无环'
        : `${cyclic.length} 个状态处于非终态循环`,
    mode,
  };
}

/** Tarjan SCC：返回处于环中的节点（SCC size≥2，或 size=1 且有自环） */
function findCyclicStates(adj: Map<string, string[]>): string[] {
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cyclic: string[] = [];
  let idx = 0;

  const selfLoop = new Set<string>();
  for (const [u, outs] of adj) {
    if (outs.includes(u)) selfLoop.add(u);
  }

  const stronglyConnect = (root: string) => {
    const work: { v: string; wi: number }[] = [{ v: root, wi: 0 }];
    while (work.length > 0) {
      const top = work[work.length - 1];
      const outs = adj.get(top.v) ?? [];
      if (top.wi === 0) {
        indices.set(top.v, idx);
        lowlinks.set(top.v, idx);
        idx++;
        stack.push(top.v);
        onStack.add(top.v);
      }
      if (top.wi < outs.length) {
        const w = outs[top.wi++];
        if (!indices.has(w)) {
          work.push({ v: w, wi: 0 });
        } else if (onStack.has(w)) {
          lowlinks.set(top.v, Math.min(lowlinks.get(top.v)!, indices.get(w)!));
        }
      } else {
        // 收尾
        if (lowlinks.get(top.v) === indices.get(top.v)) {
          const comp: string[] = [];
          let w: string;
          do {
            w = stack.pop()!;
            onStack.delete(w);
            comp.push(w);
          } while (w !== top.v);
          if (comp.length >= 2) cyclic.push(...comp);
          else if (selfLoop.has(comp[0])) cyclic.push(comp[0]);
        }
        work.pop();
        if (work.length > 0) {
          const parent = work[work.length - 1];
          lowlinks.set(parent.v, Math.min(lowlinks.get(parent.v)!, lowlinks.get(top.v)!));
        }
      }
    }
  };

  for (const v of adj.keys()) {
    if (!indices.has(v)) stronglyConnect(v);
  }
  return cyclic;
}

// ============================================================================
// AI 推演
// ============================================================================

interface PrecheckContext {
  reachability: ReachabilityResult;
  deadlock: DeadlockResult;
  liveness: LivenessResult;
  /** 主分析集合（主状态机 + 孤儿组件）的状态 ID——AI 报告的不可达/死锁清单按此过滤 */
  mainStateIds: Set<string>;
  /** 主分析集合的转移 ID */
  mainTransitionIds: Set<string>;
  /** 状态机分解（供提示词描述附属实体隔离） */
  machines?: {
    main: StateMachine | null;
    subMachines: StateMachine[];
    orphanComponents: StateMachine[];
  };
  /** 附属实体子状态机独立分析摘要（advisory） */
  subEntitySummary?: string[];
}

async function reasonWithAI(
  model: SourceProtocolModel,
  adapter: AIAdapter,
  precheck: PrecheckContext
): Promise<ReasoningReport> {
  const prompt = buildReasoningPrompt(model, precheck);
  const response = await adapter.complete(prompt);

  if (!response.success) {
    return buildFailedReport(precheck, `AI 推演失败：${response.error ?? '未知错误'}`);
  }

  let aiJudgment: AIReasoningOutput;
  try {
    aiJudgment = parseAIJson<AIReasoningOutput>(response.content);
  } catch {
    return buildFailedReport(precheck, 'AI 输出无法解析为 JSON');
  }

  // 合并代码预判与 AI 推演结果。
  // 附属实体子状态机由代码独立分析（advisory），AI 报告若混入子状态机状态/转移
  // （提示词已要求不报，此处防御性过滤），只保留主分析集合内的判定——
  // 子状态机与主初始态不连通是设计使然，不能据此判主状态机不可达。
  const aiUnreachableStates = (aiJudgment.reachability?.unreachableStates ?? []).filter((id) =>
    precheck.mainStateIds.has(id)
  );
  const aiUnreachableTransitions = (aiJudgment.reachability?.unreachableTransitions ?? []).filter((id) =>
    precheck.mainTransitionIds.has(id)
  );
  const subNotes = precheck.subEntitySummary?.length
    ? `附属实体子状态机独立判定（advisory）：${precheck.subEntitySummary.join('；')}`
    : '';
  const reachability: ReachabilityResult = {
    passed:
      precheck.reachability.passed &&
      aiUnreachableStates.length === 0 &&
      aiUnreachableTransitions.length === 0,
    unreachableStates: unique([
      ...precheck.reachability.unreachableStates,
      ...aiUnreachableStates,
    ]),
    unreachableTransitions: unique([
      ...precheck.reachability.unreachableTransitions,
      ...aiUnreachableTransitions,
    ]),
    notes: [aiJudgment.reachability?.notes ?? precheck.reachability.notes, subNotes]
      .filter(Boolean)
      .join('；'),
  };

  const aiDeadlockStates = (aiJudgment.deadlock?.deadlockStates ?? []).filter((id) =>
    precheck.mainStateIds.has(id)
  );
  const deadlock: DeadlockResult = {
    passed: precheck.deadlock.passed && aiDeadlockStates.length === 0,
    deadlockStates: unique([
      ...precheck.deadlock.deadlockStates,
      ...aiDeadlockStates,
    ]),
    notes: aiJudgment.deadlock?.notes ?? precheck.deadlock.notes,
  };

  // 活性：代码确定性判定主导，AI 仅复核（消除纯 AI 的非确定性）
  const aiLiveness = aiJudgment.liveness;
  const aiAgreed = aiLiveness?.passed === precheck.liveness.passed;
  const codeNotes = precheck.liveness.notes ?? '';
  const liveness: LivenessResult = {
    passed: precheck.liveness.passed, // 代码主导，不被 AI 推翻
    violations: precheck.liveness.violations,
    mode: precheck.liveness.mode,
    notes: aiAgreed
      ? `${codeNotes}; AI 复核一致`.replace(/^;\s*/, '')
      : `${codeNotes}; AI 复核结论（${aiLiveness?.passed ? '通过' : '未通过'}）与代码判定（${precheck.liveness.passed ? '通过' : '未通过'}）不一致，以代码为准，请人工仲裁`.replace(/^;\s*/, ''),
  };

  const consistency: ConsistencyResult = {
    passed: aiJudgment.consistency?.passed ?? false,
    violations: aiJudgment.consistency?.violations ?? [],
    notes: aiJudgment.consistency?.notes,
  };

  return {
    passed: reachability.passed && deadlock.passed && liveness.passed && consistency.passed,
    reachability,
    deadlock,
    liveness,
    consistency,
    rawOutput: response.content,
    reasonedAt: new Date().toISOString(),
  };
}

/**
 * 附属实体子状态机独立分析（advisory，不阻断主状态机结论）。
 * 每台子状态机按自身入口（initial 或创建转移目标）做可达/死锁/活性判定，
 * 汇总为摘要文本并入主报告 notes；子状态机问题记录但不参与 reason.passed 硬门。
 */
function analyzeSubMachines(subMachines: StateMachine[], mode: LivenessMode): string[] {
  const notes: string[] = [];
  for (const sm of subMachines) {
    const entry = sm.entryStateIds[0];
    const reach = codeCheckReachability(sm.states, sm.transitions, entry);
    const dead = codeCheckDeadlock(sm.states, sm.transitions, sm.terminalStateIds);
    const live = codeCheckLiveness(sm.states, sm.transitions, sm.terminalStateIds, entry, mode);
    const issues: string[] = [];
    if (!reach.passed) issues.push(`不可达状态 ${reach.unreachableStates.join(', ')}`);
    if (!dead.passed) issues.push(`死锁状态 ${dead.deadlockStates.join(', ')}`);
    if (!live.passed) issues.push(`活性违反：${live.violations.join('；')}`);
    notes.push(
      issues.length === 0
        ? `[${sm.id}] 可达/死锁/活性均通过`
        : `[${sm.id}] ${issues.join('；')}`
    );
  }
  return notes;
}

interface AIReasoningOutput {
  reachability?: {
    passed: boolean;
    unreachableStates?: string[];
    unreachableTransitions?: string[];
    notes?: string;
  };
  deadlock?: {
    passed: boolean;
    deadlockStates?: string[];
    notes?: string;
  };
  liveness?: {
    passed: boolean;
    violations?: string[];
    notes?: string;
  };
  consistency?: {
    passed: boolean;
    violations?: string[];
    notes?: string;
  };
}

function buildReasoningPrompt(
  model: SourceProtocolModel,
  precheck: PrecheckContext
): { system: string; context: string; instruction: string; outputFormat: string; temperature: number } {
  const mode = precheck.liveness.mode ?? 'weak';
  const machines = precheck.machines;
  const stateMachines = machines
    ? {
        main: machines.main
          ? {
              states: machines.main.states.map((s) => s.id),
              transitions: machines.main.transitions.map((t) => t.id),
              initialStateId: machines.main.entryStateIds[0] ?? null,
              terminalStateIds: machines.main.terminalStateIds,
            }
          : null,
        subEntities: machines.subMachines.map((m) => ({
          id: m.id,
          states: m.states.map((s) => s.id),
          transitions: m.transitions.map((t) => t.id),
          entryStateIds: m.entryStateIds,
          terminalStateIds: m.terminalStateIds,
        })),
        orphanStateIds: machines.orphanComponents.flatMap((o) => o.states.map((s) => s.id)),
      }
    : null;
  const context = JSON.stringify(
    {
      metadata: {
        name: model.metadata.name,
        purpose: model.metadata.purpose,
        roles: model.metadata.roles,
        liveness: model.metadata.liveness ?? null,
      },
      background: model.readable?.background ?? '',
      derivable: {
        states: model.derivable.states,
        transitions: model.derivable.transitions,
        invariants: model.derivable.invariants,
        timing: model.derivable.timing,
        exceptions: model.derivable.exceptions,
        initialStateId: model.derivable.initialStateId,
        terminalStateIds: model.derivable.terminalStateIds,
      },
      // 状态机分解：主状态机 + 附属实体子状态机（各有独立入口，非主状态机的"不可达"）
      stateMachines,
      livenessMode: mode,
      codePrecheck: precheck,
    },
    null,
    2
  );

  const hasSubEntities = !!machines && machines.subMachines.length > 0;
  const livenessInstruction =
    mode === 'weak'
      ? '3. 活性（弱活性/终态可达）：从每个可达状态出发，是否都存在一条到达某终态的路径？代码已按此标准判定（见 codePrecheck.liveness），请复核其结论。若发现可达状态无法到达任何终态，列出违反点'
      : '3. 活性（强活性/全路径终达）：从初始状态出发，是否所有路径最终都能到达某个终态？代码已按此标准判定（见 codePrecheck.liveness），请复核其结论。若存在可无限循环不到达终态的路径，列出违反点';

  return {
    system:
      '你是协议推演专家。基于给定的协议状态空间与活性语义声明，判断活性与一致性。' +
      `本次活性判定模式：${mode === 'weak' ? '弱活性（终态可达）' : '强活性（所有路径终达终态）'}。` +
      '代码已做可达性、死锁、活性的确定性预判（针对主状态机），你需要复核代码预判，并判断一致性（不变量是否在所有路径成立）。' +
      '输出严格 JSON，不附加解释文字。活性以代码判定为准，你仅复核；若不确定一致性，passed 设为 false 并在 violations 中说明。',
    context,
    instruction: [
      '请对上述协议做四类推演：',
      `1. 可达性：复核代码预判（针对主状态机 stateMachines.main），是否还有遗漏的主状态机不可达状态/转移${hasSubEntities ? '（附属实体子状态机除外）' : ''}`,
      `2. 死锁：复核代码预判（针对主状态机），是否还有遗漏的死锁状态${hasSubEntities ? '（附属实体子状态机除外）' : ''}`,
      livenessInstruction,
      '4. 一致性：不变量在所有可达状态上是否都成立？若存在违反，列出具体不变量与违反场景',
      '',
      '注意：',
      '- 代码预判已标记的不可达状态/死锁状态应保留在你的输出中',
      ...(hasSubEntities
        ? [
            '- 本协议含附属实体子状态机（stateMachines.subEntities，如临时映射/配件维度等）：它们有独立入口（initial 或创建转移），由代码独立分析（advisory，见 codePrecheck 的 notes / subEntitySummary）',
            '- 子状态机与主初始态不连通是设计使然：不要把子状态机的状态/转移计入主状态机的不可达或死锁清单，也不要因子状态机不可达而判定主状态机不可达',
          ]
        : []),
      '- 活性已由代码按声明的模式确定性判定，你仅复核代码结论（不要自行改用其他活性标准）',
      '- 一致性是代码无法判定的，需你基于状态空间推演',
      '- 时序约束不在本次推演范围（由形式化验证步骤处理）',
    ].join('\n'),
    outputFormat: [
      '返回 JSON：',
      '{',
      '  "reachability": { "passed": boolean, "unreachableStates": ["id", ...], "unreachableTransitions": ["id", ...], "notes": "string" },',
      '  "deadlock": { "passed": boolean, "deadlockStates": ["id", ...], "notes": "string" },',
      '  "liveness": { "passed": boolean, "violations": ["描述", ...], "notes": "string" },',
      '  "consistency": { "passed": boolean, "violations": ["描述", ...], "notes": "string" }',
      '}',
    ].join('\n'),
    temperature: 0.1,
  };
}

// ============================================================================
// 退化模式推演
// ============================================================================

async function reasonDegraded(
  model: SourceProtocolModel,
  adapter: AIAdapter,
  mode: LivenessMode
): Promise<ReasoningReport> {
  const livenessDesc = mode === 'weak' ? '弱活性（每个可达状态存在到达终态的路径）' : '强活性（所有路径最终到达终态）';
  const prompt = {
    system:
      '你是形式化规格推演专家。给定形式化规格（如 TLA+/SCXML），请直接基于形式化语义判断四类性质。' +
      '输出严格 JSON。',
    context: JSON.stringify(
      {
        formalLanguage: model.derivable.formalLanguage,
        formalSpecRaw: model.derivable.formalSpecRaw,
        livenessMode: mode,
      },
      null,
      2
    ),
    instruction: [
      '请基于上述形式化规格判断：',
      '1. 可达性：是否存在不可达状态',
      '2. 死锁：是否存在死锁状态',
      `3. 活性（${livenessDesc}）：按此标准判定，若违反列出违反点`,
      '4. 一致性：不变量是否在所有可达状态成立',
      '若形式化规格本身未显式声明某些性质，标注 notes 说明。',
    ].join('\n'),
    outputFormat: [
      '返回 JSON：',
      '{',
      '  "reachability": { "passed": boolean, "unreachableStates": ["id"], "unreachableTransitions": ["id"], "notes": "string" },',
      '  "deadlock": { "passed": boolean, "deadlockStates": ["id"], "notes": "string" },',
      '  "liveness": { "passed": boolean, "violations": ["描述"], "notes": "string" },',
      '  "consistency": { "passed": boolean, "violations": ["描述"], "notes": "string" }',
      '}',
    ].join('\n'),
    temperature: 0.1,
  };

  const response = await adapter.complete(prompt);
  if (!response.success) {
    return {
      passed: false,
      reachability: { passed: false, unreachableStates: [], unreachableTransitions: [], notes: 'AI 调用失败' },
      deadlock: { passed: false, deadlockStates: [], notes: 'AI 调用失败' },
      liveness: { passed: false, violations: [], notes: 'AI 调用失败', mode },
      consistency: { passed: false, violations: [], notes: 'AI 调用失败' },
      rawOutput: response.error,
      reasonedAt: new Date().toISOString(),
    };
  }

  try {
    const ai = parseAIJson<AIReasoningOutput>(response.content);
    return {
      passed:
        (ai.reachability?.passed ?? false) &&
        (ai.deadlock?.passed ?? false) &&
        (ai.liveness?.passed ?? false) &&
        (ai.consistency?.passed ?? false),
      reachability: {
        passed: ai.reachability?.passed ?? false,
        unreachableStates: ai.reachability?.unreachableStates ?? [],
        unreachableTransitions: ai.reachability?.unreachableTransitions ?? [],
        notes: ai.reachability?.notes,
      },
      deadlock: {
        passed: ai.deadlock?.passed ?? false,
        deadlockStates: ai.deadlock?.deadlockStates ?? [],
        notes: ai.deadlock?.notes,
      },
      liveness: {
        passed: ai.liveness?.passed ?? false,
        violations: ai.liveness?.violations ?? [],
        notes: ai.liveness?.notes,
        mode,
      },
      consistency: {
        passed: ai.consistency?.passed ?? false,
        violations: ai.consistency?.violations ?? [],
        notes: ai.consistency?.notes,
      },
      rawOutput: response.content,
      reasonedAt: new Date().toISOString(),
    };
  } catch {
    return {
      passed: false,
      reachability: { passed: false, unreachableStates: [], unreachableTransitions: [], notes: 'AI 输出解析失败' },
      deadlock: { passed: false, deadlockStates: [], notes: 'AI 输出解析失败' },
      liveness: { passed: false, violations: [], notes: 'AI 输出解析失败', mode },
      consistency: { passed: false, violations: [], notes: 'AI 输出解析失败' },
      rawOutput: response.content,
      reasonedAt: new Date().toISOString(),
    };
  }
}

// ============================================================================
// 工具
// ============================================================================

function unique<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

function buildFailedReport(precheck: PrecheckContext, error: string): ReasoningReport {
  return {
    passed: false,
    reachability: { ...precheck.reachability, notes: `${precheck.reachability.notes ?? ''}; ${error}` },
    deadlock: { ...precheck.deadlock, notes: `${precheck.deadlock.notes ?? ''}; ${error}` },
    // 活性以代码判定为准（即便 AI 失败也保留代码结论），仅标注 AI 复核缺失
    liveness: {
      passed: precheck.liveness.passed,
      violations: precheck.liveness.violations,
      mode: precheck.liveness.mode,
      notes: `${precheck.liveness.notes ?? ''}; AI 复核失败（${error}），以代码判定为准`,
    },
    consistency: { passed: false, violations: [error], notes: 'AI 推演失败，无法判断' },
    reasonedAt: new Date().toISOString(),
  };
}
