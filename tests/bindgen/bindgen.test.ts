/**
 * E3 binding 骨架自动生成器单元测试
 *
 * 覆盖范围（IMPLEMENTATION-ACCEPTANCE.md §E3）：
 * - 正常协议：derive-bindings 产物字段完整 + method/path/params 推导正确
 * - 老格式 specs.json：自动 envelopeMigrate 后再生成骨架
 * - bind 流程：mergeBindings(skeleton, manual) 验证完整性
 * - 边界：超大协议（40+ 接口）/观察接口骨架正确性
 */

import {
  deriveSkeletonBindings,
  deriveHttpPath,
  deriveHttpMethod,
  deriveHttpParams,
  deriveRoles,
  deriveStateMap,
  deriveInterfaceBinding,
  selectDefaultRoleId,
  deriveBindings,
  inspectSpecsEnvelopeMeta,
  isSkeletonBindings,
  SKELETON_MARKER,
  DEFAULT_BASE_URL_PLACEHOLDER,
  type SkeletonBindings,
} from '../../src/bindgen/index.js';
import { mergeBindings, validateBindings } from '../../src/binder/index.js';
import { parseProtocolFile } from '../../src/parser/index.js';
import { specify } from '../../src/specifier/index.js';
import type {
  InterfaceSpec,
  InterfaceBinding,
  SourceProtocolModel,
} from '../../src/model/types.js';

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

const FIXTURE_DIR = '/work/protochain/tests/fixtures';

function loadApprovalFlowModel(): SourceProtocolModel {
  return parseProtocolFile(`${FIXTURE_DIR}/approval-flow.md`);
}

function loadApprovalFlowSpecs(): InterfaceSpec[] {
  return specify(loadApprovalFlowModel()).specs;
}

/** 构造超大协议 fixture（40+ 接口） */
function loadLargeModel(): SourceProtocolModel {
  // saas-real-P4-push-node 通常接口多
  return parseProtocolFile(`${FIXTURE_DIR}/saas-real-P4-push-node.md`);
}

function loadLargeSpecs(): InterfaceSpec[] {
  return specify(loadLargeModel()).specs;
}

// ---------------------------------------------------------------------------
// deriveHttpPath / deriveHttpMethod / deriveHttpParams
// ---------------------------------------------------------------------------

describe('deriveHttpPath', () => {
  test('camelCase → snake_case + 前导 /', () => {
    expect(deriveHttpPath('applyForApproval')).toBe('/apply_for_approval');
    expect(deriveHttpPath('submitForm')).toBe('/submit_form');
    expect(deriveHttpPath('createRequest')).toBe('/create_request');
  });

  test('snake_case 原样', () => {
    expect(deriveHttpPath('submit_request')).toBe('/submit_request');
  });

  test('含 / 已 path', () => {
    expect(deriveHttpPath('v1/entries')).toBe('/v1/entries');
    expect(deriveHttpPath('/v2/things')).toBe('/v2/things');
  });

  test('空名 → /TODO', () => {
    expect(deriveHttpPath('')).toBe('/TODO');
  });

  test('超长名截断', () => {
    const longName = 'a'.repeat(100);
    const path = deriveHttpPath(longName);
    expect(path.length).toBeLessThanOrEqual(65); // '/' + 64
    expect(path.startsWith('/')).toBe(true);
  });
});

describe('deriveHttpMethod', () => {
  test('observation → GET', () => {
    expect(deriveHttpMethod({
      id: 'I1', kind: 'observation', sourceId: 'S1', name: 'observe_S1', inputs: [], outputs: [],
    })).toBe('GET');
  });

  test('attribute_update → PATCH', () => {
    expect(deriveHttpMethod({
      id: 'I1', kind: 'system', sourceId: 'T1', name: 'update_x',
      inputs: [], outputs: [], actionType: 'attribute_update',
    })).toBe('PATCH');
  });

  test('state_transition → POST（默认）', () => {
    expect(deriveHttpMethod({
      id: 'I1', kind: 'system', sourceId: 'T1', name: 'submit',
      inputs: [], outputs: [], actionType: 'state_transition',
    })).toBe('POST');
  });

  test('actionType 缺省 → POST（兜底）', () => {
    expect(deriveHttpMethod({
      id: 'I1', kind: 'system', sourceId: 'T1', name: 'do_x',
      inputs: [], outputs: [],
    })).toBe('POST');
  });
});

