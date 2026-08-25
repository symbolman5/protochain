/**
 * W3-a parser 浏览器打包（05-execution-T1 TA2）验收测试
 *
 * 机械判据（05-execution-T1.md §TA2）：
 * ① bundle 在无 Node 环境（vm 沙箱，无 process/require）加载成功；
 * ② 解析 fixture model.md 得到的 IR 状态数/转移数与 Node 侧 parseProtocolFile 一致；
 * ③ bundle 暴露的 PARSER_VERSION 等于 package.json version。
 *
 * 前置：先运行 `npm run build:parser`（生成 viewer/assets/parser.js）。
 * 本测试不改 parser 源码（N3：零代码改动，仅打包配置）。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { parseProtocolFile } from '../../src/parser/index.js';

// jest 运行时 cwd 为项目根（与 jest.config.js 对齐）
const ROOT = process.cwd();
const BUNDLE_PATH = join(ROOT, 'viewer', 'assets', 'parser.js');
const MODEL_PATH = join(ROOT, 'viewer', 'samples', 'food-delivery.model.md');

function loadBundle(): Record<string, unknown> {
  if (!existsSync(BUNDLE_PATH)) {
    throw new Error(
      'viewer/assets/parser.js 不存在——请先运行 `npm run build:parser`（TA2 打包脚本）'
    );
  }
  const code = readFileSync(BUNDLE_PATH, 'utf-8');
  // 无 Node 环境模拟：context 只注入 console，无 process/require/Buffer
  const ctx: Record<string, unknown> = { console };
  createContext(ctx);
  runInContext(code, ctx);
  const p = ctx.ProtochainParser as Record<string, unknown> | undefined;
  if (!p) {
    throw new Error('bundle 未暴露全局 ProtochainParser（esbuild globalName 未生效）');
  }
  return p;
}

describe('parser 浏览器 bundle（W3-a / TA2）', () => {
  test('① 无 Node 环境加载成功：bundle 暴露 ProtochainParser.parseProtocolContent', () => {
    const p = loadBundle();
    expect(typeof p.parseProtocolContent).toBe('function');
  });

  test('③ PARSER_VERSION 等于 package.json version（防内嵌 parser 漂移守卫）', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
    const p = loadBundle();
    expect(p.PARSER_VERSION).toBe(pkg.version);
    expect(pkg.version).toBeTruthy();
  });

  test('② 解析 fixture model.md 的 IR 与 Node 侧一致（8 状态 / 11 转移）', () => {
    const p = loadBundle();
    const content = readFileSync(MODEL_PATH, 'utf-8');
    const browserIr = p.parseProtocolContent(content, 'food-delivery.model.md') as {
      metadata: { version: string };
      derivable: { states: unknown[]; transitions: unknown[] };
    };
    const nodeIr = parseProtocolFile(MODEL_PATH);
    expect(browserIr.derivable.states.length).toBe(nodeIr.derivable.states.length);
    expect(browserIr.derivable.transitions.length).toBe(nodeIr.derivable.transitions.length);
    expect(browserIr.derivable.states.length).toBe(8);
    expect(browserIr.derivable.transitions.length).toBe(11);
    expect(browserIr.metadata.version).toBe(nodeIr.metadata.version);
    expect(browserIr.metadata.version).toBe('1.0.0');
  });

  test('②（续）状态 ID 与转移 ID 序列与 Node 侧完全一致', () => {
    const p = loadBundle();
    const content = readFileSync(MODEL_PATH, 'utf-8');
    const browserIr = p.parseProtocolContent(content, 'food-delivery.model.md') as {
      derivable: { states: Array<{ id: string }>; transitions: Array<{ id: string }> };
    };
    const nodeIr = parseProtocolFile(MODEL_PATH);
    expect(browserIr.derivable.states.map((s) => s.id)).toEqual(
      nodeIr.derivable.states.map((s) => s.id)
    );
    expect(browserIr.derivable.transitions.map((t) => t.id)).toEqual(
      nodeIr.derivable.transitions.map((t) => t.id)
    );
  });

  test('bundle 不携带 node:fs 真实实现（readFileSync 为 stub 抛错）', () => {
    const p = loadBundle();
    const parseProtocolFileInBundle = p.parseProtocolFile as (() => void) | undefined;
    // parseProtocolFile 未从 bundle 导出（入口仅内容函数）；若存在则调用应抛"浏览器不可用"
    if (parseProtocolFileInBundle) {
      expect(() => parseProtocolFileInBundle()).toThrow(/浏览器环境不可用/);
    } else {
      expect(parseProtocolFileInBundle).toBeUndefined();
    }
  });
});
