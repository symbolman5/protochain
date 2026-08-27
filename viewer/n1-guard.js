/**
 * N1 新鲜度守卫（纯函数，UMD）
 *
 * 双数据源守卫（03-viewer.md W3-a / NR3-1 收口）：
 * - data.json.sourceModelVersion（buildWebData 从 model.metadata.version 写入）
 *   vs 浏览器端 parseProtocolContent 解析出的 model.metadata.version；
 * - 不匹配 → 降级"只看结构" + 显式提示"增强数据过期（vX vs vY）"；
 * - 着色唯一数据源 = data.json（edgeCoverage），N1 触发时 TA5 ⑥ 不着色。
 *
 * 项目级守卫（08-project-viewer-design.md §7，T4 09-execution-T4 TD6）：
 * checkProjectFreshness(manifest, imported) 纯函数——逐协议 S1（manifest 声明
 * dataSourceModelVersion vs 已导入 pN.data.json.sourceModelVersion，不等 → 该协议
 * 降级）+ S2（可选：C 模用户带 model.md 时 modelVersion vs 解析版本）+ S3（manifest
 * 内 modelVersion vs dataSourceModelVersion 自查，不等 → warning）+ S5（manifest
 * dataSourceModelVersion vs interface-details.protocolVersions[Pn]，不等 → 接口详情
 * 降级、条目仍展示）+ S6（composition.modelVersion vs 组合层 data.json
 * composition.version，不等 → warning 不锁视图）；S4 bindingsFingerprint 声明型不
 * 比对；diff 段不参与任何比对（防误报，08 §7.2）。verdict 复用 {fresh,degraded,alert,level}。
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
  const FRESH = { fresh: true, degraded: false, alert: null, level: 'ok' };

  /**
   * 判定 data.json 与 model.md 的新鲜度。
   * @param {string|undefined} sourceModelVersion data.json.sourceModelVersion
   * @param {string|undefined} modelVersion        浏览器端解析出的 metadata.version
   * @returns {{fresh: boolean, degraded: boolean, alert: string|null, level: string}}
   */
  function checkFreshness(sourceModelVersion, modelVersion) {
    // 未导入增强数据（或增强数据缺该字段的旧产物）→ 无 N1 可比对，不降级
    if (sourceModelVersion === undefined || sourceModelVersion === null) {
      return FRESH;
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
      return FRESH;
    }
    return {
      fresh: false,
      degraded: true,
      alert: `增强数据过期（v${sourceModelVersion} vs v${modelVersion}）——已降级为只看结构（不着色）`,
      level: 'error',
    };
  }

  /**
   * 项目级新鲜度守卫（08 §7.2 源对 S1~S6；R4=B 按子协议降级；diff 段不参与比对）。
   *
   * @param {object} manifest 项目级 manifest（ProjectManifest；08 §4.2）
   * @param {object} imported 已导入数据集合：
   *   - protocolData: { Pn: pN.data.json }（已导入的协议数据；缺协议 → 该协议不比）
   *   - interfaceDetails: interface-details.json 或 null（S5 源）
   *   - compositionData: 组合层 data.json 或 null（S6 源）
   *   - modelIr: { Pn: 浏览器解析的 model.md IR }（S2 源，仅 C 模用户带 model.md 时）
   * @returns {{perProtocol: object, interfaceDetails: object, composition: object}}
   *   perProtocol[Pn] / interfaceDetails / composition 均为 {fresh,degraded,alert,level}。
   */
  function checkProjectFreshness(manifest, imported) {
    const imp = imported || {};
    const perProtocol = {};
    const protocols = (manifest && manifest.bundles && manifest.bundles.protocols) || [];

    // S1（dataSourceModelVersion vs 已导入 pN.data.json.sourceModelVersion → 该协议 error 降级）
    // S2（modelVersion vs 浏览器解析 model.md 版本 → 该协议 error 降级；仅 C 模生效）
    // S3（manifest 内 modelVersion vs dataSourceModelVersion → warning，工具链一致性信号）
    for (const proto of protocols) {
      const pid = proto.id;
      const importedData = imp.protocolData ? imp.protocolData[pid] : undefined;
      const modelIr = imp.modelIr ? imp.modelIr[pid] : undefined;

      // S1
      const s1 = compareS1(proto, importedData);
      // S2（可选源对：modelIr 存在才生效，R12）
      const s2 = compareS2(proto, modelIr);
      // S3（manifest 内自查）
      const s3 = compareS3(proto);

      // 聚合：S1/S2 失配（error 降级）优先；其次 S3（warning）；否则 fresh
      if (s1.degraded) {
        perProtocol[pid] = s1;
      } else if (s2.degraded) {
        perProtocol[pid] = s2;
      } else if (s3.degraded) {
        perProtocol[pid] = s3;
      } else {
        perProtocol[pid] = Object.assign({}, FRESH);
      }
    }

    // S5（interface-details.protocolVersions[Pn] vs manifest dataSourceModelVersion → 接口详情降级）
    let interfaceDetails = Object.assign({}, FRESH);
    const details = imp.interfaceDetails;
    if (details && details.protocolVersions) {
      for (const proto of protocols) {
        const manifestSource = proto.dataSourceModelVersion;
        const detailsVersion = details.protocolVersions[proto.id];
        if (manifestSource === null || manifestSource === undefined) continue;
        if (detailsVersion !== undefined && detailsVersion !== null && manifestSource !== detailsVersion) {
          interfaceDetails = {
            fresh: false,
            degraded: true,
            alert: `接口详情与协议数据不同批，请重新 derive-web --project（${proto.id}: v${detailsVersion} vs v${manifestSource}）`,
            level: 'error',
          };
          break;
        }
      }
    }

    // S4（C-8b 同源一致性守卫，10 §3-3 / C-8b，TI5）：逐 interface-details entry 取 protocolId，
    // 比对 entry.binding.bindingsFingerprintAtBuild（C-3 纯记录，per-entry）与
    // manifest.bundles.protocols[pid].bindingsFingerprint（per-protocol）——检测 manifest /
    // interface-details 产物集合内部非同轮漂移。viewer 无文件系统，不检测 bindings.yaml 手改；
    // bindingsFingerprintAtBuild === null（无 bindings.yaml，如演示实例）→ 跳过、不报告（不误报
    // 为 fresh/新）；两者均非 null 且不一致 → interfaceDetails 降级；均匹配（含 demo 的 null vs null
    // 跳过）→ clean。diff 段不参与比对（08 §7.2）。
    const s4 = compareS4(manifest, details);
    // 仅当 S5 未降级时，用 S4 结果覆盖 interfaceDetails（S4 非同轮漂移同样属接口详情过期）
    if (s4.degraded && !interfaceDetails.degraded) {
      interfaceDetails = {
        fresh: false,
        degraded: true,
        alert: s4.summary.alert,
        level: 'error',
      };
    }

    // S6（composition.modelVersion vs 组合层 data.json composition.version → warning 不锁视图）
    let composition = Object.assign({}, FRESH);
    const compData = imp.compositionData;
    if (compData && compData.composition && manifest && manifest.bundles && manifest.bundles.composition) {
      const declared = manifest.bundles.composition.modelVersion;
      const actual = compData.composition.version;
      if (actual !== undefined && actual !== null && declared !== actual) {
        composition = {
          fresh: false,
          degraded: true,
          alert: `组合层数据可能过期（声明 v${declared} vs 实际 v${actual}）`,
          level: 'warn',
        };
      }
    }

    return { perProtocol, interfaceDetails, composition, bindingConsistency: s4.summary };
  }

  /**
   * S4（C-8b 同源一致性守卫，10 §3-3 / C-8b）：比对 interface-details 各 entry 的
   * bindingsFingerprintAtBuild（C-3 纯记录）与 manifest 同协议 bindingsFingerprint。
   * - 任意 entry 的 atBuild 为 null/undefined（无 bindings.yaml，如演示实例）→ 跳过该 entry，
   *   整体退化为 unknown（不报告 fresh/新、不降级）；
   * - atBuild 非 null 但与 manifest 指纹不一致 → 非同轮漂移，degraded（error）；
   * - atBuild 非 null 且全部一致 → 同源一致（ok）。
   * 返回 { degraded, summary }，summary 为对外暴露的 bindingConsistency 结果。
   */
  function compareS4(manifest, details) {
    const protocols = (manifest && manifest.bundles && manifest.bundles.protocols) || [];
    const protoFp = {};
    for (const proto of protocols) {
      protoFp[proto.id] = proto.bindingsFingerprint !== undefined ? proto.bindingsFingerprint : null;
    }
    let anyCompared = false;
    if (details && details.entries) {
      for (const pid of Object.keys(details.entries)) {
        const entries = details.entries[pid] || {};
        const manifestFp = Object.prototype.hasOwnProperty.call(protoFp, pid) ? protoFp[pid] : null;
        for (const iid of Object.keys(entries)) {
          const binding = entries[iid] && entries[iid].binding;
          const atBuild = binding ? binding.bindingsFingerprintAtBuild : undefined;
          // Gif-6b 边界：atBuild === null（无 bindings.yaml，如演示实例）→ 跳过，不误报为 fresh/新
          if (atBuild === null || atBuild === undefined) continue;
          anyCompared = true;
          if (manifestFp !== atBuild) {
            return {
              degraded: true,
              summary: {
                degraded: true,
                level: 'error',
                alert: '接口详情与 manifest 非同轮生成（binding 指纹不一致），请重新 derive-web --project',
              },
            };
          }
        }
      }
    }
    if (!anyCompared) {
      // 无可供比对的 fingerprint（演示实例 atBuild 全为 null）→ unknown：不报告 fresh、不降级
      return {
        degraded: false,
        summary: { degraded: false, level: 'unknown', alert: null },
      };
    }
    return {
      degraded: false,
      summary: { degraded: false, level: 'ok', alert: null },
    };
  }

  /** S1：manifest.dataSourceModelVersion vs 已导入 pN.data.json.sourceModelVersion */
  function compareS1(proto, importedData) {
    const source = proto.dataSourceModelVersion;
    const imported = importedData ? importedData.sourceModelVersion : undefined;
    // 缺该协议数据（未导入）→ 不比（降级由"数据未导入"提示处理）；声明缺省 null → 不比
    if (source === null || source === undefined) return FRESH;
    if (imported === undefined || imported === null) return FRESH;
    if (source !== imported) {
      return {
        fresh: false,
        degraded: true,
        alert: `增强数据过期（v${imported} vs v${source}）——本协议降级为只看结构（不着色）`,
        level: 'error',
      };
    }
    return FRESH;
  }

  /** S2：manifest.modelVersion vs 浏览器解析 model.md 版本（仅 C 模用户带 model.md 时生效，R12） */
  function compareS2(proto, modelIr) {
    const modelVersion = proto.modelVersion;
    const parsed = modelIr ? modelIr.metadata.version : undefined;
    if (parsed === undefined || parsed === null) return FRESH; // 未带 model.md → 不比
    if (modelVersion !== parsed) {
      return {
        fresh: false,
        degraded: true,
        alert: `增强数据过期（v${parsed} vs v${modelVersion}）——本协议降级为只看结构（不着色）`,
        level: 'error',
      };
    }
    return FRESH;
  }

  /** S3：manifest 内 modelVersion vs dataSourceModelVersion（工具链一致性信号，warning） */
  function compareS3(proto) {
    const modelVersion = proto.modelVersion;
    const dataSource = proto.dataSourceModelVersion;
    if (modelVersion === undefined || modelVersion === null) return FRESH;
    if (dataSource === undefined || dataSource === null) return FRESH;
    if (modelVersion !== dataSource) {
      return {
        fresh: false,
        degraded: true,
        alert: `工具链一致性警告：model.md 版本（v${modelVersion}）与增强数据声明版本（v${dataSource}）不一致，请重新 derive-web --project`,
        level: 'warn',
      };
    }
    return FRESH;
  }

  return { checkFreshness, checkProjectFreshness };
});
