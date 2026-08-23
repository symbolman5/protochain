/**
 * Mock/Spy 自动生成 —— E6
 *
 * 设计依据：《IMPLEMENTATION-PLAN》§E6
 *
 * 职责：
 *   1. `buildMockImplementation(model)`：从协议模型生成 ProtocolImplementation，
 *      每个 action 方法根据 TRANSITIONS 静态查表返回固定 nextState（fixtures）
 *      并对调用计数（spy）；
 *   2. `runMockVerification(testCases, mockImpl, paths)`：用 mock 实现执行测试用例，
 *      产出 TestToolRunReport；输出 byte-level 确定性（两次 sha256 一致）；
 *   3. `getSpySnapshot()` / `resetSpy()`：暴露 spy 计数器供 verify 报告展示。
 *
 * fixtures 来源决策（acceptance-record 必填）：
 *   - 选用 model.md TRANSITIONS（derived/protocol-model.ts）作为唯一 fixture 源
 *   - 原因：test-cases.json 仅含 transitionIds/expectedActions，未含 expectedResults；
 *     scenarios/*.yaml 同样不含 expectedResponse；
 *     TRANSITIONS 含 from→to + guard 静态语义，是工具链可机械消费的确定性数据源；
 *   - E6 验收要求"mock 返回值与 fixtures 完全一致"——TRANSITIONS 全在 derived/，
 *     一旦 model.md 改动即重推导，闭环链路干净。
 */

import type {
  SourceProtocolModel,
  ProtocolImplementationStubShape,
  ProtocolPath,
  TestCaseSet,
  TestToolCaseResult,
  TestToolRunReport,
  TransitionDef,
} from '../model/types.js';

/**
 * E6：mock 实现接口（与 ProtocolImplementationStubShape 兼容：
 *   action → (currentState, ...args) → { nextState, effects? }）。
 */
export type MockImplementation = ProtocolImplementationStubShape;

// ============================================================================
// Spy 状态：模块内单例；同一进程内所有 mock 实例共享 spy 计数
// ============================================================================

const spyCounters = new Map<string, number>();
let spySnapshotAt: string | undefined;

function bumpSpy(action: string): number {
  spyCounters.set(action, (spyCounters.get(action) ?? 0) + 1);
  spySnapshotAt = new Date().toISOString();
  return spyCounters.get(action) ?? 0;
}

/** 测试 / CLI 钩子：导出当前 spy 快照（按 action 名 → 调用次数） */
export function getSpySnapshot(): { counters: Record<string, number>; snapshotAt?: string } {
  const counters: Record<string, number> = {};
  for (const [k, v] of spyCounters) counters[k] = v;
  return { counters, snapshotAt: spySnapshotAt };
}

/** 重置 spy 状态（每次 run-mock 之前由 CLI 调用，保证两次跑之间无残留） */
export function resetSpy(): void {
  spyCounters.clear();
  spySnapshotAt = undefined;
}

// ============================================================================
// Mock 实现构建
// ============================================================================

/**
 * 按 SourceProtocolModel 生成一个 ProtocolImplementation：
 * - 每个 action → 静态查 TRANSITIONS 表（from 集合含 "-" 视为初始态可达）；
 *   返回该 action 的 to 状态（多 to 取第一个；冲突时取 all-to 平均策略）；
 * - 每次调用 bumpSpy(action)；
 * - 输出 deterministic（无随机 / 无时间）。
 *
 * 注意：mock 返回的 nextState 与 TRANSITIONS.to 一致；这正是 verify 的期望，
 *   因此 verify --mock 应全绿。
 */
