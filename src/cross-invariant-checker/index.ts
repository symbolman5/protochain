/**
 * 跨协议不变量检查器 —— 步骤②-C 机械层+AI混合（代码确定性检查 + AI 概率性判断）
 *
 * 设计依据：《协议驱动自验证工具链设计方案》2.1 cross-invariant-checker 模块、决策9
 *
 * 混合策略：
 * - complexity='simple_boolean'：代码机械解析受限 DSL 表达式，按不变量的 span
 *   实例化各子协议状态空间，触发关联动作，检查不变量是否被违反
 * - complexity='first_order'：AI 辅助判断（含一阶量词表达式的语义分析）
 *
 * 状态空间裁剪策略（默认 invariant_driven）：
 * - 从不变量表达式提取涉及维度，只实例化边界值组合
 * - simple_boolean：代码机械提取维度
 * - first_order：AI 辅助提取涉及维度
 *
 * 输入：CompositionModel + 各子协议 SourceProtocolModel
 * 输出：CrossInvariantReport
 */

import type {
  CompositionModel,
  SourceProtocolModel,
  CrossInvariantDef,
  CrossInvariantReport,
  CrossInvariantCheckResult,
  DerivableLayer,
  AIAdapter,
} from '../model/types.js';
import { parseAIJson } from '../ai/adapter.js';

// ============================================================================
// StateInstantiator（跨协议状态实例化）
// ============================================================================

export interface ProtocolInstanceState {
  instanceId: string;
  currentStateId: string;
  dimensionValues: Record<string, string | number | boolean>;
  lifecycleStatus: 'active' | 'cascaded_destroyed' | 'orphaned';
}

export interface InstanceLink {
  fromProtocol: string;
  fromInstanceId: string;
  toProtocol: string;
  toInstanceId: string;
  linkKey: string;
}

export interface MultiProtocolState {
  protocolStates: Map<string, ProtocolInstanceState[]>;
  instanceLinks: InstanceLink[];
}

/**
 * 从 invariant_driven 策略实例化多协议状态。
 *
 * 对于 simple_boolean 不变量：
 * - 解析 DSL 表达式提取涉及的维度（形如 `<protocolId>.<dimension> <op> <value>`）
 * - 只实例化这些维度的边界值组合
 *
 * 跨协议实例关联基于对象状态切面的 idKey 建立。
 */
export function instantiateMultiProtocolStates(
  composition: CompositionModel,
  subProtocolModels: SourceProtocolModel[],
  invariant: CrossInvariantDef
): MultiProtocolState {
  const protocolStates = new Map<string, ProtocolInstanceState[]>();
  const instanceLinks: InstanceLink[] = [];

  // 建立 protocolName → protocolId 映射
  const protocolIdByName = new Map<string, string>();
  for (const sp of composition.subProtocols) {
    protocolIdByName.set(sp.name, sp.protocolId);
  }

  // 为 span 覆盖的每个子协议实例化基础状态
  for (const protocolId of invariant.span) {
    const model = subProtocolModels.find(
      (m) =>
        m.sourcePath?.includes(`protocol/${protocolId}/`) ||
        composition.subProtocols.find((sp) => sp.protocolId === protocolId && sp.name === m.metadata.name)
    );
    if (!model) continue;

    const states = instantiateProtocolStates(model, protocolId, invariant);
    protocolStates.set(protocolId, states);
  }

  // 建立实例间关联（基于对象状态切面的 idKey）
  for (const facet of composition.objectStateFacets) {
    for (const linkSource of facet.facets) {
      const fromStates = protocolStates.get(linkSource.protocol) ?? [];
      for (const targetFacet of facet.facets) {
        if (targetFacet.protocol === linkSource.protocol) continue;
        const toStates = protocolStates.get(targetFacet.protocol) ?? [];
        // 简单一对一关联
        const count = Math.min(fromStates.length, toStates.length);
        for (let i = 0; i < count; i++) {
          const from = fromStates[i];
          const to = toStates[i];
          if (from.lifecycleStatus === 'active' && to.lifecycleStatus === 'active') {
            instanceLinks.push({
              fromProtocol: linkSource.protocol,
              fromInstanceId: from.instanceId,
              toProtocol: targetFacet.protocol,
              toInstanceId: to.instanceId,
              linkKey: facet.idKey,
            });
          }
        }
      }
    }
  }

  return { protocolStates, instanceLinks };
}

