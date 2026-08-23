/**
 * 一致性验证器 —— 步骤⑩（代码确定性执行 + 可选 AI 辅助摘要）
 *
 * 设计依据：《协议驱动自验证工具链设计方案》verifier 模块、AI参与矩阵
 *
 * 职责：
 * 1. 加载 ⑦ 生成的测试用例（TestCaseSet）
 * 2. 加载 ⑥ 生成的测试工具代码（TestToolCode）
 * 3. 加载开发者实现（⑨产出，由开发者提供 ProtocolImplementation）
 * 4. 运行协议路径用例，收集执行结果
 * 5. 生成权威层 VerificationReport（结构化 JSON）
 * 6. 可选：AI 生成辅助层自然语言摘要（非权威）
 *
 * 报告格式分两层：
 * - 权威层（代码生成）：每个用例的通过/失败/跳过、偏差详情、计数
 * - 辅助层（AI 可选）：自然语言摘要，不作为自动化输入
 *
 * 退化策略：
 * - 若测试工具代码不可用（未生成），则跳过所有用例并标注原因
 * - 若实现未提供，则跳过所有用例并提示需开发者完成 ⑨
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SourceProtocolModel,
  TestCaseSet,
  ProtocolPath,
  VerificationReport,
  AuthoritativeVerification,
  CaseResult,
  Deviation,
  AuxiliarySummary,
  AIAdapter,
  CrossTestCaseSet,
  CompositionModel,
  InvariantDef,
  InterfaceSpec,
  BindingConfig,
  ResolvedBinding,
  TestToolRunReport,
  ByDesignNotTestedItem,
  ErrorSummary,
} from '../model/types.js';
import { parseAIJson } from '../ai/adapter.js';
import { resolveBindings, filterInterfaces } from '../binder/index.js';
import {
  runBindingPathCase,
  type TransportExecutorFn,
  type ScenarioParamSource,
} from './binding-runner.js';

export interface VerifyOptions {
  /** 是否启用 AI 辅助摘要 */
  useAISummary?: boolean;
}

export interface VerifyContext {
  /** 项目根目录 */
  rootDir: string;
  /** 测试用例集（⑦产出，若未提供则从 derived/test-cases.json 读取） */
  testCases?: TestCaseSet;
  /** 开发者实现（⑨产出；若未提供则所有用例跳过） */
  implementation?: ProtocolImplementationStub;
  /** 接口规格（⑤产出；绑定驱动验证时需要，未提供时尝试从 derived/specs.json 读取） */
  specs?: InterfaceSpec[];
  /** 接口绑定配置（protochain.config.yaml 的 bindings 段） */
  bindings?: BindingConfig;
  /** 多协议项目中的子协议 ID（如 P3）；按 protocol 字段过滤 bindings */
  protocolId?: string;
  /** 传输执行器（默认 executeTransport；测试可注入 mock） */
  transportExecutor?: TransportExecutorFn;
  /** poll 模式轮询超时（ms，默认 10000） */
  pollTimeoutMs?: number;
  /** poll 模式轮询间隔（ms，默认 200） */
  pollIntervalMs?: number;
  /** 场景参数源（protocol/scenarios/*.yaml 加载，按路径动作序列匹配） */
  scenarios?: ScenarioParamSource[];
  /** 跨协议测试用例集（⑦-C 产出） */
  crossTestCases?: CrossTestCaseSet;
  /** 组合层模型（用于跨协议验证） */
  compositionModel?: CompositionModel;
  /** test-tool 消费报告（阶段 A/B：由生成测试工具执行的用例结果，作为权威层来源） */
  testToolRun?: TestToolRunReport;
  // ── E2 ──
  /** 协议侧（legacy）期望响应字段值，按 action 索引；用于字段级偏差对比 */
  legacyExpectedResponses?: Record<string, Record<string, unknown>>;
  /** 显式启用 E2 字段级对比；默认 false（保持原行为），新格式 specs.json 通过 derive-specs 触发后由 CLI 设为 true */
  enableFieldLevelCompare?: boolean;
  // ── E4 ──
  /**
   * E4：跳过 SQL 校验路径（--skip-sql-check）。true 时 verify 不连 storage，
   * 但报告仍写明"已跳过"，归入 `by-design-not-tested-by-toolchain` 段的项
   * 仍然可见（不静默）。
   */
  skipSqlCheck?: boolean;
  /**
   * E4：注入的 SQL 校验结果（CLI 层读 env 组装 SqlCheckConfig 后调用 sqlcheck
   * 引擎，verifier 仅消费其结果；便于单测时直接传 mock）。
   */
  sqlInvariantCheck?: import('../model/types.js').SqlInvariantCheckReport;
  /**
   * E6：mock 模式标记。true 时 verifier 跳过真实 impl 调用，但要求
   *   - testCases 来自 derived/test-cases.json；
   *   - 实现对象由 mock runner 提供（test-tool mock + spy）；
   *   - 通过 deterministic 路径校验"模型层契约一致性"。
   * 两次连续 verify 报告 sha256 应一致。
   */
  mockMode?: boolean;
}

