/**
 * 跨协议测试用例生成器 —— 步骤⑦-C（AI 执行者 + 代码翻译者）
 *
 * 设计依据：《协议驱动自验证工具链设计方案》步骤⑦-C
 *
 * 职责：根据 CompositionModel 的依赖图 edges，遍历跨协议路径，生成跨协议测试用例集。
 *
 * 输入：CompositionModel, 各子协议模型列表 SourceProtocolModel[]
 * 输出：CrossTestCaseSet (paths: CrossProtocolPath[], coverage: CrossCoverageReport, generatedAt)
 */

import type {
  CompositionModel,
  SourceProtocolModel,
  CrossProtocolPath,
  CrossTestCaseSet,
  CrossCoverageReport,
  PathSegment,
  CoverageDetail,
  UncoveredDisposition,
} from '../model/types.js';
import {
  decomposeStateMachines,
  isCreationTransition,
  type StateMachine,
} from '../model/state-machines.js';

/**
 * 生成跨协议测试用例
 *
 * 从 dependencyGraph.edges 构建跨协议路径：
 * 1. 每条 edge 的 from→to 构造一个 CrossProtocolPath
 * 2. 每个 path 的 segments 包含 from 协议的状态序列和 to 协议的状态序列
 * 3. crossInvariantCheckpoints 取跨协议不变量 ID 列表
 * 4. 覆盖度报告统计事件覆盖（edges 数量）和不变量覆盖（crossInvariants 数量）
 */
export function generateCrossCases(
  composition: CompositionModel,
  subProtocolModels: SourceProtocolModel[]
): CrossTestCaseSet {
  // 构建子协议 ID → 模型的查找表
  const modelById = new Map<string, SourceProtocolModel>();
  for (const model of subProtocolModels) {
    modelById.set(model.metadata.name, model);
  }

  // 1. 构造跨协议路径
  const paths = buildCrossProtocolPaths(composition, modelById);

  // 2. 覆盖度报告
  const coverage = buildCrossCoverage(composition, paths);

  return {
    paths,
    coverage,
    generatedAt: new Date().toISOString(),
  };
}

// ============================================================================
// 跨协议路径构建
// ============================================================================

function buildCrossProtocolPaths(
  composition: CompositionModel,
  modelById: Map<string, SourceProtocolModel>
): CrossProtocolPath[] {
  const edges = composition.dependencyGraph.edges;
  const crossInvariantIds = composition.crossInvariants.map((inv) => inv.id);

  return edges.map((edge, index) => {
    const pathId = `CROSS_PATH_${String(index + 1).padStart(2, '0')}`;

    // 构造 segments
    const segments: PathSegment[] = [];

    // from 协议的片段
    // 修改单 003：跨协议依赖边对应的 transfer IDs 应覆盖主状态机从初始态 BFS 可达的转移，
    // 同时附属实体子状态机若有入口也应纳入（其状态/转移同样属于本协议的合法状态空间）。
    // 旧实现只以 initialStateId 单一 BFS，对 P7 US×PS×PI 这类多子状态机模型会把 PS/PI 维度漏掉。
    const fromModel = modelById.get(edge.from);
    if (fromModel) {
      const machines = decomposeStateMachines(
        fromModel.derivable.states,
        fromModel.derivable.transitions,
        fromModel.derivable.initialStateId ??
          fromModel.derivable.states.find((s) => s.type === 'initial')?.id
      );
      const allMachines: StateMachine[] = [
        ...(machines.main ? [machines.main] : []),
        ...machines.subMachines,
      ];
      const reachableTransferIds = collectReachableTransferIds(allMachines);
      const transitionIds = fromModel.derivable.transitions
        .filter(
          (t) =>
            reachableTransferIds.has(t.id) ||
            // 旧语义保留：state 依赖类型下，把所有 transition 纳入（跨协议路径覆盖意图）
            edge.dependencyType === 'state'
        )
        .map((t) => t.id);
      segments.push({
        protocolId: edge.from,
        transitionIds,
        stateIds: fromModel.derivable.states.map((s) => s.id),
      });
    } else {
      // 找不到模型时使用空片段
      segments.push({
        protocolId: edge.from,
        transitionIds: [],
        stateIds: [],
      });
    }

    // to 协议的片段
    const toModel = modelById.get(edge.to);
    if (toModel) {
      const machines = decomposeStateMachines(
        toModel.derivable.states,
        toModel.derivable.transitions,
        toModel.derivable.initialStateId ??
          toModel.derivable.states.find((s) => s.type === 'initial')?.id
      );
      const allMachines: StateMachine[] = [
        ...(machines.main ? [machines.main] : []),
        ...machines.subMachines,
      ];
      const reachableTransferIds = collectReachableTransferIds(allMachines);
      const transitionIds = toModel.derivable.transitions
        .filter((t) => reachableTransferIds.has(t.id))
        .map((t) => t.id);
      segments.push({
        protocolId: edge.to,
        transitionIds,
        stateIds: toModel.derivable.states.map((s) => s.id),
      });
    } else {
      segments.push({
        protocolId: edge.to,
        transitionIds: [],
        stateIds: [],
      });
    }

    const path: CrossProtocolPath = {
      id: pathId,
      segments,
      crossInvariantCheckpoints: [...crossInvariantIds],
      description: `跨协议路径：${edge.from} → ${edge.to}（${edge.dependencyType}，${edge.description}）`,
    };

    return path;
  });
}

