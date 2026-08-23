/**
 * E4：verifier 中数据级不变量 → by-design 段收集单测
 */

import { parseProtocolContent } from '../../src/parser/index.js';
import { collectByDesignItems, formatVerificationSummary } from '../../src/verifier/index.js';
import type { SourceProtocolModel } from '../../src/model/types.js';

const MODEL_MD = `---
name: e4-test
version: 0.1.0
purpose: 数据级不变量 by-design 段单测
roles:
  - id: R-Op
    name: Op
---
# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S1 | active | normal |
| S2 | expired | terminal |

# 转移规则

| ID | 名称 | from | to | action |
|---|---|---|---|---|
| T1 | expire | S1 | S2 | expire |

# 不变量

| ID | 名称 | 表达式 | 作用状态 | 声明方 | 级别 | source | storageRef | guardLocation | 描述 |
|---|---|---|---|---|---|---|---|---|---|
| INV_DATA_STORAGE | UNIQUE(fwd_mapping_resource.id) | UNIQUE(fwd_mapping_resource.id) | S1 | R-Op | data | storage | fwd_mapping_resource | | 由 storage 唯一约束保证 |
| INV_DATA_GUARD | guard-inv | TRUE | S1 | R-Op | data | guard | | service.go L100-110 | 由 impl 守卫保证（service.go L100-110） |
| INV_DATA_BARE | bare-inv | UNIQUE(x.id) | S1 | R-Op | data | | | | storageRef 缺，工具链无法生成 SQL |
| INV_STATEMACHINE | state-inv | state \\in States | S1, S2 | R-Op | state-machine | | | | 状态机级；不进 by-design |
`;

describe('E4 verifier by-design 段', () => {
  let model: SourceProtocolModel;
  beforeAll(() => {
    model = parseProtocolContent(MODEL_MD);
  });

  it('source=guard 归入 by-design 段，含 guardLocation', () => {
    const items = collectByDesignItems(model);
    const guardItem = items.find((b) => b.invariantId === 'INV_DATA_GUARD');
    expect(guardItem).toBeDefined();
    expect(guardItem!.guardLocation).toBe('service.go L100-110');
    expect(guardItem!.reason).toContain('impl 守卫保证');
  });

  it('source=storage 归入 SQL 校验，不进 by-design', () => {
    const items = collectByDesignItems(model);
    const storageItem = items.find((b) => b.invariantId === 'INV_DATA_STORAGE');
    expect(storageItem).toBeUndefined();
  });

  it('level=data 但缺 source/storageRef → 兜底 by-design', () => {
    const items = collectByDesignItems(model);
    const bareItem = items.find((b) => b.invariantId === 'INV_DATA_BARE');
    expect(bareItem).toBeDefined();
    expect(bareItem!.reason).toContain('storageRef');
  });

  it('level=state-machine 不进 by-design', () => {
    const items = collectByDesignItems(model);
    const stateMachineItem = items.find((b) => b.invariantId === 'INV_STATEMACHINE');
    expect(stateMachineItem).toBeUndefined();
  });

  it('formatVerificationSummary 输出 by-design 段文本', () => {
    const items = collectByDesignItems(model);
    // by-design 段长这样：
    const fakeReport = {
      authoritative: { passed: true, counts: { passed: 0, failed: 0, skipped: 0 }, caseResults: [] },
      byDesignNotTestedByToolchain: items,
      verifiedAt: new Date().toISOString(),
    };
    const text = formatVerificationSummary(fakeReport);
    expect(text).toContain('by-design-not-tested-by-toolchain');
    expect(text).toContain('INV_DATA_GUARD');
    expect(text).toContain('INV_DATA_BARE');
    expect(text).toContain('service.go L100-110');
  });

  it('legacy model.md 无 level 列 → 默认 state-machine（不破坏现有协议）', () => {
    const LEGACY = `---
name: legacy
version: 0.1.0
purpose: legacy
roles:
  - id: R-Op
    name: Op
---
# 状态空间
| ID | 名称 | 类型 |
|---|---|---|
| S1 | a | normal |

# 转移规则
| ID | 名称 | from | to | action |
|---|---|---|---|---|
| T1 | do | S1 | S1 | do |

# 不变量
| ID | 名称 | 表达式 | 作用状态 | 声明方 |
|---|---|---|---|---|
| INV1 | legacy | TRUE | S1 | R-Op |
`;
    const m = parseProtocolContent(LEGACY);
    expect(m.derivable.invariants[0].level).toBe('state-machine');
    // legacy 不进 by-design
    expect(collectByDesignItems(m)).toHaveLength(0);
  });
});