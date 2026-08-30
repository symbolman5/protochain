/**
 * G7-S4（X5 / X6 / X12）对抗性用例生成测试
 *
 * 覆盖（execution-plan.md §S4 机械验收）：
 * - S4-2 用例数 ≤ 理论上限（observed 违例 ≤ observed 维度数；guard 反例 ≤ 全部合取项之和），
 *   差额必须有降级记录（R4）；
 * - S4-3 flaky 自检（R5）：X6 每个用例文件头部含冻结边界声明（mock 掉调度器/定时器），
 *   且连跑 3 次结果一致；
 * - S4-4 X12 用例数与有 remedy.detection 的不变量数相等；detection 缺省者显式降级记录不静默；
 * - S4-5 生成的用例可执行（非空壳）：对两个演示实例（food-delivery / fulfillment-payment）
 *   跑通一遍（parse + generateCases 不崩、结构完整、降级显式）。
 *
 * 生成逻辑用测试 fixture 构造 observed/declared/undetermined 维度 + 契约层 preconditions +
 * remedy 声明验证（真实实例维度 kind 现状：food-delivery 4 维度全 undetermined，fulfillment-payment
 * 无维度，X5 在真实实例上 likely 0 用例）。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { transformSync } from 'esbuild';
import { parseProtocolContent } from '../../src/parser/index.js';
import { generateCases, generateAdversarialCases } from '../../src/casegen/index.js';

const FIXTURES = join(process.cwd(), 'tests/fixtures');

/** S4-3：R5 冻结边界声明关键字（X6 用例文件头部必须含） */
const FREEZE_BOUNDARY_MARKER = 'R5 冻结边界声明';

/** G7-S4 验证 fixture：3 维度（observed/declared/undetermined）+ 契约层 preconditions + remedy */
const FIXTURE_MODEL = `---
name: G7-S4 对抗用例 fixture
version: 1.0.0
purpose: 验证 X5/X6/X12 三类对抗性用例生成
roles:
  - id: operator
    name: 操作员
    roleType: consensus
  - id: system
    name: 系统
    roleType: participant
---

# 背景

验证对抗用例生成。

# 状态空间

| ID | 名称 | 类型 | 描述 | 角色 |
|---|---|---|---|---|
| S0 | 初始 | initial | 初始态 | operator |
| S1 | 运行 | normal | 运行态 | operator |
| S2 | 终态 | terminal | 终态 | operator |

# 转移规则

| ID | 名称 | from | to | action | trigger | guard | effects | triggerType | actionType | affectsDimensions |
|---|---|---|---|---|---|---|---|---|---|---|
| T1 | 启动 | S0 | S1 | start | operator | | | role | state_transition | declared_dim |
| T2 | 完成 | S1 | S2 | finish | operator | 库存充足且订单已确认 | | role | state_transition | |
| T3 | 事实写入 | S1 | S1 | observe_fact | system | | | system | state_transition | observed_dim |

# 不变量

| ID | 名称 | 表达式 | 作用状态 | 声明方 | 不变量类别 | 描述 | remedy | 检测方式 |
|---|---|---|---|---|---|---|---|---|
| INV1 | 观测收敛 | observed_dim == expected | S1 | operator | intra_protocol | 观测值收敛 | 重算观测值 | 对账任务每分钟比对观测值与期望值 |
| INV2 | 处置仅声明 | declared_dim == x | S1 | operator | intra_protocol | 仅声明处置动作 | 重置为初始值 | |
| INV3 | 无补救 | observed_dim != undefined | S1 | operator | intra_protocol | 无 remedy 声明 | | |

# 时序约束

| ID | 名称 | 类型 | 源 | 目标 | 约束值(ms) | 描述 |
|---|---|---|---|---|---|---|
| TM1 | 收敛时限 | timeout | INV1 | INV1 | 60000 | 违约后 60 秒内收敛 |

# 附属实体

\`\`\`yaml
- id: sub_entity
  name: 测试附属实体
  belongsTo: S1（本协议）
  instanceKey: sub_entity.id
  lifecycleDependency: 随主状态生命周期
  stateSpace:
    dimensions:
      - name: observed_dim
        type: enum[a, b]
        initial: a
      - name: declared_dim
        type: enum[x, y]
        initial: x
      - name: undim
        type: string
        initial: ""
\`\`\`

# 契约层

\`\`\`yaml
parties: [operator]
contracts:
  - interface: start
    preconditions:
      - kind: json-schema
        description: 契约层合取项 request_id 非空
        schema:
          type: object
          required: [request_id]
\`\`\`
`;

