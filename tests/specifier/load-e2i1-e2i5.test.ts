/**
 * E2-I1/E2-I3/E2-I5 修复后回归测试
 *
 * 设计依据：IMPLEMENTATION-ISSUES.md §E2-I1 / §E2-I3 / §E2-I5
 *
 * 覆盖：
 * - E2-I1：loadSpecsEnvelope 自动解 Envelope / 兼容裸数组（不崩 resolveBindings）
 * - E2-I3：envelopeMigrate 复用 classifySchemaKind 口径统一
 * - E2-I5：损坏 specs.json 显式抛错（不再静默兜底空 Envelope）+ 不就地修改输入
 */

import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadSpecsEnvelope,
} from '../../src/specifier/load.js';
import {
  envelopeMigrate,
  isSpecsEnvelope,
  SPECS_ENVELOPE_SCHEMA_VERSION,
} from '../../src/specifier/envelope.js';
import { parseProtocolContent } from '../../src/parser/index.js';
import { specify, specsFromEnvelope } from '../../src/specifier/index.js';

// =============================================================================
// E2-I3 修复：envelopeMigrate 与 classifySchemaKind 口径统一
// =============================================================================

describe('E2-I3 schemaKind 口径统一', () => {
  test('裸数组中的 spec 经 envelopeMigrate 后的 schemaKind 与 classifySchemaKind 完全一致', () => {
    const legacyArr = [
      // 有 requestSchema + responseSchema → structured（与 classifySchemaKind 一致）
      {
        id: 'A', kind: 'system', sourceId: 'A', name: 'A',
        inputs: [],
        outputs: [{ name: 'nextState', type: 'string' }],
        requestSchema: { type: 'object', properties: { a: { type: 'string' } } },
        responseSchema: { type: 'object', properties: { nextState: { type: 'string' } } },
      },
      // 完全无 schema 字段 → description-only（与 classifySchemaKind 一致）
      {
        id: 'B', kind: 'system', sourceId: 'B', name: 'B',
        inputs: [],
        outputs: [],
      },
      // 仅 requestSchema，无 responseSchema → legacy-stub（与 classifySchemaKind 一致）
      {
        id: 'C', kind: 'system', sourceId: 'C', name: 'C',
        inputs: [{ name: 'a', type: 'string' }],
        outputs: [{ name: 'nextState', type: 'string' }],
        requestSchema: { type: 'object', properties: { a: { type: 'string' } } },
      },
    ];
    const r = envelopeMigrate(legacyArr, '1.0.0');
    const a = r.envelope.specs.find((s) => s.id === 'A')!;
    const b = r.envelope.specs.find((s) => s.id === 'B')!;
    const c = r.envelope.specs.find((s) => s.id === 'C')!;
    expect(a.schemaKind).toBe('structured');
    expect(b.schemaKind).toBe('description-only');
    expect(c.schemaKind).toBe('legacy-stub');
  });

  test('envelopeMigrate 与 specifier 主路径 schemaKind 一致（同一 model 双路径）', () => {
    // E2-I3 关键属性：envelopeMigrate 分类与 specifier 主路径完全一致，
    // 因为两者共用 classifySchemaKind（不再有 envelopeMigrate 自带启发式）
    const model = parseProtocolContent(`---
name: 协议
version: 1.0.0
purpose: 测试
roles:
  - id: user
    name: 用户
---
# 状态空间
| ID | 名称 | 类型 |
|---|---|---|
| S1 | 初始 | initial |
| S2 | 终态 | terminal |

# 转移规则
| ID | 名称 | from | to | action | trigger | guard |
|---|---|---|---|---|---|---|
| T1 | 提交 | S1 | S2 | submit | user | form_valid |
| T2 | 直接 | S1 | S2 | direct | user | count > 0 |
`);

    // 主路径直接 derive
    const primary = specsFromEnvelope(specify(model));

    // 走 envelopeMigrate 路径：序列化为裸数组（含 schemaKind, preconditions）
    const legacyArr = primary.map((s) => ({
      id: s.id,
      kind: s.kind,
      sourceId: s.sourceId,
      name: s.name,
      inputs: s.inputs,
      outputs: s.outputs,
      requestSchema: s.requestSchema,
      responseSchema: s.responseSchema,
      preconditions: s.preconditions,
    }));
    const r = envelopeMigrate(legacyArr, model.metadata.version);

    // 主路径与 migrate 路径在 schemaKind 上应一致
    for (const s of primary) {
      const migrated = r.envelope.specs.find((m) => m.id === s.id);
      expect(migrated).toBeDefined();
      expect(s.schemaKind).toBe(migrated!.schemaKind);
    }
    // 关键不变量：单标识符 guard → legacy-stub（不论走哪条路径）
    expect(primary.find((s) => s.sourceId === 'submit')!.schemaKind).toBe('legacy-stub');
    expect(r.envelope.specs.find((s) => s.sourceId === 'submit')!.schemaKind).toBe('legacy-stub');
    // 结构化 guard → structured
    expect(primary.find((s) => s.sourceId === 'direct')!.schemaKind).toBe('structured');
    expect(r.envelope.specs.find((s) => s.sourceId === 'direct')!.schemaKind).toBe('structured');
  });
});

