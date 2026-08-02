/**
 * 跨协议契约推导器 —— 步骤 ④-C
 *
 * 设计依据：《协议驱动自验证工具链设计方案》composition 模块
 *
 * 职责：根据 CompositionModel 推导跨协议边界契约（CrossContractSet），
 *       涵盖事件契约、影响范围契约、时序契约与补偿契约。
 *
 * 四个推导维度：
 * 1. 事件契约：从 dependencyGraph.edges 投影，每条 edge 表示子协议间的事件依赖
 * 2. 影响范围契约：从 externalDependencies 投影，外部系统的故障影响面
 * 3. 时序契约：从 crossTiming 投影，跨协议时序约束的契约化表达
 * 4. 补偿契约：暂为空（P5 阶段从 externalDependencies.compensation 补充）
 */

import type {
  CompositionModel,
  CrossContractSet,
  CrossEventContract,
  CrossImpactContract,
  CrossCompensationContract,
  CrossTimingContract,
} from '../model/types.js';

export function deriveCrossContracts(composition: CompositionModel): CrossContractSet {
  // 1. 事件契约：从依赖图边推导
  const eventContracts = deriveEventContracts(composition);

  // 2. 影响范围契约：从外部依赖推导
  const impactContracts = deriveImpactContracts(composition);

  // 3. 时序契约：从跨协议时序定义推导
  const timingContracts = deriveTimingContracts(composition);

  // 4. 补偿契约：从 externalDependencies.compensation 投影
  const compensationContracts = deriveCompensationContracts(composition);

  return {
    eventContracts,
    impactContracts,
    compensationContracts,
    timingContracts,
  };
}

// ============================================================================
// 事件契约推导
// ============================================================================

function deriveEventContracts(composition: CompositionModel): CrossEventContract[] {
  const contracts: CrossEventContract[] = [];

  for (let i = 0; i < composition.dependencyGraph.edges.length; i++) {
    const edge = composition.dependencyGraph.edges[i];

    contracts.push({
      id: `cross-event-${i}`,
      fromProtocol: edge.from,
      toProtocol: edge.to,
      event: `${edge.dependencyType}: ${edge.description}`,
      information: [],
      timing: undefined,
    });
  }

  return contracts;
}

// ============================================================================
// 影响范围契约推导
// ============================================================================

function deriveImpactContracts(composition: CompositionModel): CrossImpactContract[] {
  const contracts: CrossImpactContract[] = [];

  for (let i = 0; i < composition.externalDependencies.length; i++) {
    const dep = composition.externalDependencies[i];

    contracts.push({
      id: `cross-impact-${i}`,
      sourceEvent: dep.system,
      affectedProtocols: [dep.protocol],
      expectedResponse: dep.syncSemantics,
    });
  }

  return contracts;
}

// ============================================================================
// 时序契约推导
// ============================================================================

function deriveTimingContracts(composition: CompositionModel): CrossTimingContract[] {
  const contracts: CrossTimingContract[] = [];

  for (let i = 0; i < composition.crossTiming.length; i++) {
    const ct = composition.crossTiming[i];

    contracts.push({
      id: `cross-timing-${i}`,
      crossTimingId: ct.id,
      span: ct.span,
      rule: ct.rule,
      boundMs: ct.boundMs,
      // P5 阶段补充违约处理
      onViolation: undefined,
      // P5 阶段关联补偿契约
      compensationContractId: undefined,
    });
  }

  return contracts;
}

// ============================================================================
// 补偿契约推导
// ============================================================================

function deriveCompensationContracts(
  composition: CompositionModel
): CrossCompensationContract[] {
  const contracts: CrossCompensationContract[] = [];
  for (let i = 0; i < composition.externalDependencies.length; i++) {
    const dep = composition.externalDependencies[i];
    if (!dep.compensation || dep.compensation.length === 0) continue;
    // 每条补偿规则生成一个独立的契约
    for (let j = 0; j < dep.compensation.length; j++) {
      contracts.push({
        id: `cross-compensation-${i}-${j}`,
        failureScenario: dep.impactOnFailure || `${dep.system} 不可用`,
        compensationAction: dep.compensation[j],
        span: [dep.protocol],
      });
    }
  }
  return contracts;
}
