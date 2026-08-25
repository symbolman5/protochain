/**
 * viewer 浏览器端 parser 打包入口（W3-a / 05-execution-T1 TA2）
 *
 * 职责：
 * - 仅导出内容入口 `parseProtocolContent`（不依赖 node:fs 文件读取）；
 * - 导出 `PARSER_VERSION`（构建时由 esbuild --define 注入工具链版本号，
 *   用于"内嵌 parser vs 工具链 parser"版本漂移守卫，见 03-viewer.md 审阅 R3-2）；
 * - `node:fs` 经 esbuild alias 隔离为 stub（viewer/stubs/fs.js），parser 源码零改动。
 *
 * 打包命令：`npm run build:parser`（见 scripts/build-parser.mjs）。
 * 产物：viewer/assets/parser.js（IIFE + globalName=ProtochainParser，无框架、无运行时依赖）。
 * 浏览器加载后：`window.ProtochainParser.parseProtocolContent(content, name)`。
 */

import { parseProtocolContent } from '../src/parser/index.js';
import type { SourceProtocolModel } from '../src/model/types.js';

/** 构建时注入：工具链 package.json version（防内嵌 parser 版本漂移守卫） */
declare const __PARSER_VERSION__: string | undefined;

export const PARSER_VERSION: string =
  typeof __PARSER_VERSION__ !== 'undefined' ? __PARSER_VERSION__ : 'unknown';

export { parseProtocolContent };
export type { SourceProtocolModel };
