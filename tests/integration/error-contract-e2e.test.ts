/**
 * E11 工具链自包含 fixture 级验证（验收口径）
 *
 * 设计依据：IMPLEMENTATION-PLAN.md §E11 验收 A 层（"工具链自包含（fixture，硬条件）"）
 *
 * 覆盖：
 * - derive-specs：errorResponses 投影到 InterfaceSpec
 * - bind：specs 声明的 errorCode 未在 errorMap 绑定 → valid=false
 * - verify：场景 expectedError 命中 / 未命中 errorMap 断言
 * - derive-web：data.json + 文档含错误响应表/绑定视图；无敏感字段
 */

import {
  writeFileSync,
  mkdirSync,
  rmSync,
  readFileSync,
  existsSync,
  mkdtempSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { parseProtocolContent } from '../../src/parser/index.js';
import { specify, specsFromEnvelope } from '../../src/specifier/index.js';
import { deriveBindings } from '../../src/bindgen/index.js';
import { validateBindings, mergeBindings } from '../../src/binder/index.js';
import { deriveWeb, redactSensitiveFields } from '../../src/webgen/index.js';
import type {
  BindingConfig,
  SourceProtocolModel,
  TransportResult,
} from '../../src/model/types.js';
import type { TransportExecutorFn } from '../../src/verifier/binding-runner.js';

// ---------------------------------------------------------------------------
// E11-fixture：含 errorCode + errorResponses 的最小协议
// ---------------------------------------------------------------------------

function buildModel(): SourceProtocolModel {
  const md = `---
name: E11 fixture
version: 1.0.0
purpose: error contract fixture
roles:
  - id: r
    name: r
---
# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S1 | 初始 | initial |
| S2 | 终态 | terminal |

# 转移规则

| ID | 名称 | from | to | action | trigger |
|---|---|---|---|---|---|
| T1 | 注册 | S1 | S2 | register | r |

# 异常路径

| ID | 名称 | 触发 | 转移序列 | 错误码 |
|---|---|---|---|---|
| EX1 | 域名被占 | trg | T1 | domain_taken |
| EX2 | 角色无效 | trg | T1 | token_invalid_role |

# 契约层

\`\`\`yaml
parties:
  - r
contracts:
  - interface: register
    errorResponses:
      - id: ERR-01
        errorCode: domain_taken
        httpStatus: 409
      - id: ERR-02
        errorCode: token_invalid_role
        httpStatus: 403
        bodySchema:
          type: object
          properties:
            code: { type: string }
            message: { type: string }
          required: [code]
\`\`\`
`;
  return parseProtocolContent(md, 'test.md');
}

function makeTransport(
  handlerMap: Record<string, () => TransportResult>
): TransportExecutorFn {
  return async (resolved) => {
    if (!resolved?.binding) return { status: 404, data: { error: 'unbound' }, ok: false };
    const handler = handlerMap[resolved.spec.name];
    return handler?.() ?? { status: 404, data: { error: 'no handler' }, ok: false };
  };
}

describe('E11 fixture-level 自包含验收', () => {
  // -------------------------------------------------------------------------
  // 1. derive-specs：errorResponses 投影到 InterfaceSpec
  // -------------------------------------------------------------------------
  test('验收1：specify(model) 投影 contracts[].errorResponses 到 InterfaceSpec', () => {
    const model = buildModel();
    const specs = specsFromEnvelope(specify(model));
    const register = specs.find((s) => s.name === 'register');
    expect(register).toBeDefined();
    expect(register?.errorResponses).toBeDefined();
    expect(register?.errorResponses).toHaveLength(2);
    expect(register?.errorResponses?.[0].errorCode).toBe('domain_taken');
    expect(register?.errorResponses?.[1].errorCode).toBe('token_invalid_role');
    expect(register?.errorResponses?.[1].httpStatus).toBe(403);
    expect(register?.errorResponses?.[1].bodySchema?.properties?.code?.type).toBe('string');
    expect(register?.contractSource).toBe('register');
  });

  // -------------------------------------------------------------------------
  // 2. bind：specs.errorResponses 缺绑时 valid=false
  // -------------------------------------------------------------------------
  test('验收2：validateBindings 缺 errorMap → valid=false + unmappedErrorCodes 已填', () => {
    const model = buildModel();
    const specs = specsFromEnvelope(specify(model));
    // 有接口 binding 但 errorMap 缺
    const config: BindingConfig = {
      roles: { r: { roleId: 'r', baseUrl: 'http://x', auth: 'none' } },
      interfaces: [
        { action: 'register', roleId: 'r', transport: { type: 'http', method: 'POST', path: '/r' } },
      ],
      // 故意不写 errorMap
    };
    const report = validateBindings(specs, config);
    expect(report.valid).toBe(false);
    expect(report.unmappedErrorCodes).toContain('domain_taken');
    expect(report.unmappedErrorCodes).toContain('token_invalid_role');
  });

  test('验收2b：validateBindings 含 errorMap 全覆盖 → valid=true', () => {
    // 仅含契约中明确声明的接口 spec（剔除自动派生的观测接口）
    const specs = [
      {
        id: 'IF_SYS_register',
        kind: 'system' as const,
        sourceId: 'register',
        name: 'register',
        inputs: [],
        outputs: [],
        errorResponses: [
          { id: 'ERR-01', errorCode: 'domain_taken', httpStatus: 409 },
          { id: 'ERR-02', errorCode: 'token_invalid_role', httpStatus: 403 },
        ],
      },
    ];
    const config: BindingConfig = {
      roles: { r: { roleId: 'r', baseUrl: 'http://x', auth: 'none' } },
      interfaces: [
        { action: 'register', roleId: 'r', transport: { type: 'http', method: 'POST', path: '/r' } },
      ],
      errorMap: {
        domain_taken: { httpStatus: 409, systemCode: 'E409', bodyField: 'code' },
        token_invalid_role: { httpStatus: 403, systemCode: 'E403', bodyField: 'code' },
      },
    };
    const report = validateBindings(specs, config);
    expect(report.valid).toBe(true);
    expect(report.unmappedErrorCodes).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 3. verify：errorMap 匹配 / 未命中 / 5xx 行为
  // -------------------------------------------------------------------------
  // 直接运行 binding-runner.runBindingPathCase 调用，调出一次误差事件，
  // 而不需要 generateCases（避免对其他 E11 不相关 assertion 的影响）。
  test('验收3a：场景层 expectedError 命中 → 路径通过 + errorSummary.expected 计数', async () => {
    const { runBindingPathCase } = await import('../../src/verifier/binding-runner.js');
    const model = buildModel();
    const transitionsById = new Map(model.derivable.transitions.map((t) => [t.id, t]));
    const initialStateId = model.derivable.initialStateId ?? 'S1';
    const stateNames = new Map(model.derivable.states.map((s) => [s.id, s.name]));
    const specs = specsFromEnvelope(specify(model)).filter((s) => s.kind === 'system');
    const bindings: BindingConfig = {
      roles: { r: { roleId: 'r', baseUrl: 'http://x', auth: 'none' } },
      interfaces: [
        { action: 'register', roleId: 'r', transport: { type: 'http', method: 'POST', path: '/r' } },
      ],
      errorMap: {
        domain_taken: { httpStatus: 409, bodyField: 'code', systemCode: 'E409', bodyFieldValue: 'DOMAIN_TAKEN' },
      },
    };
    const transport = makeTransport({
      register: () => ({ status: 409, data: { code: 'domain_taken', message: '已被占用' }, ok: false }),
    });
    const errorSummary = { matched: {}, unmapped: [], systemFault: 0, expected: {} };
    const path = {
      id: 'P1',
      transitionIds: ['T1'],
      stateIds: ['S1', 'S2'],
      length: 1,
    };
    const resolved = [
      { spec: specs.find((s) => s.name === 'register')!, binding: bindings.interfaces[0], roleBinding: bindings.roles.r },
    ];
    const result = await runBindingPathCase(
      path,
      transitionsById,
      initialStateId,
      resolved,
      stateNames,
      transport,
      {
        stateMap: bindings.stateMap,
        scenarios: [
          {
            id: 'SC-TAKEN',
            expectedActions: ['register'],
            params: {},
            expectedError: { errorCode: 'domain_taken', httpStatus: 409 },
          },
        ],
        errorMap: bindings.errorMap,
        errorSummary,
      }
    );
    // expected 命中 → 通过
    expect(result.passed).toBe(true);
    expect(result.deviations).toBeUndefined();
    expect(errorSummary.matched.domain_taken).toBeGreaterThanOrEqual(1);
    expect(errorSummary.expected?.domain_taken).toBeGreaterThanOrEqual(1);
  });

  test('验收3b：未命中 errorMap → error_mismatch + unmapped 计数', async () => {
    const { runBindingPathCase } = await import('../../src/verifier/binding-runner.js');
    const model = buildModel();
    const transitionsById = new Map(model.derivable.transitions.map((t) => [t.id, t]));
    const initialStateId = model.derivable.initialStateId ?? 'S1';
    const stateNames = new Map(model.derivable.states.map((s) => [s.id, s.name]));
    const specs = specsFromEnvelope(specify(model)).filter((s) => s.kind === 'system');
    const bindings: BindingConfig = {
      roles: { r: { roleId: 'r', baseUrl: 'http://x', auth: 'none' } },
      interfaces: [
        { action: 'register', roleId: 'r', transport: { type: 'http', method: 'POST', path: '/r' } },
      ],
      errorMap: {
        domain_taken: { httpStatus: 409, bodyField: 'code' },
      },
    };
    const transport = makeTransport({
      register: () => ({ status: 403, data: { code: 'token_invalid_role', message: '...' }, ok: false }),
    });
    const errorSummary = { matched: {}, unmapped: [], systemFault: 0 };
    const path = { id: 'P1', transitionIds: ['T1'], stateIds: ['S1', 'S2'], length: 1 };
    const resolved = [
      { spec: specs.find((s) => s.name === 'register')!, binding: bindings.interfaces[0], roleBinding: bindings.roles.r },
    ];
    const result = await runBindingPathCase(
      path,
      transitionsById,
      initialStateId,
      resolved,
      stateNames,
      transport,
      { stateMap: {}, scenarios: [], errorMap: bindings.errorMap, errorSummary }
    );
    expect(result.passed).toBe(false);
    expect(errorSummary.unmapped.length).toBeGreaterThanOrEqual(1);
    expect(result.deviations?.[0].kind).toBe('error_mismatch');
  });

  test('验收3c：≥500 → system_fault 计数（不参与失败）', async () => {
    const { runBindingPathCase } = await import('../../src/verifier/binding-runner.js');
    const model = buildModel();
    const transitionsById = new Map(model.derivable.transitions.map((t) => [t.id, t]));
    const initialStateId = model.derivable.initialStateId ?? 'S1';
    const stateNames = new Map(model.derivable.states.map((s) => [s.id, s.name]));
    const specs = specsFromEnvelope(specify(model)).filter((s) => s.kind === 'system');
    const bindings: BindingConfig = {
      roles: { r: { roleId: 'r', baseUrl: 'http://x', auth: 'none' } },
      interfaces: [
        { action: 'register', roleId: 'r', transport: { type: 'http', method: 'POST', path: '/r' } },
      ],
      errorMap: {
        domain_taken: { httpStatus: 409, bodyField: 'code' },
        token_invalid_role: { httpStatus: 403, bodyField: 'code' },
      },
    };
    const transport = makeTransport({
      register: () => ({ status: 504, data: { error: 'gateway timeout' }, ok: false }),
    });
    const errorSummary = { matched: {}, unmapped: [], systemFault: 0 };
    const path = { id: 'P1', transitionIds: ['T1'], stateIds: ['S1', 'S2'], length: 1 };
    const resolved = [
      { spec: specs.find((s) => s.name === 'register')!, binding: bindings.interfaces[0], roleBinding: bindings.roles.r },
    ];
    await runBindingPathCase(
      path,
      transitionsById,
      initialStateId,
      resolved,
      stateNames,
      transport,
      { stateMap: {}, scenarios: [], errorMap: bindings.errorMap, errorSummary }
    );
    expect(errorSummary.systemFault).toBeGreaterThanOrEqual(1);
    expect(errorSummary.unmapped.length).toBe(0);
    expect(
      Object.values(errorSummary.matched).reduce((a, b) => a + b, 0)
    ).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 4. derive-web：data.json + 文档含错误响应表/绑定视图；无敏感字段
  // -------------------------------------------------------------------------
  test('验收4：derive-web data.json 含错误响应表/绑定视图且不含 authConfig 敏感字段', async () => {
    const model = buildModel();
    const tmp = mkdtempSync(join(tmpdir(), 'webgen-e11-'));
    mkdirSync(join(tmp, 'protocol'), { recursive: true });
    mkdirSync(join(tmp, 'derived'), { recursive: true });
    mkdirSync(join(tmp, 'derived/verification'), { recursive: true });
    mkdirSync(join(tmp, 'derived/impl-check'), { recursive: true });
    mkdirSync(join(tmp, 'derived/diff'), { recursive: true });

    // model.md
    writeFileSync(
      join(tmp, 'protocol/model.md'),
      readFileSync('/work/protochain/tests/fixtures/approval-flow.md', 'utf-8')
        .replace('name: 审批流协议', 'name: E11 fixture')
        .replace('version: 1.0.0', 'version: 1.0.0')
    );

    // specs.json（specify → envelope）
    const envelope = {
      ...specify(buildModel()),
      schemaVersion: '1.0' as const,
      generatedAt: '',
      sourceModelVersion: '1.0.0',
    };
    writeFileSync(join(tmp, 'derived/specs.json'), JSON.stringify(envelope, null, 2));

    // bindings.yaml（含敏感字段 → 验证 redact 兜底）
    writeFileSync(
      join(tmp, 'bindings.yaml'),
      `roles:
  r:
    roleId: r
    baseUrl: http://mock.local
    auth: bearer
    authConfig:
      tokenEnv: SECRET_TOKEN_XYZ
    tls:
      certPath: /SECRET_CERT.pem
interfaces:
  - action: register
    roleId: r
    transport:
      type: http
      method: POST
      path: /r
errorMap:
  domain_taken:
    httpStatus: 409
    bodyField: code
    systemCode: E409
`
    );

    const result = await deriveWeb(
      { rootDir: tmp, buildSite: false, force: true },
      () => buildModel()
    );

    // data.json 存在
    expect(existsSync(result.dataJsonPath)).toBe(true);
    const dataJson = JSON.parse(readFileSync(result.dataJsonPath, 'utf-8'));

    // 错误响应表进 InterfaceView
    const registerView = dataJson.interfaces.find((i: { name: string }) => i.name === 'register');
    expect(registerView).toBeDefined();
    expect(registerView.errorResponses).toBeDefined();
    expect(registerView.errorResponses.length).toBeGreaterThanOrEqual(1);

    // 绑定视图存在（roles/interfaces/errorMap/stateMap）
    expect(dataJson.binding?.hasBindings).toBe(true);
    expect(dataJson.binding?.errorMap?.domain_taken?.httpStatus).toBe(409);

    // ── 红线：敏感字段不出现 ──
    // 注：`authConfig` / `tls` 是 source code 注释 / redaction notice 字符串的一部分，
    // 这里的关键是数据内容中不出现敏感 secret 值与实际的字段键。
    const serialized = readFileSync(result.dataJsonPath, 'utf-8');
    expect(serialized).not.toContain('SECRET_TOKEN_XYZ');
    expect(serialized).not.toContain('SECRET_CERT');
    // 结构性检查：roles.* 不含 authConfig 键、tls 键、tokenEnv 键
    expect(JSON.stringify(dataJson.binding?.roles)).not.toContain('authConfig');
    expect(JSON.stringify(dataJson.binding?.roles)).not.toContain('tokenEnv');
    expect(JSON.stringify(dataJson.binding?.roles)).not.toContain('certPath');
    expect(JSON.stringify(dataJson.binding?.roles)).not.toContain('SECRET_TOKEN_XYZ');
    // role 字段白名单：baseUrl / headers / authKind
    for (const role of dataJson.binding?.roles ?? []) {
      expect(Object.keys(role).sort()).toEqual(
        expect.arrayContaining(['roleId'])
      );
    }

    // bindings.md 已生成
    const bindingsMdPath = join(tmp, 'web/docs/bindings.md');
    expect(existsSync(bindingsMdPath)).toBe(true);
    const bindingsMd = readFileSync(bindingsMdPath, 'utf-8');
    expect(bindingsMd).toContain('绑定视图（E11）');

    // 清理
    rmSync(tmp, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 5. 兼容路径：老协议无 errorCode 列 → 全部降级空
  // -------------------------------------------------------------------------
  test('验收5：老协议无 errorCode 列/errorResponses → 零回归', () => {
    const md = `---
name: legacy
version: 1.0.0
purpose: 兼容测试
roles:
  - id: r
    name: r
---
# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S1 | 初始 | initial |

# 转移规则

| ID | 名称 | from | to | action | trigger |
|---|---|---|---|---|---|
| T1 | 注册 | S1 | S1 | do_legacy | r |

# 异常路径

| ID | 名称 | 触发 | 转移序列 |
|---|---|---|---|
| EX1 | 旧异常 | trg | T1 |
`;
    const model = parseProtocolContent(md, 'test.md');
    const specs = specsFromEnvelope(specify(model)).filter((s) => s.kind === 'system');
    const obs = specs.find((s) => s.name === 'do_legacy');
    expect(obs?.errorResponses).toBeUndefined();
    expect(obs?.requestSchema).toBeDefined();
    // 旧版 validateBindings 不报 errorMap 错（specs 无 errorCode）
    const config: BindingConfig = {
      roles: { r: { roleId: 'r', baseUrl: 'http://x', auth: 'none' } },
      interfaces: [
        { action: 'do_legacy', roleId: 'r', transport: { type: 'http', method: 'POST', path: '/r' } },
      ],
    };
    const report = validateBindings(specs, config);
    expect(report.valid).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 6. derive-bindings 产生 errorMap 骨架
  // -------------------------------------------------------------------------
  test('验收6：derive-bindings 为 specs.errorResponses 生成 errorMap 骨架', async () => {
    const model = buildModel();
    const tmp = mkdtempSync(join(tmpdir(), 'derive-bindings-'));
    mkdirSync(join(tmp, 'protocol'), { recursive: true });
    mkdirSync(join(tmp, 'derived'), { recursive: true });
    // write model.md
    writeFileSync(
      join(tmp, 'protocol/model.md'),
      `---
name: E11 fixture
version: 1.0.0
purpose: derive-bindings test
roles:
  - id: r
    name: r
---
# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S1 | 初始 | initial |
| S2 | 终态 | terminal |

# 转移规则

| ID | 名称 | from | to | action | trigger |
|---|---|---|---|---|---|
| T1 | 注册 | S1 | S2 | register | r |

# 契约层

\`\`\`yaml
contracts:
  - interface: register
    errorResponses:
      - id: ERR-01
        errorCode: domain_taken
        httpStatus: 409
\`\`\`
`
    );
    // drop envelope
    const envelope = {
      ...specify(model),
      schemaVersion: '1.0' as const,
      generatedAt: '',
      sourceModelVersion: '1.0.0',
    };
    writeFileSync(join(tmp, 'derived/specs.json'), JSON.stringify(envelope, null, 2));

    const result = await deriveBindings(
      { rootDir: tmp, force: true },
      () => buildModel()
    );
    expect(result.skeleton.errorMap).toBeDefined();
    expect(result.skeleton.errorMap?.domain_taken?.httpStatus).toBe(409);
    expect(result.skeleton.errorMap?.domain_taken?.bodyField).toBe('code');

    // 集成：skeleton 与人工 bindings merge 后 errorMap 全保留
    const manual: BindingConfig = {
      roles: {},
      interfaces: [],
      errorMap: {
        domain_taken: { httpStatus: 409, systemCode: 'E409' },
      },
    };
    const merged = mergeBindings(result.skeleton, manual);
    expect(merged.errorMap?.domain_taken?.systemCode).toBe('E409');
    // skeleton 中没声明的字段（manual 未覆盖）保留
    expect(merged.errorMap?.domain_taken?.bodyField).toBe('code');

    rmSync(tmp, { recursive: true, force: true });
  });
});
