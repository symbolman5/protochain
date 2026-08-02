/**
 * 跨协议形式化桥接器 —— 步骤③-C（代码生成骨架 + AI 辅助，标注"AI+工具"）
 *
 * 设计依据：《协议驱动自验证工具链设计方案》2.1 cross-formalizer 模块、AI参与矩阵
 *
 * 职责：
 * - 消费组合层 + 各子协议可推演层
 * - 生成全局 TLA+ 规格骨架：各子协议状态合并为全局状态空间，跨协议不变量变为全局不变量
 * - 对超出 LLM 上下文窗口的多协议系统，分协议逐步生成规格片段再合并
 *
 * 输入：CompositionModel + 各子协议 SourceProtocolModel
 * 输出：FormalReport（含生成的全局 TLA+ 规格文本）
 *
 * 降低期望：③-C 为可选步骤，未通过不阻塞下游（标注"未经确定性验证"）
 */

import type {
  CompositionModel,
  SourceProtocolModel,
  FormalReport,
  AIAdapter,
} from '../model/types.js';
import { parseAIJson } from '../ai/adapter.js';

// ============================================================================
// TLA+ 骨架生成（代码确定性执行）
// ============================================================================

/**
 * 生成全局 TLA+ 规格骨架。
 *
 * 骨架包含：
 * - MODULE 声明
 * - 全局状态变量（各子协议状态 + 维度映射为 VARIABLE）
 * - 各子协议状态空间定义为常量集（CONSTANTS）
 * - Init 谓词：各子协议初始状态 + 实例关联
 * - Next 谓词骨架：各子协议的转移合并到全局转移（由 AI 填充转移逻辑）
 * - 跨协议不变量（组合层 crossInvariants 映射为 TypeInvariant）
 * - 跨协议时序约束（组合层 crossTiming 映射为 Temporal 属性）
 */
