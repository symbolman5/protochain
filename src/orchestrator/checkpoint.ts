/**
 * 检查点门控状态机
 *
 * 设计依据：《协议驱动自验证工具链设计方案》第四节 AI集成
 *
 * AI适配器只负责调用 AI 和解析输出，不负责检查点逻辑。
 * 检查点门控由 orchestrator 承担——在 AI 调用后、下一步骤前暂停流程，
 * 呈现报告，等待人工输入，根据输入决定继续/中止/重试。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { stringify as stringifyYaml, parse as parseYaml } from 'yaml';
import type {
  StepId,
  StepExecutionResult,
  StepNode,
} from '../model/types.js';
import { getAllSteps, getStep } from './dag.js';

// ============================================================================
// 检查点状态持久化
// ============================================================================

export interface CheckpointRecord {
  stepId: StepId;
  status: 'pending' | 'approved' | 'rejected' | 'skipped';
  reportSummary?: string;
  decidedBy?: string;
  note?: string;
  decidedAt?: string;
}

export interface OrchestratorState {
  /** 各步骤执行结果 */
  steps: Partial<Record<StepId, StepExecutionResult>>;
  /** 检查点记录 */
  checkpoints: Partial<Record<StepId, CheckpointRecord>>;
  /** 最后更新时间 */
  updatedAt: string;
}

const STATE_FILE = 'derived/orchestrator-state.yaml';

export function loadState(rootDir: string): OrchestratorState {
  const path = join(rootDir, STATE_FILE);
  if (!existsSync(path)) {
    return { steps: {}, checkpoints: {}, updatedAt: new Date().toISOString() };
  }
  const raw = readFileSync(path, 'utf-8');
  const parsed = parseYaml(raw) as Partial<OrchestratorState>;
  return {
    steps: parsed.steps ?? {},
    checkpoints: parsed.checkpoints ?? {},
    updatedAt: parsed.updatedAt ?? new Date().toISOString(),
  };
}

export function saveState(rootDir: string, state: OrchestratorState): void {
  const path = join(rootDir, STATE_FILE);
  mkdirSync(dirname(path), { recursive: true });
  state.updatedAt = new Date().toISOString();
  writeFileSync(path, stringifyYaml(state), 'utf-8');
}

// ============================================================================
// 检查点门控
// ============================================================================

export type CheckpointDecision =
  | { kind: 'approve'; decidedBy?: string; note?: string }
  | { kind: 'reject'; reason: string; decidedBy?: string }
  | { kind: 'skip'; decidedBy?: string; note?: string };

export interface CheckpointContext {
  step: StepNode;
  result: StepExecutionResult;
  /** 呈现给人工的报告摘要 */
  reportSummary: string;
}

/**
 * 呈现检查点：返回需要人工决策的上下文。
 * 实际交互由 CLI 层负责（读取 stdin 或等待用户输入）。
 */
export function presentCheckpoint(ctx: CheckpointContext): string {
  const lines: string[] = [
    '═══════════════════════════════════════════════════════════',
    `检查点门控：步骤 ${ctx.step.methodologyNumber} ${ctx.step.name}`,
    `执行方：${ctx.step.executor}　通过状态：${ctx.result.passed ? '✓ 通过' : '✗ 未通过'}`,
    '─── 报告摘要 ───',
    ctx.reportSummary,
    '─── 请人工决策 ───',
    '  approve [note]   - 批准，继续下一步骤',
    '  reject <reason>  - 拒绝，中止流程',
    '  skip [note]      - 跳过此检查点（不推荐）',
    '═══════════════════════════════════════════════════════════',
  ];
  return lines.join('\n');
}