/**
 * 开发者实现的协议接口（stub——实际类型由 ⑥ 生成的 protocol-executor.ts 定义）
 *
 * 注：verifier 不直接执行 TypeScript 代码（避免动态编译复杂性），
 * 而是通过约定接口调用开发者提供的实现对象。
 */
export interface ProtocolImplementationStub {
  /** 按 action 名索引的实现函数 */
  [action: string]: (currentState: string, ...args: unknown[]) =>
    Promise<{ nextState: string; effects?: string[] }>;
}

/**
 * 执行一致性验证
 */
export async function verify(
  model: SourceProtocolModel,
  ctx: VerifyContext,
  aiAdapter?: AIAdapter,
  options: VerifyOptions = {}
): Promise<VerificationReport> {
  const verifiedAt = new Date().toISOString();

  // 1. 加载测试用例
  const testCases = ctx.testCases ?? loadTestCases(ctx.rootDir);
  if (!testCases) {
    return {
      authoritative: {
        passed: false,
        counts: { passed: 0, failed: 0, skipped: 0 },
        caseResults: [],
      },
      verifiedAt,
    };
  }

  // E11：错误计数累加器（多个 runBindingPathCase 调用共享 → 聚合到单一 ErrorSummary）
  const errorSummary: ErrorSummary | undefined = ctx.bindings?.errorMap
    ? {
        matched: {},
        unmapped: [],
        systemFault: 0,
        expected: {},
      }
    : undefined;

  // 2. 执行单协议测试用例（test-tool 消费优先；绑定模式次之；stub 模式兜底）
  const authoritative = ctx.testToolRun
    ? authoritativeFromTestTool(ctx.testToolRun)
    : ctx.bindings
      ? await runTestCasesBinding(
          model,
          testCases,
          ctx.specs ?? loadSpecs(ctx.rootDir),
          ctx.bindings,
          ctx.protocolId,
          ctx.transportExecutor,
          {
            pollTimeoutMs: ctx.pollTimeoutMs,
            pollIntervalMs: ctx.pollIntervalMs,
            scenarios: ctx.scenarios,
            legacyExpectedResponses: ctx.legacyExpectedResponses,
            enableFieldLevelCompare: ctx.enableFieldLevelCompare === true,
            // E11：错误判定上下文（errorMap + 共享累加器）
            errorMap: ctx.bindings.errorMap,
            errorSummary,
          }
        )
      : await runTestCases(model, testCases, ctx.implementation);

  // 3. 跨协议用例验证（如有）
  if (ctx.crossTestCases) {
    const crossResults = await runCrossProtocolCases(
      ctx.crossTestCases,
      model,
      ctx.compositionModel,
      ctx.implementation
    );
    authoritative.caseResults.push(...crossResults);
    for (const r of crossResults) {
      if (r.skipped) {
        authoritative.counts.skipped++;
      } else if (r.passed) {
        authoritative.counts.passed++;
      } else {
        authoritative.counts.failed++;
      }
    }
  }

  // 4. 消极保证验证（从模型不变量推导验证条目）
  if (model.derivable.invariants.length > 0) {
    const negativeAssuranceResults = runNegativeAssuranceChecks(
      model.derivable.invariants
    );
    authoritative.caseResults.push(...negativeAssuranceResults);
    for (const r of negativeAssuranceResults) {
      if (r.skipped) {
        authoritative.counts.skipped++;
      } else if (r.passed) {
        authoritative.counts.passed++;
      } else {
        authoritative.counts.failed++;
      }
    }
  }

  // 5. 重新计算总体通过状态
  authoritative.passed = authoritative.counts.failed === 0;

  // 5b. E4：数据级不变量 SQL 校验段 + by-design 段（不参与 authoritative.passed；
  //     报告中显式列出，不静默）
  const sqlInvariantCheck = ctx.sqlInvariantCheck;
  const byDesignNotTestedByToolchain = collectByDesignItems(model);

  // 6. 可选 AI 摘要
  let auxiliary: AuxiliarySummary | undefined;
  if (options.useAISummary && aiAdapter) {
    auxiliary = await generateAISummary(authoritative, aiAdapter);
  }

  return {
    authoritative,
    auxiliary,
    sqlInvariantCheck,
    byDesignNotTestedByToolchain,
    // E11：仅当 errorMap 生效时挂 errorSummary（兼容老协议）
    errorSummary: errorSummary && (
      Object.keys(errorSummary.matched).length > 0 ||
      errorSummary.unmapped.length > 0 ||
      errorSummary.systemFault > 0
    ) ? errorSummary : undefined,
    verifiedAt,
  };
}

