/**
 * 契约推导器 —— 步骤④（代码投影 + AI 辅助不变量相关性判断）
 *
 * 设计依据：《协议驱动自验证工具链设计方案》contractor 模块
 *
 * 关键设计决策：
 * - ④先调用⑤再投影：contractor 先取得 InterfaceSpec，再按协作边界投影
 * - 投影=代码确定性执行：信息契约、时序契约、约束契约由代码从规格机械投影
 * - 不变量相关性=AI辅助：判断不变量与哪些契约方相关（如多角色不变量涉及多方）
 *
 * 四层契约（方法论4.1节）：
 * 1. 信息契约：各方提供/消费的字段与流向
 * 2. 时序契约：时序约束的契约投影
 * 3. 约束契约：守卫条件的契约投影
 * 4. 不变量契约：不变量的契约投影（含相关性判断）
 */

import type {
  SourceProtocolModel,
  DerivableLayer,
  InterfaceSpec,
  ContractSet,
  ContractField,
  InformationFlow,
  TimingContractEntry,
  GuardContractEntry,
  InvariantContractEntry,
  AIAdapter,
  TransitionDef,
  InvariantDef,
} from '../model/types.js';
import { specify } from '../specifier/index.js';
import { parseAIJson } from '../ai/adapter.js';

export interface ContractOptions {
  /** 是否启用 AI 辅助不变量相关性判断 */
  useAIForInvariantRelevance?: boolean;
  /** 退化模式下允许 AI 辅助 */
  degradedAIAssist?: boolean;
}

export interface ContractResult {
  contracts: ContractSet;
  /** 推导使用的规格（⑤产出） */
  specs: InterfaceSpec[];
  /** 扩展：系统内部约束契约（triggerType='system' 的转移） */
  systemConstraints?: { transitionId: string; action: string; guard?: string; parties: string[]; }[];
  /** 扩展：外部事件契约（triggerType='external' 的转移） */
  externalEventContracts?: {
    transitionId: string;
    action: string;
    trigger: string;
    parties: string[];
    effects?: string[];
  }[];
}

export async function deriveContracts(
  model: SourceProtocolModel,
  specs: InterfaceSpec[],
  aiAdapter?: AIAdapter,
  options: ContractOptions = {}
): Promise<ContractResult> {
  const { useAIForInvariantRelevance = true, degradedAIAssist = true } = options;
  const derivable = model.derivable;
  const roles = model.metadata.roles;
  const parties = roles.map((r) => r.id);

  // 退化模式下允许 AI 辅助标记
  const assistFlag = derivable.degraded && degradedAIAssist;

  // 1. 信息契约：从转移的动作 + trigger + effects 推导
  const information = deriveInformationContract(derivable, parties, assistFlag);

  // 2. 时序契约：从 timing 推导
  const timing = deriveTimingContract(derivable, parties, assistFlag);

  // 3. 约束契约：从 transitions 的 guard 推导
  const constraint = deriveConstraintContract(derivable, parties, assistFlag);

  // 4. 不变量契约：从 invariants 推导（AI 辅助相关性判断）
  const invariant = await deriveInvariantContract(
    derivable,
    parties,
    aiAdapter,
    useAIForInvariantRelevance,
    assistFlag
  );

  const contracts: ContractSet = {
    parties,
    information,
    timing,
    constraint,
    invariant,
  };

  // 扩展：系统内部约束契约
  const systemConstraints = deriveSystemConstraintContracts(derivable, parties);
  // 扩展：外部事件契约
  const externalEventContracts = deriveExternalEventContracts(derivable, parties);

  return { contracts, specs, systemConstraints, externalEventContracts };
}

// ============================================================================
// 信息契约推导
// ============================================================================

function deriveInformationContract(
  derivable: DerivableLayer,
  parties: string[],
  degradedAssist: boolean
): ContractSet['information'] {
  const fields: ContractField[] = [];
  const flows: InformationFlow[] = [];
  const stateMap = new Map(derivable.states.map((s) => [s.id, s]));

  for (const t of derivable.transitions) {
    const fromStates = t.from.map(f => stateMap.get(f)).filter(Boolean);
    const toState = stateMap.get(t.to);
    // 提供方：触发转移的角色
    const provider = t.triggerRoleId ?? 'system';
    // 消费方：进入新状态后关联的角色
    const consumers = toState?.roleIds ?? [];

    // 字段：action 对应的请求/响应字段
    const requestField: ContractField = {
      name: `${t.action}_request`,
      type: 'object',
      providedBy: provider,
      consumedBy: consumers.length > 0 ? consumers : parties.filter((p) => p !== provider),
      description: `${t.name}：${t.action} 动作的请求信息`,
    };
    fields.push(requestField);

    // effects 中的字段
    if (t.effects) {
      for (const effect of t.effects) {
        const effectField: ContractField = {
          name: effect,
          type: 'string',
          providedBy: provider,
          consumedBy: consumers.length > 0 ? consumers : parties.filter((p) => p !== provider),
          description: `${t.name} 的副作用：${effect}`,
        };
        fields.push(effectField);
      }
    }

    // 信息流：provider → consumers
    for (const consumer of requestField.consumedBy) {
      flows.push({
        from: provider,
        to: consumer,
        fieldName: requestField.name,
        triggerAction: t.action,
      });
    }
  }

  return { fields, flows };
}

