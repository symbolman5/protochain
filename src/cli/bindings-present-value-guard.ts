/**
 * C-8a 工具链现值守卫（10 §3-3 / §4 C-8a；11 执行编排 TI5）
 *
 * 职责：根 bindings.yaml 现值 sha256 与 web/manifest.json 各
 * `bundles.protocols[].bindingsFingerprint` 比对；不等 → 报告该协议
 * interface-details binding 投影过期。守卫只做现值检测（工具链有 fs），
 * 不断言"bindings.yaml 是否手改"的语义层（那是 C-8b viewer 同源比对的边界）。
 *
 * 纯比较函数 `checkBindingsFingerprintPresentValue` 独立导出，便于单测：
 * 测试可喂入假 manifest 协议列表 + 假当前 sha256，无需真实 fs。
 *
 * 不引入任何 `fresh` 布尔（C-3 为纯记录，10 §3-3 IR-2）；不修改既有守卫语义。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeBindingsFingerprint } from '../webgen/composition.js';

/** 单协议指纹比对输入（manifest 侧） */
export interface C8aProtocolFingerprint {
  id: string;
  bindingsFingerprint: string | null;
}

/** C-8a 现值检查结果 */
export interface C8aStaleReport {
  /** manifest 指纹 != 当前根 bindings.yaml sha256 的协议 id 列表（非同轮投影） */
  staleProtocolIds: string[];
  /** 根 bindings.yaml 不存在（currentSha256 === null）→ 无现值可比，视为 pass，不误报 */
  noBindingsFile: boolean;
}

/**
 * 纯比较：各协议 manifest 指纹 vs 当前根 bindings.yaml sha256。
 * - currentSha256 === null（无 bindings.yaml，如演示实例）→ 返回 clean（noBindingsFile=true）。
 * - 否则逐协议比对：protocol.bindingsFingerprint !== currentSha256 → 计入 stale。
 */
export function checkBindingsFingerprintPresentValue(
  protocols: ReadonlyArray<C8aProtocolFingerprint>,
  currentSha256: string | null
): C8aStaleReport {
  if (currentSha256 === null) {
    // 根 bindings.yaml 不存在（演示实例等无 bindings 场景）→ 无现值可比，pass，不误报
    return { staleProtocolIds: [], noBindingsFile: true };
  }
  const staleProtocolIds: string[] = [];
  for (const p of protocols) {
    if (p.bindingsFingerprint !== currentSha256) {
      staleProtocolIds.push(p.id);
    }
  }
  return { staleProtocolIds, noBindingsFile: false };
}

/**
 * 读取项目 web/manifest.json 并对各协议执行 C-8a 现值检查（供 CLI 调用）。
 * 非致命：任何读取/解析异常都返回 clean（守卫不得阻断 derive-web --project）。
 */
export function checkProjectBindingsFreshness(projectRootDir: string): C8aStaleReport {
  try {
    const manifestPath = join(projectRootDir, 'web', 'manifest.json');
    if (!existsSync(manifestPath)) {
      return { staleProtocolIds: [], noBindingsFile: false };
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      bundles?: { protocols?: ReadonlyArray<C8aProtocolFingerprint> };
    };
    const protocols = (manifest.bundles?.protocols ?? []).map((p) => ({
      id: p.id,
      bindingsFingerprint: p.bindingsFingerprint ?? null,
    }));
    const currentSha256 = computeBindingsFingerprint(projectRootDir);
    return checkBindingsFingerprintPresentValue(protocols, currentSha256);
  } catch {
    // 守卫非致命：解析失败时不当作 stale，避免阻断正常 derive
    return { staleProtocolIds: [], noBindingsFile: false };
  }
}
