// MySQL 命名规范机械检查（I 单元验收的一部分）。
// 规范与 ../impl/CONVENTIONS.md 一致：表名 snake_case；索引前缀 uk_/idx_；charset=utf8mb4。
// impl 或 schema 文件不存在时跳过（建模阶段/未配置规范）。
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const implDir = resolve(process.cwd(), "..", "impl");
const conventions = join(implDir, "CONVENTIONS.md");
if (!existsSync(conventions)) {
  console.log("check-mysql-naming：impl/CONVENTIONS.md 不存在，跳过（规范未配置）");
  process.exit(0);
}

const files = [];
function walk(dir) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!["node_modules", ".git"].includes(e.name)) walk(p);
    } else if (/\.(sql|go)$/.test(e.name)) {
      files.push(p);
    }
  }
}
walk(implDir);
if (files.length === 0) {
  console.log("check-mysql-naming：未发现 schema 文件，跳过");
  process.exit(0);
}

// .go 文件只取字符串字面量（反引号原始串 / 双引号串），排除注释与普通代码；
// .sql 文件取全文。随后只在 CREATE TABLE 块内查表名/索引子句/字符集。
function extractSqlText(f, text) {
  if (!f.endsWith(".go")) return text;
  const parts = [];
  for (const m of text.matchAll(/`[^`]*`|"(?:\\.|[^"\\])*"/g)) parts.push(m[0]);
  return parts.join("\n");
}

const issues = [];
for (const f of files) {
  const raw = readFileSync(f, "utf8");
  const sqlText = extractSqlText(f, raw);
  const tableBlocks = sqlText.matchAll(/CREATE TABLE[\s\S]*?(?:;|$)/gi);
  const createIndexStmts = sqlText.matchAll(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+([`"\w]+)/gi);
  for (const m of createIndexStmts) {
    const idx = m[1].replace(/[`"]/g, "");
    const prefix = /UNIQUE/i.test(m[0]) ? "uk_" : "idx_";
    if (!idx.startsWith(prefix)) issues.push(`${f}: 索引 ${idx} 应以 ${prefix} 前缀命名`);
  }
  for (const block of tableBlocks) {
    const tbl = block[0].match(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?([`"\w]+)/i);
    if (!tbl) continue;
    const name = tbl[1].replace(/[`"]/g, "");
    if (!/^[a-z][a-z0-9_]*$/.test(name)) issues.push(`${f}: 表名非 snake_case: ${name}`);
    if (!/utf8mb4/i.test(block[0])) issues.push(`${f}: CREATE TABLE ${name} 缺少 charset=utf8mb4`);
    for (const im of block[0].matchAll(/\b(UNIQUE KEY|KEY)\s+([`"\w]+)/gi)) {
      const idx = im[2].replace(/[`"]/g, "");
      const prefix = im[1].startsWith("UNIQUE") ? "uk_" : "idx_";
      if (!idx.startsWith(prefix)) issues.push(`${f}: 索引 ${idx} 应以 ${prefix} 前缀命名`);
    }
  }
}
if (issues.length > 0) {
  console.error("check-mysql-naming 未通过：");
  for (const i of issues) console.error("  -", i);
  process.exit(1);
}
console.log("check-mysql-naming 通过");
