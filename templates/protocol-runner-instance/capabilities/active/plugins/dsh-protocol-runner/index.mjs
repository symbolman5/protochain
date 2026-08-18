// protocol-runner × DSH 插件（适配 harness-design v0.5 P1/P2，hsk-ng 通用化）：
// - protocol_runner_finish：写出完整账本 result.json（status/summary/artifacts/facts/effects/openItems/cost）
//   + DSH 内部 metrics；effects/artifacts 必须在写域内；
// - protocol_runner_preflight：仅当 dsh.ts 注入 preflight bridge 时注册——把 loop 内 preflight
//   信号（runAssertion / isInWriteDomain）暴露给模型；只绑定 TaskPackage.preflightAssertions，
//   不执行权威 acceptance（权威结论始终在 protocol-runner 子任务边界）；
// - 写域：write/edit 工具预执行拦截 + finish 产物校验；runSandboxed 快照仍是最终兜底。
// 注意：DSH 源码路径与 hsk-ng 实例一致（静态 ESM import 无法用环境变量）；
// 实例源码位置不同时，把下面的 file:// 路径改为对应 deepseek-harness 仓库路径。
import { defineTool } from 'file:///work/deepseek-harness/packages/core/tools/lib/index.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

export const name = 'template-dsh-protocol-runner';
export const inject = ['tools', 'systemPrompt'];

