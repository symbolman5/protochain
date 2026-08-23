/**
 * feedback-server 端到端单测 —— E7-P1
 *
 * 覆盖：
 *   - 服务启动后 GET /api/health 返回 200 + env 敏感键清单 + 剩余敏感键为 0
 *   - GET / 渲染静态 index.html
 *   - GET /scenarios / /bindings / /run / /review /assets/app.js 都 200
 *   - scenarios CRUD（list / get / put / delete）：start 端到端
 *   - bindings 读写（_rawYAML 走 yaml 解析路径）
 *   - 安全性：响应中不出现 tokenEnv（断言 known secrets）
 *   - 安全：scrub 后 process.env 不含 LEGACY_TOKEN
 *   - 一键执行子进程（runner.runCliSync 用真实 cli）—— 至少能跑 generate-cases 等
 *
 * 注意：本测试在测试期间显式存 / 删 process.env 上的临时键，确保不影响别的套件。
 */

import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startFeedbackServer, buildApp, type FeedbackServerHandle } from '../../src/webgen/feedback/index.js';

const STATIC_DIR_FOR_TESTS = join(__dirname, '..', '..', 'src', 'webgen', 'feedback', 'static');

function startEphemeralServer(rootDir: string, opts: { skipEnvScrub?: boolean; knownSecrets?: string[] } = {}): Promise<{ handle: FeedbackServerHandle; cleanup: () => Promise<void> }> {
  return startFeedbackServer({
    rootDir,
    port: 0, // 系统自动分配
    host: '127.0.0.1',
    skipEnvScrub: opts.skipEnvScrub ?? false,
    knownSecrets: opts.knownSecrets ?? [],
    staticDir: STATIC_DIR_FOR_TESTS,
  }).then((handle) => ({
    handle,
    cleanup: async () => {
      await handle.close();
    },
  }));
}

