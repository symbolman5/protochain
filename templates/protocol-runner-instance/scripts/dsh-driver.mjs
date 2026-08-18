// DSH 子任务启动器（适配 protocol-runner dsh.ts 契约，P1/P2，hsk-ng 通用化）：
// - 消费 dsh.ts 注入的 PROTOCOL_RUNNER_DSH_* 环境变量（task/prompt/protocol/result/bridge url+token）；
// - 把 protocol.json 的静态插件树映射为 DSH 侧工具面（filesystem→read/write/edit/grep/glob，shell→bash）；
// - 注入 capabilities/active/plugins/dsh-protocol-runner/index.mjs 插件：
//   写域校验 + protocol_runner_finish 账本 + protocol_runner_preflight（bridge 可用时）；
// - 写域强约束仍由 protocol-runner 侧 runSandboxed 快照兜底（越界即失败）。
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

function argAfter(flag) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : null;
}

const dangerFullAccess = process.argv.includes("--danger-full-access");

// dsh.ts 注入的环境（缺省回退 argv，兼容手工调用）
const taskFile = process.env.PROTOCOL_RUNNER_DSH_TASK_FILE ?? argAfter("--task") ?? process.argv[2] ?? "";
const promptFile = process.env.PROTOCOL_RUNNER_DSH_PROMPT_FILE ?? argAfter("--prompt") ?? process.argv[3] ?? "";
const protocolFile = process.env.PROTOCOL_RUNNER_DSH_PROTOCOL_FILE ?? argAfter("--protocol") ?? process.argv[4] ?? "";
const resultFile = process.env.PROTOCOL_RUNNER_DSH_RESULT_FILE ?? argAfter("--result") ?? process.argv[5] ?? "";

if (!taskFile || !promptFile || !resultFile) {
  console.error("dsh-driver：缺少 task/prompt/result（经 dsh.ts 的 PROTOCOL_RUNNER_DSH_* 注入）");
  process.exit(2);
}

const instanceDir = process.cwd();
const dshSourceDir = resolve(process.env.DSH_SOURCE_DIR ?? "/work/deepseek-harness");
const dshHome = resolve(process.env.DSH_HOME ?? join(instanceDir, "state/.dsh"));
const task = JSON.parse(readFileSync(taskFile, "utf8"));

// 插件树（dsh.ts 静态推导）→ DSH 工具面映射
const pluginTree = protocolFile && existsSync(protocolFile)
  ? JSON.parse(readFileSync(protocolFile, "utf8"))
  : null;
const TOOL_MAP = {
  filesystem: ["read", "write", "edit", "grep", "glob"],
  shell: ["bash"],
  protocol_runner_finish: ["protocol_runner_finish"],
  protocol_runner_preflight: ["protocol_runner_preflight"],
};
const allowed = new Set();
for (const tool of pluginTree?.tools?.allow ?? ["filesystem", "shell", "protocol_runner_finish"]) {
  for (const mapped of TOOL_MAP[tool] ?? [tool]) allowed.add(mapped);
}

// protocol-runner DSH 插件注入（账本 + 写域 + preflight）
const prPluginFile = resolve(instanceDir, "capabilities/active/plugins/dsh-protocol-runner/index.mjs");
if (!existsSync(prPluginFile)) {
  console.error(`protocol-runner DSH 插件缺失: ${prPluginFile}`);
  process.exit(2);
}
const patchFile = join(instanceDir, "state/dsh-protocol-runner.patch.yml");
mkdirSync(join(instanceDir, "state"), { recursive: true });
writeFileSync(
  patchFile,
  [
    "- insert:",
    "    - id: template-dsh-protocol-runner",
    `      name: file://${prPluginFile}`,
    "",
  ].join("\n"),
);

