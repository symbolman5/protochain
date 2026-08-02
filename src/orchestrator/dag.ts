/**
 * 步骤依赖 DAG
 *
 * 设计依据：《协议驱动自验证工具链设计方案》第三节步骤依赖DAG
 *
 * ①完备性检查 → ②AI推演 → ③形式化验证 → ⑤规格推导 → ④契约推导 → ⑥测试工具生成 → ⑦测试用例生成
 *                                                                                       ↓
 *                                                ⑧实现完整性检查 ← （⑨实现编码完成后）
 *                                                                                       ↓
 *                                                                                    ⑩一致性验证
 *
 * 设计决策：执行序为 ⑤→④（先推导完整规格，再从规格投影出契约），与方法论4.1节投影关系一致。
 * CLI命令编号 ④⑤ 为逻辑分组序，非执行序。
 */

import type { StepId, StepNode, StepExecutionResult } from '../model/types.js';

const STEP_NODES: Record<StepId, StepNode> = {
  check: {
    id: 'check',
    methodologyNumber: '①',
    name: '完备性检查',
    executor: 'code+ai',
    dependsOn: [],
    hasCheckpoint: false,
  },
  reason: {
    id: 'reason',
    methodologyNumber: '②',
    name: 'AI推演',
    executor: 'ai',
    dependsOn: ['check'],
    hasCheckpoint: true,
  },
  formalize: {
    id: 'formalize',
    methodologyNumber: '③',
    name: '形式化验证',
    executor: 'code+ai',
    dependsOn: ['reason'],
    hasCheckpoint: true,
  },
  'derive-specs': {
    id: 'derive-specs',
    methodologyNumber: '⑤',
    name: '规格推导',
    executor: 'code',
    dependsOn: ['formalize'],
    hasCheckpoint: false,
  },
  'derive-contracts': {
    id: 'derive-contracts',
    methodologyNumber: '④',
    name: '契约推导',
    executor: 'code+ai',
    dependsOn: ['derive-specs'],
    hasCheckpoint: true,
  },
  'generate-tests': {
    id: 'generate-tests',
    methodologyNumber: '⑥',
    name: '测试工具生成',
    executor: 'ai',
    dependsOn: ['derive-contracts'],
    hasCheckpoint: true,
  },
  'generate-cases': {
    id: 'generate-cases',
    methodologyNumber: '⑦',
    name: '测试用例生成',
    executor: 'ai',
    dependsOn: ['generate-tests'],
    hasCheckpoint: true,
  },
  'check-impl': {
    id: 'check-impl',
    methodologyNumber: '⑧',
    name: '实现完整性检查',
    executor: 'code',
    dependsOn: ['generate-cases'],
    hasCheckpoint: false,
  },
  verify: {
    id: 'verify',
    methodologyNumber: '⑩',
    name: '一致性验证',
    executor: 'code',
    dependsOn: ['check-impl'],
    hasCheckpoint: true,
  },
  // 组合层步骤（-C）：仅在多协议系统启用，穿插在子协议流程间
  'check-composition': {
    id: 'check-composition',
    methodologyNumber: '①-C',
    name: '组合层完备性检查',
    executor: 'code+ai',
    // 依赖各子协议 ① check 完成（DAG 中以 'check' 表示）
    dependsOn: ['check'],
    hasCheckpoint: true,
  },
  'check-cross-invariants': {
    id: 'check-cross-invariants',
    methodologyNumber: '②-C',
    name: '跨协议不变量推演',
    executor: 'code+ai',
    dependsOn: ['check-composition', 'reason'],
    hasCheckpoint: true,
  },
  'formalize-cross': {
    id: 'formalize-cross',
    methodologyNumber: '③-C',
    name: '跨协议形式化验证',
    executor: 'code+ai',
    dependsOn: ['check-cross-invariants'],
    hasCheckpoint: true,
  },
  'derive-cross-contracts': {
    id: 'derive-cross-contracts',
    methodologyNumber: '④-C',
    name: '跨协议契约推导',
    executor: 'code+ai',
    dependsOn: ['formalize-cross', 'derive-contracts'],
    hasCheckpoint: true,
  },
  'generate-cross-cases': {
    id: 'generate-cross-cases',
    methodologyNumber: '⑦-C',
    name: '跨协议测试用例生成',
    executor: 'ai',
    dependsOn: ['derive-cross-contracts', 'generate-cases'],
    hasCheckpoint: true,
  },
};