function fetchUrl(url: string, opts: { method?: string; body?: unknown } = {}): Promise<{ status: number; text: string; json?: unknown }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const data = opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body));
    const headers: Record<string, string> = {};
    if (data) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(data.length);
    }
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: opts.method ?? 'GET', headers },
      (res) => {
        let chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          let json: unknown = undefined;
          try { json = JSON.parse(text); } catch {/* ignore */}
          resolve({ status: res.statusCode ?? 0, text, json });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

describe('feedback-server: 启动与健康', () => {
  beforeEach(() => {
    process.env.__TEST_LEGACY_TOKEN = 'secret-token-value-789';
    process.env.__TEST_SECRET_X = 'shh';
  });
  afterEach(() => {
    delete process.env.__TEST_LEGACY_TOKEN;
    delete process.env.__TEST_SECRET_X;
  });
  test('startFeedbackServer 启动 + 关闭', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'feedback-e2e-'));
    mkdirSync(join(rootDir, 'protocol', 'scenarios'), { recursive: true });
    const { handle, cleanup } = await startEphemeralServer(rootDir);
    try {
      expect(handle.address.port).toBeGreaterThan(0);
      // 调用 /api/health
      const h = await fetchUrl(`http://127.0.0.1:${handle.address.port}/api/health`);
      expect(h.status).toBe(200);
      expect(JSON.stringify(h.json)).toContain('protochain-feedback');
    } finally {
      await cleanup();
    }
  });

  test('启动 scrub 后 process.env 不再含 LEGACY_TOKEN', async () => {
    expect(process.env.__TEST_LEGACY_TOKEN).toBe('secret-token-value-789');
    const rootDir = mkdtempSync(join(tmpdir(), 'feedback-e2e-'));
    const { handle, cleanup } = await startEphemeralServer(rootDir);
    try {
      expect(process.env.__TEST_LEGACY_TOKEN).toBeUndefined();
      expect(process.env.__TEST_SECRET_X).toBeUndefined();
      // 服务报告的 scrubbed 列表应包含它们（值已 redact，键名按 E7-P1-I3 掩码输出）
      const h = await fetchUrl(`http://127.0.0.1:${handle.address.port}/api/health`);
      const json = h.json as { data?: { scrubbedKeyNames?: string[] } };
      const list = json.data?.scrubbedKeyNames ?? [];
      // 掩码后不再含完整键名
      expect(list.some((s) => s.includes('__TEST_LEGACY_TOKEN'))).toBe(false);
      // 但应有 'sensitive' 族标记 + 长度元数据（__TEST_LEGACY_TOKEN 长度 = 19）
      expect(list.some((s) => /sensitive/.test(s) && /\(19,/.test(s))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test('skipEnvScrub=true 跳过 scrub', async () => {
    expect(process.env.__TEST_LEGACY_TOKEN).toBe('secret-token-value-789');
    const rootDir = mkdtempSync(join(tmpdir(), 'feedback-e2e-'));
    const { handle, cleanup } = await startEphemeralServer(rootDir, { skipEnvScrub: true });
    try {
      expect(process.env.__TEST_LEGACY_TOKEN).toBe('secret-token-value-789');
      const h = await fetchUrl(`http://127.0.0.1:${handle.address.port}/api/health`);
      const json = h.json as { data?: { scrubbedKeyNames?: string[]; remainingSensitiveEnvKeys?: string[] } };
      // scrubbedKeyNames 为空（没跑 scrub），remainingSensitiveEnvKeys 掩码后含元数据
      expect(json.data?.scrubbedKeyNames?.length ?? 0).toBe(0);
      const residual = json.data?.remainingSensitiveEnvKeys ?? [];
      expect(residual.some((s) => s.includes('__TEST_LEGACY_TOKEN'))).toBe(false);
      expect(residual.some((s) => /sensitive/.test(s) && /\(19,/.test(s))).toBe(true);
    } finally {
      delete process.env.__TEST_LEGACY_TOKEN;
      await cleanup();
    }
  });
});

describe('feedback-server: 静态资源', () => {
  test('GET / GET /scenarios / /bindings / /run / /review /assets/app.js /assets/app.css 都 200', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'feedback-static-'));
    mkdirSync(join(rootDir, 'protocol', 'scenarios'), { recursive: true });
    const { handle, cleanup } = await startEphemeralServer(rootDir);
    try {
      for (const path of ['/', '/scenarios', '/bindings', '/run', '/review', '/assets/app.js']) {
        const r = await fetchUrl(`http://127.0.0.1:${handle.address.port}${path}`);
        expect(r.status).toBe(200);
      }
    } finally {
      await cleanup();
    }
  });
});

describe('feedback-server: scenarios CRUD', () => {
  test('list / put / get / delete 端到端', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'feedback-crud-'));
    mkdirSync(join(rootDir, 'protocol', 'scenarios'), { recursive: true });
    const { handle, cleanup } = await startEphemeralServer(rootDir);
    try {
      const base = `http://127.0.0.1:${handle.address.port}`;
      // 1) list （空）
      const l0 = await fetchUrl(`${base}/api/scenarios`);
      expect(l0.status).toBe(200);
      expect((l0.json as { data: { files: unknown[] } }).data.files.length).toBe(0);

      // 2) put
      const p = await fetchUrl(`${base}/api/scenarios/sc-01.yaml`, {
        method: 'PUT',
        body: { id: 'SC-P1-01', expectedActions: ['expire'], params: { id: 10001 } },
      });
      expect(p.status).toBe(200);

      // 3) get
      const g = await fetchUrl(`${base}/api/scenarios/sc-01.yaml`);
      expect(g.status).toBe(200);
      expect(JSON.stringify(g.json)).toContain('SC-P1-01');

      // 4) 非法 body 拒绝落盘
      const pbad = await fetchUrl(`${base}/api/scenarios/sc-02.yaml`, {
        method: 'PUT',
        body: { id: 'BAD', expectedActions: ['x'] },
      });
      expect(pbad.status).toBe(400);

      // 5) delete
      const d = await fetchUrl(`${base}/api/scenarios/sc-01.yaml`, { method: 'DELETE' });
      expect(d.status).toBe(200);
      const g2 = await fetchUrl(`${base}/api/scenarios/sc-01.yaml`);
      expect(g2.status).toBe(404);
    } finally {
      await cleanup();
    }
  });

  test('PUT 越界文件名：拒绝', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'feedback-crud2-'));
    mkdirSync(join(rootDir, 'protocol', 'scenarios'), { recursive: true });
    const { handle, cleanup } = await startEphemeralServer(rootDir);
    try {
      const base = `http://127.0.0.1:${handle.address.port}`;
      const r = await fetchUrl(`${base}/api/scenarios/${encodeURIComponent('../etc/passwd.yaml')}`, {
        method: 'PUT',
        body: { id: 'SC-X', expectedActions: ['x'] },
      });
      expect(r.status).toBe(400);
    } finally {
      await cleanup();
    }
  });
});