describe('G7-S4 对抗性用例生成（X5/X6/X12）', () => {
  const model = parseProtocolContent(FIXTURE_MODEL);

  describe('X5 observed 直写违例', () => {
    test('observed 维度生成直写违例用例（≤ observed 维度数，S4-2）', () => {
      const { cases } = generateAdversarialCases(model);
      const x5 = cases.filter((c) => c.kind === 'observed-write');
      // 1 个 observed 维度（observed_dim，由 system 写 → derived）→ 1 条用例
      expect(x5).toHaveLength(1);
      expect(x5[0].expectFailure).toBe(true);
      expect(x5[0].source).toContain('observed_dim');
      expect(x5[0].source).toContain("kind='observed'");
      expect(x5[0].interfaceId).toBe('start'); // role 接口作为直写违例载体
      // 用例正文可执行（非空壳）
      expect(x5[0].body).toContain('expect(res.failed).toBe(true)');
    });

    test('undetermined 维度显式降级记录（差额不静默，R4）', () => {
      const { cases, degradedReasons } = generateAdversarialCases(model);
      const x5 = cases.filter((c) => c.kind === 'observed-write');
      // 理论上限 = observed 维度数 = 1；实际 = 1；差额 0。
      // 但 undim（kind 未判定）显式降级记录——不静默（dimension-kind-undetermined 口径）。
      expect(x5.length).toBeLessThanOrEqual(1);
      expect(
        degradedReasons.some((d) => d.includes('undim') && d.includes('X5 差额'))
      ).toBe(true);
    });

    test('declared 维度不生成 X5 用例（角色可凭意图写，不构成违例）', () => {
      const { cases } = generateAdversarialCases(model);
      const x5 = cases.filter((c) => c.kind === 'observed-write');
      expect(x5.some((c) => c.source.includes('declared_dim'))).toBe(false);
    });
  });

  describe('X6 guard 失败后状态不变', () => {
    test('契约层结构化 preconditions 合取项生成反例（≤ 全部合取项之和）', () => {
      const { cases } = generateAdversarialCases(model);
      const x6 = cases.filter((c) => c.kind === 'guard-failure');
      // 合取项：T1 契约 preconditions(1，可置否) + T2 guard 中文(2，降级) = 3；
      // 可置否仅 T1 → 1 条用例
      expect(x6).toHaveLength(1);
      expect(x6[0].negatedConjunct).toBe(0);
      expect(x6[0].conjunctText).toContain('request_id');
      // 状态不变断言作用于 affectsDimensions 投影
      expect(x6[0].stateImmutableDimensions).toEqual(['declared_dim']);
      expect(x6[0].expectFailure).toBe(true);
    });

    test('自然语言 guard 合取项显式降级（R4 差额）', () => {
      const { degradedReasons } = generateAdversarialCases(model);
      expect(
        degradedReasons.some(
          (d) => d.includes('X6 差额') && d.includes('库存充足') && d.includes('未机械结构化')
        )
      ).toBe(true);
    });

    test('每个 X6 用例文件头部含 R5 冻结边界声明（S4-3）', () => {
      const { cases } = generateAdversarialCases(model);
      const x6 = cases.filter((c) => c.kind === 'guard-failure');
      expect(x6.length).toBeGreaterThan(0);
      for (const c of x6) {
        // 冻结边界声明必须在文件头部（前 20 行内）
        const head = c.body.split('\n').slice(0, 20).join('\n');
        expect(head).toContain(FREEZE_BOUNDARY_MARKER);
        expect(c.body).toContain('jest.useFakeTimers');
        expect(c.body).toContain('schedulerMock.disable');
        expect(c.body).toContain('schedulerMock.restore');
        // 非空壳：实际断言
        expect(c.body).toContain('expect(res.failed).toBe(true)');
        expect(c.body).toContain('expect(snapshot');
        expect(c.body).toContain('toEqual(before)');
      }
    });
  });

  describe('X12 收敛断言（remedy.detection）', () => {
    test('有 remedy.detection 的不变量生成收敛用例（数量相等，S4-4）', () => {
      const { cases } = generateAdversarialCases(model);
      const x12 = cases.filter((c) => c.kind === 'convergence');
      const invsWithDetection = model.derivable.invariants.filter((i) => i.remedy?.detection);
      expect(invsWithDetection).toHaveLength(1); // 仅 INV1
      expect(x12).toHaveLength(invsWithDetection.length);
      expect(x12[0].violation).toContain('observed_dim == expected');
      expect(x12[0].detection).toContain('对账任务');
      expect(x12[0].boundMs).toBe(60000); // 关联时序 TM1 的 boundMs
      // 非空壳：制造违约 + 收敛断言 + boundMs 断言
      expect(x12[0].body).toContain('makeViolation');
      expect(x12[0].body).toContain('converged');
      expect(x12[0].body).toContain('toBeLessThanOrEqual(60000)');
    });

    test('remedy 无 detection 显式降级记录不静默（P2-8）', () => {
      const { cases, degradedReasons } = generateAdversarialCases(model);
      const x12 = cases.filter((c) => c.kind === 'convergence');
      // INV2 有 remedy 无 detection → 降级；X12 用例数与有 detection 的不变量数相等
      expect(
        degradedReasons.some(
          (d) => d.includes('INV2') && d.includes('X12 降级') && d.includes('detection 缺省')
        )
      ).toBe(true);
      expect(x12).toHaveLength(1);
    });

    test('无 remedy 的不变量不生成 X12 用例也不降级（非缺口）', () => {
      const { cases, degradedReasons } = generateAdversarialCases(model);
      const x12 = cases.filter((c) => c.kind === 'convergence');
      expect(x12.some((c) => c.source.includes('INV3'))).toBe(false);
      expect(degradedReasons.some((d) => d.includes('INV3'))).toBe(false);
    });
  });

  describe('S4-2 用例数 ≤ 理论上限 + 差额降级（R4）', () => {
    test('X5 用例数 ≤ observed 维度数', () => {
      const { cases } = generateAdversarialCases(model);
      const x5 = cases.filter((c) => c.kind === 'observed-write');
      expect(x5.length).toBeLessThanOrEqual(1);
    });

    test('X6 反例数 ≤ 全部合取项之和，差额有降级记录', () => {
      const { cases, degradedReasons } = generateAdversarialCases(model);
      const x6 = cases.filter((c) => c.kind === 'guard-failure');
      const conjunctTotal = 3; // T1 契约 1 + T2 guard 2
      expect(x6.length).toBeLessThanOrEqual(conjunctTotal);
      const gap = conjunctTotal - x6.length;
      if (gap > 0) {
        const x6Gaps = degradedReasons.filter((d) => d.includes('X6 差额'));
        expect(x6Gaps.length).toBe(gap);
      }
    });
  });

  describe('S4-5 用例可执行（非空壳）：body 语法可解析', () => {
    test('全部对抗用例 body 可被 TypeScript 语法解析（esbuild transform）', () => {
      // 用 esbuild（项目 devDependency）对生成的用例文件正文做语法级校验：
      // 可解析 = 非空壳（具备可执行测试脚本形态）。
      const { cases } = generateAdversarialCases(model);
      expect(cases.length).toBeGreaterThan(0);
      for (const c of cases) {
        // esbuild transformSync：语法错误会抛异常（errors 非标准返回字段）
        let code = '';
        expect(() => {
          code = transformSync(c.body, { loader: 'ts' }).code;
        }).not.toThrow();
        expect(code.length).toBeGreaterThan(0);
      }
    });
  });

  describe('S4-3 flaky 自检：连跑 3 次结果一致', () => {
    test('三次生成的对抗用例与降级记录完全一致', () => {
      const r1 = generateAdversarialCases(model);
      const r2 = generateAdversarialCases(model);
      const r3 = generateAdversarialCases(model);
      const norm = (r: typeof r1) =>
        JSON.stringify({ cases: r.cases, degradedReasons: r.degradedReasons });
      expect(norm(r1)).toBe(norm(r2));
      expect(norm(r2)).toBe(norm(r3));
    });
  });
});

