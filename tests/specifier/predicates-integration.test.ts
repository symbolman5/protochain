/**
 * W2 翻译器接入 specifier 主链路集成测试（07-execution-T3 TC4）
 *
 * 机械判据（TC4 验收）：
 * ① 语法命中的 guard 表达式全部 kind='json-schema' 且 ajv 可编译（逐表达式断言）；
 * ② 自然语言 guard → legacy-stub 且 schemaDegradedReasons 非空、逐条含理由（显式降级不静默）；
 * ③ attributeEffects → structured effects（kind/字段逐字段断言，零翻译直通）；
 * ④ level=data 不变量 → SchemaExpression 机械生成（InvariantDef → SchemaExpression 转换测试，
 *    02 §5 B 验收基准；unique 谓词直连 E4 SQL 校验生成器，不重做）；
 * ⑤ 老模型零回归：既有全部 specifier 测试零改动全绿（自然语言 guard 行为与 T2 一致）；
 * ⑥ tsc 0 errors + suite 全过。
 */

import Ajv from 'ajv';
import { parseProtocolContent } from '../../src/parser/index.js';
import { specify, specsFromEnvelope } from '../../src/specifier/index.js';
import {
  invariantToSchemaExpression,
  attributeEffectsToExpressions,
} from '../../src/specifier/schema-builder.js';
import type { SourceProtocolModel } from '../../src/model/types.js';

const ajv = new Ajv({ allErrors: true, strict: false });

/** 集成测试模型：含谓词命中 guard / 自然语言 guard / invariant() guard / 数据级不变量 */
function buildIntegrationModel(): SourceProtocolModel {
  return parseProtocolContent(`---
name: W2 集成协议
version: 1.0.0
purpose: TC4 谓词接入 specifier 主链路测试
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
| S3 | 态三 | terminal | 终态 | system |

# 转移规则

| ID | 名称 | from | to | action | trigger | guard | effects | triggerType | actionType | affectsDimensions |
|---|---|---|---|---|---|---|---|---|---|---|
| T1 | 谓词命中 | S1 | S2 | act_predicate | system | nonEmpty(order_id) | | system | state_transition | |
| T2 | 跨字段命中 | S2 | S3 | act_cross | system | paid_amount == order_amount | | system | state_transition | |
| T3 | 自然语言降级 | S1 | S2 | act_nl | system | 金额必须一致 | | system | state_transition | |
| T4 | 不变量引用 | S2 | S3 | act_invref | system | invariant(INV1) | | system | state_transition | |

# 不变量

| ID | 名称 | 表达式 | 作用状态 | 声明方 | 不变量类别 | 描述 | level | source | storageRef |
|---|---|---|---|---|---|---|---|---|---|
| INV1 | 数据唯一 | unique(entry_id) | S1, S2, S3 | system | intra_protocol | 数据级不变量 | data | storage | entries |
`, 'tc4-integration.md');
}

function specByAction(model: SourceProtocolModel, action: string) {
  const specs = specsFromEnvelope(specify(model));
  return specs.find((s) => s.name === action)!;
}