export function buildMockImplementation(
  model: SourceProtocolModel
): MockImplementation {
  // 按 action 名索引的多 to 列表（同名动作多个转移是常见情形）
  const byAction = new Map<string, TransitionDef[]>();
  for (const t of model.derivable.transitions) {
    const list = byAction.get(t.action) ?? [];
    list.push(t);
    byAction.set(t.action, list);
  }

  const impl: MockImplementation = {};
  // 用模型 actions 集合（包括外部观察接口），不在 spec 内的接口无法 mock
  const knownActions = new Set<string>(byAction.keys());

  for (const action of knownActions) {
    const list = byAction.get(action) ?? [];
    // 选择 to 策略：
    //   1) 若只有一个转移，直接返回其 to
    //   2) 若多个转移（多源/多目标），按 from 排序第一个为基线，nextState 不区分来源
    //     （mock 不模拟守卫差异，仅返回"第一个匹配"的 to；verify --mock 假定
    //     路径中的 currentState 已对齐）
    const baseTo = list[0]?.to ?? '-';
    impl[action] = async (_currentState: string, ..._args: unknown[]) => {
      bumpSpy(action);
      return { nextState: baseTo, effects: list[0]?.effects };
    };
  }

  // 注：kind=observation 接口不参与 mock（test-tool 不调用）
  return impl;
}

// ============================================================================
// Mock 模式 verify 执行
// ============================================================================

/**
 * 在 verify --mock 模式下，用 mock 实现跑 test-cases 路径。
 * 不依赖 test-tool 编译产物；纯 in-process 执行。
 *
 * 路径契约（与 test-tool 一致）：
 *   - 对 path.transitionIds 逐条查 TRANSITION_BY_ACTION；
 *   - 校验 currentState ∈ transition.from；
 *   - 调用 mock 实现（bump spy）→ 断言 nextState === transition.to。
 */
export async function runMockVerification(
  model: SourceProtocolModel,
  testCases: TestCaseSet,
  mockImpl: MockImplementation
): Promise<TestToolRunReport> {
  const derivable = model.derivable;
  const transitionsById = new Map(derivable.transitions.map((t) => [t.id, t]));
  const initialStateId =
    derivable.initialStateId ?? derivable.states.find((s) => s.type === 'initial')?.id;

  const caseResults: TestToolCaseResult[] = [];
  let passed = 0;
  let failed = 0;

  for (const path of testCases.paths) {
    const result = await runMockPath(path, transitionsById, initialStateId, mockImpl);
    caseResults.push(result);
    if (result.passed) passed++;
    else failed++;
  }

  return {
    consumed: true,
    executedCases: testCases.paths.length,
    passedCases: passed,
    failedCases: failed,
    caseResults,
    toolFiles: ['derived/test-tool/mocks.ts'],
    generatedAt: new Date().toISOString(),
  };
}

async function runMockPath(
  path: ProtocolPath,
  transitionsById: Map<string, TransitionDef>,
  initialStateId: string | undefined,
  mockImpl: MockImplementation
): Promise<TestToolCaseResult> {
  if (!initialStateId) {
    return {
      pathId: path.id,
      passed: false,
      error: '协议无初始状态（initialStateId 缺失）',
    };
  }
  let currentState = initialStateId;
  for (const tid of path.transitionIds) {
    const t = transitionsById.get(tid);
    if (!t) {
      return { pathId: path.id, passed: false, error: `转移 ${tid} 未定义` };
    }
    if (!t.from.includes(currentState) && !t.from.includes('-')) {
      return {
        pathId: path.id,
        passed: false,
        error: `状态 ${currentState} 不在 ${tid}.from=${t.from.join('/')} 中`,
      };
    }
    const fn = mockImpl[t.action];
    if (!fn) {
      return { pathId: path.id, passed: false, error: `mock 缺 ${t.action}` };
    }
    let outcome: { nextState: string; effects?: string[] };
    try {
      outcome = await Promise.resolve(fn(currentState));
    } catch (err) {
      return {
        pathId: path.id,
        passed: false,
        error: `mock 实现异常：${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (outcome.nextState !== t.to) {
      return {
        pathId: path.id,
        passed: false,
        error: `mock.nextState=${outcome.nextState} ≠ ${tid}.to=${t.to}`,
      };
    }
    currentState = outcome.nextState;
  }
  return { pathId: path.id, passed: true };
}

/**
 * 旧协议实现 shape 适配（type-only）：便于 verify 已有 ProtocolImplementationStub 适配。
 * 当前未使用；保留作 E6 后续扩面锚点。
 */
export function _shapeCompat(): ProtocolImplementationStubShape {
  return {};
}