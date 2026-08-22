/**
 * 修改单 003 回归测试：casegen / cross-casegen 按状态机分解拆分主/附属子状态机独立生成路径
 *
 * 背景（修改单 003）：
 * - protochain generate-cases 路径生成只以 deriable.initialStateId 单点 BFS，
 *   多实体协议（P7 US×PS×PI、P1 Mapping+TempMapping SE1）的附属实体子状态机从主初始态
 *   物理上不可达，AI 5 轮仍生成非法路径（"转移 T8 与当前状态 US1 不匹配"）。
 * - 修复：调用 decomposeStateMachines 拆分主/附属子状态机，每台独立生成覆盖路径
 *   （主状态机预算 ~70%，附属子状态机均分剩余预算）；交叉生成 AI 提示词注入子状态机入口；
 *   cross-casegen 按 collectReachableTransferIds 把附属子状态机从各自入口 BFS 可达的转移纳入。
 *
 * 验证：
 * 1. 单状态机模型（hsk-ng 风格）行为不变——主状态机唯一，subMachines 为空。
 * 2. 多状态机模型（P7 风格）下，主 + 各附属子状态机的状态/转移全部独立覆盖。
 * 3. AI 路径生成（materializePaths）允许首条转移 from 匹配子状态机入口作为合法起点。
 * 4. cross-casegen 跨协议路径片段包含附属子状态机 BFS 可达的转移（不是空数组）。
 * 5. 覆盖度报告含 submachineCoverage（advisory）。
 */

import type {
  DerivableLayer,
  StateDef,
  TransitionDef,
  InvariantDef,
  SourceProtocolModel,
  CompositionModel,
  DependencyEdge,
  CrossInvariantDef,
} from '../../src/model/types.js';
import { generateCases } from '../../src/casegen/index.js';
import { generateCrossCases } from '../../src/cross-casegen/index.js';

// ============================================================================
// 测试夹具构造器
// ============================================================================

/**
 * 构造等价 P7 的多实体模型：主 US 状态机 + PS 行生命周期 + PI 配件维度。
 * 主状态机初始态 US1，子状态机分别从 PS2/PI1 创建转移目标进入。
 */
function makeP7LikeModel(): SourceProtocolModel {
  const states: StateDef[] = [
    // 主 US 状态机
    { id: 'US1', name: '正常', type: 'initial' },
    { id: 'US2', name: '冻结', type: 'normal' },
    { id: 'US3', name: '注销中', type: 'normal' },
    { id: 'US4', name: '已注销', type: 'terminal' },
    // PS 子状态机
    { id: 'PS2', name: '正常', type: 'normal' },
    { id: 'PS3', name: '到期', type: 'normal' },
    { id: 'PS4', name: '封禁', type: 'normal' },
    { id: 'PS5', name: '停用', type: 'terminal' },
    // PI 子状态机
    { id: 'PI1', name: '已配', type: 'normal' },
    { id: 'PI2', name: '解配', type: 'normal' },
    { id: 'PI3', name: '故障', type: 'normal' },
    { id: 'PI4', name: '退役', type: 'terminal' },
  ];

  const transitions: TransitionDef[] = [
    // 主 US 转移
    { id: 'T1', name: 'US冻结', from: ['US1'], to: 'US2', action: 'freeze' },
    { id: 'T2', name: 'US解冻', from: ['US2'], to: 'US1', action: 'unfreeze' },
    { id: 'T3', name: 'US注销', from: ['US1'], to: 'US3', action: 'deactivate' },
    { id: 'T4', name: 'US注销完成', from: ['US3'], to: 'US4', action: 'deactivate_done' },
    // PS 维度（附属实体创建转移：from='-'/空，归属 PS 子状态机）
    { id: 'PS_T1', name: 'PS创建', from: ['-'], to: 'PS2', action: 'create' },
    { id: 'PS_T2', name: 'PS到期', from: ['PS2'], to: 'PS3', action: 'expire' },
    { id: 'PS_T3', name: 'PS封禁', from: ['PS2'], to: 'PS4', action: 'ban' },
    { id: 'PS_T4', name: 'PS停用', from: ['PS3', 'PS4'], to: 'PS5', action: 'deactivate' },
    // PI 维度
    { id: 'PI_T1', name: 'PI创建', from: ['-'], to: 'PI1', action: 'create' },
    { id: 'PI_T2', name: 'PI解配', from: ['PI1'], to: 'PI2', action: 'unbind' },
    { id: 'PI_T3', name: 'PI故障', from: ['PI1'], to: 'PI3', action: 'fault' },
    { id: 'PI_T4', name: 'PI退役', from: ['PI2', 'PI3'], to: 'PI4', action: 'retire' },
  ];

  const invariants: InvariantDef[] = [
    {
      id: 'INV-PS1',
      name: 'PS 终态不活跃',
      expression: 'PS5 implies US4',
    },
  ];

  const derivable: DerivableLayer = {
    states,
    transitions,
    invariants,
    timing: [],
    exceptions: [],
    degraded: false,
    initialStateId: 'US1',
    terminalStateIds: ['US4', 'PS5', 'PI4'],
  };

  return {
    metadata: { name: 'P7-like 多实体模型', version: '1.0.0', purpose: '多子状态机测试' },
    readable: { background: '等价 P7 协议，含 US 主状态机 + PS/PI 附属子状态机' },
    derivable,
    roleAnchors: [],
    subsidiaries: [],
  };
}

