// M 单元机械化步骤（首个需求自举）：初始化建模目录结构 + 初始 model.md 骨架 + protochain 配置。
// 若 modeling/protocol 已存在则跳过（幂等）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { need } from "./lib-tools.mjs";
const MODELING = need("MODELING_DIR");
const version = JSON.parse(readFileSync("state/state.json", "utf8")).version;

if (!existsSync(join(MODELING, "protocol", "P1", "model.md"))) {
  mkdirSync(join(MODELING, "protocol", "P1", "scenarios"), { recursive: true });
  mkdirSync(join(MODELING, "protocol", "P1", "versions"), { recursive: true });
  writeFileSync(
    join(MODELING, "protocol", "P1", "model.md"),
    [
      "---",
      `name: "{{PROTOCOL_NAME}}"`,
      `version: ${version}`,
      "purpose: 待第一个需求填写",
      "roles: []",
      "---",
      "",
      "# 活性语义声明（协议正式定义）",
      "",
      "- 活性标准 = 弱活性（终态可达性）：无死锁 + 每个非终态存在有限路径到达终态；",
      "- 不采用全路径强活性（实体可长期停留非终态，属合法业务）。",
      "",
      "# 状态空间",
      "",
      "| ID | 名称 | 类型 | 描述 | 角色 |",
      "|---|---|---|---|---|",
      "| S0 | 初始 | initial | 待定义 | |",
      "| S1 | 活跃 | normal | 待定义 | |",
      "| S2 | 终态 | terminal | 待定义 | |",
      "",
      "# 转移规则",
      "",
      "| ID | 名称 | from | to | action | trigger | guard | effects |",
      "|---|---|---|---|---|---|---|---|",
      "",
      "# 不变量",
      "",
      "| ID | 名称 | 表达式 | 作用状态 | 描述 |",
      "|---|---|---|---|---|",
      "",
      "# 时序约束",
      "",
      "# 异常路径",
      "",
      "---",
      "> 初始骨架：由模板 init-modeling 生成，首个需求按实际协议填写。",
    ].join("\n") + "\n",
  );
  writeFileSync(
    join(MODELING, "protocol", "P1", "scenarios", ".gitkeep"),
    "# 场景文件目录（verify 输入）\n",
  );
  // 最小 protochain 配置（bindings 占位；AI key 由使用者填写）
  writeFileSync(
    join(MODELING, "protochain.config.yaml"),
    [
      'name: "{{PROJECT_NAME}}"',
      "ai:",
      "  provider: deepseek",
      '  apiKey: "{{API_KEY}}"   # TODO: 填写',
      "  model: deepseek-v4-flash",
      "  baseUrl: https://api.deepseek.com",
      "formalTool: tla",
      "coverage:",
      "  criterion: state",
      "  maxPathLength: 10",
      "bindings:",
      "  defaultEnv: dev",
      "  roles:",
      "    R-Op: { roleId: R-Op, baseUrl: http://127.0.0.1:8787, auth: bearer }",
      "  interfaces: []",
    ].join("\n") + "\n",
  );
  console.log(`init-modeling：已创建 ${MODELING}/protocol/P1/ 与 protochain.config.yaml`);
} else {
  console.log("init-modeling：建模目录已存在，跳过");
}

mkdirSync("artifacts/model", { recursive: true });
writeFileSync(
  "artifacts/model/model.json",
  JSON.stringify({ version, model: { status: "init" } }, null, 2) + "\n",
);
