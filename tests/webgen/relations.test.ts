/**
 * W1-a relations 机械投影单测（06-execution-T2 TB1）
 *
 * 机械判据（06 §TB1 验收 + §5 M3/M4/M5）：
 * ① 对 fixture 逐转移断言：每条转移至少产出一条 causes_state_change，
 *    derived-from 非空且元素均为存在的 transitionId/invariantId/timingId；
 * ② sequence 条目的 derived-from 恰为 2 个转移且衔接条件成立（Tm.to ∈ Tn.from）；
 * ③ timing 条目仅含 boundMs 型；fixture 中非 boundMs 型 TIM 每条对应一个 degraded 条目；
 * ④ sourceModelVersion === model.metadata.version，与 data.json 同批产物一致；
 * ⑤ 确定性（可 diff）：同输入两次生成 relations 逐字节一致（key 顺序稳定）；
 * ⑥ M4 一致性用例：改 model（增转移/改 invariant scope）→ 投影相应变化。
 */

import {
  buildRelations,
  type RelationsProjection,
  type RelationProjectionEntry,
} from '../../src/webgen/relations.js';
import { buildWebData } from '../../src/webgen/index.js';
import { parseProtocolFile } from '../../src/parser/index.js';
import { specify, envelopeMigrate, isSpecsEnvelope } from '../../src/specifier/index.js';
import type { SourceProtocolModel } from '../../src/model/types.js';

const FIXTURE_DIR = '/work/protochain/tests/fixtures';

function loadFoodDeliveryModel(): SourceProtocolModel {
  return parseProtocolFile(`${FIXTURE_DIR}/../../examples/food-delivery/protocol/model.md`);
}

function loadApprovalFlowModel(): SourceProtocolModel {
  return parseProtocolFile(`${FIXTURE_DIR}/approval-flow.md`);
}

/** 构造 specs Envelope（供 buildWebData 集成断言） */
function makeSpecsEnvelope(model: SourceProtocolModel) {
  const migrated = envelopeMigrate(specify(model).specs);
  if (!isSpecsEnvelope(migrated.envelope)) {
    throw new Error('specs envelope 构造失败');
  }
  return migrated.envelope;
}

function byKind(entries: RelationProjectionEntry[], kind: RelationProjectionEntry['kind']) {
  return entries.filter((e) => e.kind === kind);
}

