/**
 * 绑定驱动验证执行器 —— 步骤⑩ 的传输层执行路径
 *
 * 设计依据：《协议驱动自验证工具链设计方案》binding-mechanism-plan 第 4 节
 *
 * 职责：
 * 1. 将 ⑤ 规格与 protochain.config.yaml 的 bindings 配置解析为 ResolvedBinding[]
 * 2. 按协议路径逐转移调用真实接口（HTTP/Kafka/NSQ），依据传输类型与响应模式判定状态：
 *    - P0a：触发系统接口，信任响应中的 nextState
 *    - P0b：触发后经观测接口独立读取状态再与协议预期比较（三步闭环）
 *    - 观测接口降级：目标状态无观测绑定时降级信任动作响应 nextState / 协议预期
 *    - Kafka/NSQ：
 *      - responseMode='none'：fire-and-forget，发送后信任协议预期（不查观测）
 *      - responseMode='poll'：发送后轮询观测接口直至状态收敛或超时
 *      - responseMode='reply_topic'：等待响应 topic 消息（执行器已实现），按 P0a/P0b 判定
 *
 * 运行时参数（runtimeParams）来源，优先级从高到低：
 *   1. 场景文件 params（protocol/<root>/scenarios/*.yaml，按路径动作序列匹配）——最高优先级
 *   2. 动作响应字段注入（如 add 返回 serverId，供后续 {serverId} 路径模板/body 使用）
 *   3. currentState（每一步自动维护）
 *
 * 状态词表归一化：bindings.stateMap（协议状态 ID → 系统状态值）+ 状态名，
 * 用于观测接口/动作响应中系统词汇与协议状态 ID 不一致时的比较。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type {
  ResolvedBinding,
  ProtocolPath,
  TransitionDef,
  CaseResult,
  Deviation,
} from '../model/types.js';
import type { TransportResult } from '../transport/types.js';
import { executeTransport } from '../transport/index.js';

/** 传输执行器函数签名（默认 executeTransport；测试可注入 mock） */
export type TransportExecutorFn = (
  resolved: ResolvedBinding | undefined,
  runtimeParams: Record<string, unknown>
) => Promise<TransportResult>;

/** setup 动作：测试路径执行前调用的清理/准备接口（如 purge_user 幂等删除测试数据） */
export interface SetupAction {
  action: string;
  params?: Record<string, unknown>;
}

/** 场景文件参数源（protocol/scenarios/*.yaml 投影） */
export interface ScenarioParamSource {
  id: string;
  /** 期望动作序列（用于与测试路径匹配） */
  expectedActions: string[];
  /** 初始运行时参数（最高优先级） */
  params: Record<string, unknown>;
  /** 前置 setup 动作序列：每条命中的测试路径执行前按序调用 */
  setup?: SetupAction[];
}

export interface BindingVerifyOptions {
  /** poll 模式轮询超时（ms，默认 10000） */
  pollTimeoutMs?: number;
  /** poll 模式轮询间隔（ms，默认 200） */
  pollIntervalMs?: number;
  /** 状态词表映射：协议状态 ID → 系统状态值 */
  stateMap?: Record<string, string>;
  /** 场景参数源列表 */
  scenarios?: ScenarioParamSource[];
  /** setup 动作绑定索引：action → 绑定（不经 specs，直接从 bindings.interfaces 解析） */
  setupBindings?: Map<string, ResolvedBinding>;
}

/** 保留字段：不注入 runtimeParams（避免污染路径变量/请求体） */
const RESERVED_INJECT_KEYS = new Set([
  'nextState',
  'currentState',
  'isInState',
  'error',
  'ok',
  'sent',
  'pollMode',
  'observeAfterMs',
  'success',
]);

/**
 * 构建观测接口索引。
 * 每个观测接口有两个别名：spec.name（如 observe_已退役）与 observe_<sourceId>（如 observe_S4），
 * 便于按转移目标状态 ID（t.to）查找对应观测绑定。
 */
