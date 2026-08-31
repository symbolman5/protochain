/**
 * viewer 用例层面板（G7-V6 · §11.4 用例视图）
 *
 * 数据源（全部查表、端内零推导，数据来自 data.json 的 V3+ 字段）：
 *  - testCases[]（路径用例）：{id, length, stateIds[], transitionIds[], description, deviations[],
 *    verificationPassed?, verificationSkipped?}（buildTestCaseViews 已合并 verification caseResults）；
 *    ——兼容 testCases 为 {paths: [...]} 的对象形态（本仓库实测为数组）。
 *  - adversarialCases[]（对抗用例）：{id, kind, source, interfaceId, expectFailure, body, ...}
 *    （casegen G7-S4/S6 确定性产物：X5 observed-write / X6 guard-failure / X12 convergence /
 *    X15 credential-expired|revoked|lookup）。
 *  - verification：{hasReport, passed, counts: {passed, failed, skipped}, deviationSummary: {...}}。
 *
 * 面板结构（§11.4 顺序）：
 *  ① 路径用例区：testCases 渲染为路径列表（id / 长度徽章 / transitionIds 摘要 / 验证状态徽章）；
 *     点路径行展开查看覆盖的转移与状态（transitionIds[i]：stateIds[i] → stateIds[i+1]）+ deviations；
 *     verification 的执行结果（counts + deviationSummary）作状态徽章条。
 *  ② 对抗用例区：adversarialCases 按 kind 分组（observed-write / guard-failure / convergence /
 *     credential（credential-expired|revoked|lookup 归组，case 仍保留自身 kind 徽章））；
 *     每条显示：id / kind 徽章 / expectFailure 徽章 / source（原文展示，可点击）/
 *     断言摘要（body 中「断言」行解析，缺省取前几行）。
 *
 * source 指回联动（J2 判据核心）：点对抗用例的 source → 解析 source 文本与 interfaceId：
 *  - 命中接口 action（interfaces[].name/id 子串，长词优先）→ 高亮协议层对应操作行（.proto-op-row.hl-case）；
 *  - 命中维度名（dimensions[].dimension）→ 高亮协议层维度卡片行（.proto-dim-row.hl-case）
 *    与组件层存储落点（.comp-storage-row.hl-case，同一维度名查表——R2b 三视图互通，§11.4「落在哪个存储」）；
 *  - 命中不变量 ID（invariants[].id）→ 高亮协议层不变量列 + 其约束的操作行 + 涉及的维度（.hl-case），
 *    维度同时带出组件层存储落点。
 * 高亮用独立类名 .hl-case，不与协议层自身联动（active/hl-guard/hl-inv）与组件层（hl-comp）互踩；
 * document 级事件委托实现（同 interface-jump-bridge / component-panel 模式），不改动协议层面板。
 *
 * 降级：无 testCases 且无 adversarialCases 的 data.json → 面板显式提示"无用例数据"，不白屏不报错；
 * 部分缺失（仅无 adversarialCases）→ 对抗区块空态；未导入数据 → 不渲染。
 */
