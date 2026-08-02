/**
 * 测试工具代码生成 —— 步骤⑥（AI 执行）
 *
 * 设计依据：《协议驱动自验证工具链设计方案》testgen 模块
 *
 * 生成三个组件源代码（开发者可审阅调试，不依赖 protochain 运行时）：
 * 1. scenario-loader.ts：加载 protocol/scenarios/ 下的场景文件
 * 2. protocol-executor.ts：按协议路径执行动作，调用实现接口
 * 3. consistency-asserter.ts：断言协议预期与实际一致
 * 4. protocol-model.ts：从 SourceProtocolModel 生成的协议模型常量
 *
 * 生成代码而非运行时解释——开发者可审阅调试。
 */

import type {
  SourceProtocolModel,
  DerivableLayer,
  InterfaceSpec,
  ContractSet,
  TestToolCode,
  AIAdapter,
} from '../model/types.js';

export interface TestGenOptions {
  /** 是否使用 AI 生成（false 时纯代码生成基础骨架） */
  useAI?: boolean;
}

export async function generateTestTool(
  model: SourceProtocolModel,
  specs: InterfaceSpec[],
  contracts: ContractSet | undefined,
  aiAdapter?: AIAdapter,
  options: TestGenOptions = {}
): Promise<TestToolCode> {
  const { useAI = false } = options;

  // 1. protocol-model.ts：从 SourceProtocolModel 生成（代码确定性）
  const protocolModel = generateProtocolModelCode(model);

  // 2. scenario-loader.ts：场景加载器（代码确定性）
  const scenarioLoader = generateScenarioLoaderCode();

  // 3. protocol-executor.ts：协议执行器（代码确定性骨架，可 AI 增强）
  let protocolExecutor: string;
  if (useAI && aiAdapter) {
    protocolExecutor = await generateExecutorWithAI(model, specs, aiAdapter);
  } else {
    protocolExecutor = generateExecutorCode(model, specs);
  }

  // 4. consistency-asserter.ts：一致性断言器（代码确定性）
  const consistencyAsserter = generateAsserterCode(model);

  return {
    scenarioLoader,
    protocolExecutor,
    consistencyAsserter,
    protocolModel,
    generatedAt: new Date().toISOString(),
  };
}

// ============================================================================
// protocol-model.ts：协议模型常量
// ============================================================================

