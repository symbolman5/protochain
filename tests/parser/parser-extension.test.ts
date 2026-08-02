import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProtocolContent, ParseError } from '../../src/parser/index.js';

const FIXTURES = join(process.cwd(), 'tests/fixtures');

function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf-8');
}

describe('parser 扩展段与迁移补全', () => {
  describe('遗留 model.md 迁移补全（legacy-model.md）', () => {
    const content = readFixture('legacy-model.md');
    const model = parseProtocolContent(content, 'legacy-model.md');

    test('roleType 未声明时首个角色提升为 consensus', () => {
      // legacy-model.md 角色无 roleType，迁移后首个角色 operator 应为 consensus
      expect(model.metadata.roles[0].roleType).toBe('consensus');
      expect(model.metadata.roles[1].roleType).toBe('participant');
    });

    test('转移 triggerType/trigger 从 triggerRoleId 推断', () => {
      const t1 = model.derivable.transitions.find((t) => t.id === 'T1');
      // T1 触发者 operator → triggerType=role, trigger=operator
      expect(t1?.triggerType).toBe('role');
      expect(t1?.trigger).toBe('operator');

      const t2 = model.derivable.transitions.find((t) => t.id === 'T2');
      // T2 无触发者 → triggerType=system, trigger=system
      expect(t2?.triggerType).toBe('system');
      expect(t2?.trigger).toBe('system');
    });

    test('actionType 默认 state_transition，affectsDimensions 默认空数组', () => {
      for (const t of model.derivable.transitions) {
        expect(t.actionType).toBe('state_transition');
        expect(t.affectsDimensions).toEqual([]);
      }
    });

    test('不变量 declaredBy 默认取首个 consensus 角色', () => {
      const inv1 = model.derivable.invariants.find((i) => i.id === 'INV1');
      expect(inv1?.declaredBy).toBe('operator'); // 首个被提升为 consensus 的角色
      expect(inv1?.invariantClass).toBe('intra_protocol');
    });

    test('扩展段未启用时扩展字段为 undefined', () => {
      expect(model.derivable.resourcePools).toBeUndefined();
      expect(model.derivable.instantiation).toBeUndefined();
      expect(model.derivable.externalEvents).toBeUndefined();
      expect(model.derivable.negativeAssurances).toBeUndefined();
      expect(model.derivable.subsidiaryEntities).toBeUndefined();
    });
  });

  describe('扩展段解析（saas-P2-entry.md）', () => {
    const content = readFixture('saas-P2-entry.md');
    const model = parseProtocolContent(content, 'saas-P2-entry.md');

    test('roleType 显式声明不被覆盖', () => {
      const rolesById = new Map(model.metadata.roles.map((r) => [r.id, r]));
      expect(rolesById.get('tenant_admin')?.roleType).toBe('consensus');
      expect(rolesById.get('platform')?.roleType).toBe('consensus');
      expect(rolesById.get('entry_runtime')?.roleType).toBe('participant');
    });

    test('转移扩展字段正确解析', () => {
      const t1 = model.derivable.transitions.find((t) => t.id === 'T1');
      expect(t1?.triggerType).toBe('role');
      expect(t1?.trigger).toBe('tenant_admin');
      expect(t1?.actionType).toBe('state_transition');

      const t2 = model.derivable.transitions.find((t) => t.id === 'T2');
      expect(t2?.triggerType).toBe('external');
      expect(t2?.trigger).toBe('upstream');
      expect(t2?.actionType).toBe('attribute_update');
      expect(t2?.affectsDimensions).toEqual(['traffic_count']);
    });

    test('资源池段解析', () => {
      expect(model.derivable.resourcePools).toHaveLength(1);
      const pool = model.derivable.resourcePools![0];
      expect(pool.id).toBe('RP1');
      expect(pool.type).toContain('server_id, port');
      expect(pool.crossInvariantIds).toEqual(['CI1']);
      expect(pool.constraints.length).toBeGreaterThan(0);
    });

    test('外部事件段解析', () => {
      expect(model.derivable.externalEvents).toHaveLength(1);
      const ee = model.derivable.externalEvents![0];
      expect(ee.id).toBe('EE1');
      expect(ee.source).toBe('upstream');
      expect(ee.ordering).toBe('by_event_time');
    });

    test('附属实体段解析（含 stateSpace.dimensions）', () => {
      expect(model.derivable.subsidiaryEntities).toHaveLength(1);
      const ent = model.derivable.subsidiaryEntities![0];
      expect(ent.id).toBe('port');
      expect(ent.belongsTo).toBe('entry（P2）');
      expect(ent.cascadeRules.length).toBeGreaterThan(0);
      expect(ent.stateSpace.dimensions).toHaveLength(1);
      expect(ent.stateSpace.dimensions[0].name).toBe('bound');
    });

    test('消极保证段解析', () => {
      expect(model.derivable.negativeAssurances).toHaveLength(1);
      const na = model.derivable.negativeAssurances![0];
      expect(na.id).toBe('NA1');
      expect(na.declaredBy).toBe('platform');
    });

    test('不变量扩展字段正确解析', () => {
      const inv1 = model.derivable.invariants.find((i) => i.id === 'INV1');
      expect(inv1?.declaredBy).toBe('platform');
      expect(inv1?.invariantClass).toBe('intra_protocol');
    });

    test('scheduled 时序解析', () => {
      const tm1 = model.derivable.timing.find((t) => t.id === 'TM1');
      expect(tm1?.type).toBe('scheduled');
      expect(tm1?.schedule).toBe('every 30s');
      expect(tm1?.onViolation).toBe('S3');
    });
  });

  describe('决策8 段落级可选检测', () => {
    test('扩展段存在但无 YAML 代码块 → 解析错误', () => {
      const content = `---
name: 测试
version: 1.0.0
purpose: 测试
roles:
  - id: r1
    name: 角色1
    roleType: consensus
---

# 资源池

这里只有文字，没有 YAML 代码块。
`;
      expect(() => parseProtocolContent(content, 'test.md')).toThrow(ParseError);
    });

    test('扩展段不存在 → 不报错，扩展字段为 undefined', () => {
      const content = `---
name: 测试
version: 1.0.0
purpose: 测试
roles:
  - id: r1
    name: 角色1
    roleType: consensus
---

# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S1 | 初始 | initial |
`;
      const model = parseProtocolContent(content, 'test.md');
      expect(model.derivable.resourcePools).toBeUndefined();
      expect(model.derivable.subsidiaryEntities).toBeUndefined();
    });
  });
});
