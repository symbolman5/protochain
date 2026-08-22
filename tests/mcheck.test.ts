/**
 * m-check 测试
 *
 * 覆盖：IMPLEMENTATION-ACCEPTANCE.md §E1 通过标准
 * - 坏模型 A/B 退出码非 0，报告逐条列出违规 ID
 * - 正常模型退出码 0，无违规
 *
 * 同时覆盖：
 * - M001 命名规范（含 `-` 的 ID）
 * - M002 跨协议 ID 唯一性
 * - M003 附属实体归属（belongsTo 指向不存在 state）
 * - M004 旧字符（invariant.expression 含 `-`）
 * - M005 ID 转义（TLA+ 关键字撞名）
 */

import {
  runMCheck,
  type MCheckReport,
} from '../src/mcheck/index.js';
import { parseProtocolContent } from '../src/parser/index.js';
import type { SourceProtocolModel } from '../src/model/types.js';

// ============================================================================
// 辅助：构造最小可用 model（合法 markdown + 必要 front matter）
// ============================================================================

function makeValidModel(opts: {
  name?: string;
  invariants?: Array<{ id: string; expression?: string; name?: string; scopeStateIds?: string[]; declaredBy?: string; invariantClass?: string }>;
  transitions?: Array<{ id: string; from: string[]; to: string; action: string; trigger?: string; name?: string; guard?: string }>;
  states?: Array<{ id: string; name: string; type?: string }>;
  subsidiaryEntities?: Array<{ id: string; name: string; belongsTo: string; instanceKey?: string; lifecycleDependency?: string; cascadeRules?: string[]; stateSpace?: { dimensions: unknown[] }; invariants?: string[] }>;
} = {}): SourceProtocolModel {
  const name = opts.name ?? '测试协议';
  const states = opts.states ?? [
    { id: 'S1', name: '初始', type: 'initial' as const },
    { id: 'S2', name: '终态', type: 'terminal' as const },
  ];
  const transitions = opts.transitions ?? [
    {
      id: 'T1',
      from: ['S1'],
      to: 'S2',
      action: 'do_action',
      trigger: 'system',
      name: '执行',
    },
  ];
  const invariants = opts.invariants ?? [
    { id: 'INV1', expression: 'S1 = S1', name: '不变量1', scopeStateIds: ['S1'], declaredBy: 'user', invariantClass: 'intra_protocol' as const },
  ];

  const seBlock =
    opts.subsidiaryEntities && opts.subsidiaryEntities.length > 0
      ? `# 附属实体\n\n\`\`\`yaml\n${opts.subsidiaryEntities
          .map((s) =>
            `- id: ${s.id}\n  name: ${s.name}\n  belongsTo: ${s.belongsTo}\n  instanceKey: ${s.instanceKey ?? 'entry.id'}\n  lifecycleDependency: ${s.lifecycleDependency ?? 'lifecycle of parent'}\n  cascadeRules: []\n  stateSpace: { dimensions: [] }\n  invariants: []`
          )
          .join('\n')}\n\`\`\`\n\n`
      : '';

  const content = `---
name: ${name}
version: 1.0.0
purpose: 用于 m-check 单元测试
roles:
  - id: user
    name: 用户
    roleType: consensus
  - id: system
    name: 系统
    roleType: participant
---

# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
${states.map((s) => `| ${s.id} | ${s.name} | ${s.type ?? 'normal'} |`).join('\n')}

# 转移规则

| ID | 名称 | from | to | action | trigger | triggerType | actionType | affectsDimensions | guard |
|---|---|---|---|---|---|---|---|---|---|
${transitions.map((t) => `| ${t.id} | ${t.name ?? t.id} | ${t.from.join(',')} | ${t.to} | ${t.action} | ${t.trigger ?? 'system'} | system | state_transition |  | ${t.guard ?? ''} |`).join('\n')}

# 不变量

| ID | 名称 | 表达式 | 作用状态 | declaredBy | invariantClass |
|---|---|---|---|---|---|
${invariants.map((i) => `| ${i.id} | ${i.name ?? i.id} | ${i.expression ?? 'TRUE'} | ${(i.scopeStateIds ?? ['S1']).join(',')} | ${i.declaredBy ?? 'user'} | ${i.invariantClass ?? 'intra_protocol'} |`).join('\n')}

${seBlock}`;

  return parseProtocolContent(content);
}

