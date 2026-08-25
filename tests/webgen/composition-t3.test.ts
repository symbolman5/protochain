/**
 * W3-f 组合层契约核验（07-execution-T3 TC7）
 *
 * 契约先行核验结论：组合层 data.json（schemaVersion '1.1'）对"可点击跨协议关系图"零缺口——
 * protocols[]（协议节点）、dependencyGraph.edges[]（依赖边）、crossRefs[]（引用边）均为
 * viewer 可直接查表的规范化数据，无需跨元素 join/聚合 → buildCompositionWebData 零改动（不扩契约）。
 * 本 suite 以演示实例（examples/fulfillment-payment）为载体固化核验结论（单测固化，TC7 职责）。
 *
 * 机械判据（TC7 验收）：
 * ① crossRefs 含退款 guard → 支付状态条目（kind='guard'、fromProtocol/toProtocol/target/context 逐字段断言）；
 * ② 协议节点数=2、依赖边与 dependencyGraph.edges 一致、引用边与 crossRefs 一致（图数据全部工具链投影，
 *    viewer 零 join——契约零缺口断言）；
 * ③ 单协议模式零回归：无 composition.md 时 derive-web 行为与 T2 一致（既有 webgen 测试全绿，基线兜底）；
 * ④ protocols[].version = 各 model.metadata.version（sourceModelVersion 同源）；
 * ⑤ tsc 0 errors + suite 全过。
 */