// ============================================================================
// test-tool 权威层（阶段 A/B：生成测试工具执行结果 → AuthoritativeVerification）
// ============================================================================

function authoritativeFromTestTool(run: TestToolRunReport): AuthoritativeVerification {
  const caseResults: CaseResult[] = run.caseResults.map((c) => ({
    pathId: c.pathId,
    passed: c.passed,
    ...(c.error
      ? {
          deviations: [
            {
              action: c.pathId,
              state: 'path',
              expected: 'test-tool 执行通过',
              actual: c.error,
              kind: 'state_mismatch' as const,
            },
          ],
        }
      : {}),
  }));
  return {
    passed: run.failedCases === 0 && run.executedCases > 0,
    counts: { passed: run.passedCases, failed: run.failedCases, skipped: 0 },
    caseResults,
    testTool: {
      consumed: true,
      executedCases: run.executedCases,
      passedCases: run.passedCases,
      failedCases: run.failedCases,
      toolFiles: run.toolFiles,
      generatedAt: run.generatedAt,
    },
  };
}

/** 由 test-tool 消费报告组装完整 VerificationReport（供 CLI test-tool run 落盘） */
export function buildVerificationReportFromTestTool(
  run: TestToolRunReport,
  verifiedAt: string = new Date().toISOString(),
): VerificationReport {
  return {
    authoritative: authoritativeFromTestTool(run),
    verifiedAt,
  };
}

// ============================================================================
// 测试用例加载
// ============================================================================

function loadTestCases(rootDir: string): TestCaseSet | undefined {
  const path = join(rootDir, 'derived/test-cases.json');
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as TestCaseSet;
  } catch {
    return undefined;
  }
}

function loadSpecs(rootDir: string): InterfaceSpec[] | undefined {
  // E2-I1 修复：走公共 helper（自动解 Envelope + 兼容裸数组迁移）
  const { loadSpecsEnvelope } = require('../specifier/load.js') as typeof import('../specifier/load.js');
  try {
    return loadSpecsEnvelope(rootDir)?.specs;
  } catch (err) {
    console.warn(`[verifier.loadSpecs] specs.json 解析失败：${err instanceof Error ? err.message : err}`);
    return undefined;
  }
}

// ============================================================================
// 绑定模式测试用例执行
// ============================================================================

