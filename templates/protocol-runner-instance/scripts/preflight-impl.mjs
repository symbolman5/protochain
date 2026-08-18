// preflight-impl：I 单元幂等/只读预检（P2 bridge 注入 loop 时由模型调用；
// 权威判定仍是 b→i / d→i 交接 acceptance 的 check-real-impl）。
// 检查项：specs.json 与 bindings.json 已存在且带 version 字段。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const projectDir = process.cwd();
const problems = [];

function checkJson(rel, mustKeys) {
  const abs = join(projectDir, rel);
  if (!existsSync(abs)) {
    problems.push(`缺少 ${rel}`);
    return;
  }
  try {
    const doc = JSON.parse(readFileSync(abs, "utf8"));
    for (const key of mustKeys) {
      if (doc[key] === undefined) problems.push(`${rel} 缺少字段 ${key}`);
    }
  } catch {
    problems.push(`${rel} 不是合法 JSON`);
  }
}

checkJson("artifacts/derive/specs.json", ["version", "protocols"]);
checkJson("artifacts/bind/bindings.json", ["version", "bindings"]);

if (problems.length > 0) {
  console.error(`preflight-impl 未通过:\n${problems.map((p) => `- ${p}`).join("\n")}`);
  process.exit(1);
}
console.log("preflight-impl 通过：specs/bindings 就绪");