describe('buildRelations（W1-a 投影）—— food-delivery fixture', () => {
  const model = loadFoodDeliveryModel();
  const proj = buildRelations(model);

  test('① 逐转移断言：每条转移至少一条 causes_state_change，derived-from 元素均存在', () => {
    const transitionIds = new Set(model.derivable.transitions.map((t) => t.id));
    const invariantIds = new Set((model.derivable.invariants ?? []).map((i) => i.id));
    const timingIds = new Set((model.derivable.timing ?? []).map((t) => t.id));
    const cs = byKind(proj.entries, 'causes_state_change');
    expect(cs.length).toBe(model.derivable.transitions.length); // 11 转移 → 11 条
    for (const t of model.derivable.transitions) {
      const entries = cs.filter((e) => e.fromId === t.id);
      expect(entries.length).toBeGreaterThanOrEqual(1); // 每条转移至少一条
      for (const e of entries) {
        expect(e.toId).toBe(t.to);
        expect(e.derivedFrom.length).toBeGreaterThan(0);
        for (const df of e.derivedFrom) {
          expect(transitionIds.has(df) || invariantIds.has(df) || timingIds.has(df)).toBe(true);
        }
      }
    }
  });

  test('② sequence：derived-from 恰为 2 个转移且衔接条件成立（Tm.to ∈ Tn.from）', () => {
    const seq = byKind(proj.entries, 'sequence');
    const byId = new Map(model.derivable.transitions.map((t) => [t.id, t]));
    for (const e of seq) {
      expect(e.derivedFrom.length).toBe(2);
      const [tmId, tnId] = e.derivedFrom;
      const tm = byId.get(tmId)!;
      const tn = byId.get(tnId)!;
      expect(e.fromId).toBe(tmId); // fromId = 前置转移 Tm
      expect(e.toId).toBe(tnId); // toId = 后置转移 Tn
      expect(tn.from.includes(tm.to)).toBe(true); // 衔接条件：Tm.to ∈ Tn.from
      expect(tmId).not.toBe(tnId);
    }
    // food-delivery 具体序列计数（人工可数：T1→T2/T7、T2→T3/T7/T8/T10、T3→T4、
    //   T4→T5/T5b、T5→T6/T9，共 11 条）
    expect(seq.length).toBe(11);
  });

  test('③ timing：仅 boundMs 型为正常条目；非 boundMs 型每条对应一个 degraded 条目', () => {
    const timingEntries = byKind(proj.entries, 'timing');
    const timingDefs = model.derivable.timing ?? [];
    const withBound = timingDefs.filter((t) => t.boundMs !== undefined);
    const withoutBound = timingDefs.filter((t) => t.boundMs === undefined);
    const normal = timingEntries.filter((e) => !e.degraded);
    const degraded = timingEntries.filter((e) => e.degraded);
    // 正常条目 = boundMs 型，逐条断言
    expect(normal.length).toBe(withBound.length);
    for (const e of normal) {
      expect(e.boundMs).toBeDefined();
      expect(e.degraded).toBeUndefined();
    }
    // food-delivery：TM1(timeout)/TM2(deadline) 正常；TM3(scheduled)/TM4(continuous) 降级
    expect(normal.map((e) => e.derivedFrom[0]).sort()).toEqual(['TM1', 'TM2']);
    // degraded 条目 = 非 boundMs 型，每条对应一个（含降级原因）
    expect(degraded.length).toBe(withoutBound.length);
    for (const e of degraded) {
      expect(e.boundMs).toBeUndefined();
      expect(e.degraded).toBe(true);
      expect(e.degradedReason).toBeTruthy();
    }
    expect(degraded.map((e) => e.derivedFrom[0]).sort()).toEqual(['TM3', 'TM4']);
  });

  test('③b invariant_scope：逐不变量一条，scopeStateIds 与模型一致（空 → 全部状态）', () => {
    const invEntries = byKind(proj.entries, 'invariant_scope');
    expect(invEntries.length).toBe((model.derivable.invariants ?? []).length); // 5
    const allStateIds = model.derivable.states.map((s) => s.id);
    const invById = new Map(model.derivable.invariants.map((i) => [i.id, i]));
    for (const e of invEntries) {
      expect(e.derivedFrom).toEqual([e.fromId]);
      const inv = invById.get(e.fromId)!;
      const expectedScope =
        inv.scopeStateIds && inv.scopeStateIds.length > 0
          ? inv.scopeStateIds
          : allStateIds;
      expect(e.scopeStateIds).toEqual(expectedScope);
    }
    // INV4（骑手在途单量受限）作用 S5
    const inv4 = invEntries.find((e) => e.fromId === 'INV4')!;
    expect(inv4.scopeStateIds).toEqual(['S5']);
    // INV1（金额一致性）作用 S1~S6
    const inv1 = invEntries.find((e) => e.fromId === 'INV1')!;
    expect(inv1.scopeStateIds).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6']);
  });

  test('④ sourceModelVersion === model.metadata.version，与 data.json 同批产物一致', () => {
    expect(proj.sourceModelVersion).toBe(model.metadata.version);
    const specsEnvelope = makeSpecsEnvelope(model);
    const data = buildWebData({ specsEnvelope, model });
    // 三处同源（M5）：relations.sourceModelVersion === data.relations.sourceModelVersion
    // === data.sourceModelVersion === model.metadata.version
    expect(data.relations.sourceModelVersion).toBe(model.metadata.version);
    expect(data.relations.sourceModelVersion).toBe(data.sourceModelVersion);
    expect(data.relations.entries.length).toBe(proj.entries.length);
  });

  test('⑤ 确定性：同输入两次生成逐字节一致（可 diff）', () => {
    const proj2 = buildRelations(model);
    expect(JSON.stringify(proj2)).toBe(JSON.stringify(proj));
    // 深层逐条目稳定（key 顺序稳定）
    expect(proj2.entries).toEqual(proj.entries);
  });

  test('⑥ M4 一致性用例：增一条转移 → 新增 causes_state_change 且受影响的 sequence 条目出现', () => {
    const clone = JSON.parse(JSON.stringify(model)) as SourceProtocolModel;
    clone.derivable.transitions.push({
      id: 'TX',
      name: '测试新增转移',
      from: ['S5'],
      to: 'S7',
      action: 'test_extra_action',
      triggerType: 'system',
      trigger: 'system',
      actionType: 'state_transition',
      affectsDimensions: [],
    });
    const p1 = buildRelations(model);
    const p2 = buildRelations(clone);
    const cs2 = byKind(p2.entries, 'causes_state_change');
    // 新增转移 ⇒ 新增一条 causes_state_change
    expect(cs2.length).toBe(byKind(p1.entries, 'causes_state_change').length + 1);
    expect(cs2.some((e) => e.fromId === 'TX' && e.toId === 'S7')).toBe(true);
    // 受影响的 sequence：S5 → S7 衔接 → T5(S4→S5).to=S5 ∈ TX.from=[S5] → [T5, TX] 出现
    const seq2 = byKind(p2.entries, 'sequence');
    expect(seq2.some((e) => e.fromId === 'T5' && e.toId === 'TX')).toBe(true);
  });

  test('⑥b M4 一致性用例：改一处 invariant scope → invariant_scope 条目相应变化', () => {
    const clone = JSON.parse(JSON.stringify(model)) as SourceProtocolModel;
    // INV4 scope 从 [S5] 改为 [S5, S6]
    const inv4 = clone.derivable.invariants.find((i) => i.id === 'INV4')!;
    inv4.scopeStateIds = ['S5', 'S6'];
    const p2 = buildRelations(clone);
    const inv4e = byKind(p2.entries, 'invariant_scope').find((e) => e.fromId === 'INV4')!;
    expect(inv4e.scopeStateIds).toEqual(['S5', 'S6']);
  });
});