// ---------------------------------------------------------------------------
// S4-5：两个演示实例跑通一遍（parse + generateCases 不崩、结构完整、降级显式）
// ---------------------------------------------------------------------------

describe('G7-S4 S4-5：演示实例跑通（food-delivery / fulfillment-payment）', () => {
  const instances: Array<{ name: string; file: string }> = [
    { name: 'food-delivery', file: join(process.cwd(), 'examples/food-delivery/protocol/model.md') },
    { name: 'fulfillment-payment/P1', file: join(process.cwd(), 'examples/fulfillment-payment/protocol/P1/model.md') },
    { name: 'fulfillment-payment/P2', file: join(process.cwd(), 'examples/fulfillment-payment/protocol/P2/model.md') },
  ];

  for (const inst of instances) {
    describe(inst.name, () => {
      const model = parseProtocolContent(readFileSync(inst.file, 'utf-8'));
      const cases = generateCases(model);

      test('generateCases 跑通（路径 + 对抗用例 + 降级记录结构完整）', () => {
        expect(cases.paths.length).toBeGreaterThan(0);
        expect(cases.coverage).toBeDefined();
        // adversarialCases / degradedReasons 为可选字段：无则视为 0（结构完整即可）
        const adversarial = cases.adversarialCases ?? [];
        const degraded = cases.degradedReasons ?? [];
        for (const c of adversarial) {
          expect(c.body.length).toBeGreaterThan(0); // 非空壳
          expect(c.source.length).toBeGreaterThan(0);
          expect(c.id).toMatch(/^(X5_|X6_|X12_)/);
        }
        expect(Array.isArray(degraded)).toBe(true);
      });

      test('X6 用例（如有）文件头部均含 R5 冻结边界声明', () => {
        const adversarial = cases.adversarialCases ?? [];
        const x6 = adversarial.filter((c) => c.kind === 'guard-failure');
        for (const c of x6) {
          expect(c.body.split('\n').slice(0, 20).join('\n')).toContain(FREEZE_BOUNDARY_MARKER);
        }
      });

      test('X12 用例数与有 remedy.detection 的不变量数相等（S4-4）', () => {
        const adversarial = cases.adversarialCases ?? [];
        const x12 = adversarial.filter((c) => c.kind === 'convergence');
        const withDetection = model.derivable.invariants.filter((i) => i.remedy?.detection);
        expect(x12.length).toBe(withDetection.length);
      });

      test('差额降级显式：X5 无 observed 维度时降级记录不静默（R4）', () => {
        // 真实实例维度现状：food-delivery 4 维度全 undetermined；fulfillment-payment 无维度。
        // 若存在 kind 未判定维度 → 必须有 X5 差额降级记录；否则无缺口。
        const degraded = cases.degradedReasons ?? [];
        const hasDims = model.derivable.subsidiaryEntities?.some(
          (e) => e.stateSpace.dimensions.length > 0
        );
        if (hasDims) {
          expect(degraded.some((d) => d.includes('X5 差额'))).toBe(true);
        }
      });
    });
  }
});
