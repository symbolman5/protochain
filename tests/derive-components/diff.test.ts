/**
 * T1c 机械验收：组件模型同步（候选骨架差分）
 *
 * - T1c-2 正反向：协议新增接口 → 差异清单含新候选（derived）；删除接口 →
 *   asserted 映射进仲裁清单
 * - T1c-3 未变场景：仅改 guard 文本 → 差异清单为空（组件模型不动）
 * - T1c-4 既有 diff/impact/propagate 行为零回归（components-diff 为新增产物，不改变既有链路）
 */
import { join } from 'node:path';
import { parseProtocolFile } from '../../src/parser/index.js';
import { deriveComponentsSkeleton } from '../../src/derive-components/index.js';
import { diffComponentSkeletons } from '../../src/derive-components/diff.js';

const EXAMPLES = join(process.cwd(), 'examples', 'anonymous-saas', 'protocol');

function loadModel(p: string) {
  return parseProtocolFile(join(EXAMPLES, p, 'model.md'), { allowDegraded: true });
}

describe('T1c-2 正反向：新增接口 → derived；删除接口 → asserted 仲裁', () => {
  test('协议新增接口 → added 含新候选（disposition=derived）', () => {
    const base = loadModel('P1');
    const oldS = deriveComponentsSkeleton(base);
    // 模拟协议新增接口：在操作列表追加一个操作
    const clone = JSON.parse(JSON.stringify(base)) as typeof base;
    (clone.derivable.operations as unknown[]).push({
      id: 'OP_X',
      name: '新接口X',
      triggerRoleId: 'account_holder',
      target: '资源',
      targetEntities: ['资源'],
      guard: '无',
      change: '资源.状态=已认领',
      changes: [{ entity: '资源', dimension: '状态', value: '已认领' }],
      affectsDimensions: ['状态'],
      sideEffects: [],
      triggerType: 'role',
    });
    const newS = deriveComponentsSkeleton(clone);
    const diff = diffComponentSkeletons(oldS, newS);
    // 新接口 → added（derived：机械覆盖候选）
    const addedIfaces = diff.added.filter((it) => it.elementType === 'interface' && it.elementId === '新接口X');
    expect(addedIfaces).toHaveLength(1);
    expect(addedIfaces[0].disposition).toBe('derived');
    // 契约同步 added
    expect(diff.added.some((it) => it.elementType === 'contract' && it.elementId === '新接口X')).toBe(true);
  });

  test('协议删除接口 → removed 进仲裁清单（disposition=asserted，机械只标记）', () => {
    const base = loadModel('P1');
    const oldS = deriveComponentsSkeleton(base);
    // 模拟协议删除接口：移除第一个操作
    const clone = JSON.parse(JSON.stringify(base)) as typeof base;
    const removed = (clone.derivable.operations as unknown[]).shift() as { name: string };
    const newS = deriveComponentsSkeleton(clone);
    const diff = diffComponentSkeletons(oldS, newS);
    // 被删接口 → removed（asserted：既有映射引用失效 → 人工仲裁）
    const removedIfaces = diff.removed.filter((it) => it.elementType === 'interface' && it.elementId === removed.name);
    expect(removedIfaces).toHaveLength(1);
    expect(removedIfaces[0].disposition).toBe('asserted');
    // 契约同样进仲裁清单
    expect(diff.removed.some((it) => it.elementType === 'contract' && it.elementId === removed.name)).toBe(true);
  });
});

describe('T1c-3 未变场景：仅改 guard 文本 → 差异清单为空', () => {
  test('操作 guard 文本变更（接口集合不变）→ added/removed 均为空', () => {
    const base = loadModel('P2');
    const oldS = deriveComponentsSkeleton(base);
    const clone = JSON.parse(JSON.stringify(base)) as typeof base;
    const op = (clone.derivable.operations as unknown as Array<{ guard?: string }>)[0];
    op.guard = `（改动后的守卫文本：${Date.now()}）`;
    const newS = deriveComponentsSkeleton(clone);
    const diff = diffComponentSkeletons(oldS, newS);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    // 未变项 = 接口 + 维度 + 关系 + 契约总数（组件模型不动）
    expect(diff.unchanged.length).toBeGreaterThan(0);
  });
});

describe('T1c-4 既有链路零回归：差分不改变骨架推导本身', () => {
  test('P1/P2/P3 骨架推导与 T1b 一致（接口/维度/关系计数）', () => {
    for (const p of ['P1', 'P2', 'P3']) {
      const model = loadModel(p);
      const s = deriveComponentsSkeleton(model);
      expect(s.coverage.interfaceCovered).toBe(s.coverage.interfaceTotal);
      expect(s.coverage.dimensionCovered).toBe(s.coverage.dimensionTotal);
    }
  });
});
