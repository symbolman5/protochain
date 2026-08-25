/**
 * 浏览器端 node:fs stub（W3-a / TA2 打包隔离）
 *
 * parser 源码零改动：`parseProtocolFile`（读文件入口）在浏览器不可用，
 * 因此 `node:fs.readFileSync` 以本 stub 替换——调用即抛错（不静默）。
 * `parseProtocolContent`（内容入口）不依赖文件读取，可正常在浏览器使用。
 */

export function readFileSync() {
  throw new Error(
    'node:fs 在浏览器环境不可用：请使用 parseProtocolContent 内容入口（viewer 通过 File API 读取 model.md）'
  );
}
