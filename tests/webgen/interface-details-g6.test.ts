/**
 * G6 T3 · interface-details 投影接入单测（10 §17.3 C-G6-3 / 13-execution-G6 T3 验收③ 卡内层）
 *
 * 不依赖演示实例 bindings（演示实例当前无 bindings.yaml），用独立 jest fixture 构造含
 * roles[roleId].baseUrl 的 bindingView，断言：
 *  - transport 行按 roleId 拼出 server（G6-3 拼接逻辑，卡内闭环，不硬失败）；
 *  - interface.codeSamples 非空且 code 非空（G6-2）；
 *  - requestExample/responseExample 顶层字段集 ⊆ 对应 schema 叶子（G6-1 预检）。
 */
import { join } from 'node:path';
import { parseProtocolFile } from '../../src/parser/index.js';
import { specify } from '../../src/specifier/index.js';
import { buildWebData, type WebBindingView } from '../../src/webgen/index.js';
import {
  buildInterfaceDetails,
  type InterfaceDetailsProtocolInput,
} from '../../src/webgen/interface-details.js';
import type { CrossProtocolRef, ProjectInterfaceDetailData } from '../../src/webgen/index.js';

const DEMO = join(process.cwd(), 'examples', 'fulfillment-payment');

function buildDemoProtocolsOnly(): {
  protocols: InterfaceDetailsProtocolInput[];
  crossRefs: CrossProtocolRef[];
} {
  const protocols: InterfaceDetailsProtocolInput[] = [];
  const allSpecs: ReturnType<typeof specify>['specs'][] = [];
  for (const pid of ['P1', 'P2']) {
    const model = parseProtocolFile(join(DEMO, 'protocol', pid, 'model.md'));
    const envelope = specify(model);
    allSpecs.push(envelope.specs);
    const webData = buildWebData({ specsEnvelope: envelope, model });
    protocols.push({ protocolId: pid, specs: envelope.specs, webData, bindingsFingerprint: null });
  }
  const crossRefs: CrossProtocolRef[] = [];
  return { protocols, crossRefs };
}

/** 独立 fixture：含 roles[roleId].baseUrl 的 bindingView（演示实例真实无此数据，卡内补全） */
function fakeBindingView(): WebBindingView {
  return {
    hasBindings: true,
    roles: [
      { roleId: 'platform', baseUrl: 'https://pay.example.com' },
      { roleId: 'merchant', baseUrl: 'https://merchant.example.com' },
    ],
    interfaces: [
      { action: 'confirm_order', roleId: 'platform', protocol: 'P1', transport: { type: 'http', method: 'POST', path: '/v1/confirm' } },
      { action: 'complete_fulfillment', roleId: 'merchant', protocol: 'P1', transport: { type: 'http', method: 'POST', path: '/v1/complete' } },
    ],
    errorMap: { ERR_ORDER_NOT_FOUND: { httpStatus: 404 } },
    warnings: [],
  };
}

function buildWithBindingView(bv: WebBindingView): ProjectInterfaceDetailData {
  const { protocols, crossRefs } = buildDemoProtocolsOnly();
  return buildInterfaceDetails({ protocols, crossRefs, bindingView: bv });
}

/** 收集 object schema 顶层叶子 key（§17.6 未决③：仅顶层示例） */
function topLevelLeafKeys(schema: unknown): Set<string> {
  const s = schema as { type?: string; properties?: Record<string, unknown> } | undefined;
  if (s && s.type === 'object' && s.properties) return new Set(Object.keys(s.properties));
  return new Set();
}

describe('G6 T3 · transport server 拼接 + codeSamples + 示例字段集', () => {
  const bv = fakeBindingView();
  const details = buildWithBindingView(bv);

  test('G6-3（卡内逻辑）：transport 行按 roleId 拼出 server', () => {
    const confirm = details.entries['P1']['IF_SYS_T1'];
    expect(confirm).toBeDefined();
    expect(confirm.binding?.hasBindings).toBe(true);
    const t = confirm.binding?.transport ?? [];
    expect(t.length).toBeGreaterThan(0);
    const confirmTransport = t.find((x) => x.roleId === 'platform');
    expect(confirmTransport?.server).toBe('https://pay.example.com');
    // complete_fulfillment（action）→ IF_SYS_T3，含 merchant roleId → 拼出 merchant baseUrl
    const complete = details.entries['P1']['IF_SYS_T3'];
    const merchantTransport = (complete.binding?.transport ?? []).find((x) => x.roleId === 'merchant');
    expect(merchantTransport?.server).toBe('https://merchant.example.com');
  });

  test('G6-3：无 roleId 命中 → server 省略（不硬失败）', () => {
    const noRoleBv: WebBindingView = {
      hasBindings: true,
      roles: [{ roleId: 'platform', baseUrl: 'https://pay.example.com' }],
      interfaces: [{ action: 'confirm_order', transport: { type: 'http', method: 'POST', path: '/v1/confirm' } }],
      warnings: [],
    };
    const det = buildWithBindingView(noRoleBv);
    const t = det.entries['P1']['IF_SYS_T1'].binding?.transport ?? [];
    expect(t.length).toBe(1);
    expect(t[0].server).toBeUndefined();
  });

  test('G6-2：interface.codeSamples 非空且 code 非空', () => {
    for (const pid of Object.keys(details.entries)) {
      for (const iid of Object.keys(details.entries[pid])) {
        const cs = details.entries[pid][iid].interface.codeSamples;
        expect(Array.isArray(cs)).toBe(true);
        expect(cs!.length).toBeGreaterThan(0);
        for (const s of cs!) {
          expect(s.lang).toBeTruthy();
          expect(s.label).toBeTruthy();
          expect(typeof s.code === 'string' && s.code.length > 0).toBe(true);
        }
      }
    }
  });

  test('G6-1：requestExample/responseExample 顶层字段集 ⊆ 对应 schema 叶子', () => {
    const confirm = details.entries['P1']['IF_SYS_T1'];
    const i = confirm.interface;
    const reqLeaves = topLevelLeafKeys(i.requestSchema);
    const respLeaves = topLevelLeafKeys(i.responseSchema);
    if (reqLeaves.size > 0) {
      const reqKeys = Object.keys((i.requestExample as Record<string, unknown>) ?? {});
      for (const k of reqKeys) expect(reqLeaves.has(k)).toBe(true);
    } else {
      expect(i.requestExample).toBeNull();
    }
    if (respLeaves.size > 0) {
      const respKeys = Object.keys((i.responseExample as Record<string, unknown>) ?? {});
      for (const k of respKeys) expect(respLeaves.has(k)).toBe(true);
    } else {
      expect(i.responseExample).toBeNull();
    }
  });

  test('G6-6：脱敏——binding 投影不含 authConfig/tls 红名单键', () => {
    const json = JSON.stringify(details.entries['P1']['IF_SYS_T1'].binding);
    expect(json).not.toMatch(/authConfig|"tls"|\.secret/);
  });
});
