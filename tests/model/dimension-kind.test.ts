/**
 * X1（P0-1）：buildDimensionKinds 独立单测 —— 四分支全覆盖（S1-3）。
 *
 * | 分支 | 输入 W(dim) | 期望 |
 * |---|---|---|
 * | role-only | 只含 role | kind='declared', kindSource='derived' |
 * | non-role-only | 只含 system/external | kind='observed', kindSource='derived' |
 * | 混合 | role + system/external | 抛 Error 且 message 含 dimension-kind-conflict |
 * | 空集 | 无写入方 | 不推导；schemaDegradedReasons 含 dimension-kind-undetermined |
 *
 * 另覆盖：人写断言（kindSource='asserted'）保留断言值；附属实体维度同样纳入推导。
 */
import {
  buildDimensionKinds,
  DIMENSION_KIND_CONFLICT,
  DIMENSION_KIND_UNDETERMINED,
} from '../../src/model/dimension-kind.js';
import type {
  DerivableLayer,
  StateDef,
  StateDimension,
  SubsidiaryEntityDef,
  TransitionDef,
} from '../../src/model/types.js';

// ============================================================================
// 辅助构造
// ============================================================================

function mkDerivable(opts: {
  states?: StateDef[];
  transitions?: TransitionDef[];
  subsidiaryEntities?: SubsidiaryEntityDef[];
}): DerivableLayer {
  return {
    degraded: false,
    states: opts.states ?? [],
    transitions: opts.transitions ?? [],
    invariants: [],
    timing: [],
    exceptions: [],
    terminalStateIds: [],
    subsidiaryEntities: opts.subsidiaryEntities,
  };
}

function mkState(id: string, dimensions: StateDimension[]): StateDef {
  return { id, name: id, type: 'normal', dimensions };
}

function mkTransition(
  id: string,
  affectsDimensions: string[],
  triggerType: TransitionDef['triggerType']
): TransitionDef {
  return {
    id,
    name: id,
    from: ['S1'],
    to: 'S2',
    action: id,
    triggerType,
    trigger: triggerType,
    actionType: 'state_transition',
    affectsDimensions,
  };
}

function mkDim(name: string, extra?: Partial<StateDimension>): StateDimension {
  return { name, type: 'string', initial: '', ...extra };
}

// ============================================================================
// 四分支
// ============================================================================

describe('buildDimensionKinds（X1 维度 kind 机械推导）', () => {
  test('role-only：W(dim) 只含 role → declared / derived', () => {
    const ir = mkDerivable({
      states: [mkState('S1', [mkDim('dimA')])],
      transitions: [mkTransition('T1', ['dimA'], 'role')],
    });
    const result = buildDimensionKinds(ir);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toEqual({
      owner: 'S1',
      dimension: 'dimA',
      kind: 'declared',
      kindSource: 'derived',
      writers: ['role'],
    });
    expect(result.schemaDegradedReasons).toHaveLength(0);
  });

  test('non-role-only：W(dim) 只含 system → observed / derived', () => {
    const ir = mkDerivable({
      states: [mkState('S1', [mkDim('dimB')])],
      transitions: [mkTransition('T1', ['dimB'], 'system')],
    });
    const result = buildDimensionKinds(ir);
    expect(result.entries[0]).toEqual({
      owner: 'S1',
      dimension: 'dimB',
      kind: 'observed',
      kindSource: 'derived',
      writers: ['system'],
    });
  });

  test('non-role-only：W(dim) 只含 external → observed / derived（写入方去重排序）', () => {
    const ir = mkDerivable({
      states: [mkState('S1', [mkDim('dimB2')])],
      transitions: [
        mkTransition('T1', ['dimB2'], 'external'),
        mkTransition('T2', ['dimB2'], 'external'),
      ],
    });
    const result = buildDimensionKinds(ir);
    expect(result.entries[0]).toEqual({
      owner: 'S1',
      dimension: 'dimB2',
      kind: 'observed',
      kindSource: 'derived',
      writers: ['external'],
    });
  });

  test('混合：W(dim) 同时含 role 与非 role → 抛错且 message 含 dimension-kind-conflict', () => {
    const ir = mkDerivable({
      states: [mkState('S1', [mkDim('dimC')])],
      transitions: [
        mkTransition('T1', ['dimC'], 'role'),
        mkTransition('T2', ['dimC'], 'system'),
      ],
    });
    expect(() => buildDimensionKinds(ir)).toThrow(DIMENSION_KIND_CONFLICT);
    expect(() => buildDimensionKinds(ir)).toThrow(/dimC/);
  });

  test('混合：external + role 同样硬失败', () => {
    const ir = mkDerivable({
      states: [mkState('S1', [mkDim('dimC2')])],
      transitions: [
        mkTransition('T1', ['dimC2'], 'external'),
        mkTransition('T2', ['dimC2'], 'role'),
      ],
    });
    expect(() => buildDimensionKinds(ir)).toThrow(/dimension-kind-conflict/);
  });

  test('空集：W(dim)=∅ → 不推导且 schemaDegradedReasons 含 dimension-kind-undetermined', () => {
    const ir = mkDerivable({
      states: [mkState('S1', [mkDim('dimD')])],
      transitions: [],
    });
    const result = buildDimensionKinds(ir);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].kind).toBeUndefined();
    expect(result.entries[0].kindSource).toBeUndefined();
    expect(result.entries[0].writers).toEqual([]);
    expect(result.schemaDegradedReasons.length).toBeGreaterThan(0);
    for (const reason of result.schemaDegradedReasons) {
      expect(reason).toContain(DIMENSION_KIND_UNDETERMINED);
    }
  });

  test('空集：无维度模型 → 空 entries 且无降级', () => {
    const ir = mkDerivable({ states: [mkState('S1', [])], transitions: [] });
    const result = buildDimensionKinds(ir);
    expect(result.entries).toHaveLength(0);
    expect(result.schemaDegradedReasons).toHaveLength(0);
  });

  test('空集：不影响有写入方的维度（只对空集维度记降级）', () => {
    const ir = mkDerivable({
      states: [mkState('S1', [mkDim('dimE'), mkDim('dimF')])],
      transitions: [mkTransition('T1', ['dimE'], 'role')],
    });
    const result = buildDimensionKinds(ir);
    expect(result.entries).toHaveLength(2);
    const e = result.entries.find((x) => x.dimension === 'dimE');
    const f = result.entries.find((x) => x.dimension === 'dimF');
    expect(e).toMatchObject({ kind: 'declared', kindSource: 'derived' });
    expect(f?.kind).toBeUndefined();
    expect(result.schemaDegradedReasons).toHaveLength(1);
    expect(result.schemaDegradedReasons[0]).toContain('dimF');
    expect(result.schemaDegradedReasons[0]).toContain(DIMENSION_KIND_UNDETERMINED);
  });
});

