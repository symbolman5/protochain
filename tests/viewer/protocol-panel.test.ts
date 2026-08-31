/**
 * viewer 协议层主视图测试（R2a · §11.3 协议模型视图；由 V4 协议层面板测试迁移升级）
 *
 * 机械判据（R2a-2 / R2a-3 / R2a-4 / R2a-5，对应 V4-3 / V4-4 / V4-5）：
 * R2a-2 渲染：加载 anonymous-saas web/data.json →
 *   ① 实体-维度卡片区：17 维度行、kind 着色（declared 蓝 / observed 青，数量与 data.json 一致）；
 *   ② 操作×不变量交叉面板：行数=interfaces、列数=invariants、●=invariantIds 显式命中、跨实体行标注；
 *   ③ 时间语义摘要条：always/eventually_within 分布 + boundMs 一览（与 data.json 查表一致）；
 *   ④ 关系图：12 条 modelRelations 渲染（节点=实体、边带 type 标签）。
 * R2a-3 交互：点维度 → 高亮引用它的 guard（interfaces[].precondition 含维度名）与不变量（invariants[].dimensions 含维度名）；
 *           点不变量 → 高亮它约束的操作（invariantIds 显式 ∪ 文本提及）与涉及的维度（DOM 断言）。
 * R2a-4 旧转移图不渲染：协议层视图为默认主界面——DOM 中无转移图容器（.sm-svg / .sm-node-group）。
 * R2a-5 老数据降级：无新字段的 data.json（food-delivery）→ 面板显示"无协议层数据"缺省，不抛错。
 *
 * 环境：jsdom（与 viewer-t2-panels.test.ts 同构）。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInContext } from 'node:vm';
import { JSDOM } from 'jsdom';

const ROOT = process.cwd();
const VIEWER = join(ROOT, 'viewer');

function readViewerFile(rel: string): string {
  return readFileSync(join(VIEWER, rel), 'utf-8');
}

/** anonymous-saas V4 完整数据（含 dimensions/invariants/modelRelations/storage） */
function loadSaasData(): unknown {
  return JSON.parse(
    readFileSync(join(ROOT, 'examples/anonymous-saas/web/data.json'), 'utf-8')
  );
}

/** 老模型数据（无任何协议层新字段） */
function loadLegacyData(): unknown {
  return JSON.parse(readViewerFile('samples/food-delivery.data.json'));
}

interface V4Window {
  ProtochainViewer?: { state: { dataJson: unknown } };
  [key: string]: unknown;
}

function setupDom(dataJson: unknown): { dom: JSDOM; win: V4Window } {
  const html = readViewerFile('index.html');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'file:///viewer/index.html' });
  const ctx = dom.getInternalVMContext();
  runInContext(readViewerFile('assets/parser.js'), ctx);
  runInContext(readViewerFile('n1-guard.js'), ctx);
  runInContext(readViewerFile('app.js'), ctx);
  runInContext(readViewerFile('main-view.js'), ctx);
  runInContext(readViewerFile('protocol-panel.js'), ctx);
  const win = dom.window as unknown as V4Window;
  if (dataJson !== undefined) {
    win.ProtochainViewer!.state.dataJson = dataJson;
  }
  const panels = dom.window.document.querySelector('#panels') as unknown as { innerHTML: string };
  (dom.window as unknown as { ProtochainViewerHooks: { renderAll: (s: unknown, p: unknown) => void } })
    .ProtochainViewerHooks.renderAll(win.ProtochainViewer!.state, panels);
  return { dom, win };
}

function click(dom: JSDOM, el: Element): void {
  el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
}

function highlightedGuardRows(dom: JSDOM): string[] {
  return [...dom.window.document.querySelectorAll('.proto-op-row.hl-guard')]
    .map((r) => r.getAttribute('data-interface-id'))
    .filter((x): x is string => !!x)
    .sort();
}

function highlightedInvRows(dom: JSDOM): string[] {
  return [...dom.window.document.querySelectorAll('.proto-op-row.hl-inv')]
    .map((r) => r.getAttribute('data-interface-id'))
    .filter((x): x is string => !!x)
    .sort();
}

function highlightedInvCols(dom: JSDOM): string[] {
  return [...dom.window.document.querySelectorAll('.proto-inv-col.hl')]
    .map((c) => c.getAttribute('data-invariant-id'))
    .filter((x): x is string => !!x)
    .sort();
}

function highlightedInvDims(dom: JSDOM): string[] {
  return [...dom.window.document.querySelectorAll('.proto-dim-row.hl-inv-dim')]
    .map((r) => r.getAttribute('data-dimension'))
    .filter((x): x is string => !!x)
    .sort();
}

