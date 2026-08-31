/**
 * T5b viewer 组合层视图（第三层）机械验收
 *
 * - T5b-3 渲染：组合层 data（子协议拓扑 3 节点 + 5 跨协议不变量 + 事件契约 + 组件归属）
 *   → 组合层面板出现；数据缺省空态不崩
 * - T5b-4 既有组合层面板零回归（协议节点/依赖边/引用边照常）
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

/** 组合层 data.json（带 crossProtocolComponents / invariantSpans 详情 / 事件契约） */
function compositionData(): unknown {
  return {
    schemaVersion: '1.1',
    composition: { systemName: '测试系统', version: '0.1.0', changeType: 'protocol_extend' },
    protocols: [
      { id: 'P1', name: 'P1 域', version: '1.0.0' },
      { id: 'P2', name: 'P2 域', version: '1.0.0' },
      { id: 'P3', name: 'P3 域', version: '1.0.0' },
    ],
    dependencyGraph: {
      mermaid: 'graph LR',
      edges: [
        { from: 'P1', to: 'P2', dependencyType: 'state', description: '状态依赖' },
        { from: 'P2', to: 'P3', dependencyType: 'event', description: '控制面→数据面推送访问策略副本（INV-11）' },
      ],
    },
    crossRefs: [],
    invariantSpans: [
      { id: 'INV-11', name: '数据面访问策略副本一致', span: ['P2', 'P3'], protocols: ['P2', 'P3'], checkMethod: '对账', expression: '副本 = 控制面策略' },
    ],
    crossProtocolComponents: {
      components: [
        { name: 'control-plane', description: '管理面', baseUrl: 'https://control.example.com', auth: 'bearer' },
        { name: 'data-plane', auth: 'none' },
      ],
      interfaceImplementations: [
        { interface: '登录', protocolId: 'P1', component: 'control-plane' },
        { interface: '认领资源', protocolId: 'P2', component: 'control-plane' },
      ],
    },
    sharedMatrix: { sharedObjects: [] },
    warnings: [],
  };
}

function setupDom(dataJson: unknown): { dom: JSDOM } {
  const html = readViewerFile('index.html');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'file:///viewer/index.html' });
  const ctx = dom.getInternalVMContext();
  runInContext(readViewerFile('assets/parser.js'), ctx);
  runInContext(readViewerFile('n1-guard.js'), ctx);
  runInContext(readViewerFile('app.js'), ctx);
  runInContext(readViewerFile('main-view.js'), ctx);
  runInContext(readViewerFile('protocol-panel.js'), ctx);
  runInContext(readViewerFile('composition-panel.js'), ctx);
  const win = dom.window as unknown as { ProtochainViewer?: { state: { dataJson: unknown } } };
  win.ProtochainViewer!.state.dataJson = dataJson;
  const panels = dom.window.document.querySelector('#panels') as unknown as { innerHTML: string };
  (dom.window as unknown as { ProtochainViewerHooks: { renderAll: (s: unknown, p: unknown) => void } })
    .ProtochainViewerHooks.renderAll(win.ProtochainViewer!.state, panels);
  return { dom };
}

describe('T5b-3 组合层视图渲染（第三层）', () => {
  test('子协议拓扑 3 节点 + 跨协议不变量（span/checkMethod）+ 事件契约 + 组件归属', () => {
    const { dom } = setupDom(compositionData());
    const panel = dom.window.document.querySelector('.composition-panel');
    expect(panel).not.toBeNull();
    // 子协议拓扑：3 节点
    expect(dom.window.document.querySelectorAll('.proto-node').length).toBe(3);
    // 跨协议不变量：span + checkMethod 详情
    const invRow = dom.window.document.querySelector('.inv-span-row')!;
    expect(invRow.textContent).toContain('INV-11');
    expect(invRow.textContent).toContain('span=[P2, P3]');
    expect(invRow.textContent).toContain('检测方式：对账');
    // 事件契约（dependencyType=event 边）
    const evRow = dom.window.document.querySelector('.ev-row')!;
    expect(evRow).not.toBeNull();
    expect(evRow.textContent).toContain('P2');
    expect(evRow.textContent).toContain('P3');
    expect(evRow.textContent).toContain('INV-11');
    // 组合层组件归属：组件定义 + 接口→组件+子协议
    const compChips = [...dom.window.document.querySelectorAll('.compo-comp-chip')];
    expect(compChips.length).toBe(2);
    expect(compChips[0].textContent).toContain('control-plane');
    expect(compChips[0].textContent).toContain('bearer');
    const iiRows = [...dom.window.document.querySelectorAll('.compo-comp-ii-row')];
    expect(iiRows.length).toBe(2);
    expect(iiRows[0].textContent).toContain('登录');
    expect(iiRows[0].textContent).toContain('P1');
    expect(iiRows[1].textContent).toContain('认领资源');
    expect(iiRows[1].textContent).toContain('P2');
  });

  test('点不变量 → 高亮关联子协议节点（跳转复用 .proto-node.hl）', () => {
    const { dom } = setupDom(compositionData());
    const row = dom.window.document.querySelector('.inv-span-row')!;
    row.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    expect(row.classList.contains('hl')).toBe(true);
    const hlNodes = [...dom.window.document.querySelectorAll('.proto-node.hl')].map((n) => n.getAttribute('data-protocol-id'));
    expect(hlNodes.sort()).toEqual(['P2', 'P3']);
  });

  test('缺省：无 crossProtocolComponents → 组件归属区块不渲染，不崩', () => {
    const data = compositionData() as Record<string, unknown>;
    delete data.crossProtocolComponents;
    const { dom } = setupDom(data);
    expect(dom.window.document.querySelector('.composition-panel')).not.toBeNull();
    expect(dom.window.document.querySelector('.compo-comp-chip')).toBeNull();
    // 事件契约 / 拓扑照常
    expect(dom.window.document.querySelector('.ev-row')).not.toBeNull();
  });

  test('误导入单协议 data.json → 显式提示需组合层数据（不崩）', () => {
    const { dom } = setupDom({ schemaVersion: '1.0', interfaces: [] });
    const empty = dom.window.document.querySelector('.composition-empty');
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toContain('需组合层');
  });
});
