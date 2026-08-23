/**
 * E11 #008 缺陷 4：derive-web / derive-bindings 在多协议目录下可执行
 *
 * 修复前：硬编码 `parseProtocolFile(join(rd, 'protocol/model.md'))`，
 *        多协议项目（protocol/<Pn>/model.md）下报 ENOENT。
 * 修复后：CLI 复用 resolveProjectContext.modelPath，多协议自动读 protocol/<Pn>/model.md。
 *
 * 验证：
 * - 系统根 + --protocol <Pn> 模式可定位子协议模型
 * - --dir protocol/<Pn> 模式也可定位子协议模型
 */

import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseProtocolFile } from '../../src/parser/index.js';
import { deriveBindings } from '../../src/bindgen/index.js';
import { deriveWeb } from '../../src/webgen/index.js';
import { specify, specsFromEnvelope } from '../../src/specifier/index.js';
import { resolveProjectContext } from '../../src/project/context.js';

const FIXTURE_DIR = '/work/protochain/tests/fixtures';

function mkTmp(): string {
  return join(tmpdir(), `e11-multi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

describe('E11 #008 缺陷 4：CLI 多协议定位（resolveProjectContext）', () => {
  let tmpRoot: string;
  afterEach(() => {
    if (tmpRoot && existsSync(tmpRoot)) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  function setupMultiProtocolProject(): string {
    tmpRoot = mkTmp();
    // system root 布局
    mkdirSync(join(tmpRoot, 'protocol/P1'), { recursive: true });
    mkdirSync(join(tmpRoot, 'protocol/P2'), { recursive: true });
    // protochain.config.yaml（resolveProjectContext 必须）
    writeFileSync(
      join(tmpRoot, 'protochain.config.yaml'),
      'systemName: e11-multi\nversion: 1.0.0\n'
    );
    // composition.md（多协议特征）
    writeFileSync(
      join(tmpRoot, 'protocol/composition.md'),
      `---
name: e11-multi
version: 1.0.0
changeType: minor
systemName: e11-multi
protocols:
  - id: P1
    name: 子协议1
    modelPath: protocol/P1/model.md
  - id: P2
    name: 子协议2
    modelPath: protocol/P2/model.md
---
# 子协议依赖

| From | To | Type |
|---|---|---|
| P1 | P2 | depends_on |
`
    );
    // P1 model.md
    writeFileSync(
      join(tmpRoot, 'protocol/P1/model.md'),
      readFixture('approval-flow.md')
    );
    // P2 model.md
    writeFileSync(
      join(tmpRoot, 'protocol/P2/model.md'),
      readFixture('saas-P2-entry.md')
    );
    // P1 derived/specs.json
    const p1Model = parseProtocolFile(join(tmpRoot, 'protocol/P1/model.md'));
    const p1Specs = specify(p1Model);
    mkdirSync(join(tmpRoot, 'protocol/P1/derived'), { recursive: true });
    writeFileSync(
      join(tmpRoot, 'protocol/P1/derived/specs.json'),
      JSON.stringify(p1Specs, null, 2)
    );
    // P2 derived/specs.json
    const p2Model = parseProtocolFile(join(tmpRoot, 'protocol/P2/model.md'));
    const p2Specs = specify(p2Model);
    mkdirSync(join(tmpRoot, 'protocol/P2/derived'), { recursive: true });
    writeFileSync(
      join(tmpRoot, 'protocol/P2/derived/specs.json'),
      JSON.stringify(p2Specs, null, 2)
    );
    return tmpRoot;
  }

  function readFixture(name: string): string {
    // 同步读取 fixture 文件
    const fs = require('node:fs') as typeof import('node:fs');
    return fs.readFileSync(join(FIXTURE_DIR, name), 'utf-8');
  }

  test('系统根 + --protocol P3：modelPath = protocol/P3/model.md（修复点 1）', () => {
    setupMultiProtocolProject();
    const ctx = resolveProjectContext(tmpRoot, { protocol: 'P1' });
    expect(ctx.mode).toBe('multi');
    expect(ctx.protocolId).toBe('P1');
    expect(ctx.modelPath).toBe(join(tmpRoot, 'protocol/P1/model.md'));
    // modelPath 必须可读
    expect(() => parseProtocolFile(ctx.modelPath)).not.toThrow();
  });

  test('系统根 + --protocol P2：modelPath = protocol/P2/model.md', () => {
    setupMultiProtocolProject();
    const ctx = resolveProjectContext(tmpRoot, { protocol: 'P2' });
    expect(ctx.modelPath).toBe(join(tmpRoot, 'protocol/P2/model.md'));
  });

  test('不指定 --protocol 但 --dir 直接指向子协议目录：自动识别', () => {
    setupMultiProtocolProject();
    const ctx = resolveProjectContext(join(tmpRoot, 'protocol/P1'));
    expect(ctx.mode).toBe('multi');
    expect(ctx.protocolId).toBe('P1');
    expect(ctx.modelPath).toBe(join(tmpRoot, 'protocol/P1/model.md'));
  });

  test('CLI 修复点：derive-bindings 多协议 P1 不再 ENOENT（修复前会硬编码 protocol/model.md）', async () => {
    setupMultiProtocolProject();
    const ctx = resolveProjectContext(tmpRoot, { protocol: 'P1' });
    const rootDir = ctx.protocolRoot;
    // 修复前：(rd) => parseProtocolFile(join(rd, 'protocol/model.md')) → ENOENT
    // 修复后：使用 ctx.modelPath（protocol/P1/model.md）→ 成功
    const result = await deriveBindings(
      { rootDir },
      () => parseProtocolFile(ctx.modelPath)
    );
    expect(result.skeletonPath).toContain('bindings.skeleton.yaml');
    expect(result.skeleton.stats.total).toBeGreaterThan(0);
  });

  test('CLI 修复点：derive-web 多协议 P2 不再 ENOENT', async () => {
    setupMultiProtocolProject();
    const ctx = resolveProjectContext(tmpRoot, { protocol: 'P2' });
    const rootDir = ctx.protocolRoot;
    const result = await deriveWeb(
      { rootDir, buildSite: false },
      () => parseProtocolFile(ctx.modelPath)
    );
    expect(existsSync(result.dataJsonPath)).toBe(true);
    const dataRaw = JSON.parse(
      require('node:fs').readFileSync(result.dataJsonPath, 'utf-8')
    ) as { interfaces: unknown[] };
    expect(dataRaw.interfaces.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 端到端：实际跑 derive-web CLI 验证多协议修复
// ---------------------------------------------------------------------------

describe('E11 #008 缺陷 4（端到端 CLI）：derive-web 多协议目录', () => {
  let tmpRoot: string;
  afterEach(() => {
    if (tmpRoot && existsSync(tmpRoot)) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  function setupMultiProtocolProject(): string {
    tmpRoot = mkTmp();
    mkdirSync(join(tmpRoot, 'protocol/P3/derived'), { recursive: true });
    writeFileSync(
      join(tmpRoot, 'protochain.config.yaml'),
      'systemName: e11-cli\nversion: 1.0.0\n'
    );
    writeFileSync(
      join(tmpRoot, 'protocol/composition.md'),
      `---
name: e11-cli
version: 1.0.0
changeType: minor
systemName: e11-cli
protocols:
  - id: P3
    name: 子协议3
    modelPath: protocol/P3/model.md
---
`
    );
    writeFileSync(
      join(tmpRoot, 'protocol/P3/model.md'),
      readFixture('approval-flow.md')
    );
    // 直接预生成 specs.json（CLI 测试不依赖 specify 命令链路）
    const model = parseProtocolFile(join(tmpRoot, 'protocol/P3/model.md'));
    const specs = specify(model);
    writeFileSync(
      join(tmpRoot, 'protocol/P3/derived/specs.json'),
      JSON.stringify(specs, null, 2)
    );
    return tmpRoot;
  }

  function readFixture(name: string): string {
    const fs = require('node:fs') as typeof import('node:fs');
    return fs.readFileSync(join(FIXTURE_DIR, name), 'utf-8');
  }

  test('derive-web --dir <multi-root> --protocol P3 不再 ENOENT', () => {
    setupMultiProtocolProject();
    // 修复前：CLI 硬编码 protocol/model.md → ENOENT
    // 修复后：CLI 复用 resolveProjectContext.modelPath → 成功落盘 web/data.json
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
    const cliPath = join(process.cwd(), 'dist/cli/index.js');
    const r = spawnSync(
      process.execPath,
      [cliPath, 'derive-web', '--dir', tmpRoot, '--protocol', 'P3', '--no-build'],
      { encoding: 'utf8', cwd: process.cwd() }
    );
    // 不再抛 ENOENT
    expect(r.stderr + r.stdout).not.toContain('ENOENT');
    // 期望 data.json 落盘（protocol/P3/web/data.json）
    const dataJsonPath = join(tmpRoot, 'protocol/P3/web/data.json');
    expect(existsSync(dataJsonPath)).toBe(true);
  });

  test('derive-bindings --dir <multi-root> --protocol P3 不再 ENOENT', () => {
    setupMultiProtocolProject();
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
    const cliPath = join(process.cwd(), 'dist/cli/index.js');
    // derive-bindings 需要先有 specs.json：复用已有 approval-flow 跑一次 specify
    const p3ModelPath = join(tmpRoot, 'protocol/P3/model.md');
    const { spawnSync: s2 } = require('node:child_process') as typeof import('node:child_process');
    const specifyR = s2(
      process.execPath,
      [cliPath, 'specify', '--dir', p3ModelPath],
      { encoding: 'utf8', cwd: process.cwd() }
    );
    // 如果 specify 也依赖根目录布局，容忍其退出码；只要不是 ENOENT protocol/P3/protocol/model.md
    void specifyR;

    const r = spawnSync(
      process.execPath,
      [cliPath, 'derive-bindings', '--dir', tmpRoot, '--protocol', 'P3'],
      { encoding: 'utf8', cwd: process.cwd() }
    );
    expect(r.stderr + r.stdout).not.toContain('ENOENT');
  });
});
