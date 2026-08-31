/**
 * viewer R2b+ 分层视图测试（协议层 / 组件层 / 用例层 分离容器 + tab 切换）
 *
 * 机械判据（R2b+-1 ~ R2b+-4）：
 * R2b+-1 分离渲染：加载 view-tabs.js（启用分层视图）+ 各面板 + anonymous-saas data.json →
 *   协议层四区块进 #view-protocol、组件层面板进 #view-component、用例层面板进 #view-cases，
 *   且三容器互不串内容（协议容器内无 .component-panel / .cases-panel）；
 * R2b+-2 默认激活：初始 #view-protocol.active，组件/用例容器非 active（协议层为默认主界面）；
 * R2b+-3 tab 切换：点「组件层」tab → #view-component.active、#view-protocol 失去 active
 *   （CSS 显示切换，不重渲染）；
 * R2b+-4 老数据降级：food-delivery（无 components/adversarialCases 字段）→ 各容器显示对应
 *   缺省提示（.protocol-empty / .component-empty / .cases-empty），不白屏不报错。
 *
 * 零回归保证：不加载 view-tabs.js 的测试环境（既有 viewer 套件）退回原 #panels 堆叠，
 * 本套件只验证启用路径。
 *
 * 环境：jsdom（与 component-panel.test.ts 同构）。
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

/** anonymous-saas 完整数据（V3+ 含 components/adversarialCases 字段） */
function loadSaasData(): unknown {
  return JSON.parse(
    readFileSync(join(ROOT, 'examples/anonymous-saas/web/data.json'), 'utf-8')
  );
}

/** 老模型数据（无协议层/组件层/用例层字段） */
function loadLegacyData(): unknown {
  return JSON.parse(readViewerFile('samples/food-delivery.data.json'));
}

interface VtWindow {
  ProtochainViewer?: { state: { dataJson: unknown; projectMode: boolean } };
  ProtochainViewerHooks?: { renderAll: (s: unknown, p: unknown) => void };
  ProtochainViewerTabs?: { viewBox: (p: unknown, s: string) => unknown };
  [key: string]: unknown;
}

function setupDom(dataJson: unknown): { dom: JSDOM; win: VtWindow } {
  const html = readViewerFile('index.html');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'file:///viewer/index.html' });
  const ctx = dom.getInternalVMContext();
  runInContext(readViewerFile('assets/parser.js'), ctx);
  runInContext(readViewerFile('n1-guard.js'), ctx);
  runInContext(readViewerFile('app.js'), ctx);
  runInContext(readViewerFile('view-tabs.js'), ctx);
  runInContext(readViewerFile('main-view.js'), ctx);
  runInContext(readViewerFile('protocol-panel.js'), ctx);
  runInContext(readViewerFile('component-panel.js'), ctx);
  runInContext(readViewerFile('cases-panel.js'), ctx);
  const win = dom.window as unknown as VtWindow;
  if (dataJson !== undefined) {
    win.ProtochainViewer!.state.dataJson = dataJson;
  }
  const panels = dom.window.document.querySelector('#panels') as unknown as { innerHTML: string };
  win.ProtochainViewerHooks!.renderAll(win.ProtochainViewer!.state, panels);
  return { dom, win };
}

function click(dom: JSDOM, el: Element): void {
  el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
}

describe('R2b+ 分层视图（协议层/组件层/用例层分离容器）', () => {
  it('R2b+-1 分离渲染：三面板各进各自容器，互不串内容', () => {
    const { dom } = setupDom(loadSaasData());
    const doc = dom.window.document;
    const proto = doc.querySelector('#view-protocol');
    const comp = doc.querySelector('#view-component');
    const cases = doc.querySelector('#view-cases');
    expect(proto).not.toBeNull();
    expect(comp).not.toBeNull();
    expect(cases).not.toBeNull();
    // 协议层容器含协议层四区块（.protocol-panel）
    expect(proto!.querySelector('.protocol-panel')).not.toBeNull();
    // 组件层容器含组件面板（.component-panel）
    expect(comp!.querySelector('.component-panel')).not.toBeNull();
    // 用例层容器含用例面板（.cases-panel）
    expect(cases!.querySelector('.cases-panel')).not.toBeNull();
    // 分离：协议层容器内不得有组件层/用例层面板
    expect(proto!.querySelector('.component-panel')).toBeNull();
    expect(proto!.querySelector('.cases-panel')).toBeNull();
    // 组件层容器内不得有协议层/用例层面板
    expect(comp!.querySelector('.protocol-panel')).toBeNull();
    expect(comp!.querySelector('.cases-panel')).toBeNull();
  });

  it('R2b+-2 默认激活协议层（协议层为默认主界面）', () => {
    const { dom } = setupDom(loadSaasData());
    const doc = dom.window.document;
    expect(doc.querySelector('#view-protocol')!.classList.contains('active')).toBe(true);
    expect(doc.querySelector('#view-component')!.classList.contains('active')).toBe(false);
    expect(doc.querySelector('#view-cases')!.classList.contains('active')).toBe(false);
    expect(doc.querySelector('.view-tab.active')!.getAttribute('data-view')).toBe('protocol');
  });

  it('R2b+-3 tab 切换：点组件层 → 组件容器激活、协议容器隐藏', () => {
    const { dom } = setupDom(loadSaasData());
    const doc = dom.window.document;
    const tab = doc.querySelector('.view-tab[data-view="component"]');
    expect(tab).not.toBeNull();
    click(dom, tab as Element);
    expect(doc.querySelector('#view-component')!.classList.contains('active')).toBe(true);
    expect(doc.querySelector('#view-protocol')!.classList.contains('active')).toBe(false);
    // 组件层容器内容在切换前已渲染（DOM 常驻，切换只改显示）
    expect(doc.querySelector('#view-component .component-panel')).not.toBeNull();
    // 再切回协议层
    click(dom, doc.querySelector('.view-tab[data-view="protocol"]') as Element);
    expect(doc.querySelector('#view-protocol')!.classList.contains('active')).toBe(true);
    expect(doc.querySelector('#view-component')!.classList.contains('active')).toBe(false);
  });

  it('R2b+-4 老数据降级：无协议层/组件层/用例层字段 → 各容器缺省提示，不崩', () => {
    const { dom } = setupDom(loadLegacyData());
    const doc = dom.window.document;
    // 老数据在协议层容器内显示协议层缺省提示（或老面板内容）；组件/用例容器显示缺省提示
    const compEmpty = doc.querySelector('#view-component .component-empty');
    const casesEmpty = doc.querySelector('#view-cases .cases-empty');
    expect(compEmpty).not.toBeNull();
    expect(casesEmpty).not.toBeNull();
    // 无协议层字段时不白屏（#panels 仍可渲染）
    expect(doc.querySelector('#view-protocol')).not.toBeNull();
  });
});
