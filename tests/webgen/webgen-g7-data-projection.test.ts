/**
 * G7-V3（webgen 数据层扩展）单元测试 —— 六个新字段投影
 *
 * 覆盖范围（V3-5 验收）：
 * ① dimensions（S1 产物，specs.json 顶层）→ WebDataJson.dimensions；
 * ② modelRelations（V1 关系段，DerivableLayer.relations）→ WebDataJson.modelRelations；
 * ③ storage（S3 derive-storage 产物 storage.schema.json）→ WebDataJson.storage；
 * ④ credentials（G7-S6 frontmatter credential: 段）→ WebDataJson.credentials；
 * ⑤ components（S5b X18 组件映射段三张表）→ WebDataJson.components；
 * ⑥ adversarialCases（S4/S6 产物 test-cases.json）→ WebDataJson.adversarialCases；
 * ⑦ 老模型缺省路径：六个字段全部 undefined / JSON 序列化不出现（零回归）。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildWebData,
  buildStorageView,
  buildComponentsView,
  buildInvariantsView,
  type WebDataJson,
} from '../../src/webgen/index.js';
import { parseProtocolFile } from '../../src/parser/index.js';
import type {
  SourceProtocolModel,
  TestCaseSet,
  CredentialDeclaration,
  AdversarialCase,
} from '../../src/model/types.js';
import type { DimensionKindEntry } from '../../src/model/dimension-kind.js';
import type { StorageSchema } from '../../src/storagegen/index.js';
import type { SpecsEnvelope } from '../../src/specifier/envelope.js';

const EXAMPLE_DIR = '/work/protochain/examples/anonymous-saas';

const NEW_FIELD_KEYS = [
  'dimensions',
  'modelRelations',
  'storage',
  'credentials',
  'components',
  'adversarialCases',
] as const;

// ---------------------------------------------------------------------------
// 辅助：构造 inputs
// ---------------------------------------------------------------------------

function loadAnonymousSaaSInputs(): {
  specsEnvelope: SpecsEnvelope;
  model: SourceProtocolModel;
  storage: StorageSchema;
  testCases: TestCaseSet;
} {
  const model = parseProtocolFile(join(EXAMPLE_DIR, 'protocol/model.md'));
  const specsEnvelope = JSON.parse(
    readFileSync(join(EXAMPLE_DIR, 'derived/specs.json'), 'utf-8')
  ) as SpecsEnvelope;
  const storage = JSON.parse(
    readFileSync(join(EXAMPLE_DIR, 'derived/storage.schema.json'), 'utf-8')
  ) as StorageSchema;
  const testCases = JSON.parse(
    readFileSync(join(EXAMPLE_DIR, 'derived/test-cases.json'), 'utf-8')
  ) as TestCaseSet;
  return { specsEnvelope, model, storage, testCases };
}

/** 构造老模型（无任何 G7 新数据）最小 IR */
function makeLegacyModel(): SourceProtocolModel {
  return {
    metadata: {
      name: 'legacy',
      version: '1.0.0',
      purpose: '老模型',
      roles: [{ id: 'role1', name: '角色1', roleType: 'participant' }],
    },
    readable: {
      background: '老模型背景',
      concepts: [],
      workflow: '老模型流程',
    },
    derivable: {
      degraded: false,
      initialStateId: 'S0',
      terminalStateIds: ['S1'],
      states: [{ id: 'S0', name: '初态', type: 'initial' }],
      transitions: [
        {
          id: 'T1',
          name: 't1',
          from: ['S0'],
          to: 'S1',
          action: 'do_it',
          triggerType: 'role',
          trigger: 'role1',
          actionType: 'state_transition',
          affectsDimensions: [],
        },
      ],
      invariants: [],
      timing: [],
      exceptions: [],
    },
  };
}

function makeLegacyEnvelope(): SpecsEnvelope {
  return {
    schemaVersion: '1.0',
    generatedAt: '2026-08-30T00:00:00.000Z',
    sourceModelVersion: '1.0.0',
    specs: [],
  };
}

// ---------------------------------------------------------------------------
// ① dimensions（specs.json 顶层，S1 产物）
// ---------------------------------------------------------------------------

