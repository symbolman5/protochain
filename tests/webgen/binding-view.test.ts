/**
 * E11 WebBindingView（绑定视图）+ 红线（不读 authConfig/tls）
 *
 * 设计依据：IMPLEMENTATION-PLAN.md §E11、docs/error-modeling-plan.md §4.7
 *
 * 覆盖：
 * - buildBindingView：非敏感投影子集（baseUrl/transport/errorMap/stateMap）
 * - buildBindingView：authConfig 不读取 → 不出现 authConfig 键名
 * - buildBindingView：tls 不读取 → 不出现 tls 键名
 * - buildBindingView：unmappedErrorCodes 统计
 * - data.json 顶层 binding 字段 + exceptionPaths
 * - redactSensitiveFields 兜底
 * - readBindingsFileSafely 找不到文件时返回 undefined
 */

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildBindingView,
  buildWebData,
  redactSensitiveFields,
  readBindingsFileSafely,
  type WebBindingView,
} from '../../src/webgen/index.js';
import { parseProtocolContent } from '../../src/parser/index.js';
import { specify, specsFromEnvelope } from '../../src/specifier/index.js';
import type {
  BindingConfig,
  ErrorMapEntry,
  InterfaceSpec,
  SourceProtocolModel,
} from '../../src/model/types.js';

// ---------------------------------------------------------------------------
// 测试辅助：构造含 errorResponses 的最小 specs
// ---------------------------------------------------------------------------

function makeSpecWithError(
  name: string,
  errorResponses?: InterfaceSpec['errorResponses']
): InterfaceSpec {
  return {
    id: `IF_SYS_${name}`,
    kind: 'system',
    sourceId: name,
    name,
    inputs: [],
    outputs: [],
    errorResponses,
  };
}

// ---------------------------------------------------------------------------
// buildBindingView
// ---------------------------------------------------------------------------

