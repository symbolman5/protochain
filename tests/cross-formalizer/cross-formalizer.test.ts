import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCompositionContent } from '../../src/composition-parser/index.js';
import { parseProtocolContent } from '../../src/parser/index.js';
import {
  generateTlaSkeleton,
  crossFormalize,
} from '../../src/cross-formalizer/index.js';
import type { CompositionModel, SourceProtocolModel } from '../../src/model/types.js';

const FIXTURES = join(process.cwd(), 'tests/fixtures');

function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf-8');
}

function loadComposition(): CompositionModel {
  return parseCompositionContent(
    readFixture('composition-saas.md'),
    'composition-saas.md'
  );
}

function loadP2Model(): SourceProtocolModel {
  return parseProtocolContent(
    readFixture('saas-P2-entry.md'),
    'saas-P2-entry.md'
  );
}

function loadApprovalModel(): SourceProtocolModel {
  return parseProtocolContent(
    readFixture('approval-flow.md'),
    'approval-flow.md'
  );
}

describe('cross-formalizer', () => {
  const composition = loadComposition();
  const p2Model = loadP2Model();
  const approvalModel = loadApprovalModel();

  describe('generateTlaSkeleton（代码确定性生成）', () => {
    const skeleton = generateTlaSkeleton(composition, [approvalModel, p2Model]);

    test('生成完整的 MODULE 声明', () => {
      expect(skeleton).toContain('---- MODULE');
      // systemName "SaaS 系统" 经 toAscii 剔除中文 + 空格转下划线 → "SaaS_"（合法 TLA 标识符）
      expect(skeleton).toContain('SaaS_');
    });

    test('包含 EXTENDS 声明', () => {
      expect(skeleton).toContain('EXTENDS Naturals');
    });

    test('包含 CONSTANTS 声明（各子协议状态ID）', () => {
      expect(skeleton).toContain('CONSTANTS');
      // P2 状态ID
      expect(skeleton).toContain('S1');
      expect(skeleton).toContain('S2');
      expect(skeleton).toContain('S3');
    });

    test('包含 VARIABLE 声明（全局状态变量）', () => {
      expect(skeleton).toContain('VARIABLE');
      expect(skeleton).toContain('P2_state');
    });

    test('包含 Init 谓词', () => {
      expect(skeleton).toContain('Init ==');
    });

    test('包含 Next 谓词骨架', () => {
      expect(skeleton).toContain('Next ==');
    });

    test('包含跨协议不变量映射为 TypeInvariant', () => {
      if (composition.crossInvariants.length > 0) {
        expect(skeleton).toContain('TypeInvariant');
        expect(skeleton).toContain('CrossInvariants');
      }
    });

    test('包含 Spec 定义', () => {
      expect(skeleton).toContain('Spec ==');
      expect(skeleton).toContain('====');
    });

    test('包含跨协议时序注释', () => {
      // CT1: 入口创建时效
      expect(skeleton).toContain('CT1');
    });

    test('生成对象状态切面关联变量', () => {
      // entry 对象切面
      expect(skeleton).toContain('entry_link');
    });
  });

  describe('crossFormalize（主入口）', () => {
    test('无 AI 适配器时生成骨架并标记 passed', async () => {
      const report = await crossFormalize(composition, {
        subProtocolModels: [approvalModel, p2Model],
      });

      expect(report.tool).toBe('tla+');
      expect(report.generatedSpec.length).toBeGreaterThan(0);
      expect(report.passed).toBe(true); // 骨架始终可用
      expect(report.specFilePath).toBe('derived/composition/model.tla');
      expect(report.verifiedAt).toBeTruthy();
    });

    test('生成的骨架是合法语法格式', async () => {
      const report = await crossFormalize(composition, {
        subProtocolModels: [approvalModel, p2Model],
      });

      const spec = report.generatedSpec;
      expect(spec.startsWith('---- MODULE')).toBe(true);
      expect(spec.endsWith('====')).toBe(true);
    });

    test('无子协议模型时生成最小骨架', async () => {
      const report = await crossFormalize(composition, {
        subProtocolModels: [],
      });

      // 即使无子协议模型，骨架也应能生成（MODULE/EXTENDS/Init/Spec 基础结构）
      expect(report.generatedSpec).toContain('MODULE');
      expect(report.generatedSpec).toContain('Init ==');
    });
  });
});