export function buildObservationIndex(
  resolved: ResolvedBinding[]
): Map<string, ResolvedBinding> {
  const map = new Map<string, ResolvedBinding>();
  for (const r of resolved) {
    if (r.spec.kind !== 'observation' || !r.binding) continue;
    map.set(r.spec.name, r);
    if (r.spec.sourceId) {
      map.set(`observe_${r.spec.sourceId}`, r);
    }
  }
  return map;
}

/**
 * 从协议根目录加载场景参数源。
 * 同时兼容两种布局：单协议 <root>/protocol/scenarios，多协议 <root>/scenarios。
 */
export function loadScenarioParams(scenariosDir: string): ScenarioParamSource[] {
  if (!existsSync(scenariosDir)) return [];
  const files = readdirSync(scenariosDir).filter(
    (f) => f.endsWith('.yaml') || f.endsWith('.yml')
  );
  const out: ScenarioParamSource[] = [];
  for (const file of files) {
    try {
      const raw = readFileSync(join(scenariosDir, file), 'utf-8');
      const doc = parseYaml(raw) as Partial<ScenarioParamSource>;
      if (doc?.id && Array.isArray(doc.expectedActions)) {
        out.push({
          id: doc.id,
          expectedActions: doc.expectedActions,
          params: doc.params && typeof doc.params === 'object' ? doc.params : {},
          setup: Array.isArray(doc.setup) ? doc.setup : undefined,
        });
      }
    } catch {
      // 忽略损坏的场景文件
    }
  }
  return out;
}

/**
 * 定位场景目录：优先 <root>/protocol/scenarios（单协议布局），
 * 其次 <root>/scenarios（多协议子协议布局）。
 */
export function findScenariosDir(rootDir: string): string | undefined {
  const single = join(rootDir, 'protocol/scenarios');
  if (existsSync(single)) return single;
  const multi = join(rootDir, 'scenarios');
  if (existsSync(multi)) return multi;
  return undefined;
}

/**
 * 绑定模式下执行一条协议路径用例。
 *
 * @param path 协议路径（⑦ 生成）
 * @param transitionsById 转移表索引
 * @param initialStateId 初始状态 ID
 * @param resolved 解析后的绑定列表
 * @param stateNames 状态 ID → 状态名（用于观测词表归一化）
 * @param transport 传输执行器（默认 executeTransport）
 * @param options 轮询/词表/场景参数
 */
