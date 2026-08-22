/**
 * 测试辅助：将 markdown 内容写到 <root>/<rel> 路径
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export function writeProtocolContent(
  rootDir: string,
  relativePath: string,
  content: string
): string {
  const fullPath = join(rootDir, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, 'utf-8');
  return fullPath;
}
