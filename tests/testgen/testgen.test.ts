import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProtocolContent } from '../../src/parser/index.js';
import { specify, specsFromEnvelope } from '../../src/specifier/index.js';
import { generateTestTool } from '../../src/testgen/index.js';

const FIXTURES = join(process.cwd(), 'tests/fixtures');
function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf-8');
}

describe('testgen', () => {
  describe('protocol-model.ts 生成', () => {
    const model = parseProtocolContent(readFixture('approval-flow.md'));
    const specs = specsFromEnvelope(specify(model));
    const testTool = generateTestTool(model, specs, undefined, undefined, {});

    test('导出协议元数据常量', async () => {
      const code = (await testTool).protocolModel;
      expect(code).toContain('PROTOCOL_NAME');
      expect(code).toContain('PROTOCOL_VERSION');
      expect(code).toContain('审批流协议');
      expect(code).toContain('1.0.0');
    });

    test('导出 STATES 与 TRANSITIONS', async () => {
      const code = (await testTool).protocolModel;
      expect(code).toContain('export const STATES');
      expect(code).toContain('export const TRANSITIONS');
      // 含审批流的状态 ID
      expect(code).toContain('S1');
      expect(code).toContain('S5');
    });

    test('导出 INITIAL_STATE_ID 与 TERMINAL_STATE_IDS', async () => {
      const code = (await testTool).protocolModel;
      expect(code).toContain('INITIAL_STATE_ID');
      expect(code).toContain('TERMINAL_STATE_IDS');
      expect(code).toContain('S3');
    });

    test('导出 STATE_BY_ID 索引', async () => {
      const code = (await testTool).protocolModel;
      expect(code).toContain('STATE_BY_ID');
    });

    test('导出 TRANSITIONS_BY_FROM 索引（按 from 状态分组）', async () => {
      const code = (await testTool).protocolModel;
      expect(code).toContain('TRANSITIONS_BY_FROM');
    });

    test('导出 TRANSITION_BY_ACTION 索引', async () => {
      const code = (await testTool).protocolModel;
      expect(code).toContain('TRANSITION_BY_ACTION');
      // 含 submit 动作
      expect(code).toContain('submit');
    });
  });

  describe('scenario-loader.ts 生成', () => {
    const model = parseProtocolContent(readFixture('approval-flow.md'));
    const specs = specsFromEnvelope(specify(model));
    const testTool = generateTestTool(model, specs, undefined, undefined, {});

    test('导出 Scenario 接口', async () => {
      const code = (await testTool).scenarioLoader;
      expect(code).toContain('interface Scenario');
      expect(code).toContain('id:');
      expect(code).toContain('expectedActions:');
      expect(code).toContain('expectedFinalState:');
    });

    test('导出 loadScenarios 函数', async () => {
      const code = (await testTool).scenarioLoader;
      expect(code).toContain('loadScenarios');
      expect(code).toContain('scenariosDir');
    });

    test('使用 yaml 解析 YAML 文件', async () => {
      const code = (await testTool).scenarioLoader;
      expect(code).toContain("from 'yaml'");
      expect(code).toContain('parseYaml');
    });
  });

  describe('protocol-executor.ts 生成', () => {
    const model = parseProtocolContent(readFixture('approval-flow.md'));
    const specs = specsFromEnvelope(specify(model));
    const testTool = generateTestTool(model, specs, undefined, undefined, {});

    test('导出 ProtocolImplementation 接口', async () => {
      const code = (await testTool).protocolExecutor;
      expect(code).toContain('interface ProtocolImplementation');
      // 含系统接口对应的方法
      expect(code).toContain('submit:');
      expect(code).toContain('approve:');
    });

    test('导出 executeAction 函数', async () => {
      const code = (await testTool).protocolExecutor;
      expect(code).toContain('executeAction');
      expect(code).toContain('TRANSITION_BY_ACTION');
    });

    test('导出 executeScenario 函数', async () => {
      const code = (await testTool).protocolExecutor;
      expect(code).toContain('executeScenario');
      expect(code).toContain('INITIAL_STATE_ID');
    });

    test('导出 executePath 函数（用于自动生成用例）', async () => {
      const code = (await testTool).protocolExecutor;
      expect(code).toContain('executePath');
      expect(code).toContain('transitionIds');
    });

    test('执行器校验当前状态与转移源一致', async () => {
      const code = (await testTool).protocolExecutor;
      expect(code).toContain('transition.from.includes(ctx.currentState)');
      expect(code).toContain('与协议预期');
    });
  });

  describe('consistency-asserter.ts 生成', () => {
    const model = parseProtocolContent(readFixture('approval-flow.md'));
    const specs = specsFromEnvelope(specify(model));
    const testTool = generateTestTool(model, specs, undefined, undefined, {});

    test('导出 ConsistencyResult 接口', async () => {
      const code = (await testTool).consistencyAsserter;
      expect(code).toContain('interface ConsistencyResult');
      expect(code).toContain('passed:');
      expect(code).toContain('finalState:');
    });

    test('导出 assertConsistency 函数', async () => {
      const code = (await testTool).consistencyAsserter;
      expect(code).toContain('assertConsistency');
    });

    test('导出 assertTerminalReached 函数', async () => {
      const code = (await testTool).consistencyAsserter;
      expect(code).toContain('assertTerminalReached');
      expect(code).toContain('TERMINAL_STATE_IDS');
    });

    test('断言器引用 INVARIANTS 进行不变量检查', async () => {
      const code = (await testTool).consistencyAsserter;
      expect(code).toContain('INVARIANTS');
    });
  });

  describe('生成代码的有效性', () => {
    test('生成的代码是合法 TypeScript 语法（基本结构）', async () => {
      const model = parseProtocolContent(readFixture('approval-flow.md'));
      const specs = specsFromEnvelope(specify(model));
      const testTool = await generateTestTool(model, specs, undefined, undefined, {});
      // 检查基本结构特征
      expect(testTool.protocolModel).toMatch(/export const/);
      expect(testTool.scenarioLoader).toMatch(/export function/);
      expect(testTool.protocolExecutor).toMatch(/export (function|interface)/);
      expect(testTool.consistencyAsserter).toMatch(/export (function|interface)/);
    });

    test('生成时间戳存在', async () => {
      const model = parseProtocolContent(readFixture('approval-flow.md'));
      const specs = specsFromEnvelope(specify(model));
      const testTool = await generateTestTool(model, specs, undefined, undefined, {});
      expect(testTool.generatedAt).toBeTruthy();
      // ISO 时间戳格式
      expect(testTool.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('退化模式生成', () => {
    test('退化协议仍可生成测试工具', async () => {
      const model = parseProtocolContent(readFixture('degraded-protocol.md'));
      const specs = specsFromEnvelope(specify(model));
      const testTool = await generateTestTool(model, specs, undefined, undefined, {});
      expect(testTool.protocolModel).toContain('PROTOCOL_NAME');
      // 退化协议只有 1 个状态 S1
      expect(testTool.protocolModel).toContain('S1');
    });
  });
});
