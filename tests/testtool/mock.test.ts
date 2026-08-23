/**
 * E6：Mock/Spy 自动生成单测
 *
 * 覆盖：
 *  - generateMockCode 输出 deterministic TS
 *  - buildMockImplementation(model) 返回的 mock 走 TRANSITIONS 静态查表
 *  - runMockVerification 全绿（model 与 test-cases 一致时）
 *  - resetSpy 后 spy 清零
 *  - 两次连续 runMockVerification 输出确定性（无时间/随机）
 */

import { parseProtocolContent } from '../../src/parser/index.js';
import { generateCases } from '../../src/casegen/index.js';
import { generateMockCode } from '../../src/testgen/index.js';
import {
  buildMockImplementation,
  runMockVerification,
  getSpySnapshot,
  resetSpy,
} from '../../src/testtool/mock.js';

const MODEL_MD = `---
name: e6-test
version: 0.1.0
purpose: mock 单测
roles:
  - id: R-Op
    name: Op
---
# 状态空间
| ID | 名称 | 类型 |
|---|---|---|
| S1 | active | initial |
| S2 | paused | normal |
| S3 | expired | terminal |

# 转移规则
| ID | 名称 | from | to | action |
|---|---|---|---|---|
| T1 | pause | S1 | S2 | pause |
| T2 | resume | S2 | S1 | resume |
| T3 | expire | S1 | S3 | expire |

# 不变量
| ID | 名称 | 表达式 | 作用状态 | 声明方 |
|---|---|---|---|---|
| INV1 | always | TRUE | | R-Op |
`;

describe('E6 mock/spy 自动生成', () => {
  const model = parseProtocolContent(MODEL_MD);
  const testCases = generateCases(model, { criterion: 'state' });

  describe('generateMockCode', () => {
    it('输出 deterministic TS（含 fixtures + spy）', () => {
      const a = generateMockCode(model);
      const b = generateMockCode(model);
      // deterministic：不依赖时间/随机
      expect(a).toBe(b);
      // 文件头注释
      expect(a).toContain('E6 Mock/Spy');
      expect(a).toContain(model.sourcePath ?? 'protocol/model.md');
      // 含 buildMockImplementation 默认导出
      expect(a).toContain('export default function buildMockImplementation');
      // spy 工具
      expect(a).toContain('export function getSpySnapshot');
      expect(a).toContain('export function resetSpy');
      // fixtures：每个 action 都展开
      expect(a).toContain("['pause']");
      expect(a).toContain("['resume']");
      expect(a).toContain("['expire']");
      // spy 在 fixtures 内引用
      expect(a).toContain("calls['pause']");
      expect(a).toContain("calls['resume']");
      expect(a).toContain("calls['expire']");
    });
  });

  describe('buildMockImplementation + runMockVerification', () => {
    beforeEach(() => resetSpy());

    it('无 impl 环境下全绿（用例与 model 一致）', async () => {
      const impl = buildMockImplementation(model);
      const run = await runMockVerification(model, testCases, impl);
      // 全路径应通过（mock 返回 TRANSITIONS.to 与期望一致）
      expect(run.passedCases).toBe(run.executedCases);
      expect(run.failedCases).toBe(0);
    });

    it('spy 触发：每个用例的 action 调用计数 > 0', async () => {
      const impl = buildMockImplementation(model);
      await runMockVerification(model, testCases, impl);
      const spy = getSpySnapshot();
      expect(Object.keys(spy.counters).length).toBeGreaterThan(0);
      const total = Object.values(spy.counters).reduce((a, b) => a + b, 0);
      expect(total).toBeGreaterThan(0);
    });

    it('两次连续 runMockVerification 确定性（无随机）', async () => {
      resetSpy();
      const a = await runMockVerification(model, testCases, buildMockImplementation(model));
      resetSpy();
      const b = await runMockVerification(model, testCases, buildMockImplementation(model));
      expect(a.passedCases).toBe(b.passedCases);
      expect(a.failedCases).toBe(b.failedCases);
      expect(a.executedCases).toBe(b.executedCases);
      // caseResults 顺序与内容一致（除 generatedAt 时间戳）
      const aStrip = a.caseResults.map((r) => `${r.pathId}:${r.passed}:${r.error ?? ''}`).join('|');
      const bStrip = b.caseResults.map((r) => `${r.pathId}:${r.passed}:${r.error ?? ''}`).join('|');
      expect(aStrip).toBe(bStrip);
    });

    it('resetSpy 清零 spy 计数', () => {
      buildMockImplementation(model); // 不调用，不增加计数
      // 通过 impl 触达 spy
      const impl = buildMockImplementation(model);
      void impl.pause('S1');
      void impl.resume('S2');
      const before = getSpySnapshot();
      expect(before.counters['pause']).toBeGreaterThan(0);
      resetSpy();
      const after = getSpySnapshot();
      expect(Object.keys(after.counters).every((k) => after.counters[k] === 0)).toBe(true);
    });
  });
});