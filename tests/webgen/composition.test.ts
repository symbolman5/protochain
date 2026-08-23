/**
 * E7-B1 组合层视图 —— 单元测试
 *
 * 覆盖范围（IMPLEMENTATION-PLAN.md §E7 v0.4 B1）：
 * - 跨协议引用提取（E1-I2 正则口径：含 P\d 或括号注解）
 * - 关联矩阵 / 共享台账 / 不变量覆盖映射
 * - 子协议 specs 老格式 → envelopeMigrate 自动迁移
 * - 子协议 specs 缺失 / JSON 损坏 → 防御性 warning + 不阻断
 * - 敏感字段过滤复用（redactSensitiveFields）
 * - 单协议模式（无 composition.md）→ 无 --project 时不参与；--project 抛错
 * - deriveProjectWeb 整体产出（data.json + 站点页面）
 */

import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import {
  extractCrossRefFragments,
  extractProtocolFromFragment,
  extractTargetFromFragment,
  snippet,
  extractRefsFromInterface,
  extractRefsFromCrossInvariants,
  extractRefsFromDependencyGraph,
  loadSubProtocolSpecs,
  buildInvariantSpans,
  buildSharedMatrix,
  buildCompositionWebData,
  deriveProjectWeb,
  renderProjectPage,
  renderCrossRefsPage,
  renderCrossDiffSkeleton,
  renderSubProtocolPage,
  renderProjectInterfaceDetailPage,
  renderProjectInterfaceBindingSection,
  renderProjectVitePressConfig,
  type CompositionWebData,
} from '../../src/webgen/composition.js';
import type { WebBindingView } from '../../src/webgen/index.js';
import type {
  CompositionModel,
  CrossInvariantDef,
  DependencyEdge,
  ErrorResponseDef,
} from '../../src/model/types.js';
import type { InterfaceSpec } from '../../src/model/types.js';

// ---------------------------------------------------------------------------
// 测试辅助：构造 composition.md + specs.json 临时项目根
// ---------------------------------------------------------------------------

/** 构造临时组合层项目根（含 composition.md + 各子协议 derived/specs.json） */
function makeProject(opts: {
  compositionYaml?: string;
  subProtocols?: Array<{
    id: string;
    name: string;
    version?: string;
    specs?: InterfaceSpec[] | { _rawArray: InterfaceSpec[] } | { _corrupt: string };
  }>;
  compositionYamlMeta?: Record<string, unknown>;
}): string {
  const tmp = mkdtempSync(join(tmpdir(), `webgen-comp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`));
  mkdirSync(join(tmp, 'protocol'), { recursive: true });

  const meta = opts.compositionYamlMeta ?? {};
  const metaYaml = [
    `systemName: ${meta.systemName ?? 'TestSystem'}`,
    `version: ${meta.version ?? '0.1.0'}`,
    `changeType: ${meta.changeType ?? 'protocol_tweak'}`,
  ].join('\n');

  const subs = opts.subProtocols ?? [];
  const subsYaml = subs
    .map(
      (s, i) =>
        `  - protocolId: ${s.id}\n    name: ${s.name}\n    version: ${s.version ?? '0.1.0'}\n    modelPath: protocol/${s.id}/model.md`
    )
    .join('\n');

  // 可选 edges / crossInvariants 通过 opts.compositionYaml 注入
  const composition = `# 系统元数据

\`\`\`yaml
${metaYaml}
\`\`\`

# 子协议清单

\`\`\`yaml
${subsYaml}
\`\`\`

# 依赖图

\`\`\`yaml
  - from: P2
    to: P1
    dependencyType: state
    description: P1 写操作守卫依赖 P2 会话
\`\`\`

${opts.compositionYaml ?? ''}
`;
  writeFileSync(join(tmp, 'protocol/composition.md'), composition, 'utf-8');

  for (const sub of subs) {
    mkdirSync(join(tmp, 'protocol', sub.id, 'derived'), { recursive: true });
    if (sub.specs === undefined) continue;
    if ('_corrupt' in sub.specs) {
      writeFileSync(join(tmp, 'protocol', sub.id, 'derived', 'specs.json'), sub.specs._corrupt, 'utf-8');
    } else if ('_rawArray' in sub.specs) {
      // 老格式裸数组
      writeFileSync(
        join(tmp, 'protocol', sub.id, 'derived', 'specs.json'),
        JSON.stringify(sub.specs._rawArray, null, 2),
        'utf-8'
      );
    } else {
      // Envelope 形态
      const envelope = {
        schemaVersion: '1.0' as const,
        generatedAt: new Date().toISOString(),
        sourceModelVersion: sub.version ?? '0.1.0',
        specs: sub.specs,
      };
      writeFileSync(
        join(tmp, 'protocol', sub.id, 'derived', 'specs.json'),
        JSON.stringify(envelope, null, 2),
        'utf-8'
      );
    }
  }

  return tmp;
}

/** 构造一个最小 InterfaceSpec */
function mkIface(
  id: string,
  name: string,
  opts?: {
    precondition?: string;
    preconditions?: Array<{ kind: string; description?: string }>;
    inputs?: Array<{ name: string; type: string; description?: string; required?: boolean }>;
    outputs?: Array<{ name: string; type: string; description?: string }>;
    postconditions?: string[];
    invariantIds?: string[];
    schemaKind?: 'structured' | 'legacy-stub' | 'description-only';
  }
): InterfaceSpec {
  const iface: InterfaceSpec = {
    id,
    name,
    kind: 'system',
    sourceId: id,
    inputs: opts?.inputs ?? [],
    outputs: opts?.outputs ?? [],
    postconditions: opts?.postconditions ?? [],
  };
  if (opts?.precondition !== undefined) iface.precondition = opts.precondition;
  if (opts?.preconditions) iface.preconditions = opts.preconditions as InterfaceSpec['preconditions'];
  if (opts?.invariantIds) iface.invariantIds = opts.invariantIds;
  if (opts?.schemaKind) iface.schemaKind = opts.schemaKind;
  return iface;
}

// ---------------------------------------------------------------------------
// extractCrossRefFragments / extractProtocolFromFragment / extractTargetFromFragment
// ---------------------------------------------------------------------------

describe('extractCrossRefFragments', () => {
  test('空文本返回空数组', () => {
    expect(extractCrossRefFragments(undefined)).toEqual([]);
    expect(extractCrossRefFragments('')).toEqual([]);
  });

  test('命中 P\\d 前缀', () => {
    expect(extractCrossRefFragments('P2.account.S1_active')).toEqual(['P2.account']);
    expect(extractCrossRefFragments('P10.foo')).toEqual(['P10.foo']);
  });

  test('命中全角括号注解', () => {
    expect(extractCrossRefFragments('归属（P2）')).toEqual(['（P2）']);
    expect(extractCrossRefFragments('S1（P1 网卡入口归属账户活跃）')).toEqual(['（P1 网卡入口归属账户活跃）']);
  });

  test('命中半角括号注解', () => {
    expect(extractCrossRefFragments('(P2.entry)')).toEqual(['(P2.entry)']);
  });

  test('混合 P\\d 前缀与括号注解（去重保序）', () => {
    // '归属 P2（账户活跃）'：P2 是 P\d 前缀；（账户活跃）是括号注解但不含 P\d
    // 两者都是机械提取出的片段；引用分析层 extractProtocolFromFragment 会再过滤
    expect(extractCrossRefFragments('归属 P2（账户活跃）')).toEqual(['P2', '（账户活跃）']);
  });

  test('无跨协议引用 → 空数组', () => {
    expect(extractCrossRefFragments('这是一段纯中文文本')).toEqual([]);
    // 协议前缀 P 后必须紧跟数字才视为跨协议引用；纯字符（如 PX、P_foo）不命中
    expect(extractCrossRefFragments('P_one.foo')).toEqual([]);
    expect(extractCrossRefFragments('XYZ123')).toEqual([]);
  });

  test('去重保序', () => {
    const r = extractCrossRefFragments('P2.foo and P2.foo and P3.bar');
    expect(r).toEqual(['P2.foo', 'P3.bar']);
  });
});