// ============================================================================
// 时序契约推导
// ============================================================================

function deriveTimingContract(
  derivable: DerivableLayer,
  parties: string[],
  degradedAssist: boolean
): ContractSet['timing'] {
  const constraints: TimingContractEntry[] = [];
  const stateIds = new Set(derivable.states.map((s) => s.id));
  const actionNames = new Set(derivable.transitions.map((t) => t.action));

  for (const tm of derivable.timing) {
    // 找出受约束的契约方：源/目标若是动作，找触发者；若是状态，找关联角色
    const involvedParties = new Set<string>();
    if (actionNames.has(tm.source)) {
      const t = derivable.transitions.find((tr) => tr.action === tm.source);
      if (t?.triggerRoleId) involvedParties.add(t.triggerRoleId);
    }
    if (actionNames.has(tm.target)) {
      const t = derivable.transitions.find((tr) => tr.action === tm.target);
      if (t?.triggerRoleId) involvedParties.add(t.triggerRoleId);
    }
    void degradedAssist;
    if (stateIds.has(tm.source)) {
      const s = derivable.states.find((st) => st.id === tm.source);
      s?.roleIds?.forEach((r) => involvedParties.add(r));
    }
    if (stateIds.has(tm.target)) {
      const s = derivable.states.find((st) => st.id === tm.target);
      s?.roleIds?.forEach((r) => involvedParties.add(r));
    }

    constraints.push({
      timingId: tm.id,
      type: tm.type,
      source: tm.source,
      target: tm.target,
      boundMs: tm.boundMs,
      parties: involvedParties.size > 0 ? Array.from(involvedParties) : parties,
    });
  }

  return { constraints };
}

// ============================================================================
// 约束契约推导
// ============================================================================

function deriveConstraintContract(
  derivable: DerivableLayer,
  parties: string[],
  degradedAssist: boolean
): ContractSet['constraint'] {
  const guards: GuardContractEntry[] = [];

  for (const t of derivable.transitions) {
    if (!t.guard) continue;
    // 受约束方：触发者 + 目标状态关联角色
    const involved = new Set<string>();
    if (t.triggerRoleId) involved.add(t.triggerRoleId);
    const toState = derivable.states.find((s) => s.id === t.to);
    toState?.roleIds?.forEach((r) => involved.add(r));

    guards.push({
      transitionId: t.id,
      action: t.action,
      guard: t.guard,
      parties: involved.size > 0 ? Array.from(involved) : parties,
    });
  }

  return { guards };
}

// ============================================================================
// 不变量契约推导（AI 辅助相关性判断）
// ============================================================================

async function deriveInvariantContract(
  derivable: DerivableLayer,
  parties: string[],
  aiAdapter: AIAdapter | undefined,
  useAI: boolean,
  degradedAssist: boolean
): Promise<ContractSet['invariant']> {
  const invariants: InvariantContractEntry[] = [];

  // 代码预判：基于不变量作用状态关联的角色
  const codeRelevance = deriveInvariantRelevanceByCode(derivable);

  // AI 辅助：判断代码预判未覆盖的相关性
  let aiRelevance: Record<string, { parties: string[]; note: string }> = {};
  if (useAI && aiAdapter && derivable.invariants.length > 0) {
    aiRelevance = await deriveInvariantRelevanceByAI(derivable, aiAdapter);
  }

  for (const inv of derivable.invariants) {
    const codeResult = codeRelevance[inv.id] ?? { parties, note: '默认关联所有方' };
    const aiResult = aiRelevance[inv.id];

    // AI 结果优先（若存在），否则用代码结果
    const finalParties = aiResult?.parties ?? codeResult.parties;
    const relevanceNote = aiResult?.note ?? codeResult.note;

    invariants.push({
      invariantId: inv.id,
      expression: inv.expression,
      parties: finalParties,
      relevanceNote,
      degradedAssist: degradedAssist || !!aiResult,
    });
  }

  return { invariants };
}

/**
 * 代码预判不变量相关性：基于作用状态关联的角色
 */