describe('TC4 W2 谓词接入 specifier 主链路', () => {
  const model = buildIntegrationModel();

  describe('① 语法命中的 guard 全部 json-schema 且 ajv 可编译（逐表达式断言）', () => {
    test('nonEmpty(order_id) → json-schema + 可编译', () => {
      const spec = specByAction(model, 'act_predicate');
      const pre = spec.preconditions!;
      expect(pre.length).toBe(1);
      expect(pre[0].kind).toBe('json-schema');
      expect(() => ajv.compile(pre[0].schema as object)).not.toThrow();
      expect(pre[0].schema).toEqual({ type: 'string', minLength: 1, description: 'order_id 非空' });
    });

    test('paid_amount == order_amount → json-schema + 可编译（跨字段结构表达）', () => {
      const spec = specByAction(model, 'act_cross');
      const pre = spec.preconditions!;
      expect(pre.length).toBe(1);
      expect(pre[0].kind).toBe('json-schema');
      expect(() => ajv.compile(pre[0].schema as object)).not.toThrow();
      expect(pre[0].schema!.required).toEqual(['paid_amount', 'order_amount']);
    });

    test('invariant(INV1) → json-schema + 挂载到 spec.invariantIds（R2-3）', () => {
      const spec = specByAction(model, 'act_invref');
      const pre = spec.preconditions!;
      expect(pre.length).toBe(1);
      expect(pre[0].kind).toBe('json-schema');
      expect(() => ajv.compile(pre[0].schema as object)).not.toThrow();
      // 跨接口谓词挂载 InvariantDef：guard 引用写入 invariantIds
      expect(spec.invariantIds).toEqual(['INV1']);
    });
  });

  describe('② 自然语言 guard → legacy-stub + schemaDegradedReasons 非空（显式降级不静默）', () => {
    test('金额必须一致 → preconditions[0] legacy-stub + degradedReasons 含理由', () => {
      const spec = specByAction(model, 'act_nl');
      const pre = spec.preconditions!;
      expect(pre.length).toBe(1);
      expect(pre[0].kind).toBe('legacy-stub');
      expect(spec.schemaDegradedReasons).toBeDefined();
      expect(spec.schemaDegradedReasons!.length).toBeGreaterThan(0);
      const reason = spec.schemaDegradedReasons![0];
      expect(reason).toContain('金额必须一致');
      expect(reason).toContain('未机械提取');
    });
  });

  describe('③ attributeEffects → structured effects（零翻译直通，逐字段断言）', () => {
    test('attributeEffectsToExpressions：set/increment/append/remove → json-schema + 字段', () => {
      const exprs = attributeEffectsToExpressions([
        { field: 'order_status', operation: 'set', value: 'accepted' },
        { field: 'retry_count', operation: 'increment' },
        { field: 'audit_log', operation: 'append', value: 'entry' },
        { field: 'temp_flag', operation: 'remove' },
      ]);
      expect(exprs.length).toBe(4);
      for (const e of exprs) {
        expect(e.kind).toBe('json-schema');
        expect(() => ajv.compile(e.schema as object)).not.toThrow();
      }
      expect(exprs[0].description).toContain('set(order_status)');
      expect(exprs[0].schema!.required).toEqual(['order_status']);
      expect(exprs[1].description).toContain('increment(retry_count)');
      expect(exprs[2].description).toContain('append(audit_log)');
      expect(exprs[3].description).toContain('remove(temp_flag)');
    });

    test('specifier 主链路：attributeEffects 注入后 → postconditionExpressions 含 structured effects', () => {
      const m = buildIntegrationModel();
      const t = m.derivable.transitions.find((x) => x.id === 'T1')!;
      t.attributeEffects = [
        { field: 'order_status', operation: 'set', value: 'paid' },
        { field: 'attempts', operation: 'increment' },
      ];
      const spec = specByAction(m, 'act_predicate');
      const post = spec.postconditionExpressions!;
      const attrExprs = post.filter((p) => p.description.includes('属性效果'));
      expect(attrExprs.length).toBe(2);
      expect(attrExprs[0].kind).toBe('json-schema');
      expect(attrExprs[0].schema!.required).toEqual(['order_status']);
      expect(attrExprs[1].description).toContain('increment(attempts)');
    });

    test('无 attributeEffects / 无谓词命中的 narrative effects → 保持 description-only（零回归）', () => {
      const m = buildIntegrationModel();
      const t = m.derivable.transitions.find((x) => x.id === 'T2')!;
      t.effects = ['状态改为已接单', 'count = count + 1'];
      const spec = specByAction(m, 'act_cross');
      const post = spec.postconditionExpressions!;
      // 赋值语义文本未按谓词语法书写 → description-only（R2-2：不混入 guard 值约束）
      for (const p of post) {
        expect(p.kind).toBe('description-only');
      }
    });
  });

  describe('④ level=data 不变量 → SchemaExpression 机械生成（转换测试，02 §5 B）', () => {
    test('invariantToSchemaExpression：unique 表达式 → json-schema', () => {
      const inv = model.derivable.invariants[0];
      expect(inv.level).toBe('data');
      const expr = invariantToSchemaExpression(inv);
      expect(expr.kind).toBe('json-schema');
      expect(expr.schema!.type).toBe('array');
      expect(expr.schema!.uniqueItems).toBe(true);
      expect(() => ajv.compile(expr.schema as object)).not.toThrow();
    });

    test('观测接口（IF_OBS_INV_*）postconditionExpressions 携带数据级不变量 schema', () => {
      const specs = specsFromEnvelope(specify(model));
      const obs = specs.find((s) => s.id === 'IF_OBS_INV_INV1')!;
      expect(obs.kind).toBe('observation');
      expect(obs.invariantIds).toEqual(['INV1']);
      const post = obs.postconditionExpressions ?? [];
      expect(post.length).toBe(1);
      expect(post[0].kind).toBe('json-schema');
      expect(post[0].schema!.uniqueItems).toBe(true);
    });

    test('非谓词表达式的数据级不变量 → description-only（原文保留）', () => {
      const inv = {
        id: 'INV9',
        name: '业务唯一',
        expression: '同一租户下 entry 域名唯一',
        scopeStateIds: ['S1'],
        declaredBy: 'system',
        invariantClass: 'intra_protocol' as const,
        level: 'data' as const,
      };
      const expr = invariantToSchemaExpression(inv);
      expect(expr.kind).toBe('description-only');
      expect(expr.description).toContain('INV9');
    });
  });

  describe('⑤ 老模型零回归：自然语言 guard 行为与 T2 一致', () => {
    test('既有复杂自然语言 guard 路径（多 token 布尔表达式）不被谓词命中改变', () => {
      const m = parseProtocolContent(`---
name: 回归协议
version: 1.0.0
purpose: TC4 零回归
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
| T1 | 布尔守卫 | S1 | S2 | act_bool | system | count > 0 && flag == true | | system | state_transition | |

# 不变量

# 不变量

（无）
`);
      const spec = specByAction(m, 'act_bool');
      // 字面量比较（count > 0 / flag == true）不属于受限谓词语法 → 走既有 boolean json-schema 路径
      expect(spec.preconditions![0].kind).toBe('json-schema');
      expect(spec.preconditions![0].schema!.type).toBe('boolean');
    });
  });
});
