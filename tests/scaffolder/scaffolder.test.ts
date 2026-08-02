import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProject } from '../../src/scaffolder/index.js';
import { scaffoldInterfaces } from '../../src/scaffolder/index.js';
import type { InterfaceSpec } from '../../src/model/types.js';

describe('scaffolder', () => {
  describe('initProject', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'protochain-test-'));
    });

    test('生成协议项目骨架', () => {
      const result = initProject({ name: '测试协议', rootDir: tmpDir });

      // 必需目录
      expect(existsSync(join(tmpDir, 'protocol'))).toBe(true);
      expect(existsSync(join(tmpDir, 'protocol/scenarios'))).toBe(true);
      expect(existsSync(join(tmpDir, 'derived'))).toBe(true);
      expect(existsSync(join(tmpDir, 'impl-scaffold'))).toBe(true);
      expect(existsSync(join(tmpDir, 'diff'))).toBe(true);

      // 必需文件
      expect(existsSync(join(tmpDir, 'protocol/model.md'))).toBe(true);
      expect(existsSync(join(tmpDir, 'protocol/scenarios/SC1.yaml'))).toBe(true);
      expect(existsSync(join(tmpDir, 'protochain.config.yaml'))).toBe(true);

      expect(result.createdFiles).toContain('protocol/model.md');
      expect(result.createdFiles).toContain('protochain.config.yaml');
    });

    test('model.md 模板含三层结构', () => {
      initProject({ name: '测试', rootDir: tmpDir });
      const modelContent = readFileSync(join(tmpDir, 'protocol/model.md'), 'utf-8');

      // 元数据层 front matter
      expect(modelContent).toMatch(/^---/);
      expect(modelContent).toContain('name: 测试');
      expect(modelContent).toContain('version: 0.1.0');
      expect(modelContent).toContain('roles:');

      // 可读层
      expect(modelContent).toContain('# 背景');
      expect(modelContent).toContain('# 核心概念');
      expect(modelContent).toContain('# 协作流程');

      // 可推演层
      expect(modelContent).toContain('# 状态空间');
      expect(modelContent).toContain('# 转移规则');
      expect(modelContent).toContain('# 不变量');
      expect(modelContent).toContain('# 时序约束');
      expect(modelContent).toContain('# 异常路径');

      // 契约层
      expect(modelContent).toContain('# 契约层');
    });

    test('config.yaml 含默认配置', () => {
      initProject({ name: '测试', rootDir: tmpDir });
      const configContent = readFileSync(join(tmpDir, 'protochain.config.yaml'), 'utf-8');
      expect(configContent).toContain('name: 测试');
      expect(configContent).toContain('provider: local');
      expect(configContent).toContain('criterion: state');
    });

    test('不覆盖已存在文件（除非 force）', () => {
      initProject({ name: 'first', rootDir: tmpDir });
      const modelPath = join(tmpDir, 'protocol/model.md');
      const firstContent = readFileSync(modelPath, 'utf-8');

      // 修改文件
      writeFileSync(modelPath, firstContent + '\n# 用户自定义\n', 'utf-8');

      // 再次 init 不覆盖
      initProject({ name: 'second', rootDir: tmpDir });
      const secondContent = readFileSync(modelPath, 'utf-8');
      expect(secondContent).toContain('用户自定义');
      expect(secondContent).not.toContain('name: second');
    });

    test('force 覆盖已存在文件', () => {
      initProject({ name: 'first', rootDir: tmpDir });
      const modelPath = join(tmpDir, 'protocol/model.md');

      initProject({ name: 'second', rootDir: tmpDir, force: true });
      const content = readFileSync(modelPath, 'utf-8');
      expect(content).toContain('name: second');
      expect(content).not.toContain('name: first');
    });
  });

  describe('scaffoldInterfaces', () => {
    test('从接口规格生成 TypeScript 类型骨架', () => {
      const specs: InterfaceSpec[] = [
        {
          id: 'IF1',
          kind: 'system',
          sourceId: 'submit',
          name: 'submit',
          inputs: [{ name: 'form', type: 'string', required: true }],
          outputs: [{ name: 'requestId', type: 'string' }],
          precondition: 'form_valid',
          postconditions: ['create_request', 'notify_approver'],
        },
        {
          id: 'IF2',
          kind: 'observation',
          sourceId: 'S1',
          name: 'observeDraft',
          inputs: [],
          outputs: [{ name: 'state', type: 'string' }],
        },
      ];

      const code = scaffoldInterfaces({ specs });
      expect(code).toContain('interface Submit');
      expect(code).toContain('(form: string)');
      expect(code).toContain('string | Promise<string>');
      expect(code).toContain('interface ObserveDraft');
      expect(code).toContain('ProtocolImplementation');
      expect(code).toContain('submit: Submit');
      expect(code).toContain('observeDraft: ObserveDraft');
    });

    test('空 outputs 映射为 void', () => {
      const specs: InterfaceSpec[] = [
        {
          id: 'IF1',
          kind: 'system',
          sourceId: 'act',
          name: 'doAct',
          inputs: [],
          outputs: [],
        },
      ];
      const code = scaffoldInterfaces({ specs });
      expect(code).toContain('): void | Promise<void>');
    });
  });
});
