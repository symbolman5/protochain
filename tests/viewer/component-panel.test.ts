/**
 * viewer V5 组件层面板测试（§11.3 组件模型视图）
 *
 * 机械判据（V5-3 / V5-4 / V5-5）：
 * V5-3 渲染：加载 anonymous-saas web/data.json →
 *   ① 接口→实现组件表：24 行（components.interfaceImplementations），行含接口 id+name（interfaces 查表）与组件；
 *   ② 实体维度→存储表：17 行（components.dimensionStorage），行含维度名+owner（dimensions 查表）与表；
 *   ③ 组件→组件传输表：2 行（components.componentTransfers），含 from→to / channel / mode sync·async 徽章；
 *   ④ 架构总览拓扑：节点=去重组件集（组件名+承载接口数），边=传输数（2）带 mode 徽章。
 * V5-4 交互：
 *   点接口（本面板行 / 协议层接口名）→ 高亮实现组件行+拓扑节点与存储落点（接口文本提及的 dimensionStorage 维度）；
 *   点组件（拓扑节点 / 组件列）→ 高亮其承载的全部接口（同面板 .hl + 协议层 .hl-comp）。
 * V5-5 老数据降级：无 components 字段的 data.json（food-delivery）→ 面板显示"无组件层数据"缺省，不抛错；
 *           部分缺失（仅 interfaceImplementations）→ 区块级空态，整体不崩。
 *
 * 环境：jsdom（与 protocol-panel.test.ts 同构）。
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

/** anonymous-saas 完整数据（V3+ 含 components/storage 字段） */
function loadSaasData(): unknown {
  return JSON.parse(
    readFileSync(join(ROOT, 'examples/anonymous-saas/web/data.json'), 'utf-8')
  );
}

/** 老模型数据（无 components 字段） */
function loadLegacyData(): unknown {
  return JSON.parse(readViewerFile('samples/food-delivery.data.json'));
}

interface V5Window {
  ProtochainViewer?: { state: { dataJson: unknown } };
  [key: string]: unknown;
}

function setupDom(dataJson: unknown): { dom: JSDOM; win: V5Window } {
  const html = readViewerFile('index.html');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'file:///viewer/index.html' });
  const ctx = dom.getInternalVMContext();
  runInContext(readViewerFile('assets/parser.js'), ctx);
  runInContext(readViewerFile('n1-guard.js'), ctx);
  runInContext(readViewerFile('app.js'), ctx);
  runInContext(readViewerFile('main-view.js'), ctx);
  runInContext(readViewerFile('protocol-panel.js'), ctx);
  runInContext(readViewerFile('component-panel.js'), ctx);
  const win = dom.window as unknown as V5Window;
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

/** 接口文本拼接（与 component-panel.js ifaceTexts 同构，供存储落点期望计算） */
function ifaceTexts(iface: {
  [k: string]: unknown;
  precondition?: unknown;
  postconditions?: unknown;
  sideEffects?: unknown;
  outputs?: unknown;
}): string[] {
  const texts: string[] = [];
  if (typeof iface.precondition === 'string') texts.push(iface.precondition);
  if (Array.isArray(iface.postconditions)) texts.push(...(iface.postconditions as string[]));
  for (const s of (iface.sideEffects as Array<{ description?: string; kind?: string }>) || []) {
    texts.push(s.description || s.kind || '');
  }
  for (const o of (iface.outputs as Array<{ description?: string }>) || []) {
    texts.push(o.description || '');
  }
  return texts;
}

interface SaasShape {
  interfaces: Array<{ id: string; name: string; [k: string]: unknown }>;
  dimensions: Array<{ owner: string; dimension: string; [k: string]: unknown }>;
  components: {
    interfaceImplementations: Array<{ interface: string; component: string; description?: string }>;
    dimensionStorage: Array<{ dimension: string; table: string; description?: string }>;
    componentTransfers: Array<{ from: string; to: string; channel?: string; mode?: string; description?: string }>;
  };
}

// ---------------------------------------------------------------------------
// V5-3 渲染
// ---------------------------------------------------------------------------