/** 为单个协议实例化状态快照 */
function instantiateProtocolStates(
  model: SourceProtocolModel,
  protocolId: string,
  _invariant: CrossInvariantDef
): ProtocolInstanceState[] {
  const states: ProtocolInstanceState[] = [];
  const derivable = model.derivable;

  // 为每个非 terminal 状态创建一个实例（简化版：每状态一个实例）
  for (const s of derivable.states) {
    if (s.type === 'terminal') continue;
    // 构建维度值快照：使用维度定义的 initial 值
    const dimensionValues: Record<string, string | number | boolean> = {};
    for (const dim of s.dimensions ?? []) {
      dimensionValues[dim.name] = dim.initial;
    }
    // 同时检查附属实体的维度
    for (const ent of derivable.subsidiaryEntities ?? []) {
      for (const dim of ent.stateSpace.dimensions) {
        if (!(dim.name in dimensionValues)) {
          dimensionValues[dim.name] = dim.initial;
        }
      }
    }
    states.push({
      instanceId: `${protocolId}-${s.id}-inst`,
      currentStateId: s.id,
      dimensionValues,
      lifecycleStatus: 'active',
    });
  }

  return states;
}

// ============================================================================
// Simple Boolean 不变量检查（代码确定性执行）
// ============================================================================

/**
 * 受限 DSL 语法：
 *   <protocolId>.<dimension> <op> <value>
 *   布尔组合：AND / OR / NOT
 *
 * op ∈ {=, ≠, >, <, ≥, ≤}
 *
 * 示例：
 *   P2.port_exclusive = true
 *   P2.port_bound = true AND P2.traffic_count > 0
 */
function checkSimpleBooleanInvariant(
  invariant: CrossInvariantDef,
  state: MultiProtocolState
): CrossInvariantCheckResult {
  const terms = parseSimpleBooleanExpression(invariant.expression);

  if (terms.length === 0) {
    return {
      invariantId: invariant.id,
      passed: true,
      checkMethod: 'code',
    };
  }

  // 展开所有实例状态组合并逐项检查
  const allStates = collectActiveStates(state);

  for (const term of terms) {
    const termResult = evaluateTerm(term, allStates, state);
    if (!termResult) {
      return {
        invariantId: invariant.id,
        passed: false,
        counterexample: `不变量 "${invariant.name}" 违反：条件 "${JSON.stringify(term)}" 不满足`,
        checkMethod: 'code',
      };
    }
  }

  return {
    invariantId: invariant.id,
    passed: true,
    checkMethod: 'code',
  };
}

interface DSLTerm {
  protocolId: string;
  dimension: string;
  op: string;
  value: string | number | boolean;
}

function parseSimpleBooleanExpression(expr: string): DSLTerm[] {
  const terms: DSLTerm[] = [];
  // 按 AND 分割子句
  const clauses = expr.split(/\bAND\b/i).map((c) => c.trim()).filter(Boolean);

  for (const clause of clauses) {
    // 去除可能的 NOT 前缀（简化版：标记但不展开完整真值表）
    const cleanClause = clause.replace(/\bNOT\b\s*/i, '').trim();

    // 匹配 <protocolId>.<dimension> <op> <value>
    const match = cleanClause.match(/^(\w+)\.(\w+)\s*(=|≠|>=|<=|>|<)\s*(.+)$/);
    if (match) {
      const value = parseValue(match[4].trim());
      terms.push({
        protocolId: match[1],
        dimension: match[2],
        op: match[3],
        value,
      });
    }
    // 直接 true/false 常数项跳过（永久满足/违反）
  }

  return terms;
}

function evaluateTerm(
  term: DSLTerm,
  allStates: Map<string, ProtocolInstanceState[]>,
  state: MultiProtocolState
): boolean {
  const states = allStates.get(term.protocolId) ?? [];
  if (states.length === 0) return true; // 无实例 → 空真

  for (const s of states) {
    const actual = s.dimensionValues[term.dimension];
    const expected = term.value;

    if (term.op === '=' || term.op === '==') {
      if (actual !== expected) return false;
    } else if (term.op === '≠' || term.op === '!=') {
      if (actual === expected) return false;
    } else if (term.op === '>') {
      if (typeof actual !== 'number' || typeof expected !== 'number' || actual <= expected) return false;
    } else if (term.op === '<') {
      if (typeof actual !== 'number' || typeof expected !== 'number' || actual >= expected) return false;
    } else if (term.op === '>=') {
      if (typeof actual !== 'number' || typeof expected !== 'number' || actual < expected) return false;
    } else if (term.op === '<=') {
      if (typeof actual !== 'number' || typeof expected !== 'number' || actual > expected) return false;
    }
  }

  return true;
}