describe('WebDataJson.dimensions（S1 维度 kind 判定投影）', () => {
  test('anonymous-saas：17 条维度带 kind/kindSource/writers 原样投影', () => {
    const { specsEnvelope, model, storage, testCases } = loadAnonymousSaaSInputs();
    const data = buildWebData({ specsEnvelope, model, testCases, storage });
    expect(data.dimensions).toBeDefined();
    expect(data.dimensions!.length).toBe(17);
    const first = data.dimensions![0];
    expect(first).toMatchObject({
      owner: 'resource',
      dimension: '形态',
      kind: 'declared',
      kindSource: 'asserted',
    });
    expect(Array.isArray(first.writers)).toBe(true);
    // 与 specs.json 源数据一致（原样投影）
    expect(data.dimensions).toEqual(specsEnvelope.dimensions);
  });

  test('老模型（specs 无 dimensions）→ 字段缺省且 JSON 序列化不出现', () => {
    const data = buildWebData({ specsEnvelope: makeLegacyEnvelope(), model: makeLegacyModel() });
    expect(data.dimensions).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain('"dimensions"');
  });
});

// ---------------------------------------------------------------------------
// ② modelRelations（V1 关系段，DerivableLayer.relations）
// ---------------------------------------------------------------------------

describe('WebDataJson.modelRelations（V1 关系段投影）', () => {
  test('anonymous-saas：12 条关系 from/to/type/constraint/onGone 原样投影', () => {
    const { specsEnvelope, model, storage, testCases } = loadAnonymousSaaSInputs();
    const data = buildWebData({ specsEnvelope, model, testCases, storage });
    expect(data.modelRelations).toBeDefined();
    expect(data.modelRelations!.length).toBe(12);
    const first = data.modelRelations![0];
    expect(first).toMatchObject({
      from: 'resource',
      to: 'account',
      type: '绑定',
    });
    expect(typeof first.constraint).toBe('string');
    expect(typeof first.onGone).toBe('string');
    // 与 IR 关系段一致（原样投影）
    expect(data.modelRelations).toEqual(model.derivable.relations);
  });

  test('老模型（无「关系」段）→ 字段缺省且 JSON 序列化不出现', () => {
    const data = buildWebData({ specsEnvelope: makeLegacyEnvelope(), model: makeLegacyModel() });
    expect(data.modelRelations).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain('"modelRelations"');
  });
});

// ---------------------------------------------------------------------------
// ③ storage（S3 derive-storage 产物）
// ---------------------------------------------------------------------------

describe('buildStorageView + WebDataJson.storage（S3 存储 schema 投影）', () => {
  test('anonymous-saas：17 维度全覆盖，entities[].dimensions[].{name,type,kind} 归一投影', () => {
    const { specsEnvelope, model, storage, testCases } = loadAnonymousSaaSInputs();
    const data = buildWebData({ specsEnvelope, model, testCases, storage });
    expect(data.storage).toBeDefined();
    expect(data.storage!.dimensionCount).toBe(17);
    expect(data.storage!.coveredDimensionCount).toBe(17);
    expect(data.storage!.coverageRate).toBe(1);
    const entity = data.storage!.entities[0];
    expect(entity.entity).toBe('resource');
    expect(entity.dimensionCount).toBe(5);
    expect(entity.dimensions[0]).toEqual({ name: '形态', type: 'TODO', kind: 'declared' });
    // 每列归一投影：name=dimension、type=type、kind=kind
    for (const e of data.storage!.entities) {
      for (const d of e.dimensions) {
        expect(typeof d.name).toBe('string');
        expect(typeof d.type).toBe('string');
        expect(['declared', 'observed', 'undetermined']).toContain(d.kind);
      }
    }
  });

  test('buildStorageView：未提供 storage → undefined（字段缺省路径）', () => {
    expect(buildStorageView(undefined)).toBeUndefined();
  });

  test('buildStorageView：空骨架（dimensionCount=0）→ 空 entities 视图', () => {
    const empty: StorageSchema = {
      schemaVersion: '1.0',
      kind: 'storage-schema',
      generatedAt: '2026-08-30T00:00:00.000Z',
      sourceModelVersion: '1.0.0',
      dimensionCount: 0,
      coveredDimensionCount: 0,
      coverageRate: 1,
      entities: [],
      schemaDegradedReasons: [],
      warnings: [],
    };
    const view = buildStorageView(empty);
    expect(view).toEqual({
      dimensionCount: 0,
      coveredDimensionCount: 0,
      coverageRate: 1,
      entities: [],
    });
  });

  test('老模型（未运行 derive-storage）→ 字段缺省且 JSON 序列化不出现', () => {
    const data = buildWebData({ specsEnvelope: makeLegacyEnvelope(), model: makeLegacyModel() });
    expect(data.storage).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain('"storage"');
  });
});