function issuesOf(report: MCheckReport, ruleId: string) {
  const rule = report.rules.find((r) => r.ruleId === ruleId);
  return rule?.issues ?? [];
}

// ============================================================================
// M001 命名规范
// ============================================================================

describe('M001 命名规范', () => {
  test('正常命名通过', () => {
    const model = makeValidModel({
      invariants: [{ id: 'INV1', expression: 'S1 = S1' }],
    });
    const report = runMCheck(model);
    expect(issuesOf(report, 'M001')).toHaveLength(0);
  });

  test('ID 含 `-`（019 单 INV-PS1 场景）被拦下', () => {
    const model = makeValidModel({
      invariants: [{ id: 'INV-PS1', expression: 'S1 = S1' }],
    });
    const report = runMCheck(model);
    const issues = issuesOf(report, 'M001');
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].elementId).toBe('INV-PS1');
    expect(issues[0].severity).toBe('error');
    expect(report.passed).toBe(false);
  });

  test('subsidiaryEntities ID 含 `-` 被拦下（与 M001 其他维度对齐）', () => {
    // E1-I6：补 SE 实体维度的命名违规用例。
    // 此前坏模型 B 用 transition ID 模拟 001 式违规，SE 维度未直接覆盖。
    // 规则覆盖等价（DERIVABLE_ID_FIELDS 含 subsidiaryEntities），但补用例避免
    // 误以为 SE 维度已单测。
    const model = makeValidModel({
      subsidiaryEntities: [
        {
          id: 'SE-BAD', // 含 `-`
          name: '流量配额',
          belongsTo: 'S1',
          instanceKey: 'entry.id',
          lifecycleDependency: 'lifecycle',
          cascadeRules: [],
          stateSpace: { dimensions: [] },
          invariants: [],
        },
      ],
    });
    const report = runMCheck(model);
    const issues = issuesOf(report, 'M001');
    expect(issues.some((i) => i.elementId === 'SE-BAD' && i.elementType === 'subsidiaryEntity')).toBe(true);
  });

  test('ID 含 `/` 被拦下', () => {
    const model = makeValidModel({
      transitions: [
        {
          id: 'T/1',
          from: ['S1'],
          to: 'S2',
          action: 'do',
          trigger: 'system',
        },
      ],
    });
    const report = runMCheck(model);
    const issues = issuesOf(report, 'M001');
    expect(issues.some((i) => i.elementId === 'T/1')).toBe(true);
  });

  test('state ID 简洁形式（如 S1）不被误伤', () => {
    // S1 不含禁用字符，应通过
    const model = makeValidModel({
      states: [{ id: 'S1', name: 'S1' }, { id: 'S2', name: 'S2' }],
    });
    const report = runMCheck(model);
    expect(issuesOf(report, 'M001').some((i) => i.elementType === 'state')).toBe(false);
  });
});

// ============================================================================
// M002 跨协议 ID 唯一性
// ============================================================================