// =============================================================================
// E2-I5 修复：envelopeMigrate 不就地修改输入 + 显式错误
// =============================================================================

describe('E2-I5 envelopeMigrate 不修改输入', () => {
  test('裸数组输入不被就地修改', () => {
    const legacyArr = [
      { id: 'A', kind: 'system', sourceId: 'A', name: 'A', inputs: [], outputs: [] },
    ];
    const snapshot = JSON.stringify(legacyArr);
    envelopeMigrate(legacyArr, '1.0.0');
    // envelopeMigrate 后，原数组应未被修改（schemaKind 等字段未被新增）
    expect(JSON.stringify(legacyArr)).toBe(snapshot);
    expect(legacyArr[0]).not.toHaveProperty('schemaKind');
  });

  test('损坏形态（如 {"foo":1}）：返回 migrated=false + parseError 显式标注', () => {
    const r = envelopeMigrate({ foo: 1 }, '1.0.0');
    expect(r.migrated).toBe(false);
    expect(r.parseError).toBeDefined();
    expect(r.parseError).toContain('无法识别');
    // Envelope 仍保留（空 specs + parseError），不再静默空 Envelope
    expect(r.envelope.specs).toEqual([]);
    expect(r.envelope.parseError).toBeDefined();
  });

  test('损坏形态（如 null）：返回 migrated=false', () => {
    const r = envelopeMigrate(null, '1.0.0');
    expect(r.migrated).toBe(false);
    expect(r.parseError).toBeDefined();
  });

  test('损坏形态（如 字符串）：返回 migrated=false', () => {
    const r = envelopeMigrate('not a json', '1.0.0');
    expect(r.migrated).toBe(false);
    expect(r.parseError).toBeDefined();
  });

  test('loadSpecsEnvelope 遇损坏形态抛出显式错误（不再静默）', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'protochain-load-e2i5-'));
    const dir = join(tmp, 'derived');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'specs.json');
    writeFileSync(path, JSON.stringify({ foo: 1 }), 'utf-8');
    expect(() => loadSpecsEnvelope(tmp, '1.0.0')).toThrow(/无法识别/);
  });

  test('文件不存在 → 返回 undefined（不抛错）', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'protochain-load-empty-'));
    const r = loadSpecsEnvelope(tmp, '1.0.0');
    expect(r).toBeUndefined();
  });
});

// =============================================================================
// E2-I1 修复：loadSpecsEnvelope 与 envelope/裸数组兼容
// =============================================================================

describe('E2-I1 loadSpecsEnvelope 公共 helper', () => {
  function writeSpecs(tmp: string, content: object): string {
    const dir = join(tmp, 'derived');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'specs.json');
    writeFileSync(path, JSON.stringify(content, null, 2), 'utf-8');
    return path;
  }

  test('Enveloped specs 加载：返回 source=envelope + specs', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'protochain-load-env-'));
    writeSpecs(tmp, {
      schemaVersion: SPECS_ENVELOPE_SCHEMA_VERSION,
      generatedAt: '2026-08-22T00:00:00Z',
      sourceModelVersion: '1.0.0',
      specs: [
        { id: 'A', kind: 'system', sourceId: 'A', name: 'A', inputs: [], outputs: [] },
      ],
    });
    const r = loadSpecsEnvelope(tmp, '1.0.0')!;
    expect(r.source).toBe('envelope');
    expect(r.migrated).toBe(false);
    expect(r.specs.length).toBe(1);
  });

  test('裸数组 specs 加载：自动 migrate + source=array-migrated', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'protochain-load-legacy-'));
    writeSpecs(tmp, [
      { id: 'A', kind: 'system', sourceId: 'A', name: 'A', inputs: [], outputs: [] },
    ]);
    const warnings: string[] = [];
    const r = loadSpecsEnvelope(tmp, '1.0.0', (w) => warnings.push(w))!;
    expect(r.source).toBe('array-migrated');
    expect(r.migrated).toBe(true);
    expect(r.specs.length).toBe(1);
    // 迁移报警通过 callback 触发
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('老格式');
  });

  test('文件不存在 → 返回 undefined（caller 决定 fallback）', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'protochain-load-none-'));
    const r = loadSpecsEnvelope(tmp, '1.0.0');
    expect(r).toBeUndefined();
  });

  test('isSpecsEnvelope 静态类型守卫', () => {
    expect(isSpecsEnvelope({
      schemaVersion: '1.0',
      specs: [],
    })).toBe(true);
    expect(isSpecsEnvelope([{ id: 'A' }])).toBe(false);
    expect(isSpecsEnvelope({ foo: 1 })).toBe(false);
    expect(isSpecsEnvelope(null)).toBe(false);
    expect(isSpecsEnvelope(undefined)).toBe(false);
  });
});