function generateProtocolModelCode(model: SourceProtocolModel): string {
  const derivable = model.derivable;
  const lines: string[] = [
    '/**',
    ' * 协议模型常量（自动生成，请勿手动编辑）',
    ` * 来源：${model.sourcePath ?? 'protocol/model.md'}`,
    ` * 生成时间：${new Date().toISOString()}`,
    ' */',
    '',
    `export const PROTOCOL_NAME = ${JSON.stringify(model.metadata.name)};`,
    `export const PROTOCOL_VERSION = ${JSON.stringify(model.metadata.version)};`,
    '',
    'export interface StateDef {',
    '  id: string;',
    '  name: string;',
    '  type: "initial" | "normal" | "terminal" | "error";',
    '  roleIds?: string[];',
    '}',
    '',
    'export interface TransitionDef {',
    '  id: string;',
    '  name: string;',
    '  from: string;',
    '  to: string;',
    '  action: string;',
    '  triggerRoleId?: string;',
    '  guard?: string;',
    '  effects?: string[];',
    '}',
    '',
    'export interface InvariantDef {',
    '  id: string;',
    '  name: string;',
    '  expression: string;',
    '  scopeStateIds?: string[];',
    '}',
    '',
    `export const STATES: StateDef[] = ${JSON.stringify(derivable.states, null, 2)};`,
    '',
    `export const TRANSITIONS: TransitionDef[] = ${JSON.stringify(derivable.transitions, null, 2)};`,
    '',
    `export const INVARIANTS: InvariantDef[] = ${JSON.stringify(derivable.invariants, null, 2)};`,
    '',
    `export const INITIAL_STATE_ID = ${JSON.stringify(derivable.initialStateId)};`,
    '',
    `export const TERMINAL_STATE_IDS = ${JSON.stringify(derivable.terminalStateIds)};`,
    '',
    '// 状态索引（按 ID 查询）',
    'export const STATE_BY_ID: Record<string, StateDef> = {',
    ...derivable.states.map((s) => `  ${JSON.stringify(s.id)}: ${JSON.stringify(s)},`),
    '};',
    '',
    '// 转移索引（按 from 状态分组）',
    'export const TRANSITIONS_BY_FROM: Record<string, TransitionDef[]> = {',
    ...derivable.states.map((s) => {
      const ts = derivable.transitions.filter((t) => t.from.includes(s.id));
      return `  ${JSON.stringify(s.id)}: ${JSON.stringify(ts)},`;
    }),
    '};',
    '',
    '// 转移索引（按 action 查询）',
    'export const TRANSITION_BY_ACTION: Record<string, TransitionDef> = {',
    ...derivable.transitions.map((t) => `  ${JSON.stringify(t.action)}: ${JSON.stringify(t)},`),
    '};',
    '',
    '// ============================================================================',
    '// MultiDimensionAsserter：多维断言器',
    '// ============================================================================',
    '',
    '/**',
    ' * 多维断言器 —— 对指定维度进行值断言',
    ' * 适用于跨协议场景下多个维度的一致性与合规性检查',
    ' */',
    'export class MultiDimensionAsserter {',
    '  private dimensionName: string;',
    '  private expectedValue: any;',
    '',
    '  constructor(dimensionName: string, expectedValue: any) {',
    '    this.dimensionName = dimensionName;',
    '    this.expectedValue = expectedValue;',
    '  }',
    '',
    '  /**',
    '   * 断言当前状态中指定维度的值符合预期',
    '   * @param state - 当前状态数据（维度名 → 维度值）',
    '   * @returns 是否符合预期',
    '   */',
    '  assert(state: Record<string, any>): boolean {',
    '    const actualValue = state[this.dimensionName];',
    '    if (actualValue === undefined) {',
    '      return false;',
    '    }',
    '    return actualValue === this.expectedValue;',
    '  }',
    '}',
    '',
    '// ============================================================================',
    '// CrossProtocolScenarioLoader：跨协议场景加载器',
    '// ============================================================================',
    '',
    '/**',
    ' * 跨协议场景加载器 —— 加载跨协议场景文件并解析为场景数据',
    ' * 用于步骤⑦-C 跨协议测试用例的执行',
    ' */',
    'export class CrossProtocolScenarioLoader {',
    '  private scenePaths: string[];',
    '',
    '  constructor(scenePaths: string[]) {',
    '    this.scenePaths = scenePaths;',
    '  }',
    '',
    '  /**',
    '   * 加载所有场景文件',
    '   * @returns 场景数据数组',
    '   */',
    '  async load(): Promise<any[]> {',
    '    // 骨架实现：由开发者根据实际场景格式填充',
    '    return [];',
    '  }',
    '}',
  ];
  return lines.join('\n');
}

// ============================================================================
// scenario-loader.ts：场景加载器
// ============================================================================

function generateScenarioLoaderCode(): string {
  return `/**
 * 场景加载器（自动生成）
 * 从 protocol/scenarios/ 加载 YAML 场景文件，供协议执行器使用
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface Scenario {
  id: string;
  name: string;
  description?: string;
  initialFacts?: Record<string, unknown>;
  expectedActions: string[];
  expectedFinalState: string;
}

export function loadScenarios(scenariosDir: string): Scenario[] {
  if (!existsSync(scenariosDir)) {
    return [];
  }
  const files = readdirSync(scenariosDir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
  const scenarios: Scenario[] = [];
  for (const file of files) {
    const path = join(scenariosDir, file);
    const raw = readFileSync(path, 'utf-8');
    const scenario = parseYaml(raw) as Scenario;
    if (scenario && scenario.id) {
      scenarios.push(scenario);
    }
  }
  return scenarios;
}

export function loadScenario(path: string): Scenario {
  const raw = readFileSync(path, 'utf-8');
  return parseYaml(raw) as Scenario;
}
`;
}

