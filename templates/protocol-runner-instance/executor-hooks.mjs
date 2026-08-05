// 实例层执行器注册：真实 human 执行器——有已确认（resolved + humanAnswers）的 escalation 才写 release 产物，
// 否则返回 aborted（等待人工终审）。
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function loadEscalations(projectDir) {
  const dir = join(projectDir, "state", "escalations");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => { try { return JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { return null; } })
    .filter(Boolean);
}

export function register(registry) {
  registry.register("human", (config = {}) => ({
    kind: "human",
    async execute(pkg, ctx) {
      const confirmed = loadEscalations(ctx.projectDir).find(
        (e) => e.from === pkg.unitId && e.status === "resolved" && e.humanAnswers,
      );
      if (!confirmed) {
        return {
          status: "aborted",
          reason: "等待人工终审：请用 --resolve-escalation 三问确认后重跑",
        };
      }
      const version = JSON.parse(readFileSync(join(ctx.projectDir, "state", "state.json"), "utf8")).version;
      const artifact = (config?.stub?.artifacts ?? [])[0]?.path ?? "artifacts/release/release.json";
      mkdirSync(join(ctx.projectDir, artifact.replace(/\/[^/]+$/, "")), { recursive: true });
      writeFileSync(
        join(ctx.projectDir, artifact),
        JSON.stringify(
          { version, released: true, decidedBy: confirmed.humanAnswers.decidedBy, decidedAt: confirmed.humanAnswers.decidedAt },
          null, 2,
        ) + "\n",
      );
      return { status: "completed", artifacts: [{ path: artifact }], summary: `人工终审确认（${confirmed.humanAnswers.decidedBy}）` };
    },
  }));
}