// ============================================================================
// 人写断言（parser 解析 model.md kind 段 → kindSource='asserted'）
// ============================================================================

describe('buildDimensionKinds · 人写断言（kindSource=asserted）', () => {
  test('已断言维度保留断言 kind，同时带出 W(dim) writers', () => {
    const ir = mkDerivable({
      states: [mkState('S1', [mkDim('dimG', { kind: 'observed', kindSource: 'asserted' })])],
      transitions: [mkTransition('T1', ['dimG'], 'role')],
    });
    const result = buildDimensionKinds(ir);
    expect(result.entries[0]).toEqual({
      owner: 'S1',
      dimension: 'dimG',
      kind: 'observed',
      kindSource: 'asserted',
      writers: ['role'],
    });
  });

  test('已断言维度即使 W(dim)=∅ 也不降级（人写断言即定论）', () => {
    const ir = mkDerivable({
      states: [mkState('S1', [mkDim('dimH', { kind: 'declared', kindSource: 'asserted' })])],
      transitions: [],
    });
    const result = buildDimensionKinds(ir);
    expect(result.entries[0]).toMatchObject({ kind: 'declared', kindSource: 'asserted' });
    expect(result.schemaDegradedReasons).toHaveLength(0);
  });

  test('已断言维度 W(dim) 混合仍硬失败（M10：写入方集合矛盾与断言无关）', () => {
    const ir = mkDerivable({
      states: [mkState('S1', [mkDim('dimI', { kind: 'declared', kindSource: 'asserted' })])],
      transitions: [
        mkTransition('T1', ['dimI'], 'role'),
        mkTransition('T2', ['dimI'], 'system'),
      ],
    });
    expect(() => buildDimensionKinds(ir)).toThrow(/dimension-kind-conflict/);
  });
});

// ============================================================================
// 附属实体维度（subsidiaryEntities[].stateSpace.dimensions 同纳入推导）
// ============================================================================

describe('buildDimensionKinds · 附属实体维度', () => {
  test('附属实体维度 W(dim) 空 → 降级记录带 owner=附属实体 ID', () => {
    const ir = mkDerivable({
      states: [mkState('S1', [])],
      subsidiaryEntities: [
        {
          id: 'refund_order',
          name: '退款单',
          belongsTo: 'S1',
          instanceKey: 'refund_order.id',
          lifecycleDependency: '随主实体',
          cascadeRules: [],
          stateSpace: { dimensions: [mkDim('refund_status'), mkDim('refund_amount')] },
          invariants: [],
        },
      ],
      transitions: [],
    });
    const result = buildDimensionKinds(ir);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toMatchObject({ owner: 'refund_order', dimension: 'refund_status' });
    expect(result.entries[0].kind).toBeUndefined();
    expect(result.schemaDegradedReasons).toHaveLength(2);
    for (const reason of result.schemaDegradedReasons) {
      expect(reason).toContain(DIMENSION_KIND_UNDETERMINED);
    }
  });
});
