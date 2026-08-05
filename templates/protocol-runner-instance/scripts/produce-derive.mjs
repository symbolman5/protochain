// D 单元机械化产出：运行 protochain 推演链（check → … → generate-cases，含 formalize/TLC），
// 写 derive 占位产物 + formalize 结果书签；formalize 未通过则退出非 0。
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { need, nodeBin, protoBin } from "./lib-tools.mjs";
const MODELING = need("MODELING_DIR");
const NODE = nodeBin();
const PROTO = protoBin();

let exitCode = 0;
try {
  execSync(`${NODE} ${PROTO} run --protocol P1 --from check --to generate-cases -y`, {
    cwd: MODELING,
    stdio: "inherit",
    env: process.env,
    timeout: 600000,
  });
} catch (e) {
  exitCode = e.status ?? 1;
  console.error(`protochain 推演失败（exit ${exitCode}）`);
}

const version = JSON.parse(readFileSync("state/state.json", "utf8")).version;
mkdirSync("artifacts/derive", { recursive: true });
writeFileSync("artifacts/derive/specs.json", JSON.stringify({ version, specs: [] }, null, 2) + "\n");
writeFileSync("artifacts/derive/test-cases.json", JSON.stringify({ version, cases: [] }, null, 2) + "\n");

const reportPath = join(MODELING, "protocol", "P1", "derived", "formal", "formal-report.json");
let passed = false;
if (existsSync(reportPath)) {
  try {
    const doc = JSON.parse(readFileSync(reportPath, "utf8"));
    passed = doc.toolExecuted === true && doc.passed === true;
  } catch {
    passed = false;
  }
}
writeFileSync(
  "artifacts/derive/formalize.json",
  JSON.stringify({ version, exitCode, passed }, null, 2) + "\n",
);
if (!passed) {
  console.error("formalize（TLC）未通过：模型结构或守卫翻译存在缺陷");
  process.exit(exitCode || 1);
}
console.log("produce-derive 通过：protochain 推演 + TLC 全绿");
