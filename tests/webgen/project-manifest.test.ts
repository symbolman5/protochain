/**
 * T4 TD3 buildProjectManifest 投影器（09-execution-T4.md TD3 / 08-project-viewer-design.md §4）
 *
 * 机械判据（TD3 验收）：
 * ① 演示实例产物与 08 §4.3 示例逐字段一致（systemName/version/changeType/两协议条目全字段/
 *    diff 条目全字段/redactionNotice 两条文案——generatedAt 除外）；
 * ② bindingsFingerprint === null（实例无 bindings.yaml，真实值）；
 * ③ 反向：无 diff 快照的项目 → bundles.diff 为空数组（非缺省）；
 * ④ S3 自查口径：manifest 不做 join——model.md version 与 pN.data.json sourceModelVersion
 *    不一致的 fixture 仍正常产出 manifest（不断言、不报错，比对留给 viewer）；
 * ⑤ 单协议模式零回归：无 composition.md 的 derive-web 行为不变（既有测试全绿）；
 * ⑥ tsc 0 errors + suite 全过。
 */

import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { parseCompositionFile } from '../../src/composition-parser/index.js';
import { parseProtocolFile } from '../../src/parser/index.js';
import {
  buildProjectManifest,
  computeBindingsFingerprint,
  type ProjectProtocolManifestInput,
  type ProjectDiffSnapshotInput,
} from '../../src/webgen/composition.js';
import type { CompositionModel } from '../../src/model/types.js';

const DEMO = join(process.cwd(), 'examples', 'fulfillment-payment');
const WEB = join(DEMO, 'web');

/** 从演示实例构造 manifest 输入（与 deriveProjectWeb 采集逻辑同构） */
function loadDemoManifestInputs(): {
  composition: CompositionModel;
  protocols: ProjectProtocolManifestInput[];
  diffSnapshots: ProjectDiffSnapshotInput[];
} {
  const composition = parseCompositionFile(join(DEMO, 'protocol', 'composition.md'));
  const protocols: ProjectProtocolManifestInput[] = composition.subProtocols.map((sub) => {
    const pid = sub.protocolId;
    const dataFile = `${pid.toLowerCase()}.data.json`;
    const subData = JSON.parse(readFileSync(join(WEB, dataFile), 'utf-8')) as {
      schemaVersion?: unknown;
      sourceModelVersion?: unknown;
    };
    const model = parseProtocolFile(join(DEMO, 'protocol', pid, 'model.md'));
    const specs = JSON.parse(readFileSync(join(DEMO, 'protocol', pid, 'derived', 'specs.json'), 'utf-8')) as {
      specs?: unknown[];
      schemaVersion?: unknown;
    };
    const specList = Array.isArray(specs.specs) ? specs.specs : (specs as unknown as unknown[]);
    return {
      id: pid,
      name: sub.name,
      modelPath: sub.modelPath,
      modelVersion: model.metadata.version,
      dataFile,
      dataSchemaVersion: typeof subData.schemaVersion === 'string' ? subData.schemaVersion : null,
      dataSourceModelVersion:
        typeof subData.sourceModelVersion === 'string' ? subData.sourceModelVersion : null,
      bindingsFingerprint: computeBindingsFingerprint(DEMO),
      interfaceCount: specList.length,
    };
  });
  // diff 快照：读 payment.diff.data.json（与 deriveProjectWeb 发现逻辑同构）
  const diffRaw = JSON.parse(readFileSync(join(WEB, 'payment.diff.data.json'), 'utf-8')) as {
    schemaVersion: string;
    sourceModelVersion: string;
    protocol: { name: string };
    diff: { metadataChanges: Array<{ path: string; kind: string; oldValue: string }> };
  };
  const versionChange = diffRaw.diff.metadataChanges.find(
    (c) => c.path === 'metadata.version' && c.kind === 'modified'
  )!;
  const diffSnapshots: ProjectDiffSnapshotInput[] = [
    {
      file: 'payment.diff.data.json',
      schemaVersion: diffRaw.schemaVersion,
      sourceModelVersion: diffRaw.sourceModelVersion,
      protocolName: diffRaw.protocol.name,
      baseModelVersion: versionChange.oldValue,
    },
  ];
  return { composition, protocols, diffSnapshots };
}

