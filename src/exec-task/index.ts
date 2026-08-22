/**
 * 子任务模式：protocol-runner 驱动 protochain 的结构化边界（《Harness 架构设计》§7 衔接）
 *
 * 契约：
 * - 输入：结构化 task.json（步骤清单、目标、上下文切片、预算、preflight 提示）；
 * - 执行：只执行请求的步骤；默认走现有确定性路径；AI 步骤仅当
 *   task.useAI === true 且存在可用适配器（config.ai 或调用方注入）时才走
 *   "生成 -> 机械预检 -> 修正 -> 重试" loop；
 * - 输出：结构化 result.json（status/summary/artifacts/partialArtifacts/facts/effects/
 *   openItems/cost，cost 含 loop 修正轮数与近似 token 用量）；
 * - 边界：本模块不执行权威 acceptance（handoff acceptance / verify / 真实接口调用），
 *   权威结论留在 protocol-runner 子任务边界；preflightAssertions 仅作为模型可读提示，
 *   不在 loop 内执行（P1 语义，与 dsh.ts 一致）。
 *
 * 红线对齐：
 * - 不修改 src/reasoner/index.ts：reason 步骤的 BFS/SCC 代码判定仍不可被 AI 推翻；
 * - loop 内只做机械预检（tsc --noEmit / schema / 覆盖度），不执行构建与真实接口调用；
 * - verify 步骤在子任务模式被显式禁止（它是权威 acceptance 层，不属于 harness 边界）。
 */
import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { loadConfig } from '../cli/config.js';
import { resolveProjectContext } from '../project/context.js';
import { estimateTokens } from '../ai/generation-loop.js';
import { createAIRouter, type AIRole } from '../ai/router.js';
import type {
  AIAdapter,
  AIPrompt,
  AIResponse,
  DerivedArtifacts,
  ProtochainConfig,
  SourceProtocolModel,
  StepExecutionResult,
  StepId,
} from '../model/types.js';
import { parseProtocolFile } from '../parser/index.js';
import { specify, specsFromEnvelope } from '../specifier/index.js';
import { deriveContracts } from '../contractor/index.js';
import { createCheckExecutor } from '../steps/check.js';
import { createReasonExecutor } from '../steps/reason.js';
import { createFormalizeExecutor } from '../steps/formalize.js';
import { createSpecifyExecutor } from '../steps/specify.js';
import { createContractExecutor } from '../steps/contract.js';
import { createTestGenExecutor } from '../steps/testgen.js';
import { createCaseGenExecutor } from '../steps/casegen.js';
import { createImplCheckExecutor } from '../steps/implcheck.js';
import { createVerifyExecutor } from '../steps/verify.js';
import { getAllPrerequisites, getAllSteps, getStep } from '../orchestrator/dag.js';
import {
  getExecutor,
  registerExecutor,
  saveState,
  type OrchestratorState,
  writeReport,
} from '../orchestrator/index.js';

// ---------------------------------------------------------------------------
// 结构化契约类型
// ---------------------------------------------------------------------------

export interface ExecTaskBudget {
  maxIterations?: number;
  maxTokens?: number;
  maxToolCalls?: number;
}

/** 预检提示（P1：仅模型可读，不执行） */
export interface ExecTaskPreflightHint {
  kind?: string;
  path?: string;
  command?: string;
  description?: string;
  [key: string]: unknown;
}

export interface ExecTaskContext {
  /** 相对 protochain 项目根的模型路径（默认 protocol/model.md） */
  modelPath?: string;
  /** 输入契约交付物（相对 protochain 项目根；仅记录/校验存在性，不越权消费） */
  inputContract?: string[];
  /** 写域提示（供结果核对；沙箱强约束在 protocol-runner 侧） */
  writeDomain?: string[];
  budget?: ExecTaskBudget;
  /** preflight 提示清单：只注入提示文本，不在 loop 内执行 */
  preflightAssertions?: ExecTaskPreflightHint[];
}

export interface ExecTaskInput {
  taskId: string;
  /** protochain 项目根（CLI 用；缺省取 --dir 或 cwd） */
  projectDir?: string;
  /** 多协议项目中的子协议 ID（如 P1）；缺省单协议 */
  protocolId?: string;
  /** 执行后持久化 orchestrator-state.yaml（兼容既有 acceptance；默认无状态） */
  persistState?: boolean;
  steps: StepId[];
  goal?: string;
  /** 显式启用 AI：仅当为 true 且存在可用适配器时，AI 步骤才走 loop */
  useAI?: boolean;
  context?: ExecTaskContext;
}

