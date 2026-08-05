// V 单元机械化产出：有建模参考实现（src/server.js）→ 真实 verify；无 → 建模-only 跳过并记录。
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nodeBin, protoBin } from "./lib-tools.mjs";
const MODELING = process.env.MODELING_DIR;
const NODE = nodeBin();
const PROTO = protoBin();
const version = JSON.parse(readFileSync("state/state.json", "utf8")).version;
mkdirSync("artifacts/verify", { recursive: true });

if (!MODELING || MODELING.includes("{{")) { console.error("MODELING_DIR 占位符未替换"); process.exit(1); }
if (!existsSync(join(MODELING, "src", "server.js"))) {
  writeFileSync("artifacts/verify/verification.json",
    JSON.stringify({ version, ok: true, mode: "modeling-only", note: "无建模参考实现，verify 由 D 的 formalize/TLC 闸门兜底" }, null, 2) + "\n");
  console.log("produce-verify：建模-only 模式（无参考实现，跳过真实 verify）");
  process.exit(0);
}
const server = spawn(NODE, ["src/server.js"], { cwd: MODELING, env: process.env, stdio: "ignore" });
let code = 1;
try {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch("http://127.0.0.1:8787/v1/health"); if (r.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  const v = spawnSync(NODE, [PROTO, "verify", "--protocol", "P1"], {
    cwd: MODELING, env: process.env, stdio: "inherit", timeout: 300000,
  });
  code = v.status ?? 1;
} finally { server.kill("SIGTERM"); }
const report = join(MODELING, "protocol", "P1", "derived", "verification", "verification-report.json");
let ok = false;
if (existsSync(report)) {
  const doc = JSON.parse(readFileSync(report, "utf8"));
  ok = doc.authoritative?.passed === true && code === 0;
}
writeFileSync("artifacts/verify/verification.json", JSON.stringify({ version, ok }, null, 2) + "\n");
if (!ok) { console.error("真实 verify 未通过"); process.exit(1); }
console.log("produce-verify 通过");
