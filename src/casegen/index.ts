/**
 * 测试用例生成 —— 步骤⑦（AI 执行者 + 代码翻译者）
 *
 * 设计依据：《协议驱动自验证工具链设计方案》casegen 模块、覆盖度准则
 *
 * 职责：
 * 1. 协议路径遍历：从初始状态出发，按状态机生成路径用例
 * 2. 覆盖度准则：
 *    - 默认：状态覆盖 + 转移覆盖（有限且充分性可接受）
 *    - 可选：路径覆盖（带最大路径长度限制，默认状态数的2倍）
 * 3. 循环检测：避免路径爆炸
 * 4. 覆盖度报告：标注未覆盖项与处置建议
 *
 * 退化模式：基于已提取的 states/transitions 生成路径
 */

import type {
  SourceProtocolModel,
  DerivableLayer,
  ProtocolPath,
  TestCaseSet,
  CoverageReport,
  CoverageDetail,
  UncoveredDisposition,
  StateDef,
  StateDimension,
  AIAdapter,
  AIPrompt,
  AdversarialCase,
  AdversarialCaseKind,
  JSONSchema,
  SchemaExpression,
  TransitionDef,
  CredentialDeclaration,
} from '../model/types.js';
import { parseAIJson } from '../ai/adapter.js';
import {
  runGenerationLoop,
  type GenerationAttempt,
  type GenerationLoopOptions,
} from '../ai/generation-loop.js';
import {
  decomposeStateMachines,
  isCreationTransition,
  type StateMachine,
} from '../model/state-machines.js';
import { buildDimensionKinds } from '../model/dimension-kind.js';
import { translatePredicate } from '../specifier/predicates.js';

export interface CaseGenOptions {
  /** 覆盖度准则 */
  criterion?: 'state' | 'transition' | 'path';
  /** 路径覆盖时的最大路径长度（默认状态数的2倍） */
  maxPathLength?: number;
  /** 最大生成路径数（防止爆炸） */
  maxPaths?: number;
}

export interface CaseGenAIOptions extends CaseGenOptions {
  /** AI 生成 loop 的预算（maxIterations / maxTokens / maxToolCalls） */
  loop?: GenerationLoopOptions;
}

export function generateCases(
  model: SourceProtocolModel,
  options: CaseGenOptions = {}
): TestCaseSet {
  const {
    criterion = 'state',
    maxPathLength = Math.max(6, model.derivable.states.length * 2),
    maxPaths = 100,
  } = options;

  const derivable = model.derivable;
  const initialStateId = derivable.initialStateId ??
    derivable.states.find((s) => s.type === 'initial')?.id;

  // G7-S4：对抗性用例（X5 observed 直写违例 / X6 guard 失败后状态不变 / X12 收敛断言）
  // 与状态机路径生成正交：无初始状态时同样生成（不依赖路径可达性）。
  const adversarial = generateAdversarialCases(model);

  if (!initialStateId) {
    // 无初始状态：无法生成路径，但覆盖度报告仍应反映实际状态/转移总数
    return {
      paths: [],
      coverage: computeCoverage(derivable, [], criterion, maxPathLength),
      generatedAt: new Date().toISOString(),
      ...(adversarial.cases.length > 0
        ? { adversarialCases: adversarial.cases }
        : {}),
      ...(adversarial.degradedReasons.length > 0
        ? { degradedReasons: adversarial.degradedReasons }
        : {}),
    };
  }

  // 1. 路径生成 —— 按状态机分解拆分主/附属子状态机独立生成（修改单 003）
  // 多实体协议（如 P7 US×PS×PI、P1 Mapping+TempMapping SE1）的子状态机有独立入口，
  // 从主初始态 BFS 物理上无法触达 PS/PI 维度的状态/转移，导致 AI 5 轮仍生成非法路径。
  // 单状态机模型（hsk-ng P1/P2/P4/P5/P6、P7 US 维度）：main 唯一，所有状态/转移归 main，
  // subMachines 为空，行为与既有逻辑一致。
  const { main, subMachines, orphanComponents } = decomposeStateMachines(
    derivable.states,
    derivable.transitions,
    initialStateId
  );
  const paths = generatePathsForMachines(
    { main, subMachines, orphanComponents },
    criterion,
    maxPathLength,
    maxPaths
  );

  // 2. 覆盖度分析（仍对全量状态/转移统计；子状态机覆盖度由独立报告 advisory 给出）
  const coverage = computeCoverage(derivable, paths, criterion, maxPathLength);
  // 附属实体子状态机独立覆盖度（advisory，不阻断主报告 passed）
  const submachineCoverage = computeSubmachineCoverage(subMachines, paths);

  return {
    paths,
    coverage,
    generatedAt: new Date().toISOString(),
    // 通过自定义扩展字段承载附属实体覆盖度——TypeScript 上无对应字段时按 unknown 透传
    ...(submachineCoverage ? { submachineCoverage } : {}),
    ...(adversarial.cases.length > 0
      ? { adversarialCases: adversarial.cases }
      : {}),
    ...(adversarial.degradedReasons.length > 0
      ? { degradedReasons: adversarial.degradedReasons }
      : {}),
  } as TestCaseSet;
}

/**
 * P3：AI 辅助生成测试用例，loop 内以覆盖度报告作为机械预检信号：
 * 未覆盖状态/转移 -> feedback 交给 AI 补路径 -> 重试，直到准则达标或预算耗尽。
 *
 * 与 generateCases 的关系：确定性路径（generateCases）保持默认可用；
 * 本函数仅在调用方显式传入 AI 适配器并启用 AI 生成时使用。
 */
export async function generateCasesWithAI(
  model: SourceProtocolModel,
  aiAdapter: AIAdapter,
  options: CaseGenAIOptions = {}
): Promise<TestCaseSet> {
  const {
    criterion = 'state',
    maxPathLength = Math.max(6, model.derivable.states.length * 2),
    maxPaths = 100,
    loop,
  } = options;

  const derivable = model.derivable;
  const initialStateId =
    derivable.initialStateId ??
    derivable.states.find((s) => s.type === 'initial')?.id;

  // G7-S4：对抗性用例（与 AI 路径生成正交，确定性生成）
  const adversarial = generateAdversarialCases(model);

  if (!initialStateId) {
    // 与确定性路径一致：无初始状态时返回空路径 + 覆盖度报告
    return {
      paths: [],
      coverage: computeCoverage(derivable, [], criterion, maxPathLength),
      generatedAt: new Date().toISOString(),
      ...(adversarial.cases.length > 0
        ? { adversarialCases: adversarial.cases }
        : {}),
      ...(adversarial.degradedReasons.length > 0
        ? { degradedReasons: adversarial.degradedReasons }
        : {}),
    };
  }

  // 状态机分解（修改单 003）：把主状态机 + 附属子状态机的入口与状态/转移注入提示词，
  // 让 AI 知道"主初始态 BFS 触不到的子状态机需要独立入口路径"。
  const { main, subMachines, orphanComponents } = decomposeStateMachines(
    derivable.states,
    derivable.transitions,
    initialStateId
  );

  const transitionsById = new Map(derivable.transitions.map((t) => [t.id, t]));
  const { result: materialized } = await runGenerationLoop<MaterializeResult>(
    aiAdapter,
    {
      buildPrompt: ({ iteration, previousAttempts }) =>
        buildCasesPrompt(
          derivable,
          initialStateId,
          criterion,
          maxPathLength,
          maxPaths,
          iteration,
          previousAttempts,
          { main, subMachines, orphanComponents }
        ),
      parse: async (content) => {
        const parsed = parseAIJson<{
          paths?: Array<{ transitionIds?: unknown; description?: string }>;
        }>(content);
        if (!parsed || !Array.isArray(parsed.paths)) {
          throw new Error('输出缺少 paths 数组');
        }
        const candidates = parsed.paths.map((p, i) => {
          if (
            !Array.isArray(p.transitionIds) ||
            !p.transitionIds.every((tid) => typeof tid === 'string')
          ) {
            throw new Error(`第 ${i + 1} 条路径的 transitionIds 非法（需为字符串数组）`);
          }
          return {
            id: `PATH_AI_${String(i + 1).padStart(3, '0')}`,
            transitionIds: p.transitionIds as string[],
            description: p.description,
          };
        });
        // 注入子状态机入口状态作为合法的"虚拟起点"——AI 给的路径若以子状态机入口
        // 开头（previousState 缺失），把它当作从 entry 出发的独立路径。
        return materializePaths(
          candidates,
          transitionsById,
          initialStateId,
          maxPaths,
          subMachines
        );
      },
      preflight: async (candidate) => {
        const coverage = computeCoverage(
          derivable,
          candidate.valid,
          criterion,
          maxPathLength
        );
        if (!judgeCoveragePass(coverage)) {
          const uncovered = coverage.uncoveredDispositions
            .map((u) => `[${u.elementType}] ${u.elementId}`)
            .join('、');
          const feedback = [
            candidate.invalidIssues.length > 0
              ? `非法路径：${candidate.invalidIssues.join('；')}`
              : '',
            uncovered ? `未覆盖项：${uncovered}` : '覆盖度仍未达标',
            '请补充路径使所有状态/转移被覆盖（返回 paths 数组，元素为 { transitionIds: string[], description?: string }）。',
          ]
            .filter(Boolean)
            .join('\n');
          return { passed: false, feedback };
        }
        return { passed: true, result: candidate };
      },
    },
    loop
  );

  const paths = materialized.valid;
  return {
    paths,
    coverage: computeCoverage(derivable, paths, criterion, maxPathLength),
    generatedAt: new Date().toISOString(),
    ...(adversarial.cases.length > 0
      ? { adversarialCases: adversarial.cases }
      : {}),
    ...(adversarial.degradedReasons.length > 0
      ? { degradedReasons: adversarial.degradedReasons }
      : {}),
  };
}

