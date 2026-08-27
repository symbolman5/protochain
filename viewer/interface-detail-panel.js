/**
 * viewer 接口详情面板（T4 09-execution-T4.md TD9 / 08-project-viewer-design.md §5 + R10）
 *
 * 消费 state.interfaceDetails（interface-details.json）条目，按 08 §5 契约查表渲染五段：
 * ① 接口自身（name/kind/sourceId/actionType/triggerRoleId/description/schemaKind 及降级理由/
 *    isContractCarrier/requestSchema/responseSchema/inputs/outputs/precondition 系/errorResponses）；
 * ② 关系（ownedTransitions/preconditionStates/postconditionStates/coveredInvariants/diffImpact）；
 * ③ binding（hasBindings=false → "未读取到 bindings.yaml"）；
 * ④ diffImpact（affected=true 高亮 + changedTransitions/changedStates/summary）；
 * ⑤ crossRefs（逐条 kind/toProtocol/target/context + downlink 消费：resolved=true → 点击走
 *    §6.4 定位/高亮；resolved=false → 展示 reason 降级文案，不定位——viewer 不做任何 target 语义推断）。
 *
 * 降级语义（08 §5.4 表逐行）：interface-details 缺失 / 协议条目缺失 / coveredInvariants 空 /
 * crossRefs 空均显式提示不白屏；diff 新增接口（不在当前协议数据）→ 查 diff 快照数据渲染摘要。
 *
 * 注册为 interface scope 渲染器（TD8 renderScope）：window.ProtochainProjectNav.registerScopeRenderer('interface', ...)。
 */
