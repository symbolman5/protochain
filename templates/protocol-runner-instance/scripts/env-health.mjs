// 环境前提：MODELING_DIR 必须替换；NODE/PROTOCHAIN 缺省用 PATH（存在性校验）
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
const modeling = process.env.MODELING_DIR;
if (!modeling || modeling.includes("{{")) { console.error("MODELING_DIR 占位符未替换"); process.exit(1); }
if (!existsSync(modeling)) { console.error(`MODELING_DIR 不存在: ${modeling}`); process.exit(1); }
for (const [name, val] of [["NODE", process.env.NODE], ["PROTOCHAIN", process.env.PROTOCHAIN]]) {
  if (val && !val.includes("{{")) {
    if (val.includes("/")) { if (!existsSync(val)) { console.error(`${name} 路径不存在: ${val}`); process.exit(1); } }
    else { try { execSync(`which ${val}`, { stdio: "ignore" }); } catch { console.error(`${name} 不在 PATH: ${val}`); process.exit(1); } }
  }
}
console.log("env-health 通过");