/** 覆盖度准则是否达标（与步骤执行器 judgePass 同规则） */
export function judgeCoveragePass(coverage: CoverageReport): boolean {
  if (coverage.criterion === 'state') {
    return coverage.stateCoverage.ratio === 1;
  }
  if (coverage.criterion === 'transition') {
    return coverage.transitionCoverage.ratio === 1;
  }
  if (coverage.criterion === 'path') {
    return coverage.stateCoverage.ratio > 0;
  }
  return false;
}

interface MaterializeResult {
  valid: ProtocolPath[];
  invalidIssues: string[];
}

/**
 * 把 AI 返回的转移 ID 序列落地为 ProtocolPath：
 * - 从初始状态出发逐步走转移，校验转移存在且 from 匹配当前状态；
 * - 序列中任一环非法则整条丢弃，并记录问题供 AI 修正。
 *
 * 修改单 003：允许路径以附属实体子状态机的入口（subMachines[*].entryStateIds[0]）
 * 作为起点——多实体协议的子状态机从主初始态 BFS 物理上不可达，AI 给的子状态机路径
 * 若首条转移的 from 匹配某个子状态机入口，重置 current 为该入口再校验后续转移。
 */
function materializePaths(
  candidatePaths: Array<{ id: string; transitionIds: string[]; description?: string }>,
  transitionsById: Map<string, DerivableLayer['transitions'][number]>,
  initialStateId: string,
  maxPaths: number,
  subMachines: StateMachine[] = []
): MaterializeResult {
  // 收集所有合法起点：主初始态 + 各子状态机入口
  const validStarts = new Set<string>([initialStateId]);
  for (const sm of subMachines) {
    for (const e of sm.entryStateIds) validStarts.add(e);
  }

  const valid: ProtocolPath[] = [];
  const invalidIssues: string[] = [];
  for (const candidate of candidatePaths.slice(0, maxPaths)) {
    if (candidate.transitionIds.length === 0) {
      invalidIssues.push(`路径 ${candidate.id} 为空`);
      continue;
    }
    const firstTid = candidate.transitionIds[0];
    const firstT = transitionsById.get(firstTid);
    if (!firstT) {
      invalidIssues.push(`路径 ${candidate.id} 引用未知转移 ${firstTid}`);
      continue;
    }
    // 推断起点：第一个转移的 from 中若有合法起点（主初始态/子状态机入口），
    // 就把 current 设为它；否则从主初始态出发，触发"与当前状态不匹配"。
    const possibleStart = firstT.from.find((f) => validStarts.has(f));
    if (!possibleStart) {
      invalidIssues.push(
        `路径 ${candidate.id} 首条转移 ${firstTid} 的 from ${JSON.stringify(firstT.from)} 与任何已知起点（主初始态 ${initialStateId} 或附属实体入口 ${[...validStarts].join('/')}）不匹配`
      );
      continue;
    }
    const stateIds: string[] = [possibleStart];
    let current = possibleStart;
    let broken = false;
    for (const tid of candidate.transitionIds) {
      const t = transitionsById.get(tid);
      if (!t) {
        invalidIssues.push(`路径 ${candidate.id} 引用未知转移 ${tid}`);
        broken = true;
        break;
      }
      if (!t.from.includes(current)) {
        invalidIssues.push(`路径 ${candidate.id} 转移 ${tid} 与当前状态 ${current} 不匹配`);
        broken = true;
        break;
      }
      current = t.to;
      stateIds.push(current);
    }
    if (broken) continue;
    valid.push({
      id: candidate.id,
      transitionIds: [...candidate.transitionIds],
      stateIds,
      length: candidate.transitionIds.length,
      description: candidate.description ?? stateIds.join(' -> '),
    });
  }
  return { valid, invalidIssues };
}

function buildCasesPrompt(
  derivable: DerivableLayer,
  initialStateId: string,
  criterion: 'state' | 'transition' | 'path',
  maxPathLength: number,
  maxPaths: number,
  iteration: number,
  previousAttempts: GenerationAttempt<MaterializeResult>[],
  machines?: {
    main: StateMachine | null;
    subMachines: StateMachine[];
    orphanComponents: StateMachine[];
  }
): AIPrompt {
  const submachineSummary = machines && machines.subMachines.length > 0
    ? {
        subEntities: machines.subMachines.map((m) => ({
          id: m.id,
          entryStateIds: m.entryStateIds,
          states: m.states.map((s) => s.id),
          transitions: m.transitions.map((t) => t.id),
        })),
      }
    : null;

  const context = JSON.stringify(
    {
      initialStateId,
      terminalStateIds: derivable.terminalStateIds,
      states: derivable.states.map((s) => ({
        id: s.id,
        type: s.type,
        dimensions: s.dimensions,
      })),
      transitions: derivable.transitions.map((t) => ({
        id: t.id,
        from: t.from,
        to: t.to,
        action: t.action,
      })),
      // 状态机分解（修改单 003）：提示 AI 主/附属子状态机各需独立覆盖路径
      submachineSummary,
    },
    null,
    2
  );

  const criterionText =
    criterion === 'state'
      ? '覆盖全部状态（每个状态至少被一条路径访问）'
      : criterion === 'transition'
        ? '覆盖全部转移（每个转移至少被一条路径执行）'
        : '覆盖尽可能多的状态/转移（路径覆盖）';

  const instruction: string[] = [
    `第 ${iteration} 次生成。请根据协议状态机设计测试用例路径，要求：${criterionText}。`,
    `- 每条路径从初始状态 ${initialStateId} 出发，按转移 ID 序列推进；`,
    `- transitionIds 中的每个转移必须存在且 from 与当前状态匹配；`,
    `- 最多 ${maxPaths} 条路径，单条长度不超过 ${maxPathLength}；`,
    '只返回 JSON：{"paths":[{"transitionIds":["T1","T2"],"description":"路径说明"}]}',
  ];

  // 修改单 003：协议含附属实体子状态机时，提示 AI 为每个子状态机入口单独生成路径
  if (submachineSummary) {
    const subList = submachineSummary.subEntities
      .map(
        (s) =>
          `  - ${s.id}: 入口 ${JSON.stringify(s.entryStateIds)}；状态 ${s.states.length} 个、转移 ${s.transitions.length} 条`
      )
      .join('\n');
    instruction.push(
      '',
      `【修改单 003】本协议含附属实体子状态机（subEntities）——它们有独立入口（${submachineSummary.subEntities
        .flatMap((s) => s.entryStateIds)
        .join('/')} 等），主初始态 BFS 无法触达。`,
      '请为每个附属实体入口分别生成至少一条路径（首条转移的 from 匹配该入口即可），',
      '让 subEntities 列表中的状态/转移也被覆盖。子状态机与主状态机不互通是设计使然，不要试图用主状态机转移触发子状态机。',
      '',
      '附属实体子状态机：',
      subList
    );
  }
  const feedbacks = previousAttempts
    .map((a) => a.preflight.feedback)
    .filter((f): f is string => Boolean(f));
  if (feedbacks.length > 0) {
    instruction.push(
      '',
      '上一轮的机械预检未通过，请根据以下反馈补充/修正路径后重新返回完整 JSON：',
      feedbacks.map((f) => `---\n${f}`).join('\n')
    );
  }

  return {
    system:
      '你是协议测试用例生成器。你只根据状态机结构返回合法路径 JSON，覆盖度由机械层校验。',
    context,
    instruction: instruction.join('\n'),
    outputFormat: 'JSON：{"paths":[{"transitionIds":["T1"],"description":"..."}]}',
    temperature: 0.3,
  };
}

