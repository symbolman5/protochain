import { existsSync } from "node:fs";
if (!existsSync("env/dev.env")) { console.error("环境声明缺失: env/dev.env"); process.exit(1); }
if (!process.env.PROTOCHAIN || process.env.PROTOCHAIN.includes("{{")) {
  console.log("final env check 通过（PROTOCHAIN 未覆盖，使用 PATH 中的 protochain）");
} else if (!existsSync(process.env.PROTOCHAIN)) {
  console.error("protochain 不可达"); process.exit(1);
}
console.log("final env check 通过");