describe('extractProtocolFromFragment', () => {
  test('P\\d 前缀', () => {
    expect(extractProtocolFromFragment('P2')).toBe('P2');
    expect(extractProtocolFromFragment('P2.account')).toBe('P2');
    expect(extractProtocolFromFragment('P10.foo')).toBe('P10');
  });

  test('括号注解内', () => {
    expect(extractProtocolFromFragment('（P2）')).toBe('P2');
    expect(extractProtocolFromFragment('（P2.account）')).toBe('P2');
    expect(extractProtocolFromFragment('S1（P1 网卡入口）')).toBe('P1');
  });

  test('无协议 ID → null', () => {
    expect(extractProtocolFromFragment('（账户活跃）')).toBeNull();
    expect(extractProtocolFromFragment('Pxx')).toBeNull();
  });
});

describe('extractTargetFromFragment', () => {
  test('P\\d.xxx 形式', () => {
    expect(extractTargetFromFragment('P2.account')).toBe('account');
    expect(extractTargetFromFragment('P10.user_domains')).toBe('user_domains');
  });

  test('括号内 P\\d.xxx', () => {
    expect(extractTargetFromFragment('（P2.entry）')).toBe('entry');
    expect(extractTargetFromFragment('（Pn S1（P2.account）状态）')).toBe('account');
  });

  test('无 target', () => {
    expect(extractTargetFromFragment('P2')).toBeUndefined();
    expect(extractTargetFromFragment('（P2）')).toBeUndefined();
  });
});

describe('snippet', () => {
  test('抽取匹配周围上下文', () => {
    const text = '前置条件：依赖 P2.account 活跃态 且 网卡入口归属账户活跃（若有）';
    const s = snippet(text, 'P2.account');
    expect(s).toContain('P2.account');
    expect(s.length).toBeLessThanOrEqual(50);
  });

  test('匹配在开头/末尾', () => {
    expect(snippet('P2.account 在最前', 'P2.account')).toMatch(/^P2.account/);
    expect(snippet('结尾是 P2', 'P2')).toMatch(/P2…?$/);
  });
});

// ---------------------------------------------------------------------------
// extractRefsFromInterface（E1-I2 跨协议引用识别口径）
// ---------------------------------------------------------------------------

