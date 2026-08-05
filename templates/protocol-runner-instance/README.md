# template-protocol-modeling（协议建模驱动开发 · 可移植启动模板）

> protocol-runner 实例模板：给「协议建模驱动开发」项目用的**可移植**起始目录。
> 结构：M 模型 / D 推导 / B 绑定 / I 实现 / V 验证 / R 收尾 + formalize（TLC）闸门 + 真实 verify + 人工终审。
> 工具链均为**编译产物/外部工具**：protochain 走 PATH（或 `{{PROTOCHAIN}}` 覆盖），protocol-runner 用 `dist/runner.js` 或 `protocol-runner` bin——**不依赖任何工具链源码**。

## 前置依赖（只装工具，不看源码）

| 依赖 | 说明 | 提供方式 |
|---|---|---|
| Node.js ≥ 24 | 运行脚本与 runner | 系统或 fnm/nvm |
| protochain 工具链 | 协议建模 CLI | 加入 PATH（或 `{{PROTOCHAIN}}` 覆盖）；用法 `protochain --help` |
| TLC（可选，formalize 权威闸门） | TLA+ 模型检查 | 在生成的 `protochain.config.yaml` 配置 `tlc.*` |
| protocol-runner（编译版） | 协作编排引擎 | `npm run build` 生成 `dist/runner.js`；或 `npm link` 后使用 `protocol-runner` bin |

> 模板脚本默认执行 `node` / `protochain`（PATH）；需指定时在 `env/dev.env` 设 `NODE=` / `PROTOCHAIN=` 覆盖。
> 运行模板用 **protocol-runner 编译版**：`node <dist>/runner.js` 或 `protocol-runner`。

## 实例化步骤

1. **复制模板**到新项目（或编译版 scaffold）：
   ```bash
   node <protocol-runner-dist>/runner.js --scaffold <项目名> --from projects/template-protocol-modeling
   # 或直接 cp -r 模板到项目内
   ```
2. **替换占位符**（`env/dev.env` 与 `project.yaml` 中的 `{{...}}`）：

| 占位符 | 含义 | 示例 |
|---|---|---|
| `{{PROJECT_NAME}}` | 项目 id/名称 | my-service |
| `{{MODELING_DIR}}` | 协议建模目录（由 init-modeling 创建；可相对） | /work/my-service/modeling 或 ../modeling |
| `{{IMPL_DIR}}` | 实现目录（可后置；可相对，可留空） | /work/my-service/impl 或 ../impl |
| `{{API_KEY}}` | protochain AI key（写入生成的 modeling/protochain.config.yaml） | sk-xxx |

> **路径约定**：`MODELING_DIR`/`IMPL_DIR` 支持相对路径，相对**实例目录**（即 env/ 的上级、projectDir）解析——
> 例如 `MODELING_DIR=../modeling` 表示"实例目录的上一级/modeling"。脚本与断言均以 projectDir 为 cwd，故相对路径一致生效。
>
> **最小配置**：首轮（建模自举）只需 `MODELING_DIR`。接入真实 verify（参考实现/部署目标）时再按需在 `env/dev.env` 添加
> `PORT`、`VERIFY_TARGET`、`ADMIN_TOKEN`/`PORTAL_TOKEN`/`INSTANCE_TOKEN`；多环境（k8s/staging）同理按需添加。

3. **配置 protochain**：首个需求由 `init-modeling` 生成 `modeling/protochain.config.yaml` 骨架——填入 AI key、TLC 路径、bindings。

## 输入第一个需求

1. 编辑工程根的 **`requirements/order.md`**（init-runner 生成）：填写 目标 / 范围 / 验收 / 涉及协议；
2. `source .env && "$PROTOCOL_RUNNER" --project protocol-runner/`；
3. M 单元按变更单写模型（当前默认 stub 时由人工/外部 agent 按单填写 model.md；切 harness 后由外部 agent 读取执行）→ D 推演 → B/I/V → R 人审。

## 工程约束（架构决策 / 实现规范）

- `../docs/architecture.md`：架构决策（技术栈、部署形态、整体架构），工程资产、随项目版本化；
- `../impl/CONVENTIONS.md`：实现规范（MySQL 表名 snake_case、索引前缀 uk_/idx_、charset=utf8mb4、分层约定等），工程资产；
- **消费方式**：I 单元第一步 `read-conventions` 读取这两份并遵循；I 清单 `check-naming` 调用
  `scripts/check-mysql-naming.mjs` 机械检查（表名/索引前缀/charset），不合格 → I 验收失败 → 机械回退；
- 检查脚本找不到 schema 文件或 `CONVENTIONS.md` 不存在时自动跳过（规范未配置 = 不拦）；
- 约束文档不属于协议模型，不进 `modeling/`；由实现 agent 消费、由验收脚本守卫。

## 第一需求自举流程

```
M（init-modeling 建建模目录 + 初始 model.md；后续迭代写模型）
→ D（produce-derive：protochain 十步推演 check→…→generate-cases，formalize/TLC 权威闸门）
→ B（绑定）→ I（实现骨架）→ V（有参考实现 src/server.js 则真实 verify，否则建模-only）
→ R（人工终审 --resolve-escalation 三问）
```

- 模型有缺陷 → formalize 失败 → m→d 验收失败 → **机械回退 M**（derive 阶段 rollbackMap model→model）；
- 实现未就绪时 I 跳过真实构建、V 走建模-only（参考实现接入后自动切真实 verify）。

## 运行（编译版，无源码）

项目根 `.env`（由 init-runner 生成）配置引擎与工具路径；启动前先加载它：

```bash
# 加载项目根工具环境（PROTOCOL_RUNNER / NODE / PROTOCHAIN；留空用 PATH）
source .env

# 启动编排引擎（引擎路径见 .env 的 PROTOCOL_RUNNER）
"$PROTOCOL_RUNNER" --project protocol-runner/ --reset
"$PROTOCOL_RUNNER" --project protocol-runner/                # 跑一轮至收尾（R 停在人工确认）
"$PROTOCOL_RUNNER" --project protocol-runner/ --resolve-escalation <escId> --answers '{...}'  # 人审放行

# 或者直接用编译产物 / 全局 bin（不经 .env）：
# node <protocol-runner-dist>/runner.js --project protocol-runner/
# protocol-runner --project protocol-runner/
```
# 方式一：直接用编译产物
node <protocol-runner-dist>/runner.js --project <实例路径> --reset
node <protocol-runner-dist>/runner.js --project <实例路径>                # 跑一轮至收尾（R 停在人工确认）
node <protocol-runner-dist>/runner.js --project <实例路径> --resolve-escalation <escId> --answers '{...}'  # 人审放行

# 方式二：全局安装的 bin（npm link 后）
protocol-runner --project <实例路径> --reset
protocol-runner --project <实例路径>
```

## 与 demo-generic 的区别

- demo-generic：通用最小骨架（spec/build/verify/human，零建模逻辑）；
- 本模板：协议建模驱动专用、**可移植**——protochain 走 PATH/覆盖路径，不绑定任何工具链源码目录；内置推演、TLC 闸门、模型缺陷回退 M、真实 verify（参考实现存在时）、人工终审。

## 预实例化行为（未替换占位符时）

- 配置校验（L1–L3）可通过（版本已用默认 0.1.0）；
- 运行时 `check-real-*` 会因 `{{...}}` 占位符未替换而失败 → m→d 验收失败 → 机械回退 M → 循环。
  这是预期的守卫行为：占位符未替换 = 环境未就绪 = 验收拒绝；替换 env 后即正常。