/** 应用人工决策，更新检查点状态 */
export function applyCheckpointDecision(
  state: OrchestratorState,
  stepId: StepId,
  decision: CheckpointDecision
): OrchestratorState {
  let status: CheckpointRecord['status'];
  switch (decision.kind) {
    case 'approve':
      status = 'approved';
      break;
    case 'reject':
      status = 'rejected';
      break;
    case 'skip':
      status = 'skipped';
      break;
  }

  const record: CheckpointRecord = {
    stepId,
    status,
    decidedBy: decision.decidedBy,
    note: 'note' in decision ? decision.note : undefined,
    decidedAt: new Date().toISOString(),
  };

  if (decision.kind === 'reject') {
    record.note = decision.reason;
  }

  return {
    ...state,
    checkpoints: { ...state.checkpoints, [stepId]: record },
  };
}

/** 判断步骤是否可以继续执行（前置通过 + 检查点已批准或无需检查点） */
export function canProceed(
  state: OrchestratorState,
  stepId: StepId,
  completedSteps: Map<StepId, StepExecutionResult>
): { ok: boolean; reason?: string } {
  // 前置步骤必须完成且通过
  const step = getStep(stepId);
  for (const dep of step.dependsOn) {
    const depResult = completedSteps.get(dep);
    if (!depResult) {
      return { ok: false, reason: `前置步骤 ${dep} 未执行` };
    }
    if (!depResult.passed) {
      return { ok: false, reason: `前置步骤 ${dep} 未通过` };
    }
    // 前置若有检查点，必须已批准
    const depStep = getStep(dep);
    if (depStep.hasCheckpoint) {
      const cp = state.checkpoints[dep];
      if (!cp || (cp.status !== 'approved' && cp.status !== 'skipped')) {
        return {
          ok: false,
          reason: `前置步骤 ${dep} 的检查点未批准（当前状态：${cp?.status ?? '未决策'}）`,
        };
      }
    }
  }
  return { ok: true };
}

// ============================================================================
// 步骤执行结果记录
// ============================================================================

export function recordStepResult(
  state: OrchestratorState,
  result: StepExecutionResult
): OrchestratorState {
  return {
    ...state,
    steps: { ...state.steps, [result.stepId]: result },
  };
}

// ============================================================================
// 状态展示（protochain status）
// ============================================================================

export interface StatusView {
  steps: Array<{
    step: StepNode;
    executed: boolean;
    passed?: boolean;
    checkpoint?: CheckpointRecord;
    blockedBy?: string[];
  }>;
  pendingConfirmationsCount: number;
}

export function buildStatusView(state: OrchestratorState): StatusView {
  const completedMap = new Map<StepId, StepExecutionResult>();
  for (const [id, result] of Object.entries(state.steps)) {
    if (result) completedMap.set(id as StepId, result);
  }

  const steps = getAllSteps().map((step) => {
    const result = state.steps[step.id];
    const checkpoint = state.checkpoints[step.id];
    const blockedBy: string[] = [];
    for (const dep of step.dependsOn) {
      const depResult = completedMap.get(dep);
      if (!depResult || !depResult.passed) {
        blockedBy.push(dep);
      } else if (getStep(dep).hasCheckpoint) {
        const cp = state.checkpoints[dep];
        if (!cp || (cp.status !== 'approved' && cp.status !== 'skipped')) {
          blockedBy.push(`${dep}(检查点未批准)`);
        }
      }
    }
    return {
      step,
      executed: !!result,
      passed: result?.passed,
      checkpoint,
      blockedBy: blockedBy.length > 0 ? blockedBy : undefined,
    };
  });

  return { steps, pendingConfirmationsCount: 0 };
}

export function formatStatusView(view: StatusView): string {
  const lines: string[] = ['protochain 流程状态', ''];
  for (const item of view.steps) {
    const { step } = item;
    const status = !item.executed
      ? `○ 未执行${item.blockedBy ? `（阻塞于：${item.blockedBy.join(', ')}）` : ''}`
      : item.passed
        ? '✓ 通过'
        : '✗ 未通过';
    const cp = item.checkpoint
      ? `  检查点: ${item.checkpoint.status}`
      : step.hasCheckpoint
        ? '  检查点: 待决策'
        : '';
    lines.push(`${step.methodologyNumber} ${step.name} [${step.executor}]  ${status}${cp}`);
  }
  return lines.join('\n');
}