export interface ExecTaskFact {
  subject: string;
  kind: 'observation' | 'constraint' | 'risk' | 'assumption';
  detail: string;
}

export interface ExecTaskEffect {
  path: string;
  op: 'create' | 'modify' | 'delete';
  note?: string;
}

export interface ExecTaskOpenItem {
  id: string;
  kind: 'next-step' | 'unresolved-question' | 'blocker';
  summary: string;
  confidence?: number;
  suggestedOwner?: string;
}

export interface ExecTaskCost {
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  wallClockMs: number;
  loop?: {
    /** 本任务内 AI 调用总次数（近似 iteration 数） */
    iterations: number;
    /** 修正轮数近似：失败尝试次数（成功步 = max(0, aiCalls-1)，失败步 = aiCalls） */
    corrections: number;
  };
}

export interface ExecTaskStepResult {
  stepId: StepId;
  status: 'completed' | 'skipped' | 'failed';
  passed: boolean;
  outputs: string[];
  summary?: string;
  error?: string;
  aiCalls: number;
  corrections: number;
  /** 该步实际使用的模型名（多模型路由观测：semantic/reasoning/generation 分层证据） */
  aiModel?: string;
}

export interface ExecTaskResult {
  taskId: string;
  status: 'completed' | 'failed' | 'aborted';
  summary: string;
  reason?: string;
  artifacts: string[];
  partialArtifacts?: string[];
  /** 步骤级结果（含 aiModel 多模型路由观测） */
  stepResults: ExecTaskStepResult[];
  facts: ExecTaskFact[];
  effects: ExecTaskEffect[];
  openItems: ExecTaskOpenItem[];
  cost: ExecTaskCost;
  /** 多模型路由观测：各角色实际使用的模型名（未启用 AI 或角色未配置时为 undefined） */
  aiModelByRole?: Record<AIRole, string | undefined>;
  preflight: { provided: number; executed: 0 };
  startedAt: string;
  finishedAt: string;
}

export interface ExecTaskDeps {
  /** protochain 项目根（默认 process.cwd()） */
  projectDir?: string;
  /** 适配器注入（测试用 mock；缺省从 config.ai 构造） */
  adapterFor?: (role: AIRole) => AIAdapter | undefined;
  /** 是否自动补跑确定性前置步骤（check/derive-specs/derive-contracts），默认 false */
  includeDeterministicPrerequisites?: boolean;
  /** 执行后是否把 orchestrator-state.yaml 落盘（兼容既有 acceptance；默认 false 无状态） */
  persistState?: boolean;
}

// ---------------------------------------------------------------------------
// 内部辅助
// ---------------------------------------------------------------------------

/** 纯 AI 步骤：无适配器时无法执行（保持与现有步骤执行器一致） */
const AI_REQUIRED_STEPS = new Set<StepId>(['reason', 'formalize']);
/** 子任务模式禁止步骤：verify 是权威 acceptance / 真实接口层，不属于 harness 边界 */
const FORBIDDEN_STEPS = new Set<StepId>(['verify']);

function executionOrder(): StepId[] {
  return getAllSteps().map((s) => s.id);
}

function planSteps(
  requested: StepId[],
  includeDeterministicPrerequisites: boolean
): StepId[] {
  const order = executionOrder();
  const wanted = new Set<StepId>();
  for (const step of requested) {
    wanted.add(step);
    if (includeDeterministicPrerequisites) {
      for (const prereq of getAllPrerequisites(step)) {
        if (!AI_REQUIRED_STEPS.has(prereq)) wanted.add(prereq);
      }
    }
  }
  return order.filter((s) => wanted.has(s));
}

function validateInput(input: ExecTaskInput): string | null {
  if (!input || typeof input.taskId !== 'string' || input.taskId.trim().length === 0) {
    return 'task.json 缺少 taskId';
  }
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    return 'task.json steps 为空（需至少一个步骤）';
  }
  const order = new Set(executionOrder());
  for (const step of input.steps) {
    if (FORBIDDEN_STEPS.has(step)) {
      return `步骤 ${step} 在子任务模式被禁止：verify 属于权威 acceptance / 真实接口层，必须由 protocol-runner 在子任务边界执行`;
    }
    if (!order.has(step)) {
      return `步骤 ${step} 不是可执行的子任务步骤（可选：${[...order].join(', ')}）`;
    }
  }
  return null;
}

interface CostCounters {
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
}

function emptyCounters(): CostCounters {
  return { modelCalls: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0 };
}

