/**
 * viewer 接口主视图共享纯函数（G5 Wave 4 · TI7/TI8/TI9）
 *
 * 全部为纯函数（无 DOM / 无 window 引用），可在 Node 单测中直接 require。
 * 仅做"定位 + 查表 + 渲染中间输出"——零推导（10 §3-1 / 红线二）。
 *
 * 浏览器：<script src="interface-view-utils.js"> → window.InterfaceViewUtils
 * Node 测试：require('../../viewer/interface-view-utils.js')（UMD 导出）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.InterfaceViewUtils = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // TI7 · 默认落地页判定（Ob-6=A + 并存规则，纯函数）
  // ---------------------------------------------------------------------------
  /**
   * 根据导入状态决定首屏 scope（Ob-6=A 拍板：按导入数据自动决定）。
   *  - manifest + interface-details(catalog) 在场 → 'catalog'（接口目录优先）
   *  - 仅 manifest + 协议/组合层数据（无 interface-details）→ 'composition'（状态机）
   *  - 仅 manifest（无其他）→ 'project'（项目总览）
   *  - 非项目模式（无 manifest）→ 'project'（由 baseRenderAll 渲染 main-view）
   * @param {{manifest?:any,interfaceDetails?:any,projectData?:Object,dataJson?:any}} state
   * @returns {{scope:string}}
   */
  function decideDefaultScope(state) {
    const s = state || {};
    const hasManifest = !!(s.manifest);
    const hasCatalog = !!(s.interfaceDetails && s.interfaceDetails.catalog);
    const hasProtocolData = !!(
      s.projectData &&
      Object.keys(s.projectData).some((k) => !!s.projectData[k])
    );
    const hasComposition = !!(s.dataJson);
    // Ob-6=A + 并存规则（10 §3-4）：manifest/interface-details 在场即接口目录优先
    if (hasManifest && hasCatalog) return { scope: 'catalog' };
    if (hasManifest && (hasProtocolData || hasComposition)) return { scope: 'composition' };
    if (hasManifest) return { scope: 'project' };
    return { scope: 'project' };
  }

  /** catalog/interface-details 是否支持接口目录（查表前置） */
  function hasInterfaceDirectory(state) {
    const s = state || {};
    return !!(s.interfaceDetails && s.interfaceDetails.catalog);
  }

  // ---------------------------------------------------------------------------
  // TI8 · catalog 查表（零推导，仅重塑为一致分组结构供渲染）
  // ---------------------------------------------------------------------------
  /**
   * 把 catalog 某个索引重塑为一致的 groups 结构（key + items），不做任何维度派生。
   * 归组边界规则（10 §3-1）已由工具链在 TI3 投影，此处仅查表。
   * @param {{byProtocol?:object,byRole?:object,byPreconditionState?:object}} catalog
   * @param {'byProtocol'|'byRole'|'byPreconditionState'} indexKey
   */
  function buildCatalogView(catalog, indexKey) {
    if (!catalog || !catalog[indexKey]) return { indexKey, groups: [] };
    const idx = catalog[indexKey];
    const groups = Object.keys(idx).map((key) => ({
      key,
      items: (idx[key] || []).map((it) => ({
        protocolId: it.protocolId,
        interfaceId: it.interfaceId,
      })),
    }));
    return { indexKey, groups };
  }

  // ---------------------------------------------------------------------------
  // TI9 · schema 全量递归渲染中间输出（Ob-4=A 全量递归常开）
  // ---------------------------------------------------------------------------
  function isPlainObject(v) {
    return v && typeof v === 'object' && !Array.isArray(v);
  }

  /**
   * 递归把 JSON Schema 展开为字段树（中间输出，可序列化 → 供 Gif-2 diff）。
   * 每个节点：{ name, path, type, children?, description?, enum?, required? }
   */
  function buildSchemaTree(schema, name, path) {
    const node = {
      name: name || '(root)',
      path: path || '',
      type: schema && schema.type ? schema.type : Array.isArray(schema) ? 'array' : 'any',
    };
    const children = [];
    if (isPlainObject(schema) && schema.type === 'object' && schema.properties) {
      for (const [k, v] of Object.entries(schema.properties)) {
        children.push(buildSchemaTree(v, k, (path ? path + '.' : '') + k));
      }
      if (Array.isArray(schema.required)) node.required = schema.required;
    } else if (isPlainObject(schema) && schema.type === 'array' && schema.items) {
      children.push(buildSchemaTree(schema.items, 'items[]', (path ? path + '.' : '') + '[]'));
    }
    if (children.length) node.children = children;
    if (isPlainObject(schema) && schema.description) node.description = schema.description;
    if (isPlainObject(schema) && Array.isArray(schema.enum)) node.enum = schema.enum;
    return node;
  }

  /**
   * 收集 schema 树的叶子字段 path（含嵌套），用于逐字段 diff 断言（Gif-2）。
   * 仅收集叶子节点（无 children 的节点）；中间容器（object/array 自身）不算字段。
   */
  function collectSchemaFieldPaths(tree, acc) {
    acc = acc || [];
    const hasChildren = Array.isArray(tree.children) && tree.children.length > 0;
    if (tree.path && !hasChildren) acc.push(tree.path); // 仅叶子字段
    if (hasChildren) {
      for (const c of tree.children) collectSchemaFieldPaths(c, acc);
    }
    return acc;
  }

  // ---------------------------------------------------------------------------
  // TI9 · 错误码表中间输出（errorResponses + errorMapHits + unmappedErrorCodes）
  // ---------------------------------------------------------------------------
  /**
   * 合并接口层 errorResponses 与 binding 层 errorMapHits/unmappedErrorCodes 为
   * 错误码表行：{ errorCode, httpStatus, description, unmapped? }
   */
  function buildErrorTable(entry) {
    const i = (entry && entry.interface) || {};
    const b = (entry && entry.binding) || {};
    const map = {};
    for (const e of i.errorResponses || []) {
      map[e.errorCode] = {
        errorCode: e.errorCode,
        httpStatus: e.httpStatus !== undefined ? e.httpStatus : null,
        description: e.description || '',
        unmapped: false,
      };
    }
    for (const h of b.errorMapHits || []) {
      if (!map[h.errorCode]) {
        map[h.errorCode] = { errorCode: h.errorCode, httpStatus: null, description: '', unmapped: false };
      }
      if (h.httpStatus !== undefined && map[h.errorCode].httpStatus === null) {
        map[h.errorCode].httpStatus = h.httpStatus;
      }
    }
    const rows = Object.keys(map).map((k) => map[k]);
    for (const c of b.unmappedErrorCodes || []) {
      if (!map[c]) {
        rows.push({ errorCode: c, httpStatus: null, description: '（bindings 未映射）', unmapped: true });
      }
    }
    return rows;
  }

  // ---------------------------------------------------------------------------
  // TI9 · transport 中间输出（method/path/roleId/server）（G6 · 10 §17.3 C-G6-3）
  // ---------------------------------------------------------------------------
  function buildTransportRows(binding) {
    const b = binding || {};
    return (b.transport || []).map((t) => ({
      type: t.type,
      method: t.method || '',
      path: t.path || '',
      server: t.server || '',
      roleId: t.roleId || null,
    }));
  }

  // ---------------------------------------------------------------------------
  // G6 · 请求/响应示例中间输出（10 §17.2 / §17.6 未决③：仅顶层折叠块，不注入属性级 example）
  // 纯查表：直接透传 interface-details 已预投影的 requestExample/responseExample。
  // ---------------------------------------------------------------------------
  function buildRequestResponseExample(entry) {
    const i = (entry && entry.interface) || {};
    return {
      request: i.requestExample !== undefined ? i.requestExample : null,
      response: i.responseExample !== undefined ? i.responseExample : null,
    };
  }

  // ---------------------------------------------------------------------------
  // G6 · 代码样例中间输出（10 §17.2：lang/label/code 三元组）
  // 纯查表：直接透传 interface-details 已预投影的 codeSamples。
  // ---------------------------------------------------------------------------
  function buildCodeSamples(entry) {
    const i = (entry && entry.interface) || {};
    return Array.isArray(i.codeSamples) ? i.codeSamples : [];
  }

  return {
    decideDefaultScope,
    hasInterfaceDirectory,
    buildCatalogView,
    buildSchemaTree,
    collectSchemaFieldPaths,
    buildErrorTable,
    buildTransportRows,
    buildRequestResponseExample,
    buildCodeSamples,
  };
});
