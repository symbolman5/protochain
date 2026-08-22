import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProtocolContent } from '../../src/parser/index.js';
import { specify, specsFromEnvelope } from '../../src/specifier/index.js';
import type { SourceProtocolModel, InterfaceSpec } from '../../src/model/types.js';

const FIXTURES = join(process.cwd(), 'tests/fixtures');

function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf-8');
}

function loadP2Model(): SourceProtocolModel {
  return parseProtocolContent(
    readFixture('saas-P2-entry.md'),
    'saas-P2-entry.md'
  );
}

describe('specifier 扩展推导', () => {
  const model = loadP2Model();
  const specs = specsFromEnvelope(specify(model));

  describe('attribute_update 接口', () => {
    test('T2 (receive_traffic) 生成 attribute_update 接口 IF_SYS_ATTR_T2', () => {
      const attrSpec = specs.find((s) => s.id === 'IF_SYS_ATTR_T2');
      expect(attrSpec).toBeDefined();
      expect(attrSpec!.kind).toBe('system');
      expect(attrSpec!.sourceId).toBe('receive_traffic');
      expect(attrSpec!.actionType).toBe('attribute_update');
    });

    test('attribute_update 接口包含更新维度 traffic_count 作为输入', () => {
      const attrSpec = specs.find((s) => s.id === 'IF_SYS_ATTR_T2')!;
      expect(attrSpec.affectsDimensions).toContain('traffic_count');

      const trafficInput = attrSpec.inputs.find((i) => i.name === 'traffic_count');
      expect(trafficInput).toBeDefined();
      expect(trafficInput!.required).toBe(true);
    });

    test('attribute_update 接口包含 currentState 输入', () => {
      const attrSpec = specs.find((s) => s.id === 'IF_SYS_ATTR_T2')!;
      expect(attrSpec.inputs.some((i) => i.name === 'currentState')).toBe(true);
    });

    test('attribute_update 接口 outputs 含 updatedDimensions', () => {
      const attrSpec = specs.find((s) => s.id === 'IF_SYS_ATTR_T2')!;
      expect(attrSpec.outputs.some((o) => o.name === 'updatedDimensions')).toBe(true);
    });
  });

  describe('多维观测接口', () => {
    // 构造一个含多维度状态的协议模型
    const multiDimContent = `---
name: 多维状态协议
version: 1.0.0
purpose: 测试
roles:
  - id: admin
    name: 管理员
    roleType: consensus
---

# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S1 | 初始 | initial |
| S2 | 运行中 | normal |

# 转移规则

| ID | 名称 | from | to | action | trigger | guard | effects | triggerType | actionType | affectsDimensions |
|---|---|---|---|---|---|---|---|---|---|---|
| T1 | 创建 | S1 | S2 | create | admin | | | role | state_transition | |

# 不变量

| ID | 名称 | 表达式 | 作用状态 | declaredBy | invariantClass |
|---|---|---|---|---|---|
| INV1 | 不变量 | true | | admin | intra_protocol |`;

    // 解析 + 通过 API 注入 dimensions（手动添加）
    const multiModel = parseProtocolContent(multiDimContent, 'test-multi.md');
    // 为 S2 添加 dimensions
    multiModel.derivable.states = multiModel.derivable.states.map((s) => {
      if (s.id === 'S2') {
        return {
          ...s,
          dimensions: [
            { name: 'traffic_count', type: 'number', initial: 0, validWhen: 'S2' },
            { name: 'port_bound', type: 'enum[bound, free]', initial: 'free', validWhen: 'S2' },
          ],
        };
      }
      return s;
    });
    const multiSpecs = specsFromEnvelope(specify(multiModel));

    test('含 dimensions 的状态 → 生成 IF_OBS_MULTI_* 接口', () => {
      const multiObs = multiSpecs.find((s) => s.id === 'IF_OBS_MULTI_S2');
      expect(multiObs).toBeDefined();
      expect(multiObs!.kind).toBe('observation');
      expect(multiObs!.outputs.some((o) => o.name === 'isInState')).toBe(true);
      expect(multiObs!.outputs.some((o) => o.name === 'traffic_count')).toBe(true);
      expect(multiObs!.outputs.some((o) => o.name === 'port_bound')).toBe(true);
    });

    test('无 dimensions 的状态 → 不生成 IF_OBS_MULTI_* 接口', () => {
      const multiObs = multiSpecs.find((s) => s.id === 'IF_OBS_MULTI_S1');
      expect(multiObs).toBeUndefined();
    });
  });

  describe('资源池观测接口', () => {
    test('RP1 (端口资源池) → 生成 IF_OBS_POOL_RP1', () => {
      const poolObs = specs.find((s) => s.id === 'IF_OBS_POOL_RP1');
      expect(poolObs).toBeDefined();
      expect(poolObs!.kind).toBe('observation');
      expect(poolObs!.observesResourcePoolId).toBe('RP1');
    });

    test('资源池观测接口包含 available/capacity/allocationRule 输出', () => {
      const poolObs = specs.find((s) => s.id === 'IF_OBS_POOL_RP1')!;
      expect(poolObs.outputs.some((o) => o.name === 'available')).toBe(true);
      expect(poolObs.outputs.some((o) => o.name === 'capacity')).toBe(true);
      expect(poolObs.outputs.some((o) => o.name === 'allocationRule')).toBe(true);
    });
  });
});