/** 计数适配器：近似 token 用量 + AI 调用次数（成本账本数据源） */
class CountingAdapter implements AIAdapter {
  name: string;
  private inner: AIAdapter;
  private counters: CostCounters;

  constructor(inner: AIAdapter, counters: CostCounters) {
    this.inner = inner;
    this.counters = counters;
    this.name = `counted-${inner.name}`;
  }

  get modelName(): string {
    return (this.inner as { modelName?: string }).modelName ?? this.inner.name;
  }

  async complete(prompt: AIPrompt): Promise<AIResponse> {
    this.counters.modelCalls += 1;
    this.counters.toolCalls += 1;
    this.counters.inputTokens += estimateTokens(
      prompt.system,
      prompt.context,
      prompt.instruction,
      prompt.outputFormat
    );
    const res = await this.inner.complete(prompt);
    if (res.content) {
      this.counters.outputTokens += estimateTokens(res.content);
    }
    return res;
  }
}

/** preflight 提示注入：只把提示文本拼进 AI 的 system 约束，不执行任何断言（P1） */
class PreflightHintAdapter implements AIAdapter {
  name: string;
  private inner: AIAdapter;
  private hints: string[];

  constructor(inner: AIAdapter, hints: string[]) {
    this.inner = inner;
    this.hints = hints;
    this.name = `hinted-${inner.name}`;
  }

  get modelName(): string {
    return (this.inner as { modelName?: string }).modelName ?? this.inner.name;
  }

  async complete(prompt: AIPrompt): Promise<AIResponse> {
    if (this.hints.length === 0) return this.inner.complete(prompt);
    const hintBlock = [
      '',
      '[子任务预检提示（仅提示，不在 loop 内执行；权威 acceptance 由 protocol-runner 在子任务边界执行）]',
      ...this.hints.map((h) => `- ${h}`),
    ].join('\n');
    return this.inner.complete({
      ...prompt,
      system: `${prompt.system}${hintBlock}`,
    });
  }
}

function renderPreflightHints(
  assertions: ExecTaskPreflightHint[] | undefined
): string[] {
  return (assertions ?? []).map((a) => {
    if (a.kind === 'command' && a.command) {
      return `command: ${a.command}${a.description ? `（${a.description}）` : ''}`;
    }
    if (a.kind === 'file' && a.path) {
      return `file ${a.path}${a.description ? `（${a.description}）` : ''}`;
    }
    return a.description ?? JSON.stringify(a);
  });
}

interface StepAdapters {
  semantic?: AIAdapter;
  reasoning?: AIAdapter;
  generation?: AIAdapter;
}

/** 步骤 → 角色映射（与 registerStepExecutors 的接线一一对应，供模型名观测） */
function roleForStep(stepId: StepId): AIRole | undefined {
  switch (stepId) {
    case 'check':
      return 'semantic';
    case 'reason':
    case 'formalize':
    case 'derive-contracts':
      return 'reasoning';
    case 'generate-tests':
    case 'generate-cases':
      return 'generation';
    default:
      return undefined;
  }
}

function adapterModelName(adapter: AIAdapter | undefined): string | undefined {
  if (!adapter) return undefined;
  return (adapter as { modelName?: string }).modelName ?? adapter.name;
}

function registerStepExecutors(
  adapters: StepAdapters,
  config: ProtochainConfig,
  protocolId?: string,
  envName?: string
): void {
  registerExecutor('check', createCheckExecutor(adapters.semantic));
  registerExecutor('reason', createReasonExecutor(adapters.reasoning));
  registerExecutor('formalize', createFormalizeExecutor(adapters.reasoning, config));
  registerExecutor('derive-specs', createSpecifyExecutor());
  registerExecutor('derive-contracts', createContractExecutor(adapters.reasoning));
  registerExecutor('generate-tests', createTestGenExecutor(adapters.generation, config));
  registerExecutor('generate-cases', createCaseGenExecutor(config, adapters.generation));
  registerExecutor('check-impl', createImplCheckExecutor());
  registerExecutor('verify', createVerifyExecutor(adapters.semantic, config, protocolId, envName));
}

function buildDefaultAdapterFor(
  config: ProtochainConfig
): (role: AIRole) => AIAdapter | undefined {
  let router: ReturnType<typeof createAIRouter> | null = null;
  try {
    if (config.ai) router = createAIRouter(config.ai);
  } catch {
    router = null;
  }
  return (role: AIRole) => {
    try {
      return router ? router.get(role) : undefined;
    } catch {
      return undefined;
    }
  };
}

