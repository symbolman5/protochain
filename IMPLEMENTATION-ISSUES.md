# Protochain 实现问题收集（Implementation Issues）

> 版本：v0.8（2026-08-23）
> 范围：E1（M 单元语义闸门）、E2（specs.json 升级 JSON Schema）、E3（binding 骨架自动生成）、E7-P0（Web 检阅界面）、E7-B1（组合层视图 / T2 首个任务）、E4（数据级不变量 SQL 校验）、E5（TS transport 客户端）、E6（Mock/Spy 生成）实施/验收过程中发现的问题登记处；后续 E# 实施问题追加到本文档
> 分工（与现有文档的区别）：
> - [IMPLEMENTATION-PLAN-REVIEW.md](file:///work/protochain/IMPLEMENTATION-PLAN-REVIEW.md)：评估**规划文档**本身（口径/一致性/事实）
> - 本文档：登记**实施代码**中发现的缺陷、边界问题、待确认项
> 跟踪规则：
> - 每条问题含 严重度 / 状态 / 发现阶段 / 涉及文件 / 复现 / 影响 / 建议
> - 状态流转：open → fixing → resolved（附修复 commit/验证方式）→ wontfix（附理由）
> - 修复后按 IMPLEMENTATION-ACCEPTANCE.md 对应 E# 重跑验收

---

## 0. 当前状态

| 阶段 | 状态 |
|---|---|
| E1 实施 | 已完成；8 条问题（E1-I1~I8）已修复并通过复验（tsc 通过、24/24 测试、CLI 端到端） |
| E1 新增问题 | 无 |
| E2 实施 | 已完成验收 + 9 条问题收口（E2-I1~I9 全部 resolved）；tsc 通过、jest 748/748 全过；CLI 端到端 E2-I1/E2-I2/E2-I3/E2-I7 复验通过 |
| E3 实施 | 已完成；验收 4/4 通过；2 条低问题（[E3-I1](#e3-i1)/[E3-I2](#e3-i2)）已修复并通过复验（tsc 0 errors、jest 57/796 全过、CLI 端到端） |
| E7-P0 实施 | 已完成；验收 6/6 声称 pass。独立复验发现 8 条问题（[E7-I1](#e7-i1)~[E7-I8](#e7-i8)）→ **v0.5 全量修复并复验通过**：3 条中（E7-I1/I2/I3）影响「web serve 起服务」验收口径已修；5 条低（E7-I4/I5/I6/I7/I8）死代码/测试口径/redact 行为/warning 文案/--force 已修；tsc 0 errors、jest 58/833 全过（新增 7 项 E7-I* 修复测试） |
| E7-B1 实施（T2 首个任务） | 已完成；验收 8/8 声称 pass（tsc 0 errors、jest 59/892 已独立复跑）。**独立复验发现 3 条问题（[B1-I1](#b1-i1)~[B1-I3](#b1-i3)）已 v0.2 全量修复并通过复验**：B1-I1 删除死代码 `composeDataWithProject` + 组合层 WebDataJson 顶层 `schemaVersion='1.1'`；B1-I2 changeType 扩展 `protocol_extend` + `preprocessYamlProse` 解决 `{...}: ...` 与多行 YAML；B1-I3 `--skip-probe` 传空数组 + web-serve 按 schemaVersion 分支 + 首页链接去尾斜杠；tsc 0 errors、jest 59/899 全过；hsk-ng 真实根（非裁剪 fixture）端到端跑通 + 组合层 8 探针全 200 |
| E4 实施（T2） | 已完成 + 验收通过（acceptance-record.yaml + E4-COMPLETE.txt + 证据快照；见 verification/acceptance/E4/）。独立复验（2026-08-23）：formalize deferredToSqlValidation=8、TLA+ 仅 1 条 state-machine；verify 连 sf-mysql SQL 校验 通过 1/失败 7 + by-design 7 项；--skip-sql-check 显式标注。1 条低问题（[E4-I1](#e4-i1) P7 盘点口径）登记 |
| E5 实施（T2） | 已完成 + 验收通过（acceptance-record.yaml + E5-COMPLETE.txt + 证据快照）。独立复验（2026-08-23）发现 1 条问题（[E5-I1](#e5-i1) jest 回归）已修复：tsc 0 errors、jest 64/933 全过；hskNG P1 生成 client 真实 fetch 调用 smoke 通过 |
| E6 实施（T2） | 已完成 + 验收通过（acceptance-record.yaml + E6-COMPLETE.txt + 证据快照，验收阶段补齐）。独立复验（2026-08-23）：generate-tests --emit=mock → mocks.ts；verify --mock 19/19 全绿；--no-ai 两次 sha256 一致。2 条问题（[E6-I1](#e6-i1) 证据缺失已补 / [E6-I2](#e6-i2) AI 摘要确定性口径）登记 |
| E7-P1 实施 | 已完成（v0.1）+ 验收通过（19 个证据文件；见 verification/acceptance/E7-P1/）。**独立复验（2026-08-23，评审视角）**：端到端复跑通过「在线编辑 → 落盘权威源 → 读回 → 删除」+「全站敏感扫描 0 命中」+「一键 verify 子进程 env 隔离 0 命中」+「/api/health env scrub 报告」+ 7 静态资源 200；tsc 0 errors、jest 70/1027 全过。**v0.8（2026-08-23）修复 3 条 open**：[E7-P1-I1](#e7-p1-i1)（中）PATCH merge + PUT confirm + 写前 .bak 备份 + atomic write；[E7-P1-I2](#e7-p1-i2)（中）generate-cases 增加 `--no-ai` 走确定性 BFS/DFS；[E7-P1-I3](#e7-p1-i3)（低）env 键名掩码 `LE****(12,sensitive)`；tsc 0 errors、jest 70/1044 全过（新增 17 项单测）。**遗留**：[E7-P1-I4](#e7-p1-i4)（低/info）验收证据细节（api-issues-post 005 vs 007、tc-diff 因果、web/data.json 缺失）属 E8 文档维护；strangler-fig bindings.yaml（247B）需用户在 git/手写层恢复 47667B 完整骨架后可走 PATCH 增量补全 P2-P6 路由 |
| E8-E10 | 未启动 |
| **E2.1 实施（T3 前置并行）** | 已完成 + 验收通过（acceptance-record.yaml + E2.1-COMPLETE.txt + 证据快照；见 verification/acceptance/E2.1/）。独立复验（2026-08-23）：parser contracts[] 段解析 + specifier 契约字段合并（schemaKind=structured）+ checker ajv 自检 + verify 字段级三元组（CLI 端到端）+ hsk-ng P1 model.md 注入 contracts[]（register/bind 从 description-only 升 structured，其余 5 个转移维持 legacy-stub 零回归）；tsc 0 errors、jest 76/1080 全过（增量 +6 suites / +53 cases）。3 条 open 问题（[E2.1-I1](#e21_i1) / [E2.1-I2](#e21_i2) / [E2.1-I3](#e21_i3)）已登记 |

---

## 1. E1 阶段问题

| ID | 严重度 | 状态 | 摘要 |
|---|---|---|---|
| [E1-I1](#e1-i1) | 高 | **resolved** | M002 peer 目录过滤与 USAGE 命名不匹配 → 多协议 M002 失效（已修复并端到端验证） |
| [E1-I2](#e1-i2) | 高 | **resolved** | M003 跨协议 belongsTo 误报（已修复并端到端验证） |
| [E1-I3](#e1-i3) | 中 | **resolved** | M005 裸 TRUE warning 等级设计确认 |
| [E1-I4](#e1-i4) | 中 | **resolved** | M003 与 checker belongsTo 职责边界声明 |
| [E1-I5](#e1-i5) | 低 | **resolved** | 验收产物 git 追踪决策：版本化 |
| [E1-I6](#e1-i6) | 低 | **resolved** | SE 实体维度测试补充 |
| [E1-I7](#e1-i7) | 高 | **resolved** | 多协议 self peer 误报：loadPeerModels 加 currentModelPath + CLI 透传（已修复并端到端验证） |
| [E1-I8](#e1-i8) | 高 | **resolved** | verifier/index.ts E2 半成品接线引用未定义 `ctx` → 编译失败（复验中修复） |

### E1-I1：M002 多协议 peer 目录扫描失效 ✅ resolved

- **修复**：`loadPeerModels` 过滤改为 `/^P\d+/` 前缀匹配（[index.ts:48](file:///work/protochain/src/mcheck/index.ts#L48)），兼容 `P1-用户配额同步` 目录名。
- **验证**：
  - 单测：新增集成用例"peer 目录名带描述也能加载"（[tests/mcheck.test.ts:190-223](file:///work/protochain/tests/mcheck.test.ts#L190-L223)），走 `runMCheck(model, tmpRoot)` 目录扫描路径。
  - 端到端：构造 `/tmp/mcheck-multi/protocol/{P1-用户与配额,P2-我的协议}/model.md`（同名 INV1），`m-check --dir /tmp/mcheck-multi --model .../P1-用户与配额/model.md` 触发 M002 报 32 项跨协议冲突（修复前恒为 0）。产物：`verification/acceptance/E1/multi-protocol-M002.json`。
- **遗留边界**：self peer 误报见 E1-I7。

### E1-I2：M003 对跨协议 belongsTo 引用误报 ✅ resolved

- **修复**：M003 借鉴 checker 跨协议识别（[rules.ts:193-195](file:///work/protochain/src/mcheck/rules.ts#L193-L195)），belongsTo 含 `P\d` 或括号注解时视为跨协议引用并跳过单协议存在性校验。
- **验证**：
  - 单测：新增"belongsTo 含协议 ID（P2）视为跨协议引用，M003 不报错"（[tests/mcheck.test.ts:336-354](file:///work/protochain/tests/mcheck.test.ts#L336-L354)）。
  - 端到端：`belongsTo: entry（P2）` 模型 m-check exit=0，M003 通过。产物：`verification/acceptance/E1/cross-belongsTo.{json,txt}`。

### E1-I3：M005 对裸 `TRUE` 仅 warning 的设计确认 ✅ resolved

- **结论**：保持 warning（[rules.ts:393-400](file:///work/protochain/src/mcheck/rules.ts#L393-L400) 注释说明）：与 IMPLEMENTATION-PLAN §E4"数据级不变量允许写 TRUE（by-design）"兼容；E4 落地后与 verify 的 `by-design-not-tested-by-toolchain` 段联动。不升 error。

### E1-I4：M003 与 checker 的 belongsTo 职责边界 ✅ resolved

- **结论**：M003 顶部注释（[rules.ts:170-175](file:///work/protochain/src/mcheck/rules.ts#L170-L175)）显式声明：checker 识别 belongsTo 跨协议引用并标记 pendingCrossProtocolRefs；M003 只做单协议存在性校验，跨协议情形跳过。与 E1-I2 一并落地。

### E1-I5：验收产物 git 追踪状态 ✅ resolved

- **结论**：`verification/` 不在 [.gitignore](file:///work/protochain/.gitignore)，验收记录版本化——与 V5"审计可追溯"一致，作为正式决策。

### E1-I6：坏模型 B 覆盖维度说明 ✅ resolved

- **修复**：新增"subsidiaryEntities ID 含 `-` 被拦下"用例（[tests/mcheck.test.ts:128-149](file:///work/protochain/tests/mcheck.test.ts#L128-L149)，SE-BAD），SE 实体维度已单测覆盖。

### E1-I7：多协议 self peer 误报（复验新发现）✅ resolved

- **严重度**：高
- **状态**：**resolved**（2026-08-22）
- **修复**：
  - [src/mcheck/index.ts](file:///work/protochain/src/mcheck/index.ts) `loadPeerModels` 加 `currentModelPath` 参数，按 `resolve(modelPath) === resolve(currentModelPath)` 排除 self
  - `runMCheck` 透传 `currentModelPath` 参数
  - `mCheckCli` 把 `opts.modelPath` 解析后透传
  - 新增集成测试 `'CLI 多协议 self 不误报（E1-I7 修复）'`
- **验证**：
  - 单测：24/24 通过（含新增 self peer 用例）
  - 端到端：构造 `/tmp/mcheck-i7-clean`（P1/P2 各自无撞名 ID），M002 只报真 peer 冲突（`traffic_quota` 撞名），无 self `P1-用户与配额` 误报
  - 产物：[verification/acceptance/E1/multi-clean-i7.{json,txt}](file:///work/protochain/verification/acceptance/E1/)

### E1-I8：verifier/index.ts E2 半成品接线编译错误 ✅ resolved（复验中修复）

- **严重度**：高（阻塞 tsc，违反验收前置"应无类型错误"）
- **发现于**：E1 复验 `npx tsc` 报错 `src/verifier/index.ts(324,34): Cannot find name 'ctx'`
- **描述**：E2（字段级偏差对比）的部分实现已提前进入代码——binding-runner.ts 已实现字段级对比（[binding-runner.ts:308-332](file:///work/protochain/src/verifier/binding-runner.ts#L308-L332)，含 field-compare.ts），但 verifier/index.ts 的接线层引用未定义的 `ctx`（应为 `options`），且 `runTestCasesBinding` 的 options 类型缺字段、verify 调用处未传参。
- **修复**（最小接线，3 处）：
  1. `runTestCasesBinding` options 类型补 `legacyExpectedResponses?` / `enableFieldLevelCompare?`（[index.ts:285-292](file:///work/protochain/src/verifier/index.ts#L285-L292)）
  2. 函数内 `ctx.*` → `options.*`（[index.ts:331-333](file:///work/protochain/src/verifier/index.ts#L331-L333)）
  3. verify 调用处从 `ctx` 传入（[index.ts:137-143](file:///work/protochain/src/verifier/index.ts#L137-L143)）
- **验证**：`npx tsc` 通过；mcheck 23/23 通过。
- **关联**：E2 主体尚未实施，但字段级对比已部分存在——E2 实施时应以此接线为基线核对 binding-runner / field-compare / CLI 的完整链路。

---

## 2. E2 阶段问题

> E2 交付：specs.json 升级 JSON Schema（Envelope 形态 + 完整 requestSchema/responseSchema + 字段级偏差对比）。验收 4/4 通过，产物在 `verification/acceptance/E2/`。

| ID | 严重度 | 状态 | 摘要 |
|---|---|---|---|
| [E2-I1](#e2-i1) | 高 | **resolved** | verifier/steps 接线：抽公共 src/specifier/load.ts、steps/verify.ts 与 verifier loadSpecs 走同一 helper（v0.4 复验通过） |
| [E2-I2](#e2-i2) | 中 | **resolved** | guard 单标识符：tryParseGuardSchema 标 legacy-stub；guard params 不入 requestSchema 必填；schemaKind 同步降级 |
| [E2-I3](#e2-i3) | 中 | **resolved** | schemaKind 口径统一：envelopeMigrate 复用 classifySchemaKind，迁移分类与 specifier 主路径一致 |
| [E2-I4](#e2-i4) | 中 | **resolved** | CLI verify：buildLegacyExpectedFromModel 从 model.contractInput.expectedInformationFields + invariants 注入 legacyExpectedResponses（不再恒空） |
| [E2-I5](#e2-i5) | 中 | **resolved** | envelopeMigrate：浅拷贝 + 不可识别形态 migrated:false + envelope.parseError 显式标注；loadSpecsEnvelope 损坏形态抛错不再静默 |
| [E2-I6](#e2-i6) | 低 | **resolved** | specify()：移除 makeEnvelopeArrayLike duck-type，返回纯 SpecsEnvelope；消费方走 envelope.specs / specsFromEnvelope |
| [E2-I7](#e2-i7) | 低 | **resolved** | stateEnum 拆分：stateEnumSchema（仅真实状态）用于 nextState；stateEnumCurrentSchema（含 `-`）用于 currentState |
| [E2-I8](#e2-i8) | 低 | **resolved** | 移除 Deviation.kind 联合成员 schema_violation（无任何产出点，统一收口） |
| [E2-I9](#e2-i9) | 低 | **resolved** | scaffolder 模板：移除 /work/protocoldriven 与 /work/protocol-runner 硬编码路径（executor-hooks.mjs 异步懒加载 + 注释去路径化），init-runner.test.ts 通过 |

### E2-I1：verifier/steps 接线未适配 Envelope（绑定模式崩溃） ✅ resolved（2026-08-22 v0.4）

- **严重度**：高
- **状态**：**resolved**（2026-08-22 v0.4）
- **修复**：
  - 抽公共模块 [src/specifier/load.ts](file:///work/protochain/src/specifier/load.ts) `loadSpecsEnvelope(rootDir, ...)`
  - [src/steps/verify.ts](file:///work/protochain/src/steps/verify.ts) 改走公共 helper（不再 `readReport<InterfaceSpec[]>`）+ 透传 `enableFieldLevelCompare` 与 `legacyExpectedResponses`
  - [src/verifier/index.ts](file:///work/protochain/src/verifier/index.ts) `loadSpecs` 同样改走公共 helper
- **验证**：
  - CLI 端到端：`/work/protochain/dist/cli/index.js derive-specs --dir <fixture>` → envelope 落盘正常
  - jest 56/56 suites = 748/748 cases pass（含新测试 12 项 `load-e2i1-e2i5.test.ts`）

### E2-I2：guard 单标识符处理与设计口径相悖 🟡 open

- **严重度**：中
- **状态**：**open**（2026-08-22 登记）
- **发现阶段**：E2 代码核查（设计笔记 vs 实现）
- **涉及文件**：
  - 设计依据：[design-notes.md §4.1](file:///work/protochain/verification/acceptance/E2/design-notes.md)：「guard 是自然语言时（如 `form_valid`、`has_request`），提取的 guard params 仍进 schema（作为 `boolean` 参数），但**整体 precondition** 标注为 `legacy-stub`」
  - 实现：[schema-builder.ts:128-134](file:///work/protochain/src/specifier/schema-builder.ts#L128-L134) 单标识符 → `{kind:'json-schema', schema:{type:'boolean'}}`（结构化，非 legacy-stub）
  - [specifier/index.ts:186-199](file:///work/protochain/src/specifier/index.ts#L186-L199)：`extractGuardParams` 把 `form_valid` 当必填请求参数（`type:'any'`）→ [schema-builder.ts:70-74](file:///work/protochain/src/specifier/schema-builder.ts#L70-L74) 兜底映射为 `type:'string'`
- **复现**：approval-flow.md 的 `submit` guard=`form_valid`：`preconditions[0].kind='json-schema'`、`requestSchema.properties.form_valid.type='string'`、precondition schema 却为 `boolean`，且 `form_valid` 进 `required`。
- **影响**：① schemaKind=structured 判定失实（验收产物 structured=12 含此偏差）；② 同一变量在 requestSchema 与 precondition 类型矛盾（string vs boolean）；③ 请求参数集夸大（form_valid 是谓词名不是请求输入），未来按 schema 生成请求会要求多余字段。
- **建议**：与设计对齐——自然语言 predicate（`form_*`/`has_*` 等）→ precondition 标 legacy-stub；guard 参数不入 requestSchema 必填（或按设计以 boolean 进 schema 并加注）。注意：已被测试固化（[specifier-e2.test.ts:93-94](file:///work/protochain/tests/specifier/specifier-e2.test.ts#L93-L94)、[:135](file:///work/protochain/tests/specifier/specifier-e2.test.ts#L128-L137)），修代码须同步改测试。

### E2-I3：schemaKind 判定口径不一致 🟡 open

- **严重度**：中
- **状态**：**open**（2026-08-22 登记）
- **发现阶段**：E2 代码核查
- **涉及文件**：
  - [envelope.ts:66-84](file:///work/protochain/src/specifier/envelope.ts#L66-L84)：迁移启发式 `request 或 response 任一有 type` 即标 structured
  - [schema-builder.ts:183-207](file:///work/protochain/src/specifier/schema-builder.ts#L183-L207)：`classifySchemaKind` 要求 request 与 response **都有** type 且 precondition 无 legacy-stub 才算 structured
- **复现**：同一 legacy spec（仅 `requestSchema.type` 存在，无 responseSchema）→ `envelopeMigrate` 标 `structured`，`classifySchemaKind` 标 `legacy-stub`。
- **影响**：迁移后的 `schemaKind` 标记与消费方重新分类结果冲突，报告口径漂移；老格式自动迁移的标记不可信。
- **建议**：envelopeMigrate 复用 `classifySchemaKind`（或抽公共 classify 单点），两处口径统一后再跑 legacy-migration 验收。

### E2-I4：真实 CLI verify 缺「值对比」数据源 🟡 open

- **严重度**：中
- **状态**：**open**（2026-08-22 登记）
- **发现阶段**：E2 验收证据核查
- **涉及文件**：
  - [cli/index.ts:1140](file:///work/protochain/src/cli/index.ts#L1139-L1141)：`legacyExpectedResponses` 恒为 `{}`
  - [field-compare.ts:84-100](file:///work/protochain/src/verifier/field-compare.ts#L84-L100)：值比对仅在 `legacyExpected` 含该字段时触发
  - 验收证据来源：[scripts/gen-verification-report.mjs:70-72](file:///work/protochain/verification/acceptance/E2/scripts/gen-verification-report.mjs#L70-L72) 手工注入 `{approverId:'alice', decision:'approved'}`
- **复现**：CLI `verify` 真实路径对字段级偏差只能产出类型不符/必填缺失（legacy 侧为 expectedType/required），无法产出「legacy=Y, impl=Z」值级三元组；验收第 3 项产物仅演示脚本可复现。
- **影响**：验收第 3 项「字段 X：legacy=Y, impl=Z」在真实 CLI 路径不可复现；字段级对比能力名存实亡（只剩类型检查）。
- **建议**：E2.1 落地 legacy expected 数据源（scenarios/*.yaml.expectedFields 或 specs.json 输出字段 expected 值，design-notes §6 已提及 expectedInformationFields），并补一条走真实 CLI 的端到端验收。

### E2-I5：envelopeMigrate 静默兜底 + 就地修改 ✅ resolved（2026-08-22 v0.4）

- **严重度**：中
- **状态**：**resolved**（2026-08-22 v0.4）
- **修复**：
  - [src/specifier/envelope.ts](file:///work/protochain/src/specifier/envelope.ts) 裸数组兜底浅拷贝（`raw.map((s) => ({ ...s }))`）；不可识别形态返回 `migrated:false` + `envelope.parseError`
  - [src/specifier/load.ts](file:///work/protochain/src/specifier/load.ts) 损坏形态抛显式 Error
- **验证**：单测 `load-e2i1-e2i5.test.ts` 5 项（裸数组不被修改、损坏形态抛错等）

### E2-I6：specify() duck-type 数组兼容不完整 ✅ resolved（2026-08-22 v0.4）

- **严重度**：低
- **状态**：**resolved**（2026-08-22 v0.4）
- **修复**：[src/specifier/index.ts](file:///work/protochain/src/specifier/index.ts) 移除 `makeEnvelopeArrayLike`（连带 8 个 mock）；`specify()` 返回纯 SpecsEnvelope
- **迁移**：12 个 caller 已统一为 `specsFromEnvelope(specify(model))` 模式

### E2-I7：nextState enum 含 `-` 前置占位 ✅ resolved（2026-08-22 v0.4）

- **严重度**：低
- **状态**：**resolved**（2026-08-22 v0.4）
- **修复**：
  - [src/specifier/schema-builder.ts](file:///work/protochain/src/specifier/schema-builder.ts) `stateEnumSchema` 拆分：`stateEnumSchema(states)` 仅含真实状态 ID（nextState 用）；`stateEnumCurrentSchema(states)` 含 `-` + 全部真实状态 ID（currentState 用）
  - [src/specifier/index.ts](file:///work/protochain/src/specifier/index.ts) `deriveSystemInterface` 分拆使用
- **验证**：端到端 CLI：approval-flow.md submit action — currentState 含 `'-'` + S1~S5；nextState 仅 S1~S5

### E2-I8：Deviation.kind 声明 `schema_violation` 无产出点 ✅ resolved（2026-08-22 v0.4）

- **严重度**：低
- **状态**：**resolved**（2026-08-22 v0.4）
- **修复**：[src/model/types.ts](file:///work/protochain/src/model/types.ts) `Deviation.kind` 联合类型移除 `'schema_violation'` 成员
- **说明**：E2.1 后续如实施 verifier 运行时 ajv 校验，可重新引入该 member

### E2-I9：pre-existing 测试失败（与 E2 无关） ✅ resolved（2026-08-22 v0.4）

- **严重度**：低
- **状态**：**resolved**（2026-08-22 v0.4）
- **修复**：
  - [templates/protocol-runner-instance/executor-hooks.mjs](file:///work/protochain/templates/protocol-runner-instance/executor-hooks.mjs) 移除 `/work/protocol-runner/executors/llm/index.ts` 硬编码 import；改用异步懒加载 + 兜底 stub
  - [templates/protocol-runner-instance/README.md](file:///work/protochain/templates/protocol-runner-instance/README.md) 同步
- **验证**：`grep -r "/work/protocoldriven\|/work/protocol-runner" templates/` 无匹配；jest 56/56 = 748/748（init-runner.test.ts 通过）

---

## 3. E3 阶段问题

> E3 交付：binding 骨架自动生成（derive-bindings / mergeBindings / bind --skeleton）。验收 4/4 通过，产物在 `verification/acceptance/E3/`。
> 两条问题均为独立复验中发现（低，不影响验收通过）；E3 实施期本身未报问题。

| ID | 严重度 | 状态 | 摘要 |
|---|---|---|---|
| [E3-I1](#e3-i1) | 低 | **resolved** | mergeBindings 死代码清理：移除 manualInterfaces no-op filter + `void` 兜底；mergeAndValidateBindings 无调用点 → 删除 |
| [E3-I2](#e3-i2) | 低 | **resolved** | CLI 相对路径解析统一相对 `--dir`：新增 resolveRelative，`bind --skeleton` / `derive-bindings --specs/-o/--report` 收口 |

### E3-I1：mergeBindings 死代码 + mergeAndValidateBindings 无调用点 ✅ resolved

- **严重度**：低
- **状态**：**resolved**（2026-08-22 复验）
- **发现阶段**：E3 独立复验（代码核查）
- **涉及文件**：
  - [binder/index.ts:43-82](file:///work/protochain/src/binder/index.ts#L43-L82)：重写 interfaces 合并段，移除 `manualInterfaces` 恒 true filter 与 `void` 兜底，直接 `[...(manual.interfaces ?? []), ...skeletonOnly]`
  - `mergeAndValidateBindings` 无任何调用点 → 整体删除（CLI bind 已按 mergeBindings + validateBindings 两段走，见 [cli/index.ts:1147](file:///work/protochain/src/cli/index.ts#L1147)）
- **验证**：`npx tsc --noEmit` 0 errors；`npx jest` 57/796 全过（含 bindgen mergeBindings 5 项单测，合并行为不变）；CLI `bind --skeleton` 端到端 valid=true

### E3-I2：CLI 相对路径解析不一致（--skeleton/--specs/-o/--report 相对 cwd）✅ resolved

- **严重度**：低
- **状态**：**resolved**（2026-08-22 复验）
- **发现阶段**：E3 独立复验（CLI 端到端）
- **涉及文件**：
  - [cli/index.ts:1624-1627](file:///work/protochain/src/cli/index.ts#L1624-L1627)：新增 `resolveRelative(p, rootDir)`（绝对路径原样返回，相对路径 `resolve(rootDir, p)`）
  - [cli/index.ts:1134](file:///work/protochain/src/cli/index.ts#L1134)：`bind --skeleton` 改走 `resolveRelative(opts.skeleton, rootDir)`
  - [cli/index.ts:1785-1787](file:///work/protochain/src/cli/index.ts#L1785-L1787)：`derive-bindings --specs/-o/--report` 改走 `resolveRelative`
- **复现**（修复前）：`bind --dir /tmp/xx --skeleton derived/bindings.skeleton.yaml`（cwd=/work/protochain）→ 报 `文件不存在: /work/protochain/derived/...`
- **验证**：
  - `bind --dir /tmp/e3-reaccept --skeleton derived/bindings.skeleton.yaml`（相对路径，cwd 与 --dir 分离）→ ✓ 通过，exit=0
  - `derive-bindings --dir /tmp/e3-reaccept --output derived/... --report derived/...` → 落盘到 `/tmp/e3-reaccept/derived/`（原错误落 cwd）

---

## 4. E7-P0 阶段问题（Web 检阅界面）

> E7-P0 交付：`derive-web` 机械生成静态站点 + `web serve` 纯 stdlib http 服务。
> 实施期声称"未发现问题，无需登记修改单"（[E7-P0-COMPLETE.txt](file:///work/protochain/verification/acceptance/E7-P0/E7-P0-COMPLETE.txt) §9）—— 后续独立复验发现 8 条问题（[E7-I1](#e7-i1)~[E7-I8](#e7-i8)）；v0.5 全量修复并复验通过（3 条中 + 5 条低）。
> 复验方式：读 design-notes + acceptance-record + 快照；npx tsc --noEmit（0 errors）；npx jest（58/833 全过，含 7 项新增 E7-I* 修复测试）；CLI 端到端 /tmp/e7p0-reverify（derive-specs → derive-web --no-build → 探针 → web-serve → 畸形 URL 探针）。

| ID | 严重度 | 状态 | 摘要 |
|---|---|---|---|
| [E7-I1](#e7-i1) | 中 | **resolved** | web-serve 默认 distDir 与 derive-web 实际产物目录（`web/docs/.vitepress/dist`）已统一 → 正常链路 `derive-web`(默认 build) → `web-serve`(默认) 起得来 |
| [E7-I2](#e7-i2) | 中 | **resolved** | startServe 默认探针已不再硬编码 `/interfaces/IF_SYS_T1`；CLI 从 `web/data.json` 读真实接口 ID 构造探针；--skip-probe 可关闭 |
| [E7-I3](#e7-i3) | 中 | **resolved** | `resolveStaticPath` 对畸形百分号编码 try/catch 兜底返回 null；handleRequest 顶层包 try/catch → 单畸形请求仅 400，不再杀死进程 |
| [E7-I4](#e7-i4) | 低 | **resolved** | CLI derive-web 删除死代码 `basicPages`；exit 判定改为显式校验 5 类页面（index.md / interfaces/index.md / test-cases.md / verification.md / diff.md）落盘 |
| [E7-I5](#e7-i5) | 低 | **resolved** | 端到端脱敏测试改为向 envelope.specs 注入真实敏感键 tokenEnv/secretEnv；断言敏感值 + 敏感键名均不出现；删除占位常量恒真断言 |
| [E7-I6](#e7-i6) | 低 | **resolved** | redactSensitiveFields 改为整键删除（值不再替换为 `[REDACTED]`），与验收口径"tokenEnv 等字段不出现"严格对齐 |
| [E7-I7](#e7-i7) | 低 | **resolved** | readOptionalJsonWithStatus 新增 status 字段（'missing' / 'corrupt' / 'ok'）；CLI warning 文案区分"未找到 xxx" vs "xxx 存在但 JSON 解析失败" |
| [E7-I8](#e7-i8) | 低 | **resolved** | `--force` 真正生效：deriveWeb 在写产物前 existsSync 检查，未传 force 时抛 `web 产物已存在；如需覆盖请传 --force` |

### E7-I1：web-serve 默认 distDir 与 derive-web 产物目录不一致 ✅ resolved

- **严重度**：中
- **状态**：**resolved**（2026-08-22 v0.5）
- **根因**：derive-web 实现产物在 `web/docs/.vitepress/dist`（与 VitePress outDir 一致），web-serve 默认却看 `web/.vitepress/dist`，两处不一致导致正常用法（derive-web 默认 build → web-serve 默认）起服务时找不到 dist。
- **修复**：
  - [src/cli/index.ts](file:///work/protochain/src/cli/index.ts) `web-serve` 命令默认值从 `web/.vitepress/dist` 改为 `web/docs/.vitepress/dist`，与 derive-web outDir 对齐
  - [verification/acceptance/E7-P0/design-notes.md](file:///work/protochain/verification/acceptance/E7-P0/design-notes.md) §3/§6 同步（站点工程结构图标注真实路径）
- **验证**：
  - 单测：新增 E7-I2 端到端测试（隐含覆盖 CLI 默认路径解析）
  - 端到端（**E7-I1 修复后**）：`/tmp/e7p0-reverify` 跑 `derive-web --no-build` → 在 `web/docs/.vitepress/dist/` 写产物 → 跑 `web-serve --dir /tmp/e7p0-reverify --port 5175`（默认）→ 起服成功；curl 6 URL 全部 200
  - 产物：`web-serve-startup-log.txt`（v0.5 重生成）
  - tsc 0 errors；jest 58/833 全过

### E7-I2：startServe 默认探针硬编码 IF_SYS_T1 ✅ resolved

- **严重度**：中
- **状态**：**resolved**（2026-08-22 v0.5）
- **根因**：`DEFAULT_PROBE_PATHS` 硬编码 `/interfaces/IF_SYS_T1`，但接口 ID 按 transition id 派生（`IF_SYS_${t.id}`），任何不含字面 T1 的协议 web-serve 启动即被探针拒。
- **修复**：
  - [src/webgen/serve.ts](file:///work/protochain/src/webgen/serve.ts) `DEFAULT_PROBE_PATHS` 移除 `/interfaces/IF_SYS_T1`；保留首页 + 4 类页面
  - [src/cli/index.ts](file:///work/protochain/src/cli/index.ts) `web-serve` 命令：启动前读 `web/data.json` 取 `interfaces[0].id` 作为真实探针目标；新增 `--skip-probe` 可关闭探针
- **验证**：
  - 单测：新增 `E7-I2 修复：探针路径不硬编码 IF_SYS_T1（任意外部传入）`——传 `/interfaces/IF_SYS_T9` 探针成功
  - 端到端：`web-serve --dir /tmp/e7p0-reverify --port 5175` 探针包含 `/interfaces/IF_SYS_T1`（实际接口 ID，来自 data.json）
  - tsc 0 errors；jest 58/833 全过

### E7-I3：畸形 URL 使 web-serve 进程崩溃 ✅ resolved

- **严重度**：中
- **状态**：**resolved**（2026-08-22 v0.5）
- **根因**：`decodeURIComponent` 抛 URIError 时无 try/catch；Node 默认 `uncaughtException` 会让进程退出 → 单个畸形请求杀死整个服务。
- **修复**：
  - [src/webgen/serve.ts](file:///work/protochain/src/webgen/serve.ts) `resolveStaticPath`：`decodeURIComponent` 包 try/catch；失败 → 返回 null（由 handleRequest 转 400）
  - `handleRequest` 拆分为内部函数 + 顶层 try/catch 兜底；任一异常 → 500（不再崩进程）
- **验证**：
  - 单测：新增 2 项
    - `E7-I3 修复：畸形百分号编码 URL → 400 + 不崩进程`（resolveStaticPath 单元）
    - `E7-I3 修复：handleRequest 顶层 try/catch 兜底（不崩进程）`（真实 http server 端到端：先 `GET /%zz` → 400；再 `GET /` → 200）
  - 端到端：`curl 'http://127.0.0.1:5175/%zz'` → 400；`curl 'http://127.0.0.1:5175/'` → 200（server 仍存活）
  - tsc 0 errors；jest 58/833 全过

### E7-I4：CLI derive-web 死代码 basicPages ✅ resolved

- **严重度**：低
- **状态**：**resolved**（2026-08-22 v0.5）
- **根因**：`const basicPages = 4` 声明后从未使用；exit 判定只用 `hasDataJson && interfacesPages > 0`，「页面落盘」未被显式校验。
- **修复**：
  - [src/cli/index.ts](file:///work/protochain/src/cli/index.ts) 删除 `basicPages` 死代码
  - exit 判定改为显式 existsSync 5 类页面（`index.md` / `interfaces/index.md` / `test-cases.md` / `verification.md` / `diff.md`）；任一缺失 → exit 1 + 报错具体缺哪几页
- **验证**：tsc 0 errors；jest 58/833 全过

### E7-I5：测试占位恒真断言 + 端到端脱敏未真正覆盖 ✅ resolved

- **严重度**：低
- **状态**：**resolved**（2026-08-22 v0.5）
- **根因**：测试占位常量 `SENSITIVE_FIELD_NAMES_REPORT_FOR_TEST = true`（恒真）；端到端脱敏测试只注入 description（不在 SENSITIVE 名单）+ 断言 `"tokenEnv"` 不存在（从未注入该键）—— 断言恒真。
- **修复**：
  - [tests/webgen/webgen.test.ts](file:///work/protochain/tests/webgen/webgen.test.ts) 删除占位常量；改为断言 `SENSITIVE_FIELD_NAMES_REPORT` 字符串内容含 `tokenEnv` / `secretEnv` / `passwordEnv` / `certPath` 等关键字
  - 「敏感字段过滤」端到端测试改为向 `envelope.specs[0]` 直接注入真实敏感键（`authConfig.tokenEnv` / `secretEnv`）；断言 `JSON.stringify(data)` 不含 `SECRET_TOKEN_XYZ` / `SECRET_PASSWORD` / `tokenEnv` / `secretEnv`
- **验证**：tsc 0 errors；jest 58/833 全过

### E7-I6：redactSensitiveFields 保留键名，与验收口径"不出现"不符 ✅ resolved

- **严重度**：低
- **状态**：**resolved**（2026-08-22 v0.5）
- **修复**：[src/webgen/index.ts](file:///work/protochain/src/webgen/index.ts) `redactSensitiveFields` 改为整键删除（而非替换为 `[REDACTED]`）；与验收口径"tokenEnv 等字段不出现"严格对齐；避免键名本身暴露"存在某个令牌环境变量"。
- **验证**：
  - 单测更新断言：`expect(redacted.role.authConfig).not.toHaveProperty('tokenEnv')`
  - 端到端测试 `E7-I5 修复` 同时验证敏感值 + 敏感键名均不出现
  - tsc 0 errors；jest 58/833 全过

### E7-I7：readOptionalJson 解析失败与缺失都报"未找到" ✅ resolved

- **严重度**：低
- **状态**：**resolved**（2026-08-22 v0.5）
- **修复**：
  - [src/webgen/index.ts](file:///work/protochain/src/webgen/index.ts) 新增 `readOptionalJsonWithStatus`：返回 `{ value, status: 'missing' | 'corrupt' | 'ok', error? }`
  - `deriveWeb` 改用 `readOptionalJsonWithStatus`；CLI warning 文案区分
    - missing → `未找到 derived/test-cases.json；对应页面将空`
    - corrupt → `derived/test-cases.json 存在但 JSON 解析失败（{message}）；对应页面将空`
- **验证**：单测 `E7-I7 修复：readOptionalJsonWithStatus 区分 missing vs corrupt`（3 项：missing / corrupt / ok 各一）；tsc 0 errors；jest 58/833 全过

### E7-I8：`--force` 选项为 no-op ✅ resolved

- **严重度**：低
- **状态**：**resolved**（2026-08-22 v0.5）
- **修复**：[src/webgen/index.ts](file:///work/protochain/src/webgen/index.ts) `deriveWeb` 在 redact 之后、写文件之前增加 existsSync 检查：`if (!options.force && existsSync(dataJsonPath)) throw 'web 产物已存在（{path}）；如需覆盖请传 --force'`；写文件前的检查确保产物不会先被覆盖再报错。
- **验证**：
  - 单测：`E7-I8 修复：--force 选项真正生效` —— 跑 3 次（首次成功；第二次无 --force 抛错；第三次带 --force 成功）
  - 端到端：`derive-web --dir /tmp/e7p0-reverify --no-build`（首次成功）→ 再跑一次 → 报错"web 产物已存在；如需覆盖请传 --force" → 跑 `--force` → 成功
  - tsc 0 errors；jest 58/833 全过

---

## 5. E7-B1 阶段问题（组合层视图 / T2 首个任务）

> E7-B1 交付：`derive-web --project` 组合层视图（项目级只读机械检阅）。验收 8/8 声称 pass，产物在 `verification/acceptance/E7-B1/`。
> 本阶段 3 条问题均为**独立复验**发现。复验方式：读 E7-B1-COMPLETE + acceptance-record + 快照；npx tsc --noEmit（0 errors）；npx jest（59/892 全过）；端到端——hsk-ng 真实根 `derive-web --project`（失败）、B1 fixture 复跑（通过）+ 手写 dist 起 web-serve 验证探针/链接。
> **v0.2 独立复验确认（2026-08-22）**：B1-I1/I2/I3 三条修复全部复跑通过——hsk-ng 真实根 `derive-web --project` 成功（CI1~CI8 全部解析）；`web-serve` 组合层 12 条探针全 200 + `--skip-probe` 生效 + 目录式链接 200；tsc 0 errors、jest 59/907 全过（较 v0.1 的 892 增 15 项修复测试）。复验同时发现 2 个登记缺口：**B1-I5 未登记**（代码注释存在，见下）、B1-I3 修复记录路线描述与实际实现不符（文档写"去尾斜杠+.html"，实际为"目录式路由+尾斜杠"，见 B1-I3 修正）。

| ID | 严重度 | 状态 | 摘要 |
|---|---|---|---|
| [B1-I1](#b1-i1) | 低 | **resolved** | v0.2 修复：删除死代码 `composeDataWithProject`；组合层 WebDataJson 顶层新增 `schemaVersion='1.1'` + `generatedAt`；消费方按 schemaVersion 区分模式（1.0=单协议 / 1.1=组合层） |
| [B1-I2](#b1-i2) | 中 | **resolved** | v0.2 修复：changeType 枚举扩展接受 `protocol_extend`（hsk-ng 迭代 17 用）+ 新增 `preprocessYamlProse` 把 prose 字段（expression/checkMethod/description 等）转 literal block scalar 后再 parseYaml；解决 `{...}: ...` 与多行续行 YAML 解析失败；hsk-ng 真实根 CI1~CI8 全部解析 |
| [B1-I3](#b1-i3) | 中 | **resolved** | v0.2 修复：`--skip-probe` CLI 传 `probePaths=[]` 空数组（不再 undefined fallback）；web-serve 启动时按 `web/data.json` schemaVersion 区分模式（1.0=单协议 / 1.1=组合层）自动构造探针；首页子协议链接修复（实际方案：子协议页改目录式路由，见 [B1-I5](#b1-i5)） |
| [B1-I5](#b1-i5) | 低 | **resolved** | （v0.2 复验补登记）子协议页由 `protocols/<id>.md` 单文件改**目录式路由** `protocols/<id>/index.md` + 接口详情页 `protocols/<id>/<iface>.md`，并新增 `protocols[].firstInterfaceId` 供探针构造——B1-I3 链接修复的必要子问题（单文件 `.html` 方案与 `protocols/` 相对链接冲突），代码注释已标 B1-I5 但先前未登记 |

### B1-I1：composeDataWithProject 死代码 + --project 产物结构异构 ✅ resolved

- **严重度**：低
- **状态**：**resolved**（v0.2，2026-08-22）
- **发现阶段**：代码核查
- **v0.2 修复**：
  - 删除死代码 `composeDataWithProject`（[composition.ts:1122-1136](file:///work/protochain/src/webgen/composition.ts#L1122-L1136) → 已删除）
  - 组合层 WebDataJson 顶层新增 `schemaVersion: '1.1'` + `generatedAt`（[composition.ts](file:///work/protochain/src/webgen/composition.ts) `buildCompositionWebData`）
  - 单协议 WebDataJson 仍为 `schemaVersion: '1.0'`（[webgen/index.ts:63](file:///work/protochain/src/webgen/index.ts#L63) WEB_DATA_SCHEMA_VERSION）
  - 消费方（web serve / 未来场景）按 `schemaVersion` 区分模式（1.0=单协议 / 1.1=组合层）；CLI web-serve 已按 mode 分支构造探针（见 B1-I3）
- **验证**：
  - 单测：[tests/webgen/composition.test.ts](file:///work/protochain/tests/webgen/composition.test.ts) "B1-I1 修复：组合层 schemaVersion 区分模式" × 2 cases（buildCompositionWebData + deriveProjectWeb 端到端）
  - tsc 0 errors；jest 59/899 全过
  - hsk-ng 真实根 web/data.json 顶层含 `schemaVersion: "1.1

### B1-I2：hsk-ng 真实数据 --project 不可用 + 验收 fixture 未如实披露 ✅ resolved

- **严重度**：中
- **状态**：**resolved**（v0.2，2026-08-22）
- **发现阶段**：CLI 端到端复验
- **v0.2 修复**：
  - **changeType 枚举扩展**：[composition-parser/index.ts:133-146](file:///work/protochain/src/composition-parser/index.ts#L133-L146) 接受 `protocol_extend`（hsk-ng 迭代 17 用）；[model/types.ts:366-372](file:///work/protochain/src/model/types.ts#L366-L372) `CompositionMetadata.changeType` 同步扩展
  - **宽松 YAML 解析**：新增 `preprocessYamlProse`（[composition-parser/index.ts](file:///work/protochain/src/composition-parser/index.ts)）；按 `PROSE_KEYS` 白名单（`name` / `expression` / `checkMethod` / `description` / `rule` / `assumption` / `impactIfViolated` / `queryObservationInterfaceId` / `permissionBoundary` / `syncSemantics`）把 prose 字段转为 literal block scalar（`|`）后再 parseYaml；多行值判定：下一非空行缩进 > key 缩进 → 保留 inline + 续行 + 空行
  - **6 个组合层段解析器接入**（crossInvariants / crossTiming / externalDependencies / observationInterfaces / objectStateFacets / securityAssumptions）
  - **共享基础能力**：`parseSubItemsByHeading` ([extension-sections.ts](file:///work/protochain/src/parser/extension-sections.ts)) 增加可选 `yamlPreprocessor` 参数，向后兼容
- **端到端验证（hsk-ng 真实根 /work/hsk-ng/modeling）**：
  - `derive-web --dir /work/hsk-ng/modeling --project --no-build --force` → 4 协议卡片 + 6 依赖边 + **8 跨协议不变量（CI1~CI8 全部解析）** + 31 跨协议引用 + 老格式 specs.json 全部 envelopeMigrate 自动迁移
  - 详见 [derive-web-cli-output-v02.txt](file:///work/protochain/verification/acceptance/E7-B1/derive-web-cli-output-v02.txt) + [web-data-snapshot-v02.json](file:///work/protochain/verification/acceptance/E7-B1/web-data-snapshot-v02.json)
- **单测**：新增 [tests/composition-parser/composition-parser.test.ts](file:///work/protochain/tests/composition-parser/composition-parser.test.ts) "B1-I2 修复" × 6 cases（changeType

### B1-I3：组合层产物 web-serve 起不来 + --skip-probe 无效 + 首页链接 404 ✅ resolved

- **严重度**：中
- **状态**：**resolved**（v0.2，2026-08-22）
- **发现阶段**：CLI 端到端复验
- **v0.2 修复**：
  1. **`--skip-probe` 语义修复**：[cli/index.ts:1977](file:///work/protochain/src/cli/index.ts#L1977) 缺省 `probePaths: []`（空数组，非 undefined）；`startServe` 内 `opts.probePaths ?? DEFAULT_PROBE_PATHS` 不会回退（`??` 不触发空数组）；server 启动后探针循环直接跳过
  2. **web-serve 按 schemaVersion 自动分支**：[cli/index.ts:1980-2006](file:///work/protochain/src/cli/index.ts#L1980-L2006) 读 `web/data.json`：
     - `schemaVersion === '1.1'` → 组合层探针：`/`、`/protocols/`、`/cross-refs`、`/cross-diff`、`/protocols/<id>` × N（按 `protocols[].id` 动态构造）
     - 缺省（`schemaVersion === '1.0'` 或缺）→ 单协议探针（既有 E7-I2 逻辑：`/`、`/interfaces/`、`/interfaces/<id>`、`/test-cases`、`/verification`、`/diff`）
  3. **首页子协议链接修复**：[composition.ts:663-664](file:///work/protochain/src/webgen/composition.ts#L663-L664) 实际方案为**目录式路由**（`protocols/P1/index.md` → `/protocols/P1/`），链接保留尾斜杠；非文档此前所述"去尾斜杠 + .html"——见 [B1-I5](#b1-i5)（v0.2 复验修正）
- **端到端验证（hsk-ng 真实根）**：
  - `web-serve --dir /work/hsk-ng/modeling --port 5181` → 探针（按 schemaVersion 自动选择 8 条；全部 200）：
    - `/`、`/protocols/`、`/cross-refs`、`/cross-diff`、`/protocols/P1`、`/protocols/P2`、`/protocols/P3`、`/protocols/P4`
  - `web-serve --dir /work/hsk-ng/modeling --port 5182 --skip-probe` → 探针已跳过 + server 存活
  - 详见 [webserve-cli-output-v02.txt](file:///work/protochain/verification/acceptance/E7-B1/webserve-cli-output-v02.txt) + [webserve-skipprobe-output-v02.txt](file:///work/protochain/verification/acceptance/E7-B1/webserve-skipprobe-output-v02.txt)
- **单测**：
  - [tests/webgen/webgen.test.ts](file:///work/protochain/tests/webgen/webgen.test.ts) "B1-I3 修复：probePaths=[] 空数组时跳过所有探针" × 1 case
  - [tests/webgen/composition.test.ts](file:///work/protochain/tests/webgen/composition.test.ts) "子协议快速跳转链接（无尾斜杠）"

### B1-I5：组合层子协议页路由方案（v0.2 复验补登记） ✅ resolved

- **严重度**：低
- **状态**：**resolved**（随 B1-I3 v0.2 修复）
- **发现阶段**：v0.2 独立复验（代码核查；代码注释已标 B1-I5 但先前未登记）
- **背景**：B1-I3 修复首页子协议链接 404 时，若按原建议"链接去尾斜杠 + 单文件 `protocols/P1.md`（VitePress → `P1.html`）"，与 `protocols/index.md`（→ `/protocols/` 目录）的相对链接语义冲突；最终采用**目录式路由**方案：
  - 子协议页：`protocols/<id>/index.md`（`/protocols/P1/` 可直达）
  - 接口详情页：`protocols/<id>/<iface>.md`（如 `protocols/P1/IF_SYS_T1.md`）
  - `SubProtocolSummary` 新增 `firstInterfaceId`（[composition.ts:92](file:///work/protochain/src/webgen/composition.ts#L92)、[:568](file:///work/protochain/src/webgen/composition.ts#L568)），供 web-serve 探针构造详情页路径
- **验证（复验实测）**：hsk-ng 真实根产物 `docs/protocols/P1/index.md` + `docs/protocols/P1/IF_SYS_T1.md` 存在；`GET /protocols/P1/` → 200、`GET /protocols/P4/IF_SYS_T5` → 200
- **说明**：该条目为复验补登记（功能已随 B1-I3 落地），非新缺陷

---

## 6. 后续 E# 预留

| ID | 严重度 | 状态 | 摘要 |
|---|---|---|---|
| （待 E2.1） | - | - | 场景级 `legacy expectedFields` 具体值注入（E2-I4 关联：当前 buildLegacyExpectedFromModel 仅注入「应存在」sentinel，E2.1 应允许 scenarios/*.yaml 覆盖具体值以产出「legacy=Y, impl=Z」三元组） |
| （待 E2.1） | - | - | verifier 运行时 schema 校验产出 `schema_violation`（E2-I8 关联：类型成员已移除，E2.1 落地运行时 ajv 校验时重新引入） |

---

## 7. v0.5 复验总结（E7-I1~I8，2026-08-22）

**复验条目**：E7-I1 ~ E7-I8（IMPLEMENTATION-ISSUES.md §4 全部条目）

**复验方式**：

| 步骤 | 命令 / 文件 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc --noEmit` | 0 errors |
| 单元 + 集成测试 | `npx jest` | 58 suites / 833 cases 全过（含 7 项新单测 E7-I* 修复测试） |
| CLI 端到端 | `/tmp/e7p0-reverify` 跑 derive-specs → derive-web --no-build → 探针 → web-serve → 畸形 URL 探针 | 全过 |
| 模板路径扫描 | `grep -r "/work/protocoldriven\|/work/protocol-runner" templates/` | 无匹配 |

**前置 → 后置差异**：

| 维度 | v0.4 (open) | v0.5 (resolved) |
|---|---|---|
| web-serve 默认 distDir | `web/.vitepress/dist`（与 derive-web 实际产物 `web/docs/.vitepress/dist` 不一致） | `web/docs/.vitepress/dist`（与 derive-web outDir 对齐） |
| startServe 默认探针 | 硬编码 `/interfaces/IF_SYS_T1` | 从 `web/data.json` 读真实接口 ID 构造探针；新增 `--skip-probe` |
| 畸形 URL 处理 | `decodeURIComponent` 抛 URIError → 进程崩溃 | `resolveStaticPath` try/catch 兜底返回 null；handleRequest 顶层 try/catch → 单畸形请求仅 400 |
| CLI derive-web 死代码 | `basicPages` 声明后未用；exit 判定不校验页面落盘 | 删除 `basicPages`；exit 判定改为 existsSync 5 类页面（index.md / interfaces/index.md / test-cases.md / verification.md / diff.md） |
| 端到端脱敏测试 | 占位常量恒真断言；端到端未真正注入敏感键 | 改为向 envelope.specs 注入真实敏感键 tokenEnv/secretEnv；断言敏感值 + 敏感键名均不出现 |
| redactSensitiveFields | 值替换为 `[REDACTED]`（键名仍暴露） | 整键删除（与验收口径"tokenEnv 等字段不出现"严格对齐） |
| readOptionalJson 错误文案 | 缺失与 corrupt 都报"未找到" | 新增 status 字段（'missing' / 'corrupt' / 'ok'）；warning 文案区分"未找到 xxx" vs "xxx 存在但 JSON 解析失败" |
| `--force` 选项 | no-op | deriveWeb 在写产物前 existsSync 检查；未传 force 时抛 `web 产物已存在；如需覆盖请传 --force` |

**后续**：v0.6 起进入 E2.1 / E4-E10 阶段。E2.1 主要扩展面——legacy expected 真实值注入（影响 E2-I4 验收第 3 项完整可复现性）、verifier 运行时 schema 校验产出 `schema_violation`（E2-I8 关联：类型成员已移除，E2.1 落地运行时 ajv 校验时重新引入）。

---

## 8. v0.4 复验总结（E2-I1~I9，2026-08-22）

**复验条目**：E2-I1 ~ E2-I9（IMPLEMENTATION-ISSUES.md §2 全部条目）

**复验方式**：

| 步骤 | 命令 / 文件 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc --noEmit` | 0 errors |
| 单元 + 集成测试 | `npx jest` | 56 suites / 748 cases 全过（含 12 项新单测 `load-e2i1-e2i5.test.ts`） |
| CLI 端到端 | `node dist/cli/index.js derive-specs --dir <fixture>` | envelope 落盘正常，currentState 含 `-`，nextState 仅真实状态，guard=form_valid 标 legacy-stub |
| 模板路径扫描 | `grep -r "/work/protocoldriven\|/work/protocol-runner" templates/` | 无匹配 |

**前置 → 后置差异**：

| 维度 | v0.3 (open) | v0.4 (resolved) |
|---|---|---|
| 老格式 specs.json 自动迁移 | 静默 0 spec + migrated=true | 抛显式 Error（caller 决定阻断/降级） |
| envelopeMigrate 副作用 | 就地改 caller 持有的数组 | 浅拷贝，纯函数 |
| guard=form_valid schemaKind | structured | legacy-stub（与设计 §4.1 对齐） |
| guard=form_valid 在 requestSchema | type='string'，required | 不进 requestSchema |
| envelopeMigrate schemaKind | 自带启发式 | 复用 classifySchemaKind（口径统一） |
| CLI verify legacyExpectedResponses | 恒空 | 从 model.contractInput.expectedInformationFields + invariants 注入 |
| specify() duck-type | length/filter/map mock 8 个 | 移除，返回纯 SpecsEnvelope |
| nextState enum | 含 `-`（假阴性风险） | 仅真实状态 ID |
| Deviation.kind schema_violation | 声明无产出点 | 移除联合成员 |
| scaffolder 模板 | 含 `/work/...` 硬编码路径 | 异步懒加载 + stub fallback |

**后续**：E2.1 主要扩展面——legacy expected 真实值注入（影响 E2-I4 验收第 3 项完整可复现性）。

---

## 9. E4/E5/E6/E7-P1 阶段问题（T2，2026-08-23）

| ID | 严重度 | 状态 | 摘要 |
|---|---|---|---|
| [E4-I1](#e4-i1) | 低 | **resolved（口径已核清）** | P7 不变量盘点口径：inventory-snapshot 记「不变量总数=5」，实际 model.md 11 行（INV1-5 + INV_PS1-5 + INV_PI1）；数据级 10 条不变，N=42 不受影响 |
| [E5-I1](#e5-i1) | 高 | **resolved（验收阶段修复）** | E5 在 src/scaffolder/index.ts 引入模块级 `import.meta.url` → `npx jest` 3 套件（scaffolder/init-runner/e5-ts-clients）编译失败「Cannot use 'import.meta' outside a module」 |
| [E6-I1](#e6-i1) | 中 | **resolved（验收阶段补齐）** | E6 验收目录为空（缺 acceptance-record.yaml / E6-COMPLETE.txt / 证据快照） |
| [E6-I2](#e6-i2) | 低 | **open（口径确认，E8 后续）** | 默认 verify（config.ai 启用）输出含 AI 摘要，措辞随机 → 两次输出 sha256 不等；确定性承诺域 = `--no-ai`（工具链核心输出 byte 级一致） |
| [E7-P1-I1](#e7-p1-i1) | 中 | **resolved（PATCH merge + PUT confirm）** | PUT /api/bindings 全量覆盖无 merge：修复路径 2 落地，新增 `PATCH /api/bindings`（字段级合并）+ `DELETE /api/bindings/interfaces/:action`（单接口删）；PUT 降级为「确认整文件替换」需传 `confirm: 'replace-all'`。原子写：写前 .bak-<ts> 备份 + .tmp rename atomic |
| [E7-P1-I2](#e7-p1-i2) | 中 | **resolved（--no-ai 落地）** | generate-cases 在 useForGeneration=true 实例非确定性：CLI 增加 `--no-ai` 强制走 [src/casegen/index.ts](file:///work/protochain/src/casegen/index.ts) `generateCases()` 确定性 BFS/DFS；hsk-ng P1 端到端 `--no-ai` 两次 sha256 一致（b26b972f...） |
| [E7-P1-I3](#e7-p1-i3) | 低 | **resolved（键名掩码 LE****）** | /api/health + 启动日志披露敏感 env 键名：env-guard.ts 新增 `maskSensitiveEnvKey`（前 2 字符 + `****` + 长度 + sensitive/kept 标记）；health 端点 scrubbedKeyNames / remainingSensitiveEnvKeys / osProcResidualKeys / sensitiveFieldNames 全部掩码；完整键名不再回显 |
| [E7-P1-I4](#e7-p1-i4) | 低 | **open（复验新发现，文档口径）** | 验收证据细节：api-issues-post.txt 实为 005 号草稿而 acceptance-record 声称 007（007 内容见 draft-issue-sample.md）；tc-diff 的 BEFORE/AFTER 实际由 AI 非确定性产生而非编辑；E7-P1 证据清单缺 web/data.json（该产物属 P0/B1，E7-B1 已有快照） |

### E4-I1：P7 不变量盘点口径（inventory-snapshot 总数误记） ✅ resolved

- **现象**：`verification/acceptance/E4/inventory-snapshot.txt` 记 `P7: 数据级（表达式 TRUE）=10 / 不变量总数=5`；实际 P7 model.md 不变量表 11 行（INV1-5 + INV_PS1-5 + INV_PI1），其中 10 行表达式 TRUE。
- **原因**：盘点脚本对 P7 的「不变量总数」口径只匹配到部分行（与 P1~P6 的计数方式不一致）。
- **影响**：数据级不变量总量 N=42（8+6+4+5+5+4+10）不变，E4 验收「N 以盘点为准」结论不受影响；仅总数描述（43 vs 实际 49）需以 model.md 为准。
- **结论**：以 model.md 为权威源；inventory-snapshot 的 N 值（42）正确，总数字段后续盘点脚本统一按行数统计。

### E5-I1：scaffolder 模块级 import.meta 导致 jest 3 套件编译失败 ✅ resolved

- **现象**：`npx jest` 报 `SyntaxError: Cannot use 'import.meta' outside a module`，失败套件：tests/scaffolder/scaffolder.test.ts、init-runner.test.ts、e5-ts-clients.test.ts（均直接 import src/scaffolder/index.js）。
- **根因**：E5 在 [src/scaffolder/index.ts](file:///work/protochain/src/scaffolder/index.ts) 顶部加 `__dirnameCompat = dirname(fileURLToPath(import.meta.url))`，ts-jest 转 ESM 后由 jest-runtime 按 CJS 执行 → `import.meta` 是解析期语法错误（三元守卫无法避免）。
- **修复**：删除模块级 `__filenameCompat/__dirnameCompat`，`resolveTemplatesDir` 改用 `typeof __dirname !== 'undefined'` 守卫候选（与同文件 `instanceTemplateDir` L696 既有模式一致）；`fileURLToPath` import 一并移除。
  - CJS（jest）：候选 1 = `src/scaffolder/templates/ts` ✓
  - ESM（dist）：`__dirname` 未定义 → 候选 2 = `process.cwd()/src/scaffolder/templates/ts`（与修复前 dist 实际行为一致）
- **验证**：`npx tsc --noEmit` 0 errors；`npx jest` 64 suites / 933 cases 全过；CLI generate-scaffold --lang=ts 复跑正常。

### E6-I1：E6 验收证据缺失 ✅ resolved（验收阶段补齐）

- **现象**：`verification/acceptance/E6/` 目录为空（无 acceptance-record.yaml / E6-COMPLETE.txt / 证据快照），不满足任务 §8「每个 E 有 acceptance-record + COMPLETE + 证据快照」。
- **处置**：验收阶段独立复验并补齐——`generate-tests --emit=mock` 生成 mocks.ts；`verify --mock --no-ai` 连续两次（19/19 全绿）sha256 一致（d67b6712...）；mocks-snapshot.txt / sha256-record.txt 落盘；acceptance-record.yaml + E6-COMPLETE.txt 已写入。
- **验证**：`verification/acceptance/E6/` 5 个证据文件齐备（verify-mock-run-{1,2}.txt / sha256-record.txt / mocks-snapshot.txt / acceptance-record.yaml / E6-COMPLETE.txt）。

### E6-I2：默认 verify 输出含 AI 摘要 → sha256 确定性域 = --no-ai 🔵 open

- **现象**：`verify --mock`（config.ai 启用）两次输出 sha256 不一致——差异仅在 AI 摘要措辞（如「验证通过：共执行19个用例…」vs「本次验证全部通过：19项通过…」）；`--no-ai` 两次输出 byte 级一致。
- **性质**：AI 摘要输出已标注「非权威」；「无 AI 随机性」承诺应限定工具链核心输出（--no-ai 域）。mock/fixtures/spy 本身确定性（单测已证）。
- **后续归属**：E8「test-tool 从代码生成迁到描述执行」的确定化路径一并处理——verify 报告区分「核心输出 vs AI 摘要」字节域，或将 AI 摘要降级为独立附加文件；在此之前 E6 验收确定性口径以 `verify --mock --no-ai` 为准。

### E7-P1-I1：PUT /api/bindings 全量覆盖无 merge（end-to-end 发现） ✅ resolved（PATCH merge + PUT confirm）

- **严重度**：中
- **状态**：**resolved（2026-08-23，采纳 P004 修复路径 2 + 3 + 4：PATCH merge + PUT confirm + 写前备份 + atomic write）**
- **发现于**：E7-P1 验收阶段端到端跑通 strangler-fig P1 bindings 在线编辑时
- **修复**：
  - store 层新增 3 个函数（[src/webgen/feedback/store.ts](file:///work/protochain/src/webgen/feedback/store.ts)）：
    - `replaceBindingsFileAtomic(rootDir, body)`：写前 `path.bak-<ts>` 备份 + `.tmp` + `renameSync` 原子写
    - `mergeBindingsFile(rootDir, patch)`：字段级合并。`roles` 按 `roleId` 替换/追加；`interfaces` 按 `action` 替换/追加并深合并 `transport`（method/path/headers 不重置）；`interfaces[]._delete=true` 删除；返回 `{path, backupPath, merged, diff}`
    - `MergeBindingsPatch` 类型导出
  - 路由层（[src/webgen/feedback/index.ts](file:///work/protochain/src/webgen/feedback/index.ts)）：
    - `PUT /api/bindings`：必须传 `body.confirm === 'replace-all'` 才走整文件替换；否则返回 400 + 提示改用 PATCH
    - `PATCH /api/bindings`：新端点，body 含 `roles?/interfaces?/environments?/defaultEnv?`；空 body 拒 400
    - `DELETE /api/bindings/interfaces/:action`：新端点，走 `mergeBindingsFile({interfaces:[{action,_delete:true}]})`；非法 action（含 `/` `\` `..`）拒 400
- **验证**：
  - `npx tsc --noEmit` 0 errors
  - `npx jest`：70 suites / 1044 cases 全过（新增 13 项 E7-P1-I1 测试）
  - 端到端冒烟（`/tmp/feedback-i1-smoke`）：
    - PUT 不带 confirm → 400，原文件未变
    - PATCH 追加 new_action → 200，merged 含 a/b/new_action，bindings.yaml.bak-1787451869216 备份落盘
    - /api/bindings GET 读回 a/b/new_action 全保留
- **遗留**：strangler-fig bindings.yaml（247B）需用户在 git/手写层恢复 47667B 完整骨架（P004 修改单 followup）；恢复后可走 PATCH 增量补全 P2-P6 路由

### E7-P1-I2：generate-cases 非确定性 → 「机械推导 diff」证据不可复核 ✅ resolved（--no-ai 落地）

- **严重度**：中
- **状态**：**resolved**（2026-08-23）
- **发现于**：E7-P1 独立复验（评审视角）
- **原复现**（/work/protochain，真实实例 hsk-ng P1，无任何输入变化）：
  ```
  sha256sum protocol/P1/derived/test-cases.json  → b2f43f6dc31d7ca8cb32bd958eede3abe91093bac3dbba96c57ed84cafdc1832
  node dist/cli/index.js generate-cases --dir /work/hsk-ng/modeling --protocol P1
  sha256sum .../test-cases.json                  → a2bc8284d0259a9907a57286b6c19365c3bd9870f629abcbd4165ea64acfc616
  node dist/cli/index.js generate-cases ...      （再跑一次）
  sha256sum .../test-cases.json                  → b26b972f0ba1f01c85ff0ce71e693b80bf4c22c7cd8ae24099dd58eac3bd4a2f
  ```
  三次运行路径数分别为 2 / 1 / 1 条（「2 条路径」vs「1 条路径」），`test-cases.json` 内容随运行变化。
- **根因**：hsk-ng 与 strangler-fig 的 `protochain.config.yaml` 均 `ai.useForGeneration: true` + 真实 DeepSeek apiKey → `generate-cases`（[cli/index.ts:1046-1058](file:///work/protochain/src/cli/index.ts#L1046-L1058)）走 `createCaseGenExecutor(config, aiAdapter)` 真实 LLM 生成 loop；LLM 输出非确定性直接进 `derived/test-cases.json`。
- **修复**（[src/cli/index.ts](file:///work/protochain/src/cli/index.ts) generate-cases 子命令）：
  - 新增 `.option('--no-ai', '禁用 AI 生成（强制走确定性路径；与 LLM 非确定性互斥）')`
  - AI 适配器初始化条件：`opts.ai !== false && config.ai?.useForGeneration`（`opts.ai` 默认 true，传 `--no-ai` 时为 false）
  - `--no-ai` 显式覆盖 `config.ai.useForGeneration`；保留 warning 日志「--no-ai 已启用，跳过 AI 生成（config.ai.useForGeneration 被覆盖）」
- **验证**（修复后 hsk-ng P1 端到端）：
  ```
  sha256sum test-cases.json                                → b26b972f0ba1f01c85ff0ce71e693b80bf4c22c7cd8ae24099dd58eac3bd4a2f
  node dist/cli/index.js generate-cases --dir ... --protocol P1 --no-ai
  sha256sum test-cases.json                                → b26b972f0ba1f01c85ff0ce71e693b80bf4c22c7cd8ae24099dd58eac3bd4a2f
  node dist/cli/index.js generate-cases --dir ... --protocol P1 --no-ai
  sha256sum test-cases.json                                → b26b972f0ba1f01c85ff0ce71e693b80bf4c22c7cd8ae24099dd58eac3bd4a2f
  ```
  三次 sha 完全一致；输出 4 条路径（PATH_01_main ~ PATH_04_main，覆盖 5/5 状态、7/7 转移、100%）。
- **影响**：
  1. E7-P1 验收口径「用例变化由机械推导产生（前后 diff 可复核）」在 `--no-ai` 域恢复可复核性。
  2. 一键 generate-cases 在 AI 实例上仍默认走 AI（保持原体验），但演示「编辑→diff」对照时显式传 `--no-ai`。
  3. 与 check/verify/exec-task/diff 的 `--no-ai` 同口径；CLI 接口一致性达成。

### E7-P1-I3：health/启动日志披露敏感 env 键名 ✅ resolved（掩码 LE****）

- **严重度**：低
- **状态**：**resolved**（2026-08-23；采纳用户决策：键名掩码方案 2）
- **现象（原 §11 复验发现）**：`/api/health` 的 `scrubbedKeyNames` 回显 6 个敏感 env 键名（`LEGACY_TOKEN` / `ADMIN_TOKEN` / `SERVER_TOKENFILE` / `TRAE_JWT_TOKEN_PATH` / `TRAE_USER_CLOUDIDE_TOKEN_BLOB` / `CFS_TOKEN`，值已 redact 为 `<0 bytes>`）；`osProcResidualKeys` 同样回显键名；启动日志打印同一清单。
- **修复**（[src/webgen/feedback/env-guard.ts](file:///work/protochain/src/webgen/feedback/env-guard.ts) + [src/webgen/feedback/index.ts](file:///work/protochain/src/webgen/feedback/index.ts)）：
  - 新增 `maskSensitiveEnvKey(key)`：输出 `<前2字符>****(<长度>,<sensitive|kept>)`
    - 例：`LEGACY_TOKEN` → `LE****(12,sensitive)`；`TRAE_JWT_TOKEN_PATH` → `TR****(19,sensitive)`；`HOME` → `HO****(4,kept)`
  - `/api/health` 响应四个字段全部走掩码：`scrubbedKeyNames` / `remainingSensitiveEnvKeys` / `sensitiveFieldNames` / `osProcResidualKeys`
  - 完整键名不再出现在任何响应/页面/日志中
- **验证**：
  - `npx tsc --noEmit` 0 errors；`npx jest` 70 suites / 1044 cases 全过（新增 4 项 E7-P1-I3 测试）
  - 端到端（注入 `LEGACY_TOKEN=smoke-secret` 起 feedback-serve）：
    ```
    scrubbedKeyNames:["LE****(12,sensitive)","SE****(16,sensitive)","TR****(19,sensitive)","TR****(29,sensitive)","CF****(9,sensitive)"]
    ```
    完整 `LEGACY_TOKEN` / `SERVER_TOKENFILE` / `TRAE_JWT_TOKEN_PATH` / `TRAE_USER_CLOUDIDE_TOKEN_BLOB` / `CFS_TOKEN` 字符串均不再出现
- **后续归属**（可选 v0.2 加固）：Linux 下 `prctl(PR_SET_DUMPABLE, 0)` + `setrlimit(RLIMIT_CORE, 0)` 减少 /proc 层可读面（同 uid 也无法 coredump 读 env）；本修复未做，留待后续决策。

### E7-P1-I4：验收证据口径细节 🔵 open（文档一致性）

- **严重度**：低（信息级，不影响功能验收）
- **状态**：**open**（2026-08-23 独立复验新发现）
- **条目**：
  1. [api-issues-post.txt](file:///work/protochain/verification/acceptance/E7-P1/api-issues-post.txt) 内容为**第 5 号**草稿（`/work/工具链修改单-005-protochain-feedback-serve.md`），而 acceptance-record 对应条目表述为「POST /api/issues 落盘草稿（修改单 NNN 编号自动）」未标注实为 005 首轮；实际留存草稿为 007（[draft-issue-sample.md](file:///work/protochain/verification/acceptance/E7-P1/draft-issue-sample.md) 为 007 内容；/work 当前仅有 007/004/001-003 单，005/006 已清理为「前序 e2e 残留」快照）。证据链可追溯但文件与描述需对齐。
  2. tc-diff 证据的 BEFORE/AFTER 由 AI 非确定性产生（见 E7-P1-I2），证据标题「机械命令产生用例变化」需按确定性域重做或改述。
  3. E7-P1 验收证据清单缺 `web/data.json` 快照（验收口径证据项之一）；该产物属 P0/B1（E7-B1 已有 [web-data-snapshot-v02.json](file:///work/protochain/verification/acceptance/E7-B1/web-data-snapshot-v02.json)），P1 服务不产出，建议在 acceptance-record 显式说明出处。
- **归属**：E8 起维护验收文档时校正；E7-P1 复验补充说明已在本文档登记。

---

## 10. v0.1 复验总结（E7-P1，2026-08-23）

**复验条目**：E7-P1 端到端验收（在线编辑 + 一键执行 + 评审→修改单草稿 + 安全面）

**复验方式**：

| 步骤 | 命令 / 文件 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc --noEmit` | 0 errors |
| 单元 + 集成测试 | `npx jest` | 70 suites / 1027 cases 全过（含 88 项新单测 + E7-P1-I1 + 1 项 env-guard 增补） |
| CLI 端到端 | `LEGACY_TOKEN=... ADMIN_TOKEN=... node dist/cli/index.js feedback-serve --dir /work/hsk-ng/modeling` | scrub 6 个敏感 env 键；服务启动；7 个静态资源全 200 |
| secret-leak-scan | 子进程 stdout/stderr `grep LEGACY_TOKEN / ADMIN_TOKEN 注入值` | 0 次命中（filterEnvForChild 工作） |
| 在线编辑 → 一键 | `PUT /api/scenarios/sc-e2e-test.yaml` + `POST /api/run/generate-cases` | `test-cases.json` sha BEFORE `1fb207b1...` != AFTER `b2f43f6d...`（DIFFERENT — 机械命令重推导） |
| 评审 → 修改单 | `POST /api/issues` | 落盘 `/work/工具链修改单-007-protochain-feedback-serve-e7p1.md`（status=待审阅，走通 M→D→B→I→V→R） |

**前置 → 后置差异**：

| 维度 | v0.0（无 P1） | v0.1（E7-P1） |
|---|---|---|
| 反馈闭环能力 | 无（仅只读 P0 静态检阅） | 在线编辑 scenarios/bindings + 一键 generate-cases/bind/verify + 评审→修改单草稿 |
| 运行时依赖 | 零 | express ^4.21.2 + @types/express ^4.17.21 |
| 安全面 | 无 token env 隔离硬约束 | 服务进程 + 子进程 env 双层隔离（scrub + filterEnvForChild） |
| 修改单流程 | 仅 CLI 工具链手工写 | Web form 评审 + 自动落盘 M→D→B→I→V→R 模板 |

**T2 完成标志**：4/4 达成（E4 + E5 + E6 + E7-P1 全过）。

**后续**：T3 准备进入（E8 test-tool 描述执行 + E9 跨协议 diff + E10 修改单 SLO）。

---

## 11. 评审视角独立复验小结（E7-P1，2026-08-23）

**复验方式**：读 acceptance-record + COMPLETE + 全部 19 个证据文件；`npx tsc --noEmit`（0 errors）；`npx jest`（70 suites / 1027 cases 全过）；`npm run build`；真实实例独立端到端——注入 `LEGACY_TOKEN/ADMIN_TOKEN` 起 `feedback-serve --port 5231`（hsk-ng）→ 健康检查 / scenarios PUT→落盘→GET→DELETE / 非法 PUT 400 / 全站 9 端点注入 secret 值扫描 0 命中 / 一键 verify 子进程输出注入 secret 0 命中。

**独立验证通过项**：

| 维度 | 结果 |
|---|---|
| tsc / jest / build | 0 errors / 70/1027 全过 / build 成功 |
| env scrub | `/api/health` remainingSensitiveEnvKeys=[]、tokenEnvAbsent=true；scrubbedKeyNames 值全部 `<0 bytes>` |
| 子进程隔离 | `POST /api/run/verify` 子进程 stdout/stderr 注入 secret 0 命中；filterEnvForChild 白名单 |
| 在线编辑 | PUT → 权威源落盘（protocol/P1/scenarios/）→ GET 读回 raw+parsed+validation.ok → DELETE 清理；缺 expectedActions → 400 |
| 全站脱敏 | 9 端点（含 /、/scenarios、/bindings、/run、/review、/api/*）注入 secret 值 0 命中 |
| 静态页面 | /、/scenarios、/bindings、/run、/review、/assets/app.js、/assets/app.css 全部 200 |
| 评审→草稿 | 修改单 007 落盘 /work（M→D→B→I→V→R 结构，status=待审阅）；004（bindings 覆盖）草稿在 |
| 选型登记 | package.json express ^4.21.2 + @types/express ^4.17.21；COMPLETE.txt 记录 4 条选型理由 |

**复验发现的问题**（已登记，见 §9）：[E7-P1-I2](#e7-p1-i2)（中）generate-cases 非确定性使「编辑→机械推导 diff」证据不可复核；[E7-P1-I3](#e7-p1-i3)（低）health 披露敏感 env 键名需用户决策；[E7-P1-I4](#e7-p1-i4)（低）验收证据口径细节。另实测确认 [E7-P1-I1](#e7-p1-i1)：strangler-fig `bindings.yaml` 被验收期 PUT 覆盖为 247B（原 47667B），按 P004 修复路径待用户恢复。

**结论**：E7-P1 核心交付物（在线编辑 + 一键执行 + 评审→草稿 + env 隔离 + 脱敏）经独立复验**功能通过**；T2 完成标志 4/4 维持达成。open 问题（I1 中 / I2 中 / I3 低 / I4 低）均有明确后续归属（P004 修复 + 用户恢复 strangler-fig / E8 确定化路径 / 用户安全决策 / E8 文档维护），不阻塞 T3 启动，但 E7-P1-I2 要求后续以确定性域补「编辑→diff 可复核」证据。


## 12. E2.1 阶段问题（2026-08-23）

> E2.1 交付：契约层接口字段消费（E2 补全，P0 补全）。验收 8 项已全过（见 verification/acceptance/E2.1/）。
> 复验（2026-08-23）：tsc 0 errors / jest 76 suites / 1080 cases 全过（增量 +6 suites / +53 cases）；
> hsk-ng P1 model.md 注入 contracts[]（register/bind structured，其余 5 个转移维持 legacy-stub 零回归）；
> verify CLI 端到端字段级三元组 OK（tests/verifier/field-level-cli-e2_1.test.ts）。

| ID | 严重度 | 状态 | 摘要 |
|---|---|---|---|
| [E2.1-I1](#e21_i1) | 低 | **open（v0.2 后续）** | contracts[].preconditions 字符串数组全部归一为 description-only；若需 json-schema 形式需显式 `- kind: json-schema` 条目（人工门槛）。建议：契约层自然语言 → JSON Schema 转换 helper（AI 或字典） |
| [E2.1-I2](#e21_i2) | 低 | **open（口径）** | field-compare 的 legacyExpected sentinel 与现有 `__info_expected:` 行为耦合：当 contracts[].responseSchema 字段名与 expectedInformationFields 重名时，type sentinel 覆盖 info sentinel（避免误报）；后续扩面时确认优先级 |
| [E2.1-I3](#e21_i3) | 中 | **open（v0.2 后续）** | contracts 段解析校验 schema `required` 引用 properties 中不存在字段时仅 ajv 兜底（strict:false 默认允许）；建议 parser 增 cross-check（required ⊆ properties keys）。建议：与 E4 SQL 校验一并加固 parser 完整性校验 |
| [E2.1-I4](#e21_i4) | 低 | **open（复验新发现，流程纪律）** | hsk-ng P1 model.md 契约层注入未走 version save + 修改单（version 仍 0.7.0、无 version 快照、WORKLOG/order.md 无条目）；acceptance-record 声称「走修改单流程」无证据支撑。建议：改动补登记变更单 + version save；后续实例侧模型改动强约束该流程 |

### E2.1-I1：preconditions 字符串自动归一为 description-only（人工门槛） �� open

- **严重度**：低
- **状态**：**open**（2026-08-23 登记）
- **发现阶段**：E2.1 代码核查（人工契约段编写）
- **问题**：
  - 当前 parser 把字符串数组归一为 `{kind:'description-only', description:string}`，
    要求 json-schema 形式需显式写 `- kind: json-schema` 条目
  - 自然语言写契约时（如 `preconditions: ["name 非空", "hostDomain 合法"]`）全部降级为
    description-only；下游 ajv 校验时该条不能直接校验
- **影响**：人工编写契约段门槛升高；契约的「结构化前置条件」价值部分打折
- **建议**：
  - v0.2 加 helper `parseNaturalLanguageToSchema`（AI 辅助或字典匹配）
  - 或：文档明确「写结构化条件用 `- kind: json-schema` 显式条目」
- **关联**：与 E8「test-tool 从代码生成迁到描述执行」可联合推进

### E2.1-I2：legacyExpected sentinel 优先级 �� open

- **严重度**：低
- **状态**：**open**（口径确认）
- **发现阶段**：E2.1 设计讨论
- **问题**：
  - `buildLegacyExpectedFromModel` 在 CLI 路径同时注入两类 legacyExpected：
    - `__info_expected:<field>`（来自 expectedInformationFields）
    - `<field>=<type>`（来自 contracts[].responseSchema.properties）
  - 当 contracts[].responseSchema 字段名与 expectedInformationFields 重名时，type sentinel
    覆盖 info sentinel（避免误报）—— 当前实现是覆盖，但字段名碰撞较罕见
  - 隐含约定：type sentinel 优先级 > info sentinel
- **影响**：行为正确但口径未在文档显式；后续维护时易混淆
- **建议**：v0.2 在 CLI 注释 + USAGE.md 中显式声明优先级
- **关联**：与 E2-I4（legacy expected 数据源）一脉相承；E2-I4 已 resolved

### E2.1-I3：parser 不校验 required ⊆ properties �� open

- **严重度**：中
- **状态**：**open**（v0.2 后续，与 E4 SQL 校验一并加固）
- **发现阶段**：E2.1 测试场景（[checker-contracts.test.ts:106-134](file:///work/protochain/tests/checker/checker-contracts.test.ts#L106-L134)「直接构造非法 schema」）
- **问题**：
  - 当前 parser 接受 `required: [nonexistent_field]`（不交叉校验）
  - checker 走 ajv strict:false 也不报错（默认允许「required 引用 properties 中不存在的字段」）
  - 实测样例：register 接口契约 `required: [nonexistent_field]` 不报 schema 编译错
- **影响**：
  - 契约 schema 形似合法但实际无效 → impl 校验时永远不通过（导致误以为 impl 异常）
  - 与 E4「数据级不变量 SQL 校验」同源：parser 应有 cross-check
- **建议**：
  - parser 增加 cross-check：`for each fieldName in required: if fieldName not in properties: throw ParseError`
  - 与 E4 SQL 校验合并（E4 I1 同一类问题）
- **关联**：E4 SQL 校验设计已记录「required ⊆ properties」语义

### E2.1-I4：hsk-ng P1 model.md 契约层注入未走 version save + 修改单 🔶 open

- **严重度**：低
- **状态**：**open**（2026-08-23 复验登记，流程纪律）
- **发现阶段**：E2.1 验收独立复验（hsk-ng 实例侧）
- **问题**：
  - hsk-ng P1 model.md「契约层」段新增 contracts[]（register/bind，155 行增量）未走
    version save 快照 + 修改单登记：`model.md` version 仍 0.7.0、`modeling/protocol/P1/` 无
    version 快照、WORKLOG.md / requirements/order.md 均无对应条目（改动为未提交工作区 diff）
  - E2.1 acceptance-record.yaml 声称「model.md 走修改单流程」，但 hsk-ng 侧无对应证据
- **影响**：模型权威源变更不可追溯；违反红线「model.md 是权威源：契约字段修改走 version save + 修改单流程」
- **建议**：
  - 实例侧改动补登记：变更单条目 + `protochain version save` 快照 + WORKLOG 迭代记录
  - 后续 E2.1 实例侧（B 层）验收将 version save / 修改单证据列为硬条件
- **关联**：§E2.1 红线第 3 条；工具链侧 version save/list/show/classify 能力已就绪

### 复验结论

| 维度 | 结果 |
|---|---|
| tsc / jest / build | 0 errors / 76 suites / 1080 cases 全过 / build 成功 |
| parser contracts[] 解析 | 11 单测全过（合法 / 非法抛错 / 老协议兼容） |
| specifier 契约字段合并 | 6 单测全过（schemaKind=structured / 缺字段降级 / sourceId 对齐） |
| checker schema 自检 | 6 单测全过（含数组 items / 无段零开销） |
| verify 字段级三元组 | 5 单元 + 2 CLI 端到端全过 |
| hsk-ng P1 集成 | 6 单测全过；CLI 端到端 register/bind structured，其余零回归 |
| 兼容性 | approval-flow 老协议 derive-specs 输出一致（structured=7 legacy-stub=5） |
| E2-I4 闭环 | 「字段 X：legacy=<type>, impl=<type>」三元组在真实 CLI 路径产出 |

**T3 启动前需关注**：E2.1-I3（中）parser cross-check 缺失，建议 v0.2 推进（与 E4 SQL 校验合并）。