// ============================================================================
// 路径生成（修改单 003：按状态机分解拆分主/附属子状态机）
// ============================================================================

/**
 * 把主状态机 + 附属实体子状态机 + 孤儿组件按各自入口独立生成路径。
 * 主状态机路径在前，附属子状态机路径随后；ID 用 `PATH_NN_main` / `PATH_NN_sub_<idx>` 前缀区分。
 * 单状态机模型（subMachines 为空）退化为单 BFS，行为与既有逻辑完全一致。
 *
 * 注意：main 为 null 时回退到全量 BFS（保持既有"无初始状态"语义失败处理）。
 */
function generatePathsForMachines(
  machines: {
    main: StateMachine | null;
    subMachines: StateMachine[];
    orphanComponents: StateMachine[];
  },
  criterion: 'state' | 'transition' | 'path',
  maxLen: number,
  maxPaths: number
): ProtocolPath[] {
  const paths: ProtocolPath[] = [];

  // 主状态机优先（占大头预算：maxPaths 的 ~70%）
  if (machines.main) {
    const mainBudget = Math.max(1, Math.floor(maxPaths * 0.7));
    const mainPaths = generatePathsForOneMachine(
      machines.main,
      criterion,
      maxLen,
      mainBudget
    );
    for (const p of mainPaths) {
      paths.push(renamePathId(p, `${p.id}_main`));
    }
  } else {
    // 无主状态机（main=null）：回退到全量 BFS（与既有"无初始状态"语义保持一致——
    // 现有 generateCases 在 initialStateId 缺失时已直接返回空 paths；这里 main=null
    // 通常是 decomposeStateMachines 找不到 initialStateId 所在分量的极端边界）
    const fallbackEntry = machines.subMachines[0]?.entryStateIds[0];
    if (fallbackEntry) {
      const allMachinesLayer = collectAllTransitionsFromMachines(machines);
      const fallback = generatePathsFromInitial(
        allMachinesLayer,
        fallbackEntry,
        criterion,
        maxLen,
        maxPaths
      );
      paths.push(...fallback);
    }
  }

  // 附属实体子状态机独立生成（均分剩余预算）
  if (machines.subMachines.length > 0) {
    const remaining = Math.max(1, maxPaths - paths.length);
    const perSub = Math.max(1, Math.floor(remaining / machines.subMachines.length));
    machines.subMachines.forEach((sm, idx) => {
      const subPaths = generatePathsForOneMachine(sm, criterion, maxLen, perSub);
      for (const p of subPaths) {
        paths.push(renamePathId(p, `${p.id}_sub_${idx}`));
      }
    });
  }

  // 孤儿组件：无入口必然不可达，但其状态/转移仍计入覆盖度报告的 uncoveredIds
  // （保持与 modify-001 reason SE 隔离一致：孤儿由主判定参与，casegen 这边不强行覆盖）

  return paths;
}

/** 给一条路径换 ID（保留原 transitionIds/stateIds/description，仅改 id 与前缀语义） */
function renamePathId(p: ProtocolPath, newId: string): ProtocolPath {
  return { ...p, id: newId };
}

/** 汇总所有机器的 states/transitions/terminalStateIds（main=null 时的回退用） */
function collectAllTransitionsFromMachines(machines: {
  main: StateMachine | null;
  subMachines: StateMachine[];
  orphanComponents: StateMachine[];
}): DerivableLayer {
  const states: StateDef[] = [];
  const transitions: DerivableLayer['transitions'] = [];
  const terminalStateIds: string[] = [];
  for (const m of [machines.main, ...machines.subMachines, ...machines.orphanComponents]) {
    if (!m) continue;
    for (const s of m.states) if (!states.find((x) => x.id === s.id)) states.push(s);
    for (const t of m.transitions) if (!transitions.find((x) => x.id === t.id)) transitions.push(t);
    for (const id of m.terminalStateIds) if (!terminalStateIds.includes(id)) terminalStateIds.push(id);
  }
  // 仅 BFS 用到 states/transitions/terminalStateIds；其余 DerivableLayer 字段补默认
  return {
    states,
    transitions,
    terminalStateIds,
    invariants: [],
    timing: [],
    exceptions: [],
    degraded: false,
  };
}

/**
 * 对单台状态机（main 或 sub）生成路径：以 entryStateIds[0] 为起点。
 * 单状态机模型下退化为原 generatePaths 行为（main 唯一，subMachines 为空，路径生成预算相同）。
 */
function generatePathsForOneMachine(
  machine: StateMachine,
  criterion: 'state' | 'transition' | 'path',
  maxLen: number,
  maxPaths: number
): ProtocolPath[] {
  const entry = machine.entryStateIds[0];
  if (!entry) return [];

  const subLayer: DerivableLayer = {
    states: machine.states,
    transitions: machine.transitions,
    terminalStateIds: machine.terminalStateIds,
    invariants: [],
    timing: [],
    exceptions: [],
    degraded: false,
  };

  return generatePathsFromInitial(subLayer, entry, criterion, maxLen, maxPaths);
}

/** 原始 BFS/DFS 路径生成器（重构前 generatePaths 的等价行为） */
function generatePathsFromInitial(
  derivable: DerivableLayer,
  initialId: string,
  criterion: 'state' | 'transition' | 'path',
  maxLen: number,
  maxPaths: number
): ProtocolPath[] {
  if (!initialId || derivable.states.length === 0) return [];

  const transitionsByFrom = new Map<string, typeof derivable.transitions>();
  for (const t of derivable.transitions) {
    for (const fromState of t.from) {
      if (fromState === '-' || fromState === '') continue;
      if (!transitionsByFrom.has(fromState)) {
        transitionsByFrom.set(fromState, []);
      }
      transitionsByFrom.get(fromState)!.push(t);
    }
  }

  // 构建状态 ID → StateDef 的查找表（用于多维度裁剪）
  const statesById = new Map<string, StateDef>();
  for (const s of derivable.states) {
    statesById.set(s.id, s);
  }

  const terminalIds = new Set(derivable.terminalStateIds);
  const paths: ProtocolPath[] = [];
  const coveredStates = new Set<string>();
  const coveredTransitions = new Set<string>();

  if (criterion === 'path') {
    const visited = new Set<string>();
    dfsCollectPaths(
      derivable,
      initialId,
      [],
      [],
      visited,
      terminalIds,
      transitionsByFrom,
      maxLen,
      maxPaths,
      paths,
      statesById
    );
  } else {
    bfsCollectPaths(
      derivable,
      initialId,
      terminalIds,
      transitionsByFrom,
      maxLen,
      maxPaths,
      coveredStates,
      coveredTransitions,
      paths,
      statesById
    );
  }

  return paths;
}

/**
 * 附属实体子状态机独立覆盖度（advisory）。
 * 返回 null 当无子状态机时（保持 TestCaseSet 形态不变）。
 * 每台子状态机独立报告 state/transition 覆盖率。
 *
 * 关键：创建转移（from='-'/空）在路径生成里以"入口"形式存在（不在 BFS 边里展开），
 * 路径 coverage 是按 transitionIds 累加的，因此创建转移不会出现在 paths[*].transitionIds 里。
 * 但它语义上属于该子状态机的合法转移；本报告把这类转移视为已覆盖（入口逻辑本身已表达）。
 */
