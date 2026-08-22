import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProtocolContent } from '../../src/parser/index.js';
import { specify, specsFromEnvelope } from '../../src/specifier/index.js';
import type { SourceProtocolModel } from '../../src/model/types.js';

const FIXTURES = join(process.cwd(), 'tests/fixtures');
function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf-8');
}

describe('specifier', () => {
  describe('正常模式推导', () => {
    const model = parseProtocolContent(readFixture('approval-flow.md'));
    const specs = specsFromEnvelope(specify(model)); // E2-I6 修复：specs 走 .specs 提取

    test('为每个转移生成系统接口', () => {
      const systemSpecs = specs.filter((s) => s.kind === 'system');
      // 审批流有 5 个转移
      expect(systemSpecs.length).toBe(model.derivable.transitions.length);
      // 接口 ID 形如 IF_SYS_<transitionId>
      expect(systemSpecs.some((s) => s.id === 'IF_SYS_T1')).toBe(true);
      expect(systemSpecs.some((s) => s.id === 'IF_SYS_T5')).toBe(true);
    });

    test('系统接口 sourceId 与 action 一致', () => {
      const submitSpec = specs.find((s) => s.sourceId === 'submit');
      expect(submitSpec).toBeDefined();
      expect(submitSpec!.name).toBe('submit');
      expect(submitSpec!.kind).toBe('system');
    });

    test('系统接口包含 currentState 输入', () => {
      const sysSpec = specs.find((s) => s.kind === 'system')!;
      const currentStateInput = sysSpec.inputs.find((i) => i.name === 'currentState');
      expect(currentStateInput).toBeDefined();
      expect(currentStateInput!.required).toBe(true);
    });

    test('系统接口投影 guard 为 precondition（E2-I2 修复：单标识符 guard 标 legacy-stub，不入 requestSchema 必填）', () => {
      const submitSpec = specs.find((s) => s.sourceId === 'submit')!;
      expect(submitSpec.precondition).toBe('form_valid');
      // E2-I2 修复：form_valid 是单标识符谓词，不应作为请求输入字段
      // （谓词本身就是 guard 表达式，不是请求参数）
      expect(submitSpec.inputs.some((i) => i.name === 'form_valid')).toBe(false);
      // 但 precondition 仍记为 description，含原 guard 文本
      expect(submitSpec.preconditions?.[0]?.kind).toBe('legacy-stub');
      expect(submitSpec.preconditions?.[0]?.description).toContain('form_valid');
    });

    test('系统接口投影 effects 为 postconditions', () => {
      const submitSpec = specs.find((s) => s.sourceId === 'submit')!;
      expect(submitSpec.postconditions).toContain('create_request');
      expect(submitSpec.postconditions).toContain('notify_approver');
      // effects 也作为输出字段
      const effectsOutput = submitSpec.outputs.find((o) => o.name === 'effects');
      expect(effectsOutput).toBeDefined();
    });

    test('为每个状态生成观测接口', () => {
      const stateObs = specs.filter(
        (s) => s.kind === 'observation' && s.id.startsWith('IF_OBS_STATE_')
      );
      expect(stateObs.length).toBe(model.derivable.states.length);
      // 含 isInState 输出
      const obs = stateObs[0];
      expect(obs.outputs.some((o) => o.name === 'isInState')).toBe(true);
    });

    test('为每个不变量生成观测接口', () => {
      const invObs = specs.filter(
        (s) => s.kind === 'observation' && s.id.startsWith('IF_OBS_INV_')
      );
      expect(invObs.length).toBe(model.derivable.invariants.length);
      // 含 holds 输出
      expect(invObs[0].outputs.some((o) => o.name === 'holds')).toBe(true);
      // invariantIds 关联
      expect(invObs[0].invariantIds).toBeDefined();
    });

    test('无 AI 时无 degradedAssist 标注', () => {
      const flagged = specs.filter((s) => s.degradedAssist);
      expect(flagged.length).toBe(0);
    });
  });

  describe('退化模式推导', () => {
    const model = parseProtocolContent(readFixture('degraded-protocol.md'));
    expect(model.derivable.degraded).toBe(true);

    test('退化模式下标注 degradedAssist', () => {
      const specs = specsFromEnvelope(specify(model, { degradedAIAssist: true }));
      // 至少有一个被标注
      expect(specs.some((s) => s.degradedAssist === true)).toBe(true);
    });

    test('退化模式下不开启 AI 辅助时不标注', () => {
      const specs = specsFromEnvelope(specify(model, { degradedAIAssist: false }));
      expect(specs.every((s) => !s.degradedAssist)).toBe(true);
    });

    test('TLA+ 形式化规格中的 ACTIONS 被提取为系统接口', () => {
      const specs = specsFromEnvelope(specify(model, { degradedAIAssist: true }));
      // TLA+ 规格中存在 Next 等动作定义，应被提取（除非已在 transitions 中）
      // degraded-protocol.md 的 TLA+ 中包含 Init/Next 等保留名（被排除）
      // 验证提取不会重复已有的接口
      const systemSpecs = specs.filter((s) => s.kind === 'system');
      // 不应有重复 id
      const ids = systemSpecs.map((s) => s.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });
  });

  describe('guard 参数提取', () => {
    test('复杂 guard 表达式提取多个参数', () => {
      const model = parseProtocolContent(`---
name: 测试
version: 1.0.0
purpose: 测试 guard 参数提取
roles:
  - id: r1
    name: 角色1
---

# 背景

测试

# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S1 | 初始 | initial |
| S2 | 终态 | terminal |

# 转移规则

| ID | 名称 | from | to | action | trigger | guard |
|---|---|---|---|---|---|---|
| T1 | 转移 | S1 | S2 | doSomething | r1 | user_id > 0 and role == "admin" |
`);
      const specs = specsFromEnvelope(specify(model));
      const sysSpec = specs.find((s) => s.kind === 'system')!;
      // 应提取出 user_id 与 role（关键字 and 被排除）
      const inputNames = sysSpec.inputs.map((i) => i.name);
      expect(inputNames).toContain('user_id');
      expect(inputNames).toContain('role');
      // and 是关键字，不应作为参数
      expect(inputNames).not.toContain('and');
    });
  });
});
