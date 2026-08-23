# Protochain 实现规划（Implementation Plan）

> 来源：`CORE-VALUE.md`（v0.3，2026-08-22）
> 范围：把 §4 五类缺口 + §6 演进方向 + 附录 B Web 检阅界面需求，合并为可执行的工程路线图
> 读者：protochain 工具链维护者、首次接触协议并想贡献改造的工程师
> 评估原则：
> 1. 不破坏"model.md 是唯一权威源"的根本目标（§1.3）
> 2. 优先修"权威性漏洞"（§7 三短板），其次"骨架生成"（§4.2），最后"工程化进阶"
> 3. §6 的 P0/P1/P2 顺序与 §7 三短板口径一致；附录 A.2 硬伤 3（§4 与 §6/§7 优先级自相矛盾）在本规划中**统一为 P0 = §7 三短板**

---

## 0. 总览：六大增强 + 优先级

| # | 增强（对应原文） | 优先级 | 类型 | 主要落地模块 | 关联价值 |
|---|---|---|---|---|---|
| E1 | M 单元语义闸门（§4.4 / §6 P0 / §7 短板1） | **P0** | 权威性 | 新增 `m-check`；specifier 命名规范；`llm-model` 替换 stub | V5 / V1 |
| E2 | specs.json 升级到 JSON Schema（§4.1 / §6 P0 / §7 短板2） | **P0** | 推导完整性 | specifier 重构；checker 适配；web 数据基 | V1 / 附录 B |
| E2.1 | 契约层接口字段消费（E2 交付物 #1/#2 补全，见 §E2.1） | **P0** | 推导完整性 | parser 契约层 contracts 段解析；specifier 契约字段生成 request/responseSchema | V1 / 附录 B |
| E3 | binding 骨架自动生成（§4.2 / §6 P0 / §7 短板3） | **P0** | 工程化 | 新增 `derive-bindings`；scaffolder 扩面 | V4 |
| E4 | 数据级不变量结构化声明 + SQL 校验（§4.3 / §6 P1） | P1 | 权威性边界扩张 | model.md schema 扩面；formalizer/verify 加 SQL 校验路径 | V1 |
| E5 | impl 语言 transport 客户端生成（§4.2 / §6 P1） | P1 | 工程化 | scaffolder TS 客户端模板（Go/Java 见 E5.1/E5.2） | V4 / V5 |
| E6 | Mock/Spy 自动生成（§4.2 / §6 P1） | P1 | 工程化 | testgen 扩面 | V3 |
| E7 | Web 检阅界面（附录 B / §6 P0 隐含） | **P0** | 价值放大 | 新增 `derive-web`；前端只读静态生成 | V1 / V6 / V3 |
| E8 | test-tool 从代码生成迁到描述执行（§4.5 / §6 P2） | P2 | 权威性 | testtool 重构 | V3 |
| E9 | 跨协议 diff + binding 影响分析（V6 缺口 / §6 P2） | P2 | 可追溯性 | differ 扩面 | V6 |
| E10 | 修改单 SLO + 跨实例聚合（V2 缺口 / §6 P2） | P2 | 工程纪律 | 问题清单扩面 | V2 |
| E11 | 接口错误契约 + 错误绑定（errorModeling；扩展 E2.1/E3/E7，方案见 [docs/error-modeling-plan.md](file:///work/protochain/docs/error-modeling-plan.md)） | **P0** | 权威性/契约完整性 | types / parser / specifier / checker / bindgen / binder / verifier / webgen | V1 / 附录 B |

> 优先级口径说明：
> - §6 原本 P0 含 E1/E2/E3；§7 短板口径同此。E7（Web）在 §6 列为隐含（附录 B 自述"应作为 §4.1 修复的落地场景"），本规划把 E7 提到 P0，因其是 E2 的最强反馈闭环。
> - §6 P1 含 E4/E5/E6；与 CORE-VALUE.md §6 一致。
> - §6 P2 含 E8/E9/E10；与 CORE-VALUE.md §6 一致。
> - **E11（错误契约/错误绑定）为 P0 新增项**：E2.1 契约层的错误侧扩展，依赖面（E2.1/E3/E7）已全部落地，属权威性缺口类（CORE-VALUE §1.2「契约完整性 ✗」）；随 T3 窗口前置并行、优先于 E8 启动。
> - 附录 A.2 硬伤 3 提及的"§4 与 §6/§7 优先级自相矛盾"已在此统一。

---

## 1. 增强详述

### E1. M 单元语义闸门（§4.4）★ P0

**问题**：`llm-model` 是 stub（`templates/protocol-runner-instance/project.yaml` 中 `executor: llm-model`），只校验存在+版本；命名规范/ID 转义/跨协议 ID 唯一性等问题只能在 D 阶段才被拦下（PITFALLS #4、修改单 001/002、019 单 `INV-PS1` → `INV_PS1`）。

**目标**：M 单元输出即代表"model.md 已经过语义闸门"，下游单元只做机械推导不再回头兜底。

**交付物**：
1. 新增独立命令 `m-check`：从 markdown AST 出发，对 model.md / composition.md 做静态校验
2. 校验项（首版，**与现有 checker 严格不重叠**——[checker/index.ts:495-512](file:///work/protochain/src/checker/index.ts#L495-L512) 已做 from/to 存在性，m-check 不重复）：
   - state ID 命名规范 `/^[A-Z]+_\w+$/`（与 §4.4 一致）
   - 跨协议 ID 唯一性（多协议场景下 INV_/US_/PS_ 不撞名）
   - 附属实体归属（§结构化段的"附属实体"表格行必须挂在某 state 下）
   - 旧字符（`-`、`/`、中文标点）禁用清单
   - ID 转义前置（参考修改单 002：SANY 解析层异常在 M 阶段拦截）
3. specifier 在 `derive-specs` 开头加一道 pre-check，**复用 m-check 规则集**（命名规范/旧字符/转义前置报错）；pre-check 与 E2 的 specifier 重构**同一个 MR 合并提交**，避免 T1 双份改动合并冲突
4. `llm-model` executor 不再是 stub：要么调用 m-check 生成可机读的 `model.check.json`，要么改为 `executor: code` 直接跑 `m-check.mjs`

**涉及模块**：
- 新建 `src/mcheck/index.ts` + `src/mcheck/rules/*.ts`
- 修改 [specifier/index.ts](file:///work/protochain/src/specifier/index.ts)（pre-check）
- 修改 `templates/protocol-runner-instance/project.yaml` 的 M 单元定义
- 新增 tests：`tests/mcheck/*.test.ts`（每条规则至少一条正向 + 一条反向用例）

**验收**：
- 019 单 `INV-PS1` 在 M 单元即被拦下，`state.json` 显示 M 单元 selfCheck 失败
- 修改单 001（SE 不可达）的 SE ID 在 M 单元即被命名规范拒绝

**依赖**：无

---

### E2. specs.json 升级到 JSON Schema（§4.1）★ P0

**问题**：specs.json 是"接口目录"而非"接口契约"——inputs/outputs 只有 `name+type+description`，guard/effects 正则提取只到名词层；实现者拿到 specs.json 仍要猜字段；verify 偏差只能对状态 ID 不能对业务字段。

**目标**：specs.json = 可机械断言的契约：每个接口有完整 JSON Schema（请求/响应）、前置条件 schema、后置条件 schema、副作用 schema。

**交付物**：
1. **model.md 契约层升级**：§2 契约层段（如 §4.1 所说，目前 USAGE §4.2 把 `expectedInformationFields` 放在文末——本规划要求把契约层段前置到 §2 而不是 §8 契约层段；附录 A.3 标注的"两句逻辑冲突"以 USAGE.md 为准核实后修正）。结构化字段：
   ```yaml
   contracts:
     - interface: do_something
       requestSchema: { type: object, properties: {...}, required: [...] }
       responseSchema: { type: object, properties: {...}, required: [...] }
       preconditions: [...]   # 结构化表达式
       postconditions: [...]
       sideEffects: [...]
   ```
2. **specifier 重构**：推导产出 `specs.json` 含 `requestSchema` / `responseSchema` / `preconditions` / `postconditions`；guard/effects 由结构化表达式生成（自然语言写法仍兼容，但降级为 `description-only` 节点，不进 schema）
3. **checker 适配**：读取新 schema，做 schema 自检（schema 必须可被标准 JSON Schema validator 通过）
4. **verify 升级**：偏差对比从"状态 ID"扩展到"业务字段"——双跑对账（V3）从可对比状态提升到可对比业务数据
5. **CLI 兼容**：旧 specs.json 加 schemaVersion 字段，老格式自动迁移 + 报警

**涉及模块**：
- 修改 [specifier/index.ts](file:///work/protochain/src/specifier/index.ts)（推导核心）
- 修改 [checker/index.ts](file:///work/protochain/src/checker/index.ts)
- 修改 [verifier/index.ts](file:///work/protochain/src/verifier/index.ts)
- 修改 model.md schema 与 USAGE.md（契约层段前置）
- 复用 [package.json:16](file:///work/protochain/package.json#L16) 已有的 `ajv@^8.17.1`，不新增依赖

**验收**：
- specs.json 通过 ajv 校验
- strangler-fig / hsk-ng 任一接口的 verify 偏差报告能列出"字段 X：legacy=Y, impl=Z"
- §4.1 三件套（name/type/description）兼容老协议，schema 缺失节点 `kind="legacy-stub"` 显式标记

**依赖**：是 E7（Web）的前置；E3（binding 骨架生成）依赖此输出的 schema

---

### E2.1. 契约层接口字段消费（E2 交付物 #1/#2 补全）★ P0

**问题**：E2 交付物 #1「model.md 契约层升级（`contracts` 段 + requestSchema/responseSchema）」与 #2「specifier 从契约字段生成 schema」未完整落地：
- [parser/index.ts](file:///work/protochain/src/parser/index.ts#L941-L991) `parseContractInput` 仅解析 `parties`/`expectedInformationFields`，**`contracts` 段从未被消费**（E2 已定义形态 L77-85 无解析代码）
- [specifier/index.ts](file:///work/protochain/src/specifier/index.ts#L71-L73) 接口仅从状态机转移派生，requestSchema 由 currentState+guard 参数机械拼装，**无「从契约层字段生成 request/responseSchema」路径**
- 实测 hsk-ng P1~P4 `specs.json` 接口**全部 `description-only`**（无字段级 I/O）；E2 验收第 3 项「字段 X：legacy=Y, impl=Z」在真实 CLI 不可复现（[E2-I4](file:///work/protochain/IMPLEMENTATION-ISSUES.md) open）
- 依赖面被阻塞：E3（interfaces[].method/path/params 从 requestSchema 机械推导）、E5（client 生成）、E7（接口详情字段表格）、verify 字段级对比（E2 交付物 #4）

**目标**：model.md 契约层可声明接口字段；specifier 机械产出结构化 `requestSchema`/`responseSchema`；specs.json 接口从 `description-only` 升级为 `structured`；verify 偏差对比从状态 ID 扩展到业务字段；E2 验收第 3 项真实 CLI 可复现。

**交付物**：
1. **parser 契约层 `contracts` 段解析**（[parser/index.ts](file:///work/protochain/src/parser/index.ts) `parseContractInput` 扩展），支持 E2 已定义形态（L77-85）：
   ```yaml
   contracts:
     - interface: do_something      # 对应转移派生接口 id（sourceId）
       requestSchema: { type: object, properties: {...}, required: [...] }
       responseSchema: { type: object, properties: {...}, required: [...] }
       preconditions: [...]          # 结构化表达式
       postconditions: [...]
       sideEffects: [...]
   ```
   - 契约条目与转移派生接口按 `interface`/`sourceId` 对齐合并；**无契约字段的接口维持 `description-only`/`legacy-stub`**（兼容老协议）
2. **specifier 契约字段合并路径**（[specifier/index.ts](file:///work/protochain/src/specifier/index.ts) `deriveSystemInterface`）：契约层有字段 → 用契约 requestSchema/responseSchema 覆盖 guard 派生 inputs；契约层缺字段 → 维持现状（currentState+guard 参数），行为零回归
3. **checker 适配**（[checker/index.ts](file:///work/protochain/src/checker/index.ts)）：契约 schema 必须可被 ajv 编译通过（schema 自检）
4. **verify 字段级对比接通**（E2 交付物 #4 补全，[verifier](file:///work/protochain/src/verifier/index.ts) / field-compare）：偏差报告列出「字段 X：legacy=Y, impl=Z」（E2-I4 闭环）
5. **CLI/迁移兼容**：老 specs.json 继续自动迁移；`structured` 与 `description-only` 并存（`schemaKind`/`kind` 标记区分）
6. **数据来源（实例侧，E2.1 落地步骤）**：hsk-ng 从已有 impl 一次性提取接口字段注入 model.md 契约层——Go struct（[storage/store.go](file:///work/hsk-ng/impl/portal/internal/storage/store.go) `Server`/`Mapping`/`Endpoint` 等）+ 路由表（[http/router.go](file:///work/hsk-ng/impl/portal/internal/http/router.go) action↔路由映射）+ Service Input/Result（`CreateInput`/`MappingResult` 等）；**model.md 为权威源、impl 作参考**，脚本产出 + 人工复核；impl 无 json tag，字段名需命名归一化

**涉及模块**：
- 修改 [parser/index.ts](file:///work/protochain/src/parser/index.ts)（contracts 段解析）
- 修改 [specifier/index.ts](file:///work/protochain/src/specifier/index.ts)（契约字段合并）
- 修改 [checker/index.ts](file:///work/protochain/src/checker/index.ts)（schema 自检）
- 修改 [verifier/index.ts](file:///work/protochain/src/verifier/index.ts) / field-compare（字段级对比）
- 测试：新增 `tests/parser/contracts*`、`tests/specifier/contract-fields*`、`tests/verifier/field-level-*` 补强

**验收**（两层）：
- **A. 工具链自包含（fixture，可独立复验）**：契约段解析 / 合并优先级 / 缺字段降级正反向单测；fixture 实例跑 `derive-specs` → `schemaKind=structured`；verify 偏差报告「字段 X：legacy=Y, impl=Z」真实 CLI 可复现（E2-I4 闭环）；无契约字段接口仍 `description-only`/`legacy-stub`（兼容零回归）；`npx tsc --noEmit` 0 errors + `npx jest` 全过
- **B. hsk-ng 端到端（真实实例，模型侧落地）**：**修改 hsk-ng 模型列为验收**——P1 `register`/`bind` 契约层补接口字段（从 impl 提取，model.md 为权威源、impl 作参考，字段名归一化 + 人工复核）→ `derive-specs` 重推导 specs.json `schemaKind=structured` 且字段齐全 → `derive-web` 重跑后 E7 接口详情页出现字段表格；走实例侧流程纪律：改动前 `version save` 快照 + 修改单登记（不绕过 M→D→B→I→V→R）
- 说明：A 是工具链 PASS 的硬条件（自包含、不依赖实例状态）；B 是端到端闭环演示（验证工具链能力在真实模型上生效），若 hsk-ng 建模进度不允许可暂以 fixture 顶替并登记，但不豁免

**依赖**：E2（schema 形态已定义，本任务补消费端）；是 E7 接口详情字段表格、E3/E5 的上游；与 T3 E8/E9/E10 无耦合，可并行。

---

### E3. binding 骨架自动生成（§4.2 第一条）★ P0

**问题**：`derive-specs` 推完后人工写 bindings.yaml；hsk-ng 18 单手工补 40 路由、strangler-fig 18 单手工写 adminer 接入——**同模式重复劳动**。

**目标**：specs.json 完成后，`derive-bindings` 直接生成 binding 骨架（method/path/params 初稿），人工只填 baseUrl/headers/认证。

**交付物**：
1. 新增命令 `derive-bindings`：输入 specs.json + stateMap，输出 `bindings.skeleton.yaml`（模块落点：`src/bindgen/index.ts`，与 `src/binder/` 拼写区分避免混淆）
2. 骨架字段：
   - `roles[].baseUrl`：占位 `https://TODO.example.com`
   - `interfaces[].method/path/params`：从 requestSchema 机械推导
   - `interfaces[].responseMapping`：从 responseSchema 机械推导
   - `stateMap[]`：从 specs.json 的 `observe_*` 派生初始归一化表（待人工确认）
3. `bind` 命令改为读 `bindings.yaml`（合并 skeleton + 人工填写），不再要求"从零写"
4. 与 E2 强耦合：specs.json 含完整 schema 后才能做 method/path/params 推导

**涉及模块**：
- 新建 `src/bindgen/index.ts`（命名对比：`bindgen` 是骨架生成器，`binder` 是完整性校验器——避免原 `bindder` 与 `binder` 拼写冲突）
- 修改 [binder/index.ts](file:///work/protochain/src/binder/index.ts)
- 修改 [CLI 入口](file:///work/protochain/src/cli/index.ts) 注册新命令

**验收**：
- hsk-ng 18 单从"手工补 40 路由"降到"确认 40 路由 + 填 baseUrl"
- bindings.skeleton.yaml 一次生成成功率 ≥ 80%（剩余 20% 是 baseUrl/headers/stateMap 微调）

**依赖**：E2（JSON Schema）

---

### E4. 数据级不变量结构化声明 + SQL 校验（§4.3） P1

**问题**：TLA+ 本身支持量词（\A \E），但 protochain formalizer 无法把"自然语言量词 / 数据字段表达式"翻译成合法 TLA+，生成器检测到时自动降级为 `TRUE`——11 个数据级不变量（019 单：5+5+1=11，附录 A.2 硬伤 2 已修正）全部 `TRUE`，TLC 只证明"状态机结构合法"不证明"业务规则成立"。

**目标**：数据级不变量在 model.md 中结构化声明；verify 独立生成 SQL 校验用例；"由 X 守卫 + 存储 Y 索引保证"的不可消除项在 verify 报告里显式列出。

**交付物**：
1. **model.md schema 扩面**：不变量表格新增列 `level: state-machine | data`，`level=data` 时填：
   ```yaml
   - id: INV1
     level: data
     source: storage          # storage | guard
     invariant: UNIQUE(forward_mapping_resource.id)
     storageRef: forward_mapping_resource
   ```
2. **formalizer 适配**：`level=data` 时不进 TLA+，归入 `formal-report.json` 的 `deferredToSqlValidation` 段
3. **verify 加 SQL 校验路径**：读取 storage schema（DDL 或 protochain-managed schema）+ invariant 表达式，生成 SELECT 语句，连接 storage 执行（read-only 角色）
4. **verify 报告新增 `by-design-not-tested-by-toolchain` 段**：列出 `level=data && source=guard` 的项，标注"由 impl 守卫保证"
5. **CLI 兼容**：旧 model.md 不变量表无 `level` 列时默认 `state-machine`，不破坏现有协议

**涉及模块**：
- 修改 [formalizer/index.ts](file:///work/protochain/src/formalizer/index.ts)
- 修改 [verifier/index.ts](file:///work/protochain/src/verifier/index.ts)
- 新建 `src/sqlcheck/index.ts`（SQL 校验引擎，支持 MySQL/PostgreSQL 适配）
- 修改 model.md schema（[src/parser/](file:///work/protochain/src/parser)）

**验收**：
- 019 单 11 个数据级不变量从"全部 TRUE"降为"SQL 校验通过 N 条 + by-design-not-tested-by-toolchain (11-N) 条"——**N 由 T1 启动前盘点 019 单 model.md 每个不变量的 `source` 列后填入**（此前 §E4 的 "7+4" 数字为预测值，REVIEW §4.3 已指出此问题）
- strangler-fig / hsk-ng 至少一个协议 run 通 verify SQL 校验

**依赖**：
- 业务逻辑：无（与 E2/E3 独立）
- **文件级重叠**：E4 与 E2 都改 model.md schema 与 [parser](file:///work/protochain/src/parser)；T2 启动前与 E2 协调合并顺序（建议 E2 先落地契约层 schema，E4 在此之上加 `level/source/storageRef` 列，避免 schema 演进双 MR 冲突）

---

### E5. impl 语言 transport 客户端生成（§4.2 第二条） P1

**问题**：scaffolder 输出的 `interfaces.d.ts` 是空壳（每个 action 入参/返回都是 `any`），impl 收到 specs.json 仍要重写大量样板代码（hsk-ng / strangler-fig 已实证）。

**目标**：scaffolder 按 impl 语言生成 transport 客户端（http/kafka/nsq 三传输 × TS/Go/Java 三语言），impl 只需写业务逻辑。

**交付物（P1 范围，仅 TS）**：
1. `generate-scaffold --lang=ts`：除 `interfaces.d.ts` 外，多产物
   - TS：`clients/http.ts`、`clients/kafka.ts`、`clients/nsq.ts`（fetch / kafkajs / nsqjs 封装）
   - 每个 client 含：method 映射（specs.json → 真实 method/path）、params 序列化、错误归一化、stateMap 状态词读取辅助
2. 模板引擎抽离：`src/scaffolder/templates/ts/`
3. **Go/Java 单列为后续增量项**（T2 之后启动，独立排期）：
   - E5.1 Go：`clients/{http,kafka,nsq}.go`（net/http / sarama / nsq-go）—— 触发条件：hsk-ng 报 Go 客户端需求
   - E5.2 Java：`clients/{HttpClient,KafkaClient,NsqClient}.java`（OkHttp / kafka-clients / nsq-client）—— 触发条件：strangler-fig Java 接入需求
   - E5.x 模板套件新增时按需扩面，不阻塞 E5 主线

> **口径统一**：此前 E5 三处自相矛盾（交付物列三套 / §3 风险说只做 TS / T2 验收用 go），以本节"P1 只做 TS"为唯一口径；T2 完成标志的 `--lang=go` 改为 `--lang=ts`（见 §2）。

**涉及模块**：
- 修改 [scaffolder/index.ts](file:///work/protochain/src/scaffolder/index.ts)
- 新增 `src/scaffolder/templates/ts/`（Go/Java 随 E5.1/E5.2 增补，不在 P1 范围）

**验收**：
- hsk-ng 任一协议 `--lang=ts` 生成的 client 跑通一次 binding run（无需手写 client 代码）
- 生成的 client 与 E3 骨架生成的 bindings.yaml 方法名一致

**依赖**：E2（JSON Schema 才能推 method/path/params）

---

### E6. Mock/Spy 自动生成（§4.2 第三条） P1

**问题**：test-tool run 强依赖真实 impl；dev 阶段无 impl 时无测试可达。

**目标**：testgen 配套生成 Mock/Spy 实现，test-tool run 不依赖真实 impl。

**交付物**：
1. `generate-tests --emit=mock` 生成 `derived/test-tool/mocks.ts`：每个 `ProtocolImplementation` 方法返回 fixtures 中的固定值，支持 spy 计数
2. fixtures 来源：**T2 启动前先读 [test-cases.schema.json](file:///work/protochain/templates/protocol-runner-instance/schemas/test-cases.schema.json) 与 `test-cases.json` 现状**，再敲定是 `scenarios/*.yaml.expectations` 还是 `test-cases.json.expectedResults`（REVIEW §4.3 指出现"若已存在"为回避式表述）
3. `verify --mock` 模式：用 mocks 跑 test-tool，输出"模型层契约一致性"报告（不验证 impl 真实性）

**涉及模块**：
- 修改 [testgen/index.ts](file:///work/protochain/src/testgen/index.ts)
- 新建 `src/testtool/mock.ts`（mock runner）
- 修改 [verifier/index.ts](file:///work/protochain/src/verifier/index.ts) 加 `--mock`

**验收**：
- strangler-fig / hsk-ng 任一协议在无 impl 情况下 `verify --mock` 全绿
- mock 输出与 fixtures 完全一致（无随机性）

**依赖**：E2（JSON Schema 用于生成 mock 签名）

---

### E7. Web 检阅界面（附录 B）★ P0

**问题**：模型 review/diff/用例管理散落在 CLI 命令 + JSON 文件；非工程师难参与；diff/impact 是 JSON 非人读。

**目标**：纯机械生成的静态检阅界面，**只读展示 + 模型侧输入管理**，不破坏权威源。

**交付物**（P0 + P1 两阶段，对应附录 B.4）：

**P0（只读检阅，纯机械）**：
1. 新增命令 `derive-web`：100% 机械从 `derived/*.json` + `model-diff.json` + `impact-analysis.json` 生成静态站点数据 `web/data.json`
2. 静态站点（**敲定 VitePress**：纯静态 + 与 Vue 生态兼容 + 内置 markdown 渲染，便于"模型 diff/impact 可视化"页面挂 Vue 组件；Astro 不作为备选，避免开工前再讨论）
3. 页面：
   - 接口列表/详情（参数、请求/响应结构、状态机图 = §1.6 mermaid 复用）
   - 测试用例浏览器（路径/覆盖度/场景映射）
   - 验证报告对比（V3 双跑对账：legacy vs impl 并排）
   - 模型 diff/impact 可视化（改了什么 → 影响哪些接口/用例/骨架）——顺带补 V6 缺口
4. `protochain web serve` 一条命令起静态服务

**P0 增补（组合层视图 / B1，多协议项目级只读检阅）——v0.4 采纳（2026-08-22）**：
> 背景：E7-P0 已交付单协议只读检阅；hsk-ng 为多协议项目（composition.md + P1~P4），"一个站点看整个项目"需要组合层数据。本增补为只读机械，不依赖 E9，可提前实施。
5. `derive-web --project`（组合层模式，机械只读）：读 `protocol/composition.md` + 各子协议 `protocol/<Pn>/derived/specs.json`，产出项目级 `web/data.json`：
   - 项目总览页：子协议卡片（名称/版本/接口数/验证状态）+ 协议依赖图（mermaid，复用 composition.md edges 结构化依赖）
   - 每协议接口页叠加跨协议引用标注（guard / 请求字段 → 引用 `Pn.xxx`；双向：被引用 / 引用）
   - 跨协议关联矩阵：共享台账/实体（如 fqdn_registry）、cross-invariants 覆盖范围、跨协议守卫引用
   - 跨协议 diff 页：**数据源接 E9**（本期 E9 未落地时页面骨架先行，显示"待 E9"）
6. 行为边界：单协议项目（无 composition.md）此模式退化为现有 P0 行为；多协议项目自动启用组合层数据

**P1（反馈闭环 + 模型侧管理）**：
5. 轻量服务（Node + Express/Fastify）：
   - scenarios/*.yaml 在线编辑 + 校验 + 一键 generate-cases
   - bindings.yaml 在线编辑（E3 骨架基础上填 baseUrl/headers）+ 一键 bind
   - test-tool / verify 一键执行 + 结果回写
   - 评审标注 → 生成工具链修改单草稿（走 M→D→B→I→V→R，不绕过流程）
6. 安全：web 服务**不接触**令牌环境变量；展示层过滤 `authConfig.token`、`stateMap.secret` 等敏感字段

**明确不做（防范围蔓延，附录 B.4）**：
- mock 服务、团队协作、环境管理、Apifox 克隆——核心是"模型检阅"

**涉及模块**：
- 新建 `src/webgen/index.ts`
- 新建 `web/` 站点工程
- 新建 `src/webgen/composition.ts`（组合层数据构造 / B1：composition.md 解析 + 各子协议 derived 汇总 + 跨协议引用提取）
- 修改 [verifier/index.ts](file:///work/protochain/src/verifier/index.ts)（双跑报告并列导出）

**验收**：
- strangler-fig 019 单跑一次 `derive-web` → 静态站点可访问，接口详情/test-case/双跑报告/diff 全部人读
- P0 不引入任何运行时依赖（纯静态）；P1 服务可在本地端口起，不接触令牌
- （B1，v0.4 增补）hsk-ng 多协议根跑 `derive-web --project` → 项目总览 + 依赖图 + 每协议跨协议引用标注 + 关联矩阵全部人读；单协议项目行为不回归

**依赖**：E2（JSON Schema 让接口详情有结构可展示）；与 E3 正交（E3 让 bindings 编辑有骨架可填）；B1 不依赖 E9（跨协议 diff 页数据源接 E9，页面骨架先行）

---

### E8. test-tool 从代码生成迁到描述执行（§4.5） P2

**问题**：[testtool/loader.ts](file:///work/protochain/src/testtool/loader.ts) 把 test-tool 当 TS 编译 + 动态 import，test-tool 由 AI 生成（[testgen/index.ts:53](file:///work/protochain/src/testgen/index.ts#L53)），verify 权威性被 AI 随机性稀释；adaptor ID 转义类问题（修改单 002 同源）反复出现。

**目标**：test-tool = JSON 描述 + 固定通用 runner；AI 只生成测试场景数据，不生成测试逻辑。

**交付物**：
1. testtool 协议：`test-tool/test-cases.description.json`（不写代码，写"对 US2 状态调用 observe_已发放，期望 US2"）
2. `protocol-executor.ts` 固定模板：解析 description → 调用 observe 接口 → 断言
3. AI 只生成 description 的 params/seed 数据，runner 签名锁定
4. 旧 `test-tool/*.ts` 加 deprecated 标记 + **自动迁移脚本仅覆盖确定性路径（`useAI=false`）生成的 test-tool**；AI 生成的 test-tool（有状态、含生成期假设）走人工核对 + 双跑灰度，不强求自动转 description.json（REVIEW §6 指出的可行性存疑点）

**涉及模块**：
- 重构 [testtool/loader.ts](file:///work/protochain/src/testtool/loader.ts)
- 修改 [testgen/index.ts](file:///work/protochain/src/testgen/index.ts)（产出 description.json 而非 ts）
- 修改 [verifier/index.ts](file:///work/protochain/src/verifier/index.ts)（读 description.json）

**验收**：
- 同一 model.md + scenarios 跑两次 verify，结果 byte-level 一致（消除 AI 随机性）
- 迁移 strangler-fig 019 单的 test-tool（4 文件）到 description.json 无功能回归

**依赖**：E6（Mock/Spy 与 description runner 协同）

---

### E9. 跨协议 diff + binding 影响分析（V6 缺口） P2

**问题**：[differ](file:///work/protochain/src/differ/index.ts) 只做单协议结构化差分，无 human-readable diff；`impact` 不分析 binding；无跨协议 diff。

**目标**：diff/impact 升级为人读视图 + binding 影响分析 + 跨协议 diff。

**交付物**：
1. `diff --human`：基于 model-diff.json 渲染 unified diff 视图（含表格/接口级 human-readable）
2. `impact --include=bindings`：分析改动是否波及 bindings.yaml（stateMap 命中、interfaces.method/path 变化）
3. `diff --cross-protocol`：composition 下多协议统一 diff（按 INV/Action/State 分类）
4. E7 Web 站点 P0 页面"模型 diff/impact 可视化"复用此输出
5. （B2，v0.4 增补）E7 组合层视图（B1）的跨协议 diff 页接通 `diff --cross-protocol` 输出：改 P1 模型 → 组合站点展示影响哪些协议的哪些 API/绑定（B1 页面骨架已预留数据接口）

**涉及模块**：
- 修改 [differ/index.ts](file:///work/protochain/src/differ/index.ts)
- 新建 `src/differ/human.ts`（渲染器）
- 修改 [binder/index.ts](file:///work/protochain/src/binder/index.ts)（提供 binding 视图给 impact）

**验收**：
- 跨 strangler-fig 与 hsk-ng 任一变更跑 cross-protocol diff，输出可读报告
- impact 报告能回答"改 INV1 后哪些 binding 要回归"

**依赖**：无（独立）

---

### E10. 修改单 SLO + 跨实例聚合（V2 缺口） P2

**问题**：hsk-ng 与 strangler-fig 报的修改单是否重复？没索引；修改单多久必须响应？没机制；修完到 hsk-ng 跑回归是手动的。

**目标**：问题清单升级为"跨实例索引 + SLO + CI 联动"。

**交付物**：
1. **T3 启动前先读 [工具链问题清单-protocoldriven.md](file:///work/工具链问题清单-protocoldriven.md) 现状**，确认列结构可加 `affected-instances`、历史修改单可回填；然后再加索引列：`affected-instances: [strangler-fig, hsk-ng]`
2. 修改单加 SLO 字段：`severity: P0-24h | P1-7d | P2-30d`，CI 检查超期
3. 跨实例聚合脚本：`protochain issues aggregate --by-symptom`，按症状聚合（SE 不可达 / ID 转义 / 子状态机 等）
4. CI 联动：工具链内核 PR merge 后，自动对 strangler-fig / hsk-ng 跑一次 verify（GitHub Actions / GitLab CI 任一）

**涉及模块**：
- 修改 `工具链问题清单-protocoldriven.md`（模板升级）
- 修改 `工具链修改单-模板.md`
- 新建 `src/issues/aggregate.ts`
- 新建 `.github/workflows/instance-regression.yml`（或对应 CI 平台）

**验收**：
- 三个修改单的 affected-instances 字段填齐
- CI 跑通 strangler-fig / hsk-ng 一次回归（即使空跑）

**依赖**：E1（m-check 修复的修改单必须先建立 SLO 才有意义）

---

### E11. 接口错误契约 + 错误绑定（errorModeling）★ P0

**问题**：建模无错误结构——`# 异常路径` 的错误码（如 hsk-ng P3 的 `domain_taken`/`token_invalid_role`）埋在"处理"列自由文本，parser 不解析不校验；`InterfaceSpec` 无错误契约（全 `src/` 无 errorSchema/errorCode）；bindings.yaml 无错误映射（errorMap）；verify 只能事后观察错误（Deviation.httpStatus/responseBody），无法归一化到协议错误码；scenarios 无 expectedError。实例侧（hsk-ng）impl 已有完整一致错误结构（`writeError` envelope `{"error":{"code","message"}}` + P1~P4 四个 `mapXError`），**缺的正是建模侧对应物**——实现缺模型约束。

**目标**：错误码成为 model.md 权威源的一部分（异常路径错误码列 + `contracts[].errorResponses`）；bindings.yaml `errorMap` 映射协议错误码 ↔ 系统错误表达（与 stateMap 同构）；verify 按契约机械断言错误返回（新增 `error_mismatch` 偏差 + `errorSummary`）；web 接口详情展示"绑定后的完整接口"（业务字段 + 错误结构 + 传输绑定）。

**设计依据**：[docs/error-modeling-plan.md](file:///work/protochain/docs/error-modeling-plan.md)（工具链方案）；[../hsk-ng/docs/error-modeling-implementation-plan.md](../hsk-ng/docs/error-modeling-implementation-plan.md)（实例侧实施）

**交付物**：
1. 类型扩展（[types.ts](file:///work/protochain/src/model/types.ts)）：`ExceptionPathDef.errorCode` / `ErrorResponseDef` / `ContractEntry.errorResponses` / `InterfaceSpec.errorResponses` / `BindingConfig.errorMap` / `ErrorMapEntry` / `Deviation.kind` 增加 `error_mismatch`
2. parser（[parser/index.ts](file:///work/protochain/src/parser/index.ts)）：异常路径表"错误码"列解析；`parseContractEntry` 增加 errorResponses 解析（复用 `parseJsonSchemaValue` 校验 bodySchema）
3. specifier（[specifier/index.ts](file:///work/protochain/src/specifier/index.ts)）：命中契约的 errorResponses 投影到 InterfaceSpec（与 requestSchema 同通道）
4. checker（[checker/index.ts](file:///work/protochain/src/checker/index.ts)）：错误码唯一/命名（snake_case）/异常路径↔契约闭合校验 + httpStatus 5xx warning
5. bindgen/binder（[bindgen/index.ts](file:///work/protochain/src/bindgen/index.ts) / [binder/index.ts](file:///work/protochain/src/binder/index.ts)）：从 specs.errorResponses 派生 errorMap 骨架 + mergeBindings errorMap 合并（manual > skeleton）+ validateBindings "errorMap 缺失 = valid=false"（与观测接口缺绑同纪律）
6. verifier（[binding-runner.ts](file:///work/protochain/src/verifier/binding-runner.ts) / [index.ts](file:///work/protochain/src/verifier/index.ts)）：`ok=false` 时按 errorMap 判定（命中→符合契约 / 未命中→`error_mismatch` / ≥500→system_fault 分类）；VerificationReport 增加 `errorSummary`；ScenarioParamSource 增加 `expectedError`
7. webgen（[webgen/index.ts](file:///work/protochain/src/webgen/index.ts) / [composition.ts](file:///work/protochain/src/webgen/composition.ts)）：接口详情"错误响应"表 + verification errorSummary 段 + **绑定视图**（WebBindingView：bindings.yaml 非敏感投影子集 transport/errorMap，authConfig/tls 不读取，`redactSensitiveFields` 兜底）
8. scenarios schema（[webgen/feedback/schemas.ts](file:///work/protochain/src/webgen/feedback/schemas.ts)）：`expectedError` 字段 + ajv 校验

**涉及模块**：
- 修改 types / parser / specifier / checker / bindgen / binder / verifier / webgen（见交付物）
- 测试：新增 `tests/parser/error-code*`、`tests/specifier/error-responses*`、`tests/checker/error-contract*`、`tests/verifier/error-map*`、`tests/webgen/binding-view*`

**验收**（两层，对齐 E2.1）：
- **A. 工具链自包含（fixture，硬条件）**：错误码列/errorResponses/errorMap 解析与投影正反向单测；checker 闭合校验；`npx tsc --noEmit` 0 errors + `npx jest` 全过；fixture 跑 `derive-specs` → `errorResponses` 投影、`bind` 校验 errorMap 缺失即 valid=false、verify 错误场景断言
- **B. hsk-ng 端到端（实例侧落地，与 E2.1 B 层合并执行）**：P1-P4 model.md 异常路径错误码列 + contracts[]（业务字段 requestSchema/responseSchema + errorResponses 一次补全）→ derive-specs `schemaKind=structured` + errorResponses → bindings.yaml errorMap → `bind` valid=true → scenarios expectedError 错误场景 → verify 含 errorSummary（错误场景断言通过、system_fault 如实上报）→ derive-web 接口详情三表（错误响应/传输绑定/错误映射）+ verification errorSummary；走 version save + 修改单纪律

**依赖**：E2.1（contracts[] 已落地，错误侧扩展）/ E3（errorMap 骨架复用 derive-bindings）/ E7（web 绑定视图复用 webgen）；与 T3 E8/E9/E10 无耦合，可并行；**E9 影响面应纳入 errorMap 变更**。

---

## 2. 路线图（Roadmap）

```
T0  当前状态（2026-08）
   工具链 v0.1.0 完成，strangler-fig / hsk-ng 跑通全链路
   缺口：§4 五类 + V6 缺 human-readable diff + V2 缺 SLO

T1  ─────────── P0 集中改造（≈ 1 个完整迭代）───────────
   E1 M 单元语义闸门 ─┐
   E2 JSON Schema   ─┤ 并行启动
   E3 binding 骨架   ─┘（E3 依赖 E2）
   E7 Web P0（只读）  ─ 并行启动（依赖 E2 schema 让展示有结构）
   完成标志：specs.json 通过 ajv 校验 + m-check 拦下 019 单 INV-PS1 + derive-bindings 生成率 ≥ 80% + Web 静态站点可访问

T2  ─────────── P1 集中改造（≈ 1 个完整迭代）───────────
   E4 数据级不变量 SQL 校验
   E5 transport 客户端生成（TS/Go/Java）
   E6 Mock/Spy 生成
   E7 Web P1（反馈闭环）
   E7 B1 组合层视图（只读机械，可提前于 P1 反馈闭环）
   完成标志：019 单 11 个数据级不变量从 TRUE 降为"SQL 校验通过 N 条 + by-design (11-N) 条"（N 由 E4 启动前盘点填入） + 任一协议 --lang=ts 生成的 client 跑通 binding run + verify --mock 全绿 + Web P1 可在线编辑 scenarios + hsk-ng 多协议根 `derive-web --project` 展示项目总览/依赖图/跨协议引用

T3  ─────────── P2 收尾 + E11 P0 前置（≈ 1 个完整迭代）───────────
   E11 接口错误契约 + 错误绑定（P0，前置并行，优先于 E8/E9/E10 启动）─
       依赖面（E2.1 契约层 / E3 / E7）已完成，无前置阻塞；与 E9 协同（影响面纳入 errorMap）
   E8 test-tool 迁到描述执行
   E9 跨协议 diff + binding 影响分析（含 B2：组合视图跨协议 diff 页接通输出；影响面纳入 errorMap）
   E10 修改单 SLO + CI 联动
   E2.1 契约层接口字段消费（E2 补全，P0）─ 工具链已落地（acceptance/E2.1 pass）；
       B 层（hsk-ng model.md 契约字段）与 E11 实例侧合并执行
   完成标志：test-tool 迁移 strangler-fig 019 单无回归 + cross-protocol diff 输出人读报告 + 组合视图跨协议 diff 页（B2）展示"改 P1 → 影响哪些协议的 API/绑定" + 修改单 SLO 字段填齐 + CI 实例回归跑通 + E11：hsk-ng 四协议错误契约/errorMap/错误场景/errorSummary/绑定视图全绿（实例侧 B6 五项验收）
```

> **不建议并行**的事项：
> - E1 与 E3：E3 依赖 E2，E1 独立；但 E1 完成前不动 E10 SLO（修改单无标准可定）
> - E5 与 E6：可并行，但 E6 先做能解锁 `verify --mock` 早期使用
> - E8 与 E5/E6：E8 与 E6 协同（description runner 与 mock runner 共栈），E8 应在 E6 之后启动

---

## 3. 风险与缓解

| 风险 | 说明 | 缓解 |
|---|---|---|
| **E2 JSON Schema 破坏老协议** | 老 specs.json 缺 schema 字段 | schemaVersion 字段 + 自动迁移 + 报警，老协议仍可跑 |
| **E4 SQL 校验需 storage 连接** | dev 环境可能没 storage | `verify --skip-sql-check` 显式跳过，报告标 by-design |
| **E5 多语言模板维护负担** | P1 范围仅 TS（REVIEW §4.1 已统一口径，Go/Java 作为 E5.1/E5.2 增量项独立排期） | T2 完成后看 hsk-ng / strangler-fig 是否报 Go/Java 需求，再启 E5.1/E5.2 |
| **E7 Web 静态站点偏离目标** | 做成通用 API 平台 | 每个功能先问"是否辅助模型检阅"（附录 B.4 明确不做） |
| **E8 迁移 strangler-fig 回归** | 老 test-tool 强 AI 生成，新方案 AI 不再生成逻辑 | 灰度：双跑 3 轮，新老结果一致再切默认 |
| **修改单 SLO 流于形式** | SLO 字段填了没人看 | CI 联动（E10）让超期自动报警 |
| **优先级再被推翻** | 附录 A.2 硬伤 3 已暴露 §4/§6/§7 自相矛盾 | 本规划 §0 总览表是唯一优先级口径，§4 五类与 §6 演进方向在本文件中**不再独立排序**，统一引用本规划 §0 |

---

## 4. 文档修订（本规划触发的 CORE-VALUE.md 改动）

按附录 A 修订优先级实施：

- [x] **A.2 硬伤 1**（§4.3 "TLA+ 不支持 forall"）：CORE-VALUE.md v0.3 已修订，本规划引用 §4.3 时一律改为"当前 formalizer 无法翻译含量词的自然语言不变量"
- [x] **A.2 硬伤 2**（§4.3 不变量数量 9 → 11）：本规划 §E4 已用 11
- [x] **A.2 硬伤 3**（§4 与 §6/§7 优先级自相矛盾）：本规划 §0 总览表为唯一口径，CORE-VALUE.md 后续修订应同步
- [ ] **A.3 §4.1**（"应进 §2 契约层段而不是 §8 契约层段——USAGE §4.2 已经把这块放在文末"逻辑冲突）：E2 实施前必须先核对 USAGE.md 并修正
- [ ] **A.3 §2 V2**（"19 个变更单"与"工具链缺陷修改单"术语两义）：CORE-VALUE.md §2 V2 区分 `model 扩面变更单` vs `工具链缺陷修改单`
- [ ] **A.3 §4.2**（模板路径 `templates/project.yaml` 不存在，行号 594-600 不准）：本规划引用统一改为 `templates/protocol-runner-instance/project.yaml`，行号以代码为准

---

## 5. 与附录 B 的关系

附录 B 的红线（P0/P1 划分）在本规划 E7 中**严格遵守**：
- 可机械推演 → Web 只读展示（E7 P0）
- 可 Web 编辑（模型侧输入）：scenarios/*.yaml + bindings.yaml（E7 P1，不破坏权威源）
- 不可 Web 直接编辑：test-cases.json / test-tool/*.ts / specs.json / contracts.json / interfaces.d.ts

附录 B.3 的"反向联动"在本规划中**逐条实现**：
- "倒逼 §4.1 JSON Schema" → E2 是 E7 的前置
- "顺带补 V6 human-readable diff 缺口" → E7 P0 diff/impact 页面 + E9
- "与 §4.5 方向一致" → E7 + E8 协同
- "部分弥补 §4.4 M 单元 stub" → E1 是根本修复，E7 是放大效应

---

## 6. 修订追踪（采纳 REVIEW 评估）

来源：[IMPLEMENTATION-PLAN-REVIEW.md](file:///work/protochain/IMPLEMENTATION-PLAN-REVIEW.md)（v0.1，2026-08-22）

### 已采纳（已落地到正文）

| REVIEW § | 议题 | 落点 |
|---|---|---|
| §3.2 | ajv "新增依赖" 错误 | §E2 改为"复用 [package.json:16](file:///work/protochain/package.json#L16) 已有 ajv@^8.17.1" |
| §4.1 | E5 三处口径冲突 | §E5 统一为"P1 只做 TS"；Go/Java 单列 E5.1/E5.2；§2 T2 验收从 `--lang=go` 改 `--lang=ts`；§3 风险同步 |
| §5.2 | E1 m-check 与 checker from/to 重叠 | §E1 删除 from/to 校验项，明确"与现有 checker 严格不重叠" |
| §5.1 | E1/E2 specifier 双改未说合并 | §E1 交付物 3 注明 pre-check 与 E2 重构"同一个 MR 合并提交" |
| §4.2 | E7 VitePress/Astro 未定 | §E7 敲定 VitePress，删除"Astro 备选" |
| §4.3 | E4 验收数字是预测值 | §E4 验收改为"N 由 T1 启动前盘点后填入"；§E4 依赖补"与 E2 文件级重叠 + 协调合并顺序" |
| §6 | E8 迁移脚本范围不清 | §E8 限定为"仅确定性路径生成的 test-tool 可自动迁移" |
| §6 | E3 模块命名混淆 | §E3 改为 `src/bindgen/index.ts`（删原 `bindder` 命名） |
| §4.3 | E6 fixtures 来源回避式表述 | §E6 改为"T2 启动前先读 schema 与现状再敲定" |
| §6 | E10 问题清单现状未读 | §E10 改为"T3 启动前先读清单现状再改" |

### 不采纳

| REVIEW § | 议题 | 不采纳原因 |
|---|---|---|
| §4.3 | E4 验收 "7+4" 数字建议直接删 | 本规划保留数字占位（SQL 校验通过 N 条 + by-design (11-N) 条），但加注 "由盘点后填入"——比直接删更可追溯 |
| §7 P0 项"ajv 复用"列在事实错误而非优先修订 | 本规划把"事实修正"与"优先级修正"分开列表，更便于 REVIEW 闭环追踪 |

### v0.2 复审闭环（IMPLEMENTATION-PLAN-REVIEW.md v0.2，2026-08-22）

| 复审 § | 议题 | 状态 | 落点 |
|---|---|---|---|
| R1 | E5 验收段仍写 `--lang=go` | 已修复 | §E5 验收改为 `--lang=ts` |
| R2 | E5 涉及模块仍写"三套" | 已修复 | §E5 涉及模块改为 `templates/ts/`（Go/Java 随 E5.1/E5.2 增补） |

> v0.1 复审 10 项 + v0.2 复审 2 项残留 = 共 12 项已全部闭环；本规划可作为 T1 执行的唯一口径。

### v0.3 复审闭环（IMPLEMENTATION-PLAN-REVIEW.md v0.3，2026-08-22）

| 复审 § | 议题 | 状态 | 落点 |
|---|---|---|---|
| R3 | §0 总览表 E5 行"主要落地模块"仍写"Go/TS/Java 三套模板" | 已修复 | §0 总览表改为"scaffolder TS 客户端模板（Go/Java 见 E5.1/E5.2）" |

### v0.4 规划增补（2026-08-22，组合层视图 B1/B2）

> 来源：E7-P0 复验后需求澄清——多协议项目（hsk-ng）需要"一个站点看整个项目"，且各协议关联（守卫/字段跨协议引用、共享台账、cross-invariants）应在 Web 展示层体现。

| 项 | 议题 | 落点 |
|---|---|---|
| B1 | 组合层视图（项目级只读检阅） | §E7 P0 增补 item 5-6：`derive-web --project` + 项目总览/依赖图/跨协议引用标注/关联矩阵；只读机械，不依赖 E9，T2 提前实施 |
| B2 | 组合视图跨协议 diff 页数据源 | §E9 交付物 item 5：接通 `diff --cross-protocol` 输出（B1 页面骨架预留数据接口） |
| 路线图 | B1 入 T2、B2 入 T3 | §2 T2/T3 完成标志同步更新 |
| 模块 | 组合层数据构造 | §E7 涉及模块新增 `src/webgen/composition.ts` |

> v0.1（10 项）+ v0.2（2 项 R1/R2）+ v0.3（1 项 R3）= 共 13 项已全部闭环；总览表与正文 E5 / §2 / §3 全部统一为"P1 只做 TS、Go/Java 见 E5.1/E5.2"。

### v0.5 规划增补（2026-08-23，E2 契约层补全 / E2.1）

> 来源：E7-P1 验收复验 + hsk-ng 展示适配分析——parser 契约层仅解析 `parties`/`expectedInformationFields`，`contracts` 段从未被消费；specifier 接口仅从转移派生；实测 hsk-ng P1~P4 specs.json 接口全 `description-only`；E2 验收第 3 项「字段 X：legacy=Y, impl=Z」真实 CLI 不可复现（E2-I4 open）。

| 项 | 议题 | 落点 |
|---|---|---|
| E2.1 | 契约层接口字段消费（E2 交付物 #1/#2 补全） | 新增 §E2.1：parser `contracts` 段解析 + specifier 契约字段生成 request/responseSchema + verify 字段级对比接通 + hsk-ng 从 impl 提取字段注入 model.md（model 为权威源、impl 作参考） |
| 总览表 | E2.1 编号入表 | §0 总览表新增 E2.1 行（P0，推导完整性） |
| 路线图 | E2.1 阶段归属 | §2 T3 前置并行（P0 补全，非 T3 完成标志项） |
| 验收 | 修改 hsk-ng 模型列为验收（B 层） | §E2.1 验收拆两层：A 工具链自包含（fixture，硬条件）+ B hsk-ng 端到端（真实实例契约字段落地 + 展示层字段表格 + version save/修改单纪律） |

### 仍待办（不在本规划修订范围内）

- [ ] A.3 §4.1（契约层段位置逻辑冲突）：核对 USAGE.md 后定
- [ ] A.3 §2 V2（"变更单"术语两义）：CORE-VALUE.md 修订范畴
- [ ] A.3 §4.2（模板路径/行号引用）：以代码为准核对

---

> 本规划是 CORE-VALUE.md §6 演进方向的**工程化展开**：每个增强都对应原文位置、给出模块改动、可量化验收。下游任务分解（每个 E# 转 task list）按需展开。