function taskFromEnv() {
  const file = process.env.DSH_TASK_FILE;
  if (!file) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function absolutePath(path) {
  return resolve(process.cwd(), path);
}

function writeDomainPaths(task) {
  return Array.isArray(task?.writeDomain?.paths) ? task.writeDomain.paths : [];
}

function insideWriteDomain(path, task) {
  const abs = absolutePath(path);
  return writeDomainPaths(task).some((p) => {
    const root = absolutePath(p);
    return abs === root || abs.startsWith(root + sep);
  });
}

function resultFile(task) {
  const id = task?.taskId || task?.unitId || 'unknown';
  return process.env.DSH_RESULT_FILE || resolve(process.cwd(), 'state', 'executor-traces', id, 'result.json');
}

function allowedTools() {
  const raw = process.env.DSH_ALLOWED_TOOLS || '';
  return raw.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
}

function preflightHints(task) {
  const list = Array.isArray(task?.preflightAssertions) ? task.preflightAssertions : [];
  return list
    .map((a, i) => {
      if (a?.kind === 'command' && a.command) return `- [P${i + 1}] command: ${a.command}`;
      if (a?.kind === 'file' && a.path) return `- [P${i + 1}] file ${a.path} mustExist=${a.mustExist}`;
      return null;
    })
    .filter(Boolean);
}

function taskContractText(task, preflightActive) {
  if (!task) return '# protocol-runner unit\n\n未发现 TaskPackage。';
  const input = Array.isArray(task.context?.inputContract)
    ? task.context.inputContract
      .map((d) => `- ${d.path}${d.schemaRef ? ` (schema: ${d.schemaRef})` : ''}`)
      .join('\n')
    : '';
  const steps = Array.isArray(task.steps)
    ? task.steps.map((s) => `- [ ] ${s.id}: ${s.instruction}${s.mechanizedCommand ? ` (command: ${s.mechanizedCommand})` : ''}`).join('\n')
    : '';
  const boundary = task.context?.boundary;
  const hints = preflightHints(task);
  return [
    `# protocol-runner unit: ${task.unitId || ''}`,
    `## 目标`,
    task.context?.goal || '',
    '## 输入契约（只消费这些交付物）',
    input || '- 无',
    '## 写域（只写这些路径，越界即失败）',
    ...writeDomainPaths(task).map((p) => `- ${p}`),
    '## 步骤清单',
    steps || '- 无',
    '## 边界规则',
    `- 允许编辑: ${boundary?.allowedEdits?.join(', ') || '无'}`,
    `- 禁止编辑: ${boundary?.notAllowedEdits?.join(', ') || '无'}`,
    `- 可 escalation 类型: ${boundary?.escalationTypes?.join(', ') || '无'}`,
    `## 版本与环境`,
    `- 项目版本: ${task.version || ''}`,
    `- 静态环境: ${task.context?.staticEnv?.envId || ''}`,
    `- 运行时环境健康: ${task.context?.runtimeEnv?.healthy ? '是' : '否'}`,
    `## 预检信号（${preflightActive
      ? 'P2：已安装为 loop 内 preflight Verifier；开始执行前先运行 protocol_runner_preflight，任一条 passed=false 时按 run.stderrTail 修正后重跑'
      : 'P1：仅提示，不执行；权威 acceptance 在 protocol-runner 子任务边界'}）`,
    ...(preflightActive ? ['- 先运行 protocol_runner_preflight 逐条获取预检信号；全部 passed 后再继续。'] : []),
    ...(hints.length > 0 ? hints : ['- 本任务未声明预检断言。']),
  ].filter((line) => line !== '' || line.startsWith('- ')).join('\n');
}

export function apply(ctx) {
  const task = taskFromEnv();
  const metrics = {
    toolCalls: 0,
    deniedCalls: 0,
    writeViolations: 0,
    preflightExecuted: 0,
    preflightFailed: 0,
  };
  const bridgeUrl = process.env.DSH_PREFLIGHT_BRIDGE_URL;
  const bridgeToken = process.env.DSH_PREFLIGHT_BRIDGE_TOKEN ?? '';
  const failedPreflightIndexes = new Set();

  ctx.systemPrompt.section({
    name: 'protocol-runner:unit-contract',
    order: 70,
    text: () => taskContractText(task, !!bridgeUrl),
  });

  ctx.tools.register(defineTool({
    name: 'protocol_runner_finish',
    description: '完成当前 protocol-runner 单元任务，写出结构化账本 result.json 并结束本轮。',
    parameters: {
      summary: { type: 'string', required: true, description: '完成摘要' },
      artifacts: {
        type: 'array',
        items: { type: 'string' },
        description: '写域内产出的相对路径列表',
      },
      facts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            subject: { type: 'string' },
            kind: { type: 'string', enum: ['observation', 'constraint', 'risk', 'assumption'] },
            detail: { type: 'string' },
          },
        },
        description: '事实账本（客观：发现了什么）',
      },
      effects: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string' },
            op: { type: 'string', enum: ['create', 'modify', 'delete'] },
            note: { type: 'string' },
          },
        },
        description: '效应账本（客观：改了什么，必须都在写域内）',
      },
      openItems: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            kind: { type: 'string', enum: ['next-step', 'unresolved-question', 'blocker'] },
            summary: { type: 'string' },
            confidence: { type: 'number' },
          },
        },
        description: '未决项（主观，供外部系统裁决）',
      },
      cost: {
        type: 'object',
        additionalProperties: false,
        properties: {
          modelCalls: { type: 'number' },
          inputTokens: { type: 'number' },
          outputTokens: { type: 'number' },
          toolCalls: { type: 'number' },
          wallClockMs: { type: 'number' },
          loop: {
            type: 'object',
            additionalProperties: false,
            properties: { iterations: { type: 'number' }, corrections: { type: 'number' } },
          },
        },
        description: '成本账本（AI 调用/近似 token/工具调用/墙钟）',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          unitId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          artifacts: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `unit ${value.unitId} ${value.status}` }],
    },
    async execute(args, exec) {
      const artifactPaths = Array.isArray(args.artifacts) ? args.artifacts.filter(Boolean) : [];
      for (const path of artifactPaths) {
        if (!insideWriteDomain(path, task)) {
          return {
            taskId: task?.taskId || null,
            unitId: task?.unitId || 'unknown',
            status: 'rejected',
            artifacts: [],
          };
        }
      }
      const effects = Array.isArray(args.effects) ? args.effects : [];
      for (const effect of effects) {
        if (typeof effect?.path === 'string' && !insideWriteDomain(effect.path, task)) {
          return {
            taskId: task?.taskId || null,
            unitId: task?.unitId || 'unknown',
            status: 'rejected',
            artifacts: [],
          };
        }
      }
      const file = resultFile(task);
      mkdirSync(dirname(file), { recursive: true });
      const result = {
        schemaVersion: '1.0',
        taskId: task?.taskId || null,
        unitId: task?.unitId || 'unknown',
        status: 'completed',
        summary: args.summary,
        artifacts: artifactPaths,
        facts: Array.isArray(args.facts) ? args.facts : [],
        effects,
        openItems: Array.isArray(args.openItems) ? args.openItems : [],
        cost: typeof args.cost === 'object' && args.cost ? args.cost : undefined,
        metrics,
        wroteAt: new Date().toISOString(),
      };
      writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
      exec.concludeTurn();
      return {
        taskId: result.taskId,
        unitId: result.unitId,
        status: result.status,
        artifacts: result.artifacts,
      };
    },
  }));

  if (bridgeUrl) {
    ctx.tools.register(defineTool({
      name: 'protocol_runner_preflight',
      description: '运行一条幂等/只读的 preflight 断言（仅 TaskPackage.preflightAssertions；P1..Pn 见任务契约）。返回 passed 只是预检信号，不能替代 protocol-runner 的外部 acceptance。',
      parameters: {
        assertionIndex: { type: 'number', required: true, description: 'preflightAssertions 的索引（0 起）' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args) {
        metrics.preflightExecuted += 1;
        const index = args.assertionIndex;
        try {
          const res = await fetch(`${bridgeUrl}/run-assertion`, {
            method: 'POST',
            headers: { authorization: `Bearer ${bridgeToken}`, 'content-type': 'application/json' },
            body: JSON.stringify({ assertionIndex: index }),
          });
          const body = await res.json();
          const run = body?.run;
          if (run && run.ok === false) {
            metrics.preflightFailed += 1;
            failedPreflightIndexes.add(index);
          } else if (run && run.ok === true && failedPreflightIndexes.has(index)) {
            failedPreflightIndexes.delete(index);
            try {
              await fetch(`${bridgeUrl}/report-correction`, {
                method: 'POST',
                headers: { authorization: `Bearer ${bridgeToken}`, 'content-type': 'application/json' },
                body: JSON.stringify({ assertionIndex: index }),
              });
            } catch {
              // 修正上报失败不阻断 loop
            }
          }
          const out = { passed: run?.ok === true };
          if (run !== undefined) out.run = run;
          if (body?.error !== undefined) out.error = body.error;
          return out;
        } catch (err) {
          metrics.preflightFailed += 1;
          failedPreflightIndexes.add(index);
          return { passed: false, error: String(err) };
        }
      },
    }));
  }

  ctx.on('agent/session-start', ({ agent }) => {
    const allow = allowedTools();
    if (allow.length > 0) {
      agent.ctx.tools.restrict({ allow });
    }
  });

  ctx.on('tools/pre-execute', async (exec, next) => {
    metrics.toolCalls += 1;
    if (exec.name === 'write' || exec.name === 'edit') {
      const path = exec.arguments && typeof exec.arguments === 'object' ? exec.arguments.file_path : undefined;
      if (typeof path === 'string' && !insideWriteDomain(path, task)) {
        metrics.deniedCalls += 1;
        metrics.writeViolations += 1;
        return { kind: 'deny', reason: `outside protocol-runner write domain: ${path}` };
      }
    }
    return next();
  });
}