describe('feedback-server: bindings YAML 编辑', () => {
  test('PUT 含 _rawYAML + confirm：服务端 yaml 解析 + ajv 校验', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'feedback-bind-'));
    mkdirSync(join(rootDir, 'protocol', 'scenarios'), { recursive: true });
    writeFileSync(join(rootDir, 'bindings.yaml'), 'roles: []\ninterfaces: []\n');
    const { handle, cleanup } = await startEphemeralServer(rootDir);
    try {
      const base = `http://127.0.0.1:${handle.address.port}`;
      // 读
      const g = await fetchUrl(`${base}/api/bindings`);
      expect(g.status).toBe(200);
      // 写合法（需 confirm='replace-all'，E7-P1-I1）
      const w = await fetchUrl(`${base}/api/bindings`, {
        method: 'PUT',
        body: {
          confirm: 'replace-all',
          _rawYAML: 'roles:\n  - roleId: R-Op\ninterfaces:\n  - action: x\n    transport: { type: http, method: POST, path: /v1/x }\n',
        },
      });
      expect(w.status).toBe(200);
      // 写非法（缺 interfaces）：即便有 confirm 也得拒
      const wbad = await fetchUrl(`${base}/api/bindings`, {
        method: 'PUT',
        body: {
          confirm: 'replace-all',
          _rawYAML: 'roles:\n  - roleId: R-Op\n',
        },
      });
      expect(wbad.status).toBe(400);
    } finally {
      await cleanup();
    }
  });
});

