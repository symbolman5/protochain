/**
 * E5：scaffolder --lang=ts 生成 transport clients 单测
 *
 * 覆盖：
 *  - generateTsClients(http bindings) → http.ts 产物，方法名 ≠ 直接进入模板
 *    （http.ts 是包装 client；方法名一致性由 invoke(action) 入参保证）
 *  - generateTsClients(kafka/nsq) → kafka.ts/nsq.ts 产出
 *  - generateTsClients(bindings 缺) → 空对象
 *  - 模板占位替换 {PROTOCOL_NAME}/{PROTOCOL_VERSION}
 */

import { generateTsClients } from '../../src/scaffolder/index.js';
import type { BindingConfig, InterfaceSpec } from '../../src/model/types.js';

const BASE_SPECS: InterfaceSpec[] = [
  {
    id: 'IF_SYS_T1',
    kind: 'system',
    sourceId: 'create',
    name: 'create',
    inputs: [{ name: 'x', type: 'string' }],
    outputs: [],
  },
];

describe('E5 scaffolder --lang=ts', () => {
  it('生成 http.ts（http bindings 存在）', () => {
    const bindings: BindingConfig = {
      roles: {
        'R-Op': { roleId: 'R-Op', baseUrl: 'http://x', auth: 'none' },
      },
      interfaces: [
        {
          action: 'create',
          roleId: 'R-Op',
          transport: { type: 'http', method: 'POST', path: '/v1/x', params: [] },
        },
      ],
    };
    const r = generateTsClients({
      specs: BASE_SPECS,
      bindings,
      protocolName: 'p1',
      protocolVersion: '1.0.0',
    });
    expect(r['http.ts']).toBeDefined();
    expect(r['http.ts']).toContain('p1');
    expect(r['http.ts']).toContain('1.0.0');
    expect(r['http.ts']).toContain('class HttpClient');
    expect(r['kafka.ts']).toBeUndefined();
    expect(r['nsq.ts']).toBeUndefined();
  });

  it('同时存在 http/kafka/nsq 时全部生成', () => {
    const bindings: BindingConfig = {
      roles: {
        'R-Op': { roleId: 'R-Op', baseUrl: 'http://x', auth: 'none' },
        'R-Kafka': { roleId: 'R-Kafka', baseUrl: 'http://y', auth: 'none', kafka: { brokersEnv: 'BROKERS' } },
        'R-Nsq': { roleId: 'R-Nsq', baseUrl: 'http://z', auth: 'none', nsq: { nsqdTcpEnv: 'NSQD' } },
      },
      interfaces: [
        { action: 'create', roleId: 'R-Op', transport: { type: 'http', method: 'POST', path: '/v1/x', params: [] } },
        { action: 'kafkaPub', roleId: 'R-Kafka', transport: { type: 'kafka', topic: 't', serde: 'json', responseMode: 'none' } },
        { action: 'nsqPub', roleId: 'R-Nsq', transport: { type: 'nsq', topic: 't', serde: 'json', responseMode: 'none' } },
      ],
    };
    const r = generateTsClients({
      specs: BASE_SPECS,
      bindings,
      protocolName: 'p',
      protocolVersion: '0.1.0',
    });
    expect(r['http.ts']).toBeDefined();
    expect(r['kafka.ts']).toBeDefined();
    expect(r['nsq.ts']).toBeDefined();
    // kafka/nsq 模板用 kafkajs / nsqjs
    expect(r['kafka.ts']).toContain("from 'kafkajs'");
    expect(r['nsq.ts']).toContain("from 'nsqjs'");
  });

  it('bindings 缺 → 空对象（不抛错）', () => {
    const r = generateTsClients({
      specs: BASE_SPECS,
      bindings: undefined,
      protocolName: 'p',
      protocolVersion: '0.1.0',
    });
    expect(r).toEqual({});
  });

  it('模板占位替换 {PROTOCOL_NAME} / {PROTOCOL_VERSION}', () => {
    const bindings: BindingConfig = {
      roles: { 'R-Op': { roleId: 'R-Op', baseUrl: 'http://x', auth: 'none' } },
      interfaces: [
        { action: 'x', roleId: 'R-Op', transport: { type: 'http', method: 'GET', path: '/x', params: [] } },
      ],
    };
    const r = generateTsClients({
      specs: BASE_SPECS,
      bindings,
      protocolName: 'strangler-fig-P1',
      protocolVersion: '2.5.0',
    });
    // 模板头部注释包含协议名/版本
    expect(r['http.ts']).toContain('strangler-fig-P1');
    expect(r['http.ts']).toContain('2.5.0');
    // 不留原始占位符
    expect(r['http.ts']).not.toContain('{PROTOCOL_NAME}');
    expect(r['http.ts']).not.toContain('{PROTOCOL_VERSION}');
  });

  it('bindings 只含 http，不生成 kafka/nsq', () => {
    const bindings: BindingConfig = {
      roles: { 'R-Op': { roleId: 'R-Op', baseUrl: 'http://x', auth: 'none' } },
      interfaces: [
        { action: 'create', roleId: 'R-Op', transport: { type: 'http', method: 'POST', path: '/x', params: [] } },
      ],
    };
    const r = generateTsClients({
      specs: BASE_SPECS,
      bindings,
      protocolName: 'p',
      protocolVersion: '0.1.0',
    });
    expect(r['http.ts']).toBeDefined();
    expect(r['kafka.ts']).toBeUndefined();
    expect(r['nsq.ts']).toBeUndefined();
  });
});