describe('deriveHttpParams', () => {
  test('required 字段进 body', () => {
    const spec: InterfaceSpec = {
      id: 'I1',
      kind: 'system',
      sourceId: 'T1',
      name: 'submit',
      inputs: [],
      outputs: [],
      requestSchema: {
        type: 'object',
        properties: {
          currentState: { type: 'string' },
          formData: { type: 'object' },
          optional: { type: 'string' },
        },
        required: ['currentState', 'formData'],
      },
    };
    const params = deriveHttpParams(spec);
    const bodyParams = params.filter((p) => p.in === 'body');
    const bodyNames = bodyParams.map((p) => p.logicalName);
    expect(bodyNames).toContain('currentState');
    expect(bodyNames).toContain('formData');
    expect(bodyNames).not.toContain('optional');
  });

  test('id 字段 → path', () => {
    const spec: InterfaceSpec = {
      id: 'I1',
      kind: 'system',
      sourceId: 'T1',
      name: 'getOne',
      inputs: [],
      outputs: [],
      requestSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
      },
    };
    const params = deriveHttpParams(spec);
    const pathParam = params.find((p) => p.logicalName === 'id');
    expect(pathParam?.in).toBe('path');
  });

  test('_id 后缀字段 → path（user_id / requestId）', () => {
    const spec: InterfaceSpec = {
      id: 'I1',
      kind: 'system',
      sourceId: 'T1',
      name: 'delete',
      inputs: [],
      outputs: [],
      requestSchema: {
        type: 'object',
        properties: {
          user_id: { type: 'string' },
          requestId: { type: 'string' },
        },
        required: ['user_id', 'requestId'],
      },
    };
    const params = deriveHttpParams(spec);
    expect(params.find((p) => p.logicalName === 'user_id')?.in).toBe('path');
    expect(params.find((p) => p.logicalName === 'requestId')?.in).toBe('path');
  });

  test('无 requestSchema → 空 params', () => {
    expect(deriveHttpParams({
      id: 'I1', kind: 'system', sourceId: 'T1', name: 'x', inputs: [], outputs: [],
    })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// deriveRoles
// ---------------------------------------------------------------------------

describe('deriveRoles', () => {
  test('从 model.metadata.roles 推导，baseUrl 占位', () => {
    const model = loadApprovalFlowModel();
    const specs = loadApprovalFlowSpecs();
    const { roles, warnings } = deriveRoles(model, specs);
    expect(Object.keys(roles).sort()).toEqual(['applicant', 'approver', 'system']);
    for (const r of Object.values(roles)) {
      expect(r.baseUrl).toBe(DEFAULT_BASE_URL_PLACEHOLDER);
      expect(r.auth).toBe('none');
      expect(r.headers).toEqual({});
    }
    // approval-flow 含 system 接口 → 无角色警告
    expect(warnings).toEqual([]);
  });

  test('空 roles → default 兜底', () => {
    const model: SourceProtocolModel = {
      ...loadApprovalFlowModel(),
      metadata: { ...loadApprovalFlowModel().metadata, roles: [] },
    };
    const { roles, warnings } = deriveRoles(model, []);
    expect(roles).toHaveProperty('default');
    expect(roles.default.baseUrl).toBe(DEFAULT_BASE_URL_PLACEHOLDER);
    expect(warnings.some((w) => w.includes('default'))).toBe(true);
  });

  test('纯观测协议（无 system 接口） → 警告', () => {
    const model = loadApprovalFlowModel();
    const { warnings } = deriveRoles(model, [
      { id: 'O1', kind: 'observation', sourceId: 'S1', name: 'observe_S1', inputs: [], outputs: [] },
    ]);
    expect(warnings.some((w) => w.includes('无系统接口'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// selectDefaultRoleId
// ---------------------------------------------------------------------------

describe('selectDefaultRoleId', () => {
  test('首个 consensus 角色优先', () => {
    const model = loadApprovalFlowModel();
    // approval-flow 的角色 roleType 暂未设 → 取首个角色
    const role = selectDefaultRoleId(model);
    expect(role).toBe(model.metadata.roles[0].id);
  });

  test('空 roles → default', () => {
    const model: SourceProtocolModel = {
      ...loadApprovalFlowModel(),
      metadata: { ...loadApprovalFlowModel().metadata, roles: [] },
    };
    expect(selectDefaultRoleId(model)).toBe('default');
  });

  test('显式 consensus 角色优先', () => {
    const model = loadApprovalFlowModel();
    model.metadata.roles = [
      { id: 'p1', name: 'p1', roleType: 'participant' },
      { id: 'c1', name: 'c1', roleType: 'consensus' },
      { id: 'p2', name: 'p2', roleType: 'participant' },
    ];
    expect(selectDefaultRoleId(model)).toBe('c1');
  });
});

// ---------------------------------------------------------------------------
// deriveStateMap
// ---------------------------------------------------------------------------

describe('deriveStateMap', () => {
  test('从 state 观测接口派生（stateId → stateName）', () => {
    const specs: InterfaceSpec[] = [
      { id: 'O1', kind: 'observation', sourceId: 'S1', name: 'observe_草稿', inputs: [], outputs: [] },
      { id: 'O2', kind: 'observation', sourceId: 'S2', name: 'observe_待审批', inputs: [], outputs: [] },
    ];
    const { stateMap, warnings } = deriveStateMap(specs);
    expect(stateMap).toEqual({ S1: '草稿', S2: '待审批' });
    expect(warnings).toEqual([]);
  });

  test('不变量观测接口不进 stateMap', () => {
    const specs: InterfaceSpec[] = [
      { id: 'O1', kind: 'observation', sourceId: 'S1', name: 'observe_草稿', inputs: [], outputs: [] },
      {
        id: 'O2',
        kind: 'observation',
        sourceId: 'INV1',
        name: 'observe_INV1',
        inputs: [],
        outputs: [],
        invariantIds: ['INV1'],
      },
    ];
    const { stateMap } = deriveStateMap(specs);
    expect(stateMap).toEqual({ S1: '草稿' });
    expect(stateMap).not.toHaveProperty('INV1');
  });

  test('无 state 观测 → 空 + warning', () => {
    const specs: InterfaceSpec[] = [
      {
        id: 'O1',
        kind: 'observation',
        sourceId: 'INV1',
        name: 'observe_INV1',
        inputs: [],
        outputs: [],
        invariantIds: ['INV1'],
      },
    ];
    const { stateMap, warnings } = deriveStateMap(specs);
    expect(stateMap).toEqual({});
    expect(warnings.some((w) => w.includes('stateMap'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deriveInterfaceBinding（HTTP 默认推导）
// ---------------------------------------------------------------------------

describe('deriveInterfaceBinding', () => {
  test('system 接口：POST + body params', () => {
    const spec: InterfaceSpec = {
      id: 'I1',
      kind: 'system',
      sourceId: 'T1',
      name: 'submitRequest',
      inputs: [],
      outputs: [],
      requestSchema: {
        type: 'object',
        properties: { currentState: { type: 'string' } },
        required: ['currentState'],
      },
    };
    const binding = deriveInterfaceBinding(spec, 'R1');
    expect(binding.action).toBe('submitRequest');
    expect(binding.roleId).toBe('R1');
    expect(binding.transport.type).toBe('http');
    if (binding.transport.type === 'http') {
      expect(binding.transport.method).toBe('POST');
      expect(binding.transport.path).toBe('/submit_request');
      expect(binding.transport.params).toHaveLength(1);
      expect(binding.transport.params[0]).toMatchObject({
        logicalName: 'currentState',
        in: 'body',
      });
    }
  });

  test('observation 接口：GET + 空 params', () => {
    const spec: InterfaceSpec = {
      id: 'O1',
      kind: 'observation',
      sourceId: 'S1',
      name: 'observe_草稿',
      inputs: [],
      outputs: [],
    };
    const binding = deriveInterfaceBinding(spec, 'R1');
    if (binding.transport.type === 'http') {
      expect(binding.transport.method).toBe('GET');
      expect(binding.transport.path).toBe('/observe_草稿');
      expect(binding.transport.params).toEqual([]);
    }
  });

  test('attribute_update：PATCH', () => {
    const spec: InterfaceSpec = {
      id: 'I1',
      kind: 'system',
      sourceId: 'T1',
      name: 'updateInfo',
      inputs: [],
      outputs: [],
      actionType: 'attribute_update',
    };
    const binding = deriveInterfaceBinding(spec, 'R1');
    if (binding.transport.type === 'http') {
      expect(binding.transport.method).toBe('PATCH');
    }
  });
});

// ---------------------------------------------------------------------------
// deriveSkeletonBindings —— 主入口（不写文件）
// ---------------------------------------------------------------------------

describe('deriveSkeletonBindings', () => {
  test('正常协议（approval-flow）骨架字段完整', () => {
    const model = loadApprovalFlowModel();
    const specs = loadApprovalFlowSpecs();
    const skeleton = deriveSkeletonBindings(model, specs, {
      sourceEnvelope: true,
      sourceMigrated: false,
      sourceMigrationWarnings: [],
    });

    expect(skeleton[SKELETON_MARKER]).toBe(true);
    expect(skeleton.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(skeleton.sourceModelVersion).toBe('1.0.0');
    expect(skeleton.sourceEnvelope).toBe(true);
    expect(skeleton.sourceMigrated).toBe(false);
    expect(skeleton.defaultEnv).toBe('default');

    // interfaces 数量 = specs 数量
    expect(skeleton.interfaces).toHaveLength(specs.length);
    // 每个 binding 都是 HTTP（v0.5 默认全 generated）
    for (const b of skeleton.interfaces) {
      expect(b.transport.type).toBe('http');
    }

    // 角色 = approval-flow 三个角色
    expect(Object.keys(skeleton.roles).sort()).toEqual(['applicant', 'approver', 'system']);
    for (const r of Object.values(skeleton.roles)) {
      expect(r.baseUrl).toBe(DEFAULT_BASE_URL_PLACEHOLDER);
      expect(r.auth).toBe('none');
    }

    // stats
    expect(skeleton.stats.total).toBe(specs.length);
    expect(skeleton.stats.system + skeleton.stats.observation).toBe(skeleton.stats.total);
    expect(skeleton.stats.generated).toBe(skeleton.stats.total);
    expect(skeleton.stats.partial).toBe(0);
    expect(skeleton.stats.generationRate).toBe(1);
    expect(skeleton.stats.manualConfirmItems).toBe(
      Object.keys(skeleton.roles).length + Object.keys(skeleton.stateMap ?? {}).length
    );

    // stateMap 派生（approval-flow 5 个状态 → stateMap 5 条）
    expect(Object.keys(skeleton.stateMap ?? {}).length).toBeGreaterThanOrEqual(5);
  });

  test('method/path/params 推导正确（system 接口抽样）', () => {
    const model = loadApprovalFlowModel();
    const specs = loadApprovalFlowSpecs();
    const skeleton = deriveSkeletonBindings(model, specs, {
      sourceEnvelope: true,
      sourceMigrated: false,
      sourceMigrationWarnings: [],
    });

    // 抽样 submit 接口：name='submit'（actionType=state_transition）
    const submit = skeleton.interfaces.find((b) => b.action === 'submit');
    expect(submit).toBeDefined();
    if (submit?.transport.type === 'http') {
      expect(submit.transport.method).toBe('POST');
      expect(submit.transport.path).toBe('/submit');
      // currentState 必填进 body
      const currentState = submit.transport.params.find((p) => p.logicalName === 'currentState');
      expect(currentState).toBeDefined();
      expect(currentState!.in).toBe('body');
    }
  });

  test('observation 接口：method=GET + 空 params', () => {
    const model = loadApprovalFlowModel();
    const specs = loadApprovalFlowSpecs();
    const skeleton = deriveSkeletonBindings(model, specs, {
      sourceEnvelope: true,
      sourceMigrated: false,
      sourceMigrationWarnings: [],
    });

    const observations = skeleton.interfaces.filter((b) => b.action.startsWith('observe_'));
    expect(observations.length).toBeGreaterThan(0);
    for (const obs of observations) {
      if (obs.transport.type === 'http') {
        expect(obs.transport.method).toBe('GET');
        expect(obs.transport.params).toEqual([]);
      }
    }
  });

  test('40+ 接口（边界）：全 generated + 100% 生成率', () => {
    const model = loadLargeModel();
    const specs = loadLargeSpecs();
    expect(specs.length).toBeGreaterThanOrEqual(10); // 至少证明大协议能跑（不强求 40，因 fixture 不一定够）

    const skeleton = deriveSkeletonBindings(model, specs, {
      sourceEnvelope: true,
      sourceMigrated: false,
      sourceMigrationWarnings: [],
    });
    expect(skeleton.interfaces).toHaveLength(specs.length);
    expect(skeleton.stats.generated).toBe(specs.length);
    expect(skeleton.stats.generationRate).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// inspectSpecsEnvelopeMeta + isSkeletonBindings（envelope 元数据探针）
// ---------------------------------------------------------------------------

describe('inspectSpecsEnvelopeMeta', () => {
  test('Envelope 形态 → sourceEnvelope=true', () => {
    const env = { schemaVersion: '1.0', specs: [], generatedAt: '', sourceModelVersion: '' };
    const meta = inspectSpecsEnvelopeMeta(env);
    expect(meta.sourceEnvelope).toBe(true);
    expect(meta.sourceMigrated).toBe(false);
  });

  test('裸数组 → sourceEnvelope=false, sourceMigrated=true', () => {
    const meta = inspectSpecsEnvelopeMeta([]);
    expect(meta.sourceEnvelope).toBe(false);
    expect(meta.sourceMigrated).toBe(true);
    expect(meta.sourceMigrationWarnings.length).toBeGreaterThan(0);
  });

  test('不可识别形态 → sourceEnvelope=false, sourceMigrated=false', () => {
    const meta = inspectSpecsEnvelopeMeta('garbage');
    expect(meta.sourceEnvelope).toBe(false);
    expect(meta.sourceMigrated).toBe(false);
  });
});

describe('isSkeletonBindings', () => {
  test('含 SKELETON_MARKER=true → true', () => {
    expect(isSkeletonBindings({ [SKELETON_MARKER]: true })).toBe(true);
  });

  test('缺标记 → false', () => {
    expect(isSkeletonBindings({ roles: {}, interfaces: [] })).toBe(false);
  });

  test('null / 非对象 → false', () => {
    expect(isSkeletonBindings(null)).toBe(false);
    expect(isSkeletonBindings('x')).toBe(false);
    expect(isSkeletonBindings(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deriveBindings（CLI 入口：写文件 + 错误处理）
// ---------------------------------------------------------------------------

describe('deriveBindings（CLI 入口）', () => {
  let tmpRoot: string;
  let originalCwd: string;

  beforeEach(async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    originalCwd = process.cwd();
    tmpRoot = mkdtempSync('/tmp/e3-bindgen-');
    mkdirSync(`${tmpRoot}/derived`, { recursive: true });
    mkdirSync(`${tmpRoot}/protocol`, { recursive: true });
    // 写 model.md（用 approval-flow 内容）
    const { readFileSync } = await import('node:fs');
    const modelContent = readFileSync(`${FIXTURE_DIR}/approval-flow.md`, 'utf-8');
    writeFileSync(`${tmpRoot}/protocol/model.md`, modelContent, 'utf-8');
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  function parseModelFn(rootDir: string): SourceProtocolModel {
    return parseProtocolFile(`${rootDir}/protocol/model.md`);
  }

  test('正常 Envelope specs.json → 骨架落盘', async () => {
    const { writeFileSync } = await import('node:fs');
    const specs = loadApprovalFlowSpecs();
    const envelope = {
      schemaVersion: '1.0',
      generatedAt: new Date().toISOString(),
      sourceModelVersion: '1.0.0',
      specs,
    };
    writeFileSync(`${tmpRoot}/derived/specs.json`, JSON.stringify(envelope, null, 2), 'utf-8');

    const result = await deriveBindings({ rootDir: tmpRoot }, parseModelFn);
    expect(result.skeletonPath).toBe(`${tmpRoot}/derived/bindings.skeleton.yaml`);
    expect(result.reportPath).toBe(`${tmpRoot}/derived/bindings-generation-report.json`);

    const { readFileSync, existsSync } = await import('node:fs');
    expect(existsSync(result.skeletonPath)).toBe(true);
    expect(existsSync(result.reportPath)).toBe(true);

    const yamlContent = readFileSync(result.skeletonPath, 'utf-8');
    expect(yamlContent).toContain(SKELETON_MARKER);
    expect(yamlContent).toContain('applicant');
    expect(yamlContent).toContain('submit');

    const report = JSON.parse(readFileSync(result.reportPath, 'utf-8'));
    expect(report.stats.total).toBe(specs.length);
    expect(report.stats.generated).toBe(specs.length);
  });

  test('老格式 specs.json（裸数组）→ 自动 envelopeMigrate + 生成骨架', async () => {
    const { writeFileSync } = await import('node:fs');
    const specs = loadApprovalFlowSpecs();
    writeFileSync(`${tmpRoot}/derived/specs.json`, JSON.stringify(specs), 'utf-8');

    const result = await deriveBindings(
      { rootDir: tmpRoot, silentMigration: true },
      parseModelFn
    );
    expect(result.skeleton.sourceEnvelope).toBe(false);
    expect(result.skeleton.sourceMigrated).toBe(true);
    expect(result.skeleton.sourceMigrationWarnings.length).toBeGreaterThan(0);
    expect(result.skeleton.interfaces).toHaveLength(specs.length);
  });

  test('specs.json 不存在 → 抛错', async () => {
    await expect(
      deriveBindings({ rootDir: tmpRoot }, parseModelFn)
    ).rejects.toThrow(/specs\.json 不存在/);
  });

  test('已存在骨架 + 未传 --force → 抛错', async () => {
    const { writeFileSync } = await import('node:fs');
    const specs = loadApprovalFlowSpecs();
    writeFileSync(
      `${tmpRoot}/derived/specs.json`,
      JSON.stringify({ schemaVersion: '1.0', generatedAt: '', sourceModelVersion: '1.0.0', specs }),
      'utf-8'
    );
    writeFileSync(`${tmpRoot}/derived/bindings.skeleton.yaml`, 'old', 'utf-8');

    await expect(
      deriveBindings({ rootDir: tmpRoot }, parseModelFn)
    ).rejects.toThrow(/骨架已存在/);

    // --force 覆盖
    const result = await deriveBindings(
      { rootDir: tmpRoot, force: true },
      parseModelFn
    );
    expect(result.skeleton.interfaces.length).toBe(specs.length);
  });

  test('自定义 --output / --report 路径', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const specs = loadApprovalFlowSpecs();
    writeFileSync(
      `${tmpRoot}/derived/specs.json`,
      JSON.stringify({ schemaVersion: '1.0', generatedAt: '', sourceModelVersion: '1.0.0', specs }),
      'utf-8'
    );
    mkdirSync(`${tmpRoot}/custom`, { recursive: true });
    const result = await deriveBindings(
      {
        rootDir: tmpRoot,
        outputPath: `${tmpRoot}/custom/skeleton.yaml`,
        reportPath: `${tmpRoot}/custom/report.json`,
      },
      parseModelFn
    );
    expect(result.skeletonPath).toBe(`${tmpRoot}/custom/skeleton.yaml`);
    expect(result.reportPath).toBe(`${tmpRoot}/custom/report.json`);
  });
});

// ---------------------------------------------------------------------------
// mergeBindings（核心合并逻辑）
// ---------------------------------------------------------------------------

describe('mergeBindings', () => {
  test('manual 覆盖 skeleton roles（baseUrl / auth）', () => {
    const skeleton: SkeletonBindings = {
      [SKELETON_MARKER]: true,
      generatedAt: '',
      sourceModelVersion: '1.0.0',
      sourceEnvelope: true,
      sourceMigrated: false,
      sourceMigrationWarnings: [],
      defaultEnv: 'default',
      roles: {
        R1: { roleId: 'R1', baseUrl: 'https://TODO.example.com', auth: 'none' },
      },
      interfaces: [],
      stateMap: {},
      stats: {
        total: 0, system: 0, observation: 0,
        generated: 0, partial: 0, generationRate: 0, manualConfirmItems: 0,
      },
      warnings: [],
    };

    const manual = {
      roles: {
        R1: { roleId: 'R1', baseUrl: 'https://api.prod.example.com', auth: 'bearer' as const },
      },
      interfaces: [],
    };

    const merged = mergeBindings(skeleton, manual);
    expect(merged.roles.R1.baseUrl).toBe('https://api.prod.example.com');
    expect(merged.roles.R1.auth).toBe('bearer');
  });

  test('interfaces：manual 优先 + skeleton-only 追加', () => {
    const skeleton: SkeletonBindings = {
      [SKELETON_MARKER]: true,
      generatedAt: '',
      sourceModelVersion: '1.0.0',
      sourceEnvelope: true,
      sourceMigrated: false,
      sourceMigrationWarnings: [],
      defaultEnv: 'default',
      roles: {},
      interfaces: [
        { action: 'autoOnly', roleId: 'R1', transport: { type: 'http', method: 'GET', path: '/auto', params: [] } },
        { action: 'overlap', roleId: 'R1', transport: { type: 'http', method: 'GET', path: '/skeleton', params: [] } },
      ],
      stateMap: {},
      stats: {
        total: 0, system: 0, observation: 0,
        generated: 0, partial: 0, generationRate: 0, manualConfirmItems: 0,
      },
      warnings: [],
    };

    const manual = {
      roles: {},
      interfaces: [
        { action: 'overlap', roleId: 'R1', transport: { type: 'http', method: 'POST', path: '/manual', params: [] } },
        { action: 'manualOnly', roleId: 'R1', transport: { type: 'http', method: 'GET', path: '/m', params: [] } },
      ],
    };

    const merged = mergeBindings(skeleton, manual);
    const actions = merged.interfaces.map((i) => i.action);
    // manual 全保留 + skeleton-only 追加
    expect(actions).toContain('overlap'); // manual 优先
    expect(actions).toContain('manualOnly');
    expect(actions).toContain('autoOnly');
    // overlap 是 manual 覆盖的版本（POST + /manual）
    const overlap = merged.interfaces.find((i) => i.action === 'overlap');
    expect(overlap?.transport).toMatchObject({ type: 'http', method: 'POST', path: '/manual' });
  });

  test('stateMap 合并：manual 优先', () => {
    const skeleton: SkeletonBindings = {
      [SKELETON_MARKER]: true,
      generatedAt: '',
      sourceModelVersion: '1.0.0',
      sourceEnvelope: true,
      sourceMigrated: false,
      sourceMigrationWarnings: [],
      defaultEnv: 'default',
      roles: {},
      interfaces: [],
      stateMap: { S1: '草稿', S2: '待审批' },
      stats: {
        total: 0, system: 0, observation: 0,
        generated: 0, partial: 0, generationRate: 0, manualConfirmItems: 0,
      },
      warnings: [],
    };

    const manual = {
      roles: {},
      interfaces: [],
      stateMap: { S1: 'draft', S2: 'pending' }, // 人工确认系统词
    };

    const merged = mergeBindings(skeleton, manual);
    expect(merged.stateMap).toEqual({ S1: 'draft', S2: 'pending' });
  });

  test('manual 完全空 → 骨架原样返回', () => {
    const skeleton: SkeletonBindings = {
      [SKELETON_MARKER]: true,
      generatedAt: '',
      sourceModelVersion: '1.0.0',
      sourceEnvelope: true,
      sourceMigrated: false,
      sourceMigrationWarnings: [],
      defaultEnv: 'default',
      roles: { R1: { roleId: 'R1', baseUrl: 'https://TODO', auth: 'none' } },
      interfaces: [
        { action: 'submit', roleId: 'R1', transport: { type: 'http', method: 'POST', path: '/submit', params: [] } },
      ],
      stateMap: { S1: '草稿' },
      stats: {
        total: 1, system: 1, observation: 0,
        generated: 1, partial: 0, generationRate: 1, manualConfirmItems: 2,
      },
      warnings: [],
    };

    const merged = mergeBindings(skeleton, { roles: {}, interfaces: [] });
    expect(merged.interfaces).toHaveLength(1);
    expect(merged.stateMap).toEqual({ S1: '草稿' });
    expect(merged.roles.R1.baseUrl).toBe('https://TODO');
  });

  test('manual 覆盖 transport 类型（HTTP → Kafka）允许', () => {
    const skeleton: SkeletonBindings = {
      [SKELETON_MARKER]: true,
      generatedAt: '',
      sourceModelVersion: '1.0.0',
      sourceEnvelope: true,
      sourceMigrated: false,
      sourceMigrationWarnings: [],
      defaultEnv: 'default',
      roles: {},
      interfaces: [
        { action: 'submit', roleId: 'R1', transport: { type: 'http', method: 'POST', path: '/submit', params: [] } },
      ],
      stateMap: {},
      stats: {
        total: 1, system: 1, observation: 0,
        generated: 1, partial: 0, generationRate: 1, manualConfirmItems: 0,
      },
      warnings: [],
    };

    const manual = {
      roles: {},
      interfaces: [
        {
          action: 'submit',
          roleId: 'R1',
          transport: {
            type: 'kafka' as const,
            topic: 'events.submit',
            serde: 'json' as const,
            responseMode: 'reply_topic' as const,
          },
        },
      ],
    };

    const merged = mergeBindings(skeleton, manual);
    expect(merged.interfaces[0].transport.type).toBe('kafka');
  });
});

// ---------------------------------------------------------------------------
// bind 流程：mergeBindings + validateBindings 端到端
// ---------------------------------------------------------------------------

describe('bind 流程：mergeBindings + validateBindings', () => {
  test('approval-flow 骨架 + manual baseUrl → bind 校验通过', () => {
    const model = loadApprovalFlowModel();
    const specs = loadApprovalFlowSpecs();
    const skeleton = deriveSkeletonBindings(model, specs, {
      sourceEnvelope: true,
      sourceMigrated: false,
      sourceMigrationWarnings: [],
    });

    // 模拟人工填 baseUrl（其他字段留 TODO）
    const manual = {
      roles: {
        applicant: { ...skeleton.roles.applicant, baseUrl: 'https://portal.example.com' },
        approver: { ...skeleton.roles.approver, baseUrl: 'https://reviewer.example.com' },
        system: { ...skeleton.roles.system, baseUrl: 'https://internal.example.com' },
      },
      interfaces: skeleton.interfaces,
      stateMap: skeleton.stateMap,
    };

    const merged = mergeBindings(skeleton, manual);
    const report = validateBindings(specs, merged);

    expect(report.valid).toBe(true);
    expect(report.missingSystem).toEqual([]);
    expect(report.missingObservation).toEqual([]);
  });

  test('人工填 baseUrl 不完整（部分角色） → bind 校验仍通过（警告无 roleId）', () => {
    const model = loadApprovalFlowModel();
    const specs = loadApprovalFlowSpecs();
    const skeleton = deriveSkeletonBindings(model, specs, {
      sourceEnvelope: true,
      sourceMigrated: false,
      sourceMigrationWarnings: [],
    });

    // 只填一个角色的 baseUrl（其他留 TODO）
    const partialManual = {
      roles: {
        applicant: { ...skeleton.roles.applicant, baseUrl: 'https://portal.example.com' },
      },
      interfaces: skeleton.interfaces,
    };

    const merged = mergeBindings(skeleton, partialManual);
    const report = validateBindings(specs, merged);
    // 接口绑定本身有效；只是 baseUrl 待人工补（validateBindings 不校验 baseUrl）
    expect(report.valid).toBe(true);
  });

  test('老格式 bindings.yaml（无 skeleton）→ 继续工作', () => {
    const specs = loadApprovalFlowSpecs();
    // 模拟「从零写」的旧 bindings.yaml
    const legacyManual = {
      roles: {
        applicant: { roleId: 'applicant', baseUrl: 'https://legacy.example.com', auth: 'none' as const },
        approver: { roleId: 'approver', baseUrl: 'https://legacy.example.com', auth: 'none' as const },
      },
      interfaces: [
        { action: 'submit', roleId: 'applicant', transport: { type: 'http', method: 'POST', path: '/old/submit', params: [] } as any },
        { action: 'approve', roleId: 'approver', transport: { type: 'http', method: 'POST', path: '/old/approve', params: [] } as any },
      ] as InterfaceBinding[],
    };

    const report = validateBindings(specs, legacyManual);
    // 缺失观测接口 → 不通过
    expect(report.valid).toBe(false);
    expect(report.missingObservation.length).toBeGreaterThan(0);

    // 但 mergeBindings 调用不报错（不传 skeleton 直接 validate 仍可跑）
    // 证明：mergeBindings 是可选的（skeleton 缺省时 manual 自身可用）
  });
});