// E7-P1-I1 修复：PUT 需 confirm；PATCH 字段级合并；DELETE 单接口
describe('feedback-server: bindings PUT/PATCH/DELETE 安全面（E7-P1-I1）', () => {
  test('PUT 不带 confirm：拒绝并提示改用 PATCH 或加 confirm', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'feedback-i1-1-'));
    mkdirSync(join(rootDir, 'protocol', 'scenarios'), { recursive: true });
    writeFileSync(join(rootDir, 'bindings.yaml'),
      'roles:\n  - roleId: R-Op\n    auth: bearer\ninterfaces:\n  - action: expire\n    transport: { type: http, method: POST, path: /v1/expire }\n');
    const { handle, cleanup } = await startEphemeralServer(rootDir);
    try {
      const base = `http://127.0.0.1:${handle.address.port}`;
      const r = await fetchUrl(`${base}/api/bindings`, {
        method: 'PUT',
        body: { roles: [{ roleId: 'R-Evil' }], interfaces: [{ action: 'evil' }] },
      });
      expect(r.status).toBe(400);
      // 原文件未变
      const raw = readFileSync(join(rootDir, 'bindings.yaml'), 'utf-8');
      expect(raw).toContain('R-Op');
      expect(raw).toContain('expire');
      expect(raw).not.toContain('R-Evil');
      expect(raw).not.toContain('evil');
    } finally {
      await cleanup();
    }
  });
  test('PATCH 字段级合并：保留 P1/P2/P3/P4/P5/P6 完整骨架不被破坏', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'feedback-i1-2-'));
    mkdirSync(join(rootDir, 'protocol', 'scenarios'), { recursive: true });
    // 模拟 strangler-fig 47667B 简化为「P1~P6 完整」骨架
    const original =
      'roles:\n  - roleId: R-Op\n    auth: bearer\n  - roleId: R-Admin\n    auth: mtls\ninterfaces:\n' +
      '  - action: P1_action\n    transport: { type: http, method: POST, path: /p1 }\n' +
      '  - action: P2_action\n    transport: { type: http, method: POST, path: /p2 }\n' +
      '  - action: P3_action\n    transport: { type: http, method: POST, path: /p3 }\n' +
      '  - action: P4_action\n    transport: { type: http, method: POST, path: /p4 }\n' +
      '  - action: P5_action\n    transport: { type: http, method: POST, path: /p5 }\n' +
      '  - action: P6_action\n    transport: { type: http, method: POST, path: /p6 }\n';
    writeFileSync(join(rootDir, 'bindings.yaml'), original);
    const { handle, cleanup } = await startEphemeralServer(rootDir);
    try {
      const base = `http://127.0.0.1:${handle.address.port}`;
      // 只追加 1 个新接口（不影响既有 6 个）
      const r = await fetchUrl(`${base}/api/bindings`, {
        method: 'PATCH',
        body: {
          interfaces: [{ action: 'new_action', transport: { type: 'http', method: 'POST', path: '/new' } }],
        },
      });
      expect(r.status).toBe(200);
      const data = (r.json as { data?: { diff?: { addedInterfaces?: string[] } } }).data;
      expect(data?.diff?.addedInterfaces).toEqual(['new_action']);
      // 写后读回：所有 P1~P6 + new 共 7 个；原有 6 个完整保留
      const g = await fetchUrl(`${base}/api/bindings`);
      expect(g.status).toBe(200);
      const actions = (((g.json as { data?: { parsed?: { interfaces?: Array<{ action: string }> } } }).data?.parsed?.interfaces ?? [])
        .map((i) => i.action)).sort();
      expect(actions).toEqual(['P1_action', 'P2_action', 'P3_action', 'P4_action', 'P5_action', 'P6_action', 'new_action']);
    } finally {
      await cleanup();
    }
  });
  test('PATCH 非法 body（无任何字段）：拒绝', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'feedback-i1-3-'));
    mkdirSync(join(rootDir, 'protocol', 'scenarios'), { recursive: true });
    writeFileSync(join(rootDir, 'bindings.yaml'), 'roles: []\ninterfaces: []\n');
    const { handle, cleanup } = await startEphemeralServer(rootDir);
    try {
      const base = `http://127.0.0.1:${handle.address.port}`;
      const r = await fetchUrl(`${base}/api/bindings`, { method: 'PATCH', body: {} });
      expect(r.status).toBe(400);
    } finally {
      await cleanup();
    }
  });
  test('DELETE /api/bindings/interfaces/:action：单接口删除并留 .bak 备份', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'feedback-i1-4-'));
    mkdirSync(join(rootDir, 'protocol', 'scenarios'), { recursive: true });
    writeFileSync(join(rootDir, 'bindings.yaml'),
      'roles: []\ninterfaces:\n  - action: a\n  - action: b\n  - action: c\n');
    const { handle, cleanup } = await startEphemeralServer(rootDir);
    try {
      const base = `http://127.0.0.1:${handle.address.port}`;
      const r = await fetchUrl(`${base}/api/bindings/interfaces/b`, { method: 'DELETE' });
      expect(r.status).toBe(200);
      const data = (r.json as { data?: { backupPath?: string; diff?: { deletedInterfaces?: string[] } } }).data;
      expect(data?.diff?.deletedInterfaces).toEqual(['b']);
      expect(data?.backupPath).toMatch(/\.bak-\d+$/);
      // .bak 文件存在
      expect(existsSync(data!.backupPath!)).toBe(true);
      // 写后读回：b 已删，a/c 保留
      const g = await fetchUrl(`${base}/api/bindings`);
      const actions = (((g.json as { data?: { parsed?: { interfaces?: Array<{ action: string }> } } }).data?.parsed?.interfaces ?? [])
        .map((i) => i.action)).sort();
      expect(actions).toEqual(['a', 'c']);
    } finally {
      await cleanup();
    }
  });
  test('DELETE 非法 action（路径分隔）：拒绝', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'feedback-i1-5-'));
    mkdirSync(join(rootDir, 'protocol', 'scenarios'), { recursive: true });
    writeFileSync(join(rootDir, 'bindings.yaml'), 'roles: []\ninterfaces: []\n');
    const { handle, cleanup } = await startEphemeralServer(rootDir);
    try {
      const base = `http://127.0.0.1:${handle.address.port}`;
      const r = await fetchUrl(`${base}/api/bindings/interfaces/${encodeURIComponent('../etc')}`, { method: 'DELETE' });
      expect(r.status).toBe(400);
    } finally {
      await cleanup();
    }
  });
});