/** 生效配置：任务预算覆盖 config.ai.loop */
function effectiveConfig(
  config: ProtochainConfig,
  budget: ExecTaskBudget | undefined
): ProtochainConfig {
  if (!budget || !config.ai?.loop) return config;
  const hasOverrides = Object.values(budget).some((v) => v !== undefined);
  if (!hasOverrides) return config;
  return {
    ...config,
    ai: config.ai
      ? { ...config.ai, loop: { ...config.ai.loop, ...budget } }
      : config.ai,
  };
}

/**
 * 生成类步骤的隐式前置（specs/contracts）固定走确定性路径：
 * 子任务模式下 AI 只用于请求步骤自身的生成 loop，不为隐式重推导消耗预算。
 * 返回本次写出的产物相对路径（并入 effects/artifacts）。
 */
async function seedDeterministicDerivation(
  model: SourceProtocolModel,
  artifacts: DerivedArtifacts,
  projectDir: string
): Promise<string[]> {
  const written: string[] = [];
  if (!artifacts.specs) {
    artifacts.specs = specsFromEnvelope(specify(model, { degradedAIAssist: true }));
    written.push(relative(projectDir, writeReport(projectDir, 'derived/specs.json', artifacts.specs)));
  }
  if (!artifacts.contracts) {
    const result = await deriveContracts(model, artifacts.specs, undefined, {
      useAIForInvariantRelevance: false,
      degradedAIAssist: true,
    });
    artifacts.contracts = result.contracts;
    written.push(relative(projectDir, writeReport(projectDir, 'derived/contracts.json', artifacts.contracts)));
  }
  return written.map((p) => p.split('\\').join('/'));
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 执行子任务。
 *
 * 不抛出任务级异常：输入非法 / 步骤失败 / 内部异常统一折叠为 failed 结果，
 * 保证调用方（CLI / protocol-runner driver / 测试）总能拿到结构化 result。
 */
export async function executeTask(
  input: ExecTaskInput,
  deps: ExecTaskDeps = {}
): Promise<ExecTaskResult> {
  const startedAt = new Date().toISOString();
  const systemRoot = resolve(deps.projectDir ?? process.cwd());
  const finishedAt = (): string => new Date().toISOString();

  const failed = (reason: string): ExecTaskResult => ({
    taskId: input?.taskId ?? 'unknown',
    status: 'failed',
    summary: `子任务失败：${reason}`,
    reason,
    artifacts: [],
    stepResults: [],
    facts: [],
    effects: [],
    openItems: [],
    cost: {
      modelCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      wallClockMs: 0,
    },
    preflight: { provided: 0, executed: 0 },
    startedAt,
    finishedAt: finishedAt(),
  });

  const validationError = validateInput(input);
  if (validationError) return failed(validationError);

  const wallStart = Date.now();
  const facts: ExecTaskFact[] = [];
  const effects: ExecTaskEffect[] = [];
  const openItems: ExecTaskOpenItem[] = [];
  const stepResults: ExecTaskStepResult[] = [];
  const totalCounters = emptyCounters();
  let totalCorrections = 0;

  try {
    // 多协议定位：protocolId 存在时解析到 protocol/<Pn>，derived 落协议根
    const projectDir = input.protocolId
      ? resolveProjectContext(systemRoot, { protocol: input.protocolId }).protocolRoot
      : systemRoot;
    const config = loadConfig(systemRoot);
    const effective = effectiveConfig(config, input.context?.budget);
    const defaultModelPath = input.protocolId ? 'model.md' : 'protocol/model.md';
    const modelPath = resolve(projectDir, input.context?.modelPath ?? defaultModelPath);
    if (!existsSync(modelPath)) {
      return failed(`协议模型不存在：${modelPath}`);
    }
    const model = parseProtocolFile(modelPath);

    // 上下文切片（P1：只记录/校验存在性，不越权消费）
    const inputContract = input.context?.inputContract ?? [];
    for (const deliverable of inputContract) {
      const abs = resolve(projectDir, deliverable);
      facts.push({
        subject: 'input-contract',
        kind: existsSync(abs) ? 'observation' : 'constraint',
        detail: `${deliverable}${existsSync(abs) ? ' 存在' : ' 缺失（子任务不阻断，权威由 protocol-runner 判定）'}`,
      });
    }

    const useAI = input.useAI === true && !!effective.ai;
    const adapterFor = deps.adapterFor ?? buildDefaultAdapterFor(effective);
    const preflightHints = renderPreflightHints(input.context?.preflightAssertions);
    if (preflightHints.length > 0) {
      facts.push({
        subject: 'preflight',
        kind: 'constraint',
        detail: `收到 ${preflightHints.length} 条 preflight 提示；子任务模式只注入提示，不在 loop 内执行（executed=0，权威 acceptance 在 protocol-runner 边界）`,
      });
    }

    const steps = planSteps(
      input.steps,
      deps.includeDeterministicPrerequisites ?? false
    );
    const artifacts: DerivedArtifacts = {};
    let allPassed = true;
    const persistedSteps: Partial<Record<StepId, StepExecutionResult>> = {};
    const persistedCheckpoints: OrchestratorState['checkpoints'] = {};

    for (const stepId of steps) {
      // AI-only 步骤：无适配器时显式跳过（记录事实，不伪造通过）
      if (AI_REQUIRED_STEPS.has(stepId) && (!useAI || !adapterFor('reasoning'))) {
        facts.push({
          subject: stepId,
          kind: 'assumption',
          detail:
            useAI && !adapterFor('reasoning')
              ? '适配器不可用，跳过 AI-only 前置步骤'
              : '子任务未启用 AI，跳过 AI-only 前置步骤（reason/formalize 的确定性预判由上游或人工把关）',
        });
        stepResults.push({
          stepId,
          status: 'skipped',
          passed: false,
          outputs: [],
          aiCalls: 0,
          corrections: 0,
        });
        continue;
      }

      // 生成类步骤的隐式前置推导保持确定性（AI 只进请求步骤自身的 loop）
      if (stepId === 'generate-tests' || stepId === 'generate-cases') {
        const seeded = await seedDeterministicDerivation(model, artifacts, projectDir);
        for (const path of seeded) {
          if (!effects.some((e) => e.path === path)) {
            effects.push({ path, op: 'create', note: '生成类步骤的确定性隐式前置（specs/contracts）' });
          }
        }
      }

      // 每步独立计数适配器：成本归属到步骤（跨调用不残留）
      const stepCounters = emptyCounters();
      const stepAdapters: StepAdapters = {
        semantic: useAI ? adapterFor('semantic') : undefined,
        reasoning: useAI ? adapterFor('reasoning') : undefined,
        generation: useAI ? adapterFor('generation') : undefined,
      };
      const stepRole = roleForStep(stepId);
      const wrap = (adapter: AIAdapter | undefined): AIAdapter | undefined =>
        adapter
          ? new CountingAdapter(new PreflightHintAdapter(adapter, preflightHints), stepCounters)
          : undefined;

      registerStepExecutors(
        {
          semantic: wrap(stepAdapters.semantic),
          reasoning: wrap(stepAdapters.reasoning),
          generation: wrap(stepAdapters.generation),
        },
        effective
      );

      const executor = getExecutor(stepId);
      if (!executor) {
        allPassed = false;
        stepResults.push({
          stepId,
          status: 'failed',
          passed: false,
          outputs: [],
          error: `步骤 ${stepId} 执行器未注册`,
          aiCalls: stepCounters.modelCalls,
          corrections: 0,
        });
        break;
      }

      const result = await executor.execute({
        model,
        rootDir: projectDir,
        artifacts,
        protocolId: undefined,
      });
      const outputs = (result.outputs ?? []).map((p) => relative(projectDir, p));
      const corrections =
        stepCounters.modelCalls === 0
          ? 0
          : Math.max(0, stepCounters.modelCalls - (result.passed ? 1 : 0));
      totalCorrections += corrections;

      for (const out of outputs) {
        const normalized = out.split('\\').join('/');
        if (!effects.some((e) => e.path === normalized)) {
          effects.push({ path: normalized, op: 'create', note: 'protochain 子任务产物（重跑覆盖）' });
        }
      }

      facts.push({
        subject: stepId,
        kind: result.passed ? 'observation' : 'risk',
        detail:
          result.passed
            ? `执行成功：${outputs.length} 件产物${stepCounters.modelCalls > 0 ? `，AI 调用 ${stepCounters.modelCalls} 次，修正 ${corrections} 轮` : '（确定性路径，无 AI）'}`
            : `执行失败：${result.error ?? '未知错误'}`,
      });

      // persist-state：记录步骤结果；检查点自动批准（非交互子任务语义）
      persistedSteps[stepId] = {
        stepId,
        passed: result.passed,
        outputs: result.outputs ?? [],
        executedAt: result.executedAt,
        ...(result.error ? { error: result.error } : {}),
      };
      const stepNode = getStep(stepId);
      if (stepNode.hasCheckpoint) {
        persistedCheckpoints[stepId] = {
          stepId,
          status: 'skipped',
          note: 'exec-task 子任务模式自动跳过检查点（权威 acceptance 在 protocol-runner 边界）',
          decidedAt: new Date().toISOString(),
        };
      }

      if (result.passed && stepId === 'generate-cases' && artifacts.testCases) {
        for (const u of artifacts.testCases.coverage.uncoveredDispositions ?? []) {
          openItems.push({
            id: `${u.elementType}:${u.elementId}`,
            kind: 'unresolved-question',
            summary: u.reason,
            confidence: 0.5,
          });
        }
      }

      stepResults.push({
        stepId,
        status: result.passed ? 'completed' : 'failed',
        passed: result.passed,
        outputs,
        summary: result.reportSummary,
        error: result.error,
        aiCalls: stepCounters.modelCalls,
        corrections,
        aiModel: stepRole ? adapterModelName(stepAdapters[stepRole]) : undefined,
      });

      Object.assign(totalCounters, {
        modelCalls: totalCounters.modelCalls + stepCounters.modelCalls,
        inputTokens: totalCounters.inputTokens + stepCounters.inputTokens,
        outputTokens: totalCounters.outputTokens + stepCounters.outputTokens,
        toolCalls: totalCounters.toolCalls + stepCounters.toolCalls,
      });

      if (!result.passed) {
        allPassed = false;
        break;
      }
    }

    const wallClockMs = Date.now() - wallStart;
    const executed = stepResults.filter((s) => s.status === 'completed');
    const skipped = stepResults.filter((s) => s.status === 'skipped');
    const failedSteps = stepResults.filter((s) => s.status === 'failed');
    const firstFailure = failedSteps[0];

    if (deps.persistState === true && allPassed) {
      const state: OrchestratorState = {
        steps: persistedSteps,
        checkpoints: persistedCheckpoints,
        updatedAt: new Date().toISOString(),
      };
      saveState(projectDir, state);
      facts.push({
        subject: 'orchestrator-state',
        kind: 'observation',
        detail: `已持久化 orchestrator-state.yaml（${Object.keys(persistedSteps).length} 个步骤记录）`,
      });
    }

    facts.push({
      subject: 'subtask-boundary',
      kind: 'constraint',
      detail:
        '本子任务不执行权威 acceptance；产物采信由 protocol-runner 在子任务边界通过机械 acceptance 判定',
    });

    const cost: ExecTaskCost = {
      ...totalCounters,
      wallClockMs,
      loop:
        totalCounters.modelCalls > 0
          ? { iterations: totalCounters.modelCalls, corrections: totalCorrections }
          : undefined,
    };
    const aiModelByRole: Record<AIRole, string | undefined> | undefined = useAI
      ? {
          semantic: adapterModelName(adapterFor('semantic')),
          reasoning: adapterModelName(adapterFor('reasoning')),
          generation: adapterModelName(adapterFor('generation')),
        }
      : undefined;

    if (allPassed) {
      return {
        taskId: input.taskId,
        status: 'completed',
        summary: `子任务完成：${executed.length} 步成功${skipped.length > 0 ? ` / ${skipped.length} 步跳过（AI-only）` : ''}；产物 ${effects.length} 件；AI 调用 ${totalCounters.modelCalls} 次${totalCorrections > 0 ? `，修正 ${totalCorrections} 轮` : ''}。权威 acceptance 由 protocol-runner 在子任务边界执行。`,
        artifacts: effects.map((e) => e.path),
        stepResults,
        facts,
        effects,
        openItems,
        cost,
        aiModelByRole,
        preflight: { provided: preflightHints.length, executed: 0 },
        startedAt,
        finishedAt: finishedAt(),
      };
    }

    return {
      taskId: input.taskId,
      status: 'failed',
      summary: `子任务失败：${firstFailure?.error ?? '步骤未通过'}`,
      reason: firstFailure?.error ?? '步骤未通过',
      artifacts: [],
      partialArtifacts: effects.map((e) => e.path),
      stepResults,
      facts,
      effects,
      openItems,
      cost,
      aiModelByRole,
      preflight: { provided: preflightHints.length, executed: 0 },
      startedAt,
      finishedAt: finishedAt(),
    };
  } catch (err) {
    return failed(`子任务执行异常：${err instanceof Error ? err.message : String(err)}`);
  }
}
