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

  /** 五段渲染（08 §5.2 契约逐字段查表） */
  function renderEntry(state, panels, entry, protocolId, interfaceId) {
    const box = document.createElement('div');
    box.className = 'idp-card';
    const i = entry.interface || {};
    const r = entry.relation || {};

    // ── ① 接口自身 ──
    let html =
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
      (i.errorResponses && i.errorResponses.length > 0
        ? `<div class="idp-kv"><b>错误响应</b>${i.errorResponses.map((e2) => esc(e2.errorCode)).join('、')}</div>`
        : '') +
      (i.requestSchema
        ? `<div class="idp-kv"><b>请求 Schema</b></div><div class="idp-schema">${esc(JSON.stringify(i.requestSchema, null, 1))}</div>`
        : '') +
      (i.responseSchema
        ? `<div class="idp-kv"><b>响应 Schema</b></div><div class="idp-schema">${esc(JSON.stringify(i.responseSchema, null, 1))}</div>`
        : '');

    // ── ② 关系 ──
    html += `<div class="idp-block-title">② 关系</div>`;
    html += `<div class="idp-kv"><b>所属转移</b>${
      (r.ownedTransitions || []).length > 0 ? r.ownedTransitions.map((t) => `<span class="idp-chip">${esc(t)}</span>`).join('') : '<span class="idp-empty">（无，观测接口不触发转移）</span>'
    }</div>`;
    html += `<div class="idp-kv"><b>前置状态</b>${
      (r.preconditionStates || []).length > 0 ? r.preconditionStates.map((s) => `<span class="idp-chip">${esc(s)}</span>`).join('') : '<span class="idp-empty">（无）</span>'
    }</div>`;
    html += `<div class="idp-kv"><b>后置状态</b>${
      (r.postconditionStates || []).length > 0 ? r.postconditionStates.map((s) => `<span class="idp-chip">${esc(s)}</span>`).join('') : '<span class="idp-empty">（无）</span>'
    }</div>`;
    // 降级 3（08 §5.4）：coveredInvariants 空 → "无覆盖不变量"
    html += `<div class="idp-kv"><b>覆盖不变量</b>${
      (r.coveredInvariants || []).length > 0
        ? r.coveredInvariants.map((inv) => `<span class="idp-inv" title="scope=${esc(inv.scopeStateIds.join(','))} · carrier=${esc(inv.carrierRoleIds.join(','))}">${esc(inv.id)} ${esc(inv.name)}</span>`).join('')
        : '<span class="idp-empty">无覆盖不变量</span>'
    }</div>`;

    // ── ③ binding ──
    html += `<div class="idp-block-title">③ 绑定视图</div>`;
    const b = entry.binding;
    if (!b || !b.hasBindings) {
      html += `<div class="idp-empty">未读取到 bindings.yaml</div>`;
    } else {
      html += `<div class="idp-kv"><b>传输绑定</b>${
        (b.transport || []).length > 0
          ? b.transport.map((t) => `${esc(t.type)} ${t.method || ''} ${esc(t.path || '')}${t.roleId ? '（role ' + esc(t.roleId) + '）' : ''}`).join('；')
          : '<span class="idp-empty">（无）</span>'
      }</div>`;
      if (b.errorMapHits && b.errorMapHits.length > 0) {
        html += `<div class="idp-kv"><b>错误映射命中</b>${b.errorMapHits.map((h) => `${esc(h.errorCode)} → HTTP ${h.httpStatus !== undefined ? h.httpStatus : '—'}`).join('；')}</div>`;
      }
      if (b.unmappedErrorCodes && b.unmappedErrorCodes.length > 0) {
        html += `<div class="idp-kv"><b>未映射错误码</b>${b.unmappedErrorCodes.map((x) => esc(x)).join('、')}</div>`;
      }
      if (b.stateMap) {
        html += `<div class="idp-kv"><b>状态词表（项目级共享）</b>${Object.entries(b.stateMap).map(([k, v2]) => `${esc(k)}=${esc(v2)}`).join('，')}</div>`;
      }
    }

    // ── ④ diffImpact ──
    html += `<div class="idp-block-title">④ diff 波及</div>`;
    const di = r.diffImpact || { affected: false };
    if (di.affected) {
      html +=
        `<div class="idp-kv"><b>受影响</b><span class="idp-chip hl">是</span>` +
        `<div class="idp-kv"><b>变更转移</b>${(di.changedTransitions || []).map((t) => `<span class="idp-chip hl">${esc(t)}</span>`).join('')}</div>` +
        `<div class="idp-kv"><b>变更状态</b>${(di.changedStates || []).map((s) => `<span class="idp-chip hl">${esc(s)}</span>`).join('') || '<span class="idp-empty">（无）</span>'}</div>` +
        (di.summary ? `<div class="idp-kv"><b>摘要</b>${esc(di.summary)}</div>` : '') +
        `</div>`;
    } else {
      html += `<div class="idp-kv"><b>受影响</b><span class="idp-chip">否</span></div>`;
    }

    // ── ⑤ crossRefs ──
    html += `<div class="idp-block-title">⑤ 跨协议引用</div>`;
    const refs = entry.crossRefs || [];
    if (refs.length === 0) {
      // 降级 4（08 §5.4）：crossRefs 空
      html += `<div class="idp-empty">本接口未涉及跨协议引用</div>`;
    } else {
      html += `<div>`;
      for (let idx = 0; idx < refs.length; idx++) {
        const c = refs[idx];
        const dl = c.downlink || {};
        const resolved = dl.resolved === true;
        html +=
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
      html += `</div>`;
    }

    box.innerHTML = html;
    panels.appendChild(box);

    // 事件绑定
    const panel = box;
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
  }

  // ---------------------------------------------------------------------------
  // 注册为 interface scope 渲染器（TD8 renderScope）
  // ---------------------------------------------------------------------------
  if (window.ProtochainProjectNav && window.ProtochainProjectNav.registerScopeRenderer) {
    window.ProtochainProjectNav.registerScopeRenderer('interface', renderInterfaceDetail);
  }
})();
