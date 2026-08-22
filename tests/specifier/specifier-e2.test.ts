/**
 * E2 specs.json 升级到 JSON Schema —— 单测
 *
 * 设计依据：IMPLEMENTATION-ACCEPTANCE.md §E2
 *
 * 覆盖：
 * - ajv 编译 specs.json 全部通过
 * - 抽查接口 requestSchema / responseSchema 非空
 * - 老格式 specs.json 自动迁移 + kind="legacy-stub" 标记 + 无报错
 * - specifier 主入口返回 envelope 含 schemaVersion + 派生 schema
 * - guard 自然语言降级为 legacy-stub
 * - 退化模式自动标 description-only
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProtocolContent } from '../../src/parser/index.js';
import {
  specify,
  specsFromEnvelope,
  envelopeMigrate,
  isSpecsEnvelope,
  SPECS_ENVELOPE_SCHEMA_VERSION,
} from '../../src/specifier/index.js';
import {
  validateSchemas,
  formatSchemaValidationReport,
} from '../../src/specifier/schema-validate.js';

const FIXTURES = join(process.cwd(), 'tests/fixtures');
function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf-8');
}

// ============================================================================
// ajv 编译 specs.json 全部通过
// ============================================================================

describe('E2 ajv 编译 specs.json 全部通过', () => {
  test('审批流协议：所有 spec 的 requestSchema/responseSchema 通过 ajv 编译', () => {
    const model = parseProtocolContent(readFixture('approval-flow.md'));
    const envelope = specify(model);
    const result = validateSchemas(envelope.specs);
    expect(result.passed).toBe(true);
    expect(result.perSpec.length).toBe(envelope.specs.length);
    for (const r of result.perSpec) {
      expect(r.requestSchemaCompiled).toBe(true);
      expect(r.responseSchemaCompiled).toBe(true);
    }
  });

  test('审批流协议：5 条 IF_SYS 接口 + 5 条 IF_OBS_STATE + 2 条 IF_OBS_INV + 0 attr/multi/pool', () => {
    const model = parseProtocolContent(readFixture('approval-flow.md'));
    const envelope = specify(model);
    const systemSpecs = envelope.specs.filter((s) => s.kind === 'system');
    const stateObs = envelope.specs.filter(
      (s) => s.kind === 'observation' && s.id.startsWith('IF_OBS_STATE_')
    );
    const invObs = envelope.specs.filter(
      (s) => s.kind === 'observation' && s.id.startsWith('IF_OBS_INV_')
    );
    expect(systemSpecs.length).toBe(model.derivable.transitions.length);
    expect(stateObs.length).toBe(model.derivable.states.length);
    expect(invObs.length).toBe(model.derivable.invariants.length);
  });

  test('saas-real-P1（含 attr_update/resource pool）所有 schema 通过 ajv 编译', () => {
    const model = parseProtocolContent(readFixture('saas-real-P1-user.md'));
    const envelope = specify(model);
    const result = validateSchemas(envelope.specs);
    expect(result.passed).toBe(true);
    expect(result.perSpec.length).toBeGreaterThan(0);
    // 报告输出不抛异常
    expect(formatSchemaValidationReport(result)).toContain('通过');
  });
});

// ============================================================================
// 抽查接口 requestSchema / responseSchema 非空
// ============================================================================

describe('E2 抽查接口 schema 完整性', () => {
  test('系统接口的 requestSchema.type="object" 且 properties.currentState 含 enum（E2-I7：含 `-` 占位）', () => {
    const model = parseProtocolContent(readFixture('approval-flow.md'));
    const envelope = specify(model);
    const submitSpec = envelope.specs.find((s) => s.name === 'submit')!;
    expect(submitSpec).toBeDefined();
    expect(submitSpec.requestSchema?.type).toBe('object');
    expect(submitSpec.requestSchema?.properties?.currentState).toBeDefined();
    expect(submitSpec.requestSchema?.properties?.currentState.enum).toEqual(
      expect.arrayContaining(['S1', 'S2', 'S3', 'S4', 'S5'])
    );
    // currentState 含 `-` 占位
    expect(submitSpec.requestSchema?.properties?.currentState.enum).toContain('-');
    // E2-I2 修复：form_valid 是单标识符谓词，不应作为请求输入字段
    expect(submitSpec.requestSchema?.properties?.form_valid).toBeUndefined();
  });

  test('系统接口的 responseSchema 含 nextState + nextState.enum 覆盖全部状态', () => {
    const model = parseProtocolContent(readFixture('approval-flow.md'));
    const envelope = specify(model);
    const submitSpec = envelope.specs.find((s) => s.name === 'submit')!;
    expect(submitSpec.responseSchema?.type).toBe('object');
    expect(submitSpec.responseSchema?.properties?.nextState).toBeDefined();
    expect(submitSpec.responseSchema?.properties?.nextState.enum).toEqual(
      expect.arrayContaining(['S1', 'S2', 'S3', 'S4', 'S5'])
    );
  });

  test('状态观测接口 responseSchema 含 isInState(boolean) + required', () => {
    const model = parseProtocolContent(readFixture('approval-flow.md'));
    const envelope = specify(model);
    const stateObs = envelope.specs.filter(
      (s) => s.kind === 'observation' && s.id.startsWith('IF_OBS_STATE_')
    )[0];
    expect(stateObs.responseSchema?.type).toBe('object');
    expect(stateObs.responseSchema?.properties?.isInState?.type).toBe('boolean');
    expect(stateObs.responseSchema?.required).toContain('isInState');
  });

  test('不变量观测接口 responseSchema 含 holds(boolean)', () => {
    const model = parseProtocolContent(readFixture('approval-flow.md'));
    const envelope = specify(model);
    const invObs = envelope.specs.filter(
      (s) => s.kind === 'observation' && s.id.startsWith('IF_OBS_INV_')
    )[0];
    expect(invObs.responseSchema?.properties?.holds?.type).toBe('boolean');
  });

  test('preconditions 与 guard 对应（form_valid，E2-I2 修复：单标识符 → legacy-stub）', () => {
    const model = parseProtocolContent(readFixture('approval-flow.md'));
    const envelope = specify(model);
    const submitSpec = envelope.specs.find((s) => s.name === 'submit')!;
    expect(submitSpec.preconditions).toBeDefined();
    expect(submitSpec.preconditions!.length).toBeGreaterThan(0);
    const firstGuard = submitSpec.preconditions![0];
    // E2-I2：单标识符（谓词形） guard 标记为 legacy-stub（自然语言未机械提取）
    expect(firstGuard.kind).toBe('legacy-stub');
    expect(firstGuard.description).toContain('form_valid');
    // schemaKind 也应是 legacy-stub（precondition 单标识符谓词降级）
    expect(submitSpec.schemaKind).toBe('legacy-stub');
  });
});

// ============================================================================
// E2 envelope 形态约束
// ============================================================================

describe('E2 envelope 形态', () => {
  test('specify 返回 envelope（含 schemaVersion=1.0, generatedAt, sourceModelVersion）', () => {
    const model = parseProtocolContent(readFixture('approval-flow.md'));
    const envelope = specify(model);
    expect(envelope.schemaVersion).toBe(SPECS_ENVELOPE_SCHEMA_VERSION);
    expect(envelope.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(envelope.sourceModelVersion).toBe('1.0.0');
    expect(Array.isArray(envelope.specs)).toBe(true);
  });

  test('isSpecsEnvelope 区分 envelope 与裸数组', () => {
    const model = parseProtocolContent(readFixture('approval-flow.md'));
    const env = specify(model);
    expect(isSpecsEnvelope(env)).toBe(true);
    // 裸数组形式的 InterfaceSpec[]
    const rawArr = env.specs;
    expect(isSpecsEnvelope(rawArr)).toBe(false);
    // null / undefined / 其它对象
    expect(isSpecsEnvelope(null)).toBe(false);
    expect(isSpecsEnvelope(undefined)).toBe(false);
    expect(isSpecsEnvelope({ schemaVersion: '1.0' })).toBe(false); // 缺 specs
  });

  test('specsFromEnvelope 提取数组', () => {
    const model = parseProtocolContent(readFixture('approval-flow.md'));
    const env = specify(model);
    const arr = specsFromEnvelope(env);
    expect(Array.isArray(arr)).toBe(true);
    expect(arr.length).toBe(env.specs.length);
  });
});

// ============================================================================
// 老格式 specs.json 自动迁移 + kind="legacy-stub" 标记
// ============================================================================

describe('E2 老格式兼容', () => {
  test('裸 InterfaceSpec[] 自动迁移到 Envelope（migrated=true + warnings）', () => {
    const model = parseProtocolContent(readFixture('approval-flow.md'));
    const freshEnvelope = specify(model);
    // 取裸数组作为"老格式"输入
    const legacyArray = freshEnvelope.specs.slice();
    const r = envelopeMigrate(legacyArray, model.metadata.version);
    expect(r.migrated).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.envelope.schemaVersion).toBe(SPECS_ENVELOPE_SCHEMA_VERSION);
    expect(r.envelope.migrated).toBe(true);
    expect(r.envelope.migrationWarnings).toBeDefined();
    // 至少一条总览警告
    expect(r.warnings[0]).toContain('老格式 specs.json 自动迁移');
  });

  test('迁移时按 spec 形态决定 schemaKind（E2-I3 修复：复用 classifySchemaKind）', () => {
    // 构造裸老格式：只有 name+type+description 三件套 + 部分 I/O 字段
    const legacyArr = [
      {
        id: 'IF_SYS_X',
        kind: 'system',
        sourceId: 'X',
        name: 'X',
        inputs: [{ name: 'p', type: 'string', description: 'p desc' }],
        outputs: [{ name: 'nextState', type: 'string', description: 'next' }],
        // 无 requestSchema / responseSchema 字段
      },
      {
        id: 'IF_SYS_Y',
        kind: 'system',
        sourceId: 'Y',
        name: 'Y',
        inputs: [],
        outputs: [],
      },
      {
        id: 'IF_SYS_Z',
        kind: 'system',
        sourceId: 'Z',
        name: 'Z',
        inputs: [{ name: 'a', type: 'string', description: 'a' }],
        outputs: [{ name: 'b', type: 'string', description: 'b' }],
        requestSchema: { type: 'object', properties: { a: { type: 'string' } } },
        responseSchema: { type: 'object', properties: { b: { type: 'string' } } },
      },
    ];
    const r = envelopeMigrate(legacyArr, '1.0.0');
    const x = r.envelope.specs.find((s) => s.id === 'IF_SYS_X')!;
    const y = r.envelope.specs.find((s) => s.id === 'IF_SYS_Y')!;
    const z = r.envelope.specs.find((s) => s.id === 'IF_SYS_Z')!;
    // X 无 schema 字段（既无 requestSchema 也无 responseSchema）→ description-only
    // E2-I3 修复：与 classifySchemaKind 一致（无 schema 字段 → description-only）
    expect(x.schemaKind).toBe('description-only');
    // Y 完全无 I/O 字段：description-only
    expect(y.schemaKind).toBe('description-only');
    // Z 有 schema 字段 → structured
    expect(z.schemaKind).toBe('structured');
  });

  test('已经是 Envelope 形态时原样返回（幂等）', () => {
    const model = parseProtocolContent(readFixture('approval-flow.md'));
    const env = specify(model);
    const r = envelopeMigrate(env, model.metadata.version);
    expect(r.migrated).toBe(false);
    expect(r.warnings.length).toBe(0);
    expect(r.envelope.schemaVersion).toBe(env.schemaVersion);
  });

  test('迁移后 ajv 校验：标记为 legacy-stub/description-only 的 spec 不强制要求 schema 编译通过', () => {
    const legacyArr = [
      {
        id: 'IF_OBS_STATE_X',
        kind: 'observation',
        sourceId: 'X',
        name: 'observe_X',
        inputs: [],
        outputs: [{ name: 'isInState', type: 'boolean', description: 'desc' }],
      },
    ];
    const r = envelopeMigrate(legacyArr, '1.0.0');
    const result = validateSchemas(r.envelope.specs);
    // description-only 应直接跳过 ajv 编译
    expect(result.passed).toBe(true);
  });
});

// ============================================================================
// 退化模式降级
// ============================================================================

describe('E2 退化模式降级', () => {
  test('退化模式 spec 标 description-only，不进 strict schema', () => {
    const model = parseProtocolContent(readFixture('degraded-protocol.md'));
    expect(model.derivable.degraded).toBe(true);
    const envelope = specify(model, { degradedAIAssist: true });
    for (const s of envelope.specs) {
      expect(s.schemaKind).toBe('description-only');
    }
  });
});

// ============================================================================
// 边界用例
// ============================================================================

describe('E2 边界用例', () => {
  test('无 transitions/invariants 的协议可正常推导 envelope', () => {
    // 仅一个状态
    const minimal = `---
name: 最小协议
version: 1.0.0
purpose: 测试
roles:
  - id: r1
    name: 角色1
---
# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S1 | 初始 | initial |
| S2 | 终态 | terminal |
`;
    const model = parseProtocolContent(minimal);
    const envelope = specify(model);
    expect(envelope.specs.length).toBeGreaterThan(0);
    // 2 个状态观测接口
    const stateObs = envelope.specs.filter((s) => s.id.startsWith('IF_OBS_STATE_'));
    expect(stateObs.length).toBe(2);
  });

  test('guard 含中文标点 → 标 legacy-stub（自然语言未机械提取）', () => {
    const model = parseProtocolContent(`---
name: 中文协议
version: 1.0.0
purpose: 测试
roles:
  - id: user
    name: 用户
    roleType: consensus
---
# 状态空间
| ID | 名称 | 类型 |
|---|---|---|
| S1 | 初始 | initial |
| S2 | 终态 | terminal |

# 转移规则
| ID | 名称 | from | to | action | trigger | guard | triggerType | actionType | affectsDimensions |
|---|---|---|---|---|---|---|---|---|---|
| T1 | 转移 | S1 | S2 | do_it | user | 状态 > 0，下次进入终态 | role | state_transition | |
`);
    const envelope = specify(model);
    const sysSpec = envelope.specs.find((s) => s.kind === 'system')!;
    // 自然语言 guard 含中文标点 → 标记 legacy-stub（同时也是 schemaKind='legacy-stub'，
    // 因为 requestSchema/responseSchema 仍存在但 guard 未进 schema）
    expect(sysSpec.preconditions?.[0]?.kind).toBe('legacy-stub');
    expect(sysSpec.schemaKind).toBe('legacy-stub');
  });
});