describe('M002 跨协议 ID 唯一性', () => {
  test('无 peer 模型时不报错', () => {
    const model = makeValidModel();
    const report = runMCheck(model);
    expect(issuesOf(report, 'M002')).toHaveLength(0);
  });

  test('peer 目录名带描述（USAGE §5.1 P1-用户配额同步）也能加载（E1-I1 修复）', () => {
    // E1-I1：原过滤条件 /^P\d+$/ 不匹配 `P1-用户配额同步` 形式目录。
    // 修复后改为 /^P\d+/ 前缀匹配，应能正常加载并触发跨协议唯一性校验。
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
    const { tmpdir } = require('node:os');
    const { join } = require('node:path');
    const tmpRoot = mkdtempSync(join(tmpdir(), 'mcheck-i1-'));

    // 当前模型：protocol/P2-我的协议/model.md（目录名带描述）
    const curDir = join(tmpRoot, 'protocol', 'P2-我的协议');
    mkdirSync(curDir, { recursive: true });
    writeFileSync(
      join(curDir, 'model.md'),
      require('node:fs').readFileSync('tests/fixtures/saas-real-P1-user.md', 'utf-8')
    );

    // peer 模型：protocol/P1-用户与配额/model.md（与当前模型同名 INV1）
    const peerDir = join(tmpRoot, 'protocol', 'P1-用户与配额');
    mkdirSync(peerDir, { recursive: true });
    writeFileSync(
      join(peerDir, 'model.md'),
      require('node:fs').readFileSync('tests/fixtures/saas-real-P1-user.md', 'utf-8')
    );

    try {
      // 直接传 rootDir，走目录扫描路径
      const model = require('../src/parser/index.js').parseProtocolFile(
        join(curDir, 'model.md')
      );
      const report = runMCheck(model, tmpRoot);
      // peer 加载成功，M002 应报跨协议同名 ID（与 E1-I1 修复前的"恒为 0 项"形成对比）
      expect(issuesOf(report, 'M002').length).toBeGreaterThan(0);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test('CLI 多协议 self 不误报（E1-I7 修复）', () => {
    // E1-I7：CLI 多协议场景下，`--model protocol/P1-xxx/model.md` 时，self 协议
    // 被从同一文件重新 parse（新对象，引用不同），原过滤 `m !== model` 失效。
    // 修复：`runMCheck` 增加 `currentModelPath` 参数，按路径识别 self。
    // 期望：M002 只报真 peer 冲突，不报 self 自冲突。
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
    const { tmpdir } = require('node:os');
    const { join } = require('node:path');
    const tmpRoot = mkdtempSync(join(tmpdir(), 'mcheck-i7-'));

    const curDir = join(tmpRoot, 'protocol', 'P1-我的协议');
    mkdirSync(curDir, { recursive: true });
    writeFileSync(
      join(curDir, 'model.md'),
      require('node:fs').readFileSync('tests/fixtures/saas-real-P1-user.md', 'utf-8')
    );

    const peerDir = join(tmpRoot, 'protocol', 'P2-另一个协议');
    mkdirSync(peerDir, { recursive: true });
    // 用一个不与 P1 重名的 fixture（避免触发真实跨协议冲突）
    writeFileSync(
      join(peerDir, 'model.md'),
      require('node:fs').readFileSync('tests/fixtures/saas-real-P2-entry-config.md', 'utf-8')
    );

    try {
      const curPath = join(curDir, 'model.md');
      const model = require('../src/parser/index.js').parseProtocolFile(curPath);

      // 修复前（不传 currentModelPath）：self 副本会进 peerModels → M002 报自冲突
      const beforeFix = runMCheck(model, tmpRoot);
      expect(issuesOf(beforeFix, 'M002').length).toBeGreaterThan(0);

      // 修复后（传 currentModelPath）：self 被按路径排除 → M002 不报 self 冲突
      // 注：peer fixture 若仍含部分同名 ID 可能仍有少量 issues，但不应含 self ID
      const afterFix = runMCheck(model, tmpRoot, curPath);
      const selfIssues = issuesOf(afterFix, 'M002').filter(
        (i) => i.message.includes('P1-我的协议')
      );
      expect(selfIssues).toHaveLength(0);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test('peer 模型存在同名 ID 时报错', () => {
    const model = makeValidModel({
      name: '协议甲',
      states: [{ id: 'S_A', name: 'A' }, { id: 'S_B', name: 'B' }],
      invariants: [{ id: 'INV1', expression: 'S_A = S_A' }],
      transitions: [
        { id: 'T_A1', from: ['S_A'], to: 'S_B', action: 'do_a', trigger: 'system' },
      ],
    });
    const peer = makeValidModel({
      name: '协议乙',
      states: [{ id: 'S_C', name: 'C' }, { id: 'S_D', name: 'D' }],
      invariants: [{ id: 'INV1', expression: 'S_C = S_C' }],  // 与 model 同名
      transitions: [
        { id: 'T_C1', from: ['S_C'], to: 'S_D', action: 'do_c', trigger: 'system' },
      ],
    });
    const report = runMCheck(model, { P2: peer });
    const issues = issuesOf(report, 'M002');
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues.some((i) => i.elementId === 'INV1' && i.message.includes('子协议 P2'))).toBe(true);
  });

  test('peer 模型无同名 ID 时通过', () => {
    const model = makeValidModel({
      states: [{ id: 'S_A', name: 'A' }, { id: 'S_B', name: 'B' }],
      invariants: [{ id: 'INV1', expression: 'S_A = S_A' }],
      transitions: [
        { id: 'T_A1', from: ['S_A'], to: 'S_B', action: 'do_a', trigger: 'system' },
      ],
    });
    const peer = makeValidModel({
      states: [{ id: 'S_C', name: 'C' }, { id: 'S_D', name: 'D' }],
      invariants: [{ id: 'INV2', expression: 'S_C = S_C' }],
      transitions: [
        { id: 'T_C1', from: ['S_C'], to: 'S_D', action: 'do_c', trigger: 'system' },
      ],
    });
    const report = runMCheck(model, { P2: peer });
    expect(issuesOf(report, 'M002')).toHaveLength(0);
  });
});

// ============================================================================
// M003 附属实体归属
// ============================================================================

describe('M003 附属实体归属', () => {
  test('belongsTo 指向已存在 state 通过', () => {
    const model = makeValidModel({
      subsidiaryEntities: [
        {
          id: 'SE1',
          name: '流量配额',
          belongsTo: 'S1',
          instanceKey: 'entry.id',
          lifecycleDependency: 'lifecycle',
          cascadeRules: [],
          stateSpace: { dimensions: [] },
          invariants: [],
        },
      ],
    });
    const report = runMCheck(model);
    expect(issuesOf(report, 'M003')).toHaveLength(0);
  });

  test('belongsTo 指向不存在 state 被拦下', () => {
    const model = makeValidModel({
      subsidiaryEntities: [
        {
          id: 'SE1',
          name: '流量配额',
          belongsTo: 'S_NOT_EXISTS',
          instanceKey: 'entry.id',
          lifecycleDependency: 'lifecycle',
          cascadeRules: [],
          stateSpace: { dimensions: [] },
          invariants: [],
        },
      ],
    });
    const report = runMCheck(model);
    const issues = issuesOf(report, 'M003');
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].elementId).toBe('SE1');
    expect(issues[0].message).toContain('S_NOT_EXISTS');
  });

  test('belongsTo 含括号注解仍能解析', () => {
    // belongsTo: 'S1（P1）' → 应剥离括号并匹配 S1
    const model = makeValidModel({
      subsidiaryEntities: [
        {
          id: 'SE1',
          name: '流量配额',
          belongsTo: 'S1（P1）',
          instanceKey: 'entry.id',
          lifecycleDependency: 'lifecycle',
          cascadeRules: [],
          stateSpace: { dimensions: [] },
          invariants: [],
        },
      ],
    });
    const report = runMCheck(model);
    expect(issuesOf(report, 'M003')).toHaveLength(0);
  });

  test('belongsTo 含协议 ID（P2）视为跨协议引用，M003 不报错（E1-I2 修复）', () => {
    // 借鉴 checker 的跨协议识别：含 P\d 视为跨协议，跳过单协议存在性校验。
    // 此前的实现会把括号剥离成 'entry'，'entry' 不在本协议 states → 误报 error。
    const model = makeValidModel({
      subsidiaryEntities: [
        {
          id: 'SE_CROSS',
          name: '跨协议附属实体',
          belongsTo: 'entry（P2）', // 引用 P2 协议实体 entry
          instanceKey: 'entry.id',
          lifecycleDependency: 'lifecycle',
          cascadeRules: [],
          stateSpace: { dimensions: [] },
          invariants: [],
        },
      ],
    });
    const report = runMCheck(model);
    // 跨协议引用 M003 不应误报（由 checker 后续识别为 pendingCrossProtocolRef）
    expect(issuesOf(report, 'M003')).toHaveLength(0);
  });
});

// ============================================================================
// M004 旧字符 / 中文标点禁用
// ============================================================================

describe('M004 旧字符 / 中文标点', () => {
  test('invariant.expression 含连字符被拦下', () => {
    const model = makeValidModel({
      invariants: [{ id: 'INV1', expression: 'forward-resource > 0' }],
    });
    const report = runMCheck(model);
    const issues = issuesOf(report, 'M004');
    expect(issues.some((i) => i.elementId === 'INV1')).toBe(true);
  });

  test('transition.guard 含中文逗号被拦下', () => {
    const model = makeValidModel({
      transitions: [
        {
          id: 'T1',
          from: ['S1'],
          to: 'S2',
          action: 'do',
          trigger: 'system',
          guard: 'state > 0，next = S2',
        },
      ],
    });
    const report = runMCheck(model);
    expect(issuesOf(report, 'M004').some((i) => i.elementId === 'T1')).toBe(true);
  });

  test('invariant.expression 全合法通过', () => {
    const model = makeValidModel({
      invariants: [{ id: 'INV1', expression: 'count <= quota_cap' }],
    });
    const report = runMCheck(model);
    if (issuesOf(report, 'M004').length > 0) {
      console.error('M004 issues:', JSON.stringify(issuesOf(report, 'M004'), null, 2));
    }
    expect(issuesOf(report, 'M004')).toHaveLength(0);
  });
});

// ============================================================================
// M005 ID 转义前置
// ============================================================================

describe('M005 ID 转义前置', () => {
  test('ID 与 TLA+ 关键字 `TRUE` 撞名被拦下', () => {
    const model = makeValidModel({
      invariants: [{ id: 'TRUE', expression: 'S1 = S1' }],
    });
    const report = runMCheck(model);
    expect(issuesOf(report, 'M005').some((i) => i.elementId === 'TRUE')).toBe(true);
  });

  test('invariant.expression 为裸 `TRUE` 报 warning', () => {
    const model = makeValidModel({
      invariants: [{ id: 'INV1', expression: 'TRUE' }],
    });
    const report = runMCheck(model);
    const issues = issuesOf(report, 'M005');
    const trueExprIssue = issues.find(
      (i) => i.elementId === 'INV1' && i.message.includes('TRUE')
    );
    expect(trueExprIssue).toBeDefined();
    expect(trueExprIssue?.severity).toBe('warning');
  });

  test('合法 ID 与表达式通过', () => {
    const model = makeValidModel({
      invariants: [{ id: 'INV1', expression: 'x > 0' }],
    });
    const report = runMCheck(model);
    expect(issuesOf(report, 'M005')).toHaveLength(0);
  });
});

// ============================================================================
// 端到端：验收文档 E1 通过标准
// ============================================================================

describe('E1 验收端到端', () => {
  test('坏模型 A：INV-PS1 → m-check 报告逐条列出', () => {
    const model = makeValidModel({
      invariants: [{ id: 'INV-PS1', expression: 'forward-resource > 0' }],
    });
    const report = runMCheck(model);
    // 同时被 M001（命名违规）和 M004（表达式含 -）拦下
    expect(report.passed).toBe(false);
    expect(issuesOf(report, 'M001').some((i) => i.elementId === 'INV-PS1')).toBe(true);
    expect(issuesOf(report, 'M004').some((i) => i.elementId === 'INV-PS1')).toBe(true);
  });

  test('坏模型 B：transition id 含 `-` 违规', () => {
    const model = makeValidModel({
      transitions: [
        {
          id: 'T-BAD',
          from: ['S1'],
          to: 'S2',
          action: 'do',
          trigger: 'system',
        },
      ],
    });
    const report = runMCheck(model);
    expect(report.passed).toBe(false);
    expect(issuesOf(report, 'M001').some((i) => i.elementId === 'T-BAD')).toBe(true);
  });

  test('正常模型：所有规则均通过', () => {
    const model = makeValidModel({
      invariants: [{ id: 'INV1', expression: 'count <= quota' }],
      transitions: [
        {
          id: 'T1',
          from: ['S1'],
          to: 'S2',
          action: 'do_thing',
          trigger: 'system',
          guard: 'count > 0',
        },
      ],
      subsidiaryEntities: [
        {
          id: 'SE1',
          name: '配额',
          belongsTo: 'S1',
          instanceKey: 'entry.id',
          lifecycleDependency: 'lifecycle',
          cascadeRules: [],
          stateSpace: { dimensions: [] },
          invariants: [],
        },
      ],
    });
    const report = runMCheck(model);
    expect(report.passed).toBe(true);
    expect(report.summary.errors).toBe(0);
    for (const r of report.rules) {
      expect(r.passed).toBe(true);
    }
  });

  test('报告结构含 modelVersion / modelName / checkedAt', () => {
    const model = makeValidModel();
    const report = runMCheck(model);
    expect(report.modelVersion).toBe('1.0.0');
    expect(report.modelName).toBe('测试协议');
    expect(report.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});