function deriveInvariantRelevanceByCode(
  derivable: DerivableLayer
): Record<string, { parties: string[]; note: string }> {
  const result: Record<string, { parties: string[]; note: string }> = {};

  for (const inv of derivable.invariants) {
    if (inv.scopeStateIds && inv.scopeStateIds.length > 0) {
      // 局部不变量：收集作用状态关联的角色
      const involved = new Set<string>();
      for (const sid of inv.scopeStateIds) {
        const s = derivable.states.find((st) => st.id === sid);
        s?.roleIds?.forEach((r) => involved.add(r));
      }
      result[inv.id] = {
        parties: involved.size > 0 ? Array.from(involved) : [],
        note: `基于作用状态 ${inv.scopeStateIds.join(', ')} 关联的角色`,
      };
    } else {
      // 全局不变量：所有角色相关
      result[inv.id] = {
        parties: [],
        note: '全局不变量，需 AI 判断具体相关方',
      };
    }
  }

  return result;
}

/**
 * AI 辅助判断不变量相关性
 */
async function deriveInvariantRelevanceByAI(
  derivable: DerivableLayer,
  aiAdapter: AIAdapter
): Promise<Record<string, { parties: string[]; note: string }>> {
  const prompt = {
    system:
      '你是协议契约分析专家。给定协议的不变量与角色列表，判断每个不变量与哪些角色（契约方）相关。' +
      '相关性指：该角色的行为会影响该不变量是否成立。输出严格 JSON。',
    context: JSON.stringify(
      {
        roles: derivable.states.flatMap((s) => s.roleIds ?? []).filter((v, i, a) => a.indexOf(v) === i),
        states: derivable.states,
        invariants: derivable.invariants.map((inv) => ({
          id: inv.id,
          name: inv.name,
          expression: inv.expression,
          scope: inv.scopeStateIds,
        })),
      },
      null,
      2
    ),
    instruction: [
      '请为每个不变量判断相关的契约方（角色 ID）：',
      '- 若不变量涉及某角色提供的信息或执行的动作，则该角色相关',
      '- 全局不变量通常涉及所有相关角色',
      '- parties 为空数组表示无相关方（罕见）',
    ].join('\n'),
    outputFormat: [
      '返回 JSON：',
      '{',
      '  "results": [',
      '    { "invariantId": "INV1", "parties": ["roleA", "roleB"], "note": "说明相关性理由" }',
      '  ]',
      '}',
    ].join('\n'),
    temperature: 0.1,
  };

  const response = await aiAdapter.complete(prompt);
  if (!response.success) {
    return {};
  }

  try {
    const parsed = parseAIJson<{ results: Array<{ invariantId: string; parties: string[]; note: string }> }>(response.content);
    const result: Record<string, { parties: string[]; note: string }> = {};
    for (const r of parsed.results) {
      result[r.invariantId] = { parties: r.parties, note: r.note };
    }
    return result;
  } catch {
    return {};
  }
}

// ============================================================================
// 扩展推导（P4：系统内部约束契约 + 外部事件契约）
// ============================================================================

/** triggerType='system' → 系统内部约束契约 */
function deriveSystemConstraintContracts(
  derivable: DerivableLayer,
  parties: string[]
): ContractResult['systemConstraints'] {
  const constraints: NonNullable<ContractResult['systemConstraints']> = [];

  for (const t of derivable.transitions) {
    if (t.triggerType !== 'system') continue;
    // 系统触发的转移：约束系统自身（不属于任何角色）
    // 关联方为 target 状态的角色
    const involved = new Set<string>();
    const toState = derivable.states.find((s) => s.id === t.to);
    toState?.roleIds?.forEach((r) => involved.add(r));

    constraints.push({
      transitionId: t.id,
      action: t.action,
      guard: t.guard,
      parties: involved.size > 0 ? Array.from(involved) : parties,
    });
  }

  return constraints.length > 0 ? constraints : undefined;
}

/** triggerType='external' → 外部事件契约 */
function deriveExternalEventContracts(
  derivable: DerivableLayer,
  parties: string[]
): ContractResult['externalEventContracts'] {
  const contracts: NonNullable<ContractResult['externalEventContracts']> = [];

  for (const t of derivable.transitions) {
    if (t.triggerType !== 'external') continue;
    const involved = new Set<string>();
    const toState = derivable.states.find((s) => s.id === t.to);
    toState?.roleIds?.forEach((r) => involved.add(r));

    contracts.push({
      transitionId: t.id,
      action: t.action,
      trigger: t.trigger ?? t.triggerRoleId ?? 'unknown',
      parties: involved.size > 0 ? Array.from(involved) : parties,
      effects: t.effects,
    });
  }

  return contracts.length > 0 ? contracts : undefined;
}