describe('extractRefsFromInterface', () => {
  const validIds = new Set(['P1', 'P2']);

  test('从 precondition 提取 P2 引用', () => {
    const iface = mkIface('IF_SYS_T1', 'register', {
      precondition: 'P2.account = S1_active AND session.valid = true',
    });
    const refs = extractRefsFromInterface('P1', iface, validIds);
    expect(refs.length).toBeGreaterThanOrEqual(1);
    expect(refs.some((r) => r.toProtocol === 'P2' && r.kind === 'guard')).toBe(true);
    expect(refs.every((r) => r.fromProtocol === 'P1' && r.fromApi === 'IF_SYS_T1')).toBe(true);
  });

  test('从 inputs[].description 提取括号注解', () => {
    const iface = mkIface('IF_SYS_T1', 'register', {
      inputs: [
        { name: 'ownerId', type: 'string', description: '归属账户 ID（引用 P2.account）', required: true },
      ],
    });
    const refs = extractRefsFromInterface('P1', iface, validIds);
    expect(refs.some((r) => r.toProtocol === 'P2' && r.target === 'account')).toBe(true);
  });

  test('从 postconditions 提取', () => {
    const iface = mkIface('IF_SYS_T1', 'register', {
      postconditions: ['建立会话（P2.session.valid = true）'],
    });
    const refs = extractRefsFromInterface('P1', iface, validIds);
    expect(refs.length).toBeGreaterThanOrEqual(1);
  });

  test('自引用排除', () => {
    const iface = mkIface('IF_SYS_T1', 'register', {
      precondition: 'P1.accounts.S1 AND P1.servers.online',
    });
    const refs = extractRefsFromInterface('P1', iface, validIds);
    expect(refs.length).toBe(0);
  });

  test('外部协议排除（不在 validProtocolIds）', () => {
    const iface = mkIface('IF_SYS_T1', 'register', {
      precondition: 'P99.foo = true',
    });
    const refs = extractRefsFromInterface('P1', iface, validIds);
    expect(refs.length).toBe(0);
  });

  test('无跨协议引用 → 空数组', () => {
    const iface = mkIface('IF_SYS_T1', 'register', {
      precondition: '当前状态 S0',
    });
    expect(extractRefsFromInterface('P1', iface, validIds)).toEqual([]);
  });

  test('kind 一律为 guard（interface 上下文）', () => {
    const iface = mkIface('IF_SYS_T1', 'register', {
      precondition: 'P2.account 活跃',
    });
    const refs = extractRefsFromInterface('P1', iface, validIds);
    expect(refs.every((r) => r.kind === 'guard')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractRefsFromCrossInvariants
// ---------------------------------------------------------------------------

describe('extractRefsFromCrossInvariants', () => {
  const validIds = new Set(['P1', 'P2', 'P3']);

  test('从 expression 提取', () => {
    const inv: CrossInvariantDef[] = [
      {
        id: 'CI1',
        name: 'P1 写操作会话守卫',
        span: ['P1', 'P2'],
        expression: 'P2.account = S1_active AND P2.session.valid = true',
        declaredBy: 'system',
        checkMethod: '控制面守卫校验',
        complexity: 'simple_boolean',
      },
    ];
    const refs = extractRefsFromCrossInvariants(inv, validIds);
    // span 中已含 P2，不重复（invariant 是自身 span，不入 crossRefs）
    expect(refs.length).toBe(0);
  });

  test('跨 span 引用（不变量提到 span 外的协议）', () => {
    const inv: CrossInvariantDef[] = [
      {
        id: 'CI1',
        name: '示例',
        span: ['P1', 'P2'],
        expression: 'P3.domain 状态正常',
        declaredBy: 'system',
        checkMethod: 'check',
        complexity: 'simple_boolean',
      },
    ];
    const refs = extractRefsFromCrossInvariants(inv, validIds);
    expect(refs.some((r) => r.toProtocol === 'P3' && r.kind === 'invariant')).toBe(true);
  });

  test('kind=invariant', () => {
    const inv: CrossInvariantDef[] = [
      {
        id: 'CI_X',
        name: 'x',
        span: ['P1'],
        expression: 'P3.foo 状态',
        declaredBy: 'system',
        checkMethod: '',
        complexity: 'simple_boolean',
      },
    ];
    const refs = extractRefsFromCrossInvariants(inv, validIds);
    expect(refs.every((r) => r.kind === 'invariant')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractRefsFromDependencyGraph
// ---------------------------------------------------------------------------

describe('extractRefsFromDependencyGraph', () => {
  const validIds = new Set(['P1', 'P2', 'P3']);

  test('依赖边 description 中命中 P\\d', () => {
    const edges: DependencyEdge[] = [
      {
        from: 'P2',
        to: 'P1',
        dependencyType: 'state',
        description: 'P1 写操作守卫依赖 P2.account 活跃态',
      },
    ];
    const refs = extractRefsFromDependencyGraph(edges, validIds);
    // P2→P1 边，P2 from，P1 是被依赖的协议
    expect(refs.some((r) => r.toProtocol === 'P1' && r.kind === 'shared')).toBe(true);
    expect(refs.every((r) => r.fromProtocol === 'P2')).toBe(true);
  });

  test('自引用边（from === to）→ 跳过', () => {
    const edges: DependencyEdge[] = [
      {
        from: 'P1',
        to: 'P1',
        dependencyType: 'state',
        description: 'P1.foo = bar',
      },
    ];
    expect(extractRefsFromDependencyGraph(edges, validIds).length).toBe(0);
  });

  test('外部协议排除', () => {
    const edges: DependencyEdge[] = [
      {
        from: 'P1',
        to: 'P2',
        dependencyType: 'state',
        description: 'P99.foo 不存在',
      },
    ];
    expect(extractRefsFromDependencyGraph(edges, validIds).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// loadSubProtocolSpecs（含 envelopeMigrate）
// ---------------------------------------------------------------------------

describe('loadSubProtocolSpecs', () => {
  test('Envelope 形态直接读取', () => {
    const iface = mkIface('IF_SYS_T1', 'register', {
      precondition: '状态合法',
      schemaKind: 'structured',
    });
    const tmp = makeProject({
      subProtocols: [{ id: 'P1', name: 'X', specs: [iface] }],
    });
    const r = loadSubProtocolSpecs(tmp, { protocolId: 'P1', name: 'X', version: '0.1.0', modelPath: 'protocol/P1/model.md' });
    expect(r.available).toBe(true);
    expect(r.specs.length).toBe(1);
    expect(r.warnings.length).toBe(0);
  });

  test('老格式裸数组 → envelopeMigrate 自动迁移', () => {
    const iface = mkIface('IF_SYS_T1', 'register', {
      precondition: '状态合法',
      schemaKind: undefined,
    });
    const tmp = makeProject({
      subProtocols: [{ id: 'P1', name: 'X', specs: { _rawArray: [iface] } }],
    });
    const r = loadSubProtocolSpecs(tmp, { protocolId: 'P1', name: 'X', version: '0.1.0', modelPath: 'protocol/P1/model.md' });
    expect(r.available).toBe(true);
    expect(r.specs.length).toBe(1);
    expect(r.envelope?.migrated).toBe(true);
    expect(r.warnings.some((w) => w.includes('自动迁移'))).toBe(true);
  });

  test('specs.json 不存在 → warning + available=false', () => {
    const tmp = makeProject({
      subProtocols: [{ id: 'P1', name: 'X' }],
    });
    const r = loadSubProtocolSpecs(tmp, { protocolId: 'P1', name: 'X', version: '0.1.0', modelPath: 'protocol/P1/model.md' });
    expect(r.available).toBe(false);
    expect(r.specs.length).toBe(0);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  test('JSON 损坏 → warning + available=false', () => {
    const tmp = makeProject({
      subProtocols: [{ id: 'P1', name: 'X', specs: { _corrupt: '{not valid json' } }],
    });
    const r = loadSubProtocolSpecs(tmp, { protocolId: 'P1', name: 'X', version: '0.1.0', modelPath: 'protocol/P1/model.md' });
    expect(r.available).toBe(false);
    expect(r.warnings.some((w) => w.includes('JSON 解析失败'))).toBe(true);
  });

  test('不可识别形态 → warning + available=false', () => {
    const tmp = makeProject({
      subProtocols: [{ id: 'P1', name: 'X', specs: { _corrupt: '"just a string"' } }],
    });
    const r = loadSubProtocolSpecs(tmp, { protocolId: 'P1', name: 'X', version: '0.1.0', modelPath: 'protocol/P1/model.md' });
    expect(r.available).toBe(false);
    expect(r.warnings.some((w) => w.includes('不可识别'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildInvariantSpans / buildSharedMatrix
// ---------------------------------------------------------------------------

describe('buildInvariantSpans', () => {
  test('跨协议不变量 → 关联接口（按 invariantIds 匹配）', () => {
    const composition = {
      crossInvariants: [
        {
          id: 'CI1',
          name: 'P1 写操作会话守卫',
          span: ['P1', 'P2'],
          expression: '',
          declaredBy: 'system',
          checkMethod: '',
          complexity: 'simple_boolean' as const,
        },
      ],
    } as unknown as CompositionModel;
    const subSpecs = new Map<string, InterfaceSpec[]>([
      ['P1', [mkIface('IF_SYS_T1', 'register', { invariantIds: ['CI1'] })]],
      ['P2', []],
    ]);
    const spans = buildInvariantSpans(composition, subSpecs);
    expect(spans.length).toBe(1);
    expect(spans[0].id).toBe('CI1');
    expect(spans[0].linkedApis).toEqual([{ protocol: 'P1', interfaceId: 'IF_SYS_T1' }]);
  });

  test('无匹配接口 → linkedApis=[]', () => {
    const composition = {
      crossInvariants: [
        { id: 'CI1', name: 'x', span: ['P1'], expression: '', declaredBy: 'system', checkMethod: '', complexity: 'simple_boolean' as const },
      ],
    } as unknown as CompositionModel;
    const subSpecs = new Map<string, InterfaceSpec[]>([['P1', [mkIface('IF_SYS_T1', 'register')]]]);
    expect(buildInvariantSpans(composition, subSpecs)[0].linkedApis).toEqual([]);
  });
});

describe('buildSharedMatrix', () => {
  test('sharedObjects + crossObservations', () => {
    const composition = {
      objectStateFacets: [
        {
          object: 'fqdn_registry',
          idKey: 'fqdn',
          facets: [
            { protocol: 'P3', dimensions: ['fqdn', 'mapping_id'], description: '映射域名' },
            { protocol: 'P4', dimensions: ['fqdn', 'site_id'], description: '托管站点域名' },
          ],
          crossFacetConstraints: [],
        },
      ],
      observationInterfaces: [
        {
          id: 'OI_FQDN_GLOBAL',
          name: 'FQDN 全局视图',
          observer: 'admin',
          scope: 'cross_protocol',
          permissionBoundary: 'platform',
          readOnly: true as const,
          observable: [
            { protocol: 'P3', object: 'fqdn_registry', fields: ['fqdn', 'mapping_id'] },
            { protocol: 'P4', object: 'fqdn_registry', fields: ['fqdn', 'site_id'] },
          ],
        },
      ],
    } as unknown as CompositionModel;
    const m = buildSharedMatrix(composition);
    expect(m.sharedObjects.length).toBe(1);
    expect(m.sharedObjects[0].protocols).toEqual(['P3', 'P4']);
    expect(m.crossObservations.length).toBe(1);
    expect(m.crossObservations[0].observableProtocols).toEqual(['P3', 'P4']);
  });
});

// ---------------------------------------------------------------------------
// buildCompositionWebData
// ---------------------------------------------------------------------------

describe('buildCompositionWebData', () => {
  test('完整组合层数据：子协议 + 跨协议引用 + 不变量覆盖 + 关联矩阵', () => {
    const p1 = mkIface('IF_SYS_T1', 'register', {
      precondition: 'P2.account = S1_active',
      schemaKind: 'structured',
    });
    const p2 = mkIface('IF_SYS_T1', 'firstLogin', {
      precondition: '外部 token 验签通过',
      schemaKind: 'structured',
    });

    const composition: CompositionModel = {
      metadata: { systemName: 'TestSystem', version: '0.1.0', changeType: 'protocol_tweak' },
      subProtocols: [
        { protocolId: 'P1', name: '甲', version: '0.1.0', modelPath: 'protocol/P1/model.md' },
        { protocolId: 'P2', name: '乙', version: '0.1.0', modelPath: 'protocol/P2/model.md' },
      ],
      dependencyGraph: { mermaid: 'graph LR\n  P2-->P1', edges: [
        { from: 'P2', to: 'P1', dependencyType: 'state', description: 'P1 写操作守卫依赖 P2 会话' },
      ] },
      crossInvariants: [
        { id: 'CI1', name: 'P1 写操作会话守卫', span: ['P1', 'P2'], expression: 'P2.account = S1_active', declaredBy: 'system', checkMethod: '', complexity: 'simple_boolean' },
      ],
      crossTiming: [],
      externalDependencies: [],
      observationInterfaces: [],
      objectStateFacets: [],
      securityAssumptions: [],
      sourcePath: '',
      parsedAt: '',
    } as unknown as CompositionModel;

    const subSpecs = new Map<string, InterfaceSpec[]>([
      ['P1', [p1]],
      ['P2', [p2]],
    ]);
    const subEnvelopes = new Map<string, import('../../src/specifier/envelope.js').SpecsEnvelope | null>([
      ['P1', null],
      ['P2', null],
    ]);

    const data = buildCompositionWebData(composition, subSpecs, subEnvelopes);

    expect(data.composition.systemName).toBe('TestSystem');
    expect(data.protocols.length).toBe(2);
    expect(data.protocols[0].interfaceCount).toBe(1);
    expect(data.protocols[0].schemaSummary).toMatch(/structured=1/);

    expect(data.dependencyGraph.edges.length).toBe(1);
    expect(data.crossRefs.some((r) => r.toProtocol === 'P2' && r.kind === 'guard')).toBe(true);
    expect(data.crossRefs.some((r) => r.kind === 'shared')).toBe(true);

    expect(data.invariantSpans.length).toBe(1);
    expect(data.invariantSpans[0].id).toBe('CI1');

    expect(data.sharedMatrix.sharedObjects.length).toBe(0);
    expect(data.sharedMatrix.crossObservations.length).toBe(0);
  });

  test('空 composition（无 subProtocols）→ 数据结构仍有效', () => {
    const composition: CompositionModel = {
      metadata: { systemName: 'Empty', version: '0.1.0', changeType: 'protocol_tweak' },
      subProtocols: [],
      dependencyGraph: { mermaid: '', edges: [] },
      crossInvariants: [],
      crossTiming: [],
      externalDependencies: [],
      observationInterfaces: [],
      objectStateFacets: [],
      securityAssumptions: [],
      sourcePath: '',
      parsedAt: '',
    } as unknown as CompositionModel;

    const data = buildCompositionWebData(composition, new Map(), new Map());
    expect(data.protocols).toEqual([]);
    expect(data.crossRefs).toEqual([]);
    expect(data.invariantSpans).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 渲染函数（人读非裸 JSON）
// ---------------------------------------------------------------------------

describe('renderProjectPage', () => {
  const sampleData = {
    composition: { systemName: 'hskNG', version: '0.7.0', changeType: 'protocol_extend' },
    protocols: [
      { id: 'P1', name: '甲', version: '0.7.0', modelPath: 'protocol/P1/model.md', interfaceCount: 12, systemInterfaceCount: 8, observationInterfaceCount: 4, specsAvailable: true, schemaSummary: 'structured=12' },
      { id: 'P2', name: '乙', version: '0.7.0', modelPath: 'protocol/P2/model.md', interfaceCount: 6, systemInterfaceCount: 4, observationInterfaceCount: 2, specsAvailable: true, schemaSummary: 'structured=6' },
    ],
    dependencyGraph: { mermaid: 'graph LR\n  P2-->P1\n  P2-->P3', edges: [
      { from: 'P2', to: 'P1', dependencyType: 'state' as const, description: 'sessions' },
    ] },
    crossRefs: [
      { fromProtocol: 'P1', fromApi: 'IF_SYS_T1', sourceField: 'precondition', kind: 'guard' as const, toProtocol: 'P2', target: 'account', context: '…P2.account…' },
    ],
    invariantSpans: [
      { id: 'CI1', name: 'P1 写操作会话守卫', protocols: ['P1', 'P2'], declaredBy: 'system', complexity: 'simple_boolean' as const, linkedApis: [{ protocol: 'P1', interfaceId: 'IF_SYS_T1' }] },
    ],
    sharedMatrix: { sharedObjects: [], crossObservations: [] },
    warnings: [],
  } as unknown as CompositionWebData;

  test('包含项目名 + 子协议卡片 + 依赖图 mermaid', () => {
    const md = renderProjectPage(sampleData);
    expect(md).toContain('# hskNG');
    expect(md).toContain('## 子协议概览');
    expect(md).toContain('P1');
    expect(md).toContain('## 依赖图（mermaid）');
    expect(md).toContain('graph LR');
    expect(md).toContain('https://mermaid.live');
  });

  test('子协议快速跳转链接（目录式 + 尾斜杠，B1-I5 修复）', () => {
    const md = renderProjectPage(sampleData);
    // B1-I5 修复：目录式路由必须用尾斜杠（VitePress cleanUrls: P1/index.md → /protocols/P1/）
    expect(md).toContain('protocols/P1/');
    expect(md).toContain('protocols/P2/');
    expect(md).not.toContain('protocols/P1/ ');  // 不能写成 "protocols/P1/ —"
    expect(md).not.toContain('protocols/P2/ ');
  });

  test('跨协议引用汇总 + 警告', () => {
    const dataWithWarn = { ...sampleData, warnings: ['测试警告'] };
    const md = renderProjectPage(dataWithWarn);
    expect(md).toContain('测试警告');
    expect(md).toContain('跨协议引用');
  });
});

describe('renderCrossRefsPage', () => {
  const sampleData = {
    composition: { systemName: 'X', version: '0.1.0', changeType: 'protocol_tweak' },
    protocols: [],
    dependencyGraph: { mermaid: '', edges: [] },
    crossRefs: [
      { fromProtocol: 'P1', fromApi: 'IF_SYS_T1', sourceField: 'precondition', kind: 'guard' as const, toProtocol: 'P2', context: '…' },
    ],
    invariantSpans: [
      { id: 'CI1', name: 'x', protocols: ['P1', 'P2'], declaredBy: 'system', complexity: 'simple_boolean' as const, linkedApis: [] },
    ],
    sharedMatrix: {
      sharedObjects: [{ object: 'fqdn', idKey: 'fqdn', protocols: ['P3', 'P4'], description: 'd' }],
      crossObservations: [{ id: 'OI1', name: 'o', scope: 's', observer: 'admin', observableProtocols: ['P3', 'P4'] }],
    },
    warnings: [],
  } as unknown as CompositionWebData;

  test('包含关联矩阵 + 观测接口 + 引用分组 + 不变量覆盖', () => {
    const md = renderCrossRefsPage(sampleData);
    expect(md).toContain('共享实体 / 关联矩阵');
    expect(md).toContain('跨协议观测接口');
    expect(md).toContain('P1 → P2');
    expect(md).toContain('跨协议不变量覆盖映射');
    expect(md).toContain('CI1');
  });

  test('空 crossRefs → 显示 (无跨协议引用)', () => {
    const md = renderCrossRefsPage({ ...sampleData, crossRefs: [] });
    expect(md).toContain('*(无跨协议引用)*');
  });
});

describe('renderCrossDiffSkeleton', () => {
  test('显示待 E9 接通', () => {
    const md = renderCrossDiffSkeleton({
      composition: { systemName: 'X', version: '0.1.0', changeType: 'protocol_tweak' },
      protocols: [],
      dependencyGraph: { mermaid: '', edges: [] },
      crossRefs: [],
      invariantSpans: [],
      sharedMatrix: { sharedObjects: [], crossObservations: [] },
      warnings: [],
    });
    expect(md).toContain('待 E9 接通');
    expect(md).toContain('禁止');
    expect(md).toContain('diff --cross-protocol');
  });
});

describe('renderSubProtocolPage', () => {
  const proto = {
    id: 'P1',
    name: '甲',
    version: '0.1.0',
    modelPath: 'protocol/P1/model.md',
    interfaceCount: 1,
    systemInterfaceCount: 1,
    observationInterfaceCount: 0,
    specsAvailable: true,
    schemaSummary: 'structured=1',
  };
  const specs = [mkIface('IF_SYS_T1', 'register', { precondition: '状态合法', schemaKind: 'structured' })];
  const crossRefs = [
    { fromProtocol: 'P1', fromApi: 'IF_SYS_T1', sourceField: 'precondition', kind: 'guard' as const, toProtocol: 'P2', context: '…' },
    { fromProtocol: 'P2', fromApi: 'IF_SYS_T1', sourceField: 'precondition', kind: 'guard' as const, toProtocol: 'P1', context: '…' },
  ];

  test('包含接口列表 + 跨协议引用双向表', () => {
    const md = renderSubProtocolPage(proto, specs, crossRefs);
    expect(md).toContain('# P1');
    expect(md).toContain('## 接口列表');
    expect(md).toContain('## 跨协议引用');
    expect(md).toContain('### 引用其他协议');
    expect(md).toContain('### 被其他协议引用');
  });

  test('无 specs → 显示空提示', () => {
    const md = renderSubProtocolPage(proto, [], []);
    expect(md).toContain('*(specs.json 不可读或为空)*');
  });

  test('无跨协议引用 → 仍渲染但显示 0 条', () => {
    const md = renderSubProtocolPage(proto, specs, []);
    expect(md).toContain('引用其他协议：**0** 条');
    expect(md).toContain('被其他协议引用：**0** 条');
  });
});

// ---------------------------------------------------------------------------
// B1-I5 修复：接口详情链接恢复
// ---------------------------------------------------------------------------

describe('B1-I5 修复：接口详情链接', () => {
  const sampleProto = {
    id: 'P1',
    name: '甲',
    version: '0.1.0',
    modelPath: 'protocol/P1/model.md',
    interfaceCount: 2,
    systemInterfaceCount: 2,
    observationInterfaceCount: 0,
    specsAvailable: true,
    schemaSummary: 'structured=2',
  } as unknown as SubProtocolSummary;
  const sampleSpecs = [
    mkIface('IF_SYS_T1', 'register', {
      precondition: 'P2.account = S1_active',
      schemaKind: 'structured',
    }),
    mkIface('IF_SYS_T2', 'bind', {
      precondition: '节点存在',
      schemaKind: 'structured',
    }),
  ];

  test('renderSubProtocolPage 接口 ID 列表转链接（不是纯文本）', () => {
    const md = renderSubProtocolPage(sampleProto, sampleSpecs, []);
    // 接口 ID 列必须含 markdown 链接语法
    expect(md).toContain('[IF_SYS_T1](IF_SYS_T1)');
    expect(md).toContain('[IF_SYS_T2](IF_SYS_T2)');
    // 不能整段被 raw 文本（无方括号）独占一格
    expect(md).not.toMatch(/^\| IF_SYS_T1 \|/m);
  });

  test('renderProjectInterfaceDetailPage 含返回链接 + 跨协议引用', () => {
    const crossRefs: CrossProtocolRef[] = [
      {
        fromProtocol: 'P1',
        fromApi: 'IF_SYS_T1',
        sourceField: 'precondition',
        kind: 'guard',
        toProtocol: 'P2',
        target: 'account',
        context: '…P2.account = S1_active…',
      },
    ];
    const md = renderProjectInterfaceDetailPage(sampleProto, sampleSpecs[0], crossRefs);
    // 顶部导航：返回子协议（B1-I5 修复：目录式路由 + 尾斜杠）
    expect(md).toContain('[← 返回 P1 甲](../P1/)');
    // 接口元数据
    expect(md).toContain('`IF_SYS_T1`');
    // 跨协议引用小节
    expect(md).toContain('## 跨协议引用（与本接口相关）');
    expect(md).toContain('P2.account');
    // 底部导航
    expect(md).toContain('[项目总览](../../)');
  });

  test('renderProjectInterfaceDetailPage 无相关引用时显示空提示', () => {
    const md = renderProjectInterfaceDetailPage(sampleProto, sampleSpecs[1], []);
    expect(md).toContain('*(本接口未涉及跨协议引用)*');
  });

  test('deriveProjectWeb 生成 protocols/P1/index.md + 每个接口的详情页', async () => {
    const tmp = makeProject({
      subProtocols: [{ id: 'P1', name: '甲', specs: sampleSpecs }],
    });
    const dataJsonPath = join(tmp, 'web/data.json');
    await deriveProjectWeb({ rootDir: tmp, dataJsonPath, buildProjectSite: false });
    // 子协议索引（拆目录）
    expect(existsSync(join(tmp, 'web/docs/protocols/P1/index.md'))).toBe(true);
    expect(existsSync(join(tmp, 'web/docs/protocols/P1.md'))).toBe(false); // 已废弃
    // 每个接口的详情页
    expect(existsSync(join(tmp, 'web/docs/protocols/P1/IF_SYS_T1.md'))).toBe(true);
    expect(existsSync(join(tmp, 'web/docs/protocols/P1/IF_SYS_T2.md'))).toBe(true);
    // data.json 顶层 protocols[].firstInterfaceId + interfaceIds（B1-I5 新字段）
    const data = JSON.parse(readFileSync(dataJsonPath, 'utf-8'));
    expect(data.protocols[0].firstInterfaceId).toBe('IF_SYS_T1');
    expect(data.protocols[0].interfaceIds).toEqual(['IF_SYS_T1', 'IF_SYS_T2']);
  });

  test('renderSubProtocolPage：跨协议引用表的源接口列也转链接', () => {
    const crossRefs: CrossProtocolRef[] = [
      {
        fromProtocol: 'P1',
        fromApi: 'IF_SYS_T1',
        sourceField: 'precondition',
        kind: 'guard',
        toProtocol: 'P2',
        target: 'account',
        context: '…',
      },
    ];
    const md = renderSubProtocolPage(sampleProto, sampleSpecs, crossRefs);
    // outgoing 表中 fromApi 应转链接
    expect(md).toContain('[IF_SYS_T1](IF_SYS_T1)');
  });

  test('B1-I5 修复：deriveProjectWeb 清理 v0.1 遗留的 protocols/<id>.md', async () => {
    // 预置 v0.1 风格的遗留文件（之前版本生成的）
    const tmp = makeProject({
      subProtocols: [{ id: 'P1', name: '甲', specs: sampleSpecs }],
    });
    const legacyDir = join(tmp, 'web/docs/protocols');
    mkdirSync(legacyDir, { recursive: true });
    const legacy = join(legacyDir, 'P1.md');
    writeFileSync(legacy, '# legacy v0.1 content\n', 'utf-8');

    const dataJsonPath = join(tmp, 'web/data.json');
    await deriveProjectWeb({ rootDir: tmp, dataJsonPath, buildProjectSite: false });

    // 遗留 P1.md 应被清理（避免与 P1/index.md 路由冲突）
    expect(existsSync(legacy)).toBe(false);
    // P1/index.md 应保留
    expect(existsSync(join(tmp, 'web/docs/protocols/P1/index.md'))).toBe(true);
  });
});

describe('renderProjectVitePressConfig', () => {
  test('包含项目视图导航 + 侧栏', () => {
    const cfg = renderProjectVitePressConfig();
    expect(cfg).toContain('项目总览');
    expect(cfg).toContain('跨协议引用');
    expect(cfg).toContain('跨协议 diff');
    expect(cfg).toContain('子协议');
    expect(cfg).toContain('defineConfig');
  });
});

// ---------------------------------------------------------------------------
// B1-I1 修复：schemaVersion 顶层字段
// ---------------------------------------------------------------------------

describe('B1-I1 修复：组合层 schemaVersion 区分模式', () => {
  test('buildCompositionWebData 顶层 schemaVersion=1.1 + generatedAt', () => {
    const composition: CompositionModel = {
      metadata: { systemName: 'X', version: '0.1.0', changeType: 'protocol_tweak' },
      subProtocols: [],
      dependencyGraph: { mermaid: '', edges: [] },
      crossInvariants: [],
      crossTiming: [],
      externalDependencies: [],
      observationInterfaces: [],
      objectStateFacets: [],
      securityAssumptions: [],
      sourcePath: '',
      parsedAt: '',
    } as unknown as CompositionModel;
    const data = buildCompositionWebData(composition, new Map(), new Map());
    expect(data.schemaVersion).toBe('1.1');
    expect(typeof data.generatedAt).toBe('string');
    expect(new Date(data.generatedAt).toString()).not.toBe('Invalid Date');
  });

  test('deriveProjectWeb 产物顶层 schemaVersion=1.1（与单协议 1.0 区分）', async () => {
    const tmp = makeProject({
      subProtocols: [{ id: 'P1', name: '甲', specs: [mkIface('IF_SYS_T1', 'register', { schemaKind: 'structured' })] }],
    });
    const dataJsonPath = join(tmp, 'web/data.json');
    await deriveProjectWeb({ rootDir: tmp, dataJsonPath, buildProjectSite: false });
    const data = JSON.parse(readFileSync(dataJsonPath, 'utf-8'));
    expect(data.schemaVersion).toBe('1.1');
    expect(typeof data.generatedAt).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// 整体 deriveProjectWeb（端到端：data.json + 页面）
// ---------------------------------------------------------------------------

describe('deriveProjectWeb', () => {
  test('完整多协议项目 → 产物落盘 + data.json 结构', async () => {
    const p1 = mkIface('IF_SYS_T1', 'register', {
      precondition: 'P2.account = S1_active',
      schemaKind: 'structured',
    });
    const p2 = mkIface('IF_SYS_T1', 'firstLogin', {
      precondition: '外部 token 验签通过',
      schemaKind: 'structured',
    });
    const tmp = makeProject({
      compositionYamlMeta: { systemName: 'TestSystem', version: '0.1.0', changeType: 'protocol_tweak' },
      subProtocols: [
        { id: 'P1', name: '甲', specs: [p1] },
        { id: 'P2', name: '乙', specs: [p2] },
      ],
    });
    const dataJsonPath = join(tmp, 'web/data.json');
    const result = await deriveProjectWeb({
      rootDir: tmp,
      dataJsonPath,
      buildProjectSite: false,
    });
    expect(existsSync(dataJsonPath)).toBe(true);
    expect(result.data.protocols.length).toBe(2);
    expect(result.data.crossRefs.length).toBeGreaterThan(0);
    expect(existsSync(join(tmp, 'web/docs/index.md'))).toBe(true);
    expect(existsSync(join(tmp, 'web/docs/protocols/index.md'))).toBe(true);
    expect(existsSync(join(tmp, 'web/docs/cross-refs.md'))).toBe(true);
    expect(existsSync(join(tmp, 'web/docs/cross-diff.md'))).toBe(true);
    // B1-I5：拆目录 protocols/P1/index.md + protocols/P1/<iface>.md
    expect(existsSync(join(tmp, 'web/docs/protocols/P1/index.md'))).toBe(true);
    expect(existsSync(join(tmp, 'web/docs/protocols/P2/index.md'))).toBe(true);
    // 接口详情页：B1-I5
    expect(existsSync(join(tmp, 'web/docs/protocols/P1/IF_SYS_T1.md'))).toBe(true);
  });

  test('缺少 composition.md → 抛错', async () => {
    const tmp = mkdtempSync(join(tmpdir(), `webgen-comp-empty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`));
    mkdirSync(join(tmp, 'protocol'), { recursive: true });
    await expect(deriveProjectWeb({ rootDir: tmp, buildProjectSite: false })).rejects.toThrow(/composition\.md/);
  });

  test('任一子协议 specs.json 缺失 → 不阻断 + warning', async () => {
    const tmp = makeProject({
      subProtocols: [
        { id: 'P1', name: '甲', specs: [mkIface('IF_SYS_T1', 'register')] },
        { id: 'P2', name: '乙' /* specs 缺失 */ },
      ],
    });
    const result = await deriveProjectWeb({
      rootDir: tmp,
      buildProjectSite: false,
    });
    expect(result.data.protocols.length).toBe(2);
    expect(result.data.protocols[1].specsAvailable).toBe(false);
    expect(result.warnings.some((w) => w.includes('specs.json 不存在'))).toBe(true);
  });

  test('任一子协议 specs.json 老格式 → envelopeMigrate + warning', async () => {
    const rawIface = mkIface('IF_SYS_T1', 'register');
    const tmp = makeProject({
      subProtocols: [
        { id: 'P1', name: '甲', specs: { _rawArray: [rawIface] } },
        { id: 'P2', name: '乙' },
      ],
    });
    const result = await deriveProjectWeb({
      rootDir: tmp,
      buildProjectSite: false,
    });
    expect(result.data.protocols[0].migrated).toBe(true);
    expect(result.warnings.some((w) => w.includes('自动迁移'))).toBe(true);
  });

  test('--force 缺省 → 已存在产物抛错', async () => {
    const p1 = mkIface('IF_SYS_T1', 'register', { schemaKind: 'structured' });
    const tmp = makeProject({
      subProtocols: [{ id: 'P1', name: '甲', specs: [p1] }],
    });
    const dataJsonPath = join(tmp, 'web/data.json');
    await deriveProjectWeb({ rootDir: tmp, dataJsonPath, buildProjectSite: false });
    await expect(
      deriveProjectWeb({ rootDir: tmp, dataJsonPath, buildProjectSite: false })
    ).rejects.toThrow(/已存在/);
    await expect(
      deriveProjectWeb({ rootDir: tmp, dataJsonPath, buildProjectSite: false, force: true })
    ).resolves.toBeDefined();
  });

  test('敏感字段过滤：组合层产物不含 tokenEnv/secretEnv 等', async () => {
    const p1: InterfaceSpec = {
      ...mkIface('IF_SYS_T1', 'register', { precondition: '状态合法', schemaKind: 'structured' }),
      // 故意注入敏感字段（防御性测试）
      // 注：InterfaceSpec 实际类型不含这些字段；但 redactSensitiveFields 递归遍历会兜住
    } as InterfaceSpec;
    // 在 specs.json envelope 阶段也注入一个敏感字段（mock）
    const maliciousEnvelope = {
      schemaVersion: '1.0' as const,
      generatedAt: new Date().toISOString(),
      sourceModelVersion: '0.1.0',
      specs: [p1],
      tokenEnv: 'SECRET_TOKEN_XYZ', // 顶层敏感字段
      secret: 'SECRET_DATA',
    };
    const tmp = makeProject({
      subProtocols: [{ id: 'P1', name: '甲' }],
    });
    // 覆盖 specs.json 写入含敏感字段的 envelope
    mkdirSync(join(tmp, 'protocol/P1/derived'), { recursive: true });
    writeFileSync(
      join(tmp, 'protocol/P1/derived/specs.json'),
      JSON.stringify(maliciousEnvelope, null, 2),
      'utf-8'
    );
    const dataJsonPath = join(tmp, 'web/data.json');
    const result = await deriveProjectWeb({
      rootDir: tmp,
      dataJsonPath,
      buildProjectSite: false,
    });
    const dataRaw = readFileSync(dataJsonPath, 'utf-8');
    expect(dataRaw).not.toContain('SECRET_TOKEN_XYZ');
    expect(dataRaw).not.toContain('SECRET_DATA');
    expect(dataRaw).not.toContain('tokenEnv');
    expect(dataRaw).not.toContain('"secret"');
  });

  test('单协议项目（无 composition.md）即使传 --project 也抛错 → CLI 层避免误用', async () => {
    const tmp = mkdtempSync(join(tmpdir(), `webgen-comp-singleton-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`));
    mkdirSync(join(tmp, 'protocol'), { recursive: true });
    await expect(deriveProjectWeb({ rootDir: tmp, buildProjectSite: false })).rejects.toThrow(/composition\.md/);
  });

  test('组合层产物顶层结构完整（向后兼容单协议 schemaVersion/字段）', async () => {
    const p1 = mkIface('IF_SYS_T1', 'register', { schemaKind: 'structured' });
    const tmp = makeProject({
      subProtocols: [{ id: 'P1', name: '甲', specs: [p1] }],
    });
    const dataJsonPath = join(tmp, 'web/data.json');
    await deriveProjectWeb({ rootDir: tmp, dataJsonPath, buildProjectSite: false });
    const data = JSON.parse(readFileSync(dataJsonPath, 'utf-8'));
    // 组合层数据应有 protocols / dependencyGraph / crossRefs / invariantSpans
    expect(data.protocols).toBeDefined();
    expect(data.dependencyGraph).toBeDefined();
    expect(data.crossRefs).toBeDefined();
    expect(data.invariantSpans).toBeDefined();
    expect(data.composition).toBeDefined();
    expect(data.sharedMatrix).toBeDefined();
  });

  test('跨协议不变量 span 与 specs invariantIds 关联', async () => {
    const p1 = mkIface('IF_SYS_T1', 'register', {
      invariantIds: ['CI1'],
      schemaKind: 'structured',
    });
    const tmp = mkdtempSync(join(tmpdir(), `webgen-comp-inv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`));
    mkdirSync(join(tmp, 'protocol'), { recursive: true });
    const compositionMd = `# 系统元数据

\`\`\`yaml
systemName: TestSystem
version: 0.1.0
changeType: protocol_tweak
\`\`\`

# 子协议清单

\`\`\`yaml
  - protocolId: P1
    name: 甲
    version: 0.1.0
    modelPath: protocol/P1/model.md
  - protocolId: P2
    name: 乙
    version: 0.1.0
    modelPath: protocol/P2/model.md
\`\`\`

# 依赖图

\`\`\`yaml
  - from: P2
    to: P1
    dependencyType: state
    description: P1 写操作守卫依赖 P2 会话
\`\`\`

# 跨协议不变量

### CI1: P1 写操作会话守卫

\`\`\`yaml
id: CI1
name: P1写操作会话守卫
span: [P1, P2]
expression: P2.account = S1_active
declaredBy: system
checkMethod: 控制面守卫
complexity: simple_boolean
\`\`\`
`;
    writeFileSync(join(tmp, 'protocol/composition.md'), compositionMd, 'utf-8');
    mkdirSync(join(tmp, 'protocol/P1/derived'), { recursive: true });
    writeFileSync(
      join(tmp, 'protocol/P1/derived/specs.json'),
      JSON.stringify({ schemaVersion: '1.0', generatedAt: '', sourceModelVersion: '0.1.0', specs: [p1] }, null, 2),
      'utf-8'
    );
    mkdirSync(join(tmp, 'protocol/P2/derived'), { recursive: true });
    writeFileSync(
      join(tmp, 'protocol/P2/derived/specs.json'),
      JSON.stringify({ schemaVersion: '1.0', generatedAt: '', sourceModelVersion: '0.1.0', specs: [] }, null, 2),
      'utf-8'
    );
    const result = await deriveProjectWeb({ rootDir: tmp, buildProjectSite: false });
    expect(result.data.invariantSpans.length).toBe(1);
    expect(result.data.invariantSpans[0].id).toBe('CI1');
    expect(result.data.invariantSpans[0].linkedApis).toEqual([
      { protocol: 'P1', interfaceId: 'IF_SYS_T1' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// B1-E11（v0.3）：E11 错误响应表 + 绑定视图段在组合层接口详情页落表
// ---------------------------------------------------------------------------

describe('B1-E11：组合层接口详情页含 E11 错误响应表', () => {
  const protocol: SubProtocolSummary = {
    id: 'P1',
    name: '转发服务器管理',
    version: '0.1.0',
    modelPath: 'protocol/P1/model.md',
    interfaceCount: 1,
    systemInterfaceCount: 1,
    observationInterfaceCount: 0,
    specsAvailable: true,
    schemaSummary: 'structured',
  };

  function mkIfaceWithErrors(): InterfaceSpec {
    const errors: ErrorResponseDef[] = [
      { id: 'ERR-01', errorCode: 'invalid_request', httpStatus: 400, description: '参数不合法' },
      { id: 'ERR-02', errorCode: 'duplicate_server_id', httpStatus: 409, description: '节点 ID 重复' },
    ];
    return {
      ...mkIface('IF_SYS_T1', 'register', { schemaKind: 'structured' }),
      // sourceId 必须 = action 名（与 bindings.yaml 的 interfaces[].action 对齐）
      sourceId: 'register',
      errorResponses: errors,
    };
  }

  test('渲染含 errorResponses 时输出"错误响应 (errorResponses)"五列表', () => {
    const iface = mkIfaceWithErrors();
    const md = renderProjectInterfaceDetailPage(protocol, iface, []);
    // 段标题
    expect(md).toContain('## 错误响应 (errorResponses)');
    // 五列表头（与单协议 webgen 对齐）
    expect(md).toContain('| ID | 错误码 | HTTP Status | bodySchema | 说明 |');
    // 两条错误响应全部展示
    expect(md).toContain('ERR-01');
    expect(md).toContain('invalid_request');
    expect(md).toContain('400');
    expect(md).toContain('ERR-02');
    expect(md).toContain('duplicate_server_id');
    expect(md).toContain('409');
  });

  test('无 errorResponses 时不渲染"错误响应"段', () => {
    const iface = mkIface('IF_SYS_T1', 'register', { schemaKind: 'structured' });
    const md = renderProjectInterfaceDetailPage(protocol, iface, []);
    expect(md).not.toContain('## 错误响应 (errorResponses)');
  });

  test('bodySchema 已定义时显示 `已定义`，未定义时显示 —', () => {
    const iface: InterfaceSpec = {
      ...mkIface('IF_SYS_T1', 'register', { schemaKind: 'structured' }),
      errorResponses: [
        { id: 'ERR-A', errorCode: 'a_err', httpStatus: 400, bodySchema: { type: 'object' } as ErrorResponseDef['bodySchema'] },
        { id: 'ERR-B', errorCode: 'b_err', httpStatus: 403 },
      ],
    };
    const md = renderProjectInterfaceDetailPage(protocol, iface, []);
    expect(md).toContain('`已定义`');
    expect(md).toContain('—');
  });
});

describe('B1-E11：组合层接口详情"绑定视图"段', () => {
  const protocol: SubProtocolSummary = {
    id: 'P1',
    name: '转发服务器管理',
    version: '0.1.0',
    modelPath: 'protocol/P1/model.md',
    interfaceCount: 1,
    systemInterfaceCount: 1,
    observationInterfaceCount: 0,
    specsAvailable: true,
    schemaSummary: 'structured',
  };

  function mkBindingView(): WebBindingView {
    return {
      roles: [
        { roleId: 'R-Op', baseUrl: 'http://127.0.0.1:8787', authKind: 'bearer' },
      ],
      interfaces: [
        {
          action: 'register',
          roleId: 'R-Op',
          protocol: 'P1',
          transport: { type: 'http', method: 'POST', path: '/api/v1/servers' },
        },
        {
          action: 'bind',
          roleId: 'R-Op',
          protocol: 'P1',
          transport: { type: 'http', method: 'POST', path: '/api/v1/servers/{id}/bind' },
        },
      ],
      errorMap: {
        invalid_request: {
          httpStatus: 400,
          systemCode: 'INVALID_REQUEST',
          bodyField: 'code',
          bodyFieldValue: 'invalid_request',
          messageField: 'message',
        },
        duplicate_server_id: {
          httpStatus: 409,
          systemCode: 'DUPLICATE_SERVER_ID',
          bodyField: 'code',
          bodyFieldValue: 'duplicate_server_id',
          messageField: 'message',
        },
        unknown_error: {
          httpStatus: 500,
          systemCode: 'UNKNOWN',
          bodyField: 'code',
          bodyFieldValue: 'unknown_error',
          messageField: 'message',
        },
      },
      stateMap: { S0: 'inactive', S1: 'active' },
      unmappedErrorCodes: ['unknown_error'],
      warnings: ['errorMap 中的错误码 "unknown_error" 未在 specs.errorResponses / 异常路径声明（可能是残留）'],
      hasBindings: true,
    };
  }

  function mkIfaceWithErrors(): InterfaceSpec {
    return {
      ...mkIface('IF_SYS_T1', 'register', { schemaKind: 'structured' }),
      // sourceId 必须 = action 名（与 bindings.yaml 的 interfaces[].action 对齐）
      sourceId: 'register',
      errorResponses: [
        { id: 'ERR-01', errorCode: 'invalid_request', httpStatus: 400, description: '参数不合法' },
        { id: 'ERR-02', errorCode: 'duplicate_server_id', httpStatus: 409, description: '节点 ID 重复' },
      ],
    };
  }

  test('bindings 未提供时降级为"未读取到 bindings.yaml"提示', () => {
    const md = renderProjectInterfaceBindingSection(mkIfaceWithErrors(), undefined);
    expect(md).toContain('## 绑定视图（E11）');
    expect(md).toContain('未读取到 bindings.yaml');
    expect(md).toContain('redactSensitiveFields');
  });

  test('hasBindings=false 时也展示"未读取"提示', () => {
    const empty: WebBindingView = { roles: [], interfaces: [], warnings: [], hasBindings: false };
    const md = renderProjectInterfaceBindingSection(mkIfaceWithErrors(), empty);
    expect(md).toContain('未读取到 bindings.yaml');
  });

  test('bindings 提供时按接口 ID 过滤传输绑定行', () => {
    const bv = mkBindingView();
    const md = renderProjectInterfaceBindingSection(mkIfaceWithErrors(), bv);
    expect(md).toContain('### 传输绑定（命中本接口）');
    expect(md).toContain('register');
    expect(md).toContain('R-Op');
    expect(md).toContain('/api/v1/servers');
    // 不应展示其它接口（如 bind）
    expect(md.split('### 传输绑定')[1]!.split('###')[0]).not.toContain('| bind |');
  });

  test('errorMap 仅展示本接口声明的 errorCode 命中行', () => {
    const bv = mkBindingView();
    const md = renderProjectInterfaceBindingSection(mkIfaceWithErrors(), bv);
    expect(md).toContain('### 错误映射表 (errorMap) —— 本接口命中行');
    // 命中行
    expect(md).toContain('invalid_request');
    expect(md).toContain('400');
    expect(md).toContain('INVALID_REQUEST');
    expect(md).toContain('duplicate_server_id');
    expect(md).toContain('409');
    // 未在本接口声明的 errorMap 条目不出现（unknown_error 仅在 unmappedErrorCodes 出现一次）
    const errorMapSection = md.split('### 错误映射表')[1]!.split('###')[0]!;
    expect(errorMapSection).not.toContain('unknown_error');
    expect(errorMapSection).not.toContain('UNKNOWN');
  });

  test('stateMap 全局展示，标注为"项目级共享"', () => {
    const bv = mkBindingView();
    const md = renderProjectInterfaceBindingSection(mkIfaceWithErrors(), bv);
    expect(md).toContain('### 状态词表 (stateMap) —— 项目级共享');
    expect(md).toContain('S0');
    expect(md).toContain('inactive');
    expect(md).toContain('S1');
    expect(md).toContain('active');
  });

  test('缺绑错误码：本接口声明但 errorMap 未覆盖', () => {
    const ifaceMissing: InterfaceSpec = {
      ...mkIface('IF_SYS_T1', 'register', { schemaKind: 'structured' }),
      errorResponses: [
        { id: 'ERR-X', errorCode: 'totally_unmapped', httpStatus: 500 },
      ],
    };
    const bv = mkBindingView();
    const md = renderProjectInterfaceBindingSection(ifaceMissing, bv);
    expect(md).toContain('### 缺绑错误码（本接口相关）');
    expect(md).toContain('totally_unmapped');
  });

  test('本接口 errorResponses 全部命中 errorMap → 缺绑段显示"(无 — ...)"', () => {
    const bv = mkBindingView();
    const md = renderProjectInterfaceBindingSection(mkIfaceWithErrors(), bv);
    const sec = md.split('### 缺绑错误码（本接口相关）')[1]!.split('###')[0]!;
    expect(sec).toContain('本接口 errorResponses 全部命中 errorMap');
  });

  test('警告段展示 bindings.warnings 全量内容', () => {
    const bv = mkBindingView();
    const md = renderProjectInterfaceBindingSection(mkIfaceWithErrors(), bv);
    expect(md).toContain('### 警告');
    expect(md).toContain('errorMap 中的错误码 "unknown_error"');
  });

  test('安全边界段提示不读取敏感字段', () => {
    const bv = mkBindingView();
    const md = renderProjectInterfaceBindingSection(mkIfaceWithErrors(), bv);
    expect(md).toContain('### 安全边界');
    expect(md).toContain('redactSensitiveFields');
    expect(md).toContain('非敏感投影子集');
  });

  test('组合层接口详情页同时含错误响应表 + 绑定视图段', () => {
    const bv = mkBindingView();
    const md = renderProjectInterfaceDetailPage(protocol, mkIfaceWithErrors(), [], bv);
    // 错误响应表
    expect(md).toContain('## 错误响应 (errorResponses)');
    expect(md).toContain('invalid_request');
    // 绑定视图段
    expect(md).toContain('## 绑定视图（E11）');
    expect(md).toContain('### 传输绑定（命中本接口）');
    expect(md).toContain('### 错误映射表 (errorMap)');
    expect(md).toContain('### 状态词表 (stateMap)');
  });
});

describe('B1-E11：组合层 deriveProjectWeb 接入 bindings.yaml 读取（集成）', () => {
  test('bindings.yaml 存在时接口详情页含 binding 视图（红/蓝绿：避免环境耦合）', async () => {
    // 简化集成：仅校验 deriveProjectWeb 不抛错；并产出包含 binding 视图段的文件
    const iface = mkIface('IF_SYS_T1', 'register', {
      schemaKind: 'structured',
    });
    const tmp = makeProject({
      subProtocols: [{ id: 'P1', name: '甲', specs: [iface] }],
    });
    // 写一个最小 bindings.yaml（不注入敏感字段，断言不抛错即可）
    writeFileSync(
      join(tmp, 'bindings.yaml'),
      'roles:\n  R-Op:\n    roleId: R-Op\n    auth: bearer\ninterfaces: []\nerrorMap: {}\nstateMap: {}\n',
      'utf-8'
    );
    const dataJsonPath = join(tmp, 'web/data.json');
    const result = await deriveProjectWeb({
      rootDir: tmp,
      dataJsonPath,
      buildProjectSite: false,
    });
    expect(result.warnings.every((w) => !w.includes('bindings.yaml'))).toBe(true);
    // data.json 不携带 bindings 字段（B1 强调组合层轻量化）
    const dataRaw = readFileSync(dataJsonPath, 'utf-8');
    expect(dataRaw).not.toContain('"bindings"');
    // 但接口详情页含 binding 视图段
    const detailPath = join(tmp, 'web/docs/protocols/P1/IF_SYS_T1.md');
    expect(existsSync(detailPath)).toBe(true);
    const detail = readFileSync(detailPath, 'utf-8');
    expect(detail).toContain('## 绑定视图（E11）');
  });

  test('bindings.yaml 不存在时降级为"未读取到"提示（不抛错）', async () => {
    const iface = mkIface('IF_SYS_T1', 'register', { schemaKind: 'structured' });
    const tmp = makeProject({
      subProtocols: [{ id: 'P1', name: '甲', specs: [iface] }],
    });
    // 不写 bindings.yaml
    const dataJsonPath = join(tmp, 'web/data.json');
    await deriveProjectWeb({ rootDir: tmp, dataJsonPath, buildProjectSite: false });
    const detailPath = join(tmp, 'web/docs/protocols/P1/IF_SYS_T1.md');
    const detail = readFileSync(detailPath, 'utf-8');
    expect(detail).toContain('## 绑定视图（E11）');
    expect(detail).toContain('未读取到 bindings.yaml');
  });

  test('bindings.yaml 含敏感字段（tokenEnv/secret/password 等）→ 接口详情页产物无敏感值泄露', async () => {
    const iface = mkIface('IF_SYS_T1', 'register', { schemaKind: 'structured' });
    const tmp = makeProject({
      subProtocols: [{ id: 'P1', name: '甲', specs: [iface] }],
    });
    writeFileSync(
      join(tmp, 'bindings.yaml'),
      [
        'roles:',
        '  R-Op:',
        '    roleId: R-Op',
        '    auth: bearer',
        '    authConfig:',
        '      tokenEnv: SECRET_TOKEN_XYZ',
        '      secretEnv: SECRET_SECRET_XYZ',
        '      passwordEnv: SECRET_PASSWORD_XYZ',
        '    tls:',
        '      caFile: /etc/hskng-root-ca.pem',
        '      keyPath: /etc/hskng-server.key',
        '      certPath: /etc/hskng-server.crt',
        'interfaces:',
        '  - action: register',
        '    roleId: R-Op',
        '    protocol: P1',
        '    transport:',
        '      type: http',
        '      method: POST',
        '      path: /api/v1/servers',
        'errorMap: {}',
        'stateMap: {}',
        '',
      ].join('\n'),
      'utf-8'
    );
    const dataJsonPath = join(tmp, 'web/data.json');
    await deriveProjectWeb({ rootDir: tmp, dataJsonPath, buildProjectSite: false });
    const detailPath = join(tmp, 'web/docs/protocols/P1/IF_SYS_T1.md');
    const detail = readFileSync(detailPath, 'utf-8');
    // 敏感字段名 + 值都不出现
    expect(detail).not.toContain('SECRET_TOKEN_XYZ');
    expect(detail).not.toContain('SECRET_SECRET_XYZ');
    expect(detail).not.toContain('SECRET_PASSWORD_XYZ');
    expect(detail).not.toContain('hskng-root-ca.pem');
    expect(detail).not.toContain('hskng-server.key');
    expect(detail).not.toContain('hskng-server.crt');
    expect(detail).not.toContain('tokenEnv');
    expect(detail).not.toContain('secretEnv');
    expect(detail).not.toContain('passwordEnv');
    expect(detail).not.toContain('caFile');
    expect(detail).not.toContain('keyPath');
    expect(detail).not.toContain('certPath');
    // data.json 也不携带
    const dataRaw = readFileSync(dataJsonPath, 'utf-8');
    expect(dataRaw).not.toContain('SECRET_TOKEN_XYZ');
    expect(dataRaw).not.toContain('tokenEnv');
  });
});

// ---------------------------------------------------------------------------
// 清理
// ---------------------------------------------------------------------------

afterAll(() => {
  // 保留测试 tmpdir 便于复验（jest 默认 maxWorkers 不强制清理）
});
