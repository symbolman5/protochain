// B 验收：protochain.config.yaml 存在且含 bindings
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const MODELING = process.env.MODELING_DIR;
if (!MODELING || MODELING.includes("{{")) { console.error("MODELING_DIR 占位符未替换"); process.exit(1); }
const cfg = join(MODELING, "protochain.config.yaml");
if (!existsSync(cfg)) { console.error("protochain.config.yaml 缺失"); process.exit(1); }
const text = readFileSync(cfg, "utf8");
if (!/^bindings:/m.test(text)) { console.error("bindings 段缺失"); process.exit(1); }
console.log("check-real-bind 通过");
