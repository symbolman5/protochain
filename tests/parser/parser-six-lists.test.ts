/**
 * R1a：六张清单 DSL 解析层验收测试
 *
 * 覆盖（机械验收 R1a-2 / R1a-3 / R1a-4）：
 * - 六张清单形态 model.md（含「操作」「实体维度」段，无状态机段）解析出完整 IR：
 *   OperationDef（role→triggerRoleId、操作→name、guard、change→changes/affectsDimensions/
 *   sideEffects、trigger→triggerType 四值）+ EntityDimensionDef + 附属实体维度投影（kind 断言）；
 * - change 的「X.y=z」正确拆到 target（changes[].entity）/ affectsDimensions（changes[].dimension）；
 * - specifier 从 operations 推导 InterfaceSpec（triggerType 三值映射、affectsDimensions/sideEffects 投影）；
 * - 无状态机段的模型 check 机械层通过（不因缺状态空间/初始状态报 error）；
 * - 老状态机实例（food-delivery 等）解析零回归由全量 jest 套件保障（本文件不触碰老 fixture）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProtocolContent, ParseError } from '../../src/parser/index.js';
import { checkCompleteness } from '../../src/checker/index.js';
import { specify } from '../../src/specifier/index.js';

const FIXTURES = join(process.cwd(), 'tests/fixtures');
const content = readFileSync(join(FIXTURES, 'six-lists-model.md'), 'utf-8');
const model = parseProtocolContent(content, 'six-lists-model.md');

describe('R1a 六张清单 DSL 解析层', () => {
  describe('「操作」段解析（表2，操作=改实体维度）', () => {
    test('operations 按声明顺序生成 OP1..OPn', () => {
      const ops = model.derivable.operations!;
      expect(ops).toHaveLength(4);
      expect(ops.map((o) => o.id)).toEqual(['OP1', 'OP2', 'OP3', 'OP4']);
    });

    test('role→triggerRoleId、操作→name、guard、target 原文保留', () => {
      const op1 = model.derivable.operations![0];
      expect(op1.triggerRoleId).toBe('publisher');
      expect(op1.name).toBe('匿名发布资源');
      expect(op1.guard).toBe('发布形态合法');
      expect(op1.target).toBe('资源 ＋ 认领码');
    });

    test('target 解析：＋ 连接多实体、｜ 分支', () => {
      const op1 = model.derivable.operations![0];
      expect(op1.targetEntities).toEqual(['资源', '认领码']);
      // 分支形态（「＋（A ｜ B）」）在变更单测中由 parser 统一处理
      const op3 = model.derivable.operations![2];
      expect(op3.targetEntities).toEqual(['短时映射实例']);
    });

    test('change 的 X.y=z 正确拆到 target（changes[].entity）/ affectsDimensions', () => {
      const op1 = model.derivable.operations![0];
      expect(op1.changes).toEqual([
        { entity: '资源', dimension: '归属状态', value: '无归属' },
        { entity: '资源', dimension: '处置状态', value: '正常' },
        { entity: '认领码', dimension: '兑付状态', value: '未使用' },
      ]);
      expect(op1.affectsDimensions).toEqual(['归属状态', '处置状态', '兑付状态']);
      // 非 X.y=z 文本段进 sideEffects
      expect(op1.sideEffects).toEqual(['派生 1 个认领码']);
    });

    test('无实体前缀的「维度=值」也进 affectsDimensions（entity 留空不猜测）', () => {
      const op3 = model.derivable.operations![2];
      expect(op3.changes).toEqual([{ entity: '', dimension: '连接状态', value: '离线' }]);
      expect(op3.affectsDimensions).toEqual(['连接状态']);
      expect(op3.sideEffects).toEqual([]);
    });

    test('判断接口（change 无 =）→ affectsDimensions 空、副作用保留原文', () => {
      const op2 = model.derivable.operations![1];
      expect(op2.changes).toEqual([]);
      expect(op2.affectsDimensions).toEqual([]);
      expect(op2.sideEffects.length).toBeGreaterThan(0);
      expect(op2.sideEffects.join('；')).toContain('判断接口');
    });

    test('trigger 四值枚举（role|observed|scheduled|cross）', () => {
      expect(model.derivable.operations!.map((o) => o.triggerType)).toEqual([
        'role',
        'role',
        'scheduled',
        'cross',
      ]);
    });

    test('trigger 非法值 → ParseError', () => {
      const bad = content.replace('trigger: cross', 'trigger: manual');
      expect(() => parseProtocolContent(bad, 'bad.md')).toThrow(ParseError);
    });
  });

  describe('「实体维度」段解析（表3，一行一个维度）', () => {
    test('entityDimensions 保留 entity/etype/dim/kind/domain 原文', () => {
      const dims = model.derivable.entityDimensions!;
      expect(dims).toHaveLength(5);
      const dim = dims[0];
      expect(dim.entity).toBe('资源');
      expect(dim.etype).toBe('记录');
      expect(dim.dimension).toBe('归属状态');
      expect(dim.kind).toBe('declared');
      expect(dim.domain).toBe('{无归属, 已认领}');
    });

    test('投影为附属实体 stateSpace.dimensions（kind 断言，kindSource=asserted）', () => {
      const ents = model.derivable.subsidiaryEntities!;
      // 5 行维度分属 4 个实体：资源(2)/认领码(1)/短时映射实例(1)/账号(1)
      expect(ents).toHaveLength(4);
      const resource = ents.find((e) => e.id === '资源')!;
      expect(resource).toBeDefined();
      expect(resource.stateSpace.dimensions).toHaveLength(2);
      const dim = resource.stateSpace.dimensions.find((d) => d.name === '归属状态')!;
      expect(dim.kind).toBe('declared');
      expect(dim.kindSource).toBe('asserted');
      // kind=observed 断言同样投影
      const inst = ents.find((e) => e.id === '短时映射实例')!;
      const conn = inst.stateSpace.dimensions.find((d) => d.name === '连接状态')!;
      expect(conn.kind).toBe('observed');
      expect(conn.kindSource).toBe('asserted');
      // 值域原文 → type enum[...]
      expect(dim.type).toBe('enum[无归属, 已认领]');
      // 投影附属实体 cascadeRules 非空（checker R7b 硬要求）
      for (const ent of ents) {
        expect(ent.cascadeRules.length).toBeGreaterThan(0);
      }
    });

    test('kind 非法值 → ParseError', () => {
      // T2b：computed 已合法（三值 declared/observed/computed）；非法值改用未知枚举
      const bad = content.replace('kind: observed', 'kind: invalid-kind');
      expect(() => parseProtocolContent(bad, 'bad.md')).toThrow(ParseError);
    });
  });

  describe('specifier 从 operations 推导 InterfaceSpec（R1a 改动1）', () => {
    const envelope = specify(model);
    const specs = envelope.specs;
    const byName = new Map(specs.map((s) => [s.name, s]));

    test('操作段每条派生一个系统接口（IF_SYS_OPn）', () => {
      const op1 = byName.get('匿名发布资源');
      expect(op1).toBeDefined();
      expect(op1!.id).toBe('IF_SYS_OP1');
      expect(op1!.kind).toBe('system');
      expect(op1!.sourceId).toBe('匿名发布资源');
    });

    test('guard→preconditions、change→affectsDimensions+sideEffects', () => {
      const op1 = byName.get('匿名发布资源')!;
      expect(op1.precondition).toBe('发布形态合法');
      expect(op1.preconditions?.length).toBeGreaterThan(0);
      expect(op1.affectsDimensions).toEqual(['归属状态', '处置状态', '兑付状态']);
      expect(op1.sideEffects?.some((s) => s.description?.includes('派生 1 个认领码'))).toBe(true);
    });

    test('trigger 四值映射三值：role→role、scheduled→system、cross→external', () => {
      expect(byName.get('匿名发布资源')!.triggerType).toBe('role');
      expect(byName.get('心跳超时判定')!.triggerType).toBe('system');
      expect(byName.get('收到退款回调')!.triggerType).toBe('external');
    });

    test('判断接口 affectsDimensions 为空投影', () => {
      const op2 = byName.get('请求访问资源')!;
      expect(op2.affectsDimensions).toEqual([]);
    });

    test('维度 kind 断言经 buildDimensionKinds 带出（无 W(dim) 不冲突不降级）', () => {
      const dims = envelope.dimensions;
      const conn = dims.find((d) => d.dimension === '连接状态');
      expect(conn?.kind).toBe('observed');
      expect(conn?.kindSource).toBe('asserted');
      const owner = dims.find((d) => d.dimension === '归属状态');
      expect(owner?.kind).toBe('declared');
    });
  });

  describe('check 机械层（R1a-3：无状态机段不因缺状态空间报错）', () => {
    test('checkCompleteness 机械层 passed=true（零 error）', () => {
      const report = checkCompleteness(model);
      const allIssues = [
        ...report.mechanical.structuralIssues,
        ...report.mechanical.fieldIssues,
        ...report.mechanical.referenceIssues,
      ];
      expect(report.mechanical.passed).toBe(true);
      expect(allIssues.filter((i) => i.severity === 'error')).toEqual([]);
    });
  });

  describe('老实例零回归（R1a-4：状态机为兼容层，声明状态机段的模型不受影响）', () => {
    const foodContent = readFileSync(
      join(process.cwd(), 'examples/food-delivery/protocol/model.md'),
      'utf-8'
    );

    test('food-delivery：状态机段照常解析，六张清单段不误入', () => {
      const fd = parseProtocolContent(foodContent, 'food-delivery/model.md');
      expect(fd.derivable.states).toHaveLength(8); // S0~S7
      expect(fd.derivable.transitions).toHaveLength(11); // T1~T10 + T5b
      expect(fd.derivable.subsidiaryEntities).toHaveLength(2); // 原附属实体段
      expect(fd.derivable.operations).toBeUndefined();
      expect(fd.derivable.entityDimensions).toBeUndefined();
    });

    test('fulfillment-payment（P1）：状态机段照常解析，六张清单段不误入', () => {
      const fp = parseProtocolContent(
        readFileSync(
          join(process.cwd(), 'examples/fulfillment-payment/protocol/P1/model.md'),
          'utf-8'
        ),
        'fulfillment-payment/P1/model.md'
      );
      expect(fp.derivable.transitions.length).toBeGreaterThan(0);
      expect(fp.derivable.operations).toBeUndefined();
      expect(fp.derivable.entityDimensions).toBeUndefined();
    });
  });
});
