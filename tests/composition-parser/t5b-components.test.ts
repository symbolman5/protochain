/**
 * T5b 机械验收：组合层组件映射段（跨协议组件归属）
 *
 * - T5b-2 parser：composition.md 组件映射段 → crossProtocolComponents IR；checker 交叉校验
 *   （跨协议引用悬空硬失败正反向：protocolId / component / interface）
 * - T5b-5 老实例零回归：无组件映射段的组合层 → undefined（零输出）
 */
import { parseCompositionContent } from '../../src/composition-parser/index.js';
import { checkCompositionCompleteness } from '../../src/composition-checker/index.js';
import type { CompositionModel, SourceProtocolModel, DerivableLayer } from '../../src/model/types.js';

function mkSubModel(name: string, sourcePath: string, ops: string[]): SourceProtocolModel {
  const derivable: DerivableLayer = {
    degraded: false,
    states: [
      { id: 'S1', name: 'S1', type: 'initial', dimensions: [] },
      { id: 'S2', name: 'S2', type: 'terminal', dimensions: [] },
    ],
    transitions: [],
    operations: ops.map((n, i) => ({
      id: `OP${i + 1}`,
      name: n,
      triggerRoleId: 'system',
      target: '实体',
      targetEntities: ['实体'],
      guard: '无',
      change: '',
      changes: [],
      affectsDimensions: [],
      sideEffects: [],
      triggerType: 'role',
    })),
    invariants: [],
    timing: [],
    exceptions: [],
    initialStateId: 'S1',
    terminalStateIds: ['S2'],
  };
  return {
    metadata: { name, version: '1.0.0', purpose: 't5b', roles: [] },
    readable: { background: 'b', concepts: [], workflow: 'w' },
    derivable,
    contractInput: undefined,
    sourcePath,
  };
}

const BASE_COMPOSITION = `# 系统元数据

\`\`\`yaml
systemName: 测试系统
version: 0.1.0
changeType: protocol_extend
\`\`\`

# 子协议清单

\`\`\`yaml
- protocolId: P1
  name: P1 域
  version: 1.0.0
  modelPath: protocol/P1/model.md
- protocolId: P2
  name: P2 域
  version: 1.0.0
  modelPath: protocol/P2/model.md
\`\`\`

# 依赖图

\`\`\`mermaid
graph LR
  P1 --> P2
\`\`\`

\`\`\`yaml
- from: P1
  to: P2
  dependencyType: state
  description: 依赖
\`\`\`

# 组件映射

\`\`\`yaml
components:
  - name: control-plane
    description: 管理面（跨 P1/P2）
    baseUrl: https://control.example.com
    auth: bearer
  - name: data-plane
    auth: none
interfaceImplementations:
  - interface: 登录
    protocolId: P1
    component: control-plane
  - interface: 认领资源
    protocolId: P2
    component: control-plane
\`\`\`
`;

describe('T5b-2 parser：组件映射段解析', () => {
  test('组件定义 + 接口归属（interface → component + protocolId）→ 完整 IR', () => {
    const cm = parseCompositionContent(BASE_COMPOSITION, 'protocol/composition.md');
    expect(cm.crossProtocolComponents).toBeDefined();
    expect(cm.crossProtocolComponents!.components).toHaveLength(2);
    expect(cm.crossProtocolComponents!.components![0]).toMatchObject({
      name: 'control-plane',
      description: '管理面（跨 P1/P2）',
      baseUrl: 'https://control.example.com',
      auth: 'bearer',
    });
    expect(cm.crossProtocolComponents!.interfaceImplementations).toEqual([
      { interface: '登录', protocolId: 'P1', component: 'control-plane' },
      { interface: '认领资源', protocolId: 'P2', component: 'control-plane' },
    ]);
  });

  test('老组合层（无组件映射段）→ crossProtocolComponents 缺省（零回归）', () => {
    const md = BASE_COMPOSITION.replace(/# 组件映射[\s\S]*$/, '');
    const cm = parseCompositionContent(md, 'x.md');
    expect(cm.crossProtocolComponents).toBeUndefined();
  });
});

describe('T5b-2 checker：跨协议引用交叉校验（正反向）', () => {
  test('合法映射（protocolId ∈ subProtocols、component ∈ 定义、interface ∈ 子协议）→ 无 error', () => {
    const cm = parseCompositionContent(BASE_COMPOSITION);
    const subModels = [mkSubModel('P1 域', 'protocol/P1/model.md', ['登录']), mkSubModel('P2 域', 'protocol/P2/model.md', ['认领资源'])];
    const report = checkCompositionCompleteness(cm, [], { subProtocolModels: subModels });
    const errs = report.mechanical.referenceIssues.filter((i) => i.severity === 'error');
    expect(errs).toHaveLength(0);
  });

  test('protocolId 悬空（不在子协议清单）→ error（硬失败）', () => {
    const md = BASE_COMPOSITION.replace('protocolId: P2\n    component: control-plane', 'protocolId: P9\n    component: control-plane');
    const cm = parseCompositionContent(md);
    const report = checkCompositionCompleteness(cm, [], { subProtocolModels: [] });
    const errs = report.mechanical.referenceIssues.filter(
      (i) => i.severity === 'error' && i.message.includes('P9') && i.message.includes('不在')
    );
    expect(errs.length).toBeGreaterThanOrEqual(1);
    expect(report.mechanical.passed).toBe(false);
  });

  test('component 悬空（不在组件定义）→ error（硬失败）', () => {
    const md = BASE_COMPOSITION.replace('component: control-plane\n  - interface: 认领资源', 'component: ghost-service\n  - interface: 认领资源');
    const cm = parseCompositionContent(md);
    const report = checkCompositionCompleteness(cm, [], { subProtocolModels: [] });
    const errs = report.mechanical.referenceIssues.filter(
      (i) => i.severity === 'error' && i.message.includes('ghost-service') && i.message.includes('组件定义悬空')
    );
    expect(errs.length).toBeGreaterThanOrEqual(1);
  });

  test('interface 悬空（不在对应子协议模型）→ error（硬失败）', () => {
    const cm = parseCompositionContent(BASE_COMPOSITION);
    const subModels = [mkSubModel('P1 域', 'protocol/P1/model.md', ['其他接口'])];
    const report = checkCompositionCompleteness(cm, [], { subProtocolModels: subModels });
    const errs = report.mechanical.referenceIssues.filter(
      (i) => i.severity === 'error' && i.message.includes('在子协议 P1 中不存在')
    );
    expect(errs.length).toBeGreaterThanOrEqual(1);
  });
});