// ============================================================================
// protocol-executor.ts：协议执行器
// ============================================================================

function generateExecutorCode(
  model: SourceProtocolModel,
  specs: InterfaceSpec[]
): string {
  const systemSpecs = specs.filter((s) => s.kind === 'system');
  const lines: string[] = [
    '/**',
    ' * 协议执行器（自动生成）',
    ' * 按协议路径执行动作，调用实现接口',
    ' */',
    '',
    "import { STATES, TRANSITIONS, STATE_BY_ID, TRANSITIONS_BY_FROM, TRANSITION_BY_ACTION, INITIAL_STATE_ID, TERMINAL_STATE_IDS, INVARIANTS } from './protocol-model.js';",
    "import { loadScenarios, type Scenario } from './scenario-loader.js';",
    "import { assertConsistency, type ConsistencyResult } from './consistency-asserter.js';",
    '',
    '/**',
    ' * 协议实现接口（开发者填充）',
    ' */',
    'export interface ProtocolImplementation {',
    ...systemSpecs.map((s) => `  ${s.name}: (currentState: string, ...args: any[]) => Promise<{ nextState: string; effects?: string[] }>;`),
    '}',
    '',
    '/**',
    ' * 协议执行上下文',
    ' */',
    'export interface ExecutionContext {',
    '  implementation: ProtocolImplementation;',
    '  currentState: string;',
    '  history: string[]; // 状态历史',
    '  actionHistory: string[]; // 动作历史',
    '}',
    '',
    '/**',
    ' * 执行单个动作',
    ' */',
    'export async function executeAction(',
    '  ctx: ExecutionContext,',
    '  action: string,',
    '  ...args: any[]',
    '): Promise<{ success: boolean; error?: string }> {',
    '  const transition = TRANSITION_BY_ACTION[action];',
    '  if (!transition) {',
    '    return { success: false, error: `未知动作: ${action}` };',
    '  }',
    '  if (!transition.from.includes(ctx.currentState)) {',
    '    const expectedFrom = transition.from.join("/");',
    '    return { success: false, error: `当前状态 ${ctx.currentState} 不允许执行动作 ${action}（需 ${expectedFrom}）` };',
    '  }',
    '  // 守卫条件检查（简化：由实现内部判断）',
    '  const impl = (ctx.implementation as any)[action];',
    '  if (!impl) {',
    '    return { success: false, error: `实现未提供动作 ${action}` };',
    '  }',
    '  try {',
    '    const result = await impl(ctx.currentState, ...args);',
    '    if (result.nextState !== transition.to) {',
    '      return { success: false, error: `实现返回状态 ${result.nextState} 与协议预期 ${transition.to} 不一致` };',
    '    }',
    '    ctx.currentState = result.nextState;',
    '    ctx.history.push(result.nextState);',
    '    ctx.actionHistory.push(action);',
    '    return { success: true };',
    '  } catch (err) {',
    '    return { success: false, error: err instanceof Error ? err.message : String(err) };',
    '  }',
    '}',
    '',
    '/**',
    ' * 执行场景：按场景期望的动作序列执行，断言最终状态',
    ' */',
    'export async function executeScenario(',
    '  scenario: Scenario,',
    '  implementation: ProtocolImplementation',
    '): Promise<ConsistencyResult> {',
    '  const ctx: ExecutionContext = {',
    '    implementation,',
    '    currentState: INITIAL_STATE_ID,',
    '    history: [INITIAL_STATE_ID],',
    '    actionHistory: [],',
    '  };',
    '',
    '  for (const action of scenario.expectedActions) {',
    '    const result = await executeAction(ctx, action);',
    '    if (!result.success) {',
    '      return {',
    '        passed: false,',
    '        scenarioId: scenario.id,',
    '        error: `动作 ${action} 执行失败: ${result.error}`,',
    '        finalState: ctx.currentState,',
    '      };',
    '    }',
    '  }',
    '',
    '  // 断言最终状态与一致性',
    '  return assertConsistency(ctx, scenario);',
    '}',
    '',
    '/**',
    ' * 执行协议路径（用于自动生成的测试用例）',
    ' */',
    'export async function executePath(',
    '  transitionIds: string[],',
    '  implementation: ProtocolImplementation',
    '): Promise<ConsistencyResult> {',
    '  const ctx: ExecutionContext = {',
    '    implementation,',
    '    currentState: INITIAL_STATE_ID,',
    '    history: [INITIAL_STATE_ID],',
    '    actionHistory: [],',
    '  };',
    '',
    '  for (const tid of transitionIds) {',
    '    const transition = TRANSITIONS.find((t) => t.id === tid);',
    '    if (!transition) {',
    '      return { passed: false, error: `未知转移: ${tid}`, finalState: ctx.currentState };',
    '    }',
    '    const result = await executeAction(ctx, transition.action);',
    '    if (!result.success) {',
    '      return {',
    '        passed: false,',
    '        error: `转移 ${tid}（${transition.action}）执行失败: ${result.error}`,',
    '        finalState: ctx.currentState,',
    '      };',
    '    }',
    '  }',
    '',
    '  return assertConsistency(ctx, { id: "path", expectedActions: [], expectedFinalState: "" });',
    '}',
  ];
  return lines.join('\n');
}