/** 单协议系统执行序（与方法论编号一致，但 ⑤ 在 ④ 之前） */
const EXECUTION_ORDER: StepId[] = [
  'check',
  'reason',
  'formalize',
  'derive-specs',
  'derive-contracts',
  'generate-tests',
  'generate-cases',
  'check-impl',
  'verify',
];

/**
 * 组合层步骤执行序（多协议系统穿插在子协议流程间）。
 * 穿插位置（依据方案 4.4 DAG）：
 * - ①-C 在各子协议 ① 之后
 * - ②-C 在 ①-C + 各子协议 ② 之后
 * - ③-C 在 ②-C 之后
 * - ④-C 在 ③-C + 各子协议 ④ 之后
 * - ⑦-C 在 ④-C + 各子协议 ⑦ 之后
 */
const COMPOSITION_STEP_ORDER: StepId[] = [
  'check-composition',
  'check-cross-invariants',
  'formalize-cross',
  'derive-cross-contracts',
  'generate-cross-cases',
];

/** 组合层步骤集合（快速判断） */
const COMPOSITION_STEPS = new Set<StepId>(COMPOSITION_STEP_ORDER);

/** 判断是否为组合层步骤（-C 步骤） */
export function isCompositionStep(stepId: StepId): boolean {
  return COMPOSITION_STEPS.has(stepId);
}

/** 获取组合层步骤执行序（多协议系统使用） */
export function getCompositionSteps(): StepNode[] {
  return COMPOSITION_STEP_ORDER.map((id) => STEP_NODES[id]);
}

export function getStep(stepId: StepId): StepNode {
  return STEP_NODES[stepId];
}

export function getAllSteps(): StepNode[] {
  return EXECUTION_ORDER.map((id) => STEP_NODES[id]);
}

/** 获取某步骤的全部前置步骤（递归，含传递依赖） */
export function getAllPrerequisites(stepId: StepId): StepId[] {
  const result: StepId[] = [];
  const visited = new Set<StepId>();
  const stack: StepId[] = [...STEP_NODES[stepId].dependsOn];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (visited.has(cur)) continue;
    visited.add(cur);
    result.push(cur);
    stack.push(...STEP_NODES[cur].dependsOn);
  }
  return result;
}

/** 获取从 from 到 to 的执行序列（含两端） */
export function getStepRange(from: StepId, to: StepId): StepId[] {
  const fromIdx = EXECUTION_ORDER.indexOf(from);
  const toIdx = EXECUTION_ORDER.indexOf(to);
  if (fromIdx === -1 || toIdx === -1) {
    throw new Error(`未知步骤: ${fromIdx === -1 ? from : to}`);
  }
  if (fromIdx > toIdx) {
    throw new Error(`起始步骤 ${from} 在 ${to} 之后，无法构成正向区间`);
  }
  return EXECUTION_ORDER.slice(fromIdx, toIdx + 1);
}

export interface PrerequisiteCheckResult {
  satisfied: boolean;
  missing: StepId[];
}

/** 检查某步骤的前置是否全部完成且通过 */
export function checkPrerequisites(
  stepId: StepId,
  completedSteps: Map<StepId, StepExecutionResult>
): PrerequisiteCheckResult {
  const required = getAllPrerequisites(stepId);
  const missing: StepId[] = [];
  for (const req of required) {
    const result = completedSteps.get(req);
    if (!result || !result.passed) {
      missing.push(req);
    }
  }
  return { satisfied: missing.length === 0, missing };
}
