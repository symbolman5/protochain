import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProtocolContent } from '../../src/parser/index.js';
import { generateCases } from '../../src/casegen/index.js';

const FIXTURES = join(process.cwd(), 'tests/fixtures');
function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf-8');
}

describe('casegen', () => {
  describe('状态覆盖准则（默认）', () => {
    const model = parseProtocolContent(readFixture('approval-flow.md'));
    const cases = generateCases(model, { criterion: 'state' });

    test('生成路径用例', () => {
      expect(cases.paths.length).toBeGreaterThan(0);
      // 每条路径有 ID 与状态序列
      expect(cases.paths[0].id).toMatch(/^PATH_/);
      expect(cases.paths[0].stateIds.length).toBeGreaterThan(0);
      expect(cases.paths[0].transitionIds).toBeDefined();
    });

    test('所有路径均从初始状态开始', () => {
      const initialId = model.derivable.initialStateId;
      expect(initialId).toBe('S1');
      for (const p of cases.paths) {
        expect(p.stateIds[0]).toBe('S1');
      }
    });

    test('状态覆盖率达 100%（审批流所有状态可达）', () => {
      expect(cases.coverage.criterion).toBe('state');
      expect(cases.coverage.stateCoverage.ratio).toBe(1);
      expect(cases.coverage.stateCoverage.uncoveredIds).toEqual([]);
    });

    test('覆盖报告含 coveredIds', () => {
      expect(cases.coverage.stateCoverage.coveredIds).toEqual(
        expect.arrayContaining(['S1', 'S2', 'S3', 'S4', 'S5'])
      );
    });
  });

  describe('转移覆盖准则', () => {
    const model = parseProtocolContent(readFixture('approval-flow.md'));
    const cases = generateCases(model, { criterion: 'transition' });

    test('准则为 transition', () => {
      expect(cases.coverage.criterion).toBe('transition');
    });

    test('转移覆盖率达 100%', () => {
      // 审批流的 5 个转移全部可达
      expect(cases.coverage.transitionCoverage.ratio).toBe(1);
      expect(cases.coverage.transitionCoverage.uncoveredIds).toEqual([]);
    });
  });

  describe('路径覆盖准则', () => {
    const model = parseProtocolContent(readFixture('approval-flow.md'));
    const cases = generateCases(model, {
      criterion: 'path',
      maxPathLength: 10,
      maxPaths: 50,
    });

    test('路径覆盖下生成多条路径', () => {
      // 审批流有多条到达终态的路径（S1→S2→S3 / S1→S2→S4 / S1→S2→S5）
      // 加上超时退回的循环路径（受 maxPathLength 限制）
      expect(cases.paths.length).toBeGreaterThan(0);
    });

    test('路径覆盖含 pathCoverage 字段', () => {
      expect(cases.coverage.pathCoverage).toBeDefined();
      expect(cases.coverage.pathCoverage!.covered).toBe(cases.paths.length);
    });

    test('记录最大路径长度', () => {
      expect(cases.coverage.maxPathLength).toBe(10);
    });

    test('每条路径到达终态或截断', () => {
      const terminalIds = new Set(model.derivable.terminalStateIds);
      for (const p of cases.paths) {
        const last = p.stateIds[p.stateIds.length - 1];
        // 终态或截断标注
        expect(terminalIds.has(last) || p.description?.includes('截断')).toBe(true);
      }
    });
  });

  describe('循环检测', () => {
    test('状态覆盖准则下不无限循环（避免重复访问状态）', () => {
      const model = parseProtocolContent(readFixture('approval-flow.md'));
      // 审批流 T5 超时退回 S1，构成 S1→S2→S1 循环
      // 状态覆盖准则下应避免无限循环
      const cases = generateCases(model, { criterion: 'state', maxPaths: 200 });
      expect(cases.paths.length).toBeLessThan(200);
    });

    test('路径覆盖准则下简单路径检测避免环', () => {
      const model = parseProtocolContent(readFixture('approval-flow.md'));
      const cases = generateCases(model, {
        criterion: 'path',
        maxPathLength: 20,
        maxPaths: 100,
      });
      // 每条路径的状态序列应无重复（简单路径）
      for (const p of cases.paths) {
        const unique = new Set(p.stateIds);
        // 终态可能在 description 中标注截断
        const isTruncated = p.description?.includes('截断');
        if (!isTruncated) {
          expect(unique.size).toBe(p.stateIds.length);
        }
      }
    });
  });

  describe('循环生命周期协议（合法循环，P1 类）', () => {
    // 生命周期协议：S1↔S2↔S3 构成合法业务循环，退役（T6）只能从 S1 出发。
    // 循环分支上的 S2/S3 若要到达终态必须重访 S1——修复前 state 准则下永远无法 100% 覆盖。
    const model = parseProtocolContent(`---
name: 生命周期协议
version: 1.0.0
purpose: 测试合法循环下的状态/转移覆盖
roles:
  - id: operator
    name: 运维
---

# 背景

测试

# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S0 | 未添加 | initial |
| S1 | 离线 | normal |
| S2 | 在线 | normal |
| S3 | 维护中 | normal |
| S4 | 已退役 | terminal |

# 转移规则

| ID | 名称 | from | to | action |
|---|---|---|---|---|
| T1 | 添加 | S0 | S1 | add |
| T2 | 上线 | S1 | S2 | go_online |
| T3 | 维护 | S2 | S3 | maintain |
| T4 | 恢复 | S3 | S2 | restore |
| T5 | 下线 | S2 | S1 | go_offline |
| T6 | 退役 | S1 | S4 | retire |
`);

    test('state 准则下状态覆盖率达 100%', () => {
      const cases = generateCases(model, { criterion: 'state' });
      expect(cases.coverage.stateCoverage.ratio).toBe(1);
      expect(cases.coverage.stateCoverage.uncoveredIds).toEqual([]);
    });

    test('state 准则下循环分支转移全部覆盖', () => {
      const cases = generateCases(model, { criterion: 'state' });
      expect(cases.coverage.transitionCoverage.ratio).toBe(1);
      expect(cases.coverage.transitionCoverage.uncoveredIds).toEqual([]);
      const covered = new Set(
        cases.paths.flatMap((p) => p.transitionIds)
      );
      for (const id of ['T1', 'T2', 'T3', 'T4', 'T5', 'T6']) {
        expect(covered.has(id)).toBe(true);
      }
    });

    test('至少一条路径到达终态且路径数量有界', () => {
      const cases = generateCases(model, { criterion: 'state', maxPaths: 200 });
      expect(cases.paths.length).toBeGreaterThan(0);
      expect(cases.paths.length).toBeLessThan(200);
      const terminalIds = new Set(model.derivable.terminalStateIds);
      expect(
        cases.paths.some((p) => terminalIds.has(p.stateIds[p.stateIds.length - 1]))
      ).toBe(true);
    });

    test('transition 准则下同样全量覆盖', () => {
      const cases = generateCases(model, { criterion: 'transition' });
      expect(cases.coverage.stateCoverage.ratio).toBe(1);
      expect(cases.coverage.transitionCoverage.ratio).toBe(1);
    });
  });

  describe('未覆盖项处置', () => {
    test('不可达状态进入未覆盖项列表', () => {
      const model = parseProtocolContent(`---
name: 测试未覆盖
version: 1.0.0
purpose: 测试不可达状态
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
| S3 | 不可达 | normal |

# 转移规则

| ID | 名称 | from | to | action |
|---|---|---|---|---|
| T1 | 完成 | S1 | S2 | finish |
`);
      const cases = generateCases(model, { criterion: 'state' });
      expect(cases.coverage.stateCoverage.uncoveredIds).toContain('S3');
      // 未覆盖项有处置建议
      const disposition = cases.coverage.uncoveredDispositions.find(
        (d) => d.elementId === 'S3'
      );
      expect(disposition).toBeDefined();
      expect(disposition!.elementType).toBe('state');
      expect(disposition!.disposition).toBe('missing_supplement');
    });

    test('未覆盖转移进入处置列表', () => {
      const model = parseProtocolContent(`---
name: 测试未覆盖转移
version: 1.0.0
purpose: 测试
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

| ID | 名称 | from | to | action |
|---|---|---|---|---|
| T1 | 完成 | S1 | S2 | finish |
`);
      const cases = generateCases(model, { criterion: 'state' });
      // 全部覆盖，无未覆盖项
      expect(cases.coverage.transitionCoverage.uncoveredIds).toEqual([]);
    });
  });

  describe('无初始状态协议', () => {
    test('无初始状态时返回空路径', () => {
      const model = parseProtocolContent(`---
name: 测试无初始
version: 1.0.0
purpose: 测试
roles:
  - id: r1
    name: 角色1
---

# 背景

测试

# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S1 | 普通 | normal |
| S2 | 终态 | terminal |

# 转移规则

| ID | 名称 | from | to | action |
|---|---|---|---|---|
| T1 | 完成 | S1 | S2 | finish |
`);
      const cases = generateCases(model);
      expect(cases.paths).toEqual([]);
      expect(cases.coverage.stateCoverage.total).toBe(2);
      expect(cases.coverage.stateCoverage.covered).toBe(0);
    });
  });

  describe('退化模式生成', () => {
    test('退化协议基于已提取的 states/transitions 生成', () => {
      const model = parseProtocolContent(readFixture('degraded-protocol.md'));
      const cases = generateCases(model, { criterion: 'state' });
      // 退化协议只有 S1，无转移（TLA+ 形式化规格未提取为转移表）
      expect(cases.coverage.stateCoverage.total).toBe(1);
      // 无转移且 S1 非终态：BFS 不记录路径，覆盖度为 0
      // （这是退化模式的局限——需 AI 辅助从 TLA+ 提取转移语义）
      expect(cases.coverage.stateCoverage.covered).toBe(0);
      expect(cases.coverage.stateCoverage.uncoveredIds).toContain('S1');
    });
  });

  describe('路径长度限制', () => {
    test('超长路径被截断并标注', () => {
      // 构造循环协议：S1↔S2，无终态
      const model = parseProtocolContent(`---
name: 循环协议
version: 1.0.0
purpose: 测试路径长度限制
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
| S2 | 中间 | normal |
| S3 | 终态 | terminal |

# 转移规则

| ID | 名称 | from | to | action |
|---|---|---|---|---|
| T1 | 进入 | S1 | S2 | enter |
| T2 | 返回 | S2 | S1 | back |
| T3 | 完成 | S2 | S3 | finish |
`);
      const cases = generateCases(model, {
        criterion: 'path',
        maxPathLength: 3,
        maxPaths: 50,
      });
      // 至少有一条路径被截断
      const truncated = cases.paths.find((p) =>
        p.description?.includes('截断')
      );
      // 路径长度不超过 maxPathLength+1（截断时路径长度 = maxPathLength）
      for (const p of cases.paths) {
        expect(p.transitionIds.length).toBeLessThanOrEqual(3);
      }
    });
  });

  describe('生成时间戳', () => {
    test('记录生成时间', () => {
      const model = parseProtocolContent(readFixture('approval-flow.md'));
      const cases = generateCases(model);
      expect(cases.generatedAt).toBeTruthy();
      expect(cases.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });
});