async function runTestCasesBinding(
  model: SourceProtocolModel,
  testCases: TestCaseSet,
  specs: InterfaceSpec[] | undefined,
  bindings: BindingConfig,
  protocolId: string | undefined,
  transportExecutor?: TransportExecutorFn,
  options: {
    pollTimeoutMs?: number;
    pollIntervalMs?: number;
    scenarios?: ScenarioParamSource[];
    // ── E2 字段级偏差对比 ──
    legacyExpectedResponses?: Record<string, Record<string, unknown>>;
    enableFieldLevelCompare?: boolean;
    // ── E11 错误判定 ──
    errorMap?: Record<string, import('../model/types.js').ErrorMapEntry>;
    errorSummary?: ErrorSummary;
  } = {}
): Promise<AuthoritativeVerification> {
  // 规格缺失时无法解析绑定：如实走"接口未绑定"偏差，而不是静默跳过
  const resolved: ResolvedBinding[] = specs
    ? resolveBindings(specs, bindings, protocolId)
    : [];
  // setup 动作绑定：不经 specs，直接从 bindings.interfaces 解析（如 purge_user 等测试清理接口）
  const setupBindings = buildSetupBindings(bindings, protocolId);

  const derivable = model.derivable;
  const transitionsById = new Map(derivable.transitions.map((t) => [t.id, t]));
  const initialStateId = derivable.initialStateId ??
    derivable.states.find((s) => s.type === 'initial')?.id;
  const stateNames = new Map(
    derivable.states.map((s) => [s.id, s.name])
  );

  const caseResults: CaseResult[] = [];
  let passedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  for (const path of testCases.paths) {
    const result = await runBindingPathCase(
      path,
      transitionsById,
      initialStateId,
      resolved,
      stateNames,
      transportExecutor,
      {
        pollTimeoutMs: options.pollTimeoutMs,
        pollIntervalMs: options.pollIntervalMs,
        stateMap: bindings.stateMap,
        scenarios: options.scenarios,
        setupBindings,
        // ── E2 字段级偏差对比 ──
        legacyExpectedResponses: options.legacyExpectedResponses,
        enableFieldLevelCompare: options.enableFieldLevelCompare === true,
        // ── E11 错误判定 ──
        errorMap: options.errorMap,
        errorSummary: options.errorSummary,
      }
    );
    caseResults.push(result);

    if (result.skipped) {
      skippedCount++;
    } else if (result.passed) {
      passedCount++;
    } else {
      failedCount++;
    }
  }

  // 汇总参数注入告警（CaseResult.warnings，来自 binding-runner #14 内核修复）：
  // 与场景命中告警合并，随权威报告输出，供人工复核而非阻断。
  const paramWarnings = caseResults.flatMap((c) => (c.warnings ?? []).map((w) => `[${c.pathId}] ${w}`));

  return {
    passed: failedCount === 0 && skippedCount === 0,
    counts: { passed: passedCount, failed: failedCount, skipped: skippedCount },
    caseResults,
    scenarioWarnings: [
      ...(collectScenarioWarnings(caseResults, options.scenarios) ?? []),
      ...paramWarnings,
    ],
  };
}

/**
 * 汇总场景命中告警：
 * - 声明了场景但无任何路径命中 → 强告警（场景写错会被静默回退响应注入掩盖）
 * - 部分场景未命中 → 次级告警
 * 未声明场景返回 undefined。
 */
function collectScenarioWarnings(
  caseResults: CaseResult[],
  scenarios: ScenarioParamSource[] | undefined
): string[] | undefined {
  if (!scenarios || scenarios.length === 0) return undefined;
  const matchedIds = new Set(
    caseResults
      .map((c) => c.scenarioMatch?.id)
      .filter((id): id is string => Boolean(id))
  );
  if (matchedIds.size === 0) {
    const ids = scenarios.map((s) => s.id).join(', ');
    return [
      `声明了 ${scenarios.length} 个场景（${ids}），但没有任何测试路径命中；verify 已静默回退到响应注入兜底，请检查 expectedActions 与路径动作序列是否一致`,
    ];
  }
  const unmatched = scenarios.filter((s) => !matchedIds.has(s.id));
  if (unmatched.length > 0) {
    return [`场景未全部命中：${unmatched.map((s) => s.id).join(', ')} 未匹配任何路径`];
  }
  return undefined;
}