export async function runBindingPathCase(
  path: ProtocolPath,
  transitionsById: Map<string, TransitionDef>,
  initialStateId: string | undefined,
  resolved: ResolvedBinding[],
  stateNames: Map<string, string>,
  transport: TransportExecutorFn = executeTransport,
  options: BindingVerifyOptions = {}
): Promise<CaseResult> {
  // 无初始状态：跳过
  if (!initialStateId) {
    return { pathId: path.id, passed: false, skipped: true };
  }

  const resolvedByAction = new Map<string, ResolvedBinding>();
  for (const r of resolved) {
    if (r.spec.kind === 'system') resolvedByAction.set(r.spec.name, r);
  }
  const obsIndex = buildObservationIndex(resolved);

  let currentState = initialStateId;
  const deviations: Deviation[] = [];

  // 运行时参数：以场景文件 params 为种子（最高优先级），动作响应字段注入次之
  const seededKeys = new Set<string>();
  const injectedParams: Record<string, 'scenario' | 'response'> = {};
  const runtimeParams: Record<string, unknown> = { currentState: initialStateId };
  const scenarioSource = selectScenarioSource(path, transitionsById, options.scenarios);
  const scenarioMatch = options.scenarios && options.scenarios.length > 0
    ? (scenarioSource ? { id: scenarioSource.id } : null)
    : undefined;
  if (scenarioSource) {
    for (const [k, v] of Object.entries(scenarioSource.params ?? {})) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        runtimeParams[k] = v;
        seededKeys.add(k);
        injectedParams[k] = 'scenario';
      }
    }
  }

  // 前置 setup：按声明顺序调用清理/准备接口（复用绑定执行逻辑；失败则整条路径记偏差且不执行）
  const setupSteps = scenarioSource?.setup ?? [];
  let setupFailed = false;
  for (const step of setupSteps) {
    const setupBinding = options.setupBindings?.get(step.action);
    if (!setupBinding?.binding) {
      deviations.push({
        action: `setup:${step.action}`,
        state: currentState,
        expected: `setup 接口 ${step.action} 已绑定（bindings.interfaces）`,
        actual: 'setup 接口未绑定',
        kind: 'missing_action',
        stepIndex: -1,
      });
      setupFailed = true;
      break;
    }
    const setupResult = await safeTransport(transport, setupBinding, { ...(step.params ?? {}) });
    if (!setupResult.ok) {
      deviations.push({
        action: `setup:${step.action}`,
        state: currentState,
        expected: `setup 接口调用成功（${JSON.stringify(step.params ?? {})}）`,
        actual: `setup 失败：${describeTransportError(setupResult)}`,
        kind: 'state_mismatch',
        stepIndex: -1,
        httpStatus: setupResult.status,
        responseBody: summarizeResponseBody(setupResult.data),
      });
      setupFailed = true;
      break;
    }
  }

  if (setupFailed) {
    return {
      pathId: path.id,
      passed: false,
      deviations,
      scenarioMatch,
      injectedParams: Object.keys(injectedParams).length > 0 ? injectedParams : undefined,
    };
  }

  let degraded = false;
  for (let stepIdx = 0; stepIdx < path.transitionIds.length; stepIdx++) {
    const tid = path.transitionIds[stepIdx];
    const t = transitionsById.get(tid);
    if (!t) {
      deviations.push({
        action: tid,
        state: currentState,
        expected: `转移 ${tid} 存在`,
        actual: '转移未定义',
        kind: 'missing_action',
        stepIndex: stepIdx,
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
        stepIndex: stepIdx,
      });
      break;
    }

    // 1. 触发系统接口
    const actionBinding = resolvedByAction.get(t.action);
    if (!actionBinding?.binding) {
      deviations.push({
        action: t.action,
        state: currentState,
        expected: `接口 ${t.action} 已绑定（bindings.interfaces）`,
        actual: '接口未绑定',
        kind: 'missing_action',
        stepIndex: stepIdx,
      });
      break;
    }

    runtimeParams['currentState'] = currentState;
    const result = await safeTransport(transport, actionBinding, runtimeParams);
    if (!result.ok) {
      deviations.push({
        action: t.action,
        state: currentState,
        expected: `接口调用成功（期望状态 ${t.to}）`,
        actual: `接口调用失败：${describeTransportError(result)}`,
        kind: 'state_mismatch',
        stepIndex: stepIdx,
        httpStatus: result.status,
        responseBody: summarizeResponseBody(result.data),
      });
      break;
    }

    // 响应字段注入：非保留字段进入 runtimeParams（场景种子字段优先，不被覆盖）
    if (result.data && typeof result.data === 'object') {
      injectResponseFields(runtimeParams, result.data, seededKeys, injectedParams);
    }

    const transportType = actionBinding.binding.transport.type;
    const responseMode =
      transportType === 'kafka' || transportType === 'nsq'
        ? actionBinding.binding.transport.responseMode
        : undefined;

    // 2. fire-and-forget：发送后信任协议预期，不查观测接口
    if (responseMode === 'none') {
      currentState = t.to;
      continue;
    }

    // 3. 判定实际状态：优先经观测接口独立读取（P0b），否则降级信任动作响应（P0a）
    const obs = obsIndex.get(`observe_${t.to}`);
    let actualState: string | null = null;

    if (responseMode === 'poll') {
      // poll 模式：发送后轮询观测接口直至状态收敛
      if (!obs?.binding) {
        deviations.push({
          action: t.action,
          state: currentState,
          expected: `poll 模式需要目标状态 ${t.to} 的观测接口绑定`,
          actual: '目标状态无观测绑定',
          kind: 'missing_action',
          stepIndex: stepIdx,
        });
        break;
      }
      const pollResult = await pollObservationState(
        obs,
        transport,
        t.to,
        stateNames,
        options
      );
      if (!pollResult.ok) {
        deviations.push({
          action: `poll:observe_${t.to}`,
          state: currentState,
          expected: `状态在 ${options.pollTimeoutMs ?? 10000}ms 内收敛到 ${t.to}`,
          actual: describeTransportError(pollResult),
          kind: 'state_mismatch',
          stepIndex: stepIdx,
          httpStatus: pollResult.status,
          responseBody: summarizeResponseBody(pollResult.data),
        });
        break;
      }
      actualState = t.to;
    } else if (obs?.binding) {
      // P0b：独立观测读取（观测响应可取 currentState / isInState / status 字段）
      const obsResult = await safeTransport(transport, obs, runtimeParams);
      if (!obsResult.ok) {
        deviations.push({
          action: `observe_${t.to}`,
          state: currentState,
          expected: `观测接口读取成功（期望状态 ${t.to}）`,
          actual: `观测接口失败：${describeTransportError(obsResult)}`,
          kind: 'state_mismatch',
          stepIndex: stepIdx,
          httpStatus: obsResult.status,
          responseBody: summarizeResponseBody(obsResult.data),
        });
        break;
      }
      actualState = resolveObservedState(
        obsResult.data,
        t.to,
        options.stateMap,
        stateNames
      );
      if (actualState !== t.to) {
        deviations.push({
          action: `observe_${t.to}`,
          state: currentState,
          expected: t.to,
          actual: actualState ?? '未知状态',
          kind: 'state_mismatch',
          stepIndex: stepIdx,
        });
        break;
      }
    } else {
      // 降级：无观测绑定 → 信任动作响应 nextState（P0a）；响应无 nextState → 信任协议预期
      const nextStateRaw = extractNextState(result.data);
      if (nextStateRaw === undefined) {
        // 降级信任协议预期：标记独立性降级，与真验证通过区分
        actualState = t.to;
        degraded = true;
      } else {
        const nextState = normalizeState(
          nextStateRaw,
          t.to,
          options.stateMap,
          stateNames
        );
        if (nextState !== t.to) {
          deviations.push({
            action: t.action,
            state: currentState,
            expected: t.to,
            actual: nextStateRaw,
            kind: 'state_mismatch',
            stepIndex: stepIdx,
          });
          break;
        }
        actualState = nextState;
      }
    }

    currentState = actualState;
  }

  return {
    pathId: path.id,
    passed: deviations.length === 0,
    deviations: deviations.length > 0 ? deviations : undefined,
    scenarioMatch,
    injectedParams: Object.keys(injectedParams).length > 0 ? injectedParams : undefined,
    degraded: degraded || undefined,
  };
}

