import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { initRunnerProject } from '../../src/scaffolder/index.js';

const protocols = (): Array<{ protocolId: string; name: string }> => [
  { protocolId: 'P1', name: '网关协议' },
  { protocolId: 'P2', name: '账户协议' },
];

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(yaml|yml|mjs|md|json|env|txt)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

describe('initRunnerProject', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'protochain-runner-'));
  });

  test('生成建模骨架（modeling/）+ 编排实例（protocol-runner/）', () => {
    const r = initRunnerProject({ systemName: 'MySys', rootDir: tmpDir, protocols: protocols() });

    // 建模骨架（initMultiProject 复用）
    expect(existsSync(join(tmpDir, 'modeling/protocol/P1/model.md'))).toBe(true);
    expect(existsSync(join(tmpDir, 'modeling/protocol/P2/model.md'))).toBe(true);
    expect(existsSync(join(tmpDir, 'modeling/protocol/composition.md'))).toBe(true);
    expect(existsSync(join(tmpDir, 'modeling/protochain.config.yaml'))).toBe(true);

    // 编排实例
    expect(existsSync(join(tmpDir, 'protocol-runner/project.yaml'))).toBe(true);
    for (const f of ['m-model', 'd-derive', 'b-bind', 'i-impl', 'v-verify', 'r-release']) {
      expect(existsSync(join(tmpDir, `protocol-runner/checklists/${f}.md`))).toBe(true);
    }
    for (const f of ['init-modeling.mjs', 'produce-derive.mjs', 'check-real-model.mjs', 'produce-verify.mjs', 'lib-tools.mjs']) {
      expect(existsSync(join(tmpDir, `protocol-runner/scripts/${f}`))).toBe(true);
    }
    expect(existsSync(join(tmpDir, 'protocol-runner/env/dev.env'))).toBe(true);
    expect(existsSync(join(tmpDir, 'protocol-runner/executor-hooks.mjs'))).toBe(true);

    expect(r.modeling.createdFiles).toContain('protocol/P1/model.md');
  });

  test('占位符替换：项目名/建模目录/实现目录，无关键占位符残留', () => {
    initRunnerProject({ systemName: 'MySys', rootDir: tmpDir, protocols: protocols() });

    const pj = readFileSync(join(tmpDir, 'protocol-runner/project.yaml'), 'utf8');
    expect(pj).toContain('id: "MySys"');
    expect(pj).not.toContain('{{PROJECT_NAME}}');
    expect(pj).not.toContain('{{MODELING_DIR}}');

    const env = readFileSync(join(tmpDir, 'protocol-runner/env/dev.env'), 'utf8');
    expect(env).toContain('MODELING_DIR=../modeling');
    expect(env).toContain('IMPL_DIR=../impl');
    expect(env).not.toContain('{{');
  });

  test('生成的实例可移植：不含任何工具链源码路径（/work/protocoldriven、/work/protocol-runner）', () => {
    initRunnerProject({ systemName: 'MySys', rootDir: tmpDir, protocols: protocols() });
    for (const f of walk(join(tmpDir, 'protocol-runner'))) {
      const text = readFileSync(f, 'utf8');
      expect(text).not.toMatch(/\/work\/(protocoldriven|protocol-runner)/);
    }
  });

  test('实例自带手册文档（README：实例化步骤 + 运行方式）', () => {
    initRunnerProject({ systemName: 'MySys', rootDir: tmpDir, protocols: protocols() });
    const readme = readFileSync(join(tmpDir, 'protocol-runner/README.md'), 'utf8');
    expect(readme).toContain('实例化步骤');
    expect(readme).toContain('运行');
    expect(readme).toContain('protocol-runner');
  });

  test('生成的 protochain.config.yaml 含 bindings（实例 check-real-bind 依赖）', () => {
    initRunnerProject({ systemName: 'MySys', rootDir: tmpDir, protocols: protocols() });
    const cfg = readFileSync(join(tmpDir, 'modeling/protochain.config.yaml'), 'utf8');
    expect(cfg).toMatch(/^bindings:/m);
    expect(cfg).toMatch(/interfaces:/m);
  });

  test('实例目录已存在且未指定 force 时抛错', () => {
    initRunnerProject({ systemName: 'MySys', rootDir: tmpDir, protocols: protocols() });
    expect(() =>
      initRunnerProject({ systemName: 'MySys', rootDir: tmpDir, protocols: protocols() })
    ).toThrow(/实例目录已存在/);
  });

  test('生成工程资产：docs/architecture.md 与 impl/CONVENTIONS.md（实例引用，不属于实例层）', () => {
    initRunnerProject({ systemName: 'MySys', rootDir: tmpDir, protocols: protocols() });
    const arch = readFileSync(join(tmpDir, 'docs/architecture.md'), 'utf8');
    expect(arch).toContain('## 技术栈');
    expect(arch).toContain('## 部署拓扑');
    const conv = readFileSync(join(tmpDir, 'impl/CONVENTIONS.md'), 'utf8');
    expect(conv).toContain('MySQL 命名规范');
    expect(conv).toContain('snake_case');
    // 规范文件在工程根/impl，不在实例目录内
    expect(existsSync(join(tmpDir, 'protocol-runner/CONVENTIONS.md'))).toBe(false);
  });

  test('实例 I 清单含 read-conventions 与 check-naming 步骤，模板含 check-mysql-naming 脚本', () => {
    initRunnerProject({ systemName: 'MySys', rootDir: tmpDir, protocols: protocols() });
    const checklist = readFileSync(join(tmpDir, 'protocol-runner/checklists/i-impl.md'), 'utf8');
    expect(checklist).toContain('read-conventions');
    expect(checklist).toContain('check-naming');
    expect(checklist).toContain('check-mysql-naming.mjs');
    expect(existsSync(join(tmpDir, 'protocol-runner/scripts/check-mysql-naming.mjs'))).toBe(true);
  });

  test('check-mysql-naming 功能：好 schema 通过、坏 schema（含 CREATE INDEX 前缀）拒绝', () => {
    initRunnerProject({ systemName: 'MySys', rootDir: tmpDir, protocols: protocols() });
    const implDir = join(tmpDir, 'impl');
    mkdirSync(join(implDir, 'schema'), { recursive: true });
    writeFileSync(
      join(implDir, 'CONVENTIONS.md'),
      ['# 实现规范', '', '- 表名 snake_case', '- 索引前缀 uk_/idx_', '- charset utf8mb4', ''].join('\n'),
    );
    const script = join(tmpDir, 'protocol-runner/scripts/check-mysql-naming.mjs');
    const run = (sql: string) =>
      spawnSync('node', [script], { cwd: join(tmpDir, 'protocol-runner'), input: undefined });
    const good = ['CREATE TABLE user_accounts (', '  id BIGINT PRIMARY KEY,', '  account_no VARCHAR(64) UNIQUE',
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;', 'CREATE INDEX idx_account_no ON user_accounts (account_no);', ''].join('\n');
    writeFileSync(join(implDir, 'schema.sql'), good);
    expect(run(good).status).toBe(0);
    const bad = ['CREATE TABLE UserAccounts (', '  id BIGINT PRIMARY KEY,', '  account_no VARCHAR(64) UNIQUE',
      ') ENGINE=InnoDB DEFAULT CHARSET=latin1;', 'CREATE INDEX uniq_accounts ON UserAccounts (account_no);', ''].join('\n');
    writeFileSync(join(implDir, 'schema.sql'), bad);
    const badRun = run(bad);
    expect(badRun.status).toBe(1);
    expect(badRun.stderr.toString()).toContain('uniq_accounts');
  });

  test('D 脚本含失败传导逻辑：produce-derive 失败即退出、check-real-derive 断言 check 通过（#11）', () => {
    initRunnerProject({ systemName: 'MySys', rootDir: tmpDir, protocols: protocols() });
    const produce = readFileSync(join(tmpDir, 'protocol-runner/scripts/produce-derive.mjs'), 'utf8');
    // protochain 推演失败（如 check 未通过）→ 立即退出，不再写"伪成功"产物
    expect(produce).toContain('process.exit(code)');
    expect(produce).not.toContain('exitCode');

    const accept = readFileSync(join(tmpDir, 'protocol-runner/scripts/check-real-derive.mjs'), 'utf8');
    // 验收双保险：断言 orchestrator-state 中 check 步骤已通过
    expect(accept).toContain('orchestrator-state');
    expect(accept).toContain('check 步骤未通过');
  });

  test('生成项目根需求变更单 requirements/order.md（第一个需求输入落点）', () => {
    initRunnerProject({ systemName: 'MySys', rootDir: tmpDir, protocols: protocols() });
    const order = readFileSync(join(tmpDir, 'requirements/order.md'), 'utf8');
    expect(order).toContain('变更单（需求输入）');
    expect(order).toContain('## 目标');
    expect(order).toContain('## 验收');
  });

  test('生成项目根 .env（PROTOCOL_RUNNER 等启动工具环境）', () => {
    initRunnerProject({ systemName: 'MySys', rootDir: tmpDir, protocols: protocols() });
    const env = readFileSync(join(tmpDir, '.env'), 'utf8');
    expect(env).toContain('PROTOCOL_RUNNER=protocol-runner');
    expect(env).toContain('NODE=');
    expect(env).toContain('PROTOCHAIN=');
  });

  test('自定义目录：--modeling-dir/--instance-dir 生效', () => {
    initRunnerProject({
      systemName: 'MySys',
      rootDir: tmpDir,
      protocols: protocols(),
      modelingDir: 'spec',
      implDir: 'src',
      instanceDir: 'flow',
    });
    expect(existsSync(join(tmpDir, 'spec/protocol/P1/model.md'))).toBe(true);
    expect(existsSync(join(tmpDir, 'flow/project.yaml'))).toBe(true);
    const env = readFileSync(join(tmpDir, 'flow/env/dev.env'), 'utf8');
    expect(env).toContain('MODELING_DIR=../spec');
    expect(env).toContain('IMPL_DIR=../src');
  });
});