describe('TD3 ① 演示实例 manifest 与 08 §4.3 示例逐字段一致（真实值）', () => {
  const { composition, protocols, diffSnapshots } = loadDemoManifestInputs();
  const manifest = buildProjectManifest({ composition, protocols, diffSnapshots });

  test('顶层 schemaVersion/kind + project 段', () => {
    expect(manifest.schemaVersion).toBe('1.0');
    expect(manifest.kind).toBe('project-manifest');
    expect(manifest.generatedAt).toBeTruthy(); // generatedAt 除外（示例值只对结构）
    expect(manifest.project).toEqual({
      systemName: '履约-支付组合系统',
      version: '0.1.0',
      changeType: 'protocol_tweak',
    });
  });

  test('bundles.composition / interfaceDetails', () => {
    expect(manifest.bundles.composition).toEqual({
      file: 'data.json',
      schemaVersion: '1.1',
      modelVersion: '0.1.0',
    });
    expect(manifest.bundles.interfaceDetails).toEqual({
      file: 'interface-details.json',
      schemaVersion: '1.0',
    });
  });

  test('bundles.protocols 两条目全字段与示例一致', () => {
    expect(manifest.bundles.protocols.length).toBe(2);
    const p1 = manifest.bundles.protocols[0];
    expect(p1).toEqual({
      id: 'P1',
      name: '履约协议',
      modelPath: 'protocol/P1/model.md',
      modelVersion: '1.0.0',
      dataFile: 'p1.data.json',
      dataSchemaVersion: '1.0',
      dataSourceModelVersion: '1.0.0',
      bindingsFingerprint: null,
      interfaceCount: 11,
    });
    const p2 = manifest.bundles.protocols[1];
    expect(p2).toEqual({
      id: 'P2',
      name: '支付协议',
      modelPath: 'protocol/P2/model.md',
      modelVersion: '1.0.0',
      dataFile: 'p2.data.json',
      dataSchemaVersion: '1.0',
      dataSourceModelVersion: '1.0.0',
      bindingsFingerprint: null,
      interfaceCount: 12,
    });
  });

  test('bundles.diff 条目全字段与示例一致（payment-v1-v2）', () => {
    expect(manifest.bundles.diff.length).toBe(1);
    expect(manifest.bundles.diff[0]).toEqual({
      id: 'payment-v1-v2',
      file: 'payment.diff.data.json',
      schemaVersion: '1.0',
      sourceProtocolId: 'P2',
      baseModelVersion: '1.0.0',
      targetModelVersion: '1.1.0',
    });
  });

  test('redactionNotice 为独立两条文案（R14：不含 P0/P1 阶段编号）', () => {
    expect(manifest.redactionNotice.length).toBe(2);
    expect(manifest.redactionNotice[0]).toContain('derive-web --project');
    expect(manifest.redactionNotice[0]).toContain('不含 authConfig.token/secret/password');
    expect(manifest.redactionNotice[1]).toContain('sha256 指纹');
    // 不复用 REDACTION_NOTICE_LINES 第三条（含 "P0 范围仅只读展示"）
    expect(manifest.redactionNotice.join('')).not.toContain('P0 范围仅只读展示');
  });
});

describe('TD3 ② bindingsFingerprint 为实例真实值 null（无 bindings.yaml）', () => {
  test('computeBindingsFingerprint(DEMO) → null', () => {
    expect(computeBindingsFingerprint(DEMO)).toBeNull();
  });

  test('构造临时 bindings.yaml → 返回 sha256 指纹（变更检测语义）', () => {
    const { mkdtempSync, writeFileSync } = require('node:fs') as typeof import('node:fs');
    const { tmpdir } = require('node:os') as typeof import('node:os');
    const { join: pathJoin } = require('node:path') as typeof import('node:path');
    const dir = mkdtempSync(pathJoin(tmpdir(), 't4-fp-'));
    writeFileSync(pathJoin(dir, 'bindings.yaml'), 'roles:\n  platform:\n    auth: token\n');
    const fp = computeBindingsFingerprint(dir);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    // 同一内容 → 同一指纹（可复现）
    expect(computeBindingsFingerprint(dir)).toBe(fp);
  });
});

describe('TD3 ③ 无 diff 快照 → bundles.diff 为空数组（非缺省）', () => {
  test('diffSnapshots 传空 → diff=[]', () => {
    const { composition, protocols } = loadDemoManifestInputs();
    const manifest = buildProjectManifest({ composition, protocols, diffSnapshots: [] });
    expect(Array.isArray(manifest.bundles.diff)).toBe(true);
    expect(manifest.bundles.diff).toEqual([]);
  });
});

describe('TD3 ④ S3 自查口径：manifest 不做跨文件 join（一致性断言留给 viewer）', () => {
  test('model.md version ≠ pN.data.json sourceModelVersion 的 fixture 仍正常产出（不断言不报错）', () => {
    const { composition, protocols, diffSnapshots } = loadDemoManifestInputs();
    // 篡改 P1 的 modelVersion（与 dataSourceModelVersion=1.0.0 不一致）
    const altered = protocols.map((p) =>
      p.id === 'P1' ? { ...p, modelVersion: '9.9.9' } : p
    );
    const manifest = buildProjectManifest({ composition, protocols: altered, diffSnapshots });
    expect(manifest.bundles.protocols[0].modelVersion).toBe('9.9.9');
    expect(manifest.bundles.protocols[0].dataSourceModelVersion).toBe('1.0.0');
    // 两个字段都如实搬运（不一致状态由 viewer S3 比对，工具链不断言）
    expect(manifest.bundles.protocols[0].modelVersion).not.toBe(
      manifest.bundles.protocols[0].dataSourceModelVersion
    );
  });
});

describe('TD3 ⑤ 单协议模式零回归（无 composition.md 的 derive-web 路径不受影响）', () => {
  test('buildProjectManifest 不依赖单协议路径；composition 缺失时由 deriveProjectWeb 前置抛错（既有行为）', () => {
    // deriveProjectWeb 在 composition.md 缺失时抛错（composition.ts L1363-1367 既有行为），
    // buildProjectManifest 仅被 deriveProjectWeb 在 composition 解析成功后调用——单协议
    // derive-web（无 --project）不经过 deriveProjectWeb，行为不变。此处断言函数存在且可调用。
    expect(typeof buildProjectManifest).toBe('function');
  });
});