describe('buildRelations（W1-a 投影）—— approval-flow fixture', () => {
  const model = loadApprovalFlowModel();
  const proj = buildRelations(model);

  test('转移数 5 → causes_state_change 5 条；sequence 衔接正确', () => {
    expect(model.derivable.transitions.length).toBe(5);
    expect(byKind(proj.entries, 'causes_state_change').length).toBe(5);
    const seq = byKind(proj.entries, 'sequence');
    // 人工可数：T1(S1→S2)→T2/T3/T4/T5；T5(S2→S1)→T1；共 5 条
    expect(seq.length).toBe(5);
    expect(seq.some((e) => e.fromId === 'T5' && e.toId === 'T1')).toBe(true); // 超时退回回到草稿
    expect(seq.some((e) => e.fromId === 'T1' && e.toId === 'T2')).toBe(true);
  });

  test('invariant_scope：scope 空（全局）→ 全部 5 个状态 id', () => {
    const invEntries = byKind(proj.entries, 'invariant_scope');
    expect(invEntries.length).toBe(2); // INV1 / INV2 均为全局
    const allStateIds = model.derivable.states.map((s) => s.id);
    for (const e of invEntries) {
      expect(e.scopeStateIds).toEqual(allStateIds);
      expect(e.toId).toBe(allStateIds.join(','));
    }
  });

  test('timing：TM1(timeout)/TM2(response) 均含 boundMs → 2 条正常条目，无 degraded', () => {
    const timingEntries = byKind(proj.entries, 'timing');
    expect(timingEntries.length).toBe(2);
    for (const e of timingEntries) {
      expect(e.boundMs).toBeDefined();
      expect(e.degraded).toBeUndefined();
    }
    expect(timingEntries.map((e) => e.derivedFrom[0]).sort()).toEqual(['TM1', 'TM2']);
  });

  test('④ 确定性 + sourceModelVersion 同源', () => {
    expect(proj.sourceModelVersion).toBe('1.0.0');
    expect(JSON.stringify(buildRelations(model))).toBe(JSON.stringify(proj));
  });
});
