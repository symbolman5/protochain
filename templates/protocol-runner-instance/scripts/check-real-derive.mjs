// D 验收：orchestrator-state 中 check 已通过 + derived/specs.json 存在 + formal-report（TLC）passed
// check 断言为双保险：防止 check 失败被 formal-report 旧值掩盖（问题清单 #11）。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const MODELING = process.env.MODELING_DIR;
if (!MODELING || MODELING.includes("{{")) { console.error("MODELING_DIR 占位符未替换"); process.exit(1); }

// 1. orchestrator-state：check 步骤必须已执行且通过
const stateFile = join(MODELING, "protocol", "P1", "derived", "orchestrator-state.yaml");
if (!existsSync(stateFile)) {
  console.error(`orchestrator-state 缺失: ${stateFile}`); process.exit(1);
}
const stateRaw = readFileSync(stateFile, "utf8");
const checkBlock = stateRaw.match(/^  check:\n([\s\S]*?)(?=^  [a-zA-Z_]+:|^[a-zA-Z_]+:)/m);
if (!checkBlock || !/passed: true/.test(checkBlock[1])) {
  console.error("orchestrator-state 中 check 步骤未通过（check 失败未传导会被此处拦截）"); process.exit(1);
}

// 2. derived/specs.json 存在
if (!existsSync(join(MODELING, "protocol", "P1", "derived", "specs.json"))) {
  console.error("derived/specs.json 缺失"); process.exit(1);
}

// 3. formal-report（TLC）passed
const report = join(MODELING, "protocol", "P1", "derived", "formal", "formal-report.json");
if (!existsSync(report)) { console.error("formal-report 缺失"); process.exit(1); }
const doc = JSON.parse(readFileSync(report, "utf8"));
if (doc.toolExecuted !== true || doc.passed !== true) {
  console.error(`formalize（TLC）未通过: passed=${doc.passed}`); process.exit(1);
}
console.log("check-real-derive 通过");
