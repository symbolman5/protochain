// D 验收：derived/specs.json 存在 + formal-report（TLC）passed
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const MODELING = process.env.MODELING_DIR;
if (!MODELING || MODELING.includes("{{")) { console.error("MODELING_DIR 占位符未替换"); process.exit(1); }
if (!existsSync(join(MODELING, "protocol", "P1", "derived", "specs.json"))) {
  console.error("derived/specs.json 缺失"); process.exit(1);
}
const report = join(MODELING, "protocol", "P1", "derived", "formal", "formal-report.json");
if (!existsSync(report)) { console.error("formal-report 缺失"); process.exit(1); }
const doc = JSON.parse(readFileSync(report, "utf8"));
if (doc.toolExecuted !== true || doc.passed !== true) {
  console.error(`formalize（TLC）未通过: passed=${doc.passed}`); process.exit(1);
}
console.log("check-real-derive 通过");
