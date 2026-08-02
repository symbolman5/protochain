import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parseProtocolContent } from '../../src/parser/index.js';
import { specify } from '../../src/specifier/index.js';
import { checkImplementation, formatImplCheckSummary } from '../../src/implcheck/index.js';

const FIXTURES = join(process.cwd(), 'tests/fixtures');
function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf-8');
}

function makeTempDir(): string {
  const dir = join(tmpdir(), `protochain-implcheck-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('implcheck', () => {
  describe('接口存在性检查', () => {
    const model = parseProtocolContent(readFixture('approval-flow.md'));
    const specs = specify(model);

    test('无任何实现时所有接口缺失', () => {
      const rootDir = makeTempDir();
      try {
        const report = checkImplementation(specs, rootDir);
        expect(report.passed).toBe(false);
        expect(report.interfaceChecks.length).toBe(specs.length);
        expect(report.interfaceChecks.every((c) => !c.found)).toBe(true);
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    });

    test('interfaces.d.ts 中存在接口声明时识别为已实现', () => {
      const rootDir = makeTempDir();
      try {
        // 生成 interfaces.d.ts
        mkdirSync(join(rootDir, 'impl-scaffold'), { recursive: true });
        const scaffoldContent = `export interface Submit { (...): void; }
export interface Approve { (...): void; }
export interface Reject { (...): void; }
export interface Withdraw { (...): void; }
export interface TimeoutReturn { (...): void; }

export interface ProtocolImplementation {
  submit: Submit;
  approve: Approve;
  reject: Reject;
  withdraw: Withdraw;
  timeout_return: TimeoutReturn;
}`;
        writeFileSync(join(rootDir, 'impl-scaffold/interfaces.d.ts'), scaffoldContent, 'utf-8');

        const report = checkImplementation(specs, rootDir);
        // 系统接口应被识别
        const systemChecks = report.interfaceChecks.filter((c) =>
          specs.find((s) => s.id === c.interfaceId)?.kind === 'system'
        );
        expect(systemChecks.every((c) => c.found)).toBe(true);
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    });

    test('src/ 下源文件中的实现被识别', () => {
      const rootDir = makeTempDir();
      try {
        mkdirSync(join(rootDir, 'src'), { recursive: true });
        const srcContent = `export const submit = (state) => ({ nextState: 'S2' });
export function approve(state) { return { nextState: 'S3' }; }
export async function reject(state) { return { nextState: 'S4' }; }
const withdraw = (s) => ({ nextState: 'S5' });
const timeout_return = (s) => ({ nextState: 'S1' });`;
        writeFileSync(join(rootDir, 'src/impl.ts'), srcContent, 'utf-8');

        const report = checkImplementation(specs, rootDir);
        const systemChecks = report.interfaceChecks.filter((c) =>
          specs.find((s) => s.id === c.interfaceId)?.kind === 'system'
        );
        // 所有系统接口应被识别
        expect(systemChecks.every((c) => c.found)).toBe(true);
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    });

    test('部分接口缺失时报告未通过', () => {
      const rootDir = makeTempDir();
      try {
        mkdirSync(join(rootDir, 'src'), { recursive: true });
        const srcContent = `export const submit = () => {};`;
        writeFileSync(join(rootDir, 'src/impl.ts'), srcContent, 'utf-8');

        const report = checkImplementation(specs, rootDir);
        expect(report.passed).toBe(false);
        const missing = report.interfaceChecks.filter((c) => !c.found);
        expect(missing.length).toBeGreaterThan(0);
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    });
  });

  describe('扫描行为', () => {
    test('跳过 node_modules 目录', () => {
      const rootDir = makeTempDir();
      try {
        mkdirSync(join(rootDir, 'src/node_modules'), { recursive: true });
        const content = `export const submit = () => {};`;
        writeFileSync(join(rootDir, 'src/node_modules/impl.ts'), content, 'utf-8');
        writeFileSync(join(rootDir, 'src/real.ts'), `export const submit = () => {};`, 'utf-8');

        const model = parseProtocolContent(readFixture('approval-flow.md'));
        const specs = specify(model);
        const report = checkImplementation(specs, rootDir);
        // submit 在 src/real.ts 中找到
        const submitCheck = report.interfaceChecks.find((c) => c.interfaceName === 'submit');
        expect(submitCheck?.found).toBe(true);
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    });

    test('跳过 derived/test-tool 自动生成代码', () => {
      const rootDir = makeTempDir();
      try {
        mkdirSync(join(rootDir, 'derived/test-tool'), { recursive: true });
        const content = `export const submit = () => {};`;
        writeFileSync(join(rootDir, 'derived/test-tool/generated.ts'), content, 'utf-8');

        const model = parseProtocolContent(readFixture('approval-flow.md'));
        const specs = specify(model);
        // sourceDirs 默认为 ['src', 'impl']，不含 derived/
        const report = checkImplementation(specs, rootDir);
        // submit 在 derived/test-tool 中，应不被扫描
        const submitCheck = report.interfaceChecks.find((c) => c.interfaceName === 'submit');
        expect(submitCheck?.found).toBe(false);
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    });

    test('支持自定义扩展名', () => {
      const rootDir = makeTempDir();
      try {
        mkdirSync(join(rootDir, 'src'), { recursive: true });
        writeFileSync(join(rootDir, 'src/impl.py'), `def submit(state): pass`, 'utf-8');

        const model = parseProtocolContent(readFixture('approval-flow.md'));
        const specs = specify(model);
        const report = checkImplementation(specs, rootDir, {
          extensions: ['.py'],
        });
        const submitCheck = report.interfaceChecks.find((c) => c.interfaceName === 'submit');
        expect(submitCheck?.found).toBe(true);
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    });
  });

  describe('报告摘要', () => {
    test('格式化摘要包含通过/缺失计数', () => {
      const rootDir = makeTempDir();
      try {
        const model = parseProtocolContent(readFixture('approval-flow.md'));
        const specs = specify(model);
        const report = checkImplementation(specs, rootDir);
        const summary = formatImplCheckSummary(report);
        expect(summary).toContain('实现完整性检查');
        expect(summary).toContain('检查接口数');
        expect(summary).toContain('通过');
        expect(summary).toContain('缺失');
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    });

    test('缺失接口在摘要中列出', () => {
      const rootDir = makeTempDir();
      try {
        const model = parseProtocolContent(readFixture('approval-flow.md'));
        const specs = specify(model);
        const report = checkImplementation(specs, rootDir);
        const summary = formatImplCheckSummary(report);
        expect(summary).toContain('缺失接口');
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    });
  });

  describe('检查时间戳', () => {
    test('记录检查时间', () => {
      const rootDir = makeTempDir();
      try {
        const model = parseProtocolContent(readFixture('approval-flow.md'));
        const specs = specify(model);
        const report = checkImplementation(specs, rootDir);
        expect(report.checkedAt).toBeTruthy();
        expect(report.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    });
  });
});