// ============================================================================
// 运行时参数
// ============================================================================

/**
 * 选择与路径动作序列匹配的场景参数源。
 * 场景的 expectedActions 与路径的转移动作序列（有序）完全一致时命中；
 * 返回整个场景源（含 params 与 setup），未命中返回 undefined。
 */
function selectScenarioSource(
  path: ProtocolPath,
  transitionsById: Map<string, TransitionDef>,
  scenarios: ScenarioParamSource[] | undefined
): ScenarioParamSource | undefined {
  if (!scenarios || scenarios.length === 0) return undefined;
  const actionSeq = path.transitionIds
    .map((tid) => transitionsById.get(tid)?.action)
    .filter((a): a is string => Boolean(a));
  return scenarios.find(
    (s) =>
      s.expectedActions.length === actionSeq.length &&
      s.expectedActions.every((a, i) => a === actionSeq[i])
  );
}

/** 将动作响应的原始字段注入 runtimeParams（跳过保留字段与场景种子字段） */
function injectResponseFields(
  runtimeParams: Record<string, unknown>,
  data: unknown,
  seededKeys: Set<string>,
  injectedParams: Record<string, 'scenario' | 'response'>
): void {
  const record = data as Record<string, unknown>;
  for (const [k, v] of Object.entries(record)) {
    if (RESERVED_INJECT_KEYS.has(k)) continue;
    if (seededKeys.has(k)) continue; // 场景参数优先，不被响应覆盖
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      runtimeParams[k] = v;
      injectedParams[k] = 'response';
    }
  }
}