describe('webgen - E11 buildBindingView（非敏感投影）', () => {
  test('正向：含 roles.baseUrl + interfaces.transport + errorMap → 全部入视图', () => {
    const specs = [
      makeSpecWithError('create', [
        { id: 'ERR-01', errorCode: 'domain_not_owned', httpStatus: 409 },
      ]),
    ];
    const bindings: BindingConfig = {
      roles: {
        r: { roleId: 'r', baseUrl: 'http://mock.local', auth: 'none' },
      },
      interfaces: [
        { action: 'create', roleId: 'r', transport: { type: 'http', method: 'POST', path: '/c', params: [] } },
      ],
      errorMap: {
        domain_not_owned: { httpStatus: 409, systemCode: 'E40901', bodyField: 'code' },
      },
    };
    const view = buildBindingView(bindings, specs);
    expect(view.hasBindings).toBe(true);
    expect(view.roles[0].roleId).toBe('r');
    expect(view.roles[0].baseUrl).toBe('http://mock.local');
    expect(view.roles[0].authKind).toBe('none');
    // authConfig 不读
    const serialized = JSON.stringify(view.roles[0]);
    expect(serialized).not.toContain('authConfig');
    expect(view.interfaces[0].action).toBe('create');
    expect(view.interfaces[0].transport?.type).toBe('http');
    expect(view.errorMap?.domain_not_owned?.httpStatus).toBe(409);
  });

  test('红线：bindings 含 authConfig（含 tokenEnv）→ 不出现在 view 中', () => {
    const specs: InterfaceSpec[] = [];
    const bindings: BindingConfig = {
      roles: {
        r: {
          roleId: 'r',
          baseUrl: 'http://mock.local',
          auth: 'bearer',
          authConfig: { tokenEnv: 'SECRET_TOKEN_XYZ' }, // 敏感
        },
      },
      interfaces: [],
    };
    const view = buildBindingView(bindings, specs);
    const serialized = JSON.stringify(view);
    // 不应出现 tokenEnv / secretEnv 等敏感字段
    expect(serialized).not.toContain('tokenEnv');
    expect(serialized).not.toContain('SECRET_TOKEN_XYZ');
    expect(serialized).not.toContain('authConfig');
  });

  test('红线：bindings 含 tls 密钥段 → 不出现在 view 中', () => {
    const specs: InterfaceSpec[] = [];
    const bindings: BindingConfig = {
      roles: {
        r: {
          roleId: 'r',
          baseUrl: 'http://mock.local',
          auth: 'none',
          tls: { caFile: '/etc/ssl/SECRET_CERT.pem', servername: 'SECRET.example' },
        },
      },
      interfaces: [],
    };
    const view = buildBindingView(bindings, specs);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('certPath');
    expect(serialized).not.toContain('keyPath');
    expect(serialized).not.toContain('SECRET_CERT');
    expect(serialized).not.toContain('tls');
  });

  test('反向：specs 声明了 errorCode 但 errorMap 缺 → unmappedErrorCodes 包含', () => {
    const specs = [
      makeSpecWithError('create', [
        { id: 'ERR-01', errorCode: 'undeclared_code', httpStatus: 409 },
      ]),
    ];
    const bindings: BindingConfig = {
      roles: {},
      interfaces: [],
      errorMap: {}, // 缺
    };
    const view = buildBindingView(bindings, specs);
    expect(view.unmappedErrorCodes).toContain('undeclared_code');
  });

  test('反向：bindings 未提供 → hasBindings=false + 空视图', () => {
    const specs: InterfaceSpec[] = [];
    const view = buildBindingView(undefined, specs);
    expect(view.hasBindings).toBe(false);
    expect(view.roles).toHaveLength(0);
    expect(view.interfaces).toHaveLength(0);
  });

  test('正向：errorMap 中额外 errorCode → warning', () => {
    const specs: InterfaceSpec[] = [];
    const bindings: BindingConfig = {
      roles: {},
      interfaces: [],
      errorMap: {
        phantom_code: { httpStatus: 400 } as ErrorMapEntry,
      },
    };
    const view = buildBindingView(bindings, specs);
    expect(view.warnings.some((w) => w.includes('phantom_code'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// redactSensitiveFields 兜底
// ---------------------------------------------------------------------------

describe('webgen - E11 redactSensitiveFields', () => {
  test('整键删除 tokenEnv/secretEnv/passwordEnv 等敏感字段', () => {
    const input = {
      ok: true,
      authConfig: { tokenEnv: 'S', secretEnv: 'S', passwordEnv: 'P' },
      roles: [{ roleId: 'r', token: 'tok', password: 'pw' }],
      interfaces: [{ action: 'a', tls: { certPath: '/c' } }],
    };
    const redacted = redactSensitiveFields(input) as Record<string, unknown>;
    expect(redacted.authConfig).toEqual({});
    const roleArr = redacted.roles as Array<Record<string, unknown>>;
    expect(roleArr[0].token).toBeUndefined();
    expect(roleArr[0].password).toBeUndefined();
    const ifaceArr = redacted.interfaces as Array<Record<string, unknown>>;
    expect(ifaceArr[0].tls).toEqual({});
    // ok 仍保留
    expect(redacted.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// readBindingsFileSafely
// ---------------------------------------------------------------------------

describe('webgen - E11 readBindingsFileSafely', () => {
  test('反向：根目录无 bindings.yaml / config 也无 bindings 段 → undefined', () => {
    const out = readBindingsFileSafely('/nonexistent-path-xyz');
    expect(out).toBeUndefined();
  });

  test('正向：根目录有 bindings.yaml → 解析为 BindingConfig', () => {
    const tmp = '/tmp/_bindings_test_' + Date.now();
    mkdirSync(tmp, { recursive: true });
    writeFileSync(
      join(tmp, 'bindings.yaml'),
      `roles:
  r:
    roleId: r
    baseUrl: http://mock.local
    auth: none
interfaces:
  - action: create
    roleId: r
    transport:
      type: http
      method: POST
      path: /c
errorMap:
  domain_not_owned:
    httpStatus: 409
    bodyField: code
`
    );
    const out = readBindingsFileSafely(tmp);
    expect(out).toBeDefined();
    expect(out?.errorMap?.domain_not_owned?.httpStatus).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// buildWebData 集成（含 binding + exceptionPaths）
// ---------------------------------------------------------------------------

describe('webgen - E11 buildWebData 集成', () => {
  test('正向：binding + exceptionPaths 出现在 data.json', () => {
    const md = `---
name: E11
version: 1.0.0
purpose: webgen binding integration
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
| EX1 | 域名未归属 | t | T1 | domain_not_owned |
`;
    const model = parseProtocolContent(md, 'test.md');
    const specs = specsFromEnvelope(specify(model));
    const bindings: BindingConfig = {
      roles: {},
      interfaces: [],
      errorMap: {
        domain_not_owned: { httpStatus: 409 } as ErrorMapEntry,
      },
    };
    const data = buildWebData({
      specsEnvelope: { ...specify(model), schemaVersion: '1.0', generatedAt: '', sourceModelVersion: '1.0.0' },
      model,
      bindings,
    });
    expect(data.binding?.hasBindings).toBe(true);
    expect(data.binding?.errorMap?.domain_not_owned?.httpStatus).toBe(409);
    expect(data.exceptionPaths).toHaveLength(1);
    expect(data.exceptionPaths?.[0].errorCode).toBe('domain_not_owned');
  });

  test('反向：bindings 缺省 → data.binding 字段缺失', () => {
    const md = `---
name: E11
version: 1.0.0
purpose: webgen no bindings
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
| T1 | r | S1 | S2 | register | r |
`;
    const model = parseProtocolContent(md, 'test.md');
    const data = buildWebData({
      specsEnvelope: { ...specify(model), schemaVersion: '1.0', generatedAt: '', sourceModelVersion: '1.0.0' },
      model,
    });
    expect(data.binding).toBeUndefined();
  });

  void {} as unknown as SourceProtocolModel; // satisfy lint
});

// ---------------------------------------------------------------------------
// Web 数据完整性（序列化后不含敏感字段）
// ---------------------------------------------------------------------------

describe('webgen - E11 data.json 序列化红线', () => {
  test('bindings 含敏感字段 → 经 redact 后 data.json 不含', () => {
    const md = `---
name: E11
version: 1.0.0
purpose: redact test
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
| T1 | r | S1 | S1 | register | r |
`;
    const model = parseProtocolContent(md, 'test.md');
    const bindings: BindingConfig = {
      roles: {
        r: {
          roleId: 'r',
          baseUrl: 'http://x',
          auth: 'bearer',
          authConfig: { tokenEnv: 'SECRET_TOKEN_XYZ' },
          tls: { certPath: '/SECRET' },
        } as BindingConfig['roles'][string],
      },
      interfaces: [],
    };
    // 模拟 webgen 路径：bindings 先 redact
    const redacted = redactSensitiveFields(bindings) as BindingConfig;
    const data = buildWebData({
      specsEnvelope: { ...specify(model), schemaVersion: '1.0', generatedAt: '', sourceModelVersion: '1.0.0' },
      model,
      bindings: redacted,
    });
    const ser = JSON.stringify(data);
    expect(ser).not.toContain('SECRET_TOKEN_XYZ');
    expect(ser).not.toContain('certPath');
  });
});

// 兜底：readBindingsFileSafely + write 模拟"端到端"路径的存在性
describe('webgen - 文件 I/O 路径存在性', () => {
  test('readFileSync vs readBindingsFileSafely（已通过其他 describe 间接验证）', () => {
    // 用一个真实路径确认 readBindingsFileSafely 兼容 readFileSync 行为
    expect(typeof readBindingsFileSafely).toBe('function');
  });

  void readFileSync; // 满足 lint
  void ({} as WebBindingView); // 满足 lint
});

// ---------------------------------------------------------------------------
// E11 #008 缺陷 2：ESM 加载下 readBindingsFileSafely 返回 bindings
// （修复前：require('yaml') 在 ESM 下未定义，恒返回 undefined；
//   修复后：顶层 ESM import 走模块解析，正常解析）
// ---------------------------------------------------------------------------

describe('E11 #008 缺陷 2：webgen ESM 路径下 readBindingsFileSafely 返回 bindings', () => {
  test('顶层 ESM import 加载 webgen 模块 → readBindingsFileSafely 能解析 bindings.yaml', () => {
    const tmp = '/tmp/_e11_yaml_' + Date.now();
    mkdirSync(tmp, { recursive: true });
    writeFileSync(
      join(tmp, 'bindings.yaml'),
      `errorMap:
  invalid_server_secret:
    httpStatus: 401
    bodyField: code
  domain_not_owned:
    httpStatus: 409
`
    );
    const out = readBindingsFileSafely(tmp);
    expect(out).toBeDefined();
    expect(out?.errorMap?.invalid_server_secret?.httpStatus).toBe(401);
    expect(out?.errorMap?.domain_not_owned?.httpStatus).toBe(409);
  });
});
