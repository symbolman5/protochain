/**
 * 子任务模式（exec-task）测试 —— protocol-runner 驱动 protochain 的联合链路（protochain 侧）
 *
 * 覆盖：
 * - 确定性路径：generate-tests / generate-cases 无 AI 跑通，产物落盘，成本账本 modelCalls=0；
 * - 无状态：子任务模式不写 orchestrator-state.yaml（跨调用无残留）；
 * - AI 路径：mock 适配器（不真调外部 API）驱动生成 loop，成本含 AI 调用数与修正轮数；
 * - 边界：verify 被禁止（权威 acceptance 留在 protocol-runner 边界）；
 * - preflight 提示：只注入提示文本，executed=0。
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeTask, type ExecTaskInput } from '../../src/exec-task/index.js';
import type { AIRole } from '../../src/ai/router.js';
import type { AIAdapter, AIPrompt, AIResponse } from '../../src/model/types.js';

// ---------------------------------------------------------------------------
// 最小协议模型（3 状态：S0 初始 / S1 运行中 / S2 终态）
// ---------------------------------------------------------------------------

const MINIMAL_MODEL = `---
name: 服务生命周期协议（实验最小实例）
version: 1.0.0
purpose: 描述服务从创建、运行到退役的最小生命周期，验证 protocol-runner 驱动 protochain 子任务的联合链路
roles:
  - id: operator
    name: 运维
    responsibilities: 创建服务、退役服务
    roleType: consensus
  - id: system
    name: 平台系统
    responsibilities: 维护服务状态机
    roleType: participant
---

# 背景

服务是一次部署单元，从创建到退役经历确定生命周期。本模型用于联合实验的最小协议样例。

# 核心概念

- **服务**：一次部署单元，从创建到退役经历确定生命周期

# 协作流程

运维创建服务后进入运行状态；运维退役服务后进入终态。

# 状态空间

| ID | 名称 | 类型 | 描述 | 角色 |
|---|---|---|---|---|
| S0 | 未创建 | initial | 服务尚未创建 | operator |
| S1 | 运行中 | normal | 服务已创建并运行 | operator |
| S2 | 已退役 | terminal | 服务已退役 | operator |

# 转移规则

| ID | 名称 | from | to | action | trigger | guard | effects | triggerType | actionType | affectsDimensions |
|---|---|---|---|---|---|---|---|---|---|---|
| T1 | 创建服务 | S0 | S1 | create | operator | | created_at = now | role | state_transition | |
| T2 | 退役服务 | S1 | S2 | retire | operator | | retired_at = now | role | state_transition | |

# 不变量

| ID | 名称 | 表达式 | 作用状态 | 声明方 | 不变量类别 | 描述 |
|---|---|---|---|---|---|---|
| INV1 | 退役不早于创建 | retired_at >= created_at | S2 | operator | intra_protocol | 退役时间不得早于创建时间 |
`;

const CONFIG_PLAIN = `name: 服务生命周期协议（实验最小实例）
`;

const CONFIG_AI = `name: 服务生命周期协议（实验最小实例）
ai:
  provider: local
  useForGeneration: true
  loop:
    maxIterations: 3
    maxTokens: 20000
    maxToolCalls: 10
`;

const COMPOSITION = `# 系统元数据

\`\`\`yaml
systemName: 多协议实验系统
version: 0.1.0
changeType: protocol_tweak
\`\`\`

# 子协议清单

\`\`\`yaml
- protocolId: P1
  name: 服务生命周期
  version: 0.1.0
  modelPath: protocol/P1/model.md
\`\`\`

# 依赖图

\`\`\`mermaid
graph LR
  P1[服务生命周期]
\`\`\`
`;

function createProject(useAI: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'protochain-exec-task-'));
  mkdirSync(join(dir, 'protocol'), { recursive: true });
  writeFileSync(join(dir, 'protocol', 'model.md'), MINIMAL_MODEL, 'utf-8');
  writeFileSync(join(dir, 'protochain.config.yaml'), useAI ? CONFIG_AI : CONFIG_PLAIN, 'utf-8');
  return dir;
}

function createMultiProject(): { root: string; p1: string } {
  const root = mkdtempSync(join(tmpdir(), 'protochain-exec-task-multi-'));
  const p1 = join(root, 'protocol', 'P1');
  mkdirSync(p1, { recursive: true });
  writeFileSync(join(root, 'protocol', 'composition.md'), COMPOSITION, 'utf-8');
  writeFileSync(join(root, 'protocol', 'P1', 'model.md'), MINIMAL_MODEL, 'utf-8');
  writeFileSync(join(root, 'protochain.config.yaml'), CONFIG_PLAIN, 'utf-8');
  return { root, p1 };
}

/** 按生成目标区分的 mock 适配器：executor 模式返回 TS 源码脚本，cases 模式返回 JSON 路径脚本 */
class StepAwareMockAdapter implements AIAdapter {
  name = 'mock';
  calls: AIPrompt[] = [];
  private modeCalls = { executor: 0, cases: 0 };

