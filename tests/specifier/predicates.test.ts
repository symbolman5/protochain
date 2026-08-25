/**
 * W2 受限谓词库翻译器测试（07-execution-T3 TC3）
 *
 * 机械判据（TC3 验收，02 §3 W2-b）：
 * ① 谓词库内每个谓词至少一条正向 + 一条反向：
 *    - 正向 = 语法命中 → kind='json-schema' 且 schema 可被 ajv 编译（逐表达式断言）；
 *    - 反向 = 形近但未按语法书写（含自然语言中文句子）→ 判定未命中
 *      （翻译函数对自然语言输入返回值恒为 null，不做模式匹配，红线 2）；
 * ② 翻译确定性：同输入两次调用结果深度一致（可 diff）；
 * ③ tsc 0 errors + suite 全过。
 */

import Ajv from 'ajv';
import { translatePredicate, matchesPredicateSyntax } from '../../src/specifier/predicates.js';

const ajv = new Ajv({ allErrors: true, strict: false });

/** 正向断言：命中 + json-schema + ajv 可编译 */
function expectHit(expr: string): void {
  const t = translatePredicate(expr);
  expect(t).not.toBeNull();
  expect(t!.kind).toBe('json-schema');
  // ajv 可编译（逐表达式断言，编译断言内置单测）
  expect(() => ajv.compile(t!.schema as object)).not.toThrow();
  // matchesPredicateSyntax 与 translatePredicate 判定一致
  expect(matchesPredicateSyntax(expr)).toBe(true);
}

/** 反向断言：未命中（含自然语言，恒 null） */
function expectMiss(expr: string): void {
  expect(translatePredicate(expr)).toBeNull();
  expect(matchesPredicateSyntax(expr)).toBe(false);
}

describe('TC3 W2 受限谓词翻译器（predicates.ts）', () => {
  describe('① 正向：每个谓词命中 → json-schema 且 ajv 可编译', () => {
    test('nonEmpty(field) → string minLength 1', () => {
      expectHit('nonEmpty(order_id)');
      const t = translatePredicate('nonEmpty(order_id)')!;
      expect(t.schema).toEqual({ type: 'string', minLength: 1, description: 'order_id 非空' });
    });

    test('nonNegative(field) → number minimum 0', () => {
      expectHit('nonNegative(stock)');
      const t = translatePredicate('nonNegative(stock)')!;
      expect(t.schema).toEqual({ type: 'number', minimum: 0, description: 'stock 非负' });
    });

    test('unique(field) → array uniqueItems', () => {
      expectHit('unique(entry_id)');
      const t = translatePredicate('unique(entry_id)')!;
      expect(t.schema).toEqual({ type: 'array', uniqueItems: true, description: 'entry_id 值唯一' });
    });

    test('matchesPattern(field, "regex") → string pattern', () => {
      expectHit('matchesPattern(mobile, "^1[0-9]{10}$")');
      const t = translatePredicate('matchesPattern(mobile, "^1[0-9]{10}$")')!;
      expect(t.schema).toEqual({
        type: 'string',
        pattern: '^1[0-9]{10}$',
        description: 'mobile 匹配 ^1[0-9]{10}$',
      });
    });

    test('fieldA == fieldB → 结构表达（字段必填）', () => {
      expectHit('paid_amount == order_amount');
      const t = translatePredicate('paid_amount == order_amount')!;
      expect(t.schema).toEqual({
        type: 'object',
        properties: { paid_amount: {}, order_amount: {} },
        required: ['paid_amount', 'order_amount'],
        description: '跨字段相等约束：paid_amount == order_amount',
      });
    });

    test('fieldA < fieldB → 结构表达（number + 必填）', () => {
      expectHit('stock < reorder_point');
      const t = translatePredicate('stock < reorder_point')!;
      expect(t.schema).toEqual({
        type: 'object',
        properties: { stock: { type: 'number' }, reorder_point: { type: 'number' } },
        required: ['stock', 'reorder_point'],
        description: '跨字段小于约束：stock < reorder_point',
      });
    });

    test('sum(f1, f2) == total → 结构表达', () => {
      expectHit('sum(item_price, item_quantity) == order_amount');
      const t = translatePredicate('sum(item_price, item_quantity) == order_amount')!;
      expect(t.schema.required).toEqual(['item_price', 'item_quantity', 'order_amount']);
    });

    test('invariant(INVn) → 跨接口引用挂载 InvariantDef', () => {
      expectHit('invariant(INV1)');
      const t = translatePredicate('invariant(INV1)')!;
      expect(t.schema.type).toBe('object');
      expect(t.description).toContain('INV1');
    });

    test('空白容忍：谓词内/操作符周围空白不破坏命中', () => {
      expectHit('nonEmpty( order_id )');
      expectHit('paid_amount  ==  order_amount');
      expectHit('sum( item_price , item_quantity ) == order_amount');
    });
  });

  describe('① 反向：形近但未按语法书写 → 恒未命中（不做模式匹配）', () => {
    test('自然语言中文句子 → null', () => {
      expectMiss('金额必须一致');
      expectMiss('订单号非空');
      expectMiss('库存不能为负');
      expectMiss('各菜品金额之和等于订单金额');
    });

    test('英文自然语言句子 → null', () => {
      expectMiss('the amount must match');
      expectMiss('order id is required and non empty');
    });

    test('裸谓词名（无括号）→ null', () => {
      expectMiss('nonEmpty');
      expectMiss('nonNegative');
      expectMiss('unique');
    });

    test('字面量比较（如 amount == 100）不属于谓词语法（两侧需为字段）→ null', () => {
      expectMiss('amount == 100');
      expectMiss('stock < 10');
    });

    test('引号不匹配 / 缺失逗号 / 多余符号 → null', () => {
      expectMiss(`matchesPattern(mobile, '^1[0-9]{10}$')`); // 单引号不匹配
      expectMiss('matchesPattern(mobile "abc")');           // 缺逗号
      expectMiss('sum(item_price item_quantity) == total'); // 缺逗号
      expectMiss('paid_amount == order_amount!');           // 多余符号
      expectMiss('nonEmpty(order_id) extra');               // 尾部多余
    });

    test('谓词关键字被占用为字段名 → null（防歧义）', () => {
      expectMiss('sum == total');
      expectMiss('nonEmpty == x');
    });
  });

  describe('② 翻译确定性：同输入两次调用结果深度一致（可 diff）', () => {
    const samples = [
      'nonEmpty(order_id)',
      'nonNegative(stock)',
      'unique(entry_id)',
      'matchesPattern(mobile, "^1[0-9]{10}$")',
      'paid_amount == order_amount',
      'stock < reorder_point',
      'sum(item_price, item_quantity) == order_amount',
      'invariant(INV1)',
      '金额必须一致', // 未命中也必须确定（恒 null）
    ];
    test('同输入两次调用深度一致', () => {
      for (const s of samples) {
        expect(translatePredicate(s)).toEqual(translatePredicate(s));
      }
    });
  });

  describe('③ 边界：空串 / 纯空白 → null', () => {
    test('空串与空白', () => {
      expectMiss('');
      expectMiss('   ');
      expectMiss(undefined as unknown as string);
    });
  });
});
