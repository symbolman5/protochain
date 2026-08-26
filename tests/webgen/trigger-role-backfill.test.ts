/**
 * T4 TD2 triggerRoleId backfill（09-execution-T4.md TD2 / 08-project-viewer-design.md §5.2.2 R11/R17）
 *
 * 机械判据（TD2 验收）：
 * ① 演示实例 P1 再生成：refund_cancel 接口（IF_SYS_T4）triggerRoleId === "platform"（edge T4 投影）；
 *    P2 pay（IF_SYS_T1）→ "customer"；
 * ② 观测接口（IF_OBS_*）triggerRoleId 保持缺省（零命中 → 保持空）；
 * ③ 反向：fixture 构造同名 action 两条转移且 triggerRoleId 不同 → 不填 + warnings 非空；
 * ④ 零回归：既有全部 webgen 测试零改动全绿（由全量 jest 验证）；
 * ⑤ tsc 0 errors（由 tsc --noEmit 验证）。
 *
 * 实现口径（R17）：stateMachine 提升为局部常量后，return 前对 interfaces 逐条 backfill——
 * edges.filter(e => e.action === iface.name) 命中集合的 triggerRoleId 去重：
 * 唯一值 → 填充；多个不同值 → 不填 + warnings；零命中 → 保持空。
 */

import { join } from 'node:path';
import { parseProtocolFile, parseProtocolContent } from '../../src/parser/index.js';
import { specify } from '../../src/specifier/index.js';
import { buildWebData } from '../../src/webgen/index.js';
import type { SourceProtocolModel } from '../../src/model/types.js';

const DEMO = join(process.cwd(), 'examples', 'fulfillment-payment');

function buildDemoData(proto: 'P1' | 'P2', warnings?: string[]) {
  const model = parseProtocolFile(join(DEMO, 'protocol', proto, 'model.md'));
  const envelope = specify(model);
  return buildWebData({ specsEnvelope: envelope, model, warnings });
}

describe('TD2 ① 正向：演示实例 triggerRoleId backfill（真实值）', () => {
  test('P1 IF_SYS_T4（refund_cancel）→ triggerRoleId = platform', () => {
    const data = buildDemoData('P1');
    const iface = data.interfaces.find((i) => i.id === 'IF_SYS_T4');
    expect(iface).toBeDefined();
    expect(iface!.name).toBe('refund_cancel');
    expect(iface!.triggerRoleId).toBe('platform');
    // edge T4 投影为 platform（同源）
    const edge = data.stateMachine.edges.find((e) => e.id === 'T4');
    expect(edge?.triggerRoleId).toBe('platform');
  });

  test('P2 IF_SYS_T1（pay）→ triggerRoleId = customer', () => {
    const data = buildDemoData('P2');
    const iface = data.interfaces.find((i) => i.id === 'IF_SYS_T1');
    expect(iface).toBeDefined();
    expect(iface!.name).toBe('pay');
    expect(iface!.triggerRoleId).toBe('customer');
  });

  test('P1 各系统接口 triggerRoleId 与对应 edge 同值（逐接口对账）', () => {
    const data = buildDemoData('P1');
    const edgeByAction = new Map(data.stateMachine.edges.map((e) => [e.action, e]));
    for (const i of data.interfaces.filter((x) => x.kind === 'system')) {
      const edge = edgeByAction.get(i.name);
      if (!edge) continue; // 契约承载接口等无 edge 场景
      expect(i.triggerRoleId).toBe(edge.triggerRoleId);
    }
  });
});

describe('TD2 ② 观测接口保持缺省（零命中 → 保持空）', () => {
  test('P1/P2 全部 IF_OBS_* 接口 triggerRoleId 缺省', () => {
    for (const proto of ['P1', 'P2'] as const) {
      const data = buildDemoData(proto);
      for (const i of data.interfaces.filter((x) => x.kind === 'observation')) {
        expect(i.id).toMatch(/^IF_OBS_/);
        expect(i.triggerRoleId).toBeUndefined();
      }
    }
  });
});

describe('TD2 ③ 反向：同名 action 多值消歧（R17）', () => {
  // fixture：两条转移 action 相同（duplicate_action）、trigger 不同（roleA / roleB）
  const fixtureMd = `---
name: 同名 action 消歧 fixture
version: 1.0.0
purpose: triggerRoleId backfill 消歧测试（TD2 ③）
roles:
  - id: roleA
    name: 角色A
  - id: roleB
    name: 角色B
---

# 状态空间

| ID | 名称 | 类型 | 描述 | 角色 |
|---|---|---|---|---|
| S0 | 初始 | initial | 初始 | roleA |
| S1 | 终态 | terminal | 终态 | roleA |

# 转移规则

| ID | 名称 | from | to | action | trigger | guard | effects | triggerType | actionType | affectsDimensions |
|---|---|---|---|---|---|---|---|---|---|---|
| T1 | 第一次 | S0 | S1 | duplicate_action | roleA | | | role | state_transition | |
| T2 | 第二次 | S0 | S1 | duplicate_action | roleB | | | role | state_transition | |
`;

  test('同名 action 两条转移 triggerRoleId 不同 → 不填 + warnings 非空', () => {
    const model: SourceProtocolModel = parseProtocolContent(fixtureMd, 'fixture.md');
    const envelope = specify(model);
    const warnings: string[] = [];
    const data = buildWebData({ specsEnvelope: envelope, model, warnings });
    // 两条系统接口 name 均为 duplicate_action；消歧失败 → triggerRoleId 不填充
    const sys = data.interfaces.filter((i) => i.kind === 'system');
    expect(sys.length).toBeGreaterThanOrEqual(2);
    for (const i of sys) {
      expect(i.name).toBe('duplicate_action');
      expect(i.triggerRoleId).toBeUndefined();
    }
    // warnings 非空且含接口 id 与 action 名
    expect(warnings.length).toBeGreaterThan(0);
    const joined = warnings.join('\n');
    expect(joined).toContain('triggerRoleId backfill 跳过');
    expect(joined).toContain('duplicate_action');
    expect(joined).toContain('roleA');
    expect(joined).toContain('roleB');
  });

  test('未传 warnings 数组时消歧失败静默不填（零回归路径）', () => {
    const model: SourceProtocolModel = parseProtocolContent(fixtureMd, 'fixture.md');
    const envelope = specify(model);
    const data = buildWebData({ specsEnvelope: envelope, model }); // 不传 warnings
    for (const i of data.interfaces.filter((x) => x.kind === 'system')) {
      expect(i.triggerRoleId).toBeUndefined();
    }
  });

  test('同名 action 两条转移 triggerRoleId 相同（去重后唯一）→ 填充', () => {
    const md = fixtureMd.replace('| T2 | 第二次 | S0 | S1 | duplicate_action | roleB |', '| T2 | 第二次 | S0 | S1 | duplicate_action | roleA |');
    const model: SourceProtocolModel = parseProtocolContent(md, 'fixture.md');
    const envelope = specify(model);
    const warnings: string[] = [];
    const data = buildWebData({ specsEnvelope: envelope, model, warnings });
    for (const i of data.interfaces.filter((x) => x.kind === 'system')) {
      expect(i.triggerRoleId).toBe('roleA');
    }
    expect(warnings).toEqual([]);
  });
});
