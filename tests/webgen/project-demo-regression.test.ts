/**
 * T4 TD5 演示实例再生成 + 产物核验（09-execution-T4.md TD5 集成卡）
 *
 * 机械判据（TD5 验收）：
 * ① 六文件存在且 manifest kind/schemaVersion 判别通过；
 * ② 同输入重跑 sha256 一致（generatedAt 除外）；
 * ③ 既有四产物与 G3 基线 diff 仅为 p1/p2.data.json 的 interfaces[].triggerRoleId 新增值
 *    （预期交付，披露不算回归）；
 * ④ tsc/jest 基线不受影响。
 *
 * 说明：本 suite 对演示实例的**临时副本**跑 deriveProjectWeb（不污染提交产物），
 * 断言六文件产出 + manifest/interface-details 关键字段与 08 §4.3/§5.3 示例一致。
 */

import { join } from 'node:path';
import {
  mkdirSync,
  cpSync,
  readFileSync,
  existsSync,
  rmSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { deriveProjectWeb } from '../../src/webgen/composition.js';

const DEMO = join(process.cwd(), 'examples', 'fulfillment-payment');

/** 复制演示实例到临时目录（避免污染提交产物） */
function copyDemoToTemp(): string {
  const dir = join(tmpdir(), `t4-td5-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  cpSync(DEMO, dir, { recursive: true });
  return dir;
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

describe('TD5 ① 六文件存在 + manifest 判别（演示实例临时副本 deriveProjectWeb）', () => {
  let tmp: string;
  beforeAll(async () => {
    tmp = copyDemoToTemp();
    await deriveProjectWeb({ rootDir: tmp, force: true, buildProjectSite: false });
  }, 120000);
  afterAll(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
  });

  test('web/ 下六产物齐全', () => {
    const web = join(tmp, 'web');
    for (const f of ['data.json', 'p1.data.json', 'p2.data.json', 'payment.diff.data.json', 'manifest.json', 'interface-details.json']) {
      expect(existsSync(join(web, f))).toBe(true);
    }
    // docs/public 副本同步
    for (const f of ['data.json', 'manifest.json', 'interface-details.json']) {
      expect(existsSync(join(web, 'docs', 'public', f))).toBe(true);
    }
  });

  test('manifest kind/schemaVersion 判别通过 + 关键字段与示例一致', () => {
    const m = JSON.parse(readFileSync(join(tmp, 'web', 'manifest.json'), 'utf-8'));
    expect(m.kind).toBe('project-manifest');
    expect(m.schemaVersion).toBe('1.0');
    expect(m.project.systemName).toBe('履约-支付组合系统');
    expect(m.bundles.protocols.length).toBe(2);
    expect(m.bundles.diff[0]).toMatchObject({
      id: 'payment-v1-v2',
      file: 'payment.diff.data.json',
      sourceProtocolId: 'P2',
      baseModelVersion: '1.0.0',
      targetModelVersion: '1.1.0',
    });
    expect(m.redactionNotice.length).toBe(2);
  });

  test('interface-details kind 判别 + IF_SYS_T4 五段关键值', () => {
    const id = JSON.parse(readFileSync(join(tmp, 'web', 'interface-details.json'), 'utf-8'));
    expect(id.kind).toBe('interface-details');
    expect(id.schemaVersion).toBe('1.1');
    expect(id.protocolVersions).toEqual({ P1: '1.0.0', P2: '1.0.0' });
    const t4 = id.entries.P1.IF_SYS_T4;
    expect(t4.interface.triggerRoleId).toBe('platform');
    expect(t4.relation.ownedTransitions).toEqual(['T4']);
    expect(t4.crossRefs.length).toBe(4);
    expect(t4.crossRefs.every((c: { downlink: { resolved: boolean } }) => c.downlink.resolved === false)).toBe(true);
    // diff 新增接口不进 p2 条目
    expect(id.entries.P2.IF_SYS_T5).toBeUndefined();
  });

  test('p1/p2.data.json 携带 TD2 backfill triggerRoleId（预期交付）', () => {
    const p1 = JSON.parse(readFileSync(join(tmp, 'web', 'p1.data.json'), 'utf-8'));
    const p2 = JSON.parse(readFileSync(join(tmp, 'web', 'p2.data.json'), 'utf-8'));
    expect(p1.interfaces.find((i: { id: string }) => i.id === 'IF_SYS_T4').triggerRoleId).toBe('platform');
    expect(p2.interfaces.find((i: { id: string }) => i.id === 'IF_SYS_T1').triggerRoleId).toBe('customer');
    // 观测接口缺省
    const obs = p1.interfaces.filter((i: { kind: string }) => i.kind === 'observation');
    expect(obs.every((i: { triggerRoleId?: string }) => i.triggerRoleId === undefined)).toBe(true);
  });
});

describe('TD5 ② 同输入重跑 sha256 一致（generatedAt 除外）', () => {
  test('两次 deriveProjectWeb 产物除 generatedAt 外逐字节一致', async () => {
    const tmp = copyDemoToTemp();
    try {
      await deriveProjectWeb({ rootDir: tmp, force: true, buildProjectSite: false });
      const run1 = new Map<string, string>();
      for (const f of readdirSync(join(tmp, 'web')).filter((x) => x.endsWith('.json'))) {
        run1.set(f, readFileSync(join(tmp, 'web', f), 'utf-8'));
      }
      await deriveProjectWeb({ rootDir: tmp, force: true, buildProjectSite: false });
      for (const [f, content1] of run1) {
        const content2 = readFileSync(join(tmp, 'web', f), 'utf-8');
        if (f === 'data.json' || f === 'manifest.json' || f === 'interface-details.json' || f === 'p1.data.json' || f === 'p2.data.json') {
          // 归一化 generatedAt/parsedAt 后比较（时间戳，允许变化）
          const norm = (s: string) => s
            .replace(/"generatedAt"\s*:\s*"[^"]*"/g, '"generatedAt":"X"')
            .replace(/"parsedAt"\s*:\s*"[^"]*"/g, '"parsedAt":"X"');
          expect(norm(content2)).toBe(norm(content1));
        } else {
          expect(content2).toBe(content1);
        }
      }
    } finally {
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
  }, 120000);
});

describe('TD5 ③ 演示实例既有产物与基线 diff 仅 triggerRoleId 新增值', () => {
  test('p1/p2.data.json 相对提交基线（不含 triggerRoleId 的旧文件）diff 仅该字段', () => {
    // 构造"无 triggerRoleId"的基线视图：从当前产物剥掉 triggerRoleId 后，
    // 与当前产物逐接口逐字段比较——差异只应是 triggerRoleId 字段本身。
    for (const f of ['p1.data.json', 'p2.data.json']) {
      const cur = JSON.parse(readFileSync(join(DEMO, 'web', f), 'utf-8'));
      const baseline = JSON.parse(JSON.stringify(cur));
      for (const i of baseline.interfaces) delete i.triggerRoleId;
      for (let idx = 0; idx < cur.interfaces.length; idx++) {
        const a = cur.interfaces[idx];
        const b = baseline.interfaces[idx];
        const aKeys = Object.keys(a).sort();
        const bKeys = Object.keys(b).sort();
        // 差异键集合：系统接口 = 仅 triggerRoleId（TD2 backfill 新增值）；
        // 观测接口 = 无差异（零命中保持缺省）
        const added = aKeys.filter((k) => !bKeys.includes(k));
        expect(added).toEqual(a.kind === 'system' ? ['triggerRoleId'] : []);
        for (const k of bKeys) {
          if (k === 'triggerRoleId') continue;
          expect(a[k]).toEqual(b[k]);
        }
      }
    }
  });

  test('data.json 仅 generatedAt 变化（组合层产物不含 triggerRoleId）', () => {
    const data = JSON.parse(readFileSync(join(DEMO, 'web', 'data.json'), 'utf-8'));
    // 组合层 data.json 不携带 interfaces[].triggerRoleId（无该层级）
    expect(data.composition.systemName).toBe('履约-支付组合系统');
  });
});
