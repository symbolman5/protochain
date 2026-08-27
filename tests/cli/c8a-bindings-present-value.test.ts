import {
  checkBindingsFingerprintPresentValue,
  type C8aProtocolFingerprint,
} from '../../src/cli/bindings-present-value-guard';

/**
 * C-8a 工具链现值守卫单测（10 §3-3 / §4 C-8a；TI5）。
 * 仅依赖纯比较函数，喂入假 manifest 协议列表 + 假当前 sha256，无需真实 fs。
 */
describe('C-8a 工具链现值守卫', () => {
  const toProtocols = (fps: Record<string, string | null>): C8aProtocolFingerprint[] =>
    Object.entries(fps).map(([id, bindingsFingerprint]) => ({ id, bindingsFingerprint }));

  it('（a）manifest 指纹 == 当前根 bindings.yaml sha256 → 一致（clean，无 stale）', () => {
    const report = checkBindingsFingerprintPresentValue(toProtocols({ P1: 'abc', P2: 'abc' }), 'abc');
    expect(report.noBindingsFile).toBe(false);
    expect(report.staleProtocolIds).toEqual([]);
  });

  it('（b）手改模拟：manifest 指纹 != sha256 → 报告该协议 interface-details 投影过期', () => {
    const report = checkBindingsFingerprintPresentValue(toProtocols({ P1: 'old1', P2: 'old2' }), 'current');
    expect(report.noBindingsFile).toBe(false);
    expect(report.staleProtocolIds.sort()).toEqual(['P1', 'P2']);
  });

  it('（b）部分协议过期 → 仅报告过期协议，未过期协议不报', () => {
    const report = checkBindingsFingerprintPresentValue(toProtocols({ P1: 'current', P2: 'stale' }), 'current');
    expect(report.staleProtocolIds).toEqual(['P2']);
  });

  it('（c）根 bindings.yaml 不存在（currentSha256 === null，如演示实例）→ pass，不误报', () => {
    const report = checkBindingsFingerprintPresentValue(toProtocols({ P1: null, P2: null }), null);
    expect(report.noBindingsFile).toBe(true);
    expect(report.staleProtocolIds).toEqual([]);
  });

  it('（补充）manifest 指纹为 null 但当前 bindings 已存在 → 视为漂移（stale，非 noBindingsFile）', () => {
    // 真实绑定文件存在但 manifest 建于无绑定期：两者不一致 → 报告过期。
    const report = checkBindingsFingerprintPresentValue(toProtocols({ P1: null }), 'current');
    expect(report.noBindingsFile).toBe(false);
    expect(report.staleProtocolIds).toEqual(['P1']);
  });
});
