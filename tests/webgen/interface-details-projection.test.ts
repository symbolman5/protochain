/**
 * TI3 (C-1/C-2/C-3) interface-details 投影器演进单测（10 §3-1/§3-2/§4；11 执行编排 §2 TI3）。
 *
 * 覆盖：
 * ① 每条 entry.interface.interfaceType ∈ 三值且非空（声明优先、缺省机械兜底）；
 * ② catalog 三索引（byProtocol/byRole/byPreconditionState）与 entries 分组一致；
 *    - byRole：triggerRoleId=null 系统接口 → "系统/未指派角色"；观测接口 → "观测"；否则按 role id；
 *    - byPreconditionState：多 from 的同一接口在多个前置状态组重复出现（不去重、标多归属）；
 * ③ binding.bindingsFingerprintAtBuild 等于传入的 per-protocol 指纹（C-3 纯记录；null 时记 null）；
 * ④ schemaVersion === '1.1'（加法式演进，老模型亦升 1.1，Gif-4①）。
 *
 * 不依赖演示实例具体条目数/名称，仅断言结构不变量 + 归组边界规则，便于机械重算（Gif-5 基准）。
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
import type { WebBindingView } from '../../src/webgen/index.js';

const DEMO = join(process.cwd(), 'examples', 'fulfillment-payment');
const FAKE_FP = 'fake-bindings-sha256-for-ti3-test';

function buildDemoProtocols(): {
  protocols: InterfaceDetailsProtocolInput[];
  crossRefs: CrossProtocolRef[];
  bindingView: WebBindingView;
} {
  const protocols: InterfaceDetailsProtocolInput[] = [];
  const allSpecs: ReturnType<typeof specify>['specs'][] = [];
  for (const pid of ['P1', 'P2']) {
    const model = parseProtocolFile(join(DEMO, 'protocol', pid, 'model.md'));
    const envelope = specify(model);
    allSpecs.push(envelope.specs);
    const webData = buildWebData({ specsEnvelope: envelope, model });
    // TI3：传入 per-protocol 指纹，验证其被记录到每个 entry.binding.bindingsFingerprintAtBuild
    protocols.push({ protocolId: pid, specs: envelope.specs, webData, bindingsFingerprint: FAKE_FP });
  }
  const { parseCompositionFile } = require('../../src/composition-parser/index.js') as typeof import('../../src/composition-parser/index.js');
  const composition = parseCompositionFile(join(DEMO, 'protocol', 'composition.md'));
  const compData = buildCompositionWebData(
    composition,
    new Map([
      ['P1', protocols[0].specs],
      ['P2', protocols[1].specs],
    ]),
    new Map()
  );
  const bindingView = buildBindingView(undefined, allSpecs.flat());
  return { protocols, crossRefs: compData.crossRefs, bindingView };
}

function buildDetails() {
  const { protocols, crossRefs, bindingView } = buildDemoProtocols();
  return buildInterfaceDetails({ protocols, crossRefs, bindingView });
}

const VALID_TYPES = new Set(['state_machine', 'contract_carrier', 'observation']);

describe('TI3 interface-details 投影器演进', () => {
  const details = buildDetails();

  test('schemaVersion === "1.1"（C-1/C-3 加法式演进）', () => {
    expect(details.schemaVersion).toBe('1.1');
  });

  test('每条 entry.interface.interfaceType ∈ 三值且非空', () => {
    const all: string[] = [];
    for (const pid of Object.keys(details.entries)) {
      for (const iid of Object.keys(details.entries[pid])) {
        const t = details.entries[pid][iid].interface.interfaceType;
        expect(t).toBeDefined();
        expect(VALID_TYPES.has(t as string)).toBe(true);
        all.push(t as string);
      }
    }
    // 演示实例至少含 state_machine 与 observation 两类（结构不变量，不依赖具体 id）
    expect(all).toContain('state_machine');
    expect(all).toContain('observation');
  });

  test('catalog.byProtocol 与 entries 分组一致', () => {
    for (const pid of Object.keys(details.entries)) {
      const ids = details.catalog!.byProtocol[pid].map((r) => r.interfaceId).sort();
      const expected = Object.keys(details.entries[pid]).sort();
      expect(ids).toEqual(expected);
      // 每条 entry 必出现在 byProtocol[pid] 且 protocolId 自洽
      for (const r of details.catalog!.byProtocol[pid]) {
        expect(r.protocolId).toBe(pid);
        expect(details.entries[r.protocolId][r.interfaceId]).toBeDefined();
      }
    }
  });

  test('catalog.byRole 归组边界：null role→"系统/未指派角色"、观测→"观测"、否则按 role', () => {
    for (const pid of Object.keys(details.entries)) {
      for (const iid of Object.keys(details.entries[pid])) {
        const entry = details.entries[pid][iid];
        const expectedKey =
          entry.interface.kind === 'observation'
            ? '观测'
            : entry.interface.triggerRoleId == null
              ? '系统/未指派角色'
              : entry.interface.triggerRoleId;
        const hit = details.catalog!.byRole[expectedKey]?.some(
          (r) => r.protocolId === pid && r.interfaceId === iid
        );
        expect(hit).toBe(true);
      }
    }
  });

  test('catalog.byPreconditionState：多 from 同一接口在多个前置状态组重复出现（不去重）', () => {
    for (const pid of Object.keys(details.entries)) {
      for (const iid of Object.keys(details.entries[pid])) {
        const entry = details.entries[pid][iid];
        for (const sid of entry.relation.preconditionStates) {
          const hit = details.catalog!.byPreconditionState[sid]?.some(
            (r) => r.protocolId === pid && r.interfaceId === iid
          );
          expect(hit).toBe(true);
        }
      }
    }
  });

  test('binding.bindingsFingerprintAtBuild === 传入的 per-protocol 指纹（C-3 纯记录）', () => {
    for (const pid of Object.keys(details.entries)) {
      for (const iid of Object.keys(details.entries[pid])) {
        const binding = details.entries[pid][iid].binding;
        expect(binding).not.toBeNull();
        expect(binding!.bindingsFingerprintAtBuild).toBe(FAKE_FP);
      }
    }
  });

  test('无指纹传入时 binding.bindingsFingerprintAtBuild === null（演示实例无 bindings.yaml 的等价路径）', () => {
    const { protocols, crossRefs, bindingView } = buildDemoProtocols();
    const noFp = protocols.map((p) => ({ ...p, bindingsFingerprint: null }));
    const det = buildInterfaceDetails({ protocols: noFp, crossRefs, bindingView });
    for (const pid of Object.keys(det.entries)) {
      for (const iid of Object.keys(det.entries[pid])) {
        expect(det.entries[pid][iid].binding!.bindingsFingerprintAtBuild).toBeNull();
      }
    }
  });
});
