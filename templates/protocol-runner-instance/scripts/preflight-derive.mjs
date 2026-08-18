// preflight-derive：D 单元幂等/只读预检（P2 bridge 注入 loop 时由模型调用；
// 权威判定仍是 m→d 交接 acceptance 的 check-real-derive）。
// 检查项：MODELING_DIR 占位符已替换 + protochain 配置存在 + 至少一个协议 model.md 存在。
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const projectDir = process.cwd();
const envFile = join(projectDir, "env", "dev.env");
const env = {};
if (existsSync(envFile)) {
  for (const raw of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    env[m[1]] = (m[2] ?? "").replace(/^['"]|['"]$/g, "");
  }
}
const modeling = process.env.MODELING_DIR ?? env.MODELING_DIR ?? "";

const problems = [];
if (!modeling || modeling.includes("{{")) {
  problems.push("MODELING_DIR 占位符未替换（env/dev.env）");
}
if (modeling && !modeling.includes("{{")) {
  const root = resolve(projectDir, modeling);
  if (!existsSync(join(root, "protochain.config.yaml"))) {
    problems.push(`缺少 ${join(modeling, "protochain.config.yaml")}（先跑 init-modeling 或手工初始化建模目录）`);
  }
  if (!existsSync(join(root, "protocol", "P1", "model.md"))) {
    problems.push(`缺少 ${join(modeling, "protocol", "P1", "model.md")}`);
  }
}

if (problems.length > 0) {
  console.error(`preflight-derive 未通过:\n${problems.map((p) => `- ${p}`).join("\n")}`);
  process.exit(1);
}
console.log("preflight-derive 通过：MODELING_DIR 就绪，protochain 配置与模型存在");
