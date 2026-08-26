/**
 * T4 TD4 buildInterfaceDetails 投影器（09-execution-T4.md TD4 / 08-project-viewer-design.md §5）
 *
 * 机械判据（TD4 验收）：
 * ① 演示实例 P1/IF_SYS_T4 条目与 08 §5.3 示例逐字段一致（triggerRoleId=platform /
 *    ownedTransitions=["T4"] / preconditionStates=["S2"] / postconditionStates=["S4"] /
 *    coveredInvariants 含 INV2"取消不产生履约费用" / diffImpact.affected=false /
 *    binding={hasBindings:false} / crossRefs 4 条均 downlink.resolved=false + reason 语义别名文案）；
 * ② P2/IF_SYS_T1 条目对账（coveredInvariants=[INV1,INV2] scope 真实值）；
 * ③ protocolVersions = {P1:"1.0.0", P2:"1.0.0"}；
 * ④ IF_SYS_T5 不在 entries.P2（diff 新增边界，08 §5.2.1）；
 * ⑤ downlink 正向：fixture 构造 target=真实状态 id → resolved=true + kind="state"；
 * ⑥ 观测接口 ownedTransitions=[]；
 * ⑦ 零回归：既有 webgen 测试全绿（全量 jest 验证）；
 * ⑧ tsc 0 errors + suite 全过。
 */

import { join } from 'node:path';
import { parseProtocolFile } from '../../src/parser/index.js';
import { specify } from '../../src/specifier/index.js';
import { buildWebData, buildBindingView } from '../../src/webgen/index.js';
import { buildCompositionWebData } from '../../src/webgen/composition.js';
import {
  buildInterfaceDetails,
  type InterfaceDetailsProtocolInput,
} from '../../src/webgen/interface-details.js';
import type { CrossProtocolRef } from '../../src/webgen/composition.js';
import type { WebDataJson, WebBindingView } from '../../src/webgen/index.js';

const DEMO = join(process.cwd(), 'examples', 'fulfillment-payment');

function buildDemoProtocols(): { protocols: InterfaceDetailsProtocolInput[]; crossRefs: CrossProtocolRef[]; bindingView: WebBindingView } {
  // 逐协议：model + specify + buildWebData（含 TD2 triggerRoleId backfill）
  const protocols: InterfaceDetailsProtocolInput[] = [];
  const allSpecs: ReturnType<typeof specify>['specs'][] = [];
  for (const pid of ['P1', 'P2']) {
    const model = parseProtocolFile(join(DEMO, 'protocol', pid, 'model.md'));
    const envelope = specify(model);
    allSpecs.push(envelope.specs);
    const webData = buildWebData({ specsEnvelope: envelope, model });
    protocols.push({ protocolId: pid, specs: envelope.specs, webData });
  }
  // 组合层 crossRefs（与 deriveProjectWeb 同源：buildCompositionWebData）
  const { parseCompositionFile } = require('../../src/composition-parser/index.js') as typeof import('../../src/composition-parser/index.js');
  const composition = parseCompositionFile(join(DEMO, 'protocol', 'composition.md'));
  const compData = buildCompositionWebData(composition, new Map([['P1', protocols[0].specs], ['P2', protocols[1].specs]]), new Map());
  const bindingView = buildBindingView(undefined, allSpecs.flat());
  return { protocols, crossRefs: compData.crossRefs, bindingView };
}

function buildDetails() {
  const { protocols, crossRefs, bindingView } = buildDemoProtocols();
  return buildInterfaceDetails({ protocols, crossRefs, bindingView });
}

