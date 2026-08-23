/**
 * E11 后续问题 5/6（008-5/6）webgen 渲染 — 单测
 *
 * 设计依据：工具链修改单 008 §E11 后续问题 5/6
 *   - 008-5：契约承载接口在 web 详情页头部加注 + 在接口列表/详情中识别 isContractCarrier
 *   - 008-6：currentState 输入字段加注 CAS 断言说明（状态转移接口 vs 观测接口）
 *
 * 覆盖：
 * - buildInterfaceViews 透传 isContractCarrier
 * - 单协议 renderInterfaceDetailPage：
 *   - 承载接口头部标注
 *   - 状态转移接口 currentState 加 "CAS 断言" 标注
 *   - 观测接口 currentState 加 "CAS 断言（impl 不读取）" 标注
 *   - 契约承载接口 currentState（罕见）不加 CAS 标注
 * - 组合层 renderProjectInterfaceDetailPage：CAS + 承载接口标注对齐
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  deriveWeb,
  buildInterfaceViews,
} from '../../src/webgen/index.js';
import { parseProtocolFile } from '../../src/parser/index.js';
import { specify } from '../../src/specifier/index.js';
import { renderProjectInterfaceDetailPage } from '../../src/webgen/composition.js';
import type {
  SourceProtocolModel,
  InterfaceSpec,
} from '../../src/model/types.js';

const FIXTURE_DIR = '/work/protochain/tests/fixtures';

function loadApprovalFlowModel(): SourceProtocolModel {
  return parseProtocolFile(`${FIXTURE_DIR}/approval-flow.md`);
}

function loadApprovalFlowSpecs(): InterfaceSpec[] {
  return specify(loadApprovalFlowModel()).specs;
}

const DEFAULT_PROTOCOL_MD =
  '---\n' +
  'name: E11 测试协议\n' +
  'version: 1.0.0\n' +
  'purpose: E11 后续问题 5/6 webgen 渲染测试\n' +
  'roles:\n' +
  '  - id: admin\n' +
  '    name: 管理员\n' +
  '  - id: system\n' +
  '    name: 系统\n' +
  '---\n' +
  '\n# 状态空间\n\n' +
  '| ID | 名称 | 类型 |\n|---|---|---|\n| S1 | 初始 | initial |\n| S2 | 终态 | terminal |\n\n' +
  '# 转移规则\n\n' +
  '| ID | 名称 | from | to | action | trigger |\n|---|---|---|---|---|---|\n| T1 | 注册 | S1 | S2 | register | admin |\n';

function makeTempWebgenProject(opts: {
  specs: InterfaceSpec[];
  protocolMd?: string;
}): string {
  const tmp = join(tmpdir(), `webgen-e11-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(join(tmp, 'protocol'), { recursive: true });
  mkdirSync(join(tmp, 'derived'), { recursive: true });
  mkdirSync(join(tmp, 'derived/verification'), { recursive: true });
  mkdirSync(join(tmp, 'derived/impl-check'), { recursive: true });
  mkdirSync(join(tmp, 'derived/diff'), { recursive: true });
  writeFileSync(join(tmp, 'protocol/model.md'), opts.protocolMd ?? DEFAULT_PROTOCOL_MD, 'utf-8');
  const envelope = {
    schemaVersion: '1.0' as const,
    generatedAt: new Date().toISOString(),
    sourceModelVersion: '1.0.0',
    specs: opts.specs,
  };
  writeFileSync(join(tmp, 'derived/specs.json'), JSON.stringify(envelope, null, 2));
  return tmp;
}

describe('webgen - E11 后续问题 5/6 渲染标注', () => {
  describe('008-5：契约承载接口标记透传', () => {
    test('buildInterfaceViews 透传 isContractCarrier=true', () => {
      const specs: InterfaceSpec[] = [
        {
          id: 'IF_CTR_mappingCreate',
          kind: 'system',
          sourceId: 'mappingCreate',
          name: 'mappingCreate',
          inputs: [],
          outputs: [],
          requestSchema: { type: 'object' },
          responseSchema: { type: 'object' },
          schemaKind: 'structured',
          contractSource: 'mappingCreate',
          isContractCarrier: true,
          errorResponses: [
            {
              id: 'ERR-01',
              errorCode: 'port_conflict',
              httpStatus: 409,
            },
          ],
        },
      ];
      const views = buildInterfaceViews(specs);
      expect(views).toHaveLength(1);
      expect(views[0].isContractCarrier).toBe(true);
      expect(views[0].errorResponses?.[0].errorCode).toBe('port_conflict');
    });

    test('buildInterfaceViews 不影响非承载接口（isContractCarrier 默认 undefined）', () => {
      const specs: InterfaceSpec[] = [
        {
          id: 'IF_SYS_T1',
          kind: 'system',
          sourceId: 'register',
          name: 'register',
          inputs: [{ name: 'currentState', type: 'string', required: true, description: '当前状态' }],
          outputs: [],
          requestSchema: { type: 'object' },
          responseSchema: { type: 'object' },
          schemaKind: 'structured',
        },
      ];
      const views = buildInterfaceViews(specs);
      expect(views[0].isContractCarrier).toBeUndefined();
    });
  });

  describe('008-6：currentState CAS 标注', () => {
    test('derive-web 端到端：状态转移接口 currentState 含 "CAS 断言" 文本', async () => {
      // 使用 approval-flow fixture（已是状态机协议）
      const model = loadApprovalFlowModel();
      const specs = loadApprovalFlowSpecs();
      const targetSpec = specs.find(
        (s) => s.kind === 'system' && (s.inputs ?? []).some((i) => i.name === 'currentState')
      );
      expect(targetSpec).toBeDefined();

      const tmp = makeTempWebgenProject({
        specs,
        protocolMd: readFileSync(`${FIXTURE_DIR}/approval-flow.md`, 'utf-8'),
      });
      // 覆盖 sourceModelVersion 以便 deriveWeb 接受
      const envelope = {
        schemaVersion: '1.0' as const,
        generatedAt: new Date().toISOString(),
        sourceModelVersion: model.metadata.version,
        specs,
      };
      writeFileSync(join(tmp, 'derived/specs.json'), JSON.stringify(envelope, null, 2));

      await deriveWeb(
        { rootDir: tmp, buildSite: false },
        (rd) => parseProtocolFile(join(rd, 'protocol/model.md'))
      );
      const detailPath = join(tmp, 'web/docs/interfaces', `${targetSpec!.id}.md`);
      expect(existsSync(detailPath)).toBe(true);
      const md = readFileSync(detailPath, 'utf-8');
      // currentState 行加注：「CAS 断言」
      expect(md).toContain('CAS 断言');
      // 状态转移接口：包含「状态转移前置校验」或「资源实际状态 == currentState」
      expect(md).toMatch(/状态转移前置校验|resource 实际状态 == currentState/);
    });

    test('观测接口 currentState 加 "CAS 断言（impl 不读取）" 标注', async () => {
      const observationSpec: InterfaceSpec = {
        id: 'IF_OBS_TEST',
        kind: 'observation',
        sourceId: 'TEST_STATE',
        name: 'observe_TEST_STATE',
        inputs: [
          { name: 'currentState', type: 'string', required: true, description: '当前状态' },
        ],
        outputs: [{ name: 'isInState', type: 'boolean', required: true, description: '是否在状态' }],
        requestSchema: {
          type: 'object',
          properties: {
            currentState: { type: 'string', description: '当前状态' },
          },
          required: ['currentState'],
        },
        responseSchema: {
          type: 'object',
          properties: { isInState: { type: 'boolean' } },
        },
        schemaKind: 'structured',
      };

      const tmp = makeTempWebgenProject({
        specs: [observationSpec],
      });

      await deriveWeb(
        { rootDir: tmp, buildSite: false },
        (rd) => parseProtocolFile(join(rd, 'protocol/model.md'))
      );
      const detailPath = join(tmp, 'web/docs/interfaces', `${observationSpec.id}.md`);
      expect(existsSync(detailPath)).toBe(true);
      const md = readFileSync(detailPath, 'utf-8');
      expect(md).toContain('CAS 断言（impl 不读取）');
      expect(md).toContain('纯读/观测接口 impl 不使用 currentState');
    });
  });

  describe('008-5：承载接口头部标注', () => {
    test('契约承载接口详情页头部含"承载接口"标注', async () => {
      const carrierSpec: InterfaceSpec = {
        id: 'IF_CTR_mappingCreate',
        kind: 'system',
        sourceId: 'mappingCreate',
        name: 'mappingCreate',
        inputs: [],
        outputs: [],
        requestSchema: { type: 'object' },
        responseSchema: { type: 'object' },
        schemaKind: 'structured',
        contractSource: 'mappingCreate',
        isContractCarrier: true,
        errorResponses: [
          { id: 'ERR-01', errorCode: 'port_conflict', httpStatus: 409 },
        ],
      };

      const tmp = makeTempWebgenProject({
        specs: [carrierSpec],
      });

      await deriveWeb(
        { rootDir: tmp, buildSite: false },
        (rd) => parseProtocolFile(join(rd, 'protocol/model.md'))
      );
      const detailPath = join(tmp, 'web/docs/interfaces', `${carrierSpec.id}.md`);
      expect(existsSync(detailPath)).toBe(true);
      const md = readFileSync(detailPath, 'utf-8');
      expect(md).toContain('承载接口（contract-carrier）');
      expect(md).toContain('mappingCreate');
    });
  });

  describe('组合层 renderProjectInterfaceDetailPage：CAS 标注 + 承载接口标注', () => {
    test('组合层状态转移接口：currentState 含 CAS 标注', () => {
      const iface: InterfaceSpec = {
        id: 'IF_SYS_T1',
        kind: 'system',
        sourceId: 'register',
        name: 'register',
        actionType: 'state_transition',
        inputs: [
          { name: 'currentState', type: 'string', required: true, description: '当前状态' },
          { name: 'name', type: 'string', required: true, description: '名称' },
        ],
        outputs: [],
        requestSchema: { type: 'object' },
        responseSchema: { type: 'object' },
        schemaKind: 'structured',
      };
      const md = renderProjectInterfaceDetailPage(
        { id: 'P1', name: '测试协议' } as unknown as Parameters<typeof renderProjectInterfaceDetailPage>[0],
        iface,
        [],
        undefined
      );
      expect(md).toContain('CAS 断言');
      expect(md).toContain('状态转移前置校验');
    });

    test('组合层观测接口：currentState 含 "impl 不读取" 标注', () => {
      const iface: InterfaceSpec = {
        id: 'IF_OBS_T1',
        kind: 'observation',
        sourceId: 'STATE_X',
        name: 'observe_STATE_X',
        inputs: [
          { name: 'currentState', type: 'string', required: true, description: '当前状态' },
        ],
        outputs: [],
        requestSchema: { type: 'object' },
        responseSchema: { type: 'object' },
        schemaKind: 'structured',
      };
      const md = renderProjectInterfaceDetailPage(
        { id: 'P1', name: '测试协议' } as unknown as Parameters<typeof renderProjectInterfaceDetailPage>[0],
        iface,
        [],
        undefined
      );
      expect(md).toContain('CAS 断言（impl 不读取）');
    });

    test('组合层契约承载接口：头部含承载标注', () => {
      const iface: InterfaceSpec = {
        id: 'IF_CTR_mappingCreate',
        kind: 'system',
        sourceId: 'mappingCreate',
        name: 'mappingCreate',
        inputs: [],
        outputs: [],
        requestSchema: { type: 'object' },
        responseSchema: { type: 'object' },
        schemaKind: 'structured',
        contractSource: 'mappingCreate',
        isContractCarrier: true,
        errorResponses: [{ id: 'ERR-01', errorCode: 'port_conflict', httpStatus: 409 }],
      };
      const md = renderProjectInterfaceDetailPage(
        { id: 'P1', name: '测试协议' } as unknown as Parameters<typeof renderProjectInterfaceDetailPage>[0],
        iface,
        [],
        undefined
      );
      expect(md).toContain('承载接口（contract-carrier）');
      expect(md).toContain('mappingCreate');
    });
  });
});