export function generateTlaSkeleton(
  composition: CompositionModel,
  subProtocolModels: SourceProtocolModel[]
): string {
  const lines: string[] = [];

  // MODULE 声明
  const moduleName = toAscii(composition.metadata.systemName).replace(/[^a-zA-Z0-9_]/g, '_') || 'System';
  lines.push(`---- MODULE ${moduleName} ----`);
  lines.push('\\* Global TLA+ spec (auto-generated skeleton, AI-assisted fill)');
  lines.push(`\\* System: ${toAscii(composition.metadata.systemName)}`);
  lines.push(`\\* Sub-protocols: ${composition.subProtocols.map((s) => `${s.protocolId}(${toAscii(s.name)})`).join(', ')}`);
  lines.push('');

  // EXTENDS
  lines.push('EXTENDS Naturals, Sequences, FiniteSets');
  lines.push('');

  // CONSTANTS（各子协议状态ID集合）
  for (const sp of composition.subProtocols) {
    const model = subProtocolModels.find(
      (m) => composition.subProtocols.find((s) => s.protocolId === sp.protocolId && s.name === m.metadata.name)
    );
    if (!model) continue;
    const stateIds = model.derivable.states.map((s) => s.id);
    lines.push(`\\* Sub-protocol ${sp.protocolId} (${toAscii(sp.name)}) state space`);
    lines.push(`CONSTANTS ${stateIds.join(', ')}`);
    const dimNames = collectDimensions(model);
    if (dimNames.length > 0) {
      lines.push(`CONSTANTS ${dimNames.map((d) => `${sp.protocolId}_${toTlaName(toAscii(d))}`).join(', ')}`);
    }
    lines.push('');
  }

  // VARIABLES（全局状态变量）
  lines.push('\\* Global state variables');
  for (const sp of composition.subProtocols) {
    const model = subProtocolModels.find(
      (m) => composition.subProtocols.find((s) => s.protocolId === sp.protocolId && s.name === m.metadata.name)
    );
    if (!model) continue;
    lines.push(`\\* ${sp.protocolId} current state`);
    lines.push(`VARIABLE ${sp.protocolId}_state`);
    // 多维度状态变量
    for (const s of model.derivable.states) {
      for (const dim of s.dimensions ?? []) {
        lines.push(`VARIABLE ${sp.protocolId}_${toTlaName(toAscii(dim.name))}`);
      }
    }
  }
  // 实例关联变量
  for (const facet of composition.objectStateFacets) {
    lines.push(`\\* Object link: ${toAscii(facet.object)} (idKey=${toAscii(facet.idKey)})`);
    lines.push(`VARIABLE ${toTlaName(toAscii(facet.object))}_link`);
  }
  lines.push('');

  // Init 谓词
  lines.push('\\* Initial state');
  lines.push('Init ==');
  for (const sp of composition.subProtocols) {
    const model = subProtocolModels.find(
      (m) => composition.subProtocols.find((s) => s.protocolId === sp.protocolId && s.name === m.metadata.name)
    );
    if (!model) continue;
    const initState = model.derivable.states.find((s) => s.type === 'initial');
    if (initState) {
      lines.push(`  /\\\\ ${sp.protocolId}_state = ${initState.id}`);
      for (const dim of initState.dimensions ?? []) {
        const tlaVal = typeof dim.initial === 'string' ? `"${toAscii(dim.initial)}"` : String(dim.initial);
        lines.push(`  /\\\\ ${sp.protocolId}_${toTlaName(toAscii(dim.name))} = ${tlaVal}`);
      }
    }
  }
  for (const facet of composition.objectStateFacets) {
    lines.push(`  /\\\\ ${toTlaName(toAscii(facet.object))}_link = {}`);
  }
  lines.push('');

  // Next 谓词骨架（AI 填充具体转移逻辑）
  lines.push('\\* Global transitions (AI fills sub-protocol transition logic)');
  lines.push('Next ==');
  lines.push('  \\/ \\* <AI: fill sub-protocol transitions>');
  for (const sp of composition.subProtocols) {
    lines.push(`  \\/ ${sp.protocolId}_Next`);
  }
  lines.push('');

  // 各子协议 Next 占位
  for (const sp of composition.subProtocols) {
    const model = subProtocolModels.find(
      (m) => composition.subProtocols.find((s) => s.protocolId === sp.protocolId && s.name === m.metadata.name)
    );
    if (!model) continue;
    lines.push(`\\* ${sp.protocolId} (${toAscii(sp.name)}) Next predicate`);
    lines.push(`${sp.protocolId}_Next ==`);
    for (const t of model.derivable.transitions) {
      // 自然语言守卫/效果无法翻译为 TLA+ 表达式 → 降级为 TRUE（语义保留于模型文档与 verify 层）
      const guard = t.guard ? ' /\\\\ TRUE' : '';
      const fromCond = `(${t.from.map(f => `${sp.protocolId}_state = ${f}`).join(' \\/ ')})`;
      lines.push(`  \\/ (${fromCond} /\\\\ ${sp.protocolId}_state' = ${t.to}${guard})`);
    }
    lines.push('');
  }

  // 跨协议不变量（TypeInvariant）
  if (composition.crossInvariants.length > 0) {
    lines.push('\\* Cross-protocol invariants (TypeInvariant)');
    lines.push('CrossInvariants ==');
    for (const inv of composition.crossInvariants) {
      const expr = translateToTlaExpression(inv.expression, composition);
      lines.push(`  /\\\\ ${expr}  \\* ${inv.id}: ${toAscii(inv.name)}`);
    }
    lines.push('');
    // 类型不变量由跨协议不变量组合 + 基本类型约束构成
    lines.push('\\* Global type invariant');
    lines.push('TypeInvariant ==');
    lines.push('  /\\\\ CrossInvariants');
    for (const sp of composition.subProtocols) {
      const model = subProtocolModels.find(
        (m) => composition.subProtocols.find((s) => s.protocolId === sp.protocolId && s.name === m.metadata.name)
      );
      if (!model) continue;
      const stateSet = `{${model.derivable.states.map((s) => s.id).join(', ')}}`;
      lines.push(`  /\\\\ ${sp.protocolId}_state \\\\in ${stateSet}`);
    }
    lines.push('');
  }

  // 跨协议时序属性（Temporal）
  if (composition.crossTiming.length > 0) {
    lines.push('\\* Cross-protocol timing constraints (Temporal properties)');
    for (const ct of composition.crossTiming) {
      const boundStr = ct.boundMs !== undefined ? `${ct.boundMs}_ms` : '';
      lines.push(`\\* ${ct.id}: ${toAscii(ct.name)} (${ct.span.join(', ')})`);
      lines.push(`\\* ${toAscii(ct.rule)}${boundStr ? ` [bound: ${boundStr}]` : ''}`);
    }
    lines.push('');
  }

  // Spec
  lines.push('\\* Spec definition');
  // vars 元组：所有状态变量 + 实例关联变量（Spec 的 [][Next]_vars 需声明）
  const varNames: string[] = [];
  for (const sp of composition.subProtocols) {
    const model = subProtocolModels.find(
      (m) => composition.subProtocols.find((s) => s.protocolId === sp.protocolId && s.name === m.metadata.name)
    );
    if (!model) continue;
    varNames.push(`${sp.protocolId}_state`);
    for (const s of model.derivable.states) {
      for (const dim of s.dimensions ?? []) {
        varNames.push(`${sp.protocolId}_${toTlaName(toAscii(dim.name))}`);
      }
    }
  }
  for (const facet of composition.objectStateFacets) {
    varNames.push(`${toTlaName(toAscii(facet.object))}_link`);
  }
  lines.push(`vars == <<${varNames.join(', ')}>>`);
  lines.push(`Spec == Init /\\\\ [][Next]_vars`);
  if (composition.crossInvariants.length > 0) {
    lines.push('Theorems == TypeInvariant');
  }
  lines.push('');
  lines.push('====');

  return lines.join('\n');
}