/**
 * 构建 setup 动作绑定索引。
 * setup 动作（如 purge_user）不在 ⑤ specs 中，需直接从 bindings.interfaces 解析
 * （按 protocol 过滤 + 未打标兜底，规则与 binder.filterInterfaces 一致）；
 * spec 为合成的系统接口（name=action），仅用于传输执行器的分发与判定。
 */
function buildSetupBindings(
  bindings: BindingConfig,
  protocolId?: string
): Map<string, ResolvedBinding> {
  const map = new Map<string, ResolvedBinding>();
  const filtered = filterInterfaces(bindings.interfaces ?? [], protocolId);
  for (const b of filtered) {
    const roleBinding = bindings.roles?.[b.roleId];
    const spec: InterfaceSpec = {
      id: `setup-${b.action}`,
      kind: 'system',
      sourceId: b.action,
      name: b.action,
      inputs: [],
      outputs: [],
    };
    map.set(b.action, { spec, binding: b, roleBinding });
  }
  return map;
}

async function runTestCases(
  model: SourceProtocolModel,
  testCases: TestCaseSet,
  implementation?: ProtocolImplementationStub
): Promise<AuthoritativeVerification> {
  const derivable = model.derivable;
  const transitionsById = new Map(derivable.transitions.map((t) => [t.id, t]));
  const initialStateId = derivable.initialStateId ??
    derivable.states.find((s) => s.type === 'initial')?.id;

  const caseResults: CaseResult[] = [];
  let passedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  for (const path of testCases.paths) {
    const result = await runPathCase(path, transitionsById, initialStateId, implementation);
    caseResults.push(result);

    if (result.skipped) {
      skippedCount++;
    } else if (result.passed) {
      passedCount++;
    } else {
      failedCount++;
    }
  }

  return {
    passed: failedCount === 0 && skippedCount === 0,
    counts: { passed: passedCount, failed: failedCount, skipped: skippedCount },
    caseResults,
  };
}

async function runPathCase(
  path: ProtocolPath,
  transitionsById: Map<string, import('../model/types.js').TransitionDef>,
  initialStateId: string | undefined,
  implementation?: ProtocolImplementationStub
): Promise<CaseResult> {
  // 无实现：跳过
  if (!implementation) {
    return {
      pathId: path.id,
      passed: false,
      skipped: true,
    };
  }

  // 无初始状态：跳过
  if (!initialStateId) {
    return {
      pathId: path.id,
      passed: false,
      skipped: true,
    };
  }

  let currentState = initialStateId;
  const deviations: Deviation[] = [];

  for (const tid of path.transitionIds) {
    const t = transitionsById.get(tid);
    if (!t) {
      deviations.push({
        action: tid,
        state: currentState,
        expected: `转移 ${tid} 存在`,
        actual: '转移未定义',
        kind: 'missing_action',
      });
      break;
    }

    // 校验当前状态与转移源一致
    if (!t.from.includes(currentState)) {
      deviations.push({
        action: t.action,
        state: currentState,
        expected: t.from.join('/'),
        actual: currentState,
        kind: 'state_mismatch',
      });
      break;
    }

    // 调用实现
    const impl = implementation[t.action];
    if (!impl) {
      deviations.push({
        action: t.action,
        state: currentState,
        expected: `实现提供 ${t.action}`,
        actual: '实现缺失',
        kind: 'missing_action',
      });
      break;
    }

    try {
      const result = await impl(currentState);
      if (result.nextState !== t.to) {
        deviations.push({
          action: t.action,
          state: currentState,
          expected: t.to,
          actual: result.nextState,
          kind: 'state_mismatch',
        });
        break;
      }
      currentState = result.nextState;
    } catch (err) {
      deviations.push({
        action: t.action,
        state: currentState,
        expected: '实现执行成功',
        actual: err instanceof Error ? err.message : String(err),
        kind: 'state_mismatch',
      });
      break;
    }
  }

  return {
    pathId: path.id,
    passed: deviations.length === 0,
    deviations: deviations.length > 0 ? deviations : undefined,
  };
}

