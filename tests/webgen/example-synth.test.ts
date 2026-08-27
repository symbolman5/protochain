/**
 * G6 T2 · 示例合成助手单测（10 §17.3 C-G6-2 / 13-execution-G6 T2 验收）
 *
 * 覆盖：确定性（同 schema+seed 同输出）/ 各 type 分支 / buildCodeSamples 三语言非空 code /
 * 红名单键脱敏（G6-6）/ 失败降级（schema 缺失 → null）。
 */
import { synthesizeExample, buildCodeSamples, containsSensitiveKeys } from '../../src/webgen/example-synth.js';
import type { JSONSchema } from '../../src/model/types.js';

describe('G6 T2 · synthesizeExample', () => {
  const sampleSchema: JSONSchema = {
    type: 'object',
    properties: {
      order_id: { type: 'string', description: '订单号' },
      qty: { type: 'integer' },
      price: { type: 'number' },
      paid: { type: 'boolean' },
      tags: { type: 'array', items: { type: 'string', description: '标签' } },
      meta: {
        type: 'object',
        properties: { note: { type: 'string', description: '备注' } },
      },
      status: { type: 'string', enum: ['created', 'paid'] },
    },
    required: ['order_id'],
  };

  it('确定性：同 schema+seed 连续 10 次调用输出一致', () => {
    const a = synthesizeExample(sampleSchema, 'P1.IF_SYS_T1.request');
    for (let i = 0; i < 10; i++) {
      const b = synthesizeExample(sampleSchema, 'P1.IF_SYS_T1.request');
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    }
  });

  it('各 type 分支覆盖（enum/string/integer/number/boolean/array/object）', () => {
    const out = synthesizeExample(sampleSchema, 'P1.IF_SYS_T1.request') as Record<string, unknown>;
    expect(out.order_id).toMatch(/^订单号-/);
    expect(out.qty).toBe(0);
    expect(out.price).toBe(1);
    expect(out.paid).toBe(true);
    expect(Array.isArray(out.tags)).toBe(true);
    expect((out.tags as unknown[]).length).toBe(1);
    expect(typeof (out.tags as unknown[])[0]).toBe('string');
    expect((out.meta as Record<string, unknown>).note).toMatch(/^备注-/);
    expect(out.status).toBe('created'); // enum 取首项
  });

  it('null 类型 / 缺省 schema → 返回 null（失败降级，不抛）', () => {
    expect(synthesizeExample({ type: 'null' }, 'x')).toBeNull();
    expect(synthesizeExample(undefined, 'x')).toBeNull();
    expect(synthesizeExample(null, 'x')).toBeNull();
  });

  it('G6-6 脱敏：合成结果不含 authConfig/tls 红名单键', () => {
    const out = synthesizeExample(sampleSchema, 'P1.IF_SYS_T1.request');
    expect(containsSensitiveKeys(out)).toBe(false);
  });
});

describe('G6 T2 · buildCodeSamples', () => {
  const spec = {
    id: 'IF_SYS_T1',
    requestSchema: {
      type: 'object',
      properties: { order_id: { type: 'string', description: '订单号' } },
    } as JSONSchema,
  };

  it('三语言分支（curl / javascript / python）各生成非空 code', () => {
    const samples = buildCodeSamples(spec, [
      { method: 'POST', path: '/v1/confirm', server: 'https://api.example.com' },
    ]);
    const langs = samples.map((s) => s.lang);
    expect(langs).toContain('curl');
    expect(langs).toContain('javascript');
    expect(langs).toContain('python');
    for (const s of samples) {
      expect(s.code.length).toBeGreaterThan(0);
      expect(s.label.length).toBeGreaterThan(0);
    }
  });

  it('完整 URL：server + path 正确拼接（G6-3 基础）', () => {
    const [curl] = buildCodeSamples(spec, [
      { method: 'POST', path: '/v1/confirm', server: 'https://api.example.com/' },
    ]).filter((s) => s.lang === 'curl');
    expect(curl.code).toContain("'https://api.example.com/v1/confirm'");
  });

  it('无 transport → 单组兜底，codeSamples 非空（G6-2）', () => {
    const samples = buildCodeSamples(spec, []);
    expect(samples.length).toBe(3);
    for (const s of samples) expect(s.code.length).toBeGreaterThan(0);
  });

  it('请求 body 由 requestSchema 派生，纯 schema 无敏感键', () => {
    const samples = buildCodeSamples(spec, [
      { method: 'POST', path: '/v1/confirm', server: 'https://api.example.com' },
    ]);
    for (const s of samples) expect(containsSensitiveKeys(s.code)).toBe(false);
  });
});
