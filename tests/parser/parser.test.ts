import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProtocolContent, parseProtocolFile, ParseError } from '../../src/parser/index.js';

const FIXTURES = join(process.cwd(), 'tests/fixtures');

function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf-8');
}

describe('parser', () => {
  describe('parseProtocolContent - 审批流正常模式', () => {
    const content = readFixture('approval-flow.md');
    const model = parseProtocolContent(content, 'approval-flow.md');

    test('解析元数据层', () => {
      expect(model.metadata.name).toBe('审批流协议');
      expect(model.metadata.version).toBe('1.0.0');
      expect(model.metadata.purpose).toContain('审批');
      expect(model.metadata.roles).toHaveLength(3);
      expect(model.metadata.roles[0]).toEqual({
        id: 'applicant',
        name: '申请人',
        responsibilities: '发起审批请求、补充材料、查阅结果',
        roleType: 'consensus', // 遗留迁移补全：无 roleType 声明时首个角色提升为共识方
      });
    });

    test('解析可读层', () => {
      expect(model.readable.background).toContain('审批流');
      expect(model.readable.concepts.length).toBeGreaterThan(0);
      const req = model.readable.concepts.find((c) => c.term === '审批请求');
      expect(req?.definition).toContain('表单');
      expect(model.readable.workflow).toContain('申请人');
    });

    test('解析可推演层状态', () => {
      expect(model.derivable.degraded).toBe(false);
      expect(model.derivable.states).toHaveLength(5);
      const s1 = model.derivable.states.find((s) => s.id === 'S1');
      expect(s1).toEqual({
        id: 'S1',
        name: '草稿',
        type: 'initial',
        description: '申请人编辑中',
        roleIds: ['applicant'],
      });
      const s3 = model.derivable.states.find((s) => s.id === 'S3');
      expect(s3?.type).toBe('terminal');
    });

    test('解析可推演层转移', () => {
      expect(model.derivable.transitions).toHaveLength(5);
      const t1 = model.derivable.transitions.find((t) => t.id === 'T1');
      expect(t1).toMatchObject({
        id: 'T1',
        name: '提交',
        from: ['S1'],
        to: 'S2',
        action: 'submit',
        triggerRoleId: 'applicant',
        guard: 'form_valid',
      });
      expect(t1?.effects).toEqual(['create_request', 'notify_approver']);
    });

    test('解析可推演层不变量', () => {
      expect(model.derivable.invariants).toHaveLength(2);
      const inv1 = model.derivable.invariants.find((i) => i.id === 'INV1');
      expect(inv1?.expression).toContain('count(active_requests');
    });

    test('解析可推演层时序约束', () => {
      expect(model.derivable.timing).toHaveLength(2);
      const tm1 = model.derivable.timing.find((t) => t.id === 'TM1');
      expect(tm1).toMatchObject({
        id: 'TM1',
        type: 'timeout',
        source: 'submit',
        target: 'approve',
        boundMs: 86400000,
      });
    });

    test('解析可推演层异常路径', () => {
      expect(model.derivable.exceptions).toHaveLength(2);
      const ex1 = model.derivable.exceptions.find((e) => e.id === 'EX1');
      expect(ex1?.transitionIds).toEqual(['T1', 'T5']);
    });

    test('推断初始状态与终态', () => {
      expect(model.derivable.initialStateId).toBe('S1');
      expect(model.derivable.terminalStateIds).toEqual(
        expect.arrayContaining(['S3', 'S4', 'S5'])
      );
    });

    test('解析契约层输入', () => {
      expect(model.contractInput).toBeDefined();
      expect(model.contractInput?.parties).toEqual(['applicant', 'approver', 'system']);
      expect(model.contractInput?.expectedInformationFields).toContain('request_form');
    });
  });

  describe('parseProtocolContent - 退化模式', () => {
    const content = readFixture('degraded-protocol.md');
    const model = parseProtocolContent(content);

    test('检测退化模式标记', () => {
      expect(model.derivable.degraded).toBe(true);
      expect(model.derivable.formalLanguage).toBe('tla');
    });

    test('保留形式化规格原文', () => {
      expect(model.derivable.formalSpecRaw).toContain('MODULE ConcurrentProtocol');
      expect(model.derivable.formalSpecRaw).toContain('Init ==');
      expect(model.derivable.formalSpecRaw).toContain('Next ==');
      expect(model.derivable.formalSpecRaw).toContain('Inv ==');
    });

    test('仍解析已提供的结构化状态（策略B：尽可能提取）', () => {
      expect(model.derivable.states).toHaveLength(1);
      expect(model.derivable.states[0].id).toBe('S1');
    });
  });

  describe('错误处理', () => {
    test('缺少 front matter 抛出 ParseError', () => {
      expect(() => parseProtocolContent('# 仅标题\n\n无 front matter')).toThrow(ParseError);
    });

    test('缺少必填字段抛出 ParseError', () => {
      const bad = `---
name: 测试
version: 1.0.0
purpose: 测试
---
# 背景
`;
      expect(() => parseProtocolContent(bad)).toThrow(ParseError);
    });

    test('表格行缺少必填字段抛出 ParseError', () => {
      const bad = `---
name: 测试
version: 1.0.0
purpose: 测试
roles:
  - id: r1
    name: 角色1
---
# 状态空间

| ID | 名称 | 类型 |
|---|---|---|
| S1 | | initial |
`;
      expect(() => parseProtocolContent(bad)).toThrow(/name/);
    });
  });

  describe('parseProtocolFile', () => {
    test('从文件路径解析', () => {
      const path = join(FIXTURES, 'approval-flow.md');
      const model = parseProtocolFile(path);
      expect(model.sourcePath).toBe(path);
      expect(model.metadata.name).toBe('审批流协议');
      expect(model.parsedAt).toBeDefined();
    });
  });
});
