# Protochain 实现验收（Implementation Acceptance）

> 版本：v0.1（2026-08-22）
> 来源：[IMPLEMENTATION-PLAN.md](file:///work/protochain/IMPLEMENTATION-PLAN.md)（E1-E10 + T1/T2/T3 完成标志）
> 读者：验收人（执行 E# 的工程师 + 独立验收者）
> 约定：
> - 实例路径用 `<strangler-fig-root>` / `<hsk-ng-root>` 占位，以实际仓库为准
> - 规划中新增命令（`m-check` / `derive-bindings` / `derive-web` / `web serve` / `verify --mock` / `--skip-sql-check` / `--lang` / `--emit=mock` / `diff --human` / `impact --include` / `issues aggregate`）实现后以 `protochain --help` 为准，本文件给出的命令形式为预期形态

---

## 0. 验收总则

| 原则 | 要求 |
|---|---|
| 权威源不破坏 | 验收过程中**不得直接改推导产物**（specs.json / test-cases.json / test-tool / interfaces.d.ts）；确需调整一律回到 model.md / scenarios / bindings → 重推导 |
| 可判定 | 每项验收有明确"通过标准"，不允许"看起来没问题"式结论 |
| 证据落盘 | 每次验收把输出/报告归档：`<实例根>/verification/acceptance/<E#>/`，记录时间与执行人 |
| 双跑对比 | 需要回归对比的项（E4/E8 等），新旧结果并排留存，避免事后无法复核 |
| 命令以实际为准 | 新增命令名以实现后 `protochain --help` 为准，本文件为准入基线 |

---

## 1. 单步验收清单（E1-E10）

### E1. M 单元语义闸门（m-check）

- **验收目标**：命名规范 / 跨协议 ID 唯一性 / 附属实体归属 / 旧字符禁用 / ID 转义前置在 M 阶段被拦截。
- **前置条件**：`m-check` 命令可用（`npm run build` 通过）。
- **操作步骤**：
  1. 构造坏模型 A：将 019 单式 `INV-PS1`（含 `-`）写入临时 model.md；构造坏模型 B：写入修改单 001 式命名违规的 SE ID。
  2. 对坏模型 A/B 跑 `protochain m-check --dir <dir>`；对现有正常模型跑一次作为对照。
  3. 通过 protocol-runner 跑 M 单元（`llm-model` 替换后的执行器），读 `<实例根>/protocol-runner/state.json` 的 M 单元 selfCheck。
- **通过标准**：
  - 坏模型 A/B：m-check 退出码非 0，报告逐条列出违规 ID 与触犯规则；state.json 中 M 单元 `selfCheck: failed`。
  - 正常模型：m-check 退出码 0，无违规报告。
- **证据**：m-check 报告输出、state.json 片段。

### E2. specs.json 升级到 JSON Schema

- **验收目标**：specs.json 含 requestSchema / responseSchema / preconditions / postconditions，可机械断言；verify 支持业务字段级对比。
- **前置条件**：specifier 重构完成；E1 的 pre-check 已合并。
- **操作步骤**：
  1. 对 hsk-ng（或 strangler-fig）任一协议跑 `protochain derive-specs`。
  2. 用 ajv 校验 specs.json：`node -e "const Ajv=require('ajv');const specs=require('<实例根>/derived/specs.json');..."`（编译全部 schema 断言全部通过）。
  3. 抽查 specs.json：每个接口有非空 `requestSchema` / `responseSchema`；自然语言 guard 的接口标记 `kind="legacy-stub"` 或 `description-only`。
  4. 配置 bindings 后跑 `protochain verify`，检查偏差报告是否出现"字段 X：legacy=Y, impl=Z"形式的条目。
  5. 兼容性：用一个老格式 specs.json（无 schema）跑 derive-specs，确认自动迁移 + 报警 + `schemaVersion` 字段。
- **通过标准**：ajv 编译全部通过；抽查接口 schema 完整；verify 报告含业务字段级偏差；老格式迁移无报错且显式标记。
- **证据**：ajv 校验输出、specs.json 样本、verification-report.json。

### E3. binding 骨架自动生成（derive-bindings）

- **验收目标**：derive-specs 后直接产出 binding 骨架，人工只填 baseUrl/headers/认证。
- **前置条件**：E2 通过（specs.json 有完整 schema）。
- **操作步骤**：
  1. 对 hsk-ng 全部 18 单跑 `protochain derive-bindings --dir <hsk-ng-root>`。
  2. 统计产出 `bindings.skeleton.yaml` 的接口条目数（对照已知 40 路由）。
  3. 人工只填 baseUrl/headers/stateMap 后，跑 `protochain bind` 确认完整性通过。
- **通过标准**：
  - 骨架覆盖全部推导接口（40/40 条生成）。
  - 生成成功率 ≥ 80%：定义 = 除 `baseUrl` / `headers` / `authConfig` / `stateMap` 确认项外，其余字段无需人工修改。
  - `bind` 校验通过（系统接口 + 观测接口无缺绑）。
- **证据**：bindings.skeleton.yaml、接口条数统计、bind 输出。

### E4. 数据级不变量结构化声明 + SQL 校验

- **验收目标**：`level=data` 不变量不进 TLA+，由 verify 的 SQL 校验路径承接；guard 型项显式声明 by-design。
- **前置条件**：T1 启动前已完成 019 单不变量盘点，`N` 值已填入规划；storage 连接信息就绪（read-only 角色）。
- **操作步骤**：
  1. 按盘点结果给 019 单 model.md 数据级不变量填 `level/source/storageRef`。
  2. 跑 `protochain formalize`，查 `formal-report.json` 的 `deferredToSqlValidation` 段（`level=data` 项应全部在此、不在 TLA+）。
  3. 跑 `protochain verify`（连接 storage），确认 N 条 SQL 校验通过、(11-N) 条进 `by-design-not-tested-by-toolchain` 段。
  4. 断连场景：`protochain verify --skip-sql-check`，确认显式跳过且报告标注。
- **通过标准**：11 条数据级不变量从"全部 TRUE"变为"N 条 SQL 校验通过 + (11-N) 条 by-design 声明"；skip 模式不静默、有标注；至少一个实例 run 通 verify SQL 校验。
- **证据**：formal-report.json、verification-report.json（含新段）、skip 模式输出。

### E5. transport 客户端生成（TS，P1 范围）

- **验收目标**：`generate-scaffold --lang=ts` 产出可直接用的 http/kafka/nsq 客户端，方法名与 bindings 一致。
- **前置条件**：E2（schema）+ E3（bindings 骨架）通过。
- **操作步骤**：
  1. 对 hsk-ng 任一协议跑 `protochain generate-scaffold --lang=ts`。
  2. 脚本比对：生成的 `clients/*.ts` 方法名 vs `bindings.yaml` 的 `interfaces[].action`，全量一致。
  3. 用生成 client 跑一次 binding run（或最小集成用例），确认可真实调用。
- **通过标准**：client 方法名与 bindings 100% 一致；至少一次真实调用成功（非仅编译通过）；`clients/` 产物位于预期路径。
- **证据**：clients/*.ts、方法名比对脚本输出、binding run 日志。

### E6. Mock/Spy 自动生成

- **验收目标**：无 impl 时可 `verify --mock` 跑模型层契约一致性；mock 输出确定性。
- **前置条件**：E2 通过；fixtures 来源已敲定（T2 启动前已读 test-cases schema 定案）。
- **操作步骤**：
  1. 跑 `protochain generate-tests --emit=mock`，确认产出 `derived/test-tool/mocks.ts`。
  2. 在无 impl 环境跑 `protochain verify --mock`，连续跑两次。
  3. 对两次输出做 sha256 比对。
- **通过标准**：`verify --mock` 全绿（模型层契约一致性）；两次输出 sha256 一致（无 AI 随机性）；mock 返回值与 fixtures 完全一致。
- **证据**：mocks.ts、两次 verify 报告 + sha256 记录。

### E7. Web 检阅界面

- **验收目标（P0）**：`derive-web` 机械生成静态检阅站点，四类页面人读。
- **操作步骤（P0）**：
  1. 对 strangler-fig 019 单跑 `protochain derive-web`，确认产出 `web/data.json` 与静态站点。
  2. `protochain web serve` 起本地静态服务，浏览器打开检查：接口列表/详情、测试用例浏览器、双跑报告对比（legacy vs impl 并排）、模型 diff/impact 可视化四类页面。
  3. 确认无后端进程依赖（纯静态文件可被任意静态服务器托管）。
- **通过标准（P0）**：四类页面全部可访问且人读（非裸 JSON）；P0 无运行时依赖（停掉 `web serve` 后静态文件仍可独立托管展示）。
- **验收目标（P1）**：scenarios/bindings 在线编辑、一键 generate-cases/bind/verify、评审生成修改单草稿。
- **操作步骤（P1）**：
  1. 在 Web 编辑一个 scenarios/*.yaml（如加一条 seed）→ 一键 generate-cases → 确认用例变化由机械推导产生。
  2. 确认页面与接口响应中**不出现** `authConfig.token` / 令牌环境变量值等敏感字段。
- **通过标准（P1）**：在线编辑生效且产物落盘正确；敏感字段全站不可见；Web 服务不持有令牌环境变量（进程 env 检查）。
- **证据**：web/data.json、页面 URL 快照、敏感字段扫描结果、P1 产物落盘路径。

### E8. test-tool 从代码生成迁到描述执行

- **验收目标**：test-tool 改为 description.json + 固定 runner；verify 结果确定化。
- **前置条件**：E6 通过（mock runner 与 description runner 共栈）。
- **操作步骤**：
  1. 确定性路径（`useAI=false`）生成 test-tool → 跑迁移脚本 → 产出 `test-cases.description.json`；确认 4 个旧 ts 文件标记 deprecated。
  2. 同一 model.md + scenarios 跑两次 `protochain verify`，对两次 `verification-report.json` 做 sha256 比对。
  3. 对 strangler-fig 019 单：迁移前 vs 迁移后各跑一次 verify，比对结果（灰度双跑 3 轮，一致后切默认）。
- **通过标准**：两次 verify 报告 byte-level 一致；019 单迁移前后结果一致（无功能回归）；AI 生成的旧 test-tool 走人工核对路径、不强制自动迁移。
- **证据**：description.json、两次报告 sha256、迁移前后对比记录。

### E9. 跨协议 diff + binding 影响分析

- **验收目标**：diff 人读化、impact 覆盖 binding、支持跨协议 diff。
- **操作步骤**：
  1. 在 strangler-fig 或 hsk-ng 改一个不变量（如 INV1 表达式）→ `protochain version save` → `protochain diff --human`。
  2. 跑 `protochain impact --include=bindings`，确认报告列出受影响的 binding（stateMap 命中 / method/path 变化）。
  3. 多协议场景：`protochain diff --cross-protocol`（composition 下多协议统一 diff）。
- **通过标准**：`diff --human` 输出人读视图（表格/接口级，非裸 JSON）；impact 能回答"改 INV1 后哪些 binding 要回归"；cross-protocol diff 输出可读报告。
- **证据**：diff 报告、impact-analysis.json、cross-protocol 报告。

### E10. 修改单 SLO + 跨实例聚合

- **验收目标**：修改单带索引与 SLO，CI 联动实例回归。
- **前置条件**：E1 通过（m-check 修复的修改单建立 SLO 才有意义）。
- **操作步骤**：
  1. 给 `/work/工具链问题清单-protocoldriven.md` 中 3 个历史修改单（001/002/003）回填 `affected-instances: [strangler-fig, hsk-ng]`。
  2. 给修改单模板加 `severity: P0-24h | P1-7d | P2-30d` 字段。
  3. 触发 CI（模拟 merge 或手动 workflow_dispatch）跑 strangler-fig / hsk-ng 回归一次。
- **通过标准**：3 个修改单 `affected-instances` 填齐；SLO 字段写入模板；CI 跑通一次实例回归（即使空跑）；超期告警机制存在（CI 检查项）。
- **证据**：问题清单、修改单模板、CI 运行日志。

---

## 2. 阶段验收（T1/T2/T3 完成标志）

### T1（P0：E1 + E2 + E3 + E7-P0）

| 检查项 | 方法（引用单步验收） | 通过标准 |
|---|---|---|
| specs.json 过 ajv | E2 步骤 2 | ajv 全部通过 |
| m-check 拦下 019 单 INV-PS1 | E1 步骤 2-3 | M 单元 selfCheck 失败 |
| derive-bindings 生成率 ≥ 80% | E3 步骤 2 | 40/40 条生成、成功率 ≥ 80% |
| Web 静态站点可访问 | E7-P0 步骤 2 | 四类页面可访问 |

### T2（P1：E4 + E5 + E6 + E7-P1）

| 检查项 | 方法 | 通过标准 |
|---|---|---|
| 数据级不变量 N+（11-N） | E4 步骤 3 | N 条 SQL 通过 + (11-N) 条 by-design |
| `--lang=ts` client 跑通 binding run | E5 步骤 3 | 真实调用成功 |
| `verify --mock` 全绿 | E6 步骤 2 | 全绿 + 两次 sha256 一致 |
| Web P1 在线编辑 scenarios | E7-P1 步骤 1 | 编辑生效、产物落盘 |

### T3（P2：E8 + E9 + E10）

| 检查项 | 方法 | 通过标准 |
|---|---|---|
| test-tool 迁移无回归 | E8 步骤 3 | 迁移前后结果一致 |
| cross-protocol diff 人读报告 | E9 步骤 3 | 输出可读 |
| SLO 字段填齐 | E10 步骤 1-2 | 3 单填齐 + 模板更新 |
| CI 实例回归跑通 | E10 步骤 3 | CI 日志成功 |

---

## 3. 整体验收（全链路回归）

在 T3 完成后、对外宣称"工具链 v0.2 就绪"前执行：

### 3.1 权威源一致性回归

对 strangler-fig 与 hsk-ng **全协议**：

```bash
protochain run --from check --to verify -y --dir <实例根>
```

- 通过标准：
  - check 全绿（机械层 + AI 语义层，可 `--no-ai` 复核机械层独立通过）
  - formalize 报告 `toolExecuted=true && passed=true`（配置 TLC 的实例）或 `tla-ai-fallback` 标注（未配置实例）
  - verify `authoritative.passed = true`，`failed = 0`
  - 无 `legacy-stub` 之外的 schema 缺失告警（E2 兼容性无回归）

### 3.2 老协议兼容回归

| 兼容对象 | 回归方法 | 通过标准 |
|---|---|---|
| 无 schema 的旧 specs.json | E2 步骤 5 重跑 | 自动迁移 + `kind="legacy-stub"` 标记，无报错 |
| 无 `level` 列的不变量表 | E4：跑 check/formalize | 默认按 `state-machine` 处理，行为与旧版一致 |
| 无 scenarios/setup 的场景 | 全链路回归 | 行为向后兼容（USAGE 6.4） |
| 单环境 bindings（无 environments 段） | `protochain bind && verify` | 行为与旧版一致 |

### 3.3 权威源单一性抽查

- 抽查 3 个接口：specs.json → bindings.yaml → impl 实现 → verify 报告四者一致，无"绕过模型直接改产物"的痕迹（对比 git diff 中 derived/ 是否只由工具链命令产生）。
- 通过标准：derived/ 目录所有变更均来自 `protochain` 命令执行，无手工编辑提交。

### 3.4 整体验收结论

- 三阶段 + 全链路回归全部通过 → 输出验收结论：`达成（T1/T2/T3 全部完成标志通过）`。
- 任一项失败 → 记录失败项 → 回到对应 E# 修复 → 重跑该步 + 其依赖的后续步，**不跳过重跑**。

---

## 4. 验收记录模板

每次验收归档至 `<实例根>/verification/acceptance/<E#>/`，单份记录格式：

```yaml
item: E2
date: 2026-08-22
executor: <执行人>
instance: hsk-ng
command: protochain derive-specs --dir <hsk-ng-root>
result: pass | fail
evidence:
  - derived/specs.json (sha256: ...)
  - ajv-check-output.log
notes: 老协议 A 自动迁移成功，标记 legacy-stub
followup:   # 仅 fail 时填写
  - 回到 E2 修复 xx
```

> 反馈：本验收文档与 IMPLEMENTATION-PLAN.md 的 E# 一一对应；若规划后续修订，同步更新本节验收方法与通过标准。
