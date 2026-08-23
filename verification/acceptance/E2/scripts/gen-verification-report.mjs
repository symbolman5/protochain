#!/usr/bin/env node
/**
 * E2 verify 字段级偏差演示脚本（dist 版）：使用已编译的 dist/cli
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

process.chdir('/work/protochain');

const { parseProtocolContent } = await import('/work/protochain/dist/parser/index.js');
const { specify, specsFromEnvelope } = await import('/work/protochain/dist/specifier/index.js');
const { generateCases } = await import('/work/protochain/dist/casegen/index.js');
const { verify } = await import('/work/protochain/dist/verifier/index.js');

const MODEL = parseProtocolContent(`---
name: 字段级验证示例
version: 1.0.0
purpose: E2 字段级偏差演示
roles:
  - id: user
    name: 用户
---
# 状态空间
| ID | 名称 | 类型 |
|---|---|---|
| S1 | 初态 | initial |
| S2 | 终态 | terminal |

# 转移规则
| ID | 名称 | from | to | action | trigger |
|---|---|---|---|---|---|
| T1 | 走 | S1 | S2 | go | user |
`);

const binding = {
  roles: { R: { roleId: 'R', baseUrl: 'http://mock.local/api', auth: 'none' } },
  interfaces: [
    { action: 'go', roleId: 'R', transport: { type: 'http', method: 'POST', path: '/go', params: [] } },
  ],
};

const transport = async () =>
  ({ status: 200, data: { nextState: 'S2', approverId: 'bob', decision: 'rejected' }, ok: true });

const specs = specsFromEnvelope(specify(MODEL));
for (const s of specs) {
  if (s.name === 'go') {
    s.outputs.push({ name: 'approverId', type: 'string', description: '审批人 ID', required: true });
    s.outputs.push({ name: 'decision', type: 'string', description: '审批结果' });
    s.responseSchema = {
      type: 'object',
      properties: {
        nextState: { type: 'string', enum: ['S1', 'S2', '-'] },
        approverId: { type: 'string', description: '审批人 ID' },
        decision: { type: 'string', description: '审批结果' },
      },
      required: ['nextState', 'approverId'],
      additionalProperties: true,
    };
  }
}

const ctx = {
  rootDir: '.',
  specs,
  bindings: binding,
  transportExecutor: transport,
  enableFieldLevelCompare: true,
  legacyExpectedResponses: {
    go: { approverId: 'alice', decision: 'approved' },
  },
  testCases: generateCases(MODEL, { criterion: 'state' }),
};
const report = await verify(MODEL, ctx);

const outDir = '/work/protochain/verification/acceptance/E2';
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, 'verification-report-sample.json');
writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf-8');
console.log('已写入:', outPath);
const flat = report.authoritative.caseResults.flatMap((c) => c.deviations ?? []);
const fieldDevs = flat.filter((d) => d.kind === 'field_mismatch');
console.log('field_mismatch 偏差数:', fieldDevs.length);
for (const d of fieldDevs) {
  console.log(`  - 字段 ${d.field}: legacy=${d.legacy}, impl=${d.impl}`);
}
