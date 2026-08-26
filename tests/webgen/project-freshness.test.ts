/**
 * T4 TD6 checkProjectFreshness 项目级守卫（09-execution-T4.md TD6 / 08-project-viewer-design.md §7）
 *
 * 机械判据（TD6 验收）：
 * ① 正向：演示实例 manifest + 六产物 → 全部 verdict fresh；
 * ② S1 反向：置换旧 p1.data.json（sourceModelVersion 不匹配的 fixture）→ perProtocol.P1
 *    degraded + alert 文案含 vX vs vY + level error，P2 不受影响（按子协议降级，R4=B）；
 * ③ S5 反向：protocolVersions 不匹配 → interfaceDetails verdict degraded、条目仍展示口径；
 * ④ S6 反向：composition.version 不匹配 → composition verdict warning 不锁视图；
 * ⑤ S3 反向：manifest 内两字段不一致 → warning；
 * ⑥ diff 段：payment.diff.data.json 存在且 1.1.0 ≠ 1.0.0 → 零降级零告警；
 * ⑦ 既有 checkFreshness 单协议用例零改动全绿（viewer-n1-guard.test.ts 既有 suite）；
 * ⑧ tsc/jest 口径（UMD/Node）全过。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

const ROOT = process.cwd();
const GUARD_PATH = join(ROOT, 'viewer', 'n1-guard.js');
const WEB = join(ROOT, 'examples', 'fulfillment-payment', 'web');

interface Verdict {
  fresh: boolean;
  degraded: boolean;
  alert: string | null;
  level: string;
}

interface ProjectVerdicts {
  perProtocol: Record<string, Verdict>;
  interfaceDetails: Verdict;
  composition: Verdict;
}

function loadGuard(): {
  checkFreshness: (s: string | undefined, m: string | undefined) => Verdict;
  checkProjectFreshness: (manifest: unknown, imported: unknown) => ProjectVerdicts;
} {
  const code = readFileSync(GUARD_PATH, 'utf-8');
  const ctx: Record<string, unknown> = { module: { exports: {} } };
  createContext(ctx);
  runInContext(code, ctx);
  const mod = ctx.module as { exports: { checkFreshness: unknown; checkProjectFreshness: unknown } };
  if (!mod.exports || typeof mod.exports.checkFreshness !== 'function' || typeof mod.exports.checkProjectFreshness !== 'function') {
    throw new Error('n1-guard.js 未按 UMD 导出 checkFreshness/checkProjectFreshness');
  }
  return mod.exports as typeof mod.exports & { checkProjectFreshness: (m: unknown, i: unknown) => ProjectVerdicts };
}

function loadJson(rel: string): unknown {
  return JSON.parse(readFileSync(join(WEB, rel), 'utf-8'));
}

const guard = loadGuard();
const manifest = loadJson('manifest.json') as {
  bundles: { composition: { modelVersion: string }; protocols: Array<{
    id: string; modelVersion: string; dataSourceModelVersion: string | null;
  }> };
};
const p1Data = loadJson('p1.data.json') as { sourceModelVersion: string };
const p2Data = loadJson('p2.data.json') as { sourceModelVersion: string };
const interfaceDetails = loadJson('interface-details.json') as { protocolVersions: Record<string, string> };
const compositionData = loadJson('data.json') as { composition: { version: string } };

/** 构造演示实例全量 imported（正向） */
function importedAll(): { protocolData: Record<string, unknown>; interfaceDetails: unknown; compositionData: unknown; modelIr: Record<string, unknown> } {
  return {
    protocolData: { P1: p1Data, P2: p2Data },
    interfaceDetails,
    compositionData,
    modelIr: {},
  };
}

describe('TD6 ① 正向：演示实例 manifest + 六产物 → 全部 verdict fresh', () => {
  test('perProtocol / interfaceDetails / composition 全 fresh', () => {
    const v = guard.checkProjectFreshness(manifest, importedAll());
    expect(v.perProtocol.P1.fresh).toBe(true);
    expect(v.perProtocol.P2.fresh).toBe(true);
    expect(v.perProtocol.P1.degraded).toBe(false);
    expect(v.perProtocol.P2.degraded).toBe(false);
    expect(v.interfaceDetails.fresh).toBe(true);
    expect(v.composition.fresh).toBe(true);
  });
});