// ============================================================================
// 跨协议用例验证
// ============================================================================

async function runCrossProtocolCases(
  crossTestCases: CrossTestCaseSet,
  _model: SourceProtocolModel,
  _compositionModel?: CompositionModel,
  _implementation?: ProtocolImplementationStub
): Promise<CaseResult[]> {
  const results: CaseResult[] = [];

  for (const path of crossTestCases.paths) {
    // 跨协议路径验证：检查路径片段序列是否完整
    const segmentsCount = path.segments.length;
    const hasCheckpoints = path.crossInvariantCheckpoints.length > 0;

    // 当前暂不执行跨协议实现调用，仅做结构性检查
    // 完整执行需要组合层执行环境支持
    if (!_implementation) {
      results.push({
        pathId: path.id,
        passed: false,
        skipped: true,
      });
      continue;
    }

    const deviations: Deviation[] = [];

    // 检查路径是否有跨协议不变量检查点
    if (hasCheckpoints) {
      for (const cpId of path.crossInvariantCheckpoints) {
        // 验证跨协议不变量检查点是否在组合层模型中定义
        if (_compositionModel) {
          const invariantDef = _compositionModel.crossInvariants.find(
            (ci) => ci.id === cpId
          );
          if (!invariantDef) {
            deviations.push({
              action: `cross-invariant:${cpId}`,
              state: `segment-${segmentsCount}`,
              expected: `组合层定义了不变量 "${cpId}"`,
              actual: '组合层未找到该不变量定义',
              kind: 'missing_action',
            });
          }
        }
      }
    }

    results.push({
      pathId: path.id,
      passed: deviations.length === 0,
      deviations: deviations.length > 0 ? deviations : undefined,
    });
  }

  return results;
}

// ============================================================================
// 消极保证验证（从不变量推导）
// ============================================================================

function runNegativeAssuranceChecks(
  invariants: InvariantDef[]
): CaseResult[] {
  const results: CaseResult[] = [];

  for (const inv of invariants) {
    // 将每个不变量作为一条验证条目
    // 消极保证：验证不变量表达式是否可理解/可检查
    const hasExpression = Boolean(inv.expression && inv.expression.trim().length > 0);
    const hasScope = !inv.scopeStateIds || inv.scopeStateIds.length > 0;

    const deviations: Deviation[] = [];

    if (!hasExpression) {
      deviations.push({
        action: `invariant:${inv.id}`,
        state: 'global',
        expected: `不变量 "${inv.name}" 应有非空表达式`,
        actual: '不变量表达式为空',
        kind: 'missing_action',
      });
    }

    if (!hasScope) {
      deviations.push({
        action: `invariant:${inv.id}`,
        state: 'global',
        expected: `不变量 "${inv.name}" 应声明作用域`,
        actual: '未声明作用状态',
        kind: 'missing_action',
      });
    }

    results.push({
      pathId: `negative-assurance:${inv.id}`,
      passed: deviations.length === 0,
      deviations: deviations.length > 0 ? deviations : undefined,
    });
  }

  return results;
}

// ============================================================================
// AI 辅助摘要（非权威）
// ============================================================================