(function () {
  'use strict';

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  const IDP_CSS = `
.idp-card{border:1px solid var(--border,#ddd);border-radius:8px;padding:12px;margin-bottom:10px;background:var(--panel-bg,#fafafa)}
.idp-block{margin:8px 0}
.idp-block-title{font-weight:600;font-size:13px;margin:10px 0 4px;color:#444}
.idp-kv{font-size:13px;margin:2px 0}
.idp-kv b{display:inline-block;min-width:110px;color:#666}
.idp-chip{display:inline-block;padding:2px 8px;margin:2px;border-radius:10px;background:#fff;border:1px solid #ccc;font-size:12px}
.idp-chip.hl{background:#ffe3ec;border-color:#d6336c;color:#d6336c;font-weight:600}
.idp-inv{display:inline-block;padding:2px 8px;margin:2px;border-radius:10px;background:#e6f7e6;border:1px solid #b7e4b7;font-size:12px}
.idp-ref-row{padding:6px 8px;border:1px solid #eee;border-radius:6px;margin:4px 0;font-size:13px;cursor:pointer}
.idp-ref-row:hover{background:#f4f7ff}
.idp-ref-row .idp-reason{color:#d6336c;font-size:12px;margin-top:2px}
.idp-ref-row .idp-ref-link{color:#2f6fed;font-weight:600}
.idp-empty{color:#888;font-size:13px;padding:4px 0}
.idp-schema{font-size:12px;white-space:pre-wrap;background:#f7f7f7;border:1px solid #eee;border-radius:6px;padding:8px;max-height:220px;overflow:auto;color:#333}
.idp-schema-tree{list-style:none;margin:4px 0;padding-left:16px;border-left:1px dashed #ccc}
.idp-schema-tree li{margin:3px 0;font-size:12px}
.idp-schema-tree code{font-weight:600;color:#1f2733}
.idp-schema-type{color:#2f6fed;font-family:ui-monospace,monospace}
.idp-req{color:#d6336c;font-size:11px;margin-left:6px}
.idp-schema-desc{color:#666;margin-left:6px}
.idp-schema-enum{color:#e8590c;font-size:11px;margin-left:6px}
.idp-errtable{width:100%;border-collapse:collapse;margin:4px 0;font-size:12px}
.idp-errtable th,.idp-errtable td{border:1px solid #e0e0e0;padding:3px 8px;text-align:left}
.idp-errtable th{background:#f3f5f8}
.idp-errtable .unmapped{color:#d6336c}
.idp-state-chip,.idp-trans-chip{cursor:pointer;color:#2f6fed}
.idp-state-chip:hover,.idp-trans-chip:hover{text-decoration:underline}
/* 状态机联动高亮（来自详情页跳转）：复用 main-view 节点/边，补 hl 描边 */
.sm-node-group.hl .sm-node{stroke:#d6336c;stroke-width:3px}
.sm-edge.hl{stroke:#d6336c;stroke-width:3px}
/* G6 · 两栏布局（纯 grid，无框架，合规红线④） */
.idp-two-col{display:grid;grid-template-columns:minmax(280px,1fr) minmax(360px,1.4fr);gap:16px;align-items:start}
.idp-col-left{position:sticky;top:8px;align-self:start}
.idp-col-right{min-width:0}
@media (max-width:760px){.idp-two-col{grid-template-columns:1fr}.idp-col-left{position:static}}
/* G6 · 请求/响应示例折叠块 */
.idp-example{margin:8px 0}
.idp-example summary{cursor:pointer;font-weight:600;font-size:13px;color:#444}
.idp-example pre{white-space:pre-wrap;background:#f7f7f7;border:1px solid #eee;border-radius:6px;padding:8px;max-height:240px;overflow:auto;color:#333;font-size:12px;margin:4px 0 0}
/* G6 · 代码样例 tab（curl/javascript/python 切换） */
.idp-tabs{display:flex;gap:6px;margin:6px 0 4px;flex-wrap:wrap}
.idp-tab{padding:3px 10px;border:1px solid #ccc;background:#fff;border-radius:12px;font-size:12px;cursor:pointer}
.idp-tab.active{background:#2f6fed;color:#fff;border-color:#2f6fed}
.idp-tab-panel{display:none}
.idp-tab-panel.active{display:block}
.idp-cs-label{font-size:12px;color:#666;margin:6px 0 2px}
.idp-code{white-space:pre-wrap;background:#0f172a;color:#e2e8f0;border-radius:6px;padding:8px;overflow:auto;font-size:12px;margin:0 0 8px}
/* G6 · 完整请求 URL（apifox 式：method + server + path） */
.idp-req-url{font-family:ui-monospace,monospace;font-size:12px;background:#eef;padding:4px 8px;border-radius:6px;display:inline-block;margin:2px 0}
.idp-req-url .m{color:#d6336c;font-weight:600}
.idp-req-url .u{color:#1f2733}
/* G6 · sticky 小导航 */
.idp-sticky-nav{font-size:12px;margin:6px 0}
.idp-sticky-nav a{display:block;color:#2f6fed;padding:2px 0}
`;

  let styleInjected = false;
  function injectStyle() {
    if (styleInjected) return;
    styleInjected = true;
    const st = document.createElement('style');
    st.setAttribute('data-idp', '1');
    st.textContent = IDP_CSS;
    document.head.appendChild(st);
  }

  /**
   * interface scope 渲染器（TD8 renderScope 调用）。
   * state.nav = { scope:'interface', protocolId, interfaceId }。
   */
  function renderInterfaceDetail(state, panels) {
    injectStyle();
    const nav = state.nav || {};
    const protocolId = nav.protocolId;
    const interfaceId = nav.interfaceId;
    const details = state.interfaceDetails;

    // 降级 1（08 §5.4）：interface-details.json 缺失
    if (!details) {
      const p = document.createElement('div');
      p.className = 'panel-empty idp-card';
      p.textContent = '接口详情数据未生成（缺 interface-details.json，请重新 derive-web --project）';
      panels.appendChild(p);
      return;
    }
    // 降级 2（08 §5.4）：该协议条目缺失（specs 不可读）
    const protoEntries = details.entries ? details.entries[protocolId] : undefined;
    if (!protoEntries) {
      const p = document.createElement('div');
      p.className = 'panel-empty idp-card';
      p.textContent = `[${esc(protocolId)}] specs 不可读，接口详情空`;
      panels.appendChild(p);
      return;
    }
    // diff 新增接口：不在当前协议数据条目 → 查 diff 快照数据渲染摘要（08 §5.2.1 / §6.4 L3 降级）
    const entry = protoEntries[interfaceId];
    if (!entry) {
      renderDiffAddedSummary(state, panels, protocolId, interfaceId);
      return;
    }
    renderEntry(state, panels, entry, protocolId, interfaceId);
  }

  /** diff 新增接口摘要（查 diff 快照数据：name/kind/precondition 等既有字段，08 §6.4 L3 降级） */
  function renderDiffAddedSummary(state, panels, protocolId, interfaceId) {
    const box = document.createElement('div');
    box.className = 'idp-card';
    // 在快照数据中查找该接口
    let found = null;
    let snapId = null;
    for (const [id, snap] of Object.entries(state.diffData || {})) {
      if (snap && Array.isArray(snap.interfaces)) {
        const hit = snap.interfaces.find((i) => i.id === interfaceId);
        if (hit) {
          found = hit;
          snapId = id;
          break;
        }
      }
    }
    let html = `<div class="idp-block-title">${esc(interfaceId)}（diff 新增 · ${esc(protocolId)}）</div>`;
    if (found) {
      html +=
        `<div class="idp-kv"><b>名称</b>${esc(found.name)}</div>` +
        `<div class="idp-kv"><b>类型</b>${esc(found.kind)}</div>` +
        (found.precondition ? `<div class="idp-kv"><b>前置条件</b>${esc(found.precondition)}</div>` : '') +
        `<div class="idp-kv"><b>快照</b>${esc(snapId)}（目标版本 v${esc((state.diffData[snapId] || {}).sourceModelVersion || '')}）</div>` +
        `<div class="idp-empty">该接口为 diff 新增（目标版本 v2），当前协议数据中无此接口——以上为 diff 快照摘要。</div>`;
    } else {
      html += `<div class="idp-empty">该接口为 diff 新增，但 diff 快照数据未导入（缺快照文件）。</div>`;
    }
    box.innerHTML = html;
    panels.appendChild(box);
  }

  // ---------------------------------------------------------------------------
  // TI9 · schema 全量递归渲染（Ob-4=A 全量递归常开）+ 错误码表（纯查表渲染中间输出）
  // ---------------------------------------------------------------------------

  /** 单个 schema 树节点 → <li>（含嵌套 children） */
  function schemaNodeHtml(node, requiredSet) {
    const req = requiredSet && requiredSet.indexOf(node.name) !== -1 ? ' <span class="idp-req">必填</span>' : '';
    const desc = node.description ? ` <span class="idp-schema-desc">${esc(node.description)}</span>` : '';
    const en = node.enum ? ` <span class="idp-schema-enum">enum: ${esc(node.enum.join(', '))}</span>` : '';
    let html =
      `<li><code>${esc(node.name)}</code> : <span class="idp-schema-type">${esc(node.type)}</span>${req}${desc}${en}</li>`;
    if (node.children && node.children.length) {
      html += '<ul class="idp-schema-tree">' +
        node.children.map((c) => schemaNodeHtml(c, node.required)).join('') +
        '</ul>';
    }
    return html;
  }

  /** schema 树（buildSchemaTree 中间输出）→ 可渲染 HTML（嵌套列表） */
  function renderSchemaTreeHtml(tree) {
    if (!tree || !tree.children || !tree.children.length) {
      return '<div class="idp-empty">（无 schema 字段）</div>';
    }
    return '<ul class="idp-schema-tree">' +
      tree.children.map((c) => schemaNodeHtml(c, tree.required)).join('') +
      '</ul>';
  }

  /** 委托 window.InterfaceViewUtils.buildSchemaTree 生成渲染中间输出（缺失时降级空树） */
  function schemaTree(schema, name) {
    const U = window.InterfaceViewUtils;
    return U ? U.buildSchemaTree(schema, name, '') : { name: name, path: '', type: 'any', children: [] };
  }

  /** 委托 window.InterfaceViewUtils.buildErrorTable 生成错误码表中间输出 */
  function schemaErrorTable(entry) {
    const U = window.InterfaceViewUtils;
    return U ? U.buildErrorTable(entry) : [];
  }

  /** 错误码表行（buildErrorTable 中间输出）→ 表格 HTML */
  function renderErrorTableHtml(rows) {
    if (!rows || rows.length === 0) {
      return '<div class="idp-empty">（无错误响应定义）</div>';
    }
    let html =
      '<table class="idp-errtable"><thead><tr><th>错误码</th><th>HTTP</th><th>说明</th></tr></thead><tbody>';
    for (const r of rows) {
      const cls = r.unmapped ? ' class="unmapped"' : '';
      html +=
        `<tr${cls}>` +
        `<td>${esc(r.errorCode)}</td>` +
        `<td>${r.httpStatus !== null && r.httpStatus !== undefined ? esc(String(r.httpStatus)) : '—'}</td>` +
        `<td>${esc(r.description || '')}</td>` +
        '</tr>';
    }
    html += '</tbody></table>';
    return html;
  }

  /** pretty JSON（示例块展示） */
  function prettyJson(v) {
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return String(v);
    }
  }

  /** G6 · 请求/响应示例折叠块（buildRequestResponseExample 中间输出，纯查表） */
  function schemaExampleHtml(entry) {
    const U = window.InterfaceViewUtils;
    const ex = U ? U.buildRequestResponseExample(entry) : { request: null, response: null };
    let html = '';
    if (ex.request !== null && ex.request !== undefined) {
      html +=
        `<details class="idp-example"><summary>请求示例</summary>` +
        `<pre>${esc(prettyJson(ex.request))}</pre></details>`;
    }
    if (ex.response !== null && ex.response !== undefined) {
      html +=
        `<details class="idp-example"><summary>响应示例</summary>` +
        `<pre>${esc(prettyJson(ex.response))}</pre></details>`;
    }
    return html;
  }

  /** G6 · 代码样例 tab（curl / javascript / python 切换，buildCodeSamples 中间输出） */
  function renderCodeSamplesHtml(entry) {
    const U = window.InterfaceViewUtils;
    const cs = U ? U.buildCodeSamples(entry) : [];
    if (!cs || cs.length === 0) return '<div class="idp-empty">（无代码样例）</div>';
    const langs = [];
    for (const s of cs) if (!langs.includes(s.lang)) langs.push(s.lang);
    const tabs = langs
      .map((l, i) => `<button type="button" class="idp-tab${i === 0 ? ' active' : ''}" data-lang="${esc(l)}">${esc(l)}</button>`)
      .join('');
    const panels = langs
      .map((l, i) => {
        const items = cs
          .filter((s) => s.lang === l)
          .map((s) => `<div class="idp-cs-label">${esc(s.label)}</div><pre class="idp-code">${esc(s.code)}</pre>`)
          .join('');
        return `<div class="idp-tab-panel${i === 0 ? ' active' : ''}" data-lang="${esc(l)}">${items}</div>`;
      })
      .join('');
    return `<div class="idp-tabs">${tabs}</div><div class="idp-tab-panels">${panels}</div>`;
  }

  /** G6 · 完整请求 URL（apifox 式：method + server + path） */
  function renderTransportUrl(t) {
    const method = (t.method || '').toUpperCase();
    const server = t.server || '';
    const path = t.path || '/';
    const url = (server + path).replace(/([^:])\/+/g, '$1/');
    return `<span class="idp-req-url"><span class="m">${esc(method || '—')}</span> <span class="u">${esc(url)}</span></span>`;
  }

  /** 接口 → 状态机跳转（interface→state/transition，W3-c ③ 联动） */
  function jumpToStateMachine(state, protocolId, kind, id) {
    window.ProtochainProjectNav.navigate(state, { scope: 'protocol', protocolId });
    setTimeout(() => {
      if (kind === 'edge') {
        const e = document.querySelector(`[data-edge-id="${id}"]`);
        if (e) e.classList.add('hl');
      } else {
        const n = document.querySelector(`[data-node-id="${id}"]`);
        if (n) n.classList.add('hl');
      }
    }, 60);
  }

  /** 五段渲染（08 §5.2 契约逐字段查表）；G6 升级为两栏布局：左 sticky 小导航 + schema 字段树，右 描述+示例+代码样例+错误码+binding+关系+diff+引用（纯 CSS grid，不引框架，合规红线④） */
  function renderEntry(state, panels, entry, protocolId, interfaceId) {
    const box = document.createElement('div');
    box.className = 'idp-card';
    const i = entry.interface || {};
    const r = entry.relation || {};
    // 锚点前缀：以 interfaceId 区分，避免同页多接口卡片冲突
    const a = (suffix) => `idp-${interfaceId}-${suffix}`;

    // ── 左栏：sticky 小导航 + schema 字段树（01 G6 两栏布局）──
    const schemaLeft =
      (i.requestSchema
        ? `<div class="idp-kv"><b>请求 Schema</b></div>` + renderSchemaTreeHtml(schemaTree(i.requestSchema, 'requestSchema'))
        : '') +
      (i.responseSchema
        ? `<div class="idp-kv"><b>响应 Schema</b></div>` + renderSchemaTreeHtml(schemaTree(i.responseSchema, 'responseSchema'))
        : '');
    const leftCol =
      `<nav class="idp-sticky-nav">` +
      `<a href="#${a('if')}">接口信息</a>` +
      `<a href="#${a('schema')}">Schema 字段树</a>` +
      `<a href="#${a('example')}">请求/响应示例</a>` +
      `<a href="#${a('cs')}">代码样例</a>` +
      `<a href="#${a('err')}">错误码表</a>` +
      `<a href="#${a('binding')}">绑定视图</a>` +
      `<a href="#${a('rel')}">关系</a>` +
      `<a href="#${a('diff')}">diff 波及</a>` +
      `<a href="#${a('xref')}">跨协议引用</a>` +
      `</nav>` +
      `<div id="${a('schema')}">${schemaLeft}</div>`;

    // ── 右栏：描述 + 示例 + 代码样例 + 错误码 + binding + 关系 + diff + 引用 ──
    // ── ① 接口自身 ──
    let right =
      `<div id="${a('if')}">` +
      `<div class="idp-block-title">① 接口 · ${esc(i.id)}（${esc(i.name)}）</div>` +
      `<div class="idp-kv"><b>协议</b>${esc(protocolId)}</div>` +
      `<div class="idp-kv"><b>类型</b>${esc(i.kind)}${i.actionType ? ' · ' + esc(i.actionType) : ''}</div>` +
      `<div class="idp-kv"><b>sourceId</b>${esc(i.sourceId)}</div>` +
      (i.triggerRoleId ? `<div class="idp-kv"><b>触发角色</b>${esc(i.triggerRoleId)}</div>` : '') +
      `<div class="idp-kv"><b>描述</b>${esc(i.description || '')}</div>` +
      (i.schemaKind ? `<div class="idp-kv"><b>schema 形态</b>${esc(i.schemaKind)}</div>` : '') +
      (i.schemaDegradedReasons && i.schemaDegradedReasons.length > 0
        ? `<div class="idp-kv"><b>降级理由</b>${i.schemaDegradedReasons.map((x) => esc(x)).join('；')}</div>`
        : '') +
      (i.isContractCarrier
        ? `<div class="idp-kv"><b>承载接口</b>契约 interface 未匹配 transition，由 specifier 派生</div>`
        : '') +
      (i.precondition ? `<div class="idp-kv"><b>前置条件</b>${esc(i.precondition)}</div>` : '') +
      (i.invariantIds && i.invariantIds.length > 0
        ? `<div class="idp-kv"><b>不变量 ID</b>${i.invariantIds.map((x) => esc(x)).join('、')}</div>`
        : '') +
      (i.observesResourcePoolId
        ? `<div class="idp-kv"><b>资源池</b>${esc(i.observesResourcePoolId)}</div>`
        : '') +
      (i.inputs && i.inputs.length > 0
        ? `<div class="idp-kv"><b>入参</b>${i.inputs.map((x) => `${esc(x.name)}: ${esc(x.type || 'any')}${x.required ? '（必填）' : ''}`).join('，')}</div>`
        : '') +
      (i.outputs && i.outputs.length > 0
        ? `<div class="idp-kv"><b>出参</b>${i.outputs.map((x) => `${esc(x.name)}: ${esc(x.type || 'any')}`).join('，')}</div>`
        : '') +
      `</div>`;

    // ── ① 接口自身段下新增「请求示例 / 响应示例」折叠块（G6）──
    const exHtml = schemaExampleHtml(entry);
    if (exHtml) {
      right += `<div id="${a('example')}">${exHtml}</div>`;
    }

    // ── ①-b 错误码表上方新增「代码样例」tab（G6）──
    const csHtml = renderCodeSamplesHtml(entry);
    right += `<div id="${a('cs')}"><div class="idp-block-title">代码样例</div>${csHtml}</div>`;

    // ── ①-b 错误码表（TI9 / 板块②：errorResponses + errorMapHits + unmappedErrorCodes）──
    const errorRows = schemaErrorTable(entry);
    right += `<div id="${a('err')}"><div class="idp-block-title">错误码表</div>${renderErrorTableHtml(errorRows)}</div>`;

    // ── ② 关系 ──
    right += `<div id="${a('rel')}"><div class="idp-block-title">② 关系</div>`;
    right += `<div class="idp-kv"><b>所属转移</b>${
      (r.ownedTransitions || []).length > 0
        ? r.ownedTransitions.map((t) => `<span class="idp-trans-chip" data-transition-id="${esc(t)}">${esc(t)}</span>`).join('')
        : '<span class="idp-empty">（无，观测接口不触发转移）</span>'
    }</div>`;
    right += `<div class="idp-kv"><b>前置状态</b>${
      (r.preconditionStates || []).length > 0
        ? r.preconditionStates.map((s) => `<span class="idp-state-chip" data-state-id="${esc(s)}">${esc(s)}</span>`).join('')
        : '<span class="idp-empty">（无）</span>'
    }</div>`;
    right += `<div class="idp-kv"><b>后置状态</b>${
      (r.postconditionStates || []).length > 0
        ? r.postconditionStates.map((s) => `<span class="idp-state-chip" data-state-id="${esc(s)}">${esc(s)}</span>`).join('')
        : '<span class="idp-empty">（无）</span>'
    }</div>`;
    // 降级 3（08 §5.4）：coveredInvariants 空 → "无覆盖不变量"
    right += `<div class="idp-kv"><b>覆盖不变量</b>${
      (r.coveredInvariants || []).length > 0
        ? r.coveredInvariants.map((inv) => `<span class="idp-inv" title="scope=${esc(inv.scopeStateIds.join(','))} · carrier=${esc(inv.carrierRoleIds.join(','))}">${esc(inv.id)} ${esc(inv.name)}</span>`).join('')
        : '<span class="idp-empty">无覆盖不变量</span>'
    }</div></div>`;

    // ── ③ binding ──
    right += `<div id="${a('binding')}"><div class="idp-block-title">③ 绑定视图</div>`;
    const b = entry.binding;
    if (!b || !b.hasBindings) {
      right += `<div class="idp-empty">未读取到 bindings.yaml</div>`;
    } else {
      // 传输绑定：apifox 式完整请求 URL（method + server + path）
      right += `<div class="idp-kv"><b>传输绑定</b>${
        (b.transport || []).length > 0
          ? b.transport.map((t) => renderTransportUrl(t) + (t.roleId ? `（role ${esc(t.roleId)}）` : '')).join('；')
          : '<span class="idp-empty">（无）</span>'
      }</div>`;
      if (b.errorMapHits && b.errorMapHits.length > 0) {
        right += `<div class="idp-kv"><b>错误映射命中</b>${b.errorMapHits.map((h) => `${esc(h.errorCode)} → HTTP ${h.httpStatus !== undefined ? h.httpStatus : '—'}`).join('；')}</div>`;
      }
      if (b.unmappedErrorCodes && b.unmappedErrorCodes.length > 0) {
        right += `<div class="idp-kv"><b>未映射错误码</b>${b.unmappedErrorCodes.map((x) => esc(x)).join('、')}</div>`;
      }
      if (b.stateMap) {
        right += `<div class="idp-kv"><b>状态词表（项目级共享）</b>${Object.entries(b.stateMap).map(([k, v2]) => `${esc(k)}=${esc(v2)}`).join('，')}</div>`;
      }
    }
    right += `</div>`;

    // ── ④ diffImpact ──
    right += `<div id="${a('diff')}"><div class="idp-block-title">④ diff 波及</div>`;
    const di = r.diffImpact || { affected: false };
    if (di.affected) {
      right +=
        `<div class="idp-kv"><b>受影响</b><span class="idp-chip hl">是</span>` +
        `<div class="idp-kv"><b>变更转移</b>${(di.changedTransitions || []).map((t) => `<span class="idp-chip hl">${esc(t)}</span>`).join('')}</div>` +
        `<div class="idp-kv"><b>变更状态</b>${(di.changedStates || []).map((s) => `<span class="idp-chip hl">${esc(s)}</span>`).join('') || '<span class="idp-empty">（无）</span>'}</div>` +
        (di.summary ? `<div class="idp-kv"><b>摘要</b>${esc(di.summary)}</div>` : '') +
        `</div>`;
    } else {
      right += `<div class="idp-kv"><b>受影响</b><span class="idp-chip">否</span></div>`;
    }
    right += `</div>`;

    // ── ⑤ crossRefs ──
    right += `<div id="${a('xref')}"><div class="idp-block-title">⑤ 跨协议引用</div>`;
    const refs = entry.crossRefs || [];
    if (refs.length === 0) {
      // 降级 4（08 §5.4）：crossRefs 空
      right += `<div class="idp-empty">本接口未涉及跨协议引用</div>`;
    } else {
      right += `<div>`;
      for (let idx = 0; idx < refs.length; idx++) {
        const c = refs[idx];
        const dl = c.downlink || {};
        const resolved = dl.resolved === true;
        right +=
          `<div class="idp-ref-row" data-ref-index="${idx}" data-resolved="${resolved ? '1' : '0'}"` +
          (resolved ? ` data-dl-proto="${esc(dl.protocolId)}" data-dl-target="${esc(dl.target)}" data-dl-kind="${esc(dl.kind)}"` : '') +
          `>` +
          `<span class="idp-ref-kind">[${esc(c.kind)}]</span> ${esc(c.toProtocol)}${c.target !== undefined ? '.' + esc(c.target) : ''} · ${esc(c.sourceField)}` +
          `<div class="idp-kv"><b>上下文</b>${esc(c.context || '')}</div>` +
          (resolved
            ? `<div class="idp-ref-link">已解析 → ${esc(dl.kind)} ${esc(dl.target)}（点击定位）</div>`
            : `<div class="idp-reason">降级：${esc(dl.reason || '')}</div>`) +
          `</div>`;
      }
      right += `</div>`;
    }
    right += `</div>`;

    box.innerHTML = `<div class="idp-two-col"><div class="idp-col-left">${leftCol}</div><div class="idp-col-right">${right}</div></div>`;
    panels.appendChild(box);

    // 事件绑定
    const panel = box;
    // TI9 · 接口→状态/转移 跳转（W3-c ③ 联动）：点击前置/后置状态 → 高亮状态机节点；点击所属转移 → 高亮转移边
    panel.querySelectorAll('.idp-state-chip[data-state-id]').forEach((chip) => {
      chip.addEventListener('click', () => {
        jumpToStateMachine(state, protocolId, 'node', chip.getAttribute('data-state-id'));
      });
    });
    panel.querySelectorAll('.idp-trans-chip[data-transition-id]').forEach((chip) => {
      chip.addEventListener('click', () => {
        jumpToStateMachine(state, protocolId, 'edge', chip.getAttribute('data-transition-id'));
      });
    });
    panel.querySelectorAll('.idp-ref-row[data-resolved="1"]').forEach((row) => {
      row.addEventListener('click', () => {
        const protocolId = row.getAttribute('data-dl-proto');
        const target = row.getAttribute('data-dl-target');
        const kind = row.getAttribute('data-dl-kind');
        // §6.4 定位/高亮：resolved=true → 跳目标协议视图并高亮目标（查表定位）
        window.ProtochainProjectNav.navigate(state, { scope: 'protocol', protocolId });
        // 渲染完成后高亮目标状态/接口节点
        setTimeout(() => {
          const node = document.querySelector(`[data-node-id="${target}"]`);
          if (node) {
            node.classList.add('hl');
          }
          const edge = document.querySelector(`[data-edge-id="${target}"]`);
          if (edge) {
            edge.classList.add('hl');
          }
        }, 50);
      });
    });
    // G6 · 代码样例 tab 切换（curl / javascript / python）：同卡片内切换 active，不引框架
    panel.querySelectorAll('.idp-tab[data-lang]').forEach((tab) => {
      tab.addEventListener('click', () => {
        const lang = tab.getAttribute('data-lang');
        panel.querySelectorAll('.idp-tab').forEach((t) => t.classList.toggle('active', t.getAttribute('data-lang') === lang));
        panel.querySelectorAll('.idp-tab-panel').forEach((p) => p.classList.toggle('active', p.getAttribute('data-lang') === lang));
      });
    });
  }

  // ---------------------------------------------------------------------------
  // 注册为 interface scope 渲染器（TD8 renderScope）
  // ---------------------------------------------------------------------------
  if (window.ProtochainProjectNav && window.ProtochainProjectNav.registerScopeRenderer) {
    window.ProtochainProjectNav.registerScopeRenderer('interface', renderInterfaceDetail);
  }
})();