/** 构造单状态机模型（hsk-ng P1 风格）——用于回归"行为不变" */
function makeSingleMachineModel(): SourceProtocolModel {
  const states: StateDef[] = [
    { id: 'S1', name: '草稿', type: 'initial' },
    { id: 'S2', name: '运行', type: 'normal' },
    { id: 'S3', name: '停止', type: 'terminal' },
  ];
  const transitions: TransitionDef[] = [
    { id: 'T1', name: '启动', from: ['S1'], to: 'S2', action: 'start' },
    { id: 'T2', name: '接收流量', from: ['S2'], to: 'S2', action: 'receive' },
    { id: 'T3', name: '停止', from: ['S2'], to: 'S3', action: 'stop' },
  ];
  return {
    metadata: { name: '单状态机', version: '1.0.0', purpose: '回归测试' },
    readable: { background: '简单单状态机' },
    derivable: {
      states,
      transitions,
      invariants: [],
      timing: [],
      exceptions: [],
      degraded: false,
      initialStateId: 'S1',
      terminalStateIds: ['S3'],
    },
    roleAnchors: [],
    subsidiaries: [],
  };
}

// ============================================================================
// 测试
// ============================================================================

describe('修改单 003：casegen 按状态机分解拆分主/附属子状态机独立生成路径', () => {
  describe('单状态机模型行为不变（hsk-ng 回归）', () => {
    const model = makeSingleMachineModel();
    const cases = generateCases(model, { criterion: 'state' });

    test('主状态机唯一，附属子状态机为空', () => {
      expect((cases as unknown as { submachineCoverage?: unknown }).submachineCoverage).toBeFalsy();
    });

    test('状态覆盖 100%', () => {
      expect(cases.coverage.stateCoverage.ratio).toBe(1);
      expect(cases.coverage.stateCoverage.uncoveredIds).toEqual([]);
    });

    test('转移覆盖 100%（含 S2→S2 自环）', () => {
      expect(cases.coverage.transitionCoverage.ratio).toBe(1);
    });

    test('路径从 S1 出发', () => {
      expect(cases.paths.length).toBeGreaterThan(0);
      for (const p of cases.paths) {
        expect(p.stateIds[0]).toBe('S1');
      }
    });
  });

  describe('多状态机模型：主 + 附属子状态机独立覆盖', () => {
    const model = makeP7LikeModel();
    const cases = generateCases(model, { criterion: 'state', maxPaths: 30 });

    test('附属实体子状态机被独立覆盖（不再视为"不可达"）', () => {
      // PS 维度：所有 4 个状态至少有一条路径访问
      const coveredStates = new Set<string>();
      for (const p of cases.paths) {
        for (const s of p.stateIds) coveredStates.add(s);
      }
      expect(coveredStates.has('PS2')).toBe(true);
      expect(coveredStates.has('PS3')).toBe(true);
      expect(coveredStates.has('PS4')).toBe(true);
      expect(coveredStates.has('PS5')).toBe(true);
      // PI 维度
      expect(coveredStates.has('PI1')).toBe(true);
      expect(coveredStates.has('PI2')).toBe(true);
      expect(coveredStates.has('PI3')).toBe(true);
      expect(coveredStates.has('PI4')).toBe(true);
    });

    test('主状态机状态也都被覆盖', () => {
      const coveredStates = new Set<string>();
      for (const p of cases.paths) {
        for (const s of p.stateIds) coveredStates.add(s);
      }
      expect(coveredStates.has('US1')).toBe(true);
      expect(coveredStates.has('US2')).toBe(true);
      expect(coveredStates.has('US3')).toBe(true);
      expect(coveredStates.has('US4')).toBe(true);
    });

    test('附属实体子状态机转移被独立覆盖（创建转移 PS_T1/PI_T1 等）', () => {
      // 子状态机转移通过 submachineCoverage 报告（advisory）独立判定，
      // 创建转移语义上由 entry 被覆盖即代表"创建路径可达"——见 computeSubmachineCoverage。
      const submachine = (cases as unknown as {
        submachineCoverage?: Array<{ transitionCoverage: { coveredIds: string[]; ratio: number } }>;
      }).submachineCoverage;
      expect(submachine).toBeDefined();
      const psCov = submachine!.find((s) => s.transitionCoverage.coveredIds.includes('PS_T1') || s.transitionCoverage.coveredIds.includes('PS_T2'));
      const piCov = submachine!.find((s) => s.transitionCoverage.coveredIds.includes('PI_T1') || s.transitionCoverage.coveredIds.includes('PI_T2'));
      expect(psCov).toBeDefined();
      expect(piCov).toBeDefined();
      // 创建转移 PS_T1/PI_T1 由 entry 覆盖计入
      expect(psCov!.transitionCoverage.coveredIds).toContain('PS_T1');
      expect(piCov!.transitionCoverage.coveredIds).toContain('PI_T1');
      // 非创建转移 PS_T2/PI_T2 必须真的被某条路径执行
      expect(psCov!.transitionCoverage.coveredIds).toContain('PS_T2');
      expect(piCov!.transitionCoverage.coveredIds).toContain('PI_T2');
    });

    test('覆盖度报告含 submachineCoverage（advisory）', () => {
      const submachine = (cases as unknown as {
        submachineCoverage?: Array<{ stateCoverage: { ratio: number }; transitionCoverage: { ratio: number } }>;
      }).submachineCoverage;
      expect(submachine).toBeDefined();
      expect(submachine!.length).toBe(2); // PS + PI
      for (const sm of submachine!) {
        // 每台子状态机应能完整覆盖自身（无外部依赖）
        expect(sm.stateCoverage.ratio).toBe(1);
        expect(sm.transitionCoverage.ratio).toBe(1);
      }
    });

    test('主状态机覆盖度：state / transition 全 100%（不破 d-derive 闸门）', () => {
      expect(cases.coverage.stateCoverage.ratio).toBe(1);
      expect(cases.coverage.transitionCoverage.ratio).toBe(1);
    });
  });

  describe('路径 ID 区分（主/子状态机）', () => {
    const model = makeP7LikeModel();
    const cases = generateCases(model, { criterion: 'state', maxPaths: 30 });

    test('主状态机路径 ID 含 _main 后缀', () => {
      const mainPaths = cases.paths.filter((p) => p.id.includes('_main'));
      expect(mainPaths.length).toBeGreaterThan(0);
    });

    test('附属子状态机路径 ID 含 _sub_<idx> 后缀', () => {
      const subPaths = cases.paths.filter((p) => p.id.includes('_sub_'));
      expect(subPaths.length).toBeGreaterThan(0);
    });
  });

  describe('cross-casegen：跨协议路径片段覆盖主 + 附属子状态机的转移', () => {
    const model = makeP7LikeModel();

    // 直接构造 CompositionModel（避免依赖 composition.md 解析器结构）
    const edges: DependencyEdge[] = [
      {
        from: 'P7',
        to: 'P8',
        dependencyType: 'state',
        description: 'P7 状态变更通知 P8',
      },
    ];
    const crossInvariants: CrossInvariantDef[] = [
      {
        id: 'CI1',
        name: '注销通知',
        span: ['P7', 'P8'],
        expression: 'not exists(p7.deactivated without p8.notified)',
        declaredBy: 'platform',
        checkMethod: '事件溯源',
        complexity: 'first_order',
      },
    ];
    // modelById 使用 metadata.name 索引，但我们的测试 model 是手工构造的，metadata.name 是 'P7-like 多实体模型'。
    // 这里把 model.metadata.name 设为 'P7' 让 generateCrossCases 能找到。
    const modelForCross = { ...model, metadata: { ...model.metadata, name: 'P7' } };

    const composition: CompositionModel = {
      metadata: { systemName: 'test', version: '1.0.0', changeType: 'protocol_tweak' },
      dependencyGraph: { mermaid: 'graph LR\n  P7 --> P8', edges },
      crossInvariants,
      crossTiming: [],
      externalDependencies: [],
      observationInterfaces: [],
      objectStateFacets: [],
      securityAssumptions: [],
      subProtocols: [
        { protocolId: 'P7', name: '多实体协议', version: '1.0.0', modelPath: 'protocol/P7/model.md' },
        { protocolId: 'P8', name: '下游协议', version: '1.0.0', modelPath: 'protocol/P8/model.md' },
      ],
    };

    const cases = generateCrossCases(composition, [modelForCross]);

    test('跨协议路径 P7 片段包含 PS/PI 维度的转移（不再只剩 US 维度）', () => {
      expect(cases.paths.length).toBeGreaterThan(0);
      const p7Segment = cases.paths[0].segments.find((s) => s.protocolId === 'P7');
      expect(p7Segment).toBeDefined();
      const tids = p7Segment!.transitionIds;
      // state 依赖类型：所有 transition 都纳入（既有行为），US + PS + PI 都应有
      expect(tids.length).toBeGreaterThan(0);
      // 修复前：只含 US 维度（T1/T2/T3/T4），PS/PI 全部丢失
      // 修复后：decomposeStateMachines + collectReachableTransferIds 把附属子状态机 BFS 可达的也纳入
      expect(tids).toContain('T1'); // US 主状态机
      expect(tids).toContain('PS_T2'); // PS 子状态机转移
      expect(tids).toContain('PI_T2'); // PI 子状态机转移
    });

    test('跨协议路径含 crossInvariantCheckpoints', () => {
      for (const p of cases.paths) {
        expect(p.crossInvariantCheckpoints).toContain('CI1');
      }
    });
  });

  describe('退化模式：仅单状态机时 submachineCoverage 为 null/undefined', () => {
    const model = makeSingleMachineModel();
    const cases = generateCases(model);

    test('单状态机模型不含 submachineCoverage', () => {
      const submachine = (cases as unknown as { submachineCoverage?: unknown }).submachineCoverage;
      expect(submachine == null).toBe(true);
    });
  });
});