/**
 * 收集所有状态机（主 + 附属）从各自入口出发 BFS 可达的转移 ID。
 * 修改单 003：替代旧"以 deriable.initialStateId BFS"逻辑，把附属实体子状态机也纳入。
 */
function collectReachableTransferIds(machines: StateMachine[]): Set<string> {
  const ids = new Set<string>();
  for (const m of machines) {
    const entry = m.entryStateIds[0];
    if (!entry) continue;
    const reachable = new Set<string>([entry]);
    const queue: string[] = [entry];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const t of m.transitions) {
        if (t.from.includes(cur) && !reachable.has(t.to)) {
          reachable.add(t.to);
          queue.push(t.to);
        }
      }
    }
    for (const t of m.transitions) {
      const reachableFromMachine = t.from.some((f) => reachable.has(f)) || t.to === entry;
      if (reachableFromMachine) ids.add(t.id);
    }
    // 创建转移（from='-'/空）归属本机即纳入
    for (const t of m.transitions) {
      if (isCreationTransition(t) && m.entryStateIds.includes(t.to)) ids.add(t.id);
    }
  }
  return ids;
}

// ============================================================================
// 覆盖度报告
// ============================================================================

function buildCrossCoverage(
  composition: CompositionModel,
  paths: CrossProtocolPath[]
): CrossCoverageReport {
  const edges = composition.dependencyGraph.edges;
  const invariants = composition.crossInvariants;

  // 事件覆盖：统计 edges 中被路径覆盖的情况
  const edgeIds = edges.map((_, i) => `EDGE_${i + 1}`);
  const coveredEdgeIds = new Set<string>();
  for (const p of paths) {
    const edgeIndex = paths.indexOf(p);
    if (edgeIndex >= 0 && edgeIndex < edgeIds.length) {
      coveredEdgeIds.add(edgeIds[edgeIndex]);
    }
  }

  const eventCoverage: CoverageDetail = {
    total: edgeIds.length,
    covered: coveredEdgeIds.size,
    coveredIds: Array.from(coveredEdgeIds),
    uncoveredIds: edgeIds.filter((id) => !coveredEdgeIds.has(id)),
    ratio: edgeIds.length === 0 ? 0 : coveredEdgeIds.size / edgeIds.length,
  };

  // 不变量覆盖：统计 crossInvariants 中被路径检查点覆盖的情况
  const invariantIds = invariants.map((inv) => inv.id);
  const coveredInvariantIds = new Set<string>();
  for (const p of paths) {
    for (const cpid of p.crossInvariantCheckpoints) {
      if (invariantIds.includes(cpid)) {
        coveredInvariantIds.add(cpid);
      }
    }
  }

  const invariantCoverage: CoverageDetail = {
    total: invariantIds.length,
    covered: coveredInvariantIds.size,
    coveredIds: Array.from(coveredInvariantIds),
    uncoveredIds: invariantIds.filter((id) => !coveredInvariantIds.has(id)),
    ratio: invariantIds.length === 0 ? 0 : coveredInvariantIds.size / invariantIds.length,
  };

  // 未覆盖项的处置建议
  const uncoveredDispositions: UncoveredDisposition[] = [];
  for (const uid of eventCoverage.uncoveredIds) {
    uncoveredDispositions.push({
      elementId: uid,
      elementType: 'transition',
      disposition: 'missing_supplement',
      reason: '该跨协议依赖边未被任何跨协议路径覆盖',
    });
  }
  for (const uid of invariantCoverage.uncoveredIds) {
    uncoveredDispositions.push({
      elementId: uid,
      elementType: 'state',
      disposition: 'missing_supplement',
      reason: '该跨协议不变量未被任何路径的检查点覆盖',
    });
  }

  return {
    eventCoverage,
    invariantCoverage,
    uncoveredDispositions,
  };
}
