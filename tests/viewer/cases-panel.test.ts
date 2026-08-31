/**
 * viewer V6 用例层面板测试（§11.4 用例视图）
 *
 * 机械判据（V6-3 / V6-4 / V6-5）：
 * V6-3 渲染：加载 anonymous-saas web/data.json →
 *   ① 路径用例区：55 条路径（testCases）渲染，行含 id / 长度徽章 / transitionIds / 验证徽章；
 *      点路径行展开显示覆盖的转移/状态（transitionIds[i]：stateIds[i] → stateIds[i+1]）；
 *      verification 执行结果徽章条（报告/通过/失败/跳过 + deviationSummary）。
 *   ② 对抗用例区：20 条按 kind 分组（convergence 11 / credential 9；
 *      R3a 六张清单形态无 observed-write 载体），
 *      credential 组内 credential-expired|revoked|lookup 各 3），
 *      每条显示 id / kind 徽章 / source 原文 / expectFailure / 断言摘要（body「断言」行）。
 * V6-4 交互：点 guard-failure 用例 source（fulfillment-payment P1）→ 协议层对应操作行高亮
 *            （.proto-op-row.hl-case，DOM 断言）；点 X12 收敛 source → 不变量列 + 约束操作行高亮。
 *            R3a：六张清单形态无 role 接口写 observed 维度 → X5 observed-write 用例载体缺失
 *            （generate-cases R4 差额显式降级），X5 source 指回测试随载体移除。
 * V6-5 老数据降级：food-delivery（有路径无对抗）→ 路径区渲染、对抗区空态不崩；
 *            fulfillment-payment P1（2 路径 + 2 对抗）→ 双区渲染正确；
 *            无 testCases/adversarialCases → 面板级缺省提示；未导入 → 不渲染。
 *
 * R2b 整合（组件层 + 用例层挂进 R2a 新架构，§11.3 两层 + §11.4 用例视图）：
 * R2b-2 三面板同页渲染：协议层主视图 + 组件层三表/拓扑 + 用例层 一次 renderAll 共存；
 * R2b-3 三视图互通：点对抗用例 source → 协议层不变量列/维度行 + 组件层存储落点
 *        （comp-storage-row.hl-case，§11.4「落在哪个存储」）同步高亮；
 * R2b-4 降级沿用 V6-5（无 components/adversarialCases → 区块空态不崩）。
 *
 * 环境：jsdom（与 protocol-panel / component-panel test 同构）。
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

function loadJson(rel: string): unknown {
  return JSON.parse(readFileSync(join(ROOT, rel), 'utf-8'));
}

/** anonymous-saas 完整数据（V3+ 含 testCases/adversarialCases/verification） */
function loadSaasData(): unknown {
  return loadJson('examples/anonymous-saas/web/data.json');
}

/** 老实例：履约支付 P1（2 路径 + 2 条 X6 guard-failure 对抗用例） */
function loadFulfillmentP1Data(): unknown {
  return loadJson('examples/fulfillment-payment/protocol/P1/web/data.json');
}

/** 老实例：外卖配送（7 路径、无对抗用例、有 verification） */
function loadFoodDeliveryData(): unknown {
  return loadJson('examples/food-delivery/web/data.json');
}

interface V6Window {
  ProtochainViewer?: { state: { dataJson: unknown } };
  [key: string]: unknown;
}

function setupDom(dataJson: unknown): { dom: JSDOM; win: V6Window } {
  const html = readViewerFile('index.html');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'file:///viewer/index.html' });
  const ctx = dom.getInternalVMContext();
  runInContext(readViewerFile('assets/parser.js'), ctx);
  runInContext(readViewerFile('n1-guard.js'), ctx);
  runInContext(readViewerFile('app.js'), ctx);
  runInContext(readViewerFile('main-view.js'), ctx);
  runInContext(readViewerFile('protocol-panel.js'), ctx);
  runInContext(readViewerFile('component-panel.js'), ctx);
  runInContext(readViewerFile('cases-panel.js'), ctx);
  const win = dom.window as unknown as V6Window;
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

// ---------------------------------------------------------------------------
// V6-3 渲染（anonymous-saas）
// ---------------------------------------------------------------------------

