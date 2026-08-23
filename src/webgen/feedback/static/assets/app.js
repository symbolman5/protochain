/* Protochain P1 frontend (no-token, no-build pure JS) */
(function () {
  'use strict';

  /** tiny helpers */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k === 'html') e.innerHTML = attrs[k];
      else e.setAttribute(k, attrs[k]);
    }
    if (children) for (const c of children) e.appendChild(c);
    return e;
  }
  async function api(method, path, body) {
    const opt = { method, headers: { 'accept': 'application/json' } };
    if (body !== undefined) {
      opt.headers['content-type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    const r = await fetch(path, opt);
    let json = null;
    try { json = await r.json(); } catch (e) { /* non-JSON */ }
    if (!r.ok || (json && json.ok === false)) {
      const err = (json && json.error) || `HTTP ${r.status}`;
      throw new Error(err);
    }
    return json && json.data !== undefined ? json.data : json;
  }
  function showMessage(boxEl, text, isError) {
    if (!boxEl) return;
    boxEl.className = isError ? 'err' : 'ok';
    boxEl.textContent = text;
    boxEl.hidden = false;
  }
  function argsParse(s) {
    if (!s || !s.trim()) return [];
    // naive shell-like split (no quotes for simplicity)
    return s.match(/(?<=^|\s)[^ \t]+(?=\s|$)/g) || [];
  }

  /* dashboard */
  async function bootIndex() {
    try {
      const h = await api('GET', '/api/health');
      $('#rootDir').textContent = h.rootDir || '(unknown)';
      $('#serviceName').textContent = h.service || '(unknown)';
      $('#envResidue').textContent = String(h.remainingSensitiveEnvKeys.length);
      $('#envResidue').className = h.remainingSensitiveEnvKeys.length === 0 ? 'ok' : 'err';
      $('#sensitiveList').textContent = (h.sensitiveFieldNames || []).join(', ');
    } catch (err) {
      $('#rootDir').textContent = '加载失败：' + (err && err.message);
    }
  }

  /* scenarios */
  async function bootScenarios() {
    const tbody = $('#filesTbody');
    const reload = async () => {
      try {
        const d = await api('GET', '/api/scenarios');
        tbody.innerHTML = '';
        for (const f of d.files) {
          const tr = el('tr');
          tr.appendChild(el('td', { text: f.filename }));
          tr.appendChild(el('td', { text: f.id || '(未通过 schema)' }));
          const ea = f.parsed && f.parsed.expectedActions ? f.parsed.expectedActions.join(', ') : '';
          tr.appendChild(el('td', { text: ea }));
          const opTd = el('td');
          const editBtn = el('button', { type: 'button' });
          editBtn.textContent = '编辑';
          editBtn.onclick = () => openEditor(f);
          opTd.appendChild(editBtn);
          const delBtn = el('button', { type: 'button', class: 'secondary' });
          delBtn.textContent = '删除';
          delBtn.onclick = async () => {
            if (!confirm('删除 ' + f.filename + '？')) return;
            try { await api('DELETE', '/api/scenarios/' + encodeURIComponent(f.filename)); reload(); }
            catch (err) { showMessage($('#messageBox'), String(err && err.message || err), true); }
          };
          opTd.appendChild(delBtn);
          tr.appendChild(opTd);
          tbody.appendChild(tr);
        }
      } catch (err) {
        showMessage($('#messageBox'), String(err && err.message || err), true);
      }
    };

    const sec = $('#editorSection');
    const form = $('#editorForm');
    const titleEl = $('#editorTitle');
    function openEditor(f) {
      titleEl.textContent = '编辑：' + f.filename;
      form.filename.value = f.filename;
      form.filename.readOnly = true;
      form.id.value = f.parsed ? f.parsed.id : ('SC-' + f.filename.replace(/\.ya?ml$/, '').replace(/[^A-Za-z0-9-]/g, '').toUpperCase());
      form.name.value = (f.parsed && f.parsed.name) || '';
      form.expectedActions.value = f.parsed ? f.parsed.expectedActions.join(',') : '';
      form.description.value = (f.parsed && f.parsed.description) || '';
      form.params.value = f.parsed && f.parsed.params ? JSON.stringify(f.parsed.params, null, 2) : '';
      form.setup.value = f.parsed && f.parsed.setup ? JSON.stringify(f.parsed.setup, null, 2) : '';
      sec.hidden = false;
    }
    function openBlank() {
      titleEl.textContent = '新建 scenario';
      form.filename.value = '';
      form.filename.readOnly = false;
      form.id.value = '';
      form.name.value = '';
      form.expectedActions.value = '';
      form.description.value = '';
      form.params.value = '';
      form.setup.value = '';
      sec.hidden = false;
    }
    $('#newBtn').onclick = openBlank;
    $('#cancelBtn').onclick = () => { sec.hidden = true; };

    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const f = form;
      const body = {
        id: f.id.value,
        name: f.name.value || undefined,
        expectedActions: f.expectedActions.value.split(',').map((s) => s.trim()).filter(Boolean),
      };
      const desc = f.description.value.trim();
      if (desc) body.description = desc;
      const paramsRaw = f.params.value.trim();
      if (paramsRaw) {
        try { body.params = JSON.parse(paramsRaw); }
        catch (err) { return showMessage($('#messageBox'), 'params JSON 解析失败：' + err.message, true); }
      }
      const setupRaw = f.setup.value.trim();
      if (setupRaw) {
        try { body.setup = JSON.parse(setupRaw); }
        catch (err) { return showMessage($('#messageBox'), 'setup JSON 解析失败：' + err.message, true); }
      }
      try {
        if (f.filename.readOnly) {
          await api('PUT', '/api/scenarios/' + encodeURIComponent(f.filename.value), body);
        } else {
          if (!f.filename.value) return showMessage($('#messageBox'), 'filename 必填', true);
          await api('PUT', '/api/scenarios/' + encodeURIComponent(f.filename.value), body);
        }
        showMessage($('#messageBox'), '保存成功', false);
        sec.hidden = true;
        reload();
      } catch (err) {
        showMessage($('#messageBox'), String(err && err.message || err), true);
      }
    };
    reload();
  }

  /* bindings */
  async function bootBindings() {
    const editor = $('#bindingsEditor');
    const meta = $('#bindingsMeta');
    const pathEl = $('#bindingsPath');
    const reload = async () => {
      try {
        const d = await api('GET', '/api/bindings');
        pathEl.textContent = d.path || '(unknown)';
        editor.value = d.raw || '';
        const ib = (d.parsed && d.parsed.interfaces) || [];
        meta.textContent = 'roles: ' + ((d.parsed && d.parsed.roles && d.parsed.roles.length) || 0)
          + ' · interfaces: ' + ib.length
          + (d.validation && d.validation.ok === false ? ' · ⚠ 当前 YAML 不通过 schema' : '');
      } catch (err) {
        showMessage($('#messageBox'), String(err && err.message || err), true);
      }
    };
    $('#reloadBtn').onclick = reload;
    $('#saveBtn').onclick = async () => {
      try {
        // 服务端会解析并 ajv 校验；这里直接 PUT 原始 YAML 字符串需服务端走 raw 通道。
        // 本前端 PUT 走 JSON：因为有 raw 文本，先尝试 parse YAML 在前端解析；
        // 若 parse 失败，则原样 PUT 字符串体（特殊格式 rawS）。服务端接口接受 object。
        let parsed;
        try {
          // 走 YAML 解析（前端无 yaml lib：用服务端）
          // 直接走 PUT body=string 时服务端会拒；改用 GET /api/bindings 拿 parsed，
          // 合并来自 textarea 的"字符串"难以做差量 —— 此处用最简单方案：
          // 把 editor 内容序列化后让服务端用 yaml 解析。
          // 由于这是一个 P1 反馈闭环编辑器，我们让后端 /api/bindings 直接接受 JSON 对象
          // （调用方要先把 YAML 转 JSON；无 yaml lib 在浏览器中很麻烦）。
          // 取巧：让服务端接收 rawYAML 字符串放到 _rawYAML，后端直接覆盖写文件，并走 ajv。
          // 但当前后端接口是 JSON object — 为此，本前端 PUT 通过「读出 parsed → 让用户编辑 raw」 不可行。
          // 折中：把 raw 文本转成一个 { _rawYAML: editor.value } 对象提交，后端检测该字段走 raw 路径。
          parsed = { _rawYAML: editor.value };
        } catch (err) {
          throw new Error('YAML 客户端不解析；保存由服务端接管');
        }
        await api('PUT', '/api/bindings', parsed);
        showMessage($('#messageBox'), '保存成功（服务端 YAML 解析 + schema 校验）', false);
        reload();
      } catch (err) {
        showMessage($('#messageBox'), String(err && err.message || err), true);
      }
    };
    reload();
  }

  /* run */
  async function bootRun() {
    const box = $('#runResult');
    $$('button[data-kind]').forEach((btn) => {
      btn.onclick = async () => {
        const kind = btn.getAttribute('data-kind');
        const args = argsParse($('#argsInput').value);
        btn.disabled = true;
        try {
          const d = await api('POST', '/api/run/' + kind, { args });
          box.hidden = false;
          $('#rOk').textContent = String(d.ok);
          $('#rExit').textContent = String(d.exitCode);
          $('#rMs').textContent = String(d.durationMs);
          $('#rArgv').textContent = (d.argv || []).join(' ');
          $('#rStdout').textContent = d.stdout || '(empty)';
          $('#rStderr').textContent = d.stderr || '(empty)';
          $('#rWarn').hidden = !d.truncated;
        } catch (err) {
          box.hidden = false;
          $('#rOk').textContent = 'false';
          $('#rStdout').textContent = '';
          $('#rStderr').textContent = String(err && err.message || err);
        } finally {
          btn.disabled = false;
        }
      };
    });
  }

  /* review */
  async function bootReview() {
    const form = $('#reviewForm');
    const tbody = $('#issuesTbody');
    const reload = async () => {
      try {
        const items = await api('GET', '/api/issues');
        tbody.innerHTML = '';
        for (const i of items) {
          const tr = el('tr');
          tr.appendChild(el('td', { text: String(i.nnn) }));
          tr.appendChild(el('td', { text: i.slug }));
          tr.appendChild(el('td', { text: i.status }));
          const tdPath = el('td');
          tdPath.appendChild(el('code', { text: i.path }));
          tr.appendChild(tdPath);
          tbody.appendChild(tr);
        }
      } catch (err) {
        showMessage($('#messageBox'), String(err && err.message || err), true);
      }
    };
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const fd = new FormData(form);
      const body = {};
      for (const [k, v] of fd.entries()) body[k] = v;
      try {
        const d = await api('POST', '/api/issues', body);
        showMessage($('#messageBox'), '草稿已落盘：' + d.draftPath + '（编号 ' + d.number + '）', false);
        reload();
      } catch (err) {
        showMessage($('#messageBox'), String(err && err.message || err), true);
      }
    };
    reload();
  }

  window.P1 = {
    bootIndex, bootScenarios, bootBindings, bootRun, bootReview,
  };
})();