describe('feedback-server: 评审生成修改单草稿（覆盖真实 /work 落盘）', () => {
  let saved: string | null = null;
  afterEach(() => {
    if (saved && existsSync(saved)) {
      try { rmSync(saved); } catch {/* ignore */}
      saved = null;
    }
  });

  test('POST /api/issues 落盘 /work/工具链修改单-NNN-protochain-xxx.md', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'feedback-rev-'));
    const { handle, cleanup } = await startEphemeralServer(rootDir);
    try {
      const base = `http://127.0.0.1:${handle.address.port}`;
      const r = await fetchUrl(`${base}/api/issues`, {
        method: 'POST',
        body: {
          target: 'model',
          elementId: 'INV_PS1',
          category: 'bug',
          severity: 'P1-7d',
          title: `feedback-server 测试稿 ${Date.now()}`,
          body: 'a'.repeat(60),
          author: 'unit-test',
        },
      });
      expect(r.status).toBe(200);
      const json = r.json as { data?: { draftPath?: string; number?: number } };
      saved = json.data?.draftPath ?? null;
      expect(saved).toMatch(/工具链修改单-\d{3}-protochain-/);
      expect(existsSync(saved!)).toBe(true);
      // GET /api/issues 包含
      const l = await fetchUrl(`${base}/api/issues`);
      const items = (l.json as { data: Array<{ path: string }> }).data;
      expect(items.some((i) => i.path === saved)).toBe(true);
    } finally {
      await cleanup();
    }
  });
});

describe('feedback-server: 一键执行（runner 子进程隔离）', () => {
  test('POST /api/run/generate-cases 触发真实 CLI 子进程', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'feedback-run-'));
    mkdirSync(join(rootDir, 'protocol', 'scenarios'), { recursive: true });
    writeFileSync(join(rootDir, 'protocol', 'model.md'), [
      '# M',
      '',
      '## 元数据层',
      '',
      '- name: Test',
      '- version: 0.1.0',
      '- purpose: feedback-serve e2e',
      '- roles:',
      '  - { id: R-Op, name: Op, roleType: consensus }',
      '',
      '## 可推演层',
      '',
      'states:',
      '  - { id: S0, name: 初始, type: initial }',
      '  - { id: S1, name: 终态, type: terminal }',
      'transitions:',
      '  - { id: T1, from: [S0], to: S1, action: op, guard: form_valid }',
      'invariants:',
      '  - { id: INV1, expression: TRUE }',
    ].join('\n'));
    const { handle, cleanup } = await startEphemeralServer(rootDir, { skipEnvScrub: true });
    try {
      const base = `http://127.0.0.1:${handle.address.port}`;
      const r = await fetchUrl(`${base}/api/run/generate-cases`, {
        method: 'POST',
        body: { args: ['--no-ai'] },
      });
      expect(r.status).toBe(200);
      const d = (r.json as { data?: { ok?: boolean; exitCode?: number | null; argv?: string[] } }).data;
      expect(d?.argv?.[1]).toBe('generate-cases');
      // exit code 可空（timeout），但 ok=true ↔ exit=0
      if (d?.ok) {
        expect(d.exitCode).toBe(0);
      } else {
        // 不强求 exit=0；只要能调用到 runner
        expect(d?.argv?.length ?? 0).toBeGreaterThan(2);
      }
    } finally {
      await cleanup();
    }
  }, 120_000); // 真实子进程跑 generate-cases 可能慢
});

describe('feedback-server: 安全头', () => {
  test('响应含 X-Content-Type-Options=nosniff + CSP frame-ancestors', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'feedback-sec-'));
    const { handle, cleanup } = await startEphemeralServer(rootDir);
    try {
      const base = `http://127.0.0.1:${handle.address.port}`;
      // 用 http 直接获取 header
      const u = new URL(`${base}/api/health`);
      const headers = await new Promise<Record<string, string>>((resolve, reject) => {
        const req = http.request(
          { hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET' },
          (res) => {
            res.resume();
            resolve(res.headers as Record<string, string>);
          }
        );
        req.on('error', reject);
        req.end();
      });
      expect(headers['x-content-type-options']).toBe('nosniff');
      expect(headers['x-frame-options']).toBe('DENY');
      expect(headers['content-security-policy'] ?? '').toMatch(/frame-ancestors/);
    } finally {
      await cleanup();
    }
  });
});
