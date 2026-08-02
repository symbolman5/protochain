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
    const fromModel = modelById.get(edge.from);
    if (fromModel) {
      segments.push({
        protocolId: edge.from,
        transitionIds: fromModel.derivable.transitions
          .filter((t) => (fromModel.derivable.initialStateId != null && t.from.includes(fromModel.derivable.initialStateId)) || edge.dependencyType === 'state')
          .map((t) => t.id),
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
      segments.push({
        protocolId: edge.to,
        transitionIds: toModel.derivable.transitions.map((t) => t.id),
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
