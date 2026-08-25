/**
 * N1 新鲜度守卫（W3-a / TA3）单测
 *
 * 机械判据（05-execution-T1.md §TA3 验收①）：
 * N1 正反向：版本匹配无警示、不匹配出警示（构造两份 data.json 用例）。
 *
 * 守卫逻辑（03-viewer.md NR3-1 收口）：
 * - data.json.sourceModelVersion vs 浏览器端解析出的 metadata.version；
 * - 不匹配 → 降级"只看结构" + 提示"增强数据过期（vX vs vY）"；
 * - 着色唯一数据源 = data.json（edgeCoverage），N1 触发时 TA5 ⑥ 不着色。
 *
 * 加载方式：UMD 文件经 node:vm 执行（与 TA2 bundle 测试同构，无需 npm 依赖）。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

const ROOT = process.cwd();
const GUARD_PATH = join(ROOT, 'viewer', 'n1-guard.js');

interface N1Verdict {
  fresh: boolean;
  degraded: boolean;
  alert: string | null;
  level: string;
}

function loadN1Guard(): { checkFreshness: (s: string | undefined, m: string | undefined) => N1Verdict } {
  const code = readFileSync(GUARD_PATH, 'utf-8');
  const ctx: Record<string, unknown> = { module: { exports: {} } };
  createContext(ctx);
  runInContext(code, ctx);
  const mod = ctx.module as { exports: { checkFreshness: unknown } };
  if (!mod.exports || typeof mod.exports.checkFreshness !== 'function') {
    throw new Error('n1-guard.js 未按 UMD 导出 checkFreshness');
  }
  return mod.exports as { checkFreshness: (s: string | undefined, m: string | undefined) => N1Verdict };
}

describe('N1 新鲜度守卫（viewer/n1-guard.js）', () => {
  const guard = loadN1Guard();

  test('正向：data.json.sourceModelVersion === model.md 版本 → 无警示、不降级', () => {
    const verdict = guard.checkFreshness('1.0.0', '1.0.0');
    expect(verdict.fresh).toBe(true);
    expect(verdict.degraded).toBe(false);
    expect(verdict.alert).toBeNull();
  });

  test('反向：版本不匹配 → 警示"增强数据过期"且降级着色', () => {
    const verdict = guard.checkFreshness('0.9.0', '1.0.0');
    expect(verdict.fresh).toBe(false);
    expect(verdict.degraded).toBe(true);
    expect(verdict.alert).toContain('增强数据过期');
    expect(verdict.alert).toContain('v0.9.0');
    expect(verdict.alert).toContain('v1.0.0');
    expect(verdict.level).toBe('error');
  });

  test('未导入增强数据（sourceModelVersion 缺省）→ 不触发 N1', () => {
    const verdict = guard.checkFreshness(undefined, '1.0.0');
    expect(verdict.fresh).toBe(true);
    expect(verdict.degraded).toBe(false);
    expect(verdict.alert).toBeNull();
  });

  test('有增强数据但缺 model.md 版本 → 提示无法比对（warn，降级着色）', () => {
    const verdict = guard.checkFreshness('1.0.0', undefined);
    expect(verdict.fresh).toBe(false);
    expect(verdict.degraded).toBe(true);
    expect(verdict.level).toBe('warn');
    expect(verdict.alert).toContain('缺少 model.md 版本信息');
  });

  test('任意版本差异方向均触发警示（新旧互反）', () => {
    const forward = guard.checkFreshness('0.1.0', '1.0.0');
    const backward = guard.checkFreshness('2.0.0', '1.0.0');
    expect(forward.degraded).toBe(true);
    expect(backward.degraded).toBe(true);
    expect(forward.alert).toContain('v0.1.0');
    expect(backward.alert).toContain('v2.0.0');
  });
});