export interface SubmachineCoverageReport {
  machineId: string;
  entryStateIds: string[];
  stateCoverage: CoverageDetail;
  transitionCoverage: CoverageDetail;
  notes: string;
}

function computeSubmachineCoverage(
  subMachines: StateMachine[],
  paths: ProtocolPath[]
): SubmachineCoverageReport[] | null {
  if (subMachines.length === 0) return null;

  const coveredStates = new Set<string>();
  const coveredTransitions = new Set<string>();
  for (const p of paths) {
    for (const sid of p.stateIds) coveredStates.add(sid);
    for (const tid of p.transitionIds) coveredTransitions.add(tid);
  }

  return subMachines.map((sm) => {
    const allStateIds = sm.states.map((s) => s.id);
    const allTransitionIds = sm.transitions.map((t) => t.id);
    // 创建转移语义上由 entryStateIds 表达：若 entry 被某条路径访问（paths[*].stateIds 含入口），
    // 则该子状态机的所有创建转移视为已覆盖（入口即代表"创建路径可达"）。
    const entryCovered = sm.entryStateIds.some((e) => coveredStates.has(e));
    const creationTids = sm.transitions.filter(isCreationTransition).map((t) => t.id);
    const effectiveCovered = new Set<string>(coveredTransitions);
    if (entryCovered) {
      for (const tid of creationTids) effectiveCovered.add(tid);
    }

    const coveredS = allStateIds.filter((s) => coveredStates.has(s));
    const coveredT = allTransitionIds.filter((t) => effectiveCovered.has(t));
    const sCov: CoverageDetail = {
      total: allStateIds.length,
      covered: coveredS.length,
      coveredIds: coveredS,
      uncoveredIds: allStateIds.filter((s) => !coveredStates.has(s)),
      ratio: allStateIds.length === 0 ? 0 : coveredS.length / allStateIds.length,
    };
    const tCov: CoverageDetail = {
      total: allTransitionIds.length,
      covered: coveredT.length,
      coveredIds: coveredT,
      uncoveredIds: allTransitionIds.filter((t) => !effectiveCovered.has(t)),
      ratio: allTransitionIds.length === 0 ? 0 : coveredT.length / allTransitionIds.length,
    };
    const issues: string[] = [];
    if (sCov.ratio < 1) issues.push(`状态覆盖 ${(sCov.ratio * 100).toFixed(0)}%`);
    if (tCov.ratio < 1) issues.push(`转移覆盖 ${(tCov.ratio * 100).toFixed(0)}%`);
    return {
      machineId: sm.id,
      entryStateIds: sm.entryStateIds,
      stateCoverage: sCov,
      transitionCoverage: tCov,
      notes:
        issues.length === 0
          ? `[${sm.id}] 附属实体子状态机覆盖完整`
          : `[${sm.id}] 附属实体子状态机：${issues.join('；')}（advisory）`,
    };
  });
}

/**
 * 判断维度在指定状态下是否有效
 *
 * 从状态的 dimensions 中读取 validWhen，检查当前状态 ID 是否在 validWhen 表达式中。
 * 如果维度没有 validWhen 条件，则视为始终有效。
 * validWhen 表达式支持逗号、空格、引号分隔的状态 ID 列表。
 *
 * @param dimension - 状态维度定义
 * @param currentStateId - 当前状态 ID
 * @returns 该维度在当前状态下是否有效
 */