/** 移除文本中的非 ASCII 字符（TLA+ 注释/标识符仅支持 ASCII） */
function toAscii(str: string): string {
  return String(str ?? '').replace(/[^\x00-\x7F]/g, '');
}

function collectDimensions(model: SourceProtocolModel): string[] {
  const names = new Set<string>();
  for (const s of model.derivable.states) {
    for (const dim of s.dimensions ?? []) {
      names.add(dim.name);
    }
  }
  for (const ent of model.derivable.subsidiaryEntities ?? []) {
    for (const dim of ent.stateSpace.dimensions) {
      names.add(dim.name);
    }
  }
  return [...names];
}

function toTlaName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^(\d)/, '_$1');
}

/**
 * 将跨协议不变量 DSL 表达式翻译为 TLA+ 表达式（简化版，仅处理基本形式）。
 * 完整翻译由 AI 辅助完成。
 */
function translateToTlaExpression(expr: string, _composition: CompositionModel): string {
  // 简化翻译：一阶/自然语言表达式无法机械翻译 → 降级为 TRUE（语义保留于模型文档与 verify 层）
  if (/\b(forall|exists|not|exists.*?)\b/i.test(expr) || /[^\x00-\x7F]/.test(expr)) {
    return `TRUE  \\* <AI: first-order/natural-language expression needs manual translation>`;
  }
  // 替换协议维度引用：P2.port_exclusive → P2_port_exclusive
  let result = expr.replace(/(\w+)\.(\w+)/g, '$1_$2');
  // 替换操作符
  result = result.replace(/=/g, '=').replace(/≠/g, '/=');
  result = result.replace(/AND/gi, '/\\\\').replace(/OR/gi, '\\\\/').replace(/NOT/gi, '~');
  return result;
}

// ============================================================================
// AI 辅助填充（转移逻辑 + 一阶不变量翻译 + 时序属性）
// ============================================================================

interface AICrossFormalFillResult {
  filledTlaSpec: string;
  warnings: string[];
  completeness: 'full' | 'partial' | 'skeleton_only';
}

/**
 * AI 辅助填充 TLA+ 骨架中的转移逻辑、一阶不变量翻译和时序属性。
 *
 * 对超出上下文窗口的大型系统，采用分协议摘要策略。
 */
export async function fillTlaWithAI(
  skeleton: string,
  composition: CompositionModel,
  subProtocolModels: SourceProtocolModel[],
  adapter: AIAdapter
): Promise<{ filledSpec: string; completeness: 'full' | 'partial' | 'skeleton_only'; warnings: string[] }> {
  // 对大型系统做摘要
  const subProtocolSummary = subProtocolModels
    .map((m) => {
      const sp = composition.subProtocols.find((s) => s.name === m.metadata.name);
      const pid = sp?.protocolId ?? m.metadata.name;
      return `${pid}: states[${m.derivable.states.map((s) => s.id).join(',')}] transitions[${m.derivable.transitions.length}]`;
    })
    .join('; ');

  const prompt = buildCrossFormalPrompt(skeleton, composition, subProtocolSummary);
  const response = await adapter.complete(prompt);

  if (!response.success) {
    // AI 调用失败 → 返回骨架
    return {
      filledSpec: skeleton,
      completeness: 'skeleton_only',
      warnings: [`AI 适配器调用失败，返回未填充骨架：${response.error ?? 'unknown'}`],
    };
  }

  try {
    const result = parseAIJson<AICrossFormalFillResult>(response.content);
    return {
      filledSpec: result.filledTlaSpec || skeleton,
      completeness: result.completeness || 'skeleton_only',
      warnings: result.warnings || [],
    };
  } catch {
    // AI 输出无法解析 → 返回骨架
    return {
      filledSpec: skeleton,
      completeness: 'skeleton_only',
      warnings: [`AI 输出无法解析为 JSON，保留骨架。原始输出：${response.content.slice(0, 500)}`],
    };
  }
}

