/**
 * 绑定解析模块单元测试
 *
 * 覆盖范围（P0a / P0b）：
 * - resolveBindings：合并 InterfaceSpec + BindingConfig → ResolvedBinding[]
 * - validateBindings：校验绑定完整性（系统接口缺失 + 观测接口缺失 → valid=false）
 * - findBinding：按 action 名查找已解析绑定
 * - 观测接口双向索引：observe_<StateName> + observe_<sourceId> 别名（P0b）
 */

import {
  resolveBindings,
  validateBindings,
  findBinding,
} from '../../src/binder/index.js';
import type {
  InterfaceSpec,
  BindingConfig,
  ResolvedBinding,
  BindingValidationReport,
} from '../../src/model/types.js';

// ---------------------------------------------------------------------------
// 测试辅助函数
// ---------------------------------------------------------------------------

/** 构造最小 InterfaceSpec */
function systemSpec(overrides: Partial<InterfaceSpec> = {}): InterfaceSpec {
  return {
    id: 'IF_SYS_T1',
    kind: 'system',
    sourceId: 'create',
    name: 'create',
    inputs: [],
    outputs: [],
    ...overrides,
  };
}

function observationSpec(overrides: Partial<InterfaceSpec> = {}): InterfaceSpec {
  return {
    id: 'IF_OBS_STATE_S1',
    kind: 'observation',
    sourceId: 'S1',
    name: 'observe_初始态',
    inputs: [],
    outputs: [{ name: 'isInState', type: 'boolean' }],
    ...overrides,
  };
}

function emptyBindingConfig(): BindingConfig {
  return { roles: {}, interfaces: [] };
}

// ---------------------------------------------------------------------------
// resolveBindings — 合并规格与配置
// ---------------------------------------------------------------------------

describe('resolveBindings', () => {
  test('空规格返回空数组', () => {
    const result = resolveBindings([], emptyBindingConfig());
    expect(result).toEqual([]);
  });

  test('无绑定配置时，所有 binding 为 undefined', () => {
    const specs = [systemSpec(), observationSpec()];
    const result = resolveBindings(specs, emptyBindingConfig());

    expect(result).toHaveLength(2);
    expect(result[0].spec.name).toBe('create');
    expect(result[0].binding).toBeUndefined();
    expect(result[0].roleBinding).toBeUndefined();
    expect(result[1].binding).toBeUndefined();
  });

  test('匹配 action 时返回对应的 InterfaceBinding', () => {
    const config: BindingConfig = {
      roles: {},
      interfaces: [
        {
          action: 'create',
          roleId: 'R-User',
          transport: { type: 'http', method: 'POST', path: '/v1/entries', params: [] },
        },
      ],
    };
    const result = resolveBindings([systemSpec()], config);

    expect(result[0].binding).toBeDefined();
    expect(result[0].binding!.action).toBe('create');
    expect(result[0].binding!.transport.type).toBe('http');
  });

  test('通过 roleId 关联 RoleBinding', () => {
    const config: BindingConfig = {
      roles: {
        R_User: {
          roleId: 'R_User',
          baseUrl: 'https://portal.internal/api',
          auth: 'bearer',
        },
      },
      interfaces: [
        {
          action: 'create',
          roleId: 'R_User',
          transport: { type: 'http', method: 'POST', path: '/v1/entries', params: [] },
        },
      ],
    };
    const result = resolveBindings([systemSpec()], config);

    expect(result[0].roleBinding).toBeDefined();
    expect(result[0].roleBinding!.baseUrl).toBe('https://portal.internal/api');
    expect(result[0].roleBinding!.auth).toBe('bearer');
  });

  test('roleId 不存在时 roleBinding 为 undefined（不阻断，由 validateBindings 报告）', () => {
    const config: BindingConfig = {
      roles: {},
      interfaces: [
        {
          action: 'create',
          roleId: 'NONEXISTENT',
          transport: { type: 'http', method: 'POST', path: '/v1/entries', params: [] },
        },
      ],
    };
    const result = resolveBindings([systemSpec()], config);

    expect(result[0].binding).toBeDefined();
    expect(result[0].roleBinding).toBeUndefined();
  });

  test('多个接口按 action 精确匹配，不混淆', () => {
    const config: BindingConfig = {
      roles: {},
      interfaces: [
        { action: 'create', roleId: 'R1', transport: { type: 'http', method: 'POST', path: '/create', params: [] } },
        { action: 'delete', roleId: 'R2', transport: { type: 'http', method: 'DELETE', path: '/delete', params: [] } },
      ],
    };
    const specs = [
      systemSpec({ name: 'create', sourceId: 'create' }),
      systemSpec({ id: 'IF_SYS_T2', name: 'delete', sourceId: 'delete' }),
    ];
    const result = resolveBindings(specs, config);

    expect(result[0].binding!.transport).toMatchObject({ method: 'POST' });
    expect(result[1].binding!.transport).toMatchObject({ method: 'DELETE' });
  });
});

