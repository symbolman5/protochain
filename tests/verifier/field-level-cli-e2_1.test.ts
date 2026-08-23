/**
 * E2.1 verify 字段级对比接通（CLI 路径）
 *
 * 设计依据：IMPLEMENTATION-PLAN.md §E2.1
 *
 * 验证：构造一个含契约层的协议 + 一个返回字段类型不符的 transport executor，
 * 跑 verify 端到端，确认 deviation 含「字段 X：legacy=Y, impl=Z」。
 */

import { parseProtocolContent } from '../../src/parser/index.js';
import { specify, specsFromEnvelope } from '../../src/specifier/index.js';
import { generateCases } from '../../src/casegen/index.js';
import { verify, type VerifyContext } from '../../src/verifier/index.js';
import type { ScenarioParamSource, TransportExecutorFn } from '../../src/verifier/binding-runner.js';
import type { BindingConfig, InterfaceSpec, SourceProtocolModel } from '../../src/model/types.js';
import type { TransportResult } from '../../src/transport/types.js';

function makeTransport(
  handlers: Record<string, (params: Record<string, unknown>) => TransportResult>
): TransportExecutorFn {
  return async (resolved, params) => {
    if (!resolved?.binding) {
      return { status: 404, data: { error: '接口未绑定' }, ok: false };
    }
    const handler = handlers[resolved.spec.name];
    if (!handler) {
      return {
        status: 404,
        data: { error: `未找到 ${resolved.spec.name} 的 mock` },
        ok: false,
      };
    }
    return handler(params);
  };
}

function ok(data: unknown, status = 200): TransportResult {
  return { status, data, ok: status >= 200 && status < 300 };
}

const MODEL_TEXT =
  '---\n' +
  'name: E2.1 字段级 CLI\n' +
  'version: 1.0.0\n' +
  'purpose: E2.1 端到端字段级偏差对比\n' +
  'roles:\n' +
  '  - id: admin\n' +
  '    name: 管理员\n' +
  '---\n' +
  '\n' +
  '# 状态空间\n' +
  '\n' +
  '| ID | 名称 | 类型 |\n' +
  '|---|---|---|\n' +
  '| S1 | 初始 | initial |\n' +
  '| S2 | 终态 | terminal |\n' +
  '\n' +
  '# 转移规则\n' +
  '\n' +
  '| ID | 名称 | from | to | action | trigger | guard |\n' +
  '|---|---|---|---|---|---|---|\n' +
  '| T1 | 注册 | S1 | S2 | register | admin | |\n' +
  '\n' +
  '# 契约层\n' +
  '\n' +
  '```yaml\n' +
  'parties:\n' +
  '  - admin\n' +
  'contracts:\n' +
  '  - interface: register\n' +
  '    requestSchema:\n' +
  '      type: object\n' +
  '      properties:\n' +
  '        currentState:\n' +
  '          type: string\n' +
  '        name:\n' +
  '          type: string\n' +
  '      required:\n' +
  '        - currentState\n' +
  '        - name\n' +
  '    responseSchema:\n' +
  '      type: object\n' +
  '      properties:\n' +
  '        serverId:\n' +
  '          type: string\n' +
  '        port:\n' +
  '          type: integer\n' +
  '      required:\n' +
  '        - serverId\n' +
  '```\n';

describe('verifier - E2.1 字段级 CLI 端到端', () => {
  test('verify 端到端：字段类型不符 → 偏差含 legacy=<type>, impl=<type>', async () => {
    const model: SourceProtocolModel = parseProtocolContent(MODEL_TEXT, 'e2_1.md');
    const specs: InterfaceSpec[] = specsFromEnvelope(specify(model));
    const testCases = generateCases(model);

    // 构造 bindings：仅 register 一个接口
    const bindings: BindingConfig = {
      roles: {
        admin: { roleId: 'admin', baseUrl: 'http://localhost', auth: 'none' },
      },
      interfaces: [
        {
          action: 'register',
          roleId: 'admin',
          transport: {
            type: 'http',
            method: 'POST',
            path: '/v1/register',
            params: [],
          },
        },
      ],
    };

    // 构造 transport executor：返回字段类型不符的响应
    const transport = makeTransport({
      register: () =>
        ok({
          nextState: 'S2',
          serverId: 'srv-1',
          port: 'should-be-integer', // 类型不符
        }),
    });

    const scenarios: ScenarioParamSource[] = [];

    const ctx: VerifyContext = {
      rootDir: '/tmp/e2_1-cli',
      testCases,
      specs,
      bindings,
      protocolId: undefined,
      transportExecutor: transport,
      enableFieldLevelCompare: true,
      legacyExpectedResponses: {
        register: {
          // 契约层 type 名作为 sentinel
          serverId: 'string',
          port: 'integer',
        },
      },
      scenarios,
    };

    const report = await verify(model, ctx);
    // 至少有一条 field_mismatch
    const allDevs: Array<{ field: string; legacy?: string; impl?: string; kind: string }> = [];
    for (const cr of report.authoritative.caseResults) {
      for (const d of cr.deviations ?? []) {
        allDevs.push({ field: d.field ?? '', legacy: d.legacy, impl: d.impl, kind: d.kind });
      }
    }
    const portDev = allDevs.find((d) => d.field === 'response.port');
    expect(portDev).toBeDefined();
    expect(portDev!.legacy).toBe('integer');
    expect(portDev!.impl).toBe('string');
    expect(portDev!.kind).toBe('field_mismatch');
  });

  test('verify 端到端：所有字段类型正确 → 无 field_mismatch', async () => {
    const model = parseProtocolContent(MODEL_TEXT, 'e2_1.md');
    const specs = specsFromEnvelope(specify(model));
    const testCases = generateCases(model);

    const bindings: BindingConfig = {
      roles: {
        admin: { roleId: 'admin', baseUrl: 'http://localhost', auth: 'none' },
      },
      interfaces: [
        {
          action: 'register',
          roleId: 'admin',
          transport: {
            type: 'http',
            method: 'POST',
            path: '/v1/register',
            params: [],
          },
        },
      ],
    };

    const transport = makeTransport({
      register: () =>
        ok({
          nextState: 'S2',
          serverId: 'srv-1',
          port: 8080, // 类型正确
        }),
    });

    const ctx: VerifyContext = {
      rootDir: '/tmp/e2_1-cli-ok',
      testCases,
      specs,
      bindings,
      transportExecutor: transport,
      enableFieldLevelCompare: true,
      legacyExpectedResponses: {
        register: {
          serverId: 'string',
          port: 'integer',
        },
      },
    };

    const report = await verify(model, ctx);
    const fieldDevs = report.authoritative.caseResults
      .flatMap((cr) => cr.deviations ?? [])
      .filter((d) => d.kind === 'field_mismatch' && d.field?.startsWith('response.'));
    expect(fieldDevs).toHaveLength(0);
  });
});
