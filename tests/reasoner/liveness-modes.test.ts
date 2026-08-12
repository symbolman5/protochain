/**
 * 活性模式判定测试 —— 对应工具链问题清单 #7
 *
 * 验证：
 * - 弱活性（终态可达）/ 强活性（全路径终达）的代码确定性判定
 * - 代码主导、AI 仅复核（AI 结论无法推翻代码）
 * - 活性模式解析优先级：CLI > frontmatter > prose > 默认 weak
 */

import { parseProtocolContent } from '../../src/parser/index.js';
import { reason } from '../../src/reasoner/index.js';
import type { AIAdapter, AIPrompt, AIResponse } from '../../src/model/types.js';

class MockAIAdapter implements AIAdapter {
  name = 'mock';
  constructor(
    private livenessPassed: boolean,
    private succeed = true
  ) {}
  async complete(_prompt: AIPrompt): Promise<AIResponse> {
    return {
      content: JSON.stringify({
        reachability: { passed: true, unreachableStates: [], unreachableTransitions: [], notes: 'AI 复核' },
        deadlock: { passed: true, deadlockStates: [], notes: 'AI 复核' },
        liveness: { passed: this.livenessPassed, violations: [], notes: 'AI 复核' },
        consistency: { passed: true, violations: [], notes: 'AI 复核' },
      }),
      success: this.succeed,
      attempts: 1,
    };
  }
}

// 含停用/启用循环（S1↔S2）且有出口到终态 S3 的设备管理模型
const CYCLIC_MODEL = `
# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S0 | 未启用 | initial |
| S1 | 已启用 | normal |
| S2 | 已停用 | normal |
| S3 | 已注销 | terminal |

# 转移规则

| ID | 名称 | from | to | action |
|---|---|---|---|---|
| T0 | 启用 | S0 | S1 | enable |
| T1 | 停用 | S1 | S2 | disable |
| T2 | 重新启用 | S2 | S1 | enable |
| T3 | 注销 | S1 | S3 | deregister |
`;

function buildModel(frontmatter: string, body: string, background = ''): string {
  return `---
${frontmatter}---
# 背景
${background}
${body}`;
}

const CYCLIC_FM = `name: 设备管理
version: 1.0.0
purpose: 测试活性
roles:
  - id: sys
    name: 系统
`;