describe('V6-3 用例面板渲染（anonymous-saas）', () => {
  test('① 路径用例区：0 条路径（R3a 六张清单形态无状态机段）、verification 徽章条', () => {
    const data = loadSaasData() as {
      testCases: Array<{
        id: string;
        length: number;
        stateIds: string[];
        transitionIds: string[];
        verificationPassed?: boolean;
      }>;
      verification: { hasReport: boolean; passed: boolean; counts: Record<string, number>; deviationSummary: Record<string, number> };
    };
    const { dom } = setupDom(data);
    const panel = dom.window.document.querySelector('.cases-panel');
    expect(panel).not.toBeNull();
    // 路径行数 = testCases 数量（六张清单形态 generate-cases 无状态机路径 → 0）
    const rows = [...dom.window.document.querySelectorAll('.case-path-row')];
    expect(rows.length).toBe(data.testCases.length);
    expect(rows.length).toBe(0);
    // verification 徽章条：报告 + 通过/失败/跳过 计数（无 caseResults → 未验证）
    const bar = dom.window.document.querySelector('.case-verify-bar');
    expect(bar).not.toBeNull();
    expect(bar!.textContent).toContain('报告：未生成');
    expect(bar!.textContent).toContain(`通过 ${data.verification.counts.passed}`);
    expect(bar!.textContent).toContain(`失败 ${data.verification.counts.failed}`);
    expect(bar!.textContent).toContain(`跳过 ${data.verification.counts.skipped}`);
  });

  test('① R3a 六张清单形态（无状态机段）：testCases 为空 → 路径区 0 行、面板不崩', () => {
    const data = loadSaasData() as {
      testCases: Array<{ id: string }>;
    };
    expect(data.testCases).toHaveLength(0);
    const { dom } = setupDom(data);
    expect(dom.window.document.querySelectorAll('.case-path-row').length).toBe(0);
  });

  test('② 对抗用例区：20 条按 kind 分组（convergence 11 / credential 9；R3a 六张清单形态无 observed-write 载体），每条含 id/kind 徽章/source 原文/expectFailure/断言摘要', () => {
    const data = loadSaasData() as {
      adversarialCases: Array<{
        id: string;
        kind: string;
        source: string;
        expectFailure: boolean;
        body: string;
      }>;
    };
    const { dom } = setupDom(data);
    // 行数 = adversarialCases 数量
    const rows = [...dom.window.document.querySelectorAll('.case-adv-row')];
    expect(rows.length).toBe(data.adversarialCases.length);
    expect(rows.length).toBe(20);
    // 分组：observed-write 0（R3a 六张清单形态无 role 写 observed 维度 → X5 载体缺失，R4 差额显式降级）
    //        / convergence 11 / credential 9（credential-* 归组）
    const groupRows = (g: string): number =>
      dom.window.document.querySelectorAll(`.case-adv-group[data-kind-group="${g}"] .case-adv-row`).length;
    expect(groupRows('observed-write')).toBe(0);
    expect(groupRows('guard-failure')).toBe(0);
    expect(groupRows('convergence')).toBe(11);
    expect(groupRows('credential')).toBe(9);
    // credential 组内 kind 徽章：expired/revoked/lookup 各 3
    expect(dom.window.document.querySelectorAll('.case-kind-credential-expired').length).toBe(3);
    expect(dom.window.document.querySelectorAll('.case-kind-credential-revoked').length).toBe(3);
    expect(dom.window.document.querySelectorAll('.case-kind-credential-lookup').length).toBe(3);
    // 每条：id / kind 徽章 / source 原文（逐条相等）/ expectFailure / 断言摘要
    // 注意：casegen sanitizeId 存在 id 碰撞（如 X5_account_quota_______ 两条，维度名不同），
    // 故按「id + source」联合匹配，而非仅按 id 查行。
    const renderedSources = [...dom.window.document.querySelectorAll('.case-adv-row .case-adv-source-text')]
      .map((x) => x.textContent ?? '');
    const expectedSources = data.adversarialCases.map((c) => c.source);
    expect([...renderedSources].sort()).toEqual([...expectedSources].sort());
    for (const c of data.adversarialCases) {
      const row = [...dom.window.document.querySelectorAll('.case-adv-row')].find((r) => {
        const src = r.querySelector('.case-adv-source-text')!.textContent ?? '';
        return r.getAttribute('data-case-id') === c.id && src === c.source;
      })!;
      expect(row).not.toBeNull();
      expect(row.getAttribute('data-case-kind')).toBe(c.kind);
      expect(row.textContent).toContain(c.id);
      expect(row.querySelector(`.case-kind-${c.kind}`)).not.toBeNull();
      // source 原文展示（J2 判据核心：指回 model.md 声明）
      expect(row.querySelector('.case-adv-source-text')!.textContent).toBe(c.source);
      // expectFailure 徽章
      if (c.expectFailure === true) {
        expect(row.querySelector('.case-adv-expect-fail')).not.toBeNull();
        expect(row.textContent).toContain('期望失败');
      }
      // 断言摘要：body「断言」行解析（非空）
      const summary = row.querySelector('.case-adv-assert-text')!.textContent ?? '';
      expect(summary.length).toBeGreaterThan(0);
      const bodyLines = c.body.split('\n').map((l) => l.replace(/^\s*\*\s?/, '').trim());
      const assertLine = bodyLines.find((l) => l.includes('断言'));
      if (assertLine) expect(summary).toContain(assertLine.replace(/^\s*\*\s?/, '').trim());
    }
  });
});

