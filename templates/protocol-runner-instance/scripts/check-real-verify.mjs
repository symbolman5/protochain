// V 验收：有 verify 报告则要求 passed；建模-only（无报告）跳过
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const MODELING = process.env.MODELING_DIR;
if (!MODELING || MODELING.includes("{{")) { console.error("MODELING_DIR 占位符未替换"); process.exit(1); }
const report = join(MODELING, "protocol", "P1", "derived", "verification", "verification-report.json");
if (!existsSync(report)) { console.log("check-real-verify：无 verify 报告（建模-only）"); process.exit(0); }
const doc = JSON.parse(readFileSync(report, "utf8"));
if (doc.authoritative?.passed !== true) { console.error("verify 报告未通过"); process.exit(1); }
console.log("check-real-verify 通过");
