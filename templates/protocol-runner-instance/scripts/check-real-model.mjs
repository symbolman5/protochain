// M 验收：model.md 存在 + 版本与项目版本一致
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const MODELING = process.env.MODELING_DIR;
if (!MODELING || MODELING.includes("{{")) { console.error("MODELING_DIR 占位符未替换"); process.exit(1); }
const expected = JSON.parse(readFileSync("state/state.json", "utf8")).version;
const model = join(MODELING, "protocol", "P1", "model.md");
if (!existsSync(model)) { console.error(`model.md 缺失: ${model}`); process.exit(1); }
const m = readFileSync(model, "utf8").match(/^version:\s*([0-9]+\.[0-9]+\.[0-9]+)/m);
if (!m || m[1] !== expected) { console.error(`模型版本 ${m?.[1]} != ${expected}`); process.exit(1); }
console.log("check-real-model 通过");