// ---------------------------------------------------------------------------
// R2a 主界面语义（§11.3 推翻重构：协议层视图为默认主界面，无转移图）
// ---------------------------------------------------------------------------

describe('R2a 协议层主界面（推翻状态机转移图主展示）', () => {
  test('R2a-2/4 加载 anonymous-saas data.json → 协议层四区块为 #panels 主体、旧转移图容器不渲染', () => {
    const data = loadSaasData();
    const { dom } = setupDom(data);
    const panels = dom.window.document.querySelector('#panels')!;
    // 主界面 = 协议层主视图（取代旧状态机转移图主展示）
    expect(panels.querySelector('.protocol-panel')).not.toBeNull();
    expect(panels.querySelector('.protocol-panel')!.textContent).toContain('协议层主视图');
    // 协议层四区块齐备：实体-维度卡片 / 操作×不变量交叉 / 时间语义摘要 / 关系网络
    expect(panels.querySelector('.proto-entity-section')).not.toBeNull();
    expect(panels.querySelector('.proto-cross-section')).not.toBeNull();
    expect(panels.querySelector('.proto-timing-section')).not.toBeNull();
    expect(panels.querySelector('.proto-relation-section')).not.toBeNull();
    // R2a-4：旧状态机转移图不渲染（DOM 无转移图容器 / 状态节点 / 主视图占位）
    expect(panels.querySelector('.sm-svg')).toBeNull();
    expect(panels.querySelector('.sm-node-group')).toBeNull();
    expect(panels.querySelector('.sm-empty')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// V4-3 渲染
// ---------------------------------------------------------------------------

describe('V4-3 协议层面板渲染（anonymous-saas）', () => {
  test('① 实体-维度卡片区：17 维度行、kind 着色（declared 蓝 / observed 青）', () => {
    const data = loadSaasData() as {
      dimensions: Array<{ owner: string; dimension: string; kind: string }>;
      storage: { entities: Array<{ entity: string }> };
    };
    const { dom } = setupDom(data);
    const panel = dom.window.document.querySelector('.protocol-panel');
    expect(panel).not.toBeNull();
    // 维度行数 = dimensions 条目数（storage 补充实体仅补卡不补维度行）
    const dimRows = [...dom.window.document.querySelectorAll('.proto-dim-row')];
    expect(dimRows.length).toBe(data.dimensions.length);
    expect(dimRows.length).toBe(17);
    // kind 着色：declared / observed 徽章数量与数据一致
    const declared = data.dimensions.filter((d) => d.kind === 'declared').length;
    const observed = data.dimensions.filter((d) => d.kind === 'observed').length;
    expect(dom.window.document.querySelectorAll('.proto-kind-declared').length).toBe(declared);
    expect(dom.window.document.querySelectorAll('.proto-kind-observed').length).toBe(observed);
    // 每行含维度名 + kind 文本
    const first = data.dimensions[0];
    const firstRow = dom.window.document.querySelector(
      `.proto-dim-row[data-dimension="${first.dimension}"]`
    );
    expect(firstRow).not.toBeNull();
    expect(firstRow?.textContent).toContain(first.dimension);
    expect(firstRow?.textContent).toContain(first.kind);
  });

  test('② 交叉面板：行=interfaces（35）、列=invariants（11）、●=invariantIds 显式命中、跨实体行标注', () => {
    const data = loadSaasData() as {
      interfaces: Array<{
        id: string;
        name: string;
        invariantIds?: string[];
        precondition?: string;
        sideEffects?: Array<{ description?: string; kind?: string }>;
        postconditions?: string[];
      }>;
      invariants: Array<{ id: string }>;
      dimensions: Array<{ owner: string; dimension: string }>;
    };
    const { dom } = setupDom(data);
    expect(dom.window.document.querySelectorAll('.proto-op-row').length).toBe(data.interfaces.length);
    expect(dom.window.document.querySelectorAll('.proto-inv-col').length).toBe(data.invariants.length);
    // ● = interfaces[].invariantIds 显式命中（11 个观测接口各 1 个）
    const explicitDots = data.interfaces.filter((i) => Array.isArray(i.invariantIds)).length;
    expect(dom.window.document.querySelectorAll('.proto-cell-dot').length).toBe(explicitDots);
    // 跨实体行标注：作用实体 ≥2 个 owner（sideEffects/postconditions/precondition 文本匹配维度名；
    // 遍历全部维度条目——与渲染 entitySetOf 一致，含跨实体重复维度名）
    const crossIds = data.interfaces
      .filter((op) => {
        const texts: string[] = [];
        for (const s of op.sideEffects || []) texts.push(s.description || s.kind || '');
        if (op.postconditions) texts.push(...op.postconditions);
        if (typeof op.precondition === 'string') texts.push(op.precondition);
        const joined = texts.join('\n');
        const owners = new Set<string>();
        for (const d of data.dimensions) if (joined.includes(d.dimension)) owners.add(d.owner);
        return owners.size >= 2;
      })
      .map((op) => op.id)
      .sort();
    expect(crossIds.length).toBeGreaterThan(0);
    const renderedCross = [...dom.window.document.querySelectorAll('.proto-op-row.proto-op-cross')]
      .map((r) => r.getAttribute('data-interface-id'))
      .filter((x): x is string => !!x)
      .sort();
    expect(renderedCross).toEqual(crossIds);
    // 跨实体行含「跨实体」徽章
    expect(dom.window.document.querySelectorAll('.proto-cross-tag').length).toBe(crossIds.length);
    // 操作行展示角色 + 接口名 + guard + 作用实体（R3a：接口名=操作段 op 中文名，如 匿名发布资源）
    const opRow0 = dom.window.document.querySelector('.proto-op-row')!;
    expect(opRow0.textContent).toContain('匿名发布资源');
  });

  test('③ 时间语义摘要条：always 4 / eventually_within 7 + boundMs 一览（R3a 六张清单形态时序约束由 boundMs 承载）', () => {
    const data = loadSaasData() as {
      invariants: Array<{ id: string; timing: string; bound?: number }>;
    };
    const { dom } = setupDom(data);
    const always = data.invariants.filter((i) => i.timing === 'always').length;
    const ev = data.invariants.filter((i) => i.timing === 'eventually_within').length;
    const barText = dom.window.document.querySelector('.proto-timing-bar')?.textContent ?? '';
    expect(barText).toContain(`always ${always}`);
    expect(barText).toContain(`eventually_within ${ev}`);
    expect(always).toBe(4);
    expect(ev).toBe(7);
    // boundMs 一览（查表一致）
    const inv3 = data.invariants.find((i) => i.id === 'INV-3')!;
    expect(barText).toContain(`INV-3 ≤${inv3.bound}ms`);
    // R3a 六张清单形态：时序约束由不变量 boundMs 一览承载（无状态机 timing edges，
    // V4 旧「时序约束」块不渲染——待 R2a 新架构协议层视图重做摘要条）
  });

  test('④ 关系图：12 条 modelRelations、节点=实体、边带 type 标签', () => {
    const data = loadSaasData() as { modelRelations: Array<{ from: string; to: string; type: string }> };
    const { dom } = setupDom(data);
    const relRows = [...dom.window.document.querySelectorAll('.proto-rel-row')];
    expect(relRows.length).toBe(data.modelRelations.length);
    expect(relRows.length).toBe(12);
    // 节点 chips = from/to 去重
    const nodeSet = new Set<string>();
    for (const r of data.modelRelations) {
      nodeSet.add(r.from);
      nodeSet.add(r.to);
    }
    expect(dom.window.document.querySelectorAll('.proto-rel-node').length).toBe(nodeSet.size);
    // type 标签与数据逐条一致
    const first = data.modelRelations[0];
    const firstRow = dom.window.document.querySelector('.proto-rel-row')!;
    expect(firstRow.textContent).toContain(first.from);
    expect(firstRow.textContent).toContain(first.to);
    expect(firstRow.textContent).toContain(first.type);
    // 五种 type 均有着色类（绑定/派生/运行依赖/组合/约束关联）
    const types = new Set(data.modelRelations.map((r) => r.type));
    expect(types.size).toBe(5);
    for (const t of types) {
      expect(dom.window.document.querySelectorAll(`.proto-rel-type-${t}`).length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// V4-4 交互
// ---------------------------------------------------------------------------

describe('V4-4 协议层面板交互（anonymous-saas）', () => {
  test('① 点维度 → 高亮引用它的全部 guard（interfaces[].precondition 含维度名）与不变量（invariants[].dimensions 含维度名）', () => {
    const data = loadSaasData() as {
      interfaces: Array<{ id: string; precondition?: string }>;
      invariants: Array<{ id: string; dimensions: string[] }>;
      dimensions: Array<{ dimension: string }>;
    };
    const { dom } = setupDom(data);
    const dimName = '访问策略';
    const dimRow = dom.window.document.querySelector(`.proto-dim-row[data-dimension="${dimName}"]`)!;
    click(dom, dimRow);
    // 该维度行激活
    expect(dimRow.classList.contains('active')).toBe(true);
    // guard 高亮：precondition 含维度名的操作行
    const expectGuards = data.interfaces
      .filter((i) => (i.precondition || '').includes(dimName))
      .map((i) => i.id)
      .sort();
    expect(expectGuards.length).toBeGreaterThan(0);
    expect(highlightedGuardRows(dom)).toEqual(expectGuards);
    // 不变量列高亮：invariants[].dimensions 含维度名
    const expectCols = data.invariants
      .filter((inv) => (inv.dimensions || []).includes(dimName))
      .map((inv) => inv.id)
      .sort();
    expect(expectCols.length).toBeGreaterThan(0);
    expect(highlightedInvCols(dom)).toEqual(expectCols);
  });

  test('② 点不变量 → 高亮它约束的操作（invariantIds 显式 ∪ 文本提及）与涉及的维度', () => {
    const data = loadSaasData() as {
      interfaces: Array<{
        id: string;
        invariantIds?: string[];
        precondition?: string;
        sideEffects?: Array<{ description?: string; kind?: string }>;
        postconditions?: string[];
        outputs?: Array<{ description?: string }>;
      }>;
      invariants: Array<{ id: string; dimensions: string[] }>;
    };
    const { dom } = setupDom(data);
    const invId = 'INV-1';
    const col = dom.window.document.querySelector(`.proto-inv-col[data-invariant-id="${invId}"]`)!;
    click(dom, col);
    expect(col.classList.contains('active')).toBe(true);
    // 约束的操作：invariantIds 显式命中 ∪ 操作文本提及 INV-1
    const mentioned = (op: (typeof data.interfaces)[number]): boolean => {
      const texts: string[] = [];
      if (typeof op.precondition === 'string') texts.push(op.precondition);
      if (op.postconditions) texts.push(...op.postconditions);
      for (const s of op.sideEffects || []) texts.push(s.description || s.kind || '');
      for (const o of op.outputs || []) texts.push(o.description || '');
      return texts.join('\n').includes(invId);
    };
    const expectRows = data.interfaces
      .filter((op) => (Array.isArray(op.invariantIds) && op.invariantIds.includes(invId)) || mentioned(op))
      .map((op) => op.id)
      .sort();
    expect(expectRows.length).toBeGreaterThan(0);
    expect(highlightedInvRows(dom)).toEqual(expectRows);
    // 涉及的维度：INV-1.dimensions → 卡片维度行高亮
    const inv = data.invariants.find((i) => i.id === invId)!;
    expect(highlightedInvDims(dom)).toEqual([...(inv.dimensions || [])].sort());
  });
});

// ---------------------------------------------------------------------------
// V4-5 老数据降级
// ---------------------------------------------------------------------------

describe('V4-5 老数据降级（无协议层新字段）', () => {
  test('food-delivery data.json（无 dimensions/invariants/modelRelations/storage）→ 面板显示缺省提示，不抛错', () => {
    const legacy = loadLegacyData() as Record<string, unknown>;
    // 前置确认：老数据确实无协议层字段
    expect(legacy.dimensions).toBeUndefined();
    expect(legacy.invariants).toBeUndefined();
    expect(legacy.modelRelations).toBeUndefined();
    expect(legacy.storage).toBeUndefined();
    expect(() => setupDom(legacy)).not.toThrow();
    const { dom } = setupDom(legacy);
    const empty = dom.window.document.querySelector('.protocol-empty');
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toContain('无协议层数据');
    // 不渲染协议层面板主体（不崩）
    expect(dom.window.document.querySelector('.protocol-panel')).toBeNull();
  });

  test('未导入 data.json → 协议层面板不渲染（主视图已有提示，不重复）', () => {
    const { dom } = setupDom(null);
    expect(dom.window.document.querySelector('.protocol-empty')).toBeNull();
    expect(dom.window.document.querySelector('.protocol-panel')).toBeNull();
  });

  test('部分字段缺失（仅 modelRelations）→ 区块级空态，整体不崩', () => {
    const legacy = loadLegacyData() as Record<string, unknown>;
    const partial = {
      ...legacy,
      modelRelations: [{ from: 'a', to: 'b', type: '绑定', constraint: 'c', onGone: 'g' }],
    };
    expect(() => setupDom(partial)).not.toThrow();
    const { dom } = setupDom(partial);
    // 关系图渲染 1 条；维度/不变量区块显示空态
    expect(dom.window.document.querySelectorAll('.proto-rel-row').length).toBe(1);
    expect(dom.window.document.querySelector('.proto-empty')).not.toBeNull();
  });
});