async function generateAISummary(
  authoritative: AuthoritativeVerification,
  aiAdapter: AIAdapter
): Promise<AuxiliarySummary | undefined> {
  const failedCases = authoritative.caseResults.filter((c) => !c.passed && !c.skipped);
  const skippedCases = authoritative.caseResults.filter((c) => c.skipped);

  const prompt = {
    system:
      '你是协议验证分析专家。给定结构化验证结果，生成简洁的自然语言摘要，帮助人快速理解偏差分布。' +
      '输出严格 JSON，不解释。',
    context: JSON.stringify({
      counts: authoritative.counts,
      scenarioWarnings: authoritative.scenarioWarnings,
      degradedCount: authoritative.caseResults.filter((c) => c.degraded).length,
      failedCases: failedCases.map((c) => ({
        pathId: c.pathId,
        scenarioMatch: c.scenarioMatch,
        degraded: c.degraded,
        deviations: c.deviations,
      })),
      skippedCount: skippedCases.length,
    }),
    instruction: [
      '请生成验证摘要：',
      '1. summary：一段话总结本次验证结果，包含通过/失败/跳过数量与主要偏差类型',
      '2. deviationCategories：偏差分类数组（如 ["状态不匹配", "实现缺失"]）',
      '若全部通过，summary 标注"验证通过"，deviationCategories 为空数组',
    ].join('\n'),
    outputFormat: [
      '返回 JSON：',
      '{ "summary": "...", "deviationCategories": ["...", "..."] }',
    ].join('\n'),
    temperature: 0.3,
  };

  const response = await aiAdapter.complete(prompt);
  if (!response.success) return undefined;

  try {
    return parseAIJson<AuxiliarySummary>(response.content);
  } catch {
    return undefined;
  }
}

// ============================================================================
// 报告摘要
// ============================================================================

export function formatVerificationSummary(report: VerificationReport): string {
  const a = report.authoritative;
  const lines: string[] = [
    `一致性验证：${a.passed ? '✓ 通过' : '✗ 未通过'}`,
    `  通过: ${a.counts.passed} / 失败: ${a.counts.failed} / 跳过: ${a.counts.skipped}`,
    `  总用例数: ${a.caseResults.length}`,
  ];

  const failed = a.caseResults.filter((c) => !c.passed && !c.skipped);
  if (failed.length > 0) {
    lines.push('  失败用例（前5个）：');
    for (const c of failed.slice(0, 5)) {
      const firstDev = c.deviations?.[0];
      // ── E2 字段级偏差更详细：含 field/legacy/impl 三元组 ──
      if (firstDev?.kind === 'field_mismatch' && firstDev.field) {
        lines.push(
          `    - ${c.pathId}: ${firstDev.kind} @ ${firstDev.action} 字段 ${firstDev.field}：legacy=${firstDev.legacy ?? ''}, impl=${firstDev.impl ?? ''}`
        );
      } else {
        lines.push(
          `    - ${c.pathId}: ${firstDev?.kind ?? '未知'} @ ${firstDev?.action ?? ''}（期望 ${firstDev?.expected ?? ''}，实际 ${firstDev?.actual ?? ''}）`
        );
      }
    }
    if (failed.length > 5) {
      lines.push(`    ... 还有 ${failed.length - 5} 个失败用例`);
    }
  }

  const skipped = a.caseResults.filter((c) => c.skipped);
  if (skipped.length > 0) {
    lines.push(`  跳过用例: ${skipped.length} 个（可能未提供实现或初始状态）`);
  }

  const degradedCases = a.caseResults.filter((c) => c.degraded);
  if (degradedCases.length > 0) {
    lines.push(`  降级通过: ${degradedCases.length} 个（无观测绑定，信任协议预期/响应 nextState，非独立验证）`);
  }

  if (a.scenarioWarnings && a.scenarioWarnings.length > 0) {
    lines.push('  场景告警:');
    for (const w of a.scenarioWarnings) {
      lines.push(`    - ${w}`);
    }
  }

  if (report.auxiliary) {
    lines.push('  AI 摘要（非权威）：');
    lines.push(`    ${report.auxiliary.summary}`);
    if (report.auxiliary.deviationCategories && report.auxiliary.deviationCategories.length > 0) {
      lines.push(`    偏差分类: ${report.auxiliary.deviationCategories.join(', ')}`);
    }
  }

  // ── E4：SQL 校验 + by-design 段（独立展示，不参与 passed/failed） ──
  if (report.sqlInvariantCheck) {
    const s = report.sqlInvariantCheck;
    if (s.ran) {
      const pass = s.items.filter((i) => i.passed).length;
      const fail = s.items.length - pass;
      lines.push(`  SQL 校验（E4）: ${s.connection ? `${s.connection.driver}@${s.connection.host}:${s.connection.port}/${s.connection.database}` : '(driver=?)'} 通过 ${pass} / 失败 ${fail}（共 ${s.items.length}）`);
      for (const it of s.items) {
        if (it.passed) {
          lines.push(`    ✓ ${it.invariantId}: ${truncateSql(it.sql)}`);
        } else {
          lines.push(`    ✗ ${it.invariantId}: ${it.failureReason ?? '未知'}（${truncateSql(it.sql)}）`);
        }
      }
    } else {
      lines.push(`  SQL 校验（E4）: 已跳过（${s.skippedReason ?? '未配置 storage'}）`);
    }
  }

  if (report.byDesignNotTestedByToolchain && report.byDesignNotTestedByToolchain.length > 0) {
    lines.push(`  by-design-not-tested-by-toolchain（${report.byDesignNotTestedByToolchain.length} 项）— 由 impl 守卫保证，工具链不可消除：`);
    for (const b of report.byDesignNotTestedByToolchain) {
      const loc = b.guardLocation ? ` @ ${b.guardLocation}` : '';
      lines.push(`    - ${b.invariantId}${loc}: ${b.reason}`);
    }
  }

  // ── E11：错误契约验证汇总 ──
  if (report.errorSummary) {
    const s = report.errorSummary;
    const matchedCount = Object.values(s.matched).reduce((a, b) => a + b, 0);
    lines.push(`  错误契约验证（E11）: matched=${matchedCount} unmapped=${s.unmapped.length} systemFault=${s.systemFault}`);
    for (const [code, count] of Object.entries(s.matched)) {
      const expected = s.expected?.[code] ?? 0;
      const expectedSuffix = expected > 0 ? `（expected=${expected}）` : '';
      lines.push(`    ✓ ${code}: ${count} 次${expectedSuffix}`);
    }
    for (const u of s.unmapped) {
      lines.push(
        `    ✗ unmapped: ${u.action}${u.protocolErrorCode ? ` code=${u.protocolErrorCode}` : ''} (status=${u.httpStatus})`
      );
    }
  }

  return lines.join('\n');
}