// ============================================================================
// 轮询与状态归一化
// ============================================================================

/**
 * poll 模式：轮询观测接口直至返回预期状态或超时。
 */
async function pollObservationState(
  obs: ResolvedBinding,
  transport: TransportExecutorFn,
  expected: string,
  stateNames: Map<string, string>,
  options: BindingVerifyOptions
): Promise<TransportResult> {
  const timeoutMs = options.pollTimeoutMs ?? 10000;
  const intervalMs = options.pollIntervalMs ?? 200;
  const deadline = Date.now() + timeoutMs;

  let last: TransportResult = {
    status: 504,
    data: { error: '未开始轮询' },
    ok: false,
  };

  while (Date.now() < deadline) {
    last = await safeTransport(transport, obs, {});
    if (
      last.ok &&
      resolveObservedState(last.data, expected, options.stateMap, stateNames) === expected
    ) {
      return last;
    }
    await sleep(intervalMs);
  }

  if (last.ok) {
    return {
      status: 504,
      data: { error: `轮询超时（${timeoutMs}ms），状态未收敛到 ${expected}` },
      ok: false,
    };
  }
  return last;
}

/**
 * 从观测响应提取实际状态并归一化。
 * 可取字段：currentState / isInState / status（status 常见于 REST 资源体）。
 */
function resolveObservedState(
  data: unknown,
  expectedId: string,
  stateMap: Record<string, string> | undefined,
  stateNames: Map<string, string>
): string | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  const raw = record['currentState'] ?? record['isInState'] ?? record['status'] ?? null;
  if (raw === null || raw === undefined || typeof raw !== 'string') return null;
  return normalizeState(raw, expectedId, stateMap, stateNames);
}

/**
 * 状态词表归一化：系统值 → 协议状态 ID。
 * 依次接受：状态 ID 本身、状态名、stateMap 映射值；否则原样返回。
 */
function normalizeState(
  raw: string,
  expectedId: string,
  stateMap: Record<string, string> | undefined,
  stateNames: Map<string, string>
): string {
  if (raw === expectedId) return expectedId;
  if (stateNames.get(expectedId) === raw) return expectedId;
  if (stateMap && stateMap[expectedId] === raw) return expectedId;
  return raw;
}

function extractNextState(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const nextState = (data as Record<string, unknown>)['nextState'];
  return typeof nextState === 'string' ? nextState : undefined;
}

function describeTransportError(result: TransportResult): string {
  const data = result.data as Record<string, unknown> | undefined;
  const message = data && typeof data['error'] === 'string' ? data['error'] : '';
  return `${result.status}${message ? ` ${message}` : ''}`;
}

/**
 * 包裹传输执行器：捕获抛出的异常（网络错误等），转为 ok:false 的 TransportResult，
 * 避免 verify 因传输层异常整体 reject 而写不出报告。
 */
async function safeTransport(
  transport: TransportExecutorFn,
  binding: ResolvedBinding | undefined,
  params: Record<string, unknown>
): Promise<TransportResult> {
  try {
    return await transport(binding, params);
  } catch (err) {
    return {
      status: 0,
      data: { error: `传输异常：${err instanceof Error ? err.message : String(err)}` },
      ok: false,
    };
  }
}

/** 响应体摘要：超长（>2KB）截断为字符串，避免报告膨胀。 */
function summarizeResponseBody(data: unknown): unknown {
  if (data === undefined || data === null) return undefined;
  const s = typeof data === 'string' ? data : JSON.stringify(data);
  if (s.length <= 2048) return data;
  return `${s.slice(0, 2048)}... (truncated, ${s.length} chars total)`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
