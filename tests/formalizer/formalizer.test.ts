import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProtocolContent } from '../../src/parser/index.js';
import {
  TLAAdapter,
  SCXMLAdapter,
  DecisionTableAdapter,
  scoreAllAdapters,
  selectBestAdapter,
  createAllAdapters,
} from '../../src/formalizer/adapters.js';
import { formalize } from '../../src/formalizer/index.js';
import { runTlcOnSpec } from '../../src/formalizer/tlc-runner.js';
import type { AIAdapter, AIPrompt, AIResponse } from '../../src/model/types.js';

// 模拟 TLC 运行器：测试生成骨架语义错误时的降级行为，不依赖宿主 java/tla2tools
jest.mock('../../src/formalizer/tlc-runner.js', () => ({
  ...jest.requireActual('../../src/formalizer/tlc-runner.js'),
  runTlcOnSpec: jest.fn(),
}));

const mockRunTlc = runTlcOnSpec as jest.Mock;

/** 构造 TLC 语义错误输出 */
function tlcSemanticErrorOutput(invariantIds: string[]) {
  return {
    code: 0,
    stdout:
      'Semantic errors:\n*** Errors: 2\n' +
      'Unknown operator: `accept_within_deadline\'.\nUnknown operator: `order_amount\'.',
    stderr: '',
    timedOut: false,
    invariantIds,
  };
}

const FIXTURES = join(process.cwd(), 'tests/fixtures');
function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf-8');
}

class MockAIAdapter implements AIAdapter {
  name = 'mock';
  constructor(private responseContent: string, private succeed = true) {}
  async complete(prompt: AIPrompt): Promise<AIResponse> {
    return { content: this.responseContent, success: this.succeed, attempts: 1 };
  }
}

describe('formalizer adapters', () => {
  describe('detectSuitability 规则化评分', () => {
    test('审批流协议：多角色 + 时序约束 → TLA+ 高分', () => {
      const model = parseProtocolContent(readFixture('approval-flow.md'));
      const scores = scoreAllAdapters(model.derivable);
      const tla = scores.find((s) => s.tool === 'tla')!;
      expect(tla.score).toBeGreaterThan(0.5);
      expect(tla.reasons.length).toBeGreaterThan(0);
    });

    test('简单状态机 → SCXML 高分', () => {
      const model = parseProtocolContent(`---
name: 简单状态机
version: 1.0.0
purpose: 测试
roles:
  - id: r1
    name: 角色
---

# 背景

测试

# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S1 | 初始 | initial |
| S2 | 处理 | normal |
| S3 | 完成 | terminal |

# 转移规则

| ID | 名称 | from | to | action |
|---|---|---|---|---|
| T1 | 开始 | S1 | S2 | start |
| T2 | 完成 | S2 | S3 | finish |
`);
      const scores = scoreAllAdapters(model.derivable);
      const scxml = scores.find((s) => s.tool === 'scxml')!;
      expect(scxml.score).toBeGreaterThan(0.5);
    });

    test('退化模式 TLA+ → TLA+ 评分 1.0', () => {
      const model = parseProtocolContent(readFixture('degraded-protocol.md'));
      const scores = scoreAllAdapters(model.derivable);
      const tla = scores.find((s) => s.tool === 'tla')!;
      expect(tla.score).toBe(1.0);
    });

    test('评分按降序排列', () => {
      const model = parseProtocolContent(readFixture('approval-flow.md'));
      const scores = scoreAllAdapters(model.derivable);
      for (let i = 0; i < scores.length - 1; i++) {
        expect(scores[i].score).toBeGreaterThanOrEqual(scores[i + 1].score);
      }
    });
  });

  describe('selectBestAdapter', () => {
    test('不指定偏好时选最高分', () => {
      const model = parseProtocolContent(readFixture('degraded-protocol.md'));
      const adapters = createAllAdapters();
      const { adapter, score } = selectBestAdapter(model.derivable, adapters);
      expect(adapter.name).toBe('tla');
      expect(score).toBe(1.0);
    });

    test('指定偏好时使用偏好工具', () => {
      const model = parseProtocolContent(readFixture('approval-flow.md'));
      const adapters = createAllAdapters();
      const { adapter } = selectBestAdapter(model.derivable, adapters, 'scxml');
      expect(adapter.name).toBe('scxml');
    });
  });

  describe('TLA+ 适配器', () => {
    test('正常模式生成 TLA+ 骨架', () => {
      const model = parseProtocolContent(readFixture('approval-flow.md'));
      const adapter = new TLAAdapter();
      const spec = adapter.generateSpec(model.derivable);

      expect(spec).toContain('---- MODULE Protocol ----');
      expect(spec).toContain('VARIABLES state');
      expect(spec).toContain('Init ==');
      expect(spec).toContain('Next ==');
      expect(spec).toContain('INV1 ==');
      expect(spec).toContain('INV2 ==');
      expect(spec).toContain('TypeInvariant ==');
      expect(spec).toContain('Spec ==');
      expect(spec).toContain('=====');
    });

    test('退化模式直接返回 formalSpecRaw', () => {
      const model = parseProtocolContent(readFixture('degraded-protocol.md'));
      const adapter = new TLAAdapter();
      const spec = adapter.generateSpec(model.derivable);

      expect(spec).toContain('MODULE ConcurrentProtocol');
      expect(spec).toContain('Init ==');
      expect(spec).toContain('Inv ==');
    });
  });

  describe('SCXML 适配器', () => {
    test('生成 SCXML 骨架', () => {
      const model = parseProtocolContent(readFixture('approval-flow.md'));
      const adapter = new SCXMLAdapter();
      const spec = adapter.generateSpec(model.derivable);

      expect(spec).toContain('<scxml');
      expect(spec).toContain('initial="S1"');
      expect(spec).toContain('<state id="S1"');
      expect(spec).toContain('<transition target="S2" event="submit"');
      expect(spec).toContain('<final id="S3"');
      expect(spec).toContain('</scxml>');
    });
  });

  describe('决策表适配器', () => {
    test('生成决策表 YAML', () => {
      const model = parseProtocolContent(readFixture('approval-flow.md'));
      const adapter = new DecisionTableAdapter();
      const spec = adapter.generateSpec(model.derivable);

      expect(spec).toContain('type: decision-table');
      expect(spec).toContain('columns:');
      expect(spec).toContain('rows:');
      expect(spec).toContain('from: S1');
      expect(spec).toContain('action: submit');
      expect(spec).toContain('invariants:');
    });
  });
});

