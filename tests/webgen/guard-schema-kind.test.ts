/**
 * W2 checker schema 自检 + guardSchemaKind 端到端测试（07-execution-T3 TC5）
 *
 * 机械判据（TC5 验收）：
 * ① 含命中语法 fixture → data.json edges[].guardSchemaKind === 'json-schema'；
 *    未命中 → 'description-only'（逐边断言，与 specifier 表达式 kind 一一对应）；
 * ② jsdom：viewer 边详情显示的 guardSchemaKind 与 data.json 逐字段一致（端内零推导）；
 * ③ 反向：构造 ajv 编译失败的 schema → checker 硬错误；引用不存在字段 → 硬错误；
 *    invariant(INVn) 引用不存在不变量 → 硬错误；
 * ④ 无 guard 表达式的边 → guardSchemaKind 缺省（契约不变）；
 * ⑤ 零回归披露：food-delivery 等既有 fixture guardSchemaKind 变化属 W2 预期交付
 *    （T2 样例再生成见 TC10 记录）；
 * ⑥ tsc 0 errors + suite 全过。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import Ajv from 'ajv';
import { parseProtocolContent } from '../../src/parser/index.js';
import { buildWebData, type DeriveWebInputs } from '../../src/webgen/index.js';
import { specify } from '../../src/specifier/index.js';
import { tryParseGuardSchema } from '../../src/specifier/schema-builder.js';
import { checkCompleteness } from '../../src/checker/index.js';

const ROOT = process.cwd();
const VIEWER = join(ROOT, 'viewer');
function readViewerFile(rel: string): string {
  return readFileSync(join(VIEWER, rel), 'utf-8');
}

// ============================================================================
// fixture：含谓词命中 / 自然语言 / 无 guard / 多 token 布尔 四类 guard
// ============================================================================

function buildGuardFixtureModel() {
  return parseProtocolContent(`---
name: GuardSchemaKind 协议
version: 1.0.0
purpose: TC5 guardSchemaKind 端到端测试
roles:
  - id: system
    name: 系统
    roleType: consensus
---

# 状态空间

| ID | 名称 | 类型 | 描述 | 角色 |
|---|---|---|---|---|
| S1 | 态一 | initial | 初始态 | system |
| S2 | 态二 | normal | 中间态 | system |
| S3 | 态三 | normal | 中间态 | system |
| S4 | 态四 | terminal | 终态 | system |

# 转移规则

| ID | 名称 | from | to | action | trigger | guard | effects | triggerType | actionType | affectsDimensions |
|---|---|---|---|---|---|---|---|---|---|---|
| T1 | 谓词命中 | S1 | S2 | act_pred | system | nonEmpty(order_id) | | system | state_transition | |
| T2 | 自然语言 | S2 | S3 | act_nl | system | 金额必须一致 | | system | state_transition | |
| T3 | 无守卫 | S3 | S4 | act_noguard | system | | | system | state_transition | |
| T4 | 布尔表达式 | S1 | S2 | act_bool | system | rider_available && rider_in_flight_orders < 10 | | system | state_transition | |
| T5 | 单标识符谓词 | S2 | S4 | act_ident | system | accept_within_deadline | | system | state_transition | |

# 不变量

# 不变量

（无）
`, 'tc5-guard.md');
}

function buildData(model: ReturnType<typeof parseProtocolContent>) {
  const envelope = specify(model);
  const inputs: DeriveWebInputs = {
    specsEnvelope: envelope,
    model,
  };
  return buildWebData(inputs);
}

// ============================================================================
// ① guardSchemaKind 端到端投影（逐边断言，与 specifier 表达式 kind 一一对应）
// ============================================================================

describe('TC5 ① guardSchemaKind 端到端投影（webgen）', () => {
  const model = buildGuardFixtureModel();
  const data = buildData(model);
  const edges = data.stateMachine.edges;

  test('逐边：guardSchemaKind 与 tryParseGuardSchema 表达式 kind 一一对应', () => {
    for (const t of model.derivable.transitions) {
      const edge = edges.find((e) => e.id === t.id)!;
      const expr = t.guard ? tryParseGuardSchema(t.guard) : undefined;
      const expected = expr?.kind === 'json-schema' ? 'json-schema' : 'description-only';
      if (t.guard) {
        expect(edge.guardSchemaKind).toBe(expected);
        expect(edge.guard).toBe(t.guard);
      } else {
        expect(edge.guardSchemaKind).toBeUndefined(); // ④ 无 guard → 缺省
      }
    }
  });

  test('具体断言：nonEmpty(order_id) → json-schema；自然语言 → description-only', () => {
    const t1 = edges.find((e) => e.id === 'T1')!;
    expect(t1.guardSchemaKind).toBe('json-schema');
    const t2 = edges.find((e) => e.id === 'T2')!;
    expect(t2.guardSchemaKind).toBe('description-only');
  });

  test('布尔表达式（多 token）→ json-schema；单标识符谓词 → description-only（与 specifier 一致）', () => {
    const t4 = edges.find((e) => e.id === 'T4')!;
    expect(tryParseGuardSchema('rider_available && rider_in_flight_orders < 10')!.kind).toBe('json-schema');
    expect(t4.guardSchemaKind).toBe('json-schema');
    const t5 = edges.find((e) => e.id === 'T5')!;
    expect(tryParseGuardSchema('accept_within_deadline')!.kind).toBe('legacy-stub');
    expect(t5.guardSchemaKind).toBe('description-only');
  });

  test('④ 无 guard 表达式的边 → guardSchemaKind 缺省（契约不变）', () => {
    const t3 = edges.find((e) => e.id === 'T3')!;
    expect(t3.guard).toBeUndefined();
    expect(t3.guardSchemaKind).toBeUndefined();
  });
});

// ============================================================================
// ② jsdom：viewer 边详情显示 guardSchemaKind 与 data.json 逐字段一致
// ============================================================================

describe('TC5 ② viewer 边详情显示 guardSchemaKind（jsdom，端内零推导）', () => {
  const data = buildData(buildGuardFixtureModel());

  function setupDom(): { dom: JSDOM } {
    const html = readViewerFile('index.html');
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'file:///viewer/index.html' });
    const ctx = dom.getInternalVMContext();
    runInContext(readViewerFile('assets/parser.js'), ctx);
    runInContext(readViewerFile('n1-guard.js'), ctx);
    runInContext(readViewerFile('app.js'), ctx);
    runInContext(readViewerFile('main-view.js'), ctx);
    const win = dom.window as unknown as {
      ProtochainViewer?: { state: { dataJson: unknown; n1: { degraded: boolean } } };
    };
    win.ProtochainViewer!.state.dataJson = data as unknown;
    const panels = dom.window.document.querySelector('#panels') as unknown as { innerHTML: string };
    (dom.window as unknown as { ProtochainViewerHooks: { renderAll: (s: unknown, p: unknown) => void } })
      .ProtochainViewerHooks.renderAll(win.ProtochainViewer!.state, panels);
    return { dom };
  }

  function detailRows(dom: JSDOM): Array<{ label: string; value: string }> {
    return [...dom.window.document.querySelectorAll('.detail-row')].map((r) => ({
      label: r.querySelector('.detail-label')?.textContent ?? '',
      value: r.querySelector('.detail-value')?.textContent ?? '',
    }));
  }

  test('点击谓词命中边 → 详情显示 guard schemaKind=json-schema（与 data.json 一致）', () => {
    const { dom } = setupDom();
    const line = dom.window.document.querySelector('.sm-edge[data-edge-id="T1"]')!;
    line.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    const rows = detailRows(dom);
    const kindRow = rows.find((r) => r.label === 'guard schemaKind');
    expect(kindRow?.value).toBe('json-schema');
  });

  test('点击自然语言边 → 详情显示 guard schemaKind=description-only（与 data.json 一致）', () => {
    const { dom } = setupDom();
    const line = dom.window.document.querySelector('.sm-edge[data-edge-id="T2"]')!;
    line.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    const rows = detailRows(dom);
    const kindRow = rows.find((r) => r.label === 'guard schemaKind');
    expect(kindRow?.value).toBe('description-only');
  });
});

// ============================================================================
// ③ checker 反向：ajv 编译失败 / 字段引用不存在 / invariant 引用不存在 → 硬错误
// ============================================================================

function buildCheckModel(guard: string, opts?: { extraInvariant?: string }): string {
  const inv = opts?.extraInvariant ?? '';
  return `---
name: Schema 自检协议
version: 1.0.0
purpose: TC5 checker 反向测试
roles:
  - id: system
    name: 系统
    roleType: consensus
---

# 状态空间

| ID | 名称 | 类型 | 描述 | 角色 |
|---|---|---|---|---|
| S1 | 态一 | initial | 初始态 | system |
| S2 | 态二 | terminal | 终态 | system |

# 转移规则

| ID | 名称 | from | to | action | trigger | guard | effects | triggerType | actionType | affectsDimensions |
|---|---|---|---|---|---|---|---|---|---|---|
| T1 | 守卫 | S1 | S2 | act_x | system | ${guard} | | system | state_transition | |

# 不变量

${inv || '（无）'}
`;
}

describe('TC5 ③ checker guard schema 自检（反向硬错误）', () => {
  test('ajv 编译失败的 schema（matchesPattern 非法正则）→ 硬错误', () => {
    // "[a-z" 未闭合字符类 → ajv 编译抛错
    const model = parseProtocolContent(buildCheckModel('matchesPattern(mobile, "[a-z")'), 'tc5-bad-regex.md');
    const report = checkCompleteness(model);
    expect(report.mechanical.passed).toBe(false);
    const errs = report.mechanical.referenceIssues.filter(
      (i) => i.severity === 'error' && i.message.includes('ajv')
    );
    expect(errs.length).toBe(1);
    expect(errs[0].message).toContain('T1');
  });

  test('跨字段引用不存在字段（order_amout 拼写错误，未声明）→ 硬错误', () => {
    const model = parseProtocolContent(
      buildCheckModel('order_amout == order_amount'),
      'tc5-missing-field.md'
    );
    const report = checkCompleteness(model);
    expect(report.mechanical.passed).toBe(false);
    const errs = report.mechanical.referenceIssues.filter(
      (i) => i.severity === 'error' && i.message.includes('引用字段')
    );
    expect(errs.length).toBeGreaterThanOrEqual(1);
    // 至少一条指向拼写错误的字段 order_amout（guard 原文与字段名均含该串）
    expect(errs.some((i) => i.message.includes('order_amout'))).toBe(true);
    expect(errs.some((i) => i.message.includes('未在模型中声明'))).toBe(true);
  });

  test('声明字段（attributeEffects 直通声明）→ 引用闭合通过（正向补充）', () => {
    const model = parseProtocolContent(`---
name: 字段闭合协议
version: 1.0.0
purpose: TC5 字段闭合正向
roles:
  - id: system
    name: 系统
    roleType: consensus
---

# 状态空间

| ID | 名称 | 类型 | 描述 | 角色 |
|---|---|---|---|---|
| S1 | 态一 | initial | 初始态 | system |
| S2 | 态二 | terminal | 终态 | system |

# 转移规则

| ID | 名称 | from | to | action | trigger | guard | effects | triggerType | actionType | affectsDimensions |
|---|---|---|---|---|---|---|---|---|---|---|
| T1 | 守卫 | S1 | S2 | act_x | system | paid_amount == order_amount | | system | state_transition | |

# 不变量

（无）
`);
    // 字段经 attributeEffects 程序化声明（parser 不解析该表列，测试直接注入）
    model.derivable.transitions[0].attributeEffects = [
      { field: 'paid_amount', operation: 'set', value: '0' },
      { field: 'order_amount', operation: 'set', value: '0' },
    ];
    const report = checkCompleteness(model);
    expect(report.mechanical.passed).toBe(true);
  });

  test('invariant(INV99) 引用不存在不变量 → 硬错误', () => {
    const model = parseProtocolContent(buildCheckModel('invariant(INV99)'), 'tc5-missing-inv.md');
    const report = checkCompleteness(model);
    expect(report.mechanical.passed).toBe(false);
    const errs = report.mechanical.referenceIssues.filter(
      (i) => i.severity === 'error' && i.message.includes('INV99')
    );
    expect(errs.length).toBe(1);
    expect(errs[0].message).toContain('未在 invariants 中声明');
  });

  test('invariant(INV1) 引用已声明不变量 → 通过（正向补充）', () => {
    const model = parseProtocolContent(
      buildCheckModel('invariant(INV1)', {
        extraInvariant: `| ID | 名称 | 表达式 | 作用状态 | 声明方 | 不变量类别 | 描述 | level | source | storageRef |
|---|---|---|---|---|---|---|---|---|---|---|
| INV1 | 数据唯一 | unique(id) | S1, S2 | system | intra_protocol | 唯一 | data | storage | t |`,
      }),
      'tc5-inv-ok.md'
    );
    const report = checkCompleteness(model);
    expect(report.mechanical.passed).toBe(true);
  });

  test('所有 kind=json-schema 表达式可编译的汇总断言（fixture 全过）', () => {
    const model = buildGuardFixtureModel();
    const ajv = new Ajv({ allErrors: true, strict: false });
    let compiled = 0;
    for (const t of model.derivable.transitions) {
      if (!t.guard) continue;
      const expr = tryParseGuardSchema(t.guard);
      if (expr?.kind === 'json-schema' && expr.schema) {
        expect(() => ajv.compile(expr.schema as object)).not.toThrow();
        compiled++;
      }
    }
    expect(compiled).toBe(2); // T1 nonEmpty + T4 boolean
  });
});
