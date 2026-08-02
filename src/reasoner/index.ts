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
  DerivableLayer,
  ReasoningReport,
  ReachabilityResult,
  DeadlockResult,
  LivenessResult,
  ConsistencyResult,
} from '../model/types.js';
import { parseAIJson } from '../ai/adapter.js';

export interface ReasonOptions {
  /** 是否启用代码预判（默认 true，退化模式关闭） */
  useCodePrecheck?: boolean;
}

export async function reason(
  model: SourceProtocolModel,
  adapter: AIAdapter,
  options: ReasonOptions = {}
): Promise<ReasoningReport> {
  const { useCodePrecheck = true } = options;
  const derivable = model.derivable;

  // 退化模式：直接交 AI 推演
  if (derivable.degraded) {
    return reasonDegraded(model, adapter);
  }

  // 正常模式：代码预判 + AI 推演
  const reachability = useCodePrecheck
    ? codeCheckReachability(derivable)
    : emptyReachability();

  const deadlock = useCodePrecheck
    ? codeCheckDeadlock(derivable)
    : emptyDeadlock();

  // AI 推演：补全代码预判未覆盖的部分，并判断活性、一致性
  const aiResult = await reasonWithAI(model, adapter, {
    reachability,
    deadlock,
  });

  return aiResult;
}

// ============================================================================
// 代码确定性预判
// ============================================================================

/**
 * 可达性预判：从初始状态 BFS 遍历，标记不可达状态与转移
 */
function codeCheckReachability(derivable: DerivableLayer): ReachabilityResult {
  const states = derivable.states;
  const transitions = derivable.transitions;

  if (states.length === 0) {
    return { passed: false, unreachableStates: [], unreachableTransitions: [], notes: '状态空间为空' };
  }

  const initialId = derivable.initialStateId ?? states.find((s) => s.type === 'initial')?.id;
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
  const unreachableTransitions = transitions
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
function codeCheckDeadlock(derivable: DerivableLayer): DeadlockResult {
  const terminalIds = new Set(derivable.terminalStateIds);
  const hasOutgoing = new Set<string>();
  for (const t of derivable.transitions) {
    for (const f of t.from) hasOutgoing.add(f);
  }

  const deadlockStates = derivable.states
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

// ============================================================================
// AI 推演
// ============================================================================

interface PrecheckContext {
  reachability: ReachabilityResult;
  deadlock: DeadlockResult;
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

  // 合并代码预判与 AI 推演结果
  const reachability: ReachabilityResult = {
    passed: precheck.reachability.passed && (aiJudgment.reachability?.passed ?? true),
    unreachableStates: unique([
      ...precheck.reachability.unreachableStates,
      ...(aiJudgment.reachability?.unreachableStates ?? []),
    ]),
    unreachableTransitions: unique([
      ...precheck.reachability.unreachableTransitions,
      ...(aiJudgment.reachability?.unreachableTransitions ?? []),
    ]),
    notes: aiJudgment.reachability?.notes ?? precheck.reachability.notes,
  };

  const deadlock: DeadlockResult = {
    passed: precheck.deadlock.passed && (aiJudgment.deadlock?.passed ?? true),
    deadlockStates: unique([
      ...precheck.deadlock.deadlockStates,
      ...(aiJudgment.deadlock?.deadlockStates ?? []),
    ]),
    notes: aiJudgment.deadlock?.notes ?? precheck.deadlock.notes,
  };

  const liveness: LivenessResult = {
    passed: aiJudgment.liveness?.passed ?? false,
    violations: aiJudgment.liveness?.violations ?? [],
    notes: aiJudgment.liveness?.notes,
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
  const context = JSON.stringify(
    {
      metadata: {
        name: model.metadata.name,
        purpose: model.metadata.purpose,
        roles: model.metadata.roles,
      },
      derivable: {
        states: model.derivable.states,
        transitions: model.derivable.transitions,
        invariants: model.derivable.invariants,
        timing: model.derivable.timing,
        exceptions: model.derivable.exceptions,
        initialStateId: model.derivable.initialStateId,
        terminalStateIds: model.derivable.terminalStateIds,
      },
      codePrecheck: precheck,
    },
    null,
    2
  );

  return {
    system:
      '你是协议推演专家。基于给定的协议状态空间，判断活性（是否总能到达终态）与一致性（不变量是否在所有路径成立）。' +
      '代码已做了可达性与死锁的预判，你需要补全活性与一致性的判断，并复核代码预判结果。' +
      '输出严格 JSON，不附加解释文字。若不确定，passed 设为 false 并在 violations 中说明。',
    context,
    instruction: [
      '请对上述协议做四类推演：',
      '1. 可达性：复核代码预判，是否还有遗漏的不可达状态/转移',
      '2. 死锁：复核代码预判，是否还有遗漏的死锁状态',
      '3. 活性：从初始状态出发，是否所有路径最终都能到达某个终态？若存在无法到达终态的路径，列出违反点',
      '4. 一致性：不变量在所有可达状态上是否都成立？若存在违反，列出具体不变量与违反场景',
      '',
      '注意：',
      '- 代码预判已标记的不可达状态/死锁状态应保留在你的输出中',
      '- 活性与一致性是代码无法判定的，需你基于状态空间推演',
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
  adapter: AIAdapter
): Promise<ReasoningReport> {
  const prompt = {
    system:
      '你是形式化规格推演专家。给定形式化规格（如 TLA+/SCXML），请直接基于形式化语义判断四类性质。' +
      '输出严格 JSON。',
    context: JSON.stringify(
      {
        formalLanguage: model.derivable.formalLanguage,
        formalSpecRaw: model.derivable.formalSpecRaw,
      },
      null,
      2
    ),
    instruction: [
      '请基于上述形式化规格判断：',
      '1. 可达性：是否存在不可达状态',
      '2. 死锁：是否存在死锁状态',
      '3. 活性：是否所有路径最终满足活性条件',
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
      liveness: { passed: false, violations: [], notes: 'AI 调用失败' },
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
      liveness: { passed: false, violations: [], notes: 'AI 输出解析失败' },
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
    liveness: { passed: false, violations: [error], notes: 'AI 推演失败，无法判断' },
    consistency: { passed: false, violations: [error], notes: 'AI 推演失败，无法判断' },
    reasonedAt: new Date().toISOString(),
  };
}