// dsh.env：provider/key/model 等 DSH 运行凭据（dsh.ts 只注入 PROTOCOL_RUNNER_DSH_* 契约变量，
// 真实 API 凭据不进 runner 静态环境）
function parseEnvFile(file) {
  const out = {};
  if (!existsSync(file)) return out;
  const text = readFileSync(file, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const value = m[2] ?? "";
    out[m[1]] = value.replace(/^['"]|['"]$/g, "");
  }
  return out;
}
const dshEnvFile = process.env.DSH_ENV_FILE
  ? resolve(instanceDir, process.env.DSH_ENV_FILE)
  : resolve(instanceDir, "env/dsh.env");

const childEnv = {
  ...process.env,
  DSH_SOURCE_DIR: dshSourceDir,
  DSH_HOME: dshHome,
  DSH_TASK_FILE: taskFile,
  DSH_PROMPT_FILE: promptFile,
  DSH_UNIT_ID: task.unitId ?? "",
  DSH_STAGE_ID: task.stageId ?? "",
  DSH_EXECUTOR_KIND: task.executorKind ?? "llm",
  DSH_RESULT_FILE: resultFile,
  DSH_ALLOWED_TOOLS: [...allowed].join(","),
  ...(dangerFullAccess ? { DSH_PERMISSION_MODE: "danger-full-access" } : {}),
  ...parseEnvFile(dshEnvFile),
  // preflight bridge（dsh.ts P2 注入；插件据此暴露 protocol_runner_preflight 工具）
  ...(process.env.PROTOCOL_RUNNER_DSH_BRIDGE_URL
    ? {
        DSH_PREFLIGHT_BRIDGE_URL: process.env.PROTOCOL_RUNNER_DSH_BRIDGE_URL,
        DSH_PREFLIGHT_BRIDGE_TOKEN: process.env.PROTOCOL_RUNNER_DSH_BRIDGE_TOKEN ?? "",
      }
    : {}),
};

const dshBin = resolve(dshSourceDir, "apps/cli/lib/bin.js");
if (!existsSync(dshBin)) {
  console.error(`DSH 运行时缺失: ${dshBin}（DSH_SOURCE_DIR 指向 deepseek-harness 源码）`);
  process.exit(2);
}
const prompt = readFileSync(promptFile, "utf8");
const args = [dshBin, "--profile", "headless", "--patch", patchFile];

const child = spawn(process.env.DSH_NODE ?? "node", [...args, prompt], {
  cwd: instanceDir,
  env: childEnv,
  stdio: ["ignore", "inherit", "inherit"],
});

function collectTrace(code, signal) {
  try {
    const traceDir = join(instanceDir, "state/executor-traces", task.taskId ?? task.unitId ?? "unknown");
    mkdirSync(traceDir, { recursive: true });
    const sessions = existsSync(join(dshHome, "sessions"))
      ? readdirSync(join(dshHome, "sessions"))
          .filter((n) => n.startsWith("session") && n.endsWith(".zstd"))
          .sort((a, b) => statSync(join(dshHome, "sessions", b)).mtimeMs - statSync(join(dshHome, "sessions", a)).mtimeMs)
      : [];
    if (sessions[0]) {
      copyFileSync(join(dshHome, "sessions", sessions[0]), join(traceDir, "session.jsonl.zstd"));
    }
    const result = existsSync(resultFile)
      ? JSON.parse(readFileSync(resultFile, "utf8"))
      : null;
    writeFileSync(
      join(traceDir, "summary.json"),
      JSON.stringify(
        { taskId: task.taskId ?? null, unitId: task.unitId ?? null, exitCode: code, signal, result },
        null,
        2,
      ) + "\n",
    );
  } catch {
    // 追踪失败不阻断退出码
  }
}

child.on("exit", (code, signal) => {
  collectTrace(code, signal);
  if (signal) {
    console.error(`dsh 被信号终止: ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
child.on("error", (error) => {
  console.error(`dsh 启动失败: ${error.message}`);
  process.exit(1);
});