import { readFileSync, mkdirSync, cpSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { parseCompositionFile } from '../../src/composition-parser/index.js';
import { parseProtocolFile } from '../../src/parser/index.js';
import { specify, specsFromEnvelope } from '../../src/specifier/index.js';
import {
  buildCompositionWebData,
  deriveProjectWeb,
  type CompositionWebData,
} from '../../src/webgen/composition.js';
import { redactSensitiveFields } from '../../src/webgen/index.js';

const ROOT = process.cwd();
const DEMO = join(ROOT, 'examples', 'fulfillment-payment');

/** 加载演示实例组合层数据（与 derive-web 同源路径） */
function loadDemoCompositionData(): {
  data: CompositionWebData;
  versions: Record<string, string>;
} {
  const composition = parseCompositionFile(join(DEMO, 'protocol', 'composition.md'));
  const subSpecs = new Map<string, ReturnType<typeof specsFromEnvelope>>();
  const versions: Record<string, string> = {};
  for (const sub of composition.subProtocols) {
    const model = parseProtocolFile(join(DEMO, 'protocol', sub.protocolId, 'model.md'));
    versions[sub.protocolId] = model.metadata.version;
    subSpecs.set(sub.protocolId, specsFromEnvelope(specify(model)));
  }
  const data = buildCompositionWebData(composition, subSpecs, new Map());
  return { data, versions };
}

describe('TC7 W3-f 组合层契约核验（演示实例 fulfillment-payment）', () => {
  const { data, versions } = loadDemoCompositionData();

  test('schemaVersion=1.1 + protocols 2 个（P1 履约 / P2 支付）', () => {
    expect(data.schemaVersion).toBe('1.1');
    expect(data.protocols.map((p) => p.id)).toEqual(['P1', 'P2']);
  });

  test('④ protocols[].version = 各 model.metadata.version（sourceModelVersion 同源）', () => {
    for (const p of data.protocols) {
      expect(p.version).toBe(versions[p.id]);
    }
    expect(data.protocols.find((p) => p.id === 'P1')!.version).toBe('1.0.0');
    expect(data.protocols.find((p) => p.id === 'P2')!.version).toBe('1.0.0');
  });

  test('② 依赖边与 dependencyGraph.edges 一致（图数据工具链投影，viewer 零 join）', () => {
    expect(data.dependencyGraph.edges).toEqual([
      {
        from: 'P2',
        to: 'P1',
        dependencyType: 'state',
        description: '退款完成是履约取消的前提（履约协议退款转移 guard 引用 P2 退款状态）',
      },
    ]);
  });

  test('① crossRefs 含退款 guard → 支付状态条目（逐字段断言）', () => {
    const refundRefs = data.crossRefs.filter(
      (c) => c.kind === 'guard' && c.fromProtocol === 'P1' && c.toProtocol === 'P2'
    );
    // 至少一条来自 precondition（guard 原文）的规范化条目
    const canonical = refundRefs.find((c) => c.sourceField === 'precondition');
    expect(canonical).toBeDefined();
    expect(canonical!.target).toBe('S_refunded');
    expect(canonical!.context).toContain('P2.S_refunded');
    // 全部引用边 toProtocol ∈ 协议集合（无外部协议残留）
    for (const c of data.crossRefs) {
      expect(['P1', 'P2']).toContain(c.fromProtocol);
      expect(['P1', 'P2']).toContain(c.toProtocol);
    }
  });

  test('② 引用边与 crossRefs 一致（协议节点/依赖边/引用边三件套齐备，契约零缺口）', () => {
    // viewer 组合层面板所需三件套全部工具链投影：
    // 协议节点 = protocols[].id；依赖边 = dependencyGraph.edges[]；引用边 = crossRefs[]（fromProtocol→toProtocol）
    expect(data.protocols.length).toBe(2);
    expect(data.dependencyGraph.edges.length).toBeGreaterThanOrEqual(1);
    expect(data.crossRefs.length).toBeGreaterThanOrEqual(1);
    // crossRefs 的 fromProtocol/toProtocol 均可直接映射到协议节点（零 join）
    const protoIds = new Set(data.protocols.map((p) => p.id));
    for (const c of data.crossRefs) {
      expect(protoIds.has(c.fromProtocol)).toBe(true);
      expect(protoIds.has(c.toProtocol)).toBe(true);
    }
  });

  test('invariantSpans 覆盖跨协议不变量（CI1/CI2 协议集合）', () => {
    const spans = data.invariantSpans;
    const ci1 = spans.find((s) => s.id === 'CI1');
    const ci2 = spans.find((s) => s.id === 'CI2');
    expect(ci1).toBeDefined();
    expect(ci1!.protocols).toEqual(['P1', 'P2']);
    expect(ci2).toBeDefined();
    expect(ci2!.protocols).toEqual(['P1', 'P2']);
  });

  test('redactSensitiveFields 对组合层新增字段递归生效（回归断言）', () => {
    const payload = {
      schemaVersion: '1.1',
      protocols: [{ id: 'P1', name: 'x', apiKey: 'sk-live-123', nested: { password: 'p' } }],
      crossRefs: [{ fromProtocol: 'P1', toProtocol: 'P2', tokenEnv: 'TOKEN' }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as unknown as CompositionWebData;
    const redacted = redactSensitiveFields(payload) as unknown as Record<string, unknown>;
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain('sk-live-123');
    expect(serialized).not.toContain('TOKEN');
    expect(serialized).not.toContain('"password"');
  });

  test('deriveProjectWeb 对演示实例产出 schemaVersion=1.1 组合层 data.json（集成复现）', async () => {
    // 复制演示实例的建模产物（config + 模型文件）到唯一临时目录（不污染站点资产；
    // mkdtempSync 保证目录全新；只复制 model.md/composition.md，不复制 derived/web，
    // 规避 safe-delete shim 对批量删除（>50 文件）的守卫误伤）
    const tmp = mkdtempSync(join(ROOT, 'tmp', 't7-composition-demo-'));
    cpSync(join(DEMO, 'protochain.config.yaml'), join(tmp, 'protochain.config.yaml'));
    mkdirSync(join(tmp, 'protocol'), { recursive: true });
    cpSync(join(DEMO, 'protocol', 'composition.md'), join(tmp, 'protocol', 'composition.md'));
    for (const p of ['P1', 'P2']) {
      mkdirSync(join(tmp, 'protocol', p), { recursive: true });
      cpSync(join(DEMO, 'protocol', p, 'model.md'), join(tmp, 'protocol', p, 'model.md'));
    }
    try {
      // 预生成各子协议 specs.json（deriveProjectWeb 前置；与 CLI derive-specs 等价）
      const { writeFileSync } = await import('node:fs');
      const { dirname } = await import('node:path');
      for (const p of ['P1', 'P2']) {
        const model = parseProtocolFile(join(tmp, 'protocol', p, 'model.md'));
        const envelope = specify(model);
        const out = join(tmp, 'protocol', p, 'derived', 'specs.json');
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, JSON.stringify(envelope, null, 2), 'utf-8');
      }
      const result = await deriveProjectWeb({
        rootDir: tmp,
        buildProjectSite: false,
        force: true,
      });
      const data = JSON.parse(readFileSync(join(tmp, 'web', 'data.json'), 'utf-8'));
      expect(data.schemaVersion).toBe('1.1');
      expect(data.protocols.length).toBe(2);
      const refund = data.crossRefs.find(
        (c: { kind: string; fromProtocol: string; toProtocol: string; target: string }) =>
          c.kind === 'guard' && c.fromProtocol === 'P1' && c.toProtocol === 'P2'
      );
      expect(refund).toBeDefined();
      expect(refund.target).toBe('S_refunded');
      expect(result.warnings.some((w) => w.includes('error'))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