describe('活性模式判定（#7）', () => {
  describe('代码确定性判定', () => {
    test('线性模型：弱/强活性均通过', async () => {
      const model = parseProtocolContent(
        buildModel(
          CYCLIC_FM,
          `# 状态空间
| ID | 名称 | 类型 |
|---|---|---|
| S1 | 初态 | initial |
| S2 | 终态 | terminal |
# 转移规则
| ID | 名称 | from | to | action |
|---|---|---|---|---|
| T1 | 走 | S1 | S2 | go |`
        )
      );
      const weak = await reason(model, new MockAIAdapter(true), { liveness: 'weak' });
      expect(weak.liveness.passed).toBe(true);
      expect(weak.liveness.mode).toBe('weak');

      const strong = await reason(model, new MockAIAdapter(true), { liveness: 'strong' });
      expect(strong.liveness.passed).toBe(true);
      expect(strong.liveness.mode).toBe('strong');
    });

    test('含循环且有出口：弱活性通过、强活性违反', async () => {
      const model = parseProtocolContent(buildModel(CYCLIC_FM, CYCLIC_MODEL));

      const weak = await reason(model, new MockAIAdapter(true), { liveness: 'weak' });
      expect(weak.liveness.passed).toBe(true);
      expect(weak.liveness.mode).toBe('weak');

      const strong = await reason(model, new MockAIAdapter(false), { liveness: 'strong' });
      expect(strong.liveness.passed).toBe(false);
      expect(strong.liveness.violations.length).toBeGreaterThan(0);
      expect(strong.liveness.mode).toBe('strong');
      expect(strong.passed).toBe(false);
    });

    test('可达状态无法到达终态：弱活性违反', async () => {
      // S1 是可达非终态死胡同（无终态可达），弱活性失败
      const model = parseProtocolContent(
        buildModel(
          CYCLIC_FM,
          `# 状态空间
| ID | 名称 | 类型 |
|---|---|---|
| S0 | 初态 | initial |
| S1 | 死胡同 | normal |
| S2 | 终态 | terminal |
# 转移规则
| ID | 名称 | from | to | action |
|---|---|---|---|---|
| T0 | 进死胡同 | S0 | S1 | go |
| T1 | 直达终态 | S0 | S2 | finish |`
        )
      );
      const weak = await reason(model, new MockAIAdapter(false), { liveness: 'weak' });
      expect(weak.liveness.passed).toBe(false);
      expect(weak.liveness.violations.some((v) => v.includes('S1'))).toBe(true);
    });
  });

  describe('代码主导、AI 仅复核', () => {
    test('强活性下 AI 误判通过 → 代码否决，报告 liveness 仍为 false', async () => {
      const model = parseProtocolContent(buildModel(CYCLIC_FM, CYCLIC_MODEL));
      // AI 错误地判 liveness 通过（与代码强活性结论相反）
      const report = await reason(model, new MockAIAdapter(true), { liveness: 'strong' });
      expect(report.liveness.passed).toBe(false); // 代码主导，不被 AI 推翻
      expect(report.liveness.notes).toContain('不一致');
      expect(report.liveness.notes).toContain('以代码为准');
    });

    test('弱活性下 AI 与代码一致 → notes 标注复核一致', async () => {
      const model = parseProtocolContent(buildModel(CYCLIC_FM, CYCLIC_MODEL));
      const report = await reason(model, new MockAIAdapter(true), { liveness: 'weak' });
      expect(report.liveness.passed).toBe(true);
      expect(report.liveness.notes).toContain('AI 复核一致');
    });
  });

  describe('活性模式解析优先级', () => {
    test('frontmatter 声明 weak → 弱活性通过', async () => {
      const model = parseProtocolContent(buildModel(CYCLIC_FM + 'liveness: weak\n', CYCLIC_MODEL));
      const report = await reason(model, new MockAIAdapter(true));
      expect(report.liveness.mode).toBe('weak');
      expect(report.liveness.passed).toBe(true);
    });

    test('frontmatter 声明 strong → 强活性违反', async () => {
      const model = parseProtocolContent(buildModel(CYCLIC_FM + 'liveness: strong\n', CYCLIC_MODEL));
      const report = await reason(model, new MockAIAdapter(false));
      expect(report.liveness.mode).toBe('strong');
      expect(report.liveness.passed).toBe(false);
    });

    test('prose 声明"采用弱活性、不采用强活性" → weak', async () => {
      const model = parseProtocolContent(
        buildModel(
          CYCLIC_FM,
          CYCLIC_MODEL,
          '活性语义声明（协议正式定义）：采用弱活性（终态可达）、不采用全路径强活性，循环是合法业务。'
        )
      );
      const report = await reason(model, new MockAIAdapter(true));
      expect(report.liveness.mode).toBe('weak');
      expect(report.liveness.passed).toBe(true);
    });

    test('CLI 选项覆盖 frontmatter 声明', async () => {
      // frontmatter 声明 strong，但 CLI 指定 weak → 按 weak
      const model = parseProtocolContent(buildModel(CYCLIC_FM + 'liveness: strong\n', CYCLIC_MODEL));
      const report = await reason(model, new MockAIAdapter(true), { liveness: 'weak' });
      expect(report.liveness.mode).toBe('weak');
      expect(report.liveness.passed).toBe(true);
    });

    test('未声明 → 默认 weak', async () => {
      const model = parseProtocolContent(buildModel(CYCLIC_FM, CYCLIC_MODEL));
      const report = await reason(model, new MockAIAdapter(true));
      expect(report.liveness.mode).toBe('weak');
    });
  });
});