describe('TD6 ② S1 反向：旧 p1.data.json 混入 → 仅 P1 降级（按子协议降级，R4=B）', () => {
  test('sourceModelVersion 不匹配（0.9.0 vs 1.0.0）→ perProtocol.P1 degraded error，P2 不受影响', () => {
    const v = guard.checkProjectFreshness(manifest, {
      ...importedAll(),
      protocolData: { P1: { sourceModelVersion: '0.9.0' }, P2: p2Data },
    });
    expect(v.perProtocol.P1.fresh).toBe(false);
    expect(v.perProtocol.P1.degraded).toBe(true);
    expect(v.perProtocol.P1.level).toBe('error');
    expect(v.perProtocol.P1.alert).toContain('v0.9.0');
    expect(v.perProtocol.P1.alert).toContain('v1.0.0');
    // P2 不受影响（R4=B 按子协议降级）
    expect(v.perProtocol.P2.fresh).toBe(true);
    expect(v.perProtocol.P2.degraded).toBe(false);
    // 组合层不受单协议降级影响
    expect(v.composition.fresh).toBe(true);
  });

  test('协议数据未导入（protocolData 缺 P2）→ 该协议不比、不降级', () => {
    const v = guard.checkProjectFreshness(manifest, {
      ...importedAll(),
      protocolData: { P1: p1Data },
    });
    expect(v.perProtocol.P2.fresh).toBe(true);
    expect(v.perProtocol.P2.degraded).toBe(false);
  });
});

describe('TD6 ③ S5 反向：interface-details.protocolVersions 不匹配 → 接口详情降级（条目仍展示口径）', () => {
  test('protocolVersions.P1 失配 → interfaceDetails verdict degraded error', () => {
    const v = guard.checkProjectFreshness(manifest, {
      ...importedAll(),
      interfaceDetails: { ...interfaceDetails, protocolVersions: { P1: '0.9.0', P2: '1.0.0' } },
    });
    expect(v.interfaceDetails.fresh).toBe(false);
    expect(v.interfaceDetails.degraded).toBe(true);
    expect(v.interfaceDetails.level).toBe('error');
    expect(v.interfaceDetails.alert).toContain('接口详情与协议数据不同批');
    expect(v.interfaceDetails.alert).toContain('P1');
    // 条目仍展示口径：降级只影响提示，不影响协议级守卫
    expect(v.perProtocol.P1.fresh).toBe(true);
    expect(v.composition.fresh).toBe(true);
  });

  test('interface-details 未导入 → S5 不比（不降级）', () => {
    const v = guard.checkProjectFreshness(manifest, {
      ...importedAll(),
      interfaceDetails: null,
    });
    expect(v.interfaceDetails.fresh).toBe(true);
  });
});

describe('TD6 ④ S6 反向：composition.version 不匹配 → composition warning 不锁视图', () => {
  test('组合层数据过期（0.2.0 vs 声明 0.1.0）→ composition verdict warning', () => {
    const v = guard.checkProjectFreshness(manifest, {
      ...importedAll(),
      compositionData: { composition: { version: '0.2.0' } },
    });
    expect(v.composition.fresh).toBe(false);
    expect(v.composition.degraded).toBe(true);
    expect(v.composition.level).toBe('warn');
    expect(v.composition.alert).toContain('组合层数据可能过期');
    expect(v.composition.alert).toContain('v0.1.0');
    expect(v.composition.alert).toContain('v0.2.0');
    // 不锁视图：协议级守卫不受影响
    expect(v.perProtocol.P1.fresh).toBe(true);
    expect(v.interfaceDetails.fresh).toBe(true);
  });
});

