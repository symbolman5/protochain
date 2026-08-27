/**
 * G6 T4 · checker 示例断言单测（10 §17.3 C-G6-4 / 13-execution-G6 T4 验收）
 *
 * 覆盖：
 *  - G6-1：示例字段集 ⊆ schema 叶子 → pass；人为注入超集字段 → 硬失败（反向）；
 *  - G6-2：codeSamples 含空 code → 失败；非空 → pass；
 *  - G6-1③：老模型无 schema → 示例记 null → 不硬失败。
 * 复用既有 CheckIssue/MechanicalCheckResult 形态（severity=error → passed=false）。
 */
import { checkInterfaceDetailsExamples } from '../../src/checker/index.js';
import type { ProjectInterfaceDetailData } from '../../src/model/types.js';

function makeData(entriesPatch: Record<string, unknown>): ProjectInterfaceDetailData {
  return {
    schemaVersion: '1.1',
    kind: 'interface-details',
    generatedAt: '2026-08-27T00:00:00.000Z',
    protocolVersions: { P1: '1.0.0' },
    entries: {
      P1: {
        IF_SYS_T1: {
          protocolId: 'P1',
          interface: {
            id: 'IF_SYS_T1',
            name: '确认订单',
            kind: 'system',
            sourceId: 'confirm_order',
            description: '',
            interfaceType: 'state_machine',
            requestSchema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] },
            responseSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
            inputs: [],
            outputs: [],
            postconditions: [],
            errorResponses: [],
            ...entriesPatch,
          } as unknown as ProjectInterfaceDetailData['entries']['P1']['IF_SYS_T1']['interface'],
          relation: { ownedTransitions: [], preconditionStates: [], postconditionStates: [], coveredInvariants: [], diffImpact: { affected: false } },
          binding: null,
          crossRefs: [],
        },
      },
    },
  } as ProjectInterfaceDetailData;
}

describe('G6 T4 · checkInterfaceDetailsExamples', () => {
  test('G6-1：示例字段 ⊆ schema 叶子 → pass', () => {
    const data = makeData({
      requestExample: { order_id: 'x' },
      responseExample: { ok: true },
      codeSamples: [{ lang: 'curl', label: 'curl', code: 'curl ...' }],
    });
    const r = checkInterfaceDetailsExamples(data);
    expect(r.passed).toBe(true);
    expect(r.fieldIssues).toHaveLength(0);
  });

  test('G6-1 反向：示例含 schema 外字段 → 硬失败', () => {
    const data = makeData({
      requestExample: { order_id: 'x', evil_field: 1 },
      responseExample: { ok: true },
      codeSamples: [{ lang: 'curl', label: 'curl', code: 'curl ...' }],
    });
    const r = checkInterfaceDetailsExamples(data);
    expect(r.passed).toBe(false);
    expect(r.fieldIssues.some((i) => i.message.includes('evil_field'))).toBe(true);
  });

  test('G6-2：codeSamples 含空 code → 失败；非空 → pass', () => {
    const bad = makeData({
      requestExample: { order_id: 'x' },
      responseExample: { ok: true },
      codeSamples: [{ lang: 'curl', label: 'curl', code: '' }],
    });
    expect(checkInterfaceDetailsExamples(bad).passed).toBe(false);

    const good = makeData({
      requestExample: { order_id: 'x' },
      responseExample: { ok: true },
      codeSamples: [{ lang: 'curl', label: 'curl', code: 'curl -X POST' }],
    });
    expect(checkInterfaceDetailsExamples(good).passed).toBe(true);
  });

  test('G6-1③：老模型无 schema → 示例记 null → 不硬失败', () => {
    const data = makeData({ requestSchema: undefined, responseSchema: undefined, requestExample: null, responseExample: null });
    const r = checkInterfaceDetailsExamples(data);
    expect(r.passed).toBe(true);
  });

  test('G6-2：codeSamples 缺省（undefined）→ 不硬失败', () => {
    const data = makeData({ requestExample: { order_id: 'x' }, responseExample: { ok: true } });
    const r = checkInterfaceDetailsExamples(data);
    expect(r.passed).toBe(true);
  });
});