function parseValue(raw: string): string | number | boolean {
  const trimmed = raw.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  const num = Number(trimmed);
  if (!isNaN(num)) return num;
  return trimmed.replace(/^["']|["']$/g, '');
}

function collectActiveStates(
  state: MultiProtocolState
): Map<string, ProtocolInstanceState[]> {
  const result = new Map<string, ProtocolInstanceState[]>();
  for (const [protocolId, states] of state.protocolStates) {
    result.set(
      protocolId,
      states.filter((s) => s.lifecycleStatus === 'active')
    );
  }
  return result;
}

// ============================================================================
// AI 辅助一阶量词不变量检查
// ============================================================================

interface AIFirstOrderCheckResult {
  invariantId: string;
  passed: boolean;
  severity: 'error' | 'warning' | 'info';
  message: string;
  counterexample?: string;
}

async function checkFirstOrderInvariant(
  invariant: CrossInvariantDef,
  stateSummary: string,
  adapter: AIAdapter
): Promise<CrossInvariantCheckResult> {
  const prompt = buildFirstOrderCheckPrompt(invariant, stateSummary);
  const response = await adapter.complete(prompt);

  if (!response.success) {
    return {
      invariantId: invariant.id,
      passed: false,
      checkMethod: 'code+ai',
      counterexample: 'AI 适配器调用失败，无法完成一阶不变量检查',
    };
  }

  try {
    const result = parseAIJson<AIFirstOrderCheckResult>(response.content);
    return {
      invariantId: result.invariantId,
      passed: result.passed,
      counterexample: result.counterexample,
      checkMethod: 'code+ai',
    };
  } catch {
    // AI 输出无法解析 → 标记未通过
    return {
      invariantId: invariant.id,
      passed: false,
      counterexample: `AI 输出无法解析：${response.content.slice(0, 200)}`,
      checkMethod: 'code+ai',
    };
  }
}

function buildFirstOrderCheckPrompt(
  invariant: CrossInvariantDef,
  stateSummary: string
): { system: string; context: string; instruction: string; outputFormat: string; temperature: number } {
  return {
    system:
      '你是跨协议一阶不变量检查器。检查跨协议不变量在当前多协议状态快照下是否被违反。' +
      '若发现违反，提供反例（具体的状态组合）。你的输出必须是严格的 JSON。',
    context: JSON.stringify(
      {
        invariant: { id: invariant.id, name: invariant.name, expression: invariant.expression, span: invariant.span },
        stateSummary,
      },
      null,
      2
    ),
    instruction: '分析上述跨协议不变量在多协议状态快照下是否成立。若违反，提供具体的反例说明。',
    outputFormat: JSON.stringify(
      {
        invariantId: invariant.id,
        passed: false,
        severity: 'error',
        message: '违反说明',
        counterexample: '具体违反的状态组合（可选）',
      },
      null,
      2
    ),
    temperature: 0.2,
  };
}

// ============================================================================
// 主入口：cross-invariant-checker
// ============================================================================

export interface CheckCrossInvariantsOptions {
  /** AI 适配器（用于 first_order 不变量检查） */
  adapter?: AIAdapter;
  /** 子协议模型映射 */
  subProtocolModels: SourceProtocolModel[];
}

/**
 * ②-C 主入口：
 * 1. 对每个跨协议不变量，按 invariant_driven 策略实例化多协议状态
 * 2. simple_boolean → 代码机械检查
 * 3. first_order → AI 辅助检查
 */
export async function checkCrossInvariants(
  composition: CompositionModel,
  options: CheckCrossInvariantsOptions
): Promise<CrossInvariantReport> {
  const results: CrossInvariantCheckResult[] = [];
  const stateSummaries: string[] = [];

  for (const invariant of composition.crossInvariants) {
    // 步骤1：实例化多协议状态
    const multiState = instantiateMultiProtocolStates(
      composition,
      options.subProtocolModels,
      invariant
    );

    // 生成状态摘要
    const summaryParts: string[] = [];
    for (const [pid, states] of multiState.protocolStates) {
      const activeStates = states.filter((s) => s.lifecycleStatus === 'active');
      summaryParts.push(
        `${pid}: ${activeStates.map((s) => `${s.currentStateId}(${JSON.stringify(s.dimensionValues)})`).join(', ')}`
      );
    }
    const stateSummary = summaryParts.join('; ');
    stateSummaries.push(
      `不变量 ${invariant.id}: ${stateSummary}`
    );

    // 步骤2：按复杂度选择检查策略
    if (invariant.complexity === 'simple_boolean') {
      const result = checkSimpleBooleanInvariant(invariant, multiState);
      results.push(result);
    } else {
      // first_order → 需要 AI 适配器
      if (!options.adapter) {
        results.push({
          invariantId: invariant.id,
          passed: false,
          counterexample: `一阶不变量 "${invariant.id}" 需要 AI 适配器但未提供，跳过检查`,
          checkMethod: 'code+ai',
        });
        continue;
      }
      const result = await checkFirstOrderInvariant(
        invariant,
        stateSummary,
        options.adapter
      );
      results.push(result);
    }
  }

  const passed = results.every((r) => r.passed);

  return {
    passed,
    results,
    instantiatedStateSummary: stateSummaries.join('\n'),
    checkedAt: new Date().toISOString(),
  };
}
