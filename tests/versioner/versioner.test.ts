import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parseProtocolContent } from '../../src/parser/index.js';
import { diffModels } from '../../src/differ/index.js';
import {
  classifyChange,
  formatClassificationSummary,
  createConfirmationTracker,
  saveVersionSnapshot,
  listVersions,
  loadVersion,
  propagate,
  formatPropagateSummary,
} from '../../src/versioner/index.js';
import type { AIAdapter, AIPrompt, AIResponse, SourceProtocolModel } from '../../src/model/types.js';

const FIXTURES = join(process.cwd(), 'tests/fixtures');
function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf-8');
}

function makeTempDir(): string {
  const dir = join(tmpdir(), `protochain-versioner-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

class MockAIAdapter implements AIAdapter {
  name = 'mock';
  constructor(private equivalent: boolean, private succeed = true) {}
  async complete(prompt: AIPrompt): Promise<AIResponse> {
    return {
      content: JSON.stringify({ equivalent: this.equivalent, reason: 'mock 判断' }),
      success: this.succeed,
      attempts: 1,
    };
  }
}

function makeModel(content: string): SourceProtocolModel {
  return parseProtocolContent(content);
}

describe('versioner', () => {
  describe('变更分类', () => {
    test('使用方声明覆盖优先级最高', async () => {
      const oldModel = makeModel(`---
name: 测试
version: 1.0.0
purpose: 测试
roles:
  - id: r1
    name: 角色1
---

# 背景

测试

# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S1 | 初始 | initial |
| S2 | 终态 | terminal |

# 转移规则

| ID | 名称 | from | to | action |
|---|---|---|---|---|
| T1 | 完成 | S1 | S2 | finish |
`);
      const newModel = makeModel(`---
name: 测试
version: 1.1.0
purpose: 测试
roles:
  - id: r1
    name: 角色1
changeDeclarations:
  - targetId: INV1
    changeType: paradigm_renegotiation
    reason: 主动声明重协商
---

# 背景

测试

# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S1 | 初始 | initial |
| S2 | 终态 | terminal |

# 转移规则

| ID | 名称 | from | to | action |
|---|---|---|---|---|
| T1 | 完成 | S1 | S2 | finish |
`);
      const diff = (await diffModels(oldModel, newModel, undefined, {
        useAIForInvariantEquivalence: false,
      })).diff;
      const result = await classifyChange(diff, oldModel, newModel);
      expect(result.classification.changeType).toBe('paradigm_renegotiation');
      expect(result.classification.triggeredBy).toContain('metadata_declaration');
    });

    test('角色分工变更加范式重协商', async () => {
      const oldModel = makeModel(`---
name: 测试
version: 1.0.0
purpose: 测试
roles:
  - id: r1
    name: 角色1
---

# 背景

测试

# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S1 | 初始 | initial |
| S2 | 终态 | terminal |

# 转移规则

| ID | 名称 | from | to | action | trigger |
|---|---|---|---|---|---|
| T1 | 完成 | S1 | S2 | finish | r1 |
`);
      const newModel = makeModel(`---
name: 测试
version: 1.0.0
purpose: 测试
roles:
  - id: r1
    name: 角色1
  - id: r2
    name: 角色2
---

# 背景

测试

# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S1 | 初始 | initial |
| S2 | 终态 | terminal |

# 转移规则

| ID | 名称 | from | to | action | trigger |
|---|---|---|---|---|---|
| T1 | 完成 | S1 | S2 | finish | r2 |
`);
      const diff = (await diffModels(oldModel, newModel)).diff;
      const result = await classifyChange(diff, oldModel, newModel);
      expect(result.classification.changeType).toBe('paradigm_renegotiation');
      expect(result.classification.triggeredBy).toContain('role_change');
    });

    test('删除终态归类为范式重协商', async () => {
      const oldModel = makeModel(`---
name: 测试
version: 1.0.0
purpose: 测试
roles:
  - id: r1
    name: 角色1
---

# 背景

测试

# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S1 | 初始 | initial |
| S2 | 终态A | terminal |
| S3 | 终态B | terminal |

# 转移规则

| ID | 名称 | from | to | action |
|---|---|---|---|---|
| T1 | 走A | S1 | S2 | goA |
| T2 | 走B | S1 | S3 | goB |
`);
      const newModel = makeModel(`---
name: 测试
version: 1.0.0
purpose: 测试
roles:
  - id: r1
    name: 角色1
---

# 背景

测试

# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S1 | 初始 | initial |
| S2 | 终态A | terminal |

# 转移规则

| ID | 名称 | from | to | action |
|---|---|---|---|---|
| T1 | 走A | S1 | S2 | goA |
`);
      const diff = (await diffModels(oldModel, newModel)).diff;
      const result = await classifyChange(diff, oldModel, newModel);
      expect(result.classification.changeType).toBe('paradigm_renegotiation');
      expect(result.classification.triggeredBy).toContain('structural_change');
    });

    test('无重大变更时归类为协议微调', async () => {
      const oldModel = makeModel(`---
name: 测试
version: 1.0.0
purpose: 测试
roles:
  - id: r1
    name: 角色1
---

# 背景

测试

# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S1 | 初始 | initial |
| S2 | 终态 | terminal |

# 转移规则

| ID | 名称 | from | to | action |
|---|---|---|---|---|
| T1 | 完成 | S1 | S2 | finish |
`);
      const newModel = makeModel(`---
name: 测试
version: 1.0.0
purpose: 测试
roles:
  - id: r1
    name: 角色1
---

# 背景

测试

# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S1 | 起始 | initial |
| S2 | 终态 | terminal |

# 转移规则

| ID | 名称 | from | to | action |
|---|---|---|---|---|
| T1 | 完成 | S1 | S2 | finish |
`);
      const diff = (await diffModels(oldModel, newModel)).diff;
      const result = await classifyChange(diff, oldModel, newModel);
      expect(result.classification.changeType).toBe('protocol_tweak');
    });

    test('AI 判断不变量语义变更归类为重协商', async () => {
      const oldModel = makeModel(`---
name: 测试
version: 1.0.0
purpose: 测试
roles:
  - id: r1
    name: 角色1
---

# 背景

测试

# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S1 | 初始 | initial |
| S2 | 终态 | terminal |

# 转移规则

| ID | 名称 | from | to | action |
|---|---|---|---|---|
| T1 | 完成 | S1 | S2 | finish |

# 不变量

| ID | 名称 | 表达式 |
|---|---|---|
| INV1 | 不变量1 | forall x: x > 0 |
`);
      const newModel = makeModel(`---
name: 测试
version: 1.0.0
purpose: 测试
roles:
  - id: r1
    name: 角色1
---

# 背景

测试

# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S1 | 初始 | initial |
| S2 | 终态 | terminal |

# 转移规则

| ID | 名称 | from | to | action |
|---|---|---|---|---|
| T1 | 完成 | S1 | S2 | finish |

# 不变量

| ID | 名称 | 表达式 |
|---|---|---|
| INV1 | 不变量1 | forall x: x > 1 |
`);
      const aiAdapter = new MockAIAdapter(false); // 不等价 = 语义变更
      const diff = (await diffModels(oldModel, newModel, aiAdapter)).diff;
      const result = await classifyChange(diff, oldModel, newModel, aiAdapter);
      expect(result.classification.changeType).toBe('paradigm_renegotiation');
      expect(result.classification.triggeredBy).toContain('invariant_semantic_change');
      // 含待确认项
      expect(result.pendingConfirmations.some((p) => p.type === 'invariant_declaration')).toBe(true);
    });

    test('AI 判断不变量语义等价归类为微调', async () => {
      const oldModel = makeModel(`---
name: 测试
version: 1.0.0
purpose: 测试
roles:
  - id: r1
    name: 角色1
---

# 背景

测试

# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S1 | 初始 | initial |
| S2 | 终态 | terminal |

# 转移规则

| ID | 名称 | from | to | action |
|---|---|---|---|---|
| T1 | 完成 | S1 | S2 | finish |

# 不变量

| ID | 名称 | 表达式 |
|---|---|---|
| INV1 | 不变量1 | not exists p: p > 1 |
`);
      const newModel = makeModel(`---
name: 测试
version: 1.0.0
purpose: 测试
roles:
  - id: r1
    name: 角色1
---

# 背景

测试

# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S1 | 初始 | initial |
| S2 | 终态 | terminal |

# 转移规则

| ID | 名称 | from | to | action |
|---|---|---|---|---|
| T1 | 完成 | S1 | S2 | finish |

# 不变量

| ID | 名称 | 表达式 |
|---|---|---|
| INV1 | 不变量1 | forall p: p <= 1 |
`);
      const aiAdapter = new MockAIAdapter(true); // 等价 = 仅表达形式变更
      const diff = (await diffModels(oldModel, newModel, aiAdapter)).diff;
      const result = await classifyChange(diff, oldModel, newModel, aiAdapter);
      expect(result.classification.changeType).toBe('protocol_tweak');
    });

    test('无 AI 时不变量变更保守处理为重协商', async () => {
      const oldModel = makeModel(`---
name: 测试
version: 1.0.0
purpose: 测试
roles:
  - id: r1
    name: 角色1
---

# 背景

测试

# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S1 | 初始 | initial |
| S2 | 终态 | terminal |

# 转移规则

| ID | 名称 | from | to | action |
|---|---|---|---|---|
| T1 | 完成 | S1 | S2 | finish |

# 不变量

| ID | 名称 | 表达式 |
|---|---|---|
| INV1 | 不变量1 | forall x: x > 0 |
`);
      const newModel = makeModel(`---
name: 测试
version: 1.0.0
purpose: 测试
roles:
  - id: r1
    name: 角色1
---

# 背景

测试

# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S1 | 初始 | initial |
| S2 | 终态 | terminal |

# 转移规则

| ID | 名称 | from | to | action |
|---|---|---|---|---|
| T1 | 完成 | S1 | S2 | finish |

# 不变量

| ID | 名称 | 表达式 |
|---|---|---|
| INV1 | 不变量1 | forall x: x > 1 |
`);
      const diff = (await diffModels(oldModel, newModel, undefined, {
        useAIForInvariantEquivalence: false,
      })).diff;
      const result = await classifyChange(diff, oldModel, newModel, undefined, {
        useAIForInvariantClassification: false,
      });
      expect(result.classification.changeType).toBe('paradigm_renegotiation');
    });
  });

  describe('ConfirmationTracker', () => {
    test('添加待确认项', () => {
      const tracker = createConfirmationTracker();
      tracker.addPending({ type: 'invariant_declaration', invariantId: 'INV1' });
      const pending = tracker.getPending();
      expect(pending.length).toBe(1);
      expect(pending[0].item).toEqual({ type: 'invariant_declaration', invariantId: 'INV1' });
      expect(pending[0].status).toBe('pending');
    });

    test('去重：相同 itemId 不重复添加', () => {
      const tracker = createConfirmationTracker();
      tracker.addPending({ type: 'invariant_declaration', invariantId: 'INV1' });
      tracker.addPending({ type: 'invariant_declaration', invariantId: 'INV1' });
      expect(tracker.getPending().length).toBe(1);
    });

    test('确认待确认项', () => {
      const tracker = createConfirmationTracker();
      tracker.addPending({ type: 'invariant_declaration', invariantId: 'INV1' });
      tracker.confirm('inv:INV1', 'user1', '已确认');
      expect(tracker.getPending().length).toBe(0);
    });

    test('拒绝待确认项', () => {
      const tracker = createConfirmationTracker();
      tracker.addPending({ type: 'paradigm_renegotiation', versionRange: ['1.0.0', '2.0.0'] });
      tracker.reject('paradigm:1.0.0->2.0.0', '拒绝原因');
      expect(tracker.getPending().length).toBe(0);
    });

    test('支持四类 ConfirmableItem', () => {
      const tracker = createConfirmationTracker();
      tracker.addPending({ type: 'invariant_declaration', invariantId: 'INV1' });
      tracker.addPending({ type: 'paradigm_renegotiation', versionRange: ['1.0.0', '2.0.0'] });
      tracker.addPending({ type: 'self_constructed_scenario', scenarioId: 'SC1' });
      tracker.addPending({ type: 'utility_validation', version: '1.0.0' });
      expect(tracker.getPending().length).toBe(4);
    });
  });

  describe('版本快照', () => {
    test('保存版本快照', async () => {
      const rootDir = makeTempDir();
      try {
        // 将 fixture 复制到 rootDir/protocol/model.md，使 saveVersionSnapshot 能读取 sourcePath
        mkdirSync(join(rootDir, 'protocol'), { recursive: true });
        const fixtureContent = readFixture('approval-flow.md');
        writeFileSync(join(rootDir, 'protocol/model.md'), fixtureContent, 'utf-8');
        const { parseProtocolFile } = await import('../../src/parser/index.js');
        const model = parseProtocolFile(join(rootDir, 'protocol/model.md'));
        const path = saveVersionSnapshot(model, rootDir);
        expect(path.replace(/\\/g, '/')).toContain('protocol/versions/v1.0.0.md');
        // 版本索引存在
        const versions = listVersions(rootDir);
        expect(versions.length).toBe(1);
        expect(versions[0].version).toBe('1.0.0');
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    });

    test('重复保存相同版本需 force', async () => {
      const rootDir = makeTempDir();
      try {
        mkdirSync(join(rootDir, 'protocol'), { recursive: true });
        const fixtureContent = readFixture('approval-flow.md');
        writeFileSync(join(rootDir, 'protocol/model.md'), fixtureContent, 'utf-8');
        const { parseProtocolFile } = await import('../../src/parser/index.js');
        const model = parseProtocolFile(join(rootDir, 'protocol/model.md'));
        saveVersionSnapshot(model, rootDir);
        expect(() => saveVersionSnapshot(model, rootDir)).toThrow();
        // force=true 可覆盖
        expect(() => saveVersionSnapshot(model, rootDir, { force: true })).not.toThrow();
        const versions = listVersions(rootDir);
        expect(versions.length).toBe(1);
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    });

    test('加载版本快照', async () => {
      const rootDir = makeTempDir();
      try {
        mkdirSync(join(rootDir, 'protocol'), { recursive: true });
        const fixtureContent = readFixture('approval-flow.md');
        writeFileSync(join(rootDir, 'protocol/model.md'), fixtureContent, 'utf-8');
        const { parseProtocolFile } = await import('../../src/parser/index.js');
        const model = parseProtocolFile(join(rootDir, 'protocol/model.md'));
        saveVersionSnapshot(model, rootDir);
        const loaded = loadVersion(rootDir, '1.0.0');
        expect(loaded).toBeDefined();
        expect(loaded!.metadata.name).toBe('审批流协议');
        expect(loaded!.metadata.version).toBe('1.0.0');
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    });

    test('加载不存在的版本返回 undefined', () => {
      const rootDir = makeTempDir();
      try {
        const loaded = loadVersion(rootDir, '999.0.0');
        expect(loaded).toBeUndefined();
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    });

    test('列表无版本时返回空数组', () => {
      const rootDir = makeTempDir();
      try {
        const versions = listVersions(rootDir);
        expect(versions).toEqual([]);
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    });
  });

  describe('变更传播', () => {
    test('生成清理计划', async () => {
      const rootDir = makeTempDir();
      try {
        // 创建 stale 产物
        mkdirSync(join(rootDir, 'derived'), { recursive: true });
        writeFileSync(join(rootDir, 'derived/specs.json'), '{}', 'utf-8');
        writeFileSync(join(rootDir, 'derived/contracts.json'), '{}', 'utf-8');

        const oldModel = makeModel(`---
name: 测试
version: 1.0.0
purpose: 测试
roles:
  - id: r1
    name: 角色1
---

# 背景

测试

# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S1 | 初始 | initial |
| S2 | 终态 | terminal |

# 转移规则

| ID | 名称 | from | to | action |
|---|---|---|---|---|
| T1 | 完成 | S1 | S2 | finish |
`);
        const newModel = makeModel(`---
name: 测试
version: 1.0.0
purpose: 测试
roles:
  - id: r1
    name: 角色1
---

# 背景

测试

# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S1 | 初始 | initial |
| S2 | 完成 | terminal |

# 转移规则

| ID | 名称 | from | to | action |
|---|---|---|---|---|
| T1 | 完成 | S1 | S2 | finish |
`);
        const diffResult = await diffModels(oldModel, newModel);
        const result = propagate(diffResult.impact, rootDir);
        expect(result.staleArtifacts).toContain('derived/specs.json');
        expect(result.staleArtifacts).toContain('derived/contracts.json');
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    });

    test('增量重推导路径与影响分析一致', async () => {
      const rootDir = makeTempDir();
      try {
        const oldModel = makeModel(`---
name: 测试
version: 1.0.0
purpose: 测试
roles:
  - id: r1
    name: 角色1
---

# 背景

测试

# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S1 | 初始 | initial |
| S2 | 终态 | terminal |

# 转移规则

| ID | 名称 | from | to | action |
|---|---|---|---|---|
| T1 | 完成 | S1 | S2 | finish |
`);
        const newModel = makeModel(`---
name: 测试
version: 1.0.0
purpose: 测试
roles:
  - id: r1
    name: 角色1
---

# 背景

测试

# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S1 | 初始 | initial |
| S2 | 完成 | terminal |

# 转移规则

| ID | 名称 | from | to | action |
|---|---|---|---|---|
| T1 | 完成 | S1 | S2 | finish |
`);
        const diffResult = await diffModels(oldModel, newModel);
        const result = propagate(diffResult.impact, rootDir);
        expect(result.incrementalPlan).toEqual(diffResult.impact.incrementalPlan);
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    });
  });

  describe('报告摘要', () => {
    test('分类摘要包含变更类型与触发原因', async () => {
      const oldModel = makeModel(`---
name: 测试
version: 1.0.0
purpose: 测试
roles:
  - id: r1
    name: 角色1
---

# 背景

测试

# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S1 | 初始 | initial |
| S2 | 终态 | terminal |

# 转移规则

| ID | 名称 | from | to | action |
|---|---|---|---|---|
| T1 | 完成 | S1 | S2 | finish |
`);
      const newModel = makeModel(`---
name: 测试
version: 1.0.0
purpose: 测试
roles:
  - id: r1
    name: 角色1
  - id: r2
    name: 角色2
---

# 背景

测试

# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S1 | 初始 | initial |
| S2 | 终态 | terminal |

# 转移规则

| ID | 名称 | from | to | action |
|---|---|---|---|---|
| T1 | 完成 | S1 | S2 | finish |
`);
      const diff = (await diffModels(oldModel, newModel)).diff;
      const result = await classifyChange(diff, oldModel, newModel);
      const summary = formatClassificationSummary(result);
      expect(summary).toContain('变更分类');
      expect(summary).toContain('触发原因');
      expect(summary).toContain('触发规则');
    });

    test('传播摘要包含受影响步骤与清理计划', async () => {
      const rootDir = makeTempDir();
      try {
        mkdirSync(join(rootDir, 'derived'), { recursive: true });
        writeFileSync(join(rootDir, 'derived/specs.json'), '{}', 'utf-8');

        const oldModel = makeModel(`---
name: 测试
version: 1.0.0
purpose: 测试
roles:
  - id: r1
    name: 角色1
---

# 背景

测试

# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S1 | 初始 | initial |
| S2 | 终态 | terminal |

# 转移规则

| ID | 名称 | from | to | action |
|---|---|---|---|---|
| T1 | 完成 | S1 | S2 | finish |
`);
        const newModel = makeModel(`---
name: 测试
version: 1.0.0
purpose: 测试
roles:
  - id: r1
    name: 角色1
---

# 背景

测试

# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S1 | 初始 | initial |
| S2 | 完成 | terminal |

# 转移规则

| ID | 名称 | from | to | action |
|---|---|---|---|---|
| T1 | 完成 | S1 | S2 | finish |
`);
        const diffResult = await diffModels(oldModel, newModel);
        const result = propagate(diffResult.impact, rootDir);
        const summary = formatPropagateSummary(result);
        expect(summary).toContain('变更传播分析');
        expect(summary).toContain('受影响步骤');
        expect(summary).toContain('需清理的旧产物');
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    });
  });
});
