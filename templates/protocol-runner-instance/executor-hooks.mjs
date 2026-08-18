// 实例层执行器注册（适配 harness v0.5，hsk-ng 通用化）：
// 1) llm：包装 driver: protochain / driver: dsh —— 把 ExecutionResult 账本落盘
//    artifacts/derive/<unit>-ledger.json（观测），并把 modeling 子任务产物 settle 成
//    artifacts/derive/{specs,test-cases,formalize}.json（保持下游 b-bind/i-impl 契约，仅观测不参与 acceptance 判定）；
// 2) human：真实人工终审——有已确认（resolved + humanAnswers）的 escalation 才写 release 产物。
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { llmFactory } from "/work/protocol-runner/executors/llm/index.ts";

function writeJson(projectDir, rel, data) {
  const abs = join(projectDir, rel);
  mkdirSync(join(projectDir, rel.split("/").slice(0, -1).join("/")), { recursive: true });
  writeFileSync(abs, JSON.stringify(data, null, 2) + "\n");
}

/** 从 modeling 子任务产物汇总 settle 到 runner artifacts（模板默认单协议 P1，多协议在 protocols 配置扩展） */
function settleDerive(pkg, ctx, protocols) {
  const env = pkg.context?.staticEnv?.resolvedVars ?? {};
  const modeling = env.MODELING_DIR;
  if (!modeling || modeling.includes("{{")) return;
  const version = pkg.version;
  const specs = { version, protocols: {} };
  const testCases = { version, protocols: {} };
  let formalPassed = true;
  let formalSeen = false;
  for (const p of protocols) {
    const derived = join(modeling, "protocol", p, "derived");
    const specPath = join(derived, "specs.json");
    let specCount = 0;
    if (existsSync(specPath)) {
      try {
        const arr = JSON.parse(readFileSync(specPath, "utf8"));
        specCount = Array.isArray(arr) ? arr.length : 0;
      } catch {
        specCount = 0;
      }
    }
    specs.protocols[p] = { specs: specCount };

    const casesPath = join(derived, "test-cases.json");
    if (existsSync(casesPath)) {
      try {
        const doc = JSON.parse(readFileSync(casesPath, "utf8"));
        testCases.protocols[p] = {
          paths: Array.isArray(doc.paths) ? doc.paths.length : 0,
          ...(doc.coverage?.stateCoverage
            ? { coverage: { covered: doc.coverage.stateCoverage.covered, total: doc.coverage.stateCoverage.total } }
            : {}),
        };
      } catch {
        testCases.protocols[p] = { paths: 0 };
      }
    } else {
      testCases.protocols[p] = { paths: 0 };
    }

    const reportPath = join(derived, "formal", "formal-report.json");
    if (existsSync(reportPath)) {
      formalSeen = true;
      try {
        const doc = JSON.parse(readFileSync(reportPath, "utf8"));
        if (!(doc.toolExecuted === true && doc.passed === true)) formalPassed = false;
      } catch {
        formalPassed = false;
      }
    }
  }
  writeJson(ctx.projectDir, "artifacts/derive/specs.json", specs);
  writeJson(ctx.projectDir, "artifacts/derive/test-cases.json", testCases);
  writeJson(ctx.projectDir, "artifacts/derive/formalize.json", {
    version,
    passed: formalPassed,
    reportsSeen: formalSeen,
    note: "formalize 强闸门：由 exec-task 重新生成，check-real-derive 校验报告存在且 toolExecuted=true && passed=true",
  });
}

function wrapLedger(pkg, ctx, result, driverName) {
  writeJson(ctx.projectDir, `artifacts/derive/${pkg.unitId}-ledger.json`, {
    taskId: pkg.taskId,
    unitId: pkg.unitId,
    projectId: pkg.projectId,
    version: pkg.version,
    driver: driverName,
    result,
  });
  writeJson(ctx.projectDir, "artifacts/derive/latest-ledger.json", {
    taskId: pkg.taskId,
    unitId: pkg.unitId,
    driver: driverName,
    at: new Date().toISOString(),
  });
}

function loadEscalations(projectDir) {
  const dir = join(projectDir, "state", "escalations");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => { try { return JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { return null; } })
    .filter(Boolean);
}

export function register(registry) {
  registry.register("llm", (config = {}) => {
    const inner = llmFactory(config);
    const driverName = config.driver;
    if (driverName !== "protochain" && driverName !== "dsh") return inner;
    return {
      kind: "llm",
      async execute(pkg, ctx) {
        const result = await inner.execute(pkg, ctx);
        wrapLedger(pkg, ctx, result, driverName);
        if (driverName === "protochain") {
          const protocols = Array.isArray(config.protocols) && config.protocols.length > 0
            ? config.protocols
            : ["P1"];
          settleDerive(pkg, ctx, protocols);
        }
        return result;
      },
    };
  });

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