// ---------------------------------------------------------------------------
// validateBindings — 完整性校验
// ---------------------------------------------------------------------------

describe('validateBindings', () => {
  test('所有接口已绑定时 valid=true', () => {
    const config: BindingConfig = {
      roles: { R: { roleId: 'R', baseUrl: 'https://x', auth: 'none' } },
      interfaces: [
        { action: 'create', roleId: 'R', transport: { type: 'http', method: 'POST', path: '/c', params: [] } },
        { action: 'observe_初始态', roleId: 'R', transport: { type: 'http', method: 'GET', path: '/o', params: [] } },
      ],
    };
    const specs = [systemSpec(), observationSpec()];
    const report = validateBindings(specs, config);

    expect(report.valid).toBe(true);
    expect(report.missingSystem).toHaveLength(0);
    expect(report.missingObservation).toHaveLength(0);
    expect(report.warnings).toHaveLength(0);
  });

  test('系统接口缺失绑定时 valid=false 且记录在 missingSystem', () => {
    const config: BindingConfig = { roles: {}, interfaces: [] };
    const specs = [systemSpec({ name: 'create' })];
    const report = validateBindings(specs, config);

    expect(report.valid).toBe(false);
    expect(report.missingSystem).toContain('create');
    expect(report.missingSystem).toHaveLength(1);
  });

  test('观测接口缺失绑定时 valid=false（P0b：观测接口不是可选的）', () => {
    const config: BindingConfig = {
      roles: { R: { roleId: 'R', baseUrl: 'https://x', auth: 'none' } },
      interfaces: [
        { action: 'create', roleId: 'R', transport: { type: 'http', method: 'POST', path: '/c', params: [] } },
      ],
    };
    const specs = [systemSpec(), observationSpec()];
    const report = validateBindings(specs, config);

    expect(report.valid).toBe(false);
    expect(report.missingSystem).toHaveLength(0);
    expect(report.missingObservation).toContain('observe_初始态');
  });

  test('系统接口和观测接口同时缺失', () => {
    const config: BindingConfig = { roles: {}, interfaces: [] };
    const specs = [
      systemSpec({ name: 'create' }),
      systemSpec({ id: 'IF_SYS_T2', name: 'delete', sourceId: 'delete' }),
      observationSpec({ name: 'observe_S2' }),
    ];
    const report = validateBindings(specs, config);

    expect(report.valid).toBe(false);
    expect(report.missingSystem).toEqual(['create', 'delete']);
    expect(report.missingObservation).toEqual(['observe_S2']);
  });

  test('roleId 引用不存在的角色时产生警告', () => {
    const config: BindingConfig = {
      roles: {},
      interfaces: [
        { action: 'create', roleId: 'GHOST_ROLE', transport: { type: 'http', method: 'POST', path: '/c', params: [] } },
        { action: 'observe_初始态', roleId: 'GHOST_ROLE', transport: { type: 'http', method: 'GET', path: '/o', params: [] } },
      ],
    };
    const specs = [systemSpec(), observationSpec()];
    const report = validateBindings(specs, config);

    // 绑定存在，所以 valid=true
    expect(report.valid).toBe(true);
    // 但 roleId 不存在 → 警告
    expect(report.warnings.length).toBeGreaterThanOrEqual(2);
    expect(report.warnings.some((w) => w.includes('GHOST_ROLE'))).toBe(true);
  });

  test('Kafka responseMode=reply_topic 但未配置 responseTopic → 警告', () => {
    const config: BindingConfig = {
      roles: { R: { roleId: 'R', baseUrl: 'https://x', auth: 'none' } },
      interfaces: [
        {
          action: 'create',
          roleId: 'R',
          transport: {
            type: 'kafka',
            topic: 'events',
            serde: 'json',
            responseMode: 'reply_topic',
            // 缺少 responseTopic
          },
        },
        { action: 'observe_初始态', roleId: 'R', transport: { type: 'http', method: 'GET', path: '/o', params: [] } },
      ],
    };
    const specs = [systemSpec(), observationSpec()];
    const report = validateBindings(specs, config);

    expect(report.valid).toBe(true);
    expect(report.warnings.some((w) => w.includes('responseTopic'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// findBinding — 按 action 查找
// ---------------------------------------------------------------------------

describe('findBinding', () => {
  test('找到匹配时返回 ResolvedBinding', () => {
    const config: BindingConfig = {
      roles: { R: { roleId: 'R', baseUrl: 'https://x', auth: 'none' } },
      interfaces: [
        { action: 'create', roleId: 'R', transport: { type: 'http', method: 'POST', path: '/c', params: [] } },
      ],
    };
    const resolved = resolveBindings([systemSpec()], config);
    const found = findBinding(resolved, 'create');

    expect(found).toBeDefined();
    expect(found!.spec.name).toBe('create');
  });

  test('未找到时返回 undefined', () => {
    const resolved = resolveBindings([systemSpec({ name: 'create' })], emptyBindingConfig());
    // 搜索一个不存在的 action 名
    const found = findBinding(resolved, 'nonexistent_action');
    expect(found).toBeUndefined();

    // 搜索存在的 spec 名应该找到（即使没有 binding），因为 findBinding 按 spec.name 匹配
    const foundExisting = findBinding(resolved, 'create');
    expect(foundExisting).toBeDefined();
    expect(foundExisting!.spec.name).toBe('create');
  });

  test('多个绑定中精确匹配 action', () => {
    const config: BindingConfig = {
      roles: { R: { roleId: 'R', baseUrl: 'https://x', auth: 'none' } },
      interfaces: [
        { action: 'create', roleId: 'R', transport: { type: 'http', method: 'POST', path: '/c', params: [] } },
        { action: 'delete', roleId: 'R', transport: { type: 'http', method: 'DELETE', path: '/d', params: [] } },
      ],
    };
    const specs = [
      systemSpec({ id: 'IF1', name: 'create', sourceId: 'create' }),
      systemSpec({ id: 'IF2', name: 'delete', sourceId: 'delete' }),
    ];
    const resolved = resolveBindings(specs, config);

    expect(findBinding(resolved, 'create')!.spec.name).toBe('create');
    expect(findBinding(resolved, 'delete')!.spec.name).toBe('delete');
    expect(findBinding(resolved, 'nonexistent')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 观测接口双向索引（P0b）— resolveBindings 不直接构建索引，
// 由 verifier 的 runTestCasesWithBindings 构建。
// 此处测试 binding 通过 sourceId 别名查找的场景。
// ---------------------------------------------------------------------------

describe('观测接口双向索引 — sourceId 别名', () => {
  test('观测接口 spec.sourceId 可用于构建别名映射', () => {
    // 模拟 specifier 的生成：
    //   name: "observe_初始态"（state.name）
    //   sourceId: "S1"（state.id）
    const obs = observationSpec({ name: 'observe_初始态', sourceId: 'S1' });

    // 构建双向索引（模拟 verifier 中的逻辑）
    const observationBindings = new Map<string, ResolvedBinding>();
    const resolved: ResolvedBinding = { spec: obs, binding: undefined, roleBinding: undefined };

    // 以 InterfaceSpec.name 为 key
    observationBindings.set(obs.name, resolved);
    // 以 observe_<sourceId> 为别名
    if (obs.sourceId) {
      observationBindings.set(`observe_${obs.sourceId}`, resolved);
    }

    // verifier 查找 observe_S1 → 命中（通过别名）
    expect(observationBindings.has('observe_S1')).toBe(true);
    expect(observationBindings.get('observe_S1')!.spec.name).toBe('observe_初始态');

    // verifier 查找 observe_初始态 → 命中（通过原始名）
    expect(observationBindings.has('observe_初始态')).toBe(true);
  });

  test('sourceId 别名与 name 指向同一实例', () => {
    const obs = observationSpec({ name: 'observe_锁定态', sourceId: 'S3' });
    const map = new Map<string, ResolvedBinding>();
    const entry: ResolvedBinding = { spec: obs, binding: undefined, roleBinding: undefined };

    map.set(obs.name, entry);
    if (obs.sourceId) map.set(`observe_${obs.sourceId}`, entry);

    expect(map.get('observe_锁定态')).toBe(entry);
    expect(map.get('observe_S3')).toBe(entry);
    expect(map.get('observe_锁定态')).toBe(map.get('observe_S3'));
  });

  test('不同状态 ID/名称分别索引到各自绑定的观测接口', () => {
    const obs1 = observationSpec({ id: 'O1', name: 'observe_初始态', sourceId: 'S1' });
    const obs2 = observationSpec({ id: 'O2', name: 'observe_锁定态', sourceId: 'S3' });
    const config: BindingConfig = {
      roles: { R: { roleId: 'R', baseUrl: 'https://x', auth: 'none' } },
      interfaces: [
        { action: 'observe_初始态', roleId: 'R', transport: { type: 'http', method: 'GET', path: '/s1', params: [] } },
        { action: 'observe_锁定态', roleId: 'R', transport: { type: 'http', method: 'GET', path: '/s3', params: [] } },
      ],
    };
    const resolved = resolveBindings([obs1, obs2], config);

    // 模拟 verifier 构建的双向索引
    const map = new Map<string, ResolvedBinding>();
    for (const r of resolved) {
      map.set(r.spec.name, r);
      if (r.spec.sourceId) map.set(`observe_${r.spec.sourceId}`, r);
    }

    // 两个接口应该各自有独立的 binding
    expect(map.get('observe_S1')!.binding!.transport).toMatchObject({ path: '/s1' });
    expect(map.get('observe_S3')!.binding!.transport).toMatchObject({ path: '/s3' });
    expect(map.get('observe_S1')).not.toBe(map.get('observe_S3'));
  });
});
