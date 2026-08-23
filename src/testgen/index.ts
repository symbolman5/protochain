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
  AIPrompt,
} from '../model/types.js';
import {
  runGenerationLoop,
  type GenerationAttempt,
  type GenerationLoopOptions,
} from '../ai/generation-loop.js';
import {
  preflightTestToolCode,
  preflightTypeScript,
  type MechanicalPreflightResult,
} from '../ai/preflight.js';

export interface TestGenOptions {
  /** 是否使用 AI 生成（false 时纯代码生成基础骨架） */
  useAI?: boolean;
  /** AI 生成 loop 的预算（maxIterations / maxTokens / maxToolCalls） */
  loop?: GenerationLoopOptions;
  /**
   * E6：emit 选项。
   * - undefined / 'test-tool'：原行为（生成 4 文件）
   * - 'mock'：额外生成 derived/test-tool/mocks.ts（fixtures+spy）
   */
  emit?: 'test-tool' | 'mock';
}

export async function generateTestTool(
  model: SourceProtocolModel,
  specs: InterfaceSpec[],
  contracts: ContractSet | undefined,
  aiAdapter?: AIAdapter,
  options: TestGenOptions = {}
): Promise<TestToolCode> {
  const { useAI = false } = options;

  // P3：AI 生成路径走"生成 -> tsc 机械预检 -> 修正 -> 重试"loop；
  // useAI=false / 无适配器时完全走下面的确定性路径（不回退、不破坏）。
  if (useAI && aiAdapter) {
    return generateTestToolWithAI(model, specs, contracts, aiAdapter, options.loop);
  }

  // 1. protocol-model.ts：从 SourceProtocolModel 生成（代码确定性）
  const protocolModel = generateProtocolModelCode(model);

  // 2. scenario-loader.ts：场景加载器（代码确定性）
  const scenarioLoader = generateScenarioLoaderCode();

  // 3. protocol-executor.ts：协议执行器（代码确定性骨架）
  const protocolExecutor = generateExecutorCode(model, specs);

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

/**
 * P3：AI 生成 protocol-executor.ts，并在 loop 内做机械预检：
 * 1) 结构预检（导出符号齐备）；
 * 2) 把四个源文件写入临时目录运行 tsc --noEmit；
 * 编译错误作为 feedback 交给 AI 修正，直到预算耗尽。
 * protocol-model / scenario-loader / consistency-asserter 仍由代码确定性生成。
 */
async function generateTestToolWithAI(
  model: SourceProtocolModel,
  specs: InterfaceSpec[],
  contracts: ContractSet | undefined,
  aiAdapter: AIAdapter,
  loopOptions?: GenerationLoopOptions
): Promise<TestToolCode> {
  const protocolModel = generateProtocolModelCode(model);
  const scenarioLoader = generateScenarioLoaderCode();
  const consistencyAsserter = generateAsserterCode(model);
  // 确定性参考实现：作为 AI 生成的类型契约锚点（防类型漂移）
  const referenceExecutor = generateExecutorCode(model, specs);

  const { result: protocolExecutor } = await runGenerationLoop<string>(
    aiAdapter,
    {
      buildPrompt: ({ iteration, previousAttempts }) =>
        buildExecutorPrompt(model, specs, contracts, iteration, previousAttempts, referenceExecutor),
      parse: async (content: string) => {
        const trimmed = content.trim();
        if (trimmed.length === 0) {
          throw new Error('AI 返回空源码');
        }
        // 容忍 ```ts 代码块包裹
        return trimmed
          .replace(/^```(?:ts|typescript)\s*/i, '')
          .replace(/\s*```\s*$/i, '');
      },
      preflight: async (executorCode: string) => {
        const tool: TestToolCode = {
          protocolModel,
          scenarioLoader,
          protocolExecutor: executorCode,
          consistencyAsserter,
          generatedAt: new Date().toISOString(),
        };
        const structural = preflightTestToolCode(tool);
        if (!structural.passed) {
          return { passed: false, feedback: structural.feedback };
        }
        const compiled: MechanicalPreflightResult = await preflightTypeScript({
          'protocol-model.ts': protocolModel,
          'scenario-loader.ts': scenarioLoader,
          'protocol-executor.ts': executorCode,
          'consistency-asserter.ts': consistencyAsserter,
        });
        return { passed: compiled.passed, feedback: compiled.feedback };
      },
    },
    loopOptions
  );

  return {
    protocolModel,
    scenarioLoader,
    protocolExecutor,
    consistencyAsserter,
    generatedAt: new Date().toISOString(),
  };
}

function buildExecutorPrompt(
  model: SourceProtocolModel,
  specs: InterfaceSpec[],
  contracts: ContractSet | undefined,
  iteration: number,
  previousAttempts: GenerationAttempt<string>[],
  referenceExecutor?: string
): AIPrompt {
  const context = JSON.stringify(
    {
      metadata: model.metadata,
      derivable: model.derivable,
      specs: specs.map((s) => ({
        id: s.id,
        kind: s.kind,
        name: s.name,
        sourceId: s.sourceId,
        inputs: s.inputs,
        outputs: s.outputs,
      })),
      contracts: contracts
        ? {
            parties: contracts.parties,
            information: contracts.information,
            timing: contracts.timing,
          }
        : undefined,
      // 确定性参考实现：与 protocol-model/scenario-loader/consistency-asserter
      // 类型契约一致且可编译；AI 生成必须与之兼容（避免类型漂移）
      ...(referenceExecutor ? { referenceExecutor } : {}),
    },
    null,
    2
  );

  const instruction: string[] = [
    `第 ${iteration} 次生成。请为协议测试工具生成 protocol-executor.ts 的完整 TypeScript 源码。`,
    '要求（必须全部满足）：',
    "- 从 './protocol-model.js' 导入 STATES、TRANSITIONS、STATE_BY_ID、TRANSITIONS_BY_FROM、TRANSITION_BY_ACTION、INITIAL_STATE_ID、TERMINAL_STATE_IDS、INVARIANTS；",
    "- 从 './scenario-loader.js' 导入 loadScenarios 与 Scenario 类型；",
    "- 从 './consistency-asserter.js' 导入 assertConsistency 与 ConsistencyResult 类型；",
    '- 导出 ProtocolImplementation 接口（每个 kind=system 的接口一个方法）、ExecutionContext、executeAction、executeScenario、executePath；',
    '- executeAction 必须校验动作存在、当前状态在 transition.from 中，并校验实现返回的 nextState 与协议预期一致；',
    '- 类型契约必须与兄弟生成文件一致（参考实现已满足，直接沿用其类型用法）：',
    '  * TRANSITION_BY_ACTION 是 Record<string, TransitionDef[]>（同名动作多转移为数组，勿按单对象处理）；',
    '  * Scenario 字段以 scenario-loader 为准（id/name/description/initialFacts/expectedActions/expectedFinalState，没有 initialState/steps）；',
    '  * ExecutionContext 必须包含 implementation/currentState/history/actionHistory 字段；',
    '  * 不得重定义或改动 protocol-model 的类型（StateDef/TransitionDef 等），一律 import 使用；',
    '- 若参考实现存在：在其基础上按本协议动作集调整/补全，保持其导出签名与类型字段不变；',
    '- 只输出 TypeScript 源码本身，不要输出 markdown 代码块标记或额外解释。',
  ];
  const feedbacks = previousAttempts
    .map((a) => a.preflight.feedback)
    .filter((f): f is string => Boolean(f));
  if (feedbacks.length > 0) {
    instruction.push(
      '',
      '上一轮生成的机械预检未通过，请根据以下反馈修正后重新生成完整源码：',
      feedbacks.map((f) => `---\n${f}`).join('\n')
    );
  }

  return {
    system:
      '你是协议驱动测试工具代码生成器。你只生成可被 TypeScript 编译器直接通过的协议执行器源码，不添加解释。',
    context,
    instruction: instruction.join('\n'),
    outputFormat: 'TypeScript 源码（protocol-executor.ts 的完整文件内容）',
    temperature: 0.3,
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
    '  description?: string;',
    '  facts?: string[];',
    '  roleIds?: string[];',
    '  dimensions?: StateDimension[];',
    '}',
    '',
    'export interface StateDimension {',
    '  name: string;',
    '  type: string;',
    '  initial: string | number | boolean;',
    '  validWhen?: string;',
    '}',
    '',
    'export interface TransitionDef {',
    '  id: string;',
    '  name: string;',
    '  from: string[];',
    '  to: string;',
    '  action: string;',
    '  triggerRoleId?: string;',
    '  guard?: string;',
    '  effects?: string[];',
    '  isException?: boolean;',
    '  triggerType: "role" | "system" | "external";',
    '  trigger: string;',
    '  actionType: "state_transition" | "attribute_update";',
    '  affectsDimensions: string[];',
    '  attributeEffects?: AttributeEffect[];',
    '}',
    '',
    'export interface AttributeEffect {',
    '  field: string;',
    '  operation: "set" | "increment" | "append" | "remove";',
    '  value?: string;',
    '}',
    '',
    'export interface InvariantDef {',
    '  id: string;',
    '  name: string;',
    '  expression: string;',
    '  scopeStateIds?: string[];',
    '  description?: string;',
    '  declaredAsRenegotiation?: boolean;',
    '  declaredBy: string;',
    '  invariantClass: "intra_protocol" | "cross_protocol" | "cross_instance";',
    '  // ── E4：数据级不变量声明 ──',
    "  level?: 'state-machine' | 'data';",
    "  source?: 'storage' | 'guard';",
    '  storageRef?: string;',
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
    '// 转移索引（按 action 查询；同名动作多转移以数组存储，避免对象字面量键冲突）',
    'export const TRANSITION_BY_ACTION: Record<string, TransitionDef[]> = {',
    ...(() => {
      const byAction = new Map<string, typeof derivable.transitions>();
      for (const t of derivable.transitions) {
        const list = byAction.get(t.action) ?? [];
        list.push(t);
        byAction.set(t.action, list);
      }
      return [...byAction.entries()].map(([action, ts]) => `  ${JSON.stringify(action)}: ${JSON.stringify(ts)},`);
    })(),
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
  // 同名动作多转移会生成重复 system 接口（如 deregister T5/T6）；接口按名去重
  const systemSpecs = [
    ...new Map(
      specs
        .filter((s) => s.kind === 'system')
        .map((s) => [s.name, s] as const),
    ).values(),
  ];
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
    '  const matches = TRANSITION_BY_ACTION[action];',
    '  const transition = Array.isArray(matches)',
    '    ? matches.find((t) => t.from.includes(ctx.currentState)) ?? matches[0]',
    '    : matches;',
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
    ' * 执行单个转移（按 transitionId 精确解析，绕开 TRANSITION_BY_ACTION 对同名动作丢键的问题）',
    ' */',
    'export async function executeTransition(',
    '  ctx: ExecutionContext,',
    '  transitionId: string,',
    '): Promise<{ success: boolean; error?: string }> {',
    '  const transition = TRANSITIONS.find((t) => t.id === transitionId);',
    '  if (!transition) {',
    '    return { success: false, error: `未知转移: ${transitionId}` };',
    '  }',
    '  if (!transition.from.includes(ctx.currentState)) {',
    '    const expectedFrom = transition.from.join("/");',
    '    return { success: false, error: `当前状态 ${ctx.currentState} 不允许执行转移 ${transitionId}（${transition.action}，需 ${expectedFrom}）` };',
    '  }',
    '  const impl = (ctx.implementation as any)[transition.action];',
    '  if (!impl) {',
    '    return { success: false, error: `实现未提供动作 ${transition.action}` };',
    '  }',
    '  try {',
    '    const result = await impl(ctx.currentState);',
    '    if (result.nextState !== transition.to) {',
    '      return { success: false, error: `实现返回状态 ${result.nextState} 与协议预期 ${transition.to} 不一致` };',
    '    }',
    '    ctx.currentState = result.nextState;',
    '    ctx.history.push(result.nextState);',
    '    ctx.actionHistory.push(transition.action);',
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
    '    const result = await executeTransition(ctx, tid);',
    '    if (!result.success) {',
    '      return {',
    '        passed: false,',
    '        error: `转移 ${tid} 执行失败: ${result.error}`,',
    '        finalState: ctx.currentState,',
    '      };',
    '    }',
    '  }',
    '',
    '  return assertConsistency(ctx, { id: "path", name: "path", expectedActions: [], expectedFinalState: "" });',
    '}',
  ];
  return lines.join('\n');
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

// ============================================================================
// E6：Mock/Spy 自动生成（fixtures 由 TRANSITIONS 静态查表 + spy 计数）
// ============================================================================

/**
 * E6：生成 derived/test-tool/mocks.ts。
 *
 * 文件契约：
 *  - 默认导出 `buildMockImplementation(model)`：每个 action → 返回 fixtures 中
 *    固定 nextState（按 TRANSITIONS 查表）+ spy 计数（calls[action]++）；
 *  - 命名导出 `getSpySnapshot()` / `resetSpy()`：测试 / verify 接入用；
 *  - 全 deterministic：相同 model + 相同调用序列 → 相同 nextState 与 spy 计数
 *    （无时间 / 随机 / IO）。
 *
 * 为什么 fixtures 选 TRANSITIONS 而非 expectedResults：
 *   - test-cases.json 仅含 transitionIds/expectedActions（详见 test-cases.schema
 *     + test-cases.json 实例）；
 *   - scenarios/*.yaml 同样不含 expectedResponse 字段；
 *   - TRANSITIONS 是 model.md 静态可机械消费的确定性数据，且重推导链路干净；
 *   - 与 protocol-model.ts 同源（TRANSITIONS 同一数组），fixtures 与模型不漂移。
 */
export function generateMockCode(model: SourceProtocolModel): string {
  const byAction = new Map<string, { to: string; effects?: string[] }[]>();
  for (const t of model.derivable.transitions) {
    const list = byAction.get(t.action) ?? [];
    list.push({ to: t.to, effects: t.effects });
    byAction.set(t.action, list);
  }

  const actions = Array.from(byAction.keys()).sort();
  // 每个 action 直接生成一个 async 方法体：fixtures[i] → nextState
  // 同一进程内 spy 全局共享（resetSpy 在 verify --mock 前调用）
  // 使用 string[] + join 拼接，避免嵌套 template literal 的 ${} 解析歧义。
  const methodsLines: string[] = [];
  for (const action of actions) {
    const list = byAction.get(action) ?? [];
    const fixturesJson = JSON.stringify(list);
    const safeAction = action.replace(/[^A-Za-z0-9_]/g, '_');
    methodsLines.push(
      `    // action=${action}（fixtures ${list.length} entries）`,
      `    ['${action}']: async function _mock_${safeAction}(_currentState: string, ..._args: unknown[]) {`,
      `      const fixtures = ${fixturesJson} as Array<{ to: string; effects?: string[] }>;`,
      `      calls['${action}'] = (calls['${action}'] ?? 0) + 1;`,
      `      spySnapshotAt = new Date().toISOString();`,
      `      const f = fixtures[0];`,
      `      return { nextState: f.to, effects: f.effects };`,
      `    },`,
    );
  }
  const methodsCode = methodsLines.join('\n');

  // 模板主体用 string[] + join 拼接，避免内层 ${...} 被外层 template 抢占
  const lines: string[] = [
    '/**',
    ' * E6 Mock/Spy 自动生成（fixtures + spy 计数）。',
    ' * Auto-generated by protochain testgen --emit=mock（不要手动编辑；改 model.md → 重新跑 generate-tests）。',
    ' *',
    ` * 来源：${model.sourcePath ?? 'protocol/model.md'} v${model.metadata.version}`,
    ' * fixtures 源：protocol-model TRANSITIONS（静态查表，确定性）。',
    ' *',
    ' * 使用：',
    " *   import buildMockImplementation from './mocks.js';",
    ' *   const impl = buildMockImplementation();',
    ' *   const run = await runTestCasesWithTestTool(tool, testCases, impl);',
    ' *',
    ' * 确定性强约束：',
    ' *   - 同 model + 同调用序列 → 同 nextState / 同 spy 计数；',
    ' *   - 无 Date.now / 随机 / IO；spySnapshotAt 仅用于 UI 展示不影响 mock 返回值。',
    ' */',
    '',
    "import type { SourceProtocolModel } from '../model/types.js';",
    '',
    '// ============================================================================',
    '// Spy 状态（in-process；同一进程内所有 mock 实例共享）',
    '// ============================================================================',
    '',
    'const calls: Record<string, number> = Object.create(null);',
    'let spySnapshotAt: string | undefined;',
    '',
    'export function getSpySnapshot(): { counters: Record<string, number>; snapshotAt?: string } {',
    '  return { counters: { ...calls }, snapshotAt: spySnapshotAt };',
    '}',
    '',
    'export function resetSpy(): void {',
    '  for (const k of Object.keys(calls)) delete calls[k];',
    '  spySnapshotAt = undefined;',
    '}',
    '',
    '// ============================================================================',
    '// 默认导出：buildMockImplementation(model)',
    '// 返回一个稳定的 mock 实现对象；调用 spy + 返回 fixtures.to',
    '// ============================================================================',
    '',
    'export default function buildMockImplementation(model?: SourceProtocolModel): {',
    '  [action: string]: (currentState: string, ...args: unknown[]) => Promise<{ nextState: string; effects?: string[] }>;',
    '} {',
    '  const obj: {',
    '    [action: string]: (currentState: string, ...args: unknown[]) => Promise<{ nextState: string; effects?: string[] }>;',
    '  } = {};',
    '  Object.assign(obj, {',
    methodsCode,
    '  });',
    '  return obj;',
    '}',
  ];
  return lines.join('\n') + '\n';
}
