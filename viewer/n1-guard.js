/**
 * N1 新鲜度守卫（纯函数，UMD）
 *
 * 双数据源守卫（03-viewer.md W3-a / NR3-1 收口）：
 * - data.json.sourceModelVersion（buildWebData 从 model.metadata.version 写入）
 *   vs 浏览器端 parseProtocolContent 解析出的 model.metadata.version；
 * - 不匹配 → 降级"只看结构" + 显式提示"增强数据过期（vX vs vY）"；
 * - 着色唯一数据源 = data.json（edgeCoverage），N1 触发时 TA5 ⑥ 不着色。
 *
 * 浏览器：<script src="n1-guard.js"> → window.N1Guard
 * Node 测试：require('../../viewer/n1-guard.js')（UMD 导出）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.N1Guard = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  /**
   * 判定 data.json 与 model.md 的新鲜度。
   * @param {string|undefined} sourceModelVersion data.json.sourceModelVersion
   * @param {string|undefined} modelVersion        浏览器端解析出的 metadata.version
   * @returns {{fresh: boolean, degraded: boolean, alert: string|null, level: string}}
   */
  function checkFreshness(sourceModelVersion, modelVersion) {
    // 未导入增强数据（或增强数据缺该字段的旧产物）→ 无 N1 可比对，不降级
    if (sourceModelVersion === undefined || sourceModelVersion === null) {
      return { fresh: true, degraded: false, alert: null, level: 'ok' };
    }
    // 有增强数据但缺 model.md 版本信息 → 无法比对，提示但不硬降级
    if (modelVersion === undefined || modelVersion === null) {
      return {
        fresh: false,
        degraded: true,
        alert: '已导入增强数据但缺少 model.md 版本信息，无法比对新鲜度（着色降级）',
        level: 'warn',
      };
    }
    if (sourceModelVersion === modelVersion) {
      return { fresh: true, degraded: false, alert: null, level: 'ok' };
    }
    return {
      fresh: false,
      degraded: true,
      alert: `增强数据过期（v${sourceModelVersion} vs v${modelVersion}）——已降级为只看结构（不着色）`,
      level: 'error',
    };
  }

  return { checkFreshness };
});