(function () {
  'use strict';

  // 分层视图目标解析（R2b+）：view-tabs.js 加载且非项目模式 → 渲染进 #view-cases；否则原 #panels（零回归）
  const viewBox = (window.ProtochainViewerTabs && window.ProtochainViewerTabs.viewBox) || ((p) => p);

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // 渲染上下文：render 时收集的查表结构（renderAll 每次清空并重建面板，交互前必然已刷新）
  let ctx = null;

  // ---------------------------------------------------------------------------
  // 数据提取（查表，端内零推导）
  // ---------------------------------------------------------------------------

  /** testCases 兼容两种形态：数组（实测）/ {paths: [...]} 对象 */
  function extractPaths(data) {
    const tc = data.testCases;
    if (Array.isArray(tc)) return tc;
    if (tc && typeof tc === 'object' && Array.isArray(tc.paths)) return tc.paths;
    return [];
  }

  /** 查表索引：接口 name/id → id、维度名、不变量（source 指回匹配用） */
  function buildCtx(data) {
    const ifaces = Array.isArray(data.interfaces) ? data.interfaces : [];
    const invs = Array.isArray(data.invariants) ? data.invariants : [];
    const dimNames = (Array.isArray(data.dimensions) ? data.dimensions : [])
      .map((d) => d && d.dimension)
      .filter((x) => typeof x === 'string' && x !== '');
    const ifaceTerms = [];
    const ifaceByName = new Map();
    const ifaceIds = new Set();
    for (const i of ifaces) {
      if (!i) continue;
      if (typeof i.id === 'string' && i.id) {
        ifaceIds.add(i.id);
        ifaceTerms.push({ term: i.id, id: i.id });
      }
      if (typeof i.name === 'string' && i.name) {
        if (!ifaceByName.has(i.name)) ifaceByName.set(i.name, i);
        if (i.name !== i.id) ifaceTerms.push({ term: i.name, id: i.id });
      }
    }
    // 长词优先：防短 id/name 被长词吞掉（先匹配长词再匹配短词）
    ifaceTerms.sort((a, b) => b.term.length - a.term.length);
    return {
      ifaces,
      invs,
      dimNames,
      ifaceTerms,
      ifaceByName,
      ifaceIds,
      invIdSet: new Set(invs.map((i) => i && i.id).filter(Boolean)),
    };
  }

  /** 操作文本是否提及不变量（与协议层 opTextsMentionInv 同构） */
  function opTextsMentionInv(op, invId) {
    const texts = [];
    if (typeof op.precondition === 'string') texts.push(op.precondition);
    if (Array.isArray(op.postconditions)) texts.push(...op.postconditions);
    if (Array.isArray(op.sideEffects)) {
      for (const s of op.sideEffects) texts.push(s.description || s.kind || '');
    }
    if (Array.isArray(op.outputs)) {
      for (const o of op.outputs) texts.push(o.description || '');
    }
    return texts.join('\n').includes(invId);
  }

  /** 断言摘要：body 中「断言」行解析；缺省取前几行 */
  function assertionSummary(body) {
    if (typeof body !== 'string' || body.trim() === '') return '';
    const lines = body
      .split('\n')
      .map((l) => l.replace(/^\s*\*\s?/, '').replace(/^\s*\/\*+/, '').trim())
      .filter(Boolean);
    const asserts = lines.filter((l) => l.includes('断言'));
    if (asserts.length > 0) return asserts.join('；');
    return lines.slice(0, 3).join(' ');
  }

  // ---------------------------------------------------------------------------
  // 区块渲染
  // ---------------------------------------------------------------------------

  function emptyHint(section, text) {
    const empty = document.createElement('div');
    empty.className = 'case-empty';
    empty.textContent = text;
    section.appendChild(empty);
  }

  /** 路径的验证状态徽章（verification caseResults 合并结果，未跑验证 → 未验证） */
  function pathVerificationBadge(p) {
    if (p.verificationPassed === true) {
      return '<span class="case-path-vb case-path-vb-passed" title="verificationPassed=true">✓ 通过</span>';
    }
    if (p.verificationPassed === false) {
      return '<span class="case-path-vb case-path-vb-failed" title="verificationPassed=false">✗ 失败</span>';
    }
    if (p.verificationSkipped) {
      return '<span class="case-path-vb case-path-vb-skipped" title="verificationSkipped=true">跳过</span>';
    }
    return '<span class="case-path-vb case-path-vb-na" title="无验证结果">未验证</span>';
  }

  /** ① 路径用例区 */
  function renderPathSection(box, paths, verification) {
    const section = document.createElement('div');
    section.className = 'case-section case-path-section';

    const sub = document.createElement('div');
    sub.className = 'case-section-title';
    sub.textContent = `① 路径用例区（testCases.paths ${paths.length} 条 · 点路径行展开查看覆盖的转移/状态）`;
    section.appendChild(sub);

    // verification 执行结果徽章条（counts + deviationSummary，非零项才展示）
    if (verification) {
      const bar = document.createElement('div');
      bar.className = 'case-verify-bar';
      const counts = verification.counts || {};
      const passed = counts.passed || 0;
      const failed = counts.failed || 0;
      const skipped = counts.skipped || 0;
      const chips = [
        `<span class="case-verify-chip case-verify-report">报告：${verification.hasReport === true ? '已生成' : '未生成'}</span>`,
        `<span class="case-verify-chip case-verify-passed">通过 ${passed}</span>`,
        `<span class="case-verify-chip case-verify-failed">失败 ${failed}</span>`,
        `<span class="case-verify-chip case-verify-skipped">跳过 ${skipped}</span>`,
        `<span class="case-verify-chip case-verify-verdict">${
          verification.passed === true ? '✓ 全部通过' : verification.passed === false ? '✗ 存在失败' : '未判定'
        }</span>`,
      ];
      const dev = verification.deviationSummary;
      if (dev && typeof dev === 'object') {
        for (const [k, v] of Object.entries(dev)) {
          if (v > 0) chips.push(`<span class="case-dev-chip" title="${esc(k)} 偏差 ${v} 处">${esc(k)} ${v}</span>`);
        }
      }
      bar.innerHTML = chips.join('');
      section.appendChild(bar);
    }

    if (paths.length === 0) {
      emptyHint(section, '（无路径用例：testCases 缺失或为空）');
      box.appendChild(section);
      return;
    }

    const list = document.createElement('div');
    list.className = 'case-path-list';
    for (const p of paths) {
      const row = document.createElement('div');
      row.className = 'case-path-row';
      row.setAttribute('data-path-id', p.id || '');
      row.title = '点击展开/收起覆盖的转移与状态';

      const head = document.createElement('div');
      head.className = 'case-path-head';
      const len = typeof p.length === 'number' ? p.length : (Array.isArray(p.transitionIds) ? p.transitionIds.length : 0);
      head.innerHTML =
        `<span class="case-path-caret">▸</span>` +
        `<span class="case-path-id">${esc(p.id || '—')}</span>` +
        `<span class="case-path-badge" title="路径长度（转移数）">${len} 步</span>` +
        `<span class="case-path-tids" title="transitionIds">${esc((Array.isArray(p.transitionIds) ? p.transitionIds : []).join(' → ') || '—')}</span>` +
        pathVerificationBadge(p);
      row.appendChild(head);

      // 展开详情：覆盖的转移/状态（transitionIds[i]：stateIds[i] → stateIds[i+1]）
      const detail = document.createElement('div');
      detail.className = 'case-path-detail';
      if (p.description) {
        const desc = document.createElement('div');
        desc.className = 'case-path-desc';
        desc.innerHTML = `<span class="case-path-desc-label">路径：</span>${esc(p.description)}`;
        detail.appendChild(desc);
      }
      const tids = Array.isArray(p.transitionIds) ? p.transitionIds : [];
      const sids = Array.isArray(p.stateIds) ? p.stateIds : [];
      if (tids.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'case-path-tstep case-path-tstep-empty';
        empty.textContent = '（空路径：无转移）';
        detail.appendChild(empty);
      } else {
        for (let i = 0; i < tids.length; i++) {
          const step = document.createElement('div');
          step.className = 'case-path-tstep';
          step.innerHTML =
            `<span class="case-tstep-tid">${esc(tids[i])}</span>` +
            `<span class="case-tstep-arrow">${esc(sids[i] || '?')} → ${esc(sids[i + 1] || '?')}</span>`;
          detail.appendChild(step);
        }
      }
      if (Array.isArray(p.deviations) && p.deviations.length > 0) {
        for (const d of p.deviations) {
          const dv = document.createElement('div');
          dv.className = 'case-path-deviation';
          dv.innerHTML =
            `<span class="case-path-dev-kind">${esc(d.kind || '')}</span>` +
            `<span class="case-path-dev-text">${esc(d.action || '')}${d.field ? ' · ' + esc(d.field) : ''}：期望 ${esc(d.expected ?? '')} 实得 ${esc(d.actual ?? '')}</span>`;
          detail.appendChild(dv);
        }
      }
      row.appendChild(detail);
      list.appendChild(row);
    }
    section.appendChild(list);
    box.appendChild(section);
  }

  // ---------------------------------------------------------------------------
  // ② 对抗用例区（按 kind 分组）
  // ---------------------------------------------------------------------------

  /** kind 分组：credential-expired|revoked|lookup 归入 credential 组，其余按原 kind */
  function kindGroup(kind) {
    return typeof kind === 'string' && kind.startsWith('credential-') ? 'credential' : kind;
  }

  const KIND_GROUP_ORDER = ['observed-write', 'guard-failure', 'convergence', 'credential'];

  function renderAdvCase(c) {
    const row = document.createElement('div');
    row.className = 'case-adv-row';
    row.setAttribute('data-case-id', c.id || '');
    row.setAttribute('data-case-kind', c.kind || '');
    const kindCls = 'case-kind-' + esc(String(c.kind || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_'));
    const expect = c.expectFailure === true
      ? '<span class="case-adv-expect case-adv-expect-fail" title="expectFailure=true：用例断言调用必须失败">期望失败</span>'
      : '<span class="case-adv-expect case-adv-expect-pass" title="expectFailure=false：用例断言调用应成功">期望通过</span>';

    const head = document.createElement('div');
    head.className = 'case-adv-head';
    head.innerHTML =
      `<span class="case-adv-id">${esc(c.id || '—')}</span>` +
      `<span class="case-kind-badge ${kindCls}">${esc(c.kind || '—')}</span>` +
      expect;
    row.appendChild(head);

    // source：原文展示，可点击（J2 判据：指回 model.md 声明 → 联动高亮协议层）
    const src = document.createElement('div');
    src.className = 'case-adv-source';
    src.setAttribute('data-source', c.source || '');
    src.title = '点击联动高亮协议层的对应操作行/维度卡片（source 指回 model.md 声明，J2 判据核心）';
    src.innerHTML =
      `<span class="case-adv-source-label">source：</span>` +
      `<span class="case-adv-source-text">${esc(c.source || '—')}</span>`;
    row.appendChild(src);

    // 断言摘要（body「断言」行解析，缺省取前几行）
    const summary = assertionSummary(c.body);
    if (summary) {
      const as = document.createElement('div');
      as.className = 'case-adv-assert';
      as.innerHTML = `<span class="case-adv-assert-label">断言：</span><span class="case-adv-assert-text">${esc(summary)}</span>`;
      row.appendChild(as);
    }
    return row;
  }

  function renderAdvSection(box, cases) {
    const section = document.createElement('div');
    section.className = 'case-section case-adv-section';

    const sub = document.createElement('div');
    sub.className = 'case-section-title';
    sub.textContent = `② 对抗用例区（adversarialCases ${cases.length} 条 · 按 kind 分组 · 点 source 指回 model.md 声明并联动高亮协议层）`;
    section.appendChild(sub);

    if (cases.length === 0) {
      emptyHint(section, '（无对抗用例：adversarialCases 缺失或为空）');
      box.appendChild(section);
      return;
    }

    // 按 kind 分组（保留数据内顺序；组序按 S4 枚举，未知 kind 追加尾部）
    const groups = new Map();
    for (const c of cases) {
      const g = kindGroup(c.kind);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(c);
    }
    const order = KIND_GROUP_ORDER.filter((g) => groups.has(g))
      .concat([...groups.keys()].filter((g) => !KIND_GROUP_ORDER.includes(g)));

    for (const g of order) {
      const list = groups.get(g);
      const group = document.createElement('div');
      group.className = 'case-adv-group';
      group.setAttribute('data-kind-group', g);

      const head = document.createElement('div');
      head.className = 'case-adv-group-head';
      head.innerHTML =
        `<span class="case-adv-group-label">${esc(g)}</span>` +
        `<span class="case-adv-group-count">${list.length} 条</span>`;
      group.appendChild(head);

      for (const c of list) group.appendChild(renderAdvCase(c));
      section.appendChild(group);
    }
    box.appendChild(section);
  }

  // ---------------------------------------------------------------------------
  // source 指回联动（跨面板高亮，独立类名 .hl-case）
  // ---------------------------------------------------------------------------

  function clearCaseHighlights() {
    if (typeof document === 'undefined') return;
    document.querySelectorAll('.case-adv-row.hl').forEach((x) => x.classList.remove('hl'));
    document.querySelectorAll('.proto-op-row.hl-case').forEach((x) => x.classList.remove('hl-case'));
    document.querySelectorAll('.proto-dim-row.hl-case').forEach((x) => x.classList.remove('hl-case'));
    document.querySelectorAll('.proto-inv-col.hl-case').forEach((x) => x.classList.remove('hl-case'));
    // R2b 三视图互通：组件层存储落点随 source 指回一起高亮/清除
    document.querySelectorAll('.comp-storage-row.hl-case').forEach((x) => x.classList.remove('hl-case'));
  }

  /** source 文本 + interfaceId → 目标集合（接口 action → 操作行 / 维度名 → 维度卡片 / 不变量 ID → 不变量列） */
  function matchSourceTargets(source, interfaceId) {
    const opIds = new Set();
    const dims = new Set();
    const invIds = new Set();
    if (source) {
      // 接口 name/id（长词优先，防短词吞长词）
      for (const { term, id } of ctx.ifaceTerms) {
        if (source.includes(term)) opIds.add(id);
      }
      // 维度名
      for (const name of ctx.dimNames) {
        if (source.includes(name)) dims.add(name);
      }
      // 不变量 ID
      for (const inv of ctx.invs) {
        if (inv && inv.id && source.includes(inv.id)) invIds.add(inv.id);
      }
    }
    // interfaceId 直指：X5/X6=action（接口 name）→ 接口 id；X12=不变量 ID
    if (interfaceId) {
      const byName = ctx.ifaceByName.get(interfaceId);
      if (byName) opIds.add(byName.id);
      else if (ctx.ifaceIds.has(interfaceId)) opIds.add(interfaceId);
      else if (ctx.invIdSet.has(interfaceId)) invIds.add(interfaceId);
    }
    return { opIds, dims, invIds };
  }

  function highlightSource(box, caseId) {
    clearCaseHighlights();
    if (!box || !ctx) return;
    const c = (ctx.cases || []).find((x) => x && x.id === caseId);
    if (!c) return;

    // 行自身反馈
    const row = box.querySelector(`.case-adv-row[data-case-id="${caseId}"]`);
    if (row) row.classList.add('hl');

    const { opIds, dims, invIds } = matchSourceTargets(c.source, c.interfaceId);

    // 接口 action → 协议层操作行
    for (const id of opIds) {
      document.querySelectorAll(`.proto-op-row[data-interface-id="${id}"]`).forEach((r) => r.classList.add('hl-case'));
    }
    // 维度名 → 协议层维度卡片行 + 组件层存储落点（三视图互通 §11.4「落在哪个存储」）
    for (const d of dims) {
      document.querySelectorAll(`.proto-dim-row[data-dimension="${d}"]`).forEach((r) => r.classList.add('hl-case'));
      document.querySelectorAll(`.comp-storage-row[data-dimension="${d}"]`).forEach((r) => r.classList.add('hl-case'));
    }
    // 不变量 ID → 不变量列 + 其约束的操作行 + 涉及的维度（与协议层 V4 点不变量同语义）
    for (const id of invIds) {
      document.querySelectorAll(`.proto-inv-col[data-invariant-id="${id}"]`).forEach((c2) => c2.classList.add('hl-case'));
      const inv = (ctx.invs || []).find((i) => i && i.id === id);
      if (inv) {
        for (const d of inv.dimensions || []) {
          document.querySelectorAll(`.proto-dim-row[data-dimension="${d}"]`).forEach((r) => r.classList.add('hl-case'));
          document.querySelectorAll(`.comp-storage-row[data-dimension="${d}"]`).forEach((r) => r.classList.add('hl-case'));
        }
        for (const op of ctx.ifaces || []) {
          if (!op || !op.id) continue;
          const explicit = Array.isArray(op.invariantIds) && op.invariantIds.includes(id);
          const mentioned = opTextsMentionInv(op, id);
          if (explicit || mentioned) {
            document.querySelectorAll(`.proto-op-row[data-interface-id="${op.id}"]`).forEach((r) => r.classList.add('hl-case'));
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 面板渲染入口
  // ---------------------------------------------------------------------------
  function renderCasesPanel(state, panels) {
    const data = state.dataJson;
    if (!data) return; // 未导入：主视图已有提示，用例层不重复
    panels = viewBox(panels, 'view-cases');
    if (panels.querySelector('.cases-panel') || panels.querySelector('.cases-empty')) return;

    const paths = extractPaths(data);
    const adversarial = Array.isArray(data.adversarialCases) ? data.adversarialCases : [];
    const verification = data.verification && typeof data.verification === 'object' ? data.verification : null;

    // 老实例（无路径用例且无对抗用例）→ 显式缺省提示（不白屏不报错）
    if (paths.length === 0 && adversarial.length === 0) {
      const p = document.createElement('div');
      p.className = 'panel-empty cases-empty';
      p.textContent =
        '用例面板：当前 data.json 无用例数据（testCases / adversarialCases，casegen + derive-web 产物）——请重新运行 casegen/derive-web 或导入新版 data.json';
      panels.appendChild(p);
      return;
    }

    // 查表索引（source 指回匹配读取）
    ctx = buildCtx(data);
    ctx.cases = adversarial;

    const box = document.createElement('div');
    box.className = 'cases-panel';

    const title = document.createElement('div');
    title.className = 'panel-subtitle';
    title.textContent = `用例面板（§11.4 · 路径用例 ${paths.length} · 对抗用例 ${adversarial.length}）`;
    box.appendChild(title);

    // ① 路径用例区
    renderPathSection(box, paths, verification);
    // ② 对抗用例区
    renderAdvSection(box, adversarial);

    panels.appendChild(box);
  }

  // ---------------------------------------------------------------------------
  // 注册（叠加到 renderAll 链尾；顺序在 component 之后）
  // ---------------------------------------------------------------------------
  const hooks = window.ProtochainViewerHooks || {};
  const prevRenderAll = hooks.renderAll;
  hooks.renderAll = function (state, panels) {
    if (prevRenderAll) prevRenderAll(state, panels);
    renderCasesPanel(state, panels);
  };
  window.ProtochainViewerHooks = hooks;

  // ---------------------------------------------------------------------------
  // 交互（document 级事件委托，同 interface-jump-bridge / component-panel 模式；不改动协议层面板）
  // ---------------------------------------------------------------------------
  if (typeof document !== 'undefined') {
    document.addEventListener('click', (ev) => {
      const t = ev.target;
      if (!t || typeof t.closest !== 'function') return;
      // 对抗用例 source 点击 → 指回联动
      const src = t.closest('.case-adv-source');
      if (src) {
        const row = src.closest('.case-adv-row');
        const box = src.closest('.cases-panel');
        const caseId = row && row.getAttribute('data-case-id');
        if (box && caseId) highlightSource(box, caseId);
        return;
      }
      // 路径行点击 → 展开/收起覆盖的转移与状态
      const pathRow = t.closest('.case-path-row');
      if (pathRow) {
        const detail = pathRow.querySelector('.case-path-detail');
        if (detail) {
          const open = detail.classList.toggle('open');
          const caret = pathRow.querySelector('.case-path-caret');
          if (caret) caret.textContent = open ? '▾' : '▸';
          pathRow.classList.toggle('open', open);
        }
      }
    });
  }
})();