// ---------------------------------------------------------------------------
// V6-4 交互（source 指回联动）
// ---------------------------------------------------------------------------

describe('V6-4 source 指回联动（点 source 高亮协议层）', () => {
  test('guard-failure 用例（fulfillment-payment P1）：点 source → 协议层对应操作行（confirm_order → IF_SYS_T1）高亮', () => {
    const data = loadFulfillmentP1Data() as {
      adversarialCases: Array<{ id: string; kind: string; interfaceId: string }>;
      interfaces: Array<{ id: string; name: string }>;
    };
    const { dom } = setupDom(data);
    // 前置：协议层面板已渲染（P1 有 invariants → 交叉面板含操作行）
    expect(dom.window.document.querySelectorAll('.proto-op-row').length).toBe(data.interfaces.length);
    const gf = data.adversarialCases.find((a) => a.kind === 'guard-failure' && a.interfaceId === 'confirm_order')!;
    expect(gf).toBeDefined();
    const src = dom.window.document.querySelector(`.case-adv-row[data-case-id="${gf.id}"] .case-adv-source`)!;
    expect(src.textContent).toContain('转移 T1（action=confirm_order）');
    click(dom, src);
    // 协议层对应操作行高亮（interfaceId=action → 接口 name 查表 → id IF_SYS_T1）
    const opRow = dom.window.document.querySelector(`.proto-op-row[data-interface-id="IF_SYS_T1"]`)!;
    expect(opRow.classList.contains('hl-case')).toBe(true);
    // 用例行自身反馈
    expect(dom.window.document.querySelector(`.case-adv-row[data-case-id="${gf.id}"]`)!.classList.contains('hl')).toBe(true);
  });

  test('X12 收敛用例（anonymous-saas）：点 source → 不变量列 + 其约束的操作行高亮', () => {
    const data = loadSaasData() as {
      adversarialCases: Array<{ id: string; kind: string; interfaceId: string }>;
    };
    const { dom } = setupDom(data);
    const conv = data.adversarialCases.find((a) => a.kind === 'convergence' && a.interfaceId === 'INV-1')!;
    expect(conv).toBeDefined();
    const src = dom.window.document.querySelector(`.case-adv-row[data-case-id="${conv.id}"] .case-adv-source`)!;
    expect(src.textContent).toContain('INV-1');
    click(dom, src);
    // 不变量列高亮
    expect(
      dom.window.document.querySelector(`.proto-inv-col[data-invariant-id="INV-1"]`)!.classList.contains('hl-case')
    ).toBe(true);
    // 其约束的操作行（invariantIds 显式 ∪ 文本提及）≥1
    expect(dom.window.document.querySelectorAll('.proto-op-row.hl-case').length).toBeGreaterThan(0);
  });

  // R3a：X5 observed-write source 指回测试已移除——六张清单形态无 role 接口写 observed 维度，
  // X5 用例载体缺失（generate-cases R4 差额显式降级于 test-cases.json degradedReasons），
  // source 指回交互已按新形态重建（下方 R2b-3：X12 收敛用例 → 协议层 + 组件层存储落点）。
});

// ---------------------------------------------------------------------------
// R2b 整合（组件层 + 用例层挂进 R2a 新架构；§11.3 两层 + §11.4 用例视图）
// ---------------------------------------------------------------------------