describe('formalizer 主流程', () => {
  test('审批流协议形式化验证（AI fallback）', async () => {
    const model = parseProtocolContent(readFixture('approval-flow.md'));
    const aiResponse = JSON.stringify({
      results: [
        { invariantId: 'INV1', passed: true },
        { invariantId: 'INV2', passed: true },
      ],
    });
    const adapter = new MockAIAdapter(aiResponse);

    const result = await formalize(model, adapter, { allowAIFallback: true });

    expect(result.report.passed).toBe(true);
    expect(result.report.invariantResults).toHaveLength(2);
    expect(result.report.invariantResults[0]).toEqual({
      invariantId: 'INV1',
      passed: true,
    });
    // 工具名应包含 fallback 标记
    expect(result.report.tool).toContain('fallback');
  });

  test('AI 返回不变量未通过时报告未通过', async () => {
    const model = parseProtocolContent(readFixture('approval-flow.md'));
    const aiResponse = JSON.stringify({
      results: [
        { invariantId: 'INV1', passed: false, counterexample: 'S5 状态下违反请求唯一性' },
        { invariantId: 'INV2', passed: true },
      ],
    });
    const adapter = new MockAIAdapter(aiResponse);

    const result = await formalize(model, adapter);

    expect(result.report.passed).toBe(false);
    expect(result.report.invariantResults[0].passed).toBe(false);
    expect(result.report.invariantResults[0].counterexample).toContain('S5');
  });

  test('退化模式形式化验证', async () => {
    const model = parseProtocolContent(readFixture('degraded-protocol.md'));
    const aiResponse = JSON.stringify({
      results: [{ invariantId: 'Inv', passed: true }],
    });
    const adapter = new MockAIAdapter(aiResponse);

    const result = await formalize(model, adapter);

    expect(result.report.tool).toContain('tla');
    expect(result.report.generatedSpec).toContain('MODULE ConcurrentProtocol');
  });

  test('选择依据包含具体原因', async () => {
    const model = parseProtocolContent(readFixture('approval-flow.md'));
    const aiResponse = JSON.stringify({ results: [] });
    const adapter = new MockAIAdapter(aiResponse);

    const result = await formalize(model, adapter);

    expect(result.selectionReasons.length).toBeGreaterThan(0);
  });

  test('代码生成骨架 TLC 语义错误 → 降级 AI 推演（工具未产出结论，不权威失败）', async () => {
    const model = parseProtocolContent(readFixture('approval-flow.md'));
    mockRunTlc.mockResolvedValue(tlcSemanticErrorOutput(['INV1', 'INV2']));
    const ai = new MockAIAdapter(
      JSON.stringify({
        results: [
          { invariantId: 'INV1', passed: true },
          { invariantId: 'INV2', passed: true },
        ],
      })
    );

    const result = await formalize(model, ai, {
      allowAIFallback: true,
      preferredTool: 'tla', // 强制 TLA 路径，验证生成骨架语义错误 → 降级
      tlc: { javaPath: 'java', tla2toolsJar: 'tla2tools.jar' },
    });

    // 生成骨架未声明守卫/不变量标识符属生成器限制 → 降级，报告标注 fallback
    expect(result.report.tool).toContain('fallback');
    expect(result.report.passed).toBe(true);
    expect(result.report.rawOutput).toContain('Semantic errors');
  });

  test('退化模式 TLA+ 规格语义错误 → 权威失败（不降级 AI）', async () => {
    const model = parseProtocolContent(readFixture('degraded-protocol.md'));
    mockRunTlc.mockResolvedValue({
      code: 0,
      stdout: 'Semantic errors:\n*** Errors: 1\nUnknown operator: `Foo\'.',
      stderr: '',
      timedOut: false,
      invariantIds: ['Inv'],
    });
    const ai = new MockAIAdapter(
      JSON.stringify({ results: [{ invariantId: 'Inv', passed: true }] })
    );

    const result = await formalize(model, ai, {
      allowAIFallback: true,
      tlc: { javaPath: 'java', tla2toolsJar: 'tla2tools.jar' },
    });

    // 用户自写 TLA+ 的语义错误属规格缺陷 → 权威失败，不降级
    expect(result.report.tool).toBe('tla');
    expect(result.report.toolExecuted).toBe(true);
    expect(result.report.passed).toBe(false);
  });
});