describe('TD4 ① P1/IF_SYS_T4 条目与 08 §5.3 示例逐字段一致', () => {
  const details = buildDetails();
  const entry = details.entries.P1.IF_SYS_T4;

  test('interface 段关键字段（真实值）', () => {
    expect(entry.protocolId).toBe('P1');
    expect(entry.interface.id).toBe('IF_SYS_T4');
    expect(entry.interface.name).toBe('refund_cancel');
    expect(entry.interface.kind).toBe('system');
    expect(entry.interface.sourceId).toBe('refund_cancel');
    expect(entry.interface.actionType).toBe('state_transition');
    expect(entry.interface.triggerRoleId).toBe('platform'); // TD2 backfill 搬运
    expect(entry.interface.description).toBe('退款已批准 且 P2.S_refunded');
    expect(entry.interface.schemaKind).toBe('legacy-stub');
    expect(entry.interface.schemaDegradedReasons?.length).toBe(1);
    expect(entry.interface.isContractCarrier).toBeNull();
    expect(entry.interface.observesResourcePoolId).toBeNull();
    expect(entry.interface.errorResponses).toEqual([]);
    // requestSchema 全量（含 P2/S_refunded guard 参数）
    expect(entry.interface.requestSchema?.required).toEqual(['currentState', 'P2', 'S_refunded']);
  });

  test('relation 段：ownedTransitions/precondition/postcondition/coveredInvariants/diffImpact', () => {
    expect(entry.relation.ownedTransitions).toEqual(['T4']);
    expect(entry.relation.preconditionStates).toEqual(['S2']);
    expect(entry.relation.postconditionStates).toEqual(['S4']);
    // coveredInvariants：后置 S4 ∈ INV2.scope（S4）→ INV2（取消不产生履约费用）
    expect(entry.relation.coveredInvariants).toEqual([
      { id: 'INV2', name: '取消不产生履约费用', scopeStateIds: ['S4'], carrierRoleIds: ['platform'] },
    ]);
    expect(entry.relation.diffImpact).toEqual({
      affected: false,
      changedTransitions: [],
      changedStates: [],
      changedOthers: [],
      summary: null,
    });
  });

  test('binding 段 = {hasBindings:false}（实例无 bindings.yaml）', () => {
    expect(entry.binding).toEqual({ hasBindings: false });
  });

  test('crossRefs 4 条均 downlink.resolved=false + reason 语义别名文案', () => {
    expect(entry.crossRefs.length).toBe(4);
    for (const c of entry.crossRefs) {
      expect(c.kind).toBe('guard');
      expect(c.toProtocol).toBe('P2');
      expect(c.target).toBe('S_refunded');
      expect(c.downlink.resolved).toBe(false);
      expect(c.downlink.kind).toBeNull();
      expect(c.downlink.protocolId).toBe('P2');
      expect(c.downlink.target).toBe('S_refunded');
      // reason 语义别名文案（TD9 验收②展示口径）
      expect(c.downlink.reason).toContain('语义别名：P2 当前版本状态集无 S_refunded，接口/资源池亦无命中');
    }
    // sourceField 覆盖 precondition / preconditions[0] / inputs[1] / inputs[2]
    const fields = entry.crossRefs.map((c) => c.sourceField);
    expect(fields).toEqual(['precondition', 'preconditions[0].description', 'inputs[1].description', 'inputs[2].description']);
  });
});

describe('TD4 ② P2/IF_SYS_T1 条目对账（08 §5.3 示例）', () => {
  const details = buildDetails();
  const entry = details.entries.P2.IF_SYS_T1;

  test('interface 段 + triggerRoleId=customer', () => {
    expect(entry.interface.name).toBe('pay');
    expect(entry.interface.sourceId).toBe('pay');
    expect(entry.interface.triggerRoleId).toBe('customer');
    expect(entry.interface.schemaKind).toBe('structured');
  });

  test('relation 段：coveredInvariants=[INV1,INV2]（scope 真实值）', () => {
    expect(entry.relation.ownedTransitions).toEqual(['T1']);
    expect(entry.relation.preconditionStates).toEqual(['S0']);
    expect(entry.relation.postconditionStates).toEqual(['S1']);
    expect(entry.relation.coveredInvariants).toEqual([
      { id: 'INV1', name: '金额一致性', scopeStateIds: ['S0', 'S1', 'S2'], carrierRoleIds: ['customer', 'platform'] },
      { id: 'INV2', name: '支付幂等键唯一', scopeStateIds: ['S0', 'S1', 'S2'], carrierRoleIds: ['customer', 'platform'] },
    ]);
    expect(entry.relation.diffImpact.affected).toBe(false);
  });

  test('crossRefs 空（P2 IF_SYS_T1 无跨协议引用）', () => {
    expect(entry.crossRefs).toEqual([]);
  });
});

describe('TD4 ③ protocolVersions（R7）', () => {
  test('protocolVersions = {P1:"1.0.0", P2:"1.0.0"}（dataFile.sourceModelVersion 字段搬运）', () => {
    const details = buildDetails();
    expect(details.protocolVersions).toEqual({ P1: '1.0.0', P2: '1.0.0' });
    expect(details.schemaVersion).toBe('1.0');
    expect(details.kind).toBe('interface-details');
  });
});

