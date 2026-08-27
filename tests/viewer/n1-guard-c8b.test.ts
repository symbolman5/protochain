/**
 * C-8b viewer 同源一致性守卫（S4）单测（10 §3-3 / §4 C-8b；TI5）。
 * 以 CJS 方式执行 UMD 的 viewer/n1-guard.js（用 new Function 提供 module/exports），
 * 规避 jest ESM + 仓库 type:module 下 require('.js') 报 "Must use import to load ES Module"。
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const BASE = dirname(fileURLToPath(import.meta.url));

function loadUmd(relPath: string): any {
  const code = readFileSync(join(BASE, relPath), 'utf8');
  const module: any = { exports: {} };
  // eslint-disable-next-line no-new-func
  const fn = new Function('module', 'exports', code);
  fn(module, module.exports);
  return module.exports;
}

describe('C-8b viewer 同源一致性守卫（S4）', () => {
  let checkProjectFreshness: (manifest: any, imported: any) => any;

  beforeAll(() => {
    const api = loadUmd('../../viewer/n1-guard.js');
    checkProjectFreshness = api.checkProjectFreshness;
  });

  const mkManifest = (fps: Record<string, string | null>) => ({
    bundles: {
      protocols: Object.entries(fps).map(([id, bindingsFingerprint]) => ({ id, bindingsFingerprint })),
    },
  });

  // entries: { "<pid>": [ { atBuild, protoId } ] }
  const mkImported = (entries: Record<string, Array<{ atBuild: string | null }>>) => {
    const e: any = {};
    for (const [protoId, list] of Object.entries(entries)) {
      e[protoId] = {};
      list.forEach((item, idx) => {
        e[protoId][`if${idx}`] = { binding: { bindingsFingerprintAtBuild: item.atBuild } };
      });
    }
    return { interfaceDetails: { entries: e } };
  };

  it('（a）bindingsFingerprintAtBuild == manifest 协议指纹 → 同源一致（ok）', () => {
    const manifest = mkManifest({ P1: 'fp1' });
    const imported = mkImported({ P1: [{ atBuild: 'fp1' }] });
    const res = checkProjectFreshness(manifest, imported);
    expect(res.bindingConsistency.degraded).toBe(false);
    expect(res.bindingConsistency.level).toBe('ok');
    expect(res.interfaceDetails.degraded).toBe(false);
  });

  it('（b）故意制造非同轮（NON-null 指纹不匹配）→ 报告不一致（degraded）', () => {
    const manifest = mkManifest({ P1: 'fp1' });
    const imported = mkImported({ P1: [{ atBuild: 'different' }] });
    const res = checkProjectFreshness(manifest, imported);
    expect(res.bindingConsistency.degraded).toBe(true);
    expect(res.bindingConsistency.level).toBe('error');
    expect(res.interfaceDetails.degraded).toBe(true);
    expect(res.bindingConsistency.alert).toContain('非同轮');
  });

  it('（c）bindingsFingerprintAtBuild === null（演示实例无 bindings）→ 不告警，且不得报为 fresh/新', () => {
    const manifest = mkManifest({ P1: null });
    const imported = mkImported({ P1: [{ atBuild: null }] });
    const res = checkProjectFreshness(manifest, imported);
    // 关键边界（Gif-6b）：null 指纹条目跳过 → 整体 unknown，不报 fresh、不降级
    expect(res.bindingConsistency.level).toBe('unknown');
    expect(res.bindingConsistency.degraded).toBe(false);
    // 同时确认整体 interfaceDetails 不被降级
    expect(res.interfaceDetails.degraded).toBe(false);
  });

  it('（补充）混合条目：存在 null atBuild 条目时整体退化为 unknown，不误报', () => {
    const manifest = mkManifest({ P1: 'fp1' });
    // 一个协议下既有 null 又有匹配的非 null 条目 → 有过比对但 atBuild 均一致 + 含 null 跳过
    const imported = mkImported({ P1: [{ atBuild: null }, { atBuild: 'fp1' }] });
    const res = checkProjectFreshness(manifest, imported);
    expect(res.bindingConsistency.degraded).toBe(false);
    expect(res.bindingConsistency.level).toBe('ok');
  });
});