// ---------------------------------------------------------------------------
// ④ credentials（G7-S6 frontmatter credential: 段）
// ---------------------------------------------------------------------------

describe('WebDataJson.credentials（G7-S6 凭证声明投影）', () => {
  test('anonymous-saas：3 条凭证七列原样投影', () => {
    const { specsEnvelope, model, storage, testCases } = loadAnonymousSaaSInputs();
    const data = buildWebData({ specsEnvelope, model, testCases, storage });
    expect(data.credentials).toBeDefined();
    expect(data.credentials!.length).toBe(3);
    const claim: CredentialDeclaration = data.credentials![0];
    expect(claim).toMatchObject({
      name: '认领码',
      issuer: 'system',
      holder: 'publisher_tool',
      redeemer: 'account_holder',
      selfContained: 'needs-lookup',
    });
    expect(typeof claim.ttl).toBe('string');
    expect(typeof claim.revoke).toBe('string');
    expect(typeof claim.premise).toBe('string');
    // 与 IR metadata.credentials 一致（原样投影）
    expect(data.credentials).toEqual(model.metadata.credentials);
  });

  test('老模型（无 credential: 段）→ 字段缺省且 JSON 序列化不出现', () => {
    const data = buildWebData({ specsEnvelope: makeLegacyEnvelope(), model: makeLegacyModel() });
    expect(data.credentials).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain('"credentials"');
  });
});

// ---------------------------------------------------------------------------
// ⑤ components（S5b X18 组件映射三张表）
// ---------------------------------------------------------------------------

describe('buildComponentsView + WebDataJson.components（S5b X18 组件映射投影）', () => {
  test('anonymous-saas：三张表投影（interfaceImplementations/dimensionStorage/componentTransfers）', () => {
    const { specsEnvelope, model, storage, testCases } = loadAnonymousSaaSInputs();
    const data = buildWebData({ specsEnvelope, model, testCases, storage });
    expect(data.components).toBeDefined();
    expect(data.components!.interfaceImplementations.length).toBeGreaterThan(0);
    expect(data.components!.dimensionStorage.length).toBe(17);
    expect(data.components!.componentTransfers.length).toBe(2);
    const ii = data.components!.interfaceImplementations[0];
    expect(ii.interface).toBeTruthy();
    expect(ii.component).toBeTruthy();
    const ds = data.components!.dimensionStorage[0];
    expect(ds.dimension).toBeTruthy();
    expect(ds.table).toBeTruthy();
    const ct = data.components!.componentTransfers[0];
    expect(ct.from).toBe('control-plane');
    expect(ct.to).toBe('data-plane');
    expect(ct.channel).toBe('event');
    expect(['sync', 'async']).toContain(ct.mode);
  });

  test('buildComponentsView：无「组件映射」段 → undefined（字段缺省路径）', () => {
    expect(buildComponentsView(undefined)).toBeUndefined();
  });

  test('老模型（无「组件映射」段）→ 字段缺省且 JSON 序列化不出现', () => {
    const data = buildWebData({ specsEnvelope: makeLegacyEnvelope(), model: makeLegacyModel() });
    expect(data.components).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain('"components"');
  });
});

// ---------------------------------------------------------------------------
// ⑥ adversarialCases（S4/S6 产物 test-cases.json）
// ---------------------------------------------------------------------------