describe('TD4 ④ IF_SYS_T5 不在 entries.P2（diff 新增边界，08 §5.2.1）', () => {
  test('P2 条目仅含 v1 协议数据接口（无 diff 新增 IF_SYS_T5）', () => {
    const details = buildDetails();
    expect(details.entries.P2.IF_SYS_T5).toBeUndefined();
    expect(Object.keys(details.entries.P2)).not.toContain('IF_SYS_T5');
    // P2 接口数 = 12（4 系统 + 8 观测）
    expect(Object.keys(details.entries.P2).length).toBe(12);
  });
});

describe('TD4 ⑤ downlink 正向：target=真实状态 id → resolved=true + kind="state"', () => {
  test('构造 crossRef target=P2 状态 S3 → resolved=true kind=state', () => {
    const { protocols, bindingView } = buildDemoProtocols();
    const fakeRefs: CrossProtocolRef[] = [
      {
        fromProtocol: 'P1',
        fromApi: 'IF_SYS_T4',
        sourceField: 'precondition',
        kind: 'guard',
        toProtocol: 'P2',
        target: 'S3', // P2 真实状态 id
        context: 'fake',
      },
    ];
    const details = buildInterfaceDetails({ protocols, crossRefs: fakeRefs, bindingView });
    const dl = details.entries.P1.IF_SYS_T4.crossRefs[0].downlink;
    expect(dl.resolved).toBe(true);
    expect(dl.kind).toBe('state');
    expect(dl.protocolId).toBe('P2');
    expect(dl.target).toBe('S3');
  });

  test('构造 crossRef target=接口 id → resolved=true kind="interface"', () => {
    const { protocols, bindingView } = buildDemoProtocols();
    const fakeRefs: CrossProtocolRef[] = [
      {
        fromProtocol: 'P1',
        fromApi: 'IF_SYS_T4',
        sourceField: 'precondition',
        kind: 'guard',
        toProtocol: 'P2',
        target: 'IF_SYS_T1', // P2 真实接口 id
        context: 'fake',
      },
    ];
    const details = buildInterfaceDetails({ protocols, crossRefs: fakeRefs, bindingView });
    const dl = details.entries.P1.IF_SYS_T4.crossRefs[0].downlink;
    expect(dl.resolved).toBe(true);
    expect(dl.kind).toBe('interface');
  });

  test('target=资源池 id（observesResourcePoolId 命中）→ resolved=true kind="resourcePool"', () => {
    const { protocols, bindingView } = buildDemoProtocols();
    // P2 无资源池观测接口 → 构造一个临时 webData 带 observesResourcePoolId 的接口
    const p2 = protocols[1];
    const webDataWithPool: WebDataJson = {
      ...p2.webData,
      interfaces: p2.webData.interfaces.map((i, idx) =>
        idx === 0 ? { ...i, observesResourcePoolId: 'order_pool' } : i
      ),
    };
    const protocols2: InterfaceDetailsProtocolInput[] = [
      { ...protocols[0] },
      { protocolId: 'P2', specs: p2.specs, webData: webDataWithPool },
    ];
    const fakeRefs: CrossProtocolRef[] = [
      {
        fromProtocol: 'P1',
        fromApi: 'IF_SYS_T4',
        sourceField: 'precondition',
        kind: 'guard',
        toProtocol: 'P2',
        target: 'order_pool',
        context: 'fake',
      },
    ];
    const details = buildInterfaceDetails({ protocols: protocols2, crossRefs: fakeRefs, bindingView });
    const dl = details.entries.P1.IF_SYS_T4.crossRefs[0].downlink;
    expect(dl.resolved).toBe(true);
    expect(dl.kind).toBe('resourcePool');
  });
});

describe('TD4 ⑥ 观测接口 ownedTransitions=[]', () => {
  test('P1/P2 全部观测接口 ownedTransitions 为空、triggerRoleId 缺省', () => {
    const details = buildDetails();
    for (const pid of ['P1', 'P2']) {
      for (const [ifid, entry] of Object.entries(details.entries[pid])) {
        if (entry.interface.kind !== 'observation') continue;
        expect(entry.relation.ownedTransitions).toEqual([]);
        expect(entry.interface.triggerRoleId).toBeNull();
      }
    }
  });
});