describe('TD6 ⑤ S3 反向：manifest 内两字段不一致 → warning（工具链一致性信号）', () => {
  test('modelVersion ≠ dataSourceModelVersion → perProtocol.P1 warning（S1 通过前提下）', () => {
    // 篡改 manifest：P1 modelVersion=9.9.9 而 dataSourceModelVersion=1.0.0（S3 失配）；
    // imported 数据与 dataSourceModelVersion 一致（S1 不失配）→ perProtocol.P1 = warning
    const badManifest = JSON.parse(JSON.stringify(manifest)) as typeof manifest;
    badManifest.bundles.protocols[0].modelVersion = '9.9.9';
    const v = guard.checkProjectFreshness(badManifest, importedAll());
    expect(v.perProtocol.P1.fresh).toBe(false);
    expect(v.perProtocol.P1.degraded).toBe(true);
    expect(v.perProtocol.P1.level).toBe('warn');
    expect(v.perProtocol.P1.alert).toContain('工具链一致性警告');
    expect(v.perProtocol.P1.alert).toContain('v9.9.9');
    expect(v.perProtocol.P1.alert).toContain('v1.0.0');
    // P2 不受影响
    expect(v.perProtocol.P2.fresh).toBe(true);
  });
});

describe('TD6 ⑥ diff 段不参与任何比对（防误报，08 §7.2）', () => {
  test('payment.diff.data.json 存在且 1.1.0 ≠ 1.0.0 → 零降级零告警', () => {
    // diff 快照是独立产物，manifest.bundles.diff 声明其版本——守卫不消费 diff 段。
    // 正向 imported 含完整六产物（payment.diff.data.json 未导入也无关）→ 全 fresh
    const v = guard.checkProjectFreshness(manifest, importedAll());
    expect(v.perProtocol.P1.fresh).toBe(true);
    expect(v.perProtocol.P2.fresh).toBe(true);
    expect(v.interfaceDetails.fresh).toBe(true);
    expect(v.composition.fresh).toBe(true);
    // diff 快照 sourceModelVersion=1.1.0 与 manifest P2 dataSourceModelVersion=1.0.0
    // 不等是预期（构造性事实），任何 verdict 的 alert 均不含 diff 版本号
    const alerts = [
      v.perProtocol.P1.alert, v.perProtocol.P2.alert,
      v.interfaceDetails.alert, v.composition.alert,
    ].filter(Boolean).join('|');
    expect(alerts).not.toContain('1.1.0');
  });
});

describe('TD6 ⑦ 既有 checkFreshness 单协议口径零回归', () => {
  test('checkFreshness 行为与既有一致（正向/反向/缺省）', () => {
    expect(guard.checkFreshness('1.0.0', '1.0.0').fresh).toBe(true);
    const miss = guard.checkFreshness('0.9.0', '1.0.0');
    expect(miss.degraded).toBe(true);
    expect(miss.alert).toContain('增强数据过期');
    expect(guard.checkFreshness(undefined, '1.0.0').fresh).toBe(true);
    expect(guard.checkFreshness('1.0.0', undefined).level).toBe('warn');
  });

  test('S2：C 模带 model.md 时 modelVersion vs 解析版本（R12 生效边界）', () => {
    // 不带 modelIr → S2 不比（A/B 模生效源对 = S1+S3+S5+S6）
    const vNoModel = guard.checkProjectFreshness(manifest, importedAll());
    expect(vNoModel.perProtocol.P1.fresh).toBe(true);
    // C 模带 modelIr 且版本失配 → 该协议 error 降级
    const vModel = guard.checkProjectFreshness(manifest, {
      ...importedAll(),
      modelIr: { P1: { metadata: { version: '0.9.0' } }, P2: null },
    });
    expect(vModel.perProtocol.P1.degraded).toBe(true);
    expect(vModel.perProtocol.P1.level).toBe('error');
    expect(vModel.perProtocol.P1.alert).toContain('v0.9.0');
    // P2 无 modelIr → 不比
    expect(vModel.perProtocol.P2.fresh).toBe(true);
  });
});
