// I 验收：实现目录感知——未配置/不存在时建模阶段跳过；存在则要求构建通过
import { existsSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
const IMPL = process.env.IMPL_DIR;
if (!IMPL || IMPL.includes("{{") || !existsSync(IMPL)) {
  console.log("check-real-impl：实现目录未就绪（建模阶段，跳过真实构建）");
  process.exit(0);
}
if (!existsSync(`${IMPL}/go.mod`)) {
  console.log("check-real-impl：实现目录存在但无 go.mod（按项目语言适配构建命令）");
  process.exit(0);
}
try {
  execSync(`cd ${IMPL} && go build ./... && go vet ./...`, { stdio: "inherit", timeout: 120000 });
} catch {
  console.error("check-real-impl 失败：go build/vet 未通过"); process.exit(1);
}
// 实现规范机械检查（MySQL 命名等；脚本随模板提供）
if (existsSync("scripts/check-mysql-naming.mjs")) {
  const naming = spawnSync("node", ["scripts/check-mysql-naming.mjs"], { stdio: "inherit" });
  if (naming.status !== 0) {
    console.error("check-real-impl 失败：MySQL 命名规范检查未通过"); process.exit(1);
  }
}
console.log("check-real-impl 通过");