function isDimensionValid(dimension: StateDimension, currentStateId: string): boolean {
  if (!dimension.validWhen) {
    return true;
  }

  // 解析 validWhen 表达式：提取其中的状态 ID 引用
  // 支持格式："stateA, stateB" 或 "stateA stateB" 或 "stateA | stateB"
  const tokens = dimension.validWhen
    .split(/[,|; \t]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !/^[<>!=]/.test(t) && !/^['"]/.test(t));

  // 如果分词后没有有效 token，视为 true（无法解析时保守处理）
  if (tokens.length === 0) {
    return true;
  }

  // 检查当前状态 ID 是否在 validWhen 表达式中出现
  // 直接匹配 token，也匹配引号包裹的 ID（如 "'stateA'"）
  return tokens.some(
    (token) =>
      token === currentStateId ||
      token === `'${currentStateId}'` ||
      token === `"${currentStateId}"`
  );
}

function bfsCollectPaths(
  derivable: DerivableLayer,
  initialId: string,
  terminalIds: Set<string>,
  transitionsByFrom: Map<string, DerivableLayer['transitions']>,
  maxLen: number,
  maxPaths: number,
  coveredStates: Set<string>,
  coveredTransitions: Set<string>,
  out: ProtocolPath[],
  statesById: Map<string, StateDef>
): void {
  // 队列：{ currentState, path, states, transitions }
  interface QueueItem {
    currentState: string;
    transitionIds: string[];
    stateIds: string[];
    visitedStates: Set<string>;
  }
  const queue: QueueItem[] = [
    {
      currentState: initialId,
      transitionIds: [],
      stateIds: [initialId],
      visitedStates: new Set([initialId]),
    },
  ];

  let iterations = 0;
  const maxIterations = maxPaths * 20; // 防止死循环

  while (queue.length > 0 && out.length < maxPaths && iterations < maxIterations) {
    iterations++;
    const item = queue.shift()!;

    // 标记覆盖
    coveredStates.add(item.currentState);

    // 若到达终态，记录路径
    if (terminalIds.has(item.currentState)) {
      out.push({
        id: `PATH_${String(out.length + 1).padStart(2, '0')}`,
        transitionIds: [...item.transitionIds],
        stateIds: [...item.stateIds],
        length: item.transitionIds.length,
        description: `${item.stateIds.join(' → ')}`,
      });
      // 终态不再扩展
      continue;
    }

    // 长度限制
    if (item.transitionIds.length >= maxLen) {
      // 超长路径也记录（标注未到达终态）
      out.push({
        id: `PATH_${String(out.length + 1).padStart(2, '0')}`,
        transitionIds: [...item.transitionIds],
        stateIds: [...item.stateIds],
        length: item.transitionIds.length,
        description: `${item.stateIds.join(' → ')}（超长截断）`,
      });
      continue;
    }

    // 扩展：按转移出边，根据维度 validWhen 裁剪
    const outTransitions = transitionsByFrom.get(item.currentState) ?? [];
    const currentStateDef = statesById.get(item.currentState);
    let expanded = false; // 是否至少扩展了一条出转移（用于判定死胡同）

    for (const t of outTransitions) {
      // 多维度裁剪：检查当前状态维度的 validWhen 条件
      if (currentStateDef?.dimensions && currentStateDef.dimensions.length > 0) {
        const shouldSkip = currentStateDef.dimensions.some((dim) => {
          if (!dim.validWhen) return false;
          // 如果该维度有 validWhen 条件但当前状态 ID 不在 validWhen 表达式中，跳过该维度组合
          return !isDimensionValid(dim, item.currentState);
        });
        if (shouldSkip) continue;
      }

      // 循环检测：目标状态已在当前路径中，且该转移已被其他分支覆盖，则跳过（避免无限循环）。
      // 未覆盖的转移即使指向已访问状态也允许执行一次——合法生命周期循环（如 S1↔S2↔S3）中的
      // 状态/转移由此得以进入路径并计入覆盖，否则 state 准则对循环协议永远无法达到 100%。
      if (item.visitedStates.has(t.to) && coveredTransitions.has(t.id)) {
        continue;
      }
      coveredTransitions.add(t.id);
      expanded = true;
      const newVisited = new Set(item.visitedStates);
      newVisited.add(t.to);
      queue.push({
        currentState: t.to,
        transitionIds: [...item.transitionIds, t.id],
        stateIds: [...item.stateIds, t.to],
        visitedStates: newVisited,
      });
    }

    // 死胡同：非终态、未超长，且所有出转移均被裁剪（无出边或全部循环检测跳过）
    // → 记录终止路径，使该分支沿途的状态/转移计入覆盖
    if (!expanded && item.transitionIds.length > 0) {
      out.push({
        id: `PATH_${String(out.length + 1).padStart(2, '0')}`,
        transitionIds: [...item.transitionIds],
        stateIds: [...item.stateIds],
        length: item.transitionIds.length,
        description: `${item.stateIds.join(' → ')}（无出边终止）`,
      });
    }
  }
}

function dfsCollectPaths(
  derivable: DerivableLayer,
  currentState: string,
  transitionIds: string[],
  stateIds: string[],
  visited: Set<string>,
  terminalIds: Set<string>,
  transitionsByFrom: Map<string, DerivableLayer['transitions']>,
  maxLen: number,
  maxPaths: number,
  out: ProtocolPath[],
  statesById: Map<string, StateDef>
): void {
  if (out.length >= maxPaths) return;

  // 到达终态：记录路径
  if (terminalIds.has(currentState)) {
    out.push({
      id: `PATH_${String(out.length + 1).padStart(2, '0')}`,
      transitionIds: [...transitionIds],
      stateIds: [...stateIds],
      length: transitionIds.length,
      description: stateIds.join(' → '),
    });
    return;
  }

  // 长度限制
  if (transitionIds.length >= maxLen) {
    out.push({
      id: `PATH_${String(out.length + 1).padStart(2, '0')}`,
      transitionIds: [...transitionIds],
      stateIds: [...stateIds],
      length: transitionIds.length,
      description: `${stateIds.join(' → ')}（超长截断）`,
    });
    return;
  }

  // 简单路径检测：避免环
  if (visited.has(currentState)) {
    return;
  }
  visited.add(currentState);

  // 多维度裁剪：检查当前状态维度的 validWhen 条件
  const currentStateDef = statesById.get(currentState);
  const outTransitions = transitionsByFrom.get(currentState) ?? [];
  for (const t of outTransitions) {
    if (currentStateDef?.dimensions && currentStateDef.dimensions.length > 0) {
      const shouldSkip = currentStateDef.dimensions.some((dim) => {
        if (!dim.validWhen) return false;
        // 如果该维度有 validWhen 条件但当前状态 ID 不在 validWhen 表达式中，跳过该维度组合
        return !isDimensionValid(dim, currentState);
      });
      if (shouldSkip) continue;
    }

    dfsCollectPaths(
      derivable,
      t.to,
      [...transitionIds, t.id],
      [...stateIds, t.to],
      new Set(visited),
      terminalIds,
      transitionsByFrom,
      maxLen,
      maxPaths,
      out,
      statesById
    );
  }
}

// ============================================================================
// 覆盖度分析
// ============================================================================

function computeCoverage(
  derivable: DerivableLayer,
  paths: ProtocolPath[],
  criterion: 'state' | 'transition' | 'path',
  maxPathLength: number
): CoverageReport {
  // 状态覆盖
  const allStateIds = derivable.states.map((s) => s.id);
  const coveredStateIds = new Set<string>();
  for (const p of paths) {
    for (const sid of p.stateIds) coveredStateIds.add(sid);
  }
  const stateCoverage: CoverageDetail = {
    total: allStateIds.length,
    covered: coveredStateIds.size,
    coveredIds: Array.from(coveredStateIds),
    uncoveredIds: allStateIds.filter((id) => !coveredStateIds.has(id)),
    ratio: allStateIds.length === 0 ? 0 : coveredStateIds.size / allStateIds.length,
  };

  // 转移覆盖：路径 BFS 边累加 + 创建转移信用（修改单 003）
  // 创建转移（from='-'/空）不会出现在 paths[*].transitionIds 里（它不是 BFS 边），
  // 但其目标 entry 出现在 paths[*].stateIds 即代表"创建路径可达"。
  // 为不破主覆盖度报告对创建转移的覆盖声明，把它按"entry 被覆盖 = 创建转移已覆盖"计入。
  const allTransitionIds = derivable.transitions.map((t) => t.id);
  const coveredTransitionIds = new Set<string>();
  for (const p of paths) {
    for (const tid of p.transitionIds) coveredTransitionIds.add(tid);
  }
  for (const t of derivable.transitions) {
    if (isCreationTransition(t) && coveredStateIds.has(t.to)) {
      coveredTransitionIds.add(t.id);
    }
  }
  const transitionCoverage: CoverageDetail = {
    total: allTransitionIds.length,
    covered: coveredTransitionIds.size,
    coveredIds: Array.from(coveredTransitionIds),
    uncoveredIds: allTransitionIds.filter((id) => !coveredTransitionIds.has(id)),
    ratio: allTransitionIds.length === 0 ? 0 : coveredTransitionIds.size / allTransitionIds.length,
  };

  // 路径覆盖（仅 path 准则下计算）
  let pathCoverage: CoverageDetail | undefined;
  if (criterion === 'path') {
    pathCoverage = {
      total: paths.length,
      covered: paths.length,
      coveredIds: paths.map((p) => p.id),
      uncoveredIds: [],
      ratio: 1,
    };
  }

  // 未覆盖项处置建议
  const uncoveredDispositions: UncoveredDisposition[] = [];
  for (const sid of stateCoverage.uncoveredIds) {
    uncoveredDispositions.push({
      elementId: sid,
      elementType: 'state',
      disposition: 'missing_supplement',
      reason: '状态未被任何路径覆盖，可能存在遗漏场景或不可达状态',
    });
  }
  for (const tid of transitionCoverage.uncoveredIds) {
    uncoveredDispositions.push({
      elementId: tid,
      elementType: 'transition',
      disposition: 'missing_supplement',
      reason: '转移未被任何路径覆盖，可能存在遗漏场景',
    });
  }

  return {
    criterion,
    stateCoverage,
    transitionCoverage,
    pathCoverage,
    uncoveredDispositions,
    maxPathLength: criterion === 'path' ? maxPathLength : undefined,
  };
}

function emptyCoverage(criterion: 'state' | 'transition' | 'path'): CoverageReport {
  return {
    criterion,
    stateCoverage: { total: 0, covered: 0, coveredIds: [], uncoveredIds: [], ratio: 0 },
    transitionCoverage: { total: 0, covered: 0, coveredIds: [], uncoveredIds: [], ratio: 0 },
    uncoveredDispositions: [],
  };
}

// ============================================================================
// G7-S4（X5 / X6 / X12）：对抗性用例生成
// ============================================================================
//
// 三类此前无法生成的用例模板（execution-plan.md §S4）：
// - X5 observed 直写违例：observed 维度 × role 接口 → 断言调用必须失败
//   （observed 维度只能由事实侧 system/external 写入，角色不能凭意图制造事实）
// - X6 guard 失败后状态不变：preconditions 每个合取项 → ①调用失败
//   ②affectsDimensions 取值与调用前完全一致（R5：用例文件头部必须声明冻结边界，
//   mock 掉调度器/定时器，防止 scheduled 重算/超时任务并发改状态导致 flaky）
// - X12 收敛断言：remedy.detection → 制造违约 ⇒ 等待 ≤ boundMs ⇒ 断言收敛
//
// G7-S6（X15 / P2-6）凭证用例（execution-plan.md §S6）：
// - X15 credential-expired：凭证过期 → 必须失效（S6-4）；
// - X15 credential-revoked：凭证已撤销 → 必须失效（S6-4）；
// - X15 credential-lookup：回查失败 —— local-verify → 仍验证通过（S6-2，fail-open）；
//   needs-lookup → 拒绝而非放行（S6-3，fail-closed）。
//
// 降级口径（R4 / P2-8）：
// - 用例数 < 理论上限（observed 违例 ≤ observed 维度数；guard 反例 ≤ 全部合取项之和）
//   的差额必须显式降级记录（degradedReasons），不得静默；
// - remedy 声明了但 detection 缺省 → 显式降级记录（不生成 X12 用例，不静默）；
// - 无 credential: 段（老模型）→ 0 用例且不降级（凭证机制未启用，非缺口，S6-5 零回归）。

export interface AdversarialGenerationResult {
  cases: AdversarialCase[];
  degradedReasons: string[];
}

/** 主入口：三类对抗性用例 + 差额/缺省降级记录（确定性、纯函数） */
export function generateAdversarialCases(
  model: SourceProtocolModel
): AdversarialGenerationResult {
  const cases: AdversarialCase[] = [];
  const degradedReasons: string[] = [];
  const ir = model.derivable;

  generateObservedWriteCases(model, cases, degradedReasons); // X5
  generateGuardFailureCases(model, cases, degradedReasons); // X6
  generateConvergenceCases(ir, cases, degradedReasons); // X12
  generateCredentialCases(model, cases, degradedReasons); // X15（G7-S6）

  return { cases, degradedReasons };
}

// ----------------------------------------------------------------------------
// X5 · observed 直写违例
// ----------------------------------------------------------------------------

function generateObservedWriteCases(
  model: SourceProtocolModel,
  cases: AdversarialCase[],
  degradedReasons: string[]
): void {
  const ir = model.derivable;

  // 维度 kind 判定复用 buildDimensionKinds（与 S1 specifier / S2 checker 同一单一事实源）。
  // 混合写入方（dimension-kind-conflict）在 S1 已硬失败；此处独立运行时（测试/手工模型）
  // 以错误收集替代抛错——记降级，不阻断路径用例生成（与 checker 的错误收集口径一致）。
  let views: ReturnType<typeof buildDimensionKinds>['entries'];
  try {
    views = buildDimensionKinds(ir).entries;
  } catch (err) {
    degradedReasons.push(
      `X5 差额：维度 kind 机械推导失败（${err instanceof Error ? err.message : String(err)}），无法生成 observed 直写违例用例 [R4]`
    );
    return;
  }

  for (const v of views) {
    // 混合（W(dim) 同时含 role 与非 role）：kind 未产出 → 降级
    if (!v.kind) {
      degradedReasons.push(
        `X5 差额：维度 ${v.dimension}（${v.owner}）kind 未判定（W(dim)=${v.writers.length > 0 ? v.writers.join(',') : '∅'}，dimension-kind-undetermined），无法生成 observed 直写违例用例 [R4]`
      );
      continue;
    }
    // X5 只针对 observed 维度；declared 维度角色可凭意图写，不构成直写违例
    if (v.kind !== 'observed') continue;

    // 需要一个 role 接口作为「直写违例」的载体（合规模型下 role 接口不会写 observed 维度，
    // 违例 = role 接口尝试直写该维度；用例断言必须失败）
    const roleTransition = ir.transitions.find((t) => t.triggerType === 'role');
    if (!roleTransition) {
      degradedReasons.push(
        `X5 差额：维度 ${v.dimension}（${v.owner}）kind='observed'，但模型无任何 role 接口可作为直写违例载体，无法生成用例 [R4]`
      );
      continue;
    }

    const sourceLabel = v.kindSource === 'asserted' ? '（人写断言）' : '（机械推导）';
    cases.push({
      id: `X5_${sanitizeId(v.owner)}_${sanitizeId(v.dimension)}`,
      kind: 'observed-write',
      source: `维度 ${v.dimension}（${v.owner}）kind='observed'${sourceLabel}`,
      interfaceId: roleTransition.action,
      expectFailure: true,
      body: buildX5Body(v.owner, v.dimension, roleTransition),
    });
  }
}

function buildX5Body(owner: string, dimension: string, roleTransition: TransitionDef): string {
  const action = roleTransition.action;
  return [
    `/**`,
    ` * X5 observed 直写违例（G7-S4）`,
    ` * 数据源（model.md）：维度 ${dimension}（${owner}）kind='observed'`,
    ` * 断言：role 接口 ${action} 直写 observed 维度 ${dimension} 必须失败`,
    ` * 语义：observed 维度只能由事实侧（system/external）写入，角色不能凭意图制造事实`,
    ` */`,
    `import { describe, it, expect } from '@jest/globals';`,
    ``,
    `describe('X5 observed 直写违例：${dimension}（${owner}）', () => {`,
    `  it('role 接口 ${action} 直写 observed 维度 ${dimension} 必须失败', () => {`,
    `    // 前置：进入合法状态（无调度并发窗口）`,
    `    goto('${roleTransition.from[0] ?? ''}');`,
    `    // 快照：observed 维度当前取值`,
    `    const before = snapshot(['${dimension}']);`,
    `    // 直写违例：role 接口请求携带 observed 维度写入意图`,
    `    const res = call('${action}', { directWrite: { '${dimension}': 'violation' } });`,
    `    // 断言①：调用必须失败（角色不能凭意图制造事实）`,
    `    expect(res.failed).toBe(true);`,
    `    // 断言②：observed 维度取值未被改写`,
    `    expect(snapshot(['${dimension}'])).toEqual(before);`,
    `  });`,
    `});`,
    ``,
  ].join('\n');
}

// ----------------------------------------------------------------------------
// X6 · guard 失败后状态不变
// ----------------------------------------------------------------------------

/** X6 合取项（可置否 = 能机械构造违反输入的合取条件） */
interface X6Conjunct {
  /** 合取项原文（人读；J2 失败信息指回） */
  text: string;
  /** 是否可机械构造「置否」输入 */
  negatable: boolean;
  /** 可置否时的违反输入（置否值） */
  negationPayload?: unknown;
}

function generateGuardFailureCases(
  model: SourceProtocolModel,
  cases: AdversarialCase[],
  degradedReasons: string[]
): void {
  const ir = model.derivable;
  const contracts = model.contractInput?.contracts ?? [];
  const contractByKey = new Map<string, (typeof contracts)[number]>();
  for (const c of contracts) {
    contractByKey.set(c.interface, c);
    if (c.sourceId) contractByKey.set(c.sourceId, c);
  }

  for (const t of ir.transitions ?? []) {
    if (!t.guard && !contractByKey.has(t.action) && !contractByKey.has(t.id)) continue;
    const conjuncts = resolveX6Conjuncts(t, contractByKey.get(t.action) ?? contractByKey.get(t.id));
    const dims = t.affectsDimensions ?? [];
    conjuncts.forEach((c, i) => {
      if (c.negatable) {
        cases.push({
          id: `X6_${sanitizeId(t.id)}_c${i}`,
          kind: 'guard-failure',
          source: `转移 ${t.id}（action=${t.action}）preconditions 合取项[${i}]「${c.text}」`,
          interfaceId: t.action,
          expectFailure: true,
          negatedConjunct: i,
          conjunctText: c.text,
          stateImmutableDimensions: dims,
          body: buildX6Body(t, c, i, dims),
        });
      } else {
        // R4：无法机械构造置否输入 → 显式降级（不生成空壳用例）
        degradedReasons.push(
          `X6 差额：转移 ${t.id}（action=${t.action}）guard 合取项[${i}]「${c.text}」未机械结构化（无法构造置否输入），不生成反例 [R4]`
        );
      }
    });
  }
}

/**
 * 合取项解析：契约层 preconditions（结构化 SchemaExpression[]）优先；
 * 缺省时 guard 字符串按逻辑与（&& / 且 / and）拆分，合取项逐个过受限谓词翻译。
 */
function resolveX6Conjuncts(
  t: TransitionDef,
  contract: { preconditions?: SchemaExpression[] } | undefined
): X6Conjunct[] {
  const contractPre = contract?.preconditions;
  if (contractPre && contractPre.length > 0) {
    return contractPre.map((p) => {
      if (p.kind === 'json-schema' && p.schema) {
        return {
          text: p.description ?? 'preconditions 合取项',
          negatable: true,
          negationPayload: buildNegationPayload(p.schema),
        };
      }
      return {
        text: p.description ?? 'preconditions 合取项',
        negatable: false,
      };
    });
  }

  if (!t.guard) return [];
  return splitConjuncts(t.guard).map((part) => {
    const pred = translatePredicate(part);
    if (pred) {
      return {
        text: part,
        negatable: true,
        negationPayload: buildNegationPayload(pred.schema),
      };
    }
    return { text: part, negatable: false };
  });
}

/** 按逻辑与拆分 guard（仅顶层：括号深度 0 处；中文「且」允许无空格，英文 and 亦作合取分隔） */
function splitConjuncts(guard: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  // 返回当前位置是否命中顶层分隔符（括号深度 0 时）：命中返回分隔符长度，否则 0
  const splitterLenAt = (i: number): number => {
    if (depth > 0) return 0;
    const rest = guard.slice(i);
    if (rest.startsWith('&&')) return 2;
    if (rest.startsWith('且')) return 1;
    if (/^and\s/i.test(rest)) return 3;
    return 0;
  };
  for (let i = 0; i < guard.length; ) {
    const ch = guard[i];
    if (ch === '(') {
      depth++;
      current += ch;
      i++;
      continue;
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1);
      current += ch;
      i++;
      continue;
    }
    const len = splitterLenAt(i);
    if (len > 0) {
      const trimmed = current.trim();
      if (trimmed) parts.push(trimmed);
      current = '';
      i += len;
      continue;
    }
    current += ch;
    i++;
  }
  const last = current.trim();
  if (last) parts.push(last);
  return parts.length > 0 ? parts : [guard.trim()];
}

/**
 * 构造「违反 schema」的置否输入（X6 反例的机械构造，确定性）：
 * - object + required → 缺 required 字段（最简单、最通用）
 * - minLength → 空串；minimum → 下界减一；pattern → 不匹配串；uniqueItems → 重复元素
 * - 其余基本类型 → 类型不符值；兜底 → 任意非空对象
 */
function buildNegationPayload(schema: JSONSchema): unknown {
  if (schema.type === 'object' && schema.required && schema.required.length > 0) {
    return {}; // 缺 required 字段
  }
  if (schema.minLength !== undefined) return '';
  if (schema.minimum !== undefined) return (schema.minimum as number) - 1;
  if (schema.pattern) return `__violates_${schema.pattern}__`;
  if (schema.uniqueItems) return ['dup', 'dup'];
  if (schema.type === 'string') return '';
  if (schema.type === 'number' || schema.type === 'integer') return -1;
  if (schema.type === 'boolean') return 'not-a-boolean';
  return { __violates_schema__: true };
}

/** X6 用例文件正文：头部必须含 R5 冻结边界声明（缺失即未完成任务，S4-3） */
function buildX6Body(t: TransitionDef, c: X6Conjunct, index: number, dims: string[]): string {
  const payload = c.negationPayload === undefined ? '{}' : JSON.stringify(c.negationPayload);
  const dimsJson = JSON.stringify(dims);
  return [
    `/**`,
    ` * X6 guard 失败后状态不变（G7-S4）`,
    ` * 数据源（model.md）：转移 ${t.id}（action=${t.action}）preconditions 合取项[${index}]「${c.text}」`,
    ` * 断言：① 调用必须失败 ② affectsDimensions 取值与调用前完全一致`,
    ` *`,
    ` * ===== R5 冻结边界声明（S4-3，缺失即未完成）=====`,
    ` * 本用例冻结调度器与定时器：mock 掉 scheduled 任务派发与超时定时器，`,
    ` * 防止重算/超时任务在断言窗口内并发改写状态导致随机失败（flaky）。`,
    ` * 实现：jest.useFakeTimers() + schedulerMock.disable()（testtool/mock）。`,
    ` * =================================================`,
    ` */`,
    `import { describe, it, expect, jest } from '@jest/globals';`,
    `import { schedulerMock } from '<testtool>/mock';`,
    ``,
    `describe('X6 guard 失败后状态不变：${t.action}（${t.id}）', () => {`,
    `  beforeEach(() => {`,
    `    // R5：冻结边界 —— mock 掉调度器与定时器`,
    `    jest.useFakeTimers();`,
    `    schedulerMock.disable();`,
    `  });`,
    `  afterEach(() => {`,
    `    schedulerMock.restore();`,
    `    jest.useRealTimers();`,
    `  });`,
    ``,
    `  it('合取项[${index}]「${c.text}」置否后调用必须失败且状态不变', () => {`,
    `    // 前置：进入 ${t.from[0] ?? '未知'} 状态`,
    `    goto('${t.from[0] ?? ''}');`,
    `    // 快照：affectsDimensions 取值（${dims.length > 0 ? dims.join(', ') : '空集：无维度受影响'}）`,
    `    const before = snapshot(${dimsJson});`,
    `    // 置否合取项[${index}]：构造违反「${c.text}」的输入`,
    `    const payload = ${payload};`,
    `    // 调用接口（合取项不满足 → 必须失败）`,
    `    const res = call('${t.action}', payload);`,
    `    // 断言①：调用必须失败`,
    `    expect(res.failed).toBe(true);`,
    `    // 断言②：affectsDimensions 取值与调用前完全一致`,
    `    expect(snapshot(${dimsJson})).toEqual(before);`,
    `  });`,
    `});`,
    ``,
  ].join('\n');
}

// ----------------------------------------------------------------------------
// X12 · 收敛断言（remedy.detection）
// ----------------------------------------------------------------------------

function generateConvergenceCases(
  ir: DerivableLayer,
  cases: AdversarialCase[],
  degradedReasons: string[]
): void {
  const timings = ir.timing ?? [];
  // R5（T3a）：冻结边界声明——带 scheduled 重算任务的模型，X12 用例 body 须声明 mock 掉
  // 调度器/定时器（收敛等待期间不能有真实调度干扰，测试确定性）。
  const hasScheduled = (ir.operations ?? []).some((op) => op.triggerType === 'scheduled');
  for (const inv of ir.invariants ?? []) {
    const remedy = inv.remedy;
    // 未声明 remedy：X12 不适用（不生成也不降级——不是缺口）
    if (!remedy) continue;
    // P2-8：detection 缺省 → 显式降级记录，不静默
    if (!remedy.detection) {
      degradedReasons.push(
        `X12 降级：不变量 ${inv.id}（${inv.name}）声明了 remedy（action=${remedy.action}）但 detection 缺省（P2-8），无法生成收敛断言用例，显式降级不静默`
      );
      continue;
    }
    // boundMs 来自关联时序约束（timing.source/target 指向该不变量且带 boundMs）；
    // 缺省 → 用例仍生成（S4-4：用例数 = 有 detection 的不变量数），等待上限显式标注降级
    const related = timings.filter(
      (tm) => tm.source === inv.id || tm.target === inv.id
    );
    const boundMs = related.find((tm) => tm.boundMs !== undefined)?.boundMs;
    if (boundMs === undefined) {
      degradedReasons.push(
        `X12 降级：不变量 ${inv.id} 的 remedy.detection 已声明，但无关联时序约束（timing.source/target 指向 ${inv.id}）带 boundMs，收敛等待上限未声明，用例以「立即收敛 + 显式标注」执行`
      );
    }
    const detectionText =
      remedy.detection.description ?? remedy.detection.schema?.description ?? inv.expression;
    cases.push({
      id: `X12_${sanitizeId(inv.id)}`,
      kind: 'convergence',
      source: `不变量 ${inv.id}（${inv.name}）remedy.detection`,
      interfaceId: inv.id,
      violation: inv.expression,
      ...(boundMs !== undefined ? { boundMs } : {}),
      detection: detectionText,
      body: buildX12Body(inv.id, inv.name, inv.expression, detectionText, boundMs, hasScheduled),
    });
  }
}

function buildX12Body(
  invId: string,
  invName: string,
  expression: string,
  detection: string,
  boundMs?: number,
  hasScheduled?: boolean
): string {
  const boundLine =
    boundMs === undefined
      ? `    // 收敛等待上限未声明（无关联 timing.boundMs）：立即检查 + 显式标注降级`
      : `    // 等待 ≤ ${boundMs}ms 后断言收敛`;
  const elapsedLine =
    boundMs === undefined
      ? `    expect(elapsed()).toBeGreaterThanOrEqual(0); // 无 boundMs：仅验证收敛发生`
      : `    expect(elapsed()).toBeLessThanOrEqual(${boundMs});`;
  const frozenLine = hasScheduled
    ? [
        `    // 冻结边界声明（R5/T3a）：本模型含 scheduled 重算任务，收敛等待期间 mock 掉调度器/定时器`,
        `    mockSchedulerAndTimers();`,
      ].join('\n')
    : `    // 本模型无 scheduled 重算任务（无需冻结调度器）`;
  return [
    `/**`,
    ` * X12 收敛断言（G7-S4）`,
    ` * 数据源（model.md）：不变量 ${invId}（${invName}）remedy.detection`,
    ` * 断言：制造违约 ⇒ 等待 ≤ boundMs ⇒ 状态收敛（检测方式：${detection}）`,
    ` */`,
    `import { describe, it, expect } from '@jest/globals';`,
    ``,
    `describe('X12 收敛断言：${invId} ${invName}', () => {`,
    `  it('制造违约后收敛（${boundMs === undefined ? 'boundMs 未声明' : `boundMs=${boundMs}`}）', async () => {`,
    `    // 制造违约：违反不变量表达式「${expression}」`,
    `    makeViolation('${expression}');`,
    frozenLine,
    boundLine,
    `    // 收敛断言：检测方式「${detection}」`,
    `    await expect(converged('${detection}')).resolves.toBe(true);`,
    elapsedLine,
    `  });`,
    `});`,
    ``,
  ].join('\n');
}

/** 用例 ID 中的非法字符净化（维度名/实体名可能含空格或特殊字符） */
function sanitizeId(s: string): string {
  return s.replace(/[^A-Za-z0-9_]/g, '_');
}

// ----------------------------------------------------------------------------
// X15 · 凭证用例（G7-S6 / P2-6）：过期 / 撤销 / 回查失败
// ----------------------------------------------------------------------------
//
// 数据源：model.metadata.credentials（model.md frontmatter 的 credential: 段，与 roles: 同构）。
// 每条凭证生成三条确定性用例（S6-4 过期/撤销各一条；S6-2/3 回查失败一条）：
// - credential-expired：凭证过期 → 必须失效（expectFailure=true，S6-4）；
// - credential-revoked：凭证已撤销 → 必须失效（expectFailure=true，S6-4）；
// - credential-lookup：回查失败 →
//   local-verify → expectedCredentialBehavior='verify'（仍验证通过，S6-2 正向，fail-open）；
//   needs-lookup → expectedCredentialBehavior='reject'（拒绝而非放行，S6-3 正向，fail-closed）。
//
// 降级口径：无 credential: 段（老模型，credentials=undefined）→ 0 用例且不降级
// （凭证机制未启用，非缺口；S6-5 老模型零回归）。

/**
 * X15 生成入口：凭证过期 / 撤销 / 回查失败三类用例。
 * 确定性、纯函数；无凭证段 → 零输出（老模型零回归）。
 */
function generateCredentialCases(
  model: SourceProtocolModel,
  cases: AdversarialCase[],
  degradedReasons: string[]
): void {
  const credentials: CredentialDeclaration[] | undefined = model.metadata.credentials;
  if (!credentials || credentials.length === 0) return;

  for (const c of credentials) {
    const base = {
      credential: c.name,
      selfContained: c.selfContained,
    } as const;

    // S6-4①：过期必须失效
    cases.push({
      id: `X15_${sanitizeId(c.name)}_expired`,
      kind: 'credential-expired',
      source: `credential: 段凭证 ${c.name}（ttl=${c.ttl}）`,
      interfaceId: c.name,
      expectFailure: true,
      expectedCredentialBehavior: 'reject',
      ...base,
      body: buildCredentialExpiredBody(c),
    });

    // S6-4②：已撤销必须失效
    cases.push({
      id: `X15_${sanitizeId(c.name)}_revoked`,
      kind: 'credential-revoked',
      source: `credential: 段凭证 ${c.name}（revoke=${c.revoke}）`,
      interfaceId: c.name,
      expectFailure: true,
      expectedCredentialBehavior: 'reject',
      ...base,
      body: buildCredentialRevokedBody(c),
    });

    // S6-2/S6-3：回查失败 —— 按自包含性决定断言方向
    const localVerify = c.selfContained === 'local-verify';
    cases.push({
      id: `X15_${sanitizeId(c.name)}_lookup`,
      kind: 'credential-lookup',
      source: `credential: 段凭证 ${c.name}（selfContained=${c.selfContained}）`,
      interfaceId: c.name,
      expectFailure: localVerify ? false : true,
      expectedCredentialBehavior: localVerify ? 'verify' : 'reject',
      ...base,
      body: buildCredentialLookupBody(c, localVerify),
    });
  }
}

/** X15 过期用例正文：断言过期凭证必须失效（S6-4） */
function buildCredentialExpiredBody(c: CredentialDeclaration): string {
  return [
    `/**`,
    ` * X15 凭证过期必须失效（G7-S6 / P2-6）`,
    ` * 数据源（model.md）：credential: 段凭证 ${c.name}（ttl=${c.ttl}）`,
    ` * 断言：凭证已过期时验证必须失败（过期 ⇒ 失效，S6-4）`,
    ` */`,
    `import { describe, it, expect } from '@jest/globals';`,
    ``,
    `describe('X15 凭证过期必须失效：${c.name}', () => {`,
    `  it('凭证 ${c.name} 已过期（ttl=${c.ttl}）时验证必须失败', () => {`,
    `    // 制造过期：把凭证时间推进到 ttl 有效期之后`,
    `    makeCredentialExpired('${c.name}');`,
    `    // 验证凭证：过期 ⇒ 必须失效`,
    `    const res = verifyCredential('${c.name}');`,
    `    expect(res.valid).toBe(false);`,
    `  });`,
    `});`,
    ``,
  ].join('\n');
}

/** X15 撤销用例正文：断言已撤销凭证必须失效（S6-4） */
function buildCredentialRevokedBody(c: CredentialDeclaration): string {
  return [
    `/**`,
    ` * X15 凭证已撤销必须失效（G7-S6 / P2-6）`,
    ` * 数据源（model.md）：credential: 段凭证 ${c.name}（revoke=${c.revoke}）`,
    ` * 断言：凭证已撤销时验证必须失败（撤销 ⇒ 失效，S6-4）`,
    ` */`,
    `import { describe, it, expect } from '@jest/globals';`,
    ``,
    `describe('X15 凭证已撤销必须失效：${c.name}', () => {`,
    `  it('凭证 ${c.name} 已撤销（revoke=${c.revoke}）时验证必须失败', () => {`,
    `    // 制造撤销：按撤销语义 ${c.revoke} 撤销凭证`,
    `    makeCredentialRevoked('${c.name}');`,
    `    // 验证凭证：已撤销 ⇒ 必须失效`,
    `    const res = verifyCredential('${c.name}');`,
    `    expect(res.valid).toBe(false);`,
    `  });`,
    `});`,
    ``,
  ].join('\n');
}

/**
 * X15 回查失败用例正文：
 * - local-verify：回查失败仍验证通过（S6-2，fail-open——断言 res.valid === true）；
 * - needs-lookup：回查失败拒绝而非放行（S6-3，fail-closed——断言 res.valid === false）。
 */
function buildCredentialLookupBody(c: CredentialDeclaration, localVerify: boolean): string {
  const expectation = localVerify
    ? [
        `    // local-verify：凭证可本地验证，回查失败不阻断——仍验证通过（S6-2，fail-open）`,
        `    const res = verifyCredential('${c.name}');`,
        `    expect(res.valid).toBe(true);`,
      ]
    : [
        `    // needs-lookup：凭证需在线回查，回查失败必须拒绝而非放行（S6-3，fail-closed）`,
        `    const res = verifyCredential('${c.name}');`,
        `    expect(res.valid).toBe(false);`,
      ];
  return [
    `/**`,
    ` * X15 凭证回查失败（G7-S6 / P2-6）`,
    ` * 数据源（model.md）：credential: 段凭证 ${c.name}（selfContained=${c.selfContained}）`,
    ` * 断言：${
      localVerify
        ? '回查失败时仍验证通过（local-verify，S6-2，fail-open）'
        : '回查失败时拒绝而非放行（needs-lookup，S6-3，fail-closed）'
    }`,
    ` */`,
    `import { describe, it, expect } from '@jest/globals';`,
    ``,
    `describe('X15 凭证回查失败：${c.name}（${c.selfContained}）', () => {`,
    `  it('${
      localVerify
        ? '回查失败时验证仍通过（local-verify，fail-open）'
        : '回查失败时拒绝而非放行（needs-lookup，fail-closed）'
    }', () => {`,
    `    // 制造回查失败：lookup 端点不可达 / 超时 / 5xx`,
    `    simulateLookupFailure('${c.name}');`,
    ...expectation,
    `  });`,
    `});`,
    ``,
  ].join('\n');
}