describe('V5-3 组件层面板渲染（anonymous-saas）', () => {
  test('① 接口→实现组件表：24 行（interfaceImplementations），行含接口 id+name 与组件', () => {
    const data = loadSaasData() as SaasShape;
    const { dom } = setupDom(data);
    const panel = dom.window.document.querySelector('.component-panel');
    expect(panel).not.toBeNull();
    const rows = [...dom.window.document.querySelectorAll('.comp-impl-row')];
    expect(rows.length).toBe(data.components.interfaceImplementations.length);
    expect(rows.length).toBe(24);
    // 行数据：interface（name）→ interfaces[] 查表得 id
    const ifaceById = new Map(data.interfaces.map((i) => [i.name, i.id]));
    for (const im of data.components.interfaceImplementations) {
      const row = dom.window.document.querySelector(
        `.comp-impl-row[data-interface-name="${im.interface}"]`
      )!;
      expect(row.getAttribute('data-component')).toBe(im.component);
      expect(row.getAttribute('data-interface-id')).toBe(ifaceById.get(im.interface));
      expect(row.textContent).toContain(im.interface);
      expect(row.textContent).toContain(im.component);
      expect(row.textContent).toContain(ifaceById.get(im.interface) ?? '');
    }
    // 分组排序：同组件相邻（按组件名排序）
    const comps = rows.map((r) => r.getAttribute('data-component'));
    expect(comps.filter((c, i) => i === 0 || c !== comps[i - 1]).join(',')).toBe('control-plane,data-plane');
    // control-plane 18 / data-plane 6
    expect(dom.window.document.querySelectorAll('.comp-impl-row[data-component="control-plane"]').length).toBe(18);
    expect(dom.window.document.querySelectorAll('.comp-impl-row[data-component="data-plane"]').length).toBe(6);
  });

  test('② 实体维度→存储表：17 行（dimensionStorage），维度名+owner 查表、表=落点', () => {
    const data = loadSaasData() as SaasShape;
    const { dom } = setupDom(data);
    const rows = [...dom.window.document.querySelectorAll('.comp-storage-row')];
    expect(rows.length).toBe(data.components.dimensionStorage.length);
    expect(rows.length).toBe(17);
    // owner：dimensions 同名查表（去重并列）
    for (const s of data.components.dimensionStorage) {
      const owners = [...new Set(data.dimensions.filter((d) => d.dimension === s.dimension).map((d) => d.owner))];
      const ownerText = owners.length > 0 ? owners.join(' · ') : '—';
      const row = dom.window.document.querySelector(
        `.comp-storage-row[data-dimension="${s.dimension}"][data-table="${s.table}"]`
      )!;
      expect(row.getAttribute('data-owner')).toBe(ownerText);
      expect(row.textContent).toContain(s.dimension);
      expect(row.textContent).toContain(s.table);
    }
    // 存储表去重 = 10 张
    const tables = new Set(data.components.dimensionStorage.map((s) => s.table));
    expect(tables.size).toBe(10);
  });

  test('③ 组件→组件传输表：2 行，from→to / channel / mode 徽章（sync 绿 · async 琥珀）', () => {
    const data = loadSaasData() as SaasShape;
    const { dom } = setupDom(data);
    const rows = [...dom.window.document.querySelectorAll('.comp-transfer-row')];
    expect(rows.length).toBe(data.components.componentTransfers.length);
    expect(rows.length).toBe(2);
    for (const t of data.components.componentTransfers) {
      const row = dom.window.document.querySelector(
        `.comp-transfer-row[data-from="${t.from}"][data-to="${t.to}"]`
      )!;
      expect(row.getAttribute('data-mode')).toBe(t.mode);
      expect(row.textContent).toContain(t.from);
      expect(row.textContent).toContain(t.to);
      expect(row.textContent).toContain(t.channel ?? '');
      // mode 徽章类名
      expect(row.querySelector(`.comp-mode-${t.mode}`)).not.toBeNull();
    }
    // async 徽章：传输表 2 个 + 拓扑边 2 个（本数据无 sync）
    expect(dom.window.document.querySelectorAll('.comp-transfer-row .comp-mode-async').length).toBe(2);
    expect(dom.window.document.querySelectorAll('.comp-mode-async').length).toBe(4);
    expect(dom.window.document.querySelectorAll('.comp-mode-sync').length).toBe(0);
  });

  test('④ 架构总览：节点=去重组件集（2，带承载接口数）、边=2 带 mode 徽章', () => {
    const data = loadSaasData() as SaasShape;
    const { dom } = setupDom(data);
    // 节点 = interfaceImplementations 组件 ∪ 传输 from/to 去重
    const nodeSet = new Set<string>();
    for (const im of data.components.interfaceImplementations) nodeSet.add(im.component);
    for (const t of data.components.componentTransfers) {
      nodeSet.add(t.from);
      nodeSet.add(t.to);
    }
    const nodes = [...dom.window.document.querySelectorAll('.comp-topo-node')];
    expect(nodes.length).toBe(nodeSet.size);
    expect(nodes.length).toBe(2);
    for (const n of nodes) {
      const comp = n.getAttribute('data-component')!;
      expect(nodeSet.has(comp)).toBe(true);
      // 承载接口数 = 该组件实现的接口条数
      const count = data.components.interfaceImplementations.filter((im) => im.component === comp).length;
      expect(n.getAttribute('data-interface-count')).toBe(String(count));
      expect(n.textContent).toContain(`${comp} · ${count} 接口`);
    }
    // 边 = 传输数，带 mode 徽章
    const edges = [...dom.window.document.querySelectorAll('.comp-topo-edge')];
    expect(edges.length).toBe(data.components.componentTransfers.length);
    for (let i = 0; i < edges.length; i++) {
      const t = data.components.componentTransfers[i];
      expect(edges[i].getAttribute('data-from')).toBe(t.from);
      expect(edges[i].getAttribute('data-to')).toBe(t.to);
      expect(edges[i].getAttribute('data-mode')).toBe(t.mode);
      expect(edges[i].querySelector(`.comp-mode-${t.mode}`)).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// V5-4 交互（双向跳转）
// ---------------------------------------------------------------------------

describe('V5-4 协议↔组件双向跳转（anonymous-saas）', () => {
  test('① 点组件层面板接口行 → 高亮实现组件行+拓扑节点与存储落点（接口文本提及的 dimensionStorage 维度）', () => {
    const data = loadSaasData() as SaasShape;
    const { dom } = setupDom(data);
    // R3a：接口名=操作段 op 中文名；认领资源 guard 提及 资源/认领码/账号/账号配额 多实体维度 → 存储落点断言非空
    const iface = data.interfaces.find((i) => i.name === '认领资源')!;
    const row = dom.window.document.querySelector(`.comp-impl-row[data-interface-name="认领资源"]`)!;
    click(dom, row);
    // 实现组件行 + 拓扑节点
    expect(row.classList.contains('hl')).toBe(true);
    expect(dom.window.document.querySelector(`.comp-topo-node[data-component="control-plane"]`)!.classList.contains('hl')).toBe(true);
    // 存储落点：接口文本提及的维度 → dimensionStorage 行
    const joined = ifaceTexts(iface).join('\n');
    const expectDims = data.components.dimensionStorage
      .filter((s) => joined.includes(s.dimension))
      .map((s) => s.dimension)
      .sort();
    expect(expectDims.length).toBeGreaterThan(0);
    const hlDims = [...dom.window.document.querySelectorAll('.comp-storage-row.hl')]
      .map((r) => r.getAttribute('data-dimension'))
      .filter((x): x is string => !!x)
      .sort();
    expect(hlDims).toEqual(expectDims);
    // 其他接口行不误亮
    expect(dom.window.document.querySelectorAll('.comp-impl-row.hl').length).toBe(1);
  });

  test('② 点协议层接口名 → 组件面板对应实现组件/存储落点高亮（协议→组件 跳转）', () => {
    const data = loadSaasData() as SaasShape;
    const { dom } = setupDom(data);
    const iface = data.interfaces.find((i) => i.name === '认领资源')!;
    const opName = dom.window.document.querySelector(
      `.proto-op-row[data-interface-id="${iface.id}"] .proto-op-name`
    )!;
    expect(opName).not.toBeNull();
    click(dom, opName);
    // 组件面板：实现行高亮 + 拓扑节点高亮
    const implRow = dom.window.document.querySelector(`.comp-impl-row[data-interface-name="认领资源"]`)!;
    expect(implRow.classList.contains('hl')).toBe(true);
    expect(dom.window.document.querySelector(`.comp-topo-node[data-component="control-plane"]`)!.classList.contains('hl')).toBe(true);
    // 存储落点：认领资源 文本提及的维度
    const joined = ifaceTexts(iface).join('\n');
    const expectDims = data.components.dimensionStorage
      .filter((s) => joined.includes(s.dimension))
      .map((s) => s.dimension)
      .sort();
    const hlDims = [...dom.window.document.querySelectorAll('.comp-storage-row.hl')]
      .map((r) => r.getAttribute('data-dimension'))
      .filter((x): x is string => !!x)
      .sort();
    expect(hlDims).toEqual(expectDims);
    // 协议层点击的接口行同步标记
    expect(dom.window.document.querySelector(`.proto-op-row[data-interface-id="${iface.id}"]`)!.classList.contains('hl-comp')).toBe(true);
  });

  test('③ 点拓扑节点（组件）→ 高亮其承载的全部接口（同面板 .hl + 协议层 .hl-comp）', () => {
    const data = loadSaasData() as SaasShape;
    const { dom } = setupDom(data);
    const compName = 'control-plane';
    const compImpls = data.components.interfaceImplementations.filter((im) => im.component === compName);
    const node = dom.window.document.querySelector(`.comp-topo-node[data-component="${compName}"]`)!;
    click(dom, node);
    expect(node.classList.contains('hl')).toBe(true);
    // 同面板：该组件全部接口行
    const hlRows = [...dom.window.document.querySelectorAll('.comp-impl-row.hl')];
    expect(hlRows.length).toBe(compImpls.length);
    for (const im of compImpls) {
      const r = dom.window.document.querySelector(`.comp-impl-row[data-interface-name="${im.interface}"]`)!;
      expect(r.classList.contains('hl')).toBe(true);
    }
    // 协议层：这些接口的操作行 .hl-comp（name → id）
    const ifaceIds = compImpls
      .map((im) => data.interfaces.find((i) => i.name === im.interface)?.id)
      .filter((x): x is string => !!x)
      .sort();
    const hlCompRows = [...dom.window.document.querySelectorAll('.proto-op-row.hl-comp')]
      .map((r) => r.getAttribute('data-interface-id'))
      .filter((x): x is string => !!x)
      .sort();
    expect(hlCompRows).toEqual(ifaceIds);
    expect(hlCompRows.length).toBe(compImpls.length);
    // 非该组件的接口行不误亮
    const other = data.components.interfaceImplementations.find((im) => im.component !== compName)!;
    expect(
      dom.window.document.querySelector(`.comp-impl-row[data-interface-name="${other.interface}"]`)!.classList.contains('hl')
    ).toBe(false);
  });

  test('④ 点组件列（接口表中的组件 span）→ 同③ 高亮承载接口（组件→接口 跳转入口二）', () => {
    const data = loadSaasData() as SaasShape;
    const { dom } = setupDom(data);
    const compName = 'data-plane';
    const compImpls = data.components.interfaceImplementations.filter((im) => im.component === compName);
    const cell = dom.window.document.querySelector(`.comp-impl-component[data-component="${compName}"]`)!;
    click(dom, cell);
    expect(dom.window.document.querySelectorAll('.comp-impl-row.hl').length).toBe(compImpls.length);
    for (const im of compImpls) {
      expect(
        dom.window.document.querySelector(`.comp-impl-row[data-interface-name="${im.interface}"]`)!.classList.contains('hl')
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// V5-5 老数据降级
// ---------------------------------------------------------------------------

describe('V5-5 老数据降级（无 components 字段 / 部分缺失）', () => {
  test('food-delivery data.json（无 components 字段）→ 面板显示"无组件层数据"缺省，不抛错', () => {
    const legacy = loadLegacyData() as Record<string, unknown>;
    expect(legacy.components).toBeUndefined();
    expect(() => setupDom(legacy)).not.toThrow();
    const { dom } = setupDom(legacy);
    const empty = dom.window.document.querySelector('.component-empty');
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toContain('无组件层数据');
    // 不渲染组件层面板主体（不崩）
    expect(dom.window.document.querySelector('.component-panel')).toBeNull();
  });

  test('未导入 data.json → 组件层面板不渲染（主视图已有提示，不重复）', () => {
    const { dom } = setupDom(null);
    expect(dom.window.document.querySelector('.component-empty')).toBeNull();
    expect(dom.window.document.querySelector('.component-panel')).toBeNull();
  });

  test('部分缺失（仅 interfaceImplementations）→ ① 渲染、②③④ 区块级空态，整体不崩', () => {
    const legacy = loadLegacyData() as Record<string, unknown>;
    const partial = {
      ...legacy,
      components: {
        interfaceImplementations: [{ interface: 'submit_order', component: 'order-service', description: 'x' }],
      },
    };
    expect(() => setupDom(partial)).not.toThrow();
    const { dom } = setupDom(partial);
    // ① 渲染 1 行（id 查表缺失 → data-interface-id 为空）
    const implRows = [...dom.window.document.querySelectorAll('.comp-impl-row')];
    expect(implRows.length).toBe(1);
    expect(implRows[0].textContent).toContain('order-service');
    // ②③ 区块级空态（④ 拓扑有节点无边，不显示空态）
    expect(dom.window.document.querySelectorAll('.comp-empty').length).toBe(2);
    expect(dom.window.document.querySelector('.comp-storage-section .comp-empty')?.textContent).toContain('dimensionStorage');
    expect(dom.window.document.querySelector('.comp-transfer-section .comp-empty')?.textContent).toContain('componentTransfers');
    // 拓扑：有组件节点但无边（节点 1 · 边 0）
    expect(dom.window.document.querySelectorAll('.comp-topo-node').length).toBe(1);
    expect(dom.window.document.querySelectorAll('.comp-topo-edge').length).toBe(0);
  });
});