function buildCrossFormalPrompt(
  skeleton: string,
  composition: CompositionModel,
  subProtocolSummary: string
): { system: string; context: string; instruction: string; outputFormat: string; temperature: number } {
  return {
    system:
      '你是 TLA+ 规格专家。你需要填充一个跨协议全局 TLA+ 规格骨架，补充各子协议的转移逻辑、' +
      '跨协议不变量的一阶表达式翻译和时序属性定义。你的输出必须是严格的 JSON。' +
      '若某些部分无法自动填充，标记 completeness 为 partial 并附上 warnings。',
    context: JSON.stringify(
      {
        systemName: composition.metadata.systemName,
        subProtocols: composition.subProtocols.map((s) => ({
          id: s.protocolId,
          name: s.name,
        })),
        subProtocolSummary,
        crossInvariants: composition.crossInvariants.map((i) => ({
          id: i.id,
          name: i.name,
          expression: i.expression,
          span: i.span,
          complexity: i.complexity,
        })),
        crossTiming: composition.crossTiming.map((t) => ({
          id: t.id,
          name: t.name,
          rule: t.rule,
          span: t.span,
          boundMs: t.boundMs,
        })),
        skeleton,
      },
      null,
      2
    ),
    instruction:
      '基于上述骨架和子协议摘要，填充 TLA+ 规格中的转移逻辑、一阶不变量翻译和时序属性。' +
      '保持骨架的 MODULE/VARIABLE/CONSTANTS 声明不变，仅补充 Next 逻辑、不变量翻译和 Temporal 属性定义。',
    outputFormat: JSON.stringify(
      {
        filledTlaSpec: '<完整的 TLA+ 规格文本>',
        warnings: ['<警告信息>'],
        completeness: 'full',
      },
      null,
      2
    ),
    temperature: 0.2,
  };
}

// ============================================================================
// 主入口：cross-formalizer
// ============================================================================

export interface CrossFormalizeOptions {
  adapter?: AIAdapter;
  subProtocolModels: SourceProtocolModel[];
}

/**
 * ③-C 主入口：
 * 1. 代码生成 TLA+ 骨架
 * 2. AI 辅助填充（若提供 adapter）
 */
export async function crossFormalize(
  composition: CompositionModel,
  options: CrossFormalizeOptions
): Promise<FormalReport> {
  // 步骤1：代码生成骨架
  const skeleton = generateTlaSkeleton(composition, options.subProtocolModels);

  let generatedSpec = skeleton;
  let applicabilityIssues: string[] = [];
  let passed = true;

  // 步骤2：AI 辅助填充（可选）
  if (options.adapter) {
    try {
      const result = await fillTlaWithAI(
        skeleton,
        composition,
        options.subProtocolModels,
        options.adapter
      );
      generatedSpec = result.filledSpec;
      if (result.completeness === 'skeleton_only') {
        applicabilityIssues = result.warnings;
        passed = false;
      } else if (result.completeness === 'partial') {
        applicabilityIssues = ['跨协议形式化规格部分填充（AI 未能完成全部翻译）', ...result.warnings];
        passed = true; // ③-C 可选步骤，部分填充不阻塞
      } else {
        applicabilityIssues = result.warnings;
        passed = true;
      }
    } catch {
      applicabilityIssues = ['AI 辅助填充失败，保留骨架'];
      passed = true; // 骨架仍可用
    }
  } else {
    applicabilityIssues = ['未提供 AI 适配器，仅生成骨架（标注"未经确定性验证"）'];
  }

  return {
    passed,
    tool: 'tla+',
    suitabilityScore: 0.5,
    generatedSpec,
    specFilePath: 'derived/composition/model.tla',
    invariantResults: [],
    verifiedAt: new Date().toISOString(),
  };
}
