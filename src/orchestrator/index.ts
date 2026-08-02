/**
 * 流程编排器
 *
 * 设计依据：《协议驱动自验证工具链设计方案》orchestrator 模块
 *
 * 职责：
 * 1. 步骤依赖 DAG 调度（依据 dag.ts）
 * 2. 人工检查点门控（依据 checkpoint.ts）
 * 3. 步骤执行器分发（registry 模式，便于扩展与测试）
 * 4. `--from <步骤>` 时校验前置已完成且通过
 *
 * orchestrator 不做创造性判断，只做解析、编排、确定性验证的脚手架。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type {
  SourceProtocolModel,
  StepId,
  StepExecutionResult,
  DerivedArtifacts,
} from '../model/types.js';
import { parseProtocolFile } from '../parser/index.js';
import { getStepRange, checkPrerequisites, getStep } from './dag.js';
import {
  loadState,
  saveState,
  recordStepResult,
  applyCheckpointDecision,
  canProceed,
  presentCheckpoint,
  buildStatusView,
  formatStatusView,
  type OrchestratorState,
  type CheckpointDecision,
} from './checkpoint.js';

// 重新导出，供 CLI 层使用
export {
  loadState,
  saveState,
  buildStatusView,
  formatStatusView,
  presentCheckpoint,
  type OrchestratorState,
  type CheckpointDecision,
};

// ============================================================================
// 步骤执行器注册表
// ============================================================================

export interface StepContext {
  /** 解析后的源协议模型 */
  model: SourceProtocolModel;
  /** 项目根目录 */
  rootDir: string;
  /** 已累积的派生产物 */
  artifacts: DerivedArtifacts;
  /** 多协议项目中的子协议 ID（如 P3；单协议项目为 undefined） */
  protocolId?: string;
}

export interface StepExecutor {
  /** 执行步骤，返回执行结果与报告摘要（供检查点呈现） */
  execute(ctx: StepContext): Promise<StepExecutionResult & { reportSummary?: string }>;
}

const EXECUTOR_REGISTRY = new Map<StepId, StepExecutor>();

export function registerExecutor(stepId: StepId, executor: StepExecutor): void {
  EXECUTOR_REGISTRY.set(stepId, executor);
}

export function getExecutor(stepId: StepId): StepExecutor | undefined {
  return EXECUTOR_REGISTRY.get(stepId);
}

// ============================================================================
// 运行入口
// ============================================================================

export interface RunOptions {
  rootDir: string;
  from?: StepId;
  to?: StepId;
  /** 协议模型路径（默认 rootDir/protocol/model.md；多协议子协议场景由上层注入） */
  modelPath?: string;
  /** 多协议项目中的子协议 ID（如 P3；供 bindings 按协议过滤） */
  protocolId?: string;
  /** 检查点决策回调（CLI 层注入；不注入则自动批准——仅用于非交互场景） */
  checkpointHandler?: (stepId: StepId, reportSummary: string) => Promise<CheckpointDecision>;
}

export interface RunResult {
  executed: StepId[];
  finalState: OrchestratorState;
  aborted?: { stepId: StepId; reason: string };
}

export async function runPipeline(options: RunOptions): Promise<RunResult> {
  const { rootDir, from = 'check', to = 'verify' } = options;
  const range = getStepRange(from, to);

  // 加载状态
  let state = loadState(rootDir);

  // 构建已完成步骤映射
  const completedMap = new Map<StepId, StepExecutionResult>();
  for (const [id, result] of Object.entries(state.steps)) {
    if (result) completedMap.set(id as StepId, result);
  }

  // 前置校验：from 步骤的所有前置必须完成且通过
  const prereqCheck = checkPrerequisites(from, completedMap);
  if (!prereqCheck.satisfied) {
    throw new Error(
      `步骤 ${from} 的前置未满足：${prereqCheck.missing.join(', ')} 未完成或未通过。` +
        `请先运行 protochain run --to <前置步骤>。`
    );
  }

  // 解析协议模型（权威源）
  const modelPath = options.modelPath ?? join(rootDir, 'protocol/model.md');
  if (!existsSync(modelPath)) {
    throw new Error(`协议模型文件不存在：${modelPath}。请先运行 protochain init。`);
  }
  const model = parseProtocolFile(modelPath);

  const artifacts: DerivedArtifacts = {};
  const executed: StepId[] = [];

  for (const stepId of range) {
    // 检查是否可继续（前置 + 检查点）
    const proceed = canProceed(state, stepId, completedMap);
    if (!proceed.ok) {
      return {
        executed,
        finalState: state,
        aborted: { stepId, reason: proceed.reason ?? '未知原因' },
      };
    }

    const executor = getExecutor(stepId);
    if (!executor) {
      return {
        executed,
        finalState: state,
        aborted: {
          stepId,
          reason: `步骤 ${stepId} 的执行器未注册（该步骤可能在后续阶段实现）`,
        },
      };
    }

    const ctx: StepContext = { model, rootDir, artifacts, protocolId: options.protocolId };
    const result = await executor.execute(ctx);

    // 记录结果
    const execResult: StepExecutionResult = {
      stepId: result.stepId,
      passed: result.passed,
      outputs: result.outputs,
      executedAt: result.executedAt,
      error: result.error,
    };
    state = recordStepResult(state, execResult);
    completedMap.set(stepId, execResult);
    saveState(rootDir, state);
    executed.push(stepId);

    // 未通过则中止
    if (!result.passed) {
      return {
        executed,
        finalState: state,
        aborted: { stepId, reason: result.error ?? '步骤未通过' },
      };
    }

    // 检查点门控
    const step = getStep(stepId);
    if (step.hasCheckpoint) {
      // 该步骤自身的检查点（下一步执行前需批准）
      // 注意：检查点针对的是"本步骤产出是否可被下一步消费"
      // 所以检查点记录在 stepId 上，由下一步的 canProceed 校验
      if (options.checkpointHandler && result.reportSummary) {
        const decision = await options.checkpointHandler(stepId, result.reportSummary);
        state = applyCheckpointDecision(state, stepId, decision);
        saveState(rootDir, state);

        if (decision.kind === 'reject') {
          return {
            executed,
            finalState: state,
            aborted: {
              stepId,
              reason: `检查点被拒绝：${decision.reason}`,
            },
          };
        }
      } else {
        // 无回调：自动批准（非交互场景，记录为 skipped 以提示）
        state = applyCheckpointDecision(state, stepId, {
          kind: 'skip',
          note: '非交互模式自动跳过检查点',
        });
        saveState(rootDir, state);
      }
    }
  }

  return { executed, finalState: state };
}

// ============================================================================
// 报告读写工具
// ============================================================================

export function writeReport(
  rootDir: string,
  relativePath: string,
  data: unknown
): string {
  const fullPath = join(rootDir, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  const content =
    relativePath.endsWith('.json')
      ? JSON.stringify(data, null, 2)
      : stringifyYaml(data);
  writeFileSync(fullPath, content, 'utf-8');
  return fullPath;
}

export function readReport<T>(rootDir: string, relativePath: string): T | undefined {
  const fullPath = join(rootDir, relativePath);
  if (!existsSync(fullPath)) return undefined;
  const raw = readFileSync(fullPath, 'utf-8');
  if (relativePath.endsWith('.json')) {
    return JSON.parse(raw) as T;
  }
  // YAML 解析延迟加载，避免循环依赖
  const { parse: parseYaml } = require('yaml');
  return parseYaml(raw) as T;
}
