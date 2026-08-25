/**
 * W3-a parser 浏览器打包脚本（05-execution-T1 TA2）
 *
 * esbuild 单命令打包：
 * - 入口 viewer/parser-entry.ts（仅内容入口 parseProtocolContent）
 * - platform=browser + IIFE（无 Node 环境可加载；纯本地 File API 可用）
 * - node:fs alias → viewer/stubs/fs.js（parseProtocolFile 在浏览器不可用即抛错）
 * - PARSER_VERSION 由 --define 注入工具链 package.json version（防版本漂移守卫）
 *
 * 产物：viewer/assets/parser.js
 * 运行：npm run build:parser
 */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));

await build({
  entryPoints: [join(root, 'viewer/parser-entry.ts')],
  bundle: true,
  format: 'iife',
  globalName: 'ProtochainParser',
  platform: 'browser',
  target: ['es2020'],
  outfile: join(root, 'viewer/assets/parser.js'),
  alias: {
    'node:fs': join(root, 'viewer/stubs/fs.js'),
  },
  define: {
    __PARSER_VERSION__: JSON.stringify(pkg.version),
  },
  logLevel: 'info',
});

console.log(`[build:parser] viewer/assets/parser.js 生成完成（PARSER_VERSION=${pkg.version}）`);
