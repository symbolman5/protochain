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
} from '../model/types.js';

export interface CaseGenOptions {
  /** 覆盖度准则 */
  criterion?: 'state' | 'transition' | 'path';
  /** 路径覆盖时的最大路径长度（默认状态数的2倍） */
  maxPathLength?: number;
  /** 最大生成路径数（防止爆炸） */
  maxPaths?: number;
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

  if (!initialStateId) {
    // 无初始状态：无法生成路径，但覆盖度报告仍应反映实际状态/转移总数
    return {
      paths: [],
      coverage: computeCoverage(derivable, [], criterion, maxPathLength),
      generatedAt: new Date().toISOString(),
    };
  }

  // 1. 路径生成
  const paths = generatePaths(derivable, initialStateId, criterion, maxPathLength, maxPaths);

  // 2. 覆盖度分析
  const coverage = computeCoverage(derivable, paths, criterion, maxPathLength);

  return {
    paths,
    coverage,
    generatedAt: new Date().toISOString(),
  };
}

// ============================================================================
// 路径生成
// ============================================================================

function generatePaths(
  derivable: DerivableLayer,
  initialId: string,
  criterion: 'state' | 'transition' | 'path',
  maxLen: number,
  maxPaths: number
): ProtocolPath[] {
  const transitionsByFrom = new Map<string, typeof derivable.transitions>();
  for (const t of derivable.transitions) {
    for (const fromState of t.from) {
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

  // 策略：BFS 生成路径，按覆盖度准则决定停止条件
  // - state 准则：每个状态至少被访问一次
  // - transition 准则：每个转移至少被执行一次
  // - path 准则：枚举到终态的所有简单路径（带长度限制）

  if (criterion === 'path') {
    // 路径覆盖：DFS 枚举到终态的路径
    const visited = new Set<string>(); // 用于简单路径检测
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
    // 状态/转移覆盖：BFS 到终态，记录路径（含死胡同终止路径，覆盖循环分支上的状态/转移）
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

  // 转移覆盖
  const allTransitionIds = derivable.transitions.map((t) => t.id);
  const coveredTransitionIds = new Set<string>();
  for (const p of paths) {
    for (const tid of p.transitionIds) coveredTransitionIds.add(tid);
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