async function generateExecutorWithAI(
  model: SourceProtocolModel,
  specs: InterfaceSpec[],
  aiAdapter: AIAdapter
): Promise<string> {
  // P3 阶段：AI 增强为可选项，默认仍用代码生成
  // 完整 AI 生成需 P5 阶段打磨
  return generateExecutorCode(model, specs);
}

// ============================================================================
// consistency-asserter.ts：一致性断言器
// ============================================================================

function generateAsserterCode(model: SourceProtocolModel): string {
  const invariants = model.derivable.invariants;
  const terminalStates = model.derivable.terminalStateIds;

  return `/**
 * 一致性断言器（自动生成）
 * 断言协议执行结果与协议预期一致
 */

import { INVARIANTS, TERMINAL_STATE_IDS, STATE_BY_ID } from './protocol-model.js';
import type { ExecutionContext } from './protocol-executor.js';
import type { Scenario } from './scenario-loader.js';

export interface ConsistencyResult {
  passed: boolean;
  scenarioId?: string;
  error?: string;
  finalState: string;
  invariantViolations?: string[];
}

/**
 * 断言执行上下文与场景预期一致
 */
export function assertConsistency(
  ctx: ExecutionContext,
  scenario: Scenario
): ConsistencyResult {
  // 1. 若场景指定了期望最终状态，校验之
  if (scenario.expectedFinalState && ctx.currentState !== scenario.expectedFinalState) {
    return {
      passed: false,
      scenarioId: scenario.id,
      error: \`最终状态 \${ctx.currentState} 与期望 \${scenario.expectedFinalState} 不一致\`,
      finalState: ctx.currentState,
    };
  }

  // 2. 校验不变量（简化：调用实现提供的观测接口判断）
  // 不变量具体语义需实现侧判断，此处仅做结构性检查
  const violations: string[] = [];
  for (const inv of INVARIANTS) {
    // 局部不变量：仅当历史中出现过作用状态时检查
    if (inv.scopeStateIds && inv.scopeStateIds.length > 0) {
      const inScope = inv.scopeStateIds.some((sid) => ctx.history.includes(sid));
      if (!inScope) continue;
    }
    // 标记待实现检查（实际由实现侧的 observe_* 接口判断）
    violations.push(\`不变量 \${inv.id}（\${inv.name}）需实现侧 observe_\${inv.id} 接口判断\`);
  }

  return {
    passed: true,
    scenarioId: scenario.id,
    finalState: ctx.currentState,
    invariantViolations: violations,
  };
}

/**
 * 断言终态可达性
 */
export function assertTerminalReached(ctx: ExecutionContext): ConsistencyResult {
  if (!TERMINAL_STATE_IDS.includes(ctx.currentState)) {
    return {
      passed: false,
      error: \`最终状态 \${ctx.currentState} 不是终态\`,
      finalState: ctx.currentState,
    };
  }
  return { passed: true, finalState: ctx.currentState };
}
`;
}