describe('R2b 组件层 + 用例层整合（anonymous-saas）', () => {
  test('R2b-2 三面板同页渲染：协议层主视图 + 组件层三表/拓扑 + 用例层 一次 renderAll 共存', () => {
    const data = loadSaasData() as {
      interfaces: unknown[];
      components: {
        interfaceImplementations: unknown[];
        dimensionStorage: unknown[];
        componentTransfers: unknown[];
      };
      testCases: unknown[];
      adversarialCases: unknown[];
    };
    const { dom } = setupDom(data);
    // 三面板同页（renderAll 链尾叠加：protocol 清空 #panels 后 component/cases 顺序追加）
    expect(dom.window.document.querySelector('.protocol-panel')).not.toBeNull();
    expect(dom.window.document.querySelector('.component-panel')).not.toBeNull();
    expect(dom.window.document.querySelector('.cases-panel')).not.toBeNull();
    // 组件层三表（24/17/2）+ 拓扑节点/边（R2b-2）
    const implRows = dom.window.document.querySelectorAll('.comp-impl-row').length;
    expect(implRows).toBe(data.components.interfaceImplementations.length);
    expect(implRows).toBe(24);
    expect(dom.window.document.querySelectorAll('.comp-storage-row').length).toBe(
      data.components.dimensionStorage.length
    );
    expect(dom.window.document.querySelectorAll('.comp-transfer-row').length).toBe(
      data.components.componentTransfers.length
    );
    expect(dom.window.document.querySelectorAll('.comp-transfer-row').length).toBe(2);
    expect(dom.window.document.querySelectorAll('.comp-topo-node').length).toBeGreaterThan(0);
    expect(dom.window.document.querySelectorAll('.comp-topo-edge').length).toBe(2);
    // 用例层（R3a 六张清单形态：0 路径 + 20 对抗按 kind 分组）
    expect(dom.window.document.querySelectorAll('.case-path-row').length).toBe(data.testCases.length);
    expect(dom.window.document.querySelectorAll('.case-adv-row').length).toBe(data.adversarialCases.length);
  });

  test('R2b-3 三视图互通：点 X12 收敛 source → 协议层不变量列/维度行 + 组件层存储落点同步高亮（§11.4「落在哪个存储」）', () => {
    const data = loadSaasData() as {
      adversarialCases: Array<{ id: string; kind: string; interfaceId: string }>;
      invariants: Array<{ id: string; dimensions: string[] }>;
      components: { dimensionStorage: Array<{ dimension: string }> };
    };
    const { dom } = setupDom(data);
    const conv = data.adversarialCases.find((a) => a.kind === 'convergence' && a.interfaceId === 'INV-1')!;
    expect(conv).toBeDefined();
    const src = dom.window.document.querySelector(`.case-adv-row[data-case-id="${conv.id}"] .case-adv-source`)!;
    click(dom, src);
    // 协议层：不变量列高亮（既有 V6-4 行为不回退）+ 维度行高亮
    expect(
      dom.window.document.querySelector(`.proto-inv-col[data-invariant-id="INV-1"]`)!.classList.contains('hl-case')
    ).toBe(true);
    // 组件层：INV-1 的 dimensions（归属状态/处置状态/访问策略）→ comp-storage-row.hl-case
    const invDims = data.invariants.find((i) => i.id === 'INV-1')!.dimensions;
    expect(invDims.length).toBeGreaterThan(0);
    const hlStorage = [...dom.window.document.querySelectorAll('.comp-storage-row.hl-case')]
      .map((r) => r.getAttribute('data-dimension'))
      .filter((x): x is string => !!x);
    for (const dim of invDims) {
      expect(hlStorage).toContain(dim);
      expect(
        dom.window.document.querySelector(`.comp-storage-row[data-dimension="${dim}"]`)!.classList.contains('hl-case')
      ).toBe(true);
    }
    // 非 INV-1 维度的存储行不误亮
    const invDimSet = new Set(invDims);
    for (const s of data.components.dimensionStorage) {
      if (!invDimSet.has(s.dimension)) {
        expect(
          dom.window.document.querySelector(`.comp-storage-row[data-dimension="${s.dimension}"]`)!.classList.contains('hl-case')
        ).toBe(false);
      }
    }
  });

  test('R2b-3 复用：点 credential 用例 source（提及 认领码 凭证）→ 协议层操作行 + 不变量高亮不崩、可再点其它 source 清旧高亮', () => {
    const data = loadSaasData() as {
      adversarialCases: Array<{ id: string; kind: string; interfaceId: string }>;
    };
    const { dom } = setupDom(data);
    const cred = data.adversarialCases.find((a) => a.kind === 'credential-expired' && a.interfaceId === '认领码')!;
    expect(cred).toBeDefined();
    const src = dom.window.document.querySelector(`.case-adv-row[data-case-id="${cred.id}"] .case-adv-source`)!;
    expect(() => click(dom, src)).not.toThrow();
    // 旧高亮清除机制：再点另一条用例 source → 前一条的 hl-case 被清除（不残留）
    const conv = data.adversarialCases.find((a) => a.kind === 'convergence' && a.interfaceId === 'INV-2')!;
    const src2 = dom.window.document.querySelector(`.case-adv-row[data-case-id="${conv.id}"] .case-adv-source`)!;
    click(dom, src2);
    expect(
      dom.window.document.querySelector(`.proto-inv-col[data-invariant-id="INV-2"]`)!.classList.contains('hl-case')
    ).toBe(true);
    expect(dom.window.document.querySelectorAll('.comp-storage-row.hl-case').length).toBeGreaterThan(0);
    // 前一条用例自身行反馈已清除
    expect(
      dom.window.document.querySelector(`.case-adv-row[data-case-id="${cred.id}"]`)!.classList.contains('hl')
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// V6-5 老数据降级
// ---------------------------------------------------------------------------

describe('V6-5 老数据降级', () => {
  test('food-delivery（7 路径、无对抗用例）→ 路径区渲染 7 行、对抗区空态，不崩', () => {
    const data = loadFoodDeliveryData() as {
      testCases: Array<{ id: string }>;
      adversarialCases?: unknown;
    };
    expect(data.adversarialCases).toBeUndefined();
    expect(() => setupDom(data)).not.toThrow();
    const { dom } = setupDom(data);
    expect(dom.window.document.querySelector('.cases-panel')).not.toBeNull();
    // 路径区渲染数量正确
    expect(dom.window.document.querySelectorAll('.case-path-row').length).toBe(data.testCases.length);
    expect(dom.window.document.querySelectorAll('.case-path-row').length).toBe(7);
    // 对抗区空态（不崩）
    expect(dom.window.document.querySelector('.case-adv-section .case-empty')?.textContent).toContain('无对抗用例');
    expect(dom.window.document.querySelectorAll('.case-adv-row').length).toBe(0);
  });

  test('fulfillment-payment P1（2 路径 + 2 条 X6 guard-failure）→ 双区渲染正确，不崩', () => {
    const data = loadFulfillmentP1Data() as {
      testCases: Array<{ id: string }>;
      adversarialCases: Array<{ id: string; kind: string; source: string }>;
    };
    expect(() => setupDom(data)).not.toThrow();
    const { dom } = setupDom(data);
    expect(dom.window.document.querySelector('.cases-panel')).not.toBeNull();
    // 路径区 2 行
    expect(dom.window.document.querySelectorAll('.case-path-row').length).toBe(data.testCases.length);
    // 对抗区 2 行，guard-failure 分组
    expect(dom.window.document.querySelectorAll('.case-adv-row').length).toBe(data.adversarialCases.length);
    expect(dom.window.document.querySelectorAll('.case-adv-group[data-kind-group="guard-failure"] .case-adv-row').length).toBe(2);
    // source 原文可见（J2：指回 model.md 声明）
    for (const a of data.adversarialCases) {
      const row = dom.window.document.querySelector(`.case-adv-row[data-case-id="${a.id}"]`)!;
      expect(row.querySelector('.case-adv-source-text')!.textContent).toBe(a.source);
    }
  });

  test('无 testCases 且无 adversarialCases 的 data.json → 面板级缺省提示，不崩', () => {
    const legacy = loadJson('viewer/samples/food-delivery.data.json') as Record<string, unknown>;
    expect(() => setupDom(legacy)).not.toThrow();
    const { dom } = setupDom(legacy);
    const empty = dom.window.document.querySelector('.cases-empty');
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toContain('无用例数据');
    expect(dom.window.document.querySelector('.cases-panel')).toBeNull();
  });

  test('未导入 data.json → 用例面板不渲染', () => {
    const { dom } = setupDom(null);
    expect(dom.window.document.querySelector('.cases-empty')).toBeNull();
    expect(dom.window.document.querySelector('.cases-panel')).toBeNull();
  });
});