/** SQL 文本摘要（避免长 SELECT 占满日志） */
function truncateSql(sql: string): string {
  if (!sql) return '(无 SQL)';
  if (sql.length <= 80) return sql;
  return sql.slice(0, 77) + '...';
}

// ============================================================================
// E4：by-design 段收集
// ============================================================================

/**
 * 从 SourceProtocolModel 收集"由 impl 守卫保证、工具链不可消除"的不变量：
 * - level=data && source=guard → 显式 by-design
 * - level=data && source=storage 但缺 storageRef → 兜底 by-design（缺引用，
 *   工具链无法生成 SQL）
 * 描述末段 [guard:<loc>] 解析为 guardLocation；其余部分归入 reason。
 */
export function collectByDesignItems(model: SourceProtocolModel): ByDesignNotTestedItem[] {
  const out: ByDesignNotTestedItem[] = [];
  for (const inv of model.derivable.invariants) {
    if (inv.level !== 'data') continue;
    if (inv.source === 'guard') {
      const { reason, guardLocation } = splitGuardMarker(inv.description);
      out.push({
        invariantId: inv.id,
        expression: inv.expression,
        reason: reason || '由 impl 守卫保证（model.md 显式 source=guard）',
        guardLocation,
      });
      continue;
    }
    // source=storage 但缺 storageRef：兜底 by-design
    if (!inv.storageRef) {
      const { reason, guardLocation } = splitGuardMarker(inv.description);
      out.push({
        invariantId: inv.id,
        expression: inv.expression,
        reason: reason || 'level=data 且 source=storage 但缺 storageRef，工具链无法生成 SQL',
        guardLocation,
      });
    }
  }
  return out;
}

/** 把 description 末段 [guard:<loc>] 拆出，剩余文本作为 reason */
function splitGuardMarker(description: string | undefined): { reason: string; guardLocation?: string } {
  if (!description) return { reason: '' };
  const match = description.match(/\[guard:([^\]]+)\]\s*$/);
  if (!match) return { reason: description.trim() };
  const reason = description.slice(0, match.index).trim();
  return { reason, guardLocation: match[1].trim() };
}