describe('WebDataJson.adversarialCases（G7-S4/S6 对抗性用例投影）', () => {
  test('anonymous-saas：27 条 id/kind/source/interfaceId/body/expected* 原样投影', () => {
    const { specsEnvelope, model, storage, testCases } = loadAnonymousSaaSInputs();
    const data = buildWebData({ specsEnvelope, model, testCases, storage });
    expect(data.adversarialCases).toBeDefined();
    expect(data.adversarialCases!.length).toBe(27);
    const kinds = new Set(data.adversarialCases!.map((c) => c.kind));
    expect(kinds.has('observed-write')).toBe(true);
    expect(kinds.has('convergence')).toBe(true);
    expect(kinds.has('credential-expired')).toBe(true);
    expect(kinds.has('credential-revoked')).toBe(true);
    expect(kinds.has('credential-lookup')).toBe(true);
    const x5: AdversarialCase = data.adversarialCases![0];
    expect(x5.id).toMatch(/^X5_/);
    expect(x5.source).toBeTruthy();
    expect(x5.interfaceId).toBeTruthy();
    expect(x5.expectFailure).toBe(true);
    expect(typeof x5.body).toBe('string');
    // 与 test-cases.json 一致（原样投影）
    expect(data.adversarialCases).toEqual(testCases.adversarialCases);
  });

  test('老模型（test-cases.json 无 adversarialCases）→ 字段缺省且 JSON 序列化不出现', () => {
    const data = buildWebData({ specsEnvelope: makeLegacyEnvelope(), model: makeLegacyModel() });
    expect(data.adversarialCases).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain('"adversarialCases"');
  });

  test('testCases 完全缺失（未生成 test-cases.json）→ 字段缺省', () => {
    const data = buildWebData({ specsEnvelope: makeLegacyEnvelope(), model: makeLegacyModel() });
    expect(data.adversarialCases).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ⑧ invariants（G7-V4 不变量投影，协议层视图 §11.3 数据源）
// ---------------------------------------------------------------------------

describe('WebDataJson.invariants（G7-V4 不变量投影）', () => {
  test('anonymous-saas：11 条 id/name/expression/subject/timing/bound/remedy/dimensions 投影', () => {
    const { specsEnvelope, model, storage, testCases } = loadAnonymousSaaSInputs();
    const data = buildWebData({ specsEnvelope, model, testCases, storage });
    expect(data.invariants).toBeDefined();
    expect(data.invariants!.length).toBe(11);
    const byId = new Map(data.invariants!.map((i) => [i.id, i]));
    // INV-1：强一致 → always；subject=作用状态 S2；expression 涉及维度 访问策略/归属状态/处置状态
    const inv1 = byId.get('INV-1')!;
    expect(inv1).toMatchObject({
      name: '放行须已认领且正常',
      timing: 'always',
      subject: ['S2'],
      level: 'state-machine',
    });
    expect(inv1.expression).toContain('访问策略');
    expect(inv1.dimensions).toEqual(expect.arrayContaining(['访问策略', '归属状态', '处置状态']));
    expect(inv1.remedy).toBeDefined();
    expect(typeof inv1.remedy!.action).toBe('string');
    // 最终一致 → eventually_within：TM1（deadline target=INV-3, 30000ms）、TM4（target=INV-6, 60000ms）
    const inv3 = byId.get('INV-3')!;
    expect(inv3.timing).toBe('eventually_within');
    expect(inv3.bound).toBe(30000);
    const inv6 = byId.get('INV-6')!;
    expect(inv6.timing).toBe('eventually_within');
    expect(inv6.bound).toBe(60000);
    // 时间语义分布：always 4（INV-1/2/7/10）· eventually_within 7（INV-3/4/5/6/8/9/11）
    const always = data.invariants!.filter((i) => i.timing === 'always').length;
    const ev = data.invariants!.filter((i) => i.timing === 'eventually_within').length;
    expect(always).toBe(4);
    expect(ev).toBe(7);
  });

  test('老模型（无「不变量」段）→ 字段缺省且 JSON 序列化不出现', () => {
    const data = buildWebData({ specsEnvelope: makeLegacyEnvelope(), model: makeLegacyModel() });
    expect(data.invariants).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain('"invariants"');
  });

  test('buildInvariantsView：无不变量 → undefined（字段缺省路径）', () => {
    expect(buildInvariantsView(makeLegacyModel(), ['形态'])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ⑦ 老模型缺省路径汇总（零回归）
// ---------------------------------------------------------------------------

describe('老模型缺省路径（六个新字段全部缺省，零回归）', () => {
  test('buildWebData 老模型 → 六字段全部 undefined', () => {
    const data = buildWebData({ specsEnvelope: makeLegacyEnvelope(), model: makeLegacyModel() });
    for (const k of NEW_FIELD_KEYS) {
      expect((data as unknown as Record<string, unknown>)[k]).toBeUndefined();
    }
  });

  test('老模型 JSON 序列化 → 六个新字段键全部不出现（既有字段逐字节保持）', () => {
    const data = buildWebData({ specsEnvelope: makeLegacyEnvelope(), model: makeLegacyModel() });
    const json = JSON.stringify(data);
    for (const k of NEW_FIELD_KEYS) {
      expect(json).not.toContain(`"${k}"`);
    }
    // 既有字段结构完整（schemaVersion / relations / stateMachine 等仍在）
    const parsed = JSON.parse(json) as WebDataJson;
    expect(parsed.schemaVersion).toBe('1.0');
    expect(parsed.protocol.name).toBe('legacy');
    expect(parsed.relations).toBeDefined();
    expect(parsed.stateMachine).toBeDefined();
    expect(parsed.exceptionPaths).toBeUndefined(); // 无异常路径 → 缺省（既有行为）
  });
});