  constructor(
    private scripts: {
      executor: string[];
      cases: string[];
    }
  ) {}

  async complete(prompt: AIPrompt): Promise<AIResponse> {
    this.calls.push(prompt);
    const isExecutor = prompt.instruction.includes('protocol-executor.ts');
    const mode = isExecutor ? 'executor' : 'cases';
    const idx = Math.min(this.modeCalls[mode], this.scripts[mode].length - 1);
    this.modeCalls[mode] += 1;
    return { content: this.scripts[mode][idx]!, success: true, attempts: 1 };
  }
}

describe('exec-task 子任务模式', () => {
  test('确定性路径：generate-tests + generate-cases 无 AI 跑通，成本 modelCalls=0', async () => {
    const dir = createProject(false);
    const input: ExecTaskInput = {
      taskId: 'joint-exp-1',
      steps: ['generate-tests', 'generate-cases'],
      goal: '为最小服务生命周期协议生成测试工具与用例',
    };

    const result = await executeTask(input, { projectDir: dir });

    expect(result.status).toBe('completed');
    expect(result.artifacts).toContain('derived/test-cases.json');
    expect(result.artifacts).toContain('derived/test-tool/protocol-model.ts');
    expect(result.artifacts).toContain('derived/test-tool/protocol-executor.ts');
    expect(result.cost.modelCalls).toBe(0);
    expect(result.cost.loop).toBeUndefined();
    expect(result.preflight).toEqual({ provided: 0, executed: 0 });
    // 产物确实落盘
    expect(existsSync(join(dir, 'derived/test-cases.json'))).toBe(true);
    expect(existsSync(join(dir, 'derived/test-tool/scenario-loader.ts'))).toBe(true);
    // 覆盖度全绿 → 无 openItems
    expect(result.openItems).toEqual([]);
    // 事实账本记录步骤与子任务边界
    expect(result.facts.some((f) => f.subject === 'generate-tests')).toBe(true);
    expect(result.facts.some((f) => f.subject === 'subtask-boundary')).toBe(true);
    // 子任务模式不持久化 orchestrator state（跨调用无残留）
    expect(existsSync(join(dir, 'derived/orchestrator-state.yaml'))).toBe(false);
  });

  test('AI 路径：mock 适配器驱动生成 loop，成本含 AI 调用数与修正轮数，不真调外部 API', async () => {
    // 先跑确定性路径，取得"正确"的 protocol-executor 源码作为 mock 的修正答案
    const baseDir = createProject(false);
    const det = await executeTask(
      { taskId: 'det', steps: ['generate-tests'] },
      { projectDir: baseDir }
    );
    expect(det.status).toBe('completed');
    const correctExecutor = readFileSync(
      join(baseDir, 'derived/test-tool/protocol-executor.ts'),
      'utf-8'
    );
    // 首轮故意损坏（tsc 机械预检失败），第二轮给正确源码
    const brokenExecutor = `${correctExecutor}\nconst __bogus: number = "not-a-number";\n`;
    const PARTIAL = JSON.stringify({
      paths: [{ transitionIds: ['T1'], description: '创建服务' }],
    });
    const FULL = JSON.stringify({
      paths: [
        { transitionIds: ['T1', 'T2'], description: '创建并退役' },
      ],
    });

    const dir = createProject(true);
    const adapter = new StepAwareMockAdapter({
      executor: [brokenExecutor, correctExecutor],
      cases: [PARTIAL, FULL],
    });
    const result = await executeTask(
      {
        taskId: 'joint-exp-ai',
        steps: ['generate-tests', 'generate-cases'],
        useAI: true,
        context: {
          budget: { maxIterations: 3 },
          preflightAssertions: [
            { kind: 'file', path: 'derived/test-cases.json', description: '测试用例文件应存在' },
          ],
        },
      },
      {
        projectDir: dir,
        adapterFor: (_role: AIRole) => adapter,
      }
    );

    expect(result.status).toBe('completed');
    // testgen 2 次 + casegen 2 次
    expect(result.cost.modelCalls).toBe(4);
    expect(result.cost.toolCalls).toBe(4);
    expect(result.cost.loop?.iterations).toBe(4);
    expect(result.cost.loop?.corrections).toBe(2);
    // 修正反馈确实进入第二轮 prompt
    expect(adapter.calls.some((c) => c.instruction.includes('tsc'))).toBe(true);
    expect(adapter.calls.some((c) => c.instruction.includes('未覆盖项'))).toBe(true);
    // preflight 提示注入 system，但 executed=0（P1：不越权执行）
    expect(result.preflight).toEqual({ provided: 1, executed: 0 });
    expect(adapter.calls.some((c) => c.system.includes('子任务预检提示'))).toBe(true);
    expect(adapter.calls.some((c) => c.system.includes('不在 loop 内执行'))).toBe(true);
  });

  test('verify 在子任务模式被禁止：权威 acceptance 留在 protocol-runner 边界', async () => {
    const dir = createProject(false);
    const result = await executeTask(
      { taskId: 'forbidden', steps: ['verify'] },
      { projectDir: dir }
    );
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('verify');
    expect(result.reason).toContain('权威 acceptance');
  });

  test('未知步骤 / 空步骤清单被拒绝', async () => {
    const dir = createProject(false);
    const unknown = await executeTask(
      { taskId: 'unknown', steps: ['not-a-step' as never] },
      { projectDir: dir }
    );
    expect(unknown.status).toBe('failed');
    expect(unknown.reason).toContain('不是可执行的子任务步骤');

    const empty = await executeTask(
      { taskId: 'empty', steps: [] },
      { projectDir: dir }
    );
    expect(empty.status).toBe('failed');
    expect(empty.reason).toContain('steps 为空');
  });

  test('AI-only 步骤（reason）在未启用 AI 时显式跳过并记录事实，不伪造通过', async () => {
    const dir = createProject(false);
    const result = await executeTask(
      { taskId: 'skip-reason', steps: ['reason', 'generate-cases'] },
      { projectDir: dir }
    );
    expect(result.status).toBe('completed');
    expect(result.facts.some((f) => f.subject === 'reason' && f.kind === 'assumption')).toBe(true);
    expect(result.facts.some((f) => f.detail.includes('跳过 AI-only'))).toBe(true);
  });

  test('多模型路由观测：步骤级 aiModel 与 aiModelByRole 记录 semantic/reasoning/generation 分层', async () => {
    // 先跑确定性路径取得"正确"的 protocol-executor 源码，作为 generation mock 的答案
    const baseDir = createProject(false);
    const det = await executeTask(
      { taskId: 'det-gen', steps: ['generate-tests'] },
      { projectDir: baseDir }
    );
    expect(det.status).toBe('completed');
    const correctExecutor = readFileSync(
      join(baseDir, 'derived/test-tool/protocol-executor.ts'),
      'utf-8'
    );

    class RoleModelAdapter implements AIAdapter {
      name = 'mock';
      constructor(private model: string) {}
      get modelName(): string {
        return this.model;
      }
      async complete(prompt: AIPrompt): Promise<AIResponse> {
        if (prompt.instruction.includes('protocol-executor.ts')) {
          return { content: correctExecutor, success: true, attempts: 1 };
        }
        if (prompt.instruction.includes('一致性')) {
          return {
            content: JSON.stringify({
              consistency: { passed: true, violations: [], notes: 'mock 一致' },
            }),
            success: true,
            attempts: 1,
          };
        }
        return { content: '{}', success: true, attempts: 1 };
      }
    }

    const dir = createProject(true);
    const result = await executeTask(
      {
        taskId: 'multi-route',
        steps: ['check', 'reason', 'generate-tests'],
        useAI: true,
      },
      {
        projectDir: dir,
        adapterFor: (role: AIRole) =>
          new RoleModelAdapter(
            role === 'semantic' ? 'sem-flash' : role === 'reasoning' ? 'rsn-pro' : 'gen-flash'
          ),
      }
    );

    expect(result.status).toBe('completed');
    const byStep: Record<string, string | undefined> = {};
    for (const s of result.stepResults) byStep[s.stepId] = s.aiModel;
    expect(byStep.check).toBe('sem-flash');
    expect(byStep.reason).toBe('rsn-pro');
    expect(byStep['generate-tests']).toBe('gen-flash');
    expect(result.aiModelByRole).toEqual({
      semantic: 'sem-flash',
      reasoning: 'rsn-pro',
      generation: 'gen-flash',
    });
    // 无 AI 的步骤不误报模型名（如 derive-specs 未跑，stepResults 不应含该步 aiModel）
    expect(result.stepResults.find((s) => s.stepId === 'derive-specs')).toBeUndefined();
  });

  test('多协议：protocolId 定位到 protocol/<Pn>，derived 落协议根', async () => {
    const { root, p1 } = createMultiProject();
    const result = await executeTask(
      { taskId: 'multi-p1', protocolId: 'P1', steps: ['generate-tests', 'generate-cases'] },
      { projectDir: root }
    );
    expect(result.status).toBe('completed');
    expect(result.artifacts.some((a) => a.startsWith('derived/test-cases.json'))).toBe(true);
    expect(existsSync(join(p1, 'derived', 'test-cases.json'))).toBe(true);
    expect(existsSync(join(p1, 'derived', 'test-tool', 'protocol-model.ts'))).toBe(true);
    // 根目录不得被污染
    expect(existsSync(join(root, 'derived', 'test-cases.json'))).toBe(false);
  });

  test('多协议 + persist-state：写 orchestrator-state.yaml 且检查点自动批准', async () => {
    const { root, p1 } = createMultiProject();
    const result = await executeTask(
      { taskId: 'multi-persist', protocolId: 'P1', steps: ['generate-tests', 'generate-cases'] },
      { projectDir: root, persistState: true }
    );
    expect(result.status).toBe('completed');
    const stateFile = join(p1, 'derived', 'orchestrator-state.yaml');
    expect(existsSync(stateFile)).toBe(true);
    const raw = readFileSync(stateFile, 'utf8');
    expect(raw).toContain('generate-tests:');
    expect(raw).toContain('generate-cases:');
    expect(raw).toContain('passed: true');
    // generate-tests 有检查点 → 自动批准（skipped）
    expect(raw).toContain('checkpoints:');
    expect(result.facts.some((f) => f.subject === 'orchestrator-state')).toBe(true);
  });
});
