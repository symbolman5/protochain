# Protochain 协议驱动自验证工具链 — 使用手册

> 版本：0.1.0 | 最后更新：2026-08-02

> **版本差异提示**：`bind` 命令与"verify 通过绑定层调用真实接口"自 **2026-08-02 构建**引入。
> 旧构建（2026-08-01 及更早）无 `bind` 命令，verify 不调用真实接口（路径用例全部跳过，仅 negative-assurance 条目计入结果）。
> 若执行 `protochain bind` 报 unknown command，请重新构建：`npm run build`。

> **2026-08-02 构建（场景 setup / 多环境 / 环境变量前置校验）**：`verify` 新增场景文件 `setup` 段（测试路径执行前调用清理接口，解决重复 verify 的状态累积）、bindings `environments` 多环境配置与 `--env` 切换、以及 verify 启动时的环境变量扫描告警（清单落盘 `derived/env-deps.json`，401 文案区分"令牌环境变量未配置"与"令牌无效"）。

---

## 一、概述

Protochain 是一套**协议驱动开发（Protocol-Driven Development）**工具链。核心理念：

> 先写可校验的协议模型，再推导接口与测试用例，最后验证实现一致性。

工具链从 `protocol/model.md`（权威源）出发，执行十个步骤的机械/AI 推导，产出接口规格、契约集、测试用例，并在最终用真实实现驱动一致性验证。

工具链同时可作为 **protocol-runner 的 LLM 子任务执行器**（P3）：`exec-task` 子任务模式消费
protocol-runner 的结构化任务、按步骤执行推导/生成（含可选 AI 生成 loop），并把效应/事实账本与成本
回传为结构化回执（见 §七）。

---

## 二、安装与配置

### 2.1 环境要求

- Node.js >= 18
- npm >= 9

### 2.2 安装

```bash
cd protocoldriven
npm install
npm run build          # 编译 TypeScript
```

编译后 `protochain` 二进制可全局使用（通过 npx 或 npm link）：

```bash
npm link
protochain --help
```

开发模式可直接通过 `npm run dev` 运行：

```bash
npm run dev -- <命令> [参数]
```

### 2.3 配置文件

配置文件位于项目根目录 `protochain.config.yaml`：

```yaml
name: 系统名称
ai:                              # AI 适配器（reason/formalize/casegen 需要）
  provider: deepseek              # openai | anthropic | local | deepseek
  apiKey: sk-xxx
  model: deepseek-v4-pro
  baseUrl: https://api.deepseek.com
  models:                         # P3 多模型路由（可选）：按步骤角色覆盖 model
    semantic: deepseek-v4-flash   #   check / verify 辅助摘要 / diff / version 分类
    reasoning: deepseek-v4-pro    #   reason / formalize / derive-contracts
    generation: deepseek-v4-flash #   generate-tests / generate-cases
  useForGeneration: false         # P3 生成 loop：generate-tests/generate-cases 是否启用
                                  #   "生成 → 机械预检 → 修正 → 重试"（默认 false，保持确定性路径）
  loop:                           # 生成 loop 预算（可选；默认 maxIterations=3 / maxTokens=20000 / maxToolCalls=10）
    maxIterations: 3
    maxTokens: 20000
    maxToolCalls: 10

formalTool: auto                  # tla | scxml | decision-table | auto

tlc:                              # TLC 模型检查器（可选，见 2.5 节）
  javaPath: /path/to/portable-jre # portable JRE 目录或 java 可执行文件
  tla2toolsJar: /path/to/tla2tools.jar
  timeoutMs: 120000

coverage:                         # 测试覆盖度准则
  criterion: state                # state | transition | path
  maxPathLength: 5

paths:                            # 目录约定（可省略，使用默认值）
  protocol: protocol/
  derived: derived/
  scaffold: impl-scaffold/

bindings:                         # 接口绑定配置（P0 阶段）
  roles:
    R-User:
      roleId: R-User
      baseUrl: https://portal.internal/api
      auth: bearer
      authConfig:
        tokenEnv: PORTAL_TOKEN
    R-OpSystem:                     # Kafka 角色（不需要 baseUrl）
      roleId: R-OpSystem
      auth: none
      kafka:
        brokersEnv: KAFKA_BROKERS   # 环境变量，不配则 fallback KAFKA_BROKERS
    R-LogCollector:                  # NSQ 角色（不需要 baseUrl）
      roleId: R-LogCollector
      auth: none
      nsq:
        nsqdTcpEnv: NSQD_TCP_ADDRESS
  interfaces:
    - action: create
      roleId: R-User
      transport:
        type: http
        method: POST
        path: /v1/entries
        params: []
    - action: sync_user_quota
      roleId: R-OpSystem
      transport:
        type: kafka
        topic: user-quota-events
        serde: json
        responseMode: none
```

### 2.4 管理配置

```bash
protochain config get                    # 查看全部配置
protochain config get ai.provider         # 查看单项
protochain config set ai.provider openai  # 设置单项
```

### 2.5 TLC 模型检查器配置（可选）

`formalize`（步骤 ③）默认生成 TLA+ 规格后由 AI 推演验证（报告标注 `tla-ai-fallback`）。配置 `tlc` 段后，改用 **TLC 模型检查器**（tla2tools.jar）执行真实验证，不变量通过/反例均为确定性结论：

```yaml
formalTool: tla            # 指定 TLA+ 形式化工具
tlc:
  javaPath: /path/to/jre   # portable JRE 目录（自动补全 bin/java）或 java 可执行文件
  tla2toolsJar: /path/to/tla2tools.jar   # jar 文件，或包含 tla2tools.jar 的目录
  timeoutMs: 120000        # TLC 运行超时（毫秒，默认 60000）
```

说明：

- `javaPath`：可填 **portable JRE 目录**（如 `jdk-17.0.20+8-jre`），运行器自动补全 `bin/java`；也可直接填 `java` 可执行文件路径；不配则使用 PATH 中的 `java`
- `tla2toolsJar`：可填 `tla2tools.jar` 文件路径，或包含该文件的目录
- `timeoutMs`：模型检查超时上限，状态空间较大时建议调高（如 120000）
- **降级行为**：**只有未配置 `tlc` 段才降级为 AI 推演验证**（报告标注 `tla-ai-fallback`）。一旦配置了 TLC，其结果即权威（报告中 `toolExecuted: true`）：不变量违反、执行超时、**规格解析/语义失败**（含代码生成骨架未声明标识符的情况）、启动失败（java/jar 路径错误）均直接报告失败，**不再尝试 AI**——失败原因由 `rawOutput` 保留、人工检查点仲裁，避免静默用 AI"通过"掩盖工具失败

### 2.6 AI 生成 loop（P3，可选）

`generate-tests` / `generate-cases` 这类"纯 AI 生成"步骤默认是单次 `complete`（一次性生成 → 解析 →
失败即报错）。配置 `ai.useForGeneration: true` 后，生成类步骤复用 **"生成 → 机械预检 → 修正 → 重试"** loop
（实现：[src/ai/generation-loop.ts](../src/ai/generation-loop.ts)）：

- **预检信号来自机械层**：编译（`tsc --noEmit`）、产物 schema 解析、覆盖度统计等低风险预检；
  未通过时把机械 `feedback` 拼回下一轮 prompt 供 AI 修正；权威结论仍由步骤边界的机械层给出。
- **硬预算（已实现）**：`loop.maxIterations`（最大生成轮数）、`loop.maxTokens`（近似 token 累计，
  按字符数/4 估算）、`loop.maxToolCalls`（最大 AI 调用次数）**任一耗尽仍未通过即抛
  `GenerationLoopError`**，不无限重试。
- **红线（§7.3）**：loop 只用于生成类步骤；`reason` / `formalize` 的代码确定性预判（BFS/SCC）
  **不可被 AI 覆盖**，不接入本 loop。
- **报告**：成功的生成产物记录 `attempts`（每轮解析结果与预检结论）、`corrections`（失败修正轮数）、
  `toolCalls`（累计 AI 调用次数）。

多模型路由（`ai.models`）为可选优化：语义层检查用便宜模型、reason/formalize 用强模型、
生成类步骤单独指定；未配置的步骤回退到顶层 `model`。

示例（真实环境，portable JRE + tla2tools）：

```yaml
formalTool: tla
tlc:
  javaPath: /home/mgw/.local/opt/jre/jdk-17.0.20+8-jre
  tla2toolsJar: /home/mgw/.local/opt/tla2tools.jar
  timeoutMs: 120000
```

---

## 三、命令速查

### 3.1 初始化

| 命令 | 说明 |
|------|------|
| `init -n <名称>` | 创建单协议项目骨架 |
| `init-multi -s <系统> -p P1:名称,...` | 创建多协议系统骨架 |
| `init-runner -s <系统> -p P1:名称,...` | 初始化协议建模工程 + protocol-runner 编排实例（协议建模驱动开发完整起步；生成 modeling/ + protocol-runner/） |

### 3.2 单协议十步流程

| # | 命令 | 说明 | 执行方式 |
|---|------|------|---------|
| ① | `check` | 完备性检查 | code (机械层) + ai (语义层) |
| ② | `reason` | AI 推演 | ai |
| ③ | `formalize` | 形式化验证 | code + ai |
| ⑤ | `derive-specs` | 规格推导 | code |
| ④ | `derive-contracts` | 契约推导 | code + ai |
| ⑥ | `generate-tests` | 测试工具生成 | ai |
| ⑦ | `generate-cases` | 测试用例生成 | ai |
| ⑨ | `generate-scaffold` | 接口骨架生成 | code |
| ⑧ | `check-impl` | 实现完整性检查 | code |
| ⑩ | `verify` | 一致性验证 | code |

### 3.3 多协议组合层

| 命令 | 说明 |
|------|------|
| `check-composition` | ①-C 组合层完备性检查 |
| `check-cross-invariants` | ②-C 跨协议不变量检查 |
| `formalize-cross` | ③-C 跨协议形式化验证 |
| `derive-cross-contracts` | ④-C 跨协议契约推导 |
| `generate-cross-cases` | ⑦-C 跨协议测试用例生成 |

### 3.4 流程编排

| 命令 | 说明 |
|------|------|
| `run` | 按 DAG 依赖执行步骤区间 |
| `status` | 查看步骤进度与检查点状态 |
| `exec-task <taskFile> --result <resultFile>` | 子任务模式：消费 protocol-runner 的 `task.json`，执行指定步骤后写回结构化 `result.json`（含 effects/facts/openItems/cost；供 protocol-runner `driver: protochain` 调用，见 §七） |

### 3.5 接口绑定

| 命令 | 说明 |
|------|------|
| `bind` | 验证接口绑定完整性（`--env <名称>` 指定绑定环境） |
| `verify --env <名称>` | 指定绑定环境执行一致性验证（未指定用 `defaultEnv`） |

### 3.6 迭代与版本管理

| 命令 | 说明 |
|------|------|
| `version save` | 保存协议快照 |
| `version list` | 列出所有版本 |
| `version show <ver>` | 查看版本元数据 |
| `version classify` | 变更分类 |
| `diff` | 比较两个版本差异 |
| `impact` | 影响分析 |
| `propagate --clean` | 清理 stale 产物并生成重推导计划 |

---

## 四、单协议开发工作流

### 4.1 第一步：初始化项目

```bash
# 创建单协议项目
protochain init -n "外卖订单履约协议" -d ./food-delivery

cd food-delivery
```

生成结构：

```
food-delivery/
├── protochain.config.yaml    # 工具链配置
├── protocol/
│   └── model.md              # 协议权威源（待编辑）
│   └── scenarios/            # 场景描述（可选）
├── derived/                  # 推导产物（空目录，运行时生成）
└── impl-scaffold/            # 接口骨架输出目录
```

### 4.2 第二步：编写协议模型

编辑 `protocol/model.md`。协议模型由三层构成（完整示例见 `examples/food-delivery/protocol/model.md`，以下为全部内容）：

```markdown
---
name: 外卖订单履约协议
version: 1.0.0
purpose: 描述外卖订单从提交、支付、商家履约到骑手配送的完整生命周期，确保各参与方在协作边界上的行为一致
roles:
  - id: customer
    name: 顾客
    responsibilities: 提交订单、支付、取消订单、确认收货
    roleType: consensus
  - id: merchant
    name: 商家
    responsibilities: 接单、拒单、备餐、出餐
    roleType: participant
  - id: rider
    name: 骑手
    responsibilities: 接取配送任务、更新配送位置、确认送达
    roleType: participant
  - id: system
    name: 平台系统
    responsibilities: 分配骑手、超时扫描、自动取消、协调各参与方
    roleType: participant
  - id: payment_gateway
    name: 支付网关
    responsibilities: 处理支付、回调支付结果、处理退款
    roleType: participant
---

# 背景

外卖订单履约协议定义顾客、商家、骑手、平台系统与支付网关之间的协作规则。顾客提交订单并完成支付后，商家在时限内接单备餐，系统分配骑手配送，最终送达或取消。协议的核心约束是：每个环节都在明确的时限内完成，取消路径有清晰的责任边界。

# 核心概念

- **订单**：顾客与商家之间的一次交易单元，从提交到送达或取消经历确定的生命周期
- **支付回调**：支付网关在支付成功后向平台推送的事件，触发订单从"已创建"进入"已支付"
- **运力池**：可被分配配送任务的在线骑手集合，是订单进入配送环节的资源前提
- **配送单**：订单进入配送中后生成的附属实体，记录骑手与位置状态
- **自动取消**：商家超时未接单或配送严重超时由系统强制触发的取消路径

# 协作流程

顾客提交订单后订单从未创建状态进入已创建状态，支付网关推送支付成功事件后订单进入已支付状态。商家在 5 分钟内接单并开始备餐，备餐完成后由系统从骑手运力池分配骑手进入配送中（无可用骑手时自动取消）。骑手确认送达后订单终态为已送达；任意环节取消则订单终态为已取消并触发退款。

# 异常处理原则

- 支付网关事件可能延迟或重复，系统通过 order_id 幂等处理，不阻塞商家履约
- 商家超时未接单由系统定时扫描兜底自动取消，不依赖人工干预
- 骑手长时间无位置上报视为配送异常，订单按违约路径取消

# 状态空间

| ID | 名称 | 类型 | 描述 | 角色 |
|---|---|---|---|---|
| S0 | 未创建 | initial | 顾客尚未下单，无订单记录 | customer |
| S1 | 已创建 | normal | 顾客已提交订单，待支付 | customer |
| S2 | 已支付 | normal | 支付成功，待商家接单 | customer, merchant |
| S3 | 备餐中 | normal | 商家已接单并正在备餐 | merchant |
| S4 | 已出餐 | normal | 备餐完成，等待系统分配骑手 | merchant, system |
| S5 | 配送中 | normal | 骑手正在配送 | rider |
| S6 | 已送达 | terminal | 订单完成 | customer |
| S7 | 已取消 | terminal | 订单取消（顾客/商家/系统任一触发） | customer, merchant |

# 转移规则

| ID | 名称 | from | to | action | trigger | guard | effects | triggerType | actionType | affectsDimensions |
|---|---|---|---|---|---|---|---|---|---|---|
| T1 | 提交订单 | S0 | S1 | create | customer | | order_amount = sum(item_price * item_quantity) | role | state_transition | |
| T2 | 支付成功 | S1 | S2 | pay_success | payment_gateway | | paid_amount = order_amount; payment_time = now | external | state_transition | |
| T3 | 商家接单 | S2 | S3 | accept | merchant | accept_within_deadline | | role | state_transition | |
| T4 | 完成备餐 | S3 | S4 | finish_preparing | merchant | | ready_at = now | role | state_transition | |
| T5 | 分配骑手 | S4 | S5 | assign_rider | system | rider_available && rider_in_flight_orders < 10 | | system | state_transition | |
| T5b | 无骑手自动取消 | S4 | S7 | auto_cancel_no_rider | system | !(rider_available && rider_in_flight_orders < 10) | delivery_fee = 0 | system | state_transition | |
| T6 | 确认送达 | S5 | S6 | confirm_delivery | rider | | delivered_at = now; delivery_completed = true | role | state_transition | |
| T7 | 顾客取消 | S1, S2 | S7 | cancel | customer | | refund_triggered = true; delivery_fee = 0 | role | state_transition | |
| T8 | 超时未接单取消 | S2 | S7 | auto_cancel_accept_timeout | system | accept_timeout | delivery_fee = 0 | system | state_transition | |
| T9 | 配送超时取消 | S5 | S7 | auto_cancel_delivery_timeout | system | delivery_timeout | delivery_fee = 0 | system | state_transition | |
| T10 | 商家拒单 | S2 | S7 | reject_by_merchant | merchant | | delivery_fee = 0 | role | state_transition | |

# 不变量

| ID | 名称 | 表达式 | 作用状态 | 声明方 | 不变量类别 | 描述 |
|---|---|---|---|---|---|---|
| INV1 | 金额一致性 | order_amount = sum(item_price * item_quantity) | S1, S2, S3, S4, S5, S6 | customer | intra_protocol | 订单金额始终等于各菜品金额之和 |
| INV2 | 送达不早于出餐 | delivered_at >= ready_at | S6 | customer | intra_protocol | 送达时间不得早于出餐时间（delivered_at 仅送达后有意义） |
| INV3 | 取消订单不产生配送费 | delivery_fee = 0 | S7 | customer | intra_protocol | 订单取消后不向顾客收取配送费 |
| INV4 | 骑手在途单量受限 | rider_in_flight_orders <= 10 | S5 | customer | cross_protocol | 同一骑手同时在途订单数不超过平台上限 |
| INV5 | 实付金额与订单金额一致 | paid_amount = order_amount | S2, S3, S4, S5, S6 | customer | intra_protocol | 支付金额必须等于订单金额，不允许部分支付 |

# 时序约束

| ID | 名称 | 类型 | 源 | 目标 | 约束值(ms) | 违约转移 | schedule | 描述 |
|---|---|---|---|---|---|---|---|---|
| TM1 | 接单时限 | timeout | pay_success | accept | 300000 | | | 支付成功后商家 5 分钟内必须接单，超时由系统自动取消（T8） |
| TM2 | 配送时限 | deadline | finish_preparing | confirm_delivery | 1800000 | | | 出餐后 30 分钟内必须完成送达 |
| TM3 | 超时订单定时扫描 | scheduled | S2 | S2 | | | */1 * * * * | 每分钟扫描超时未接单订单，触发自动取消 |
| TM4 | 配送位置持续上报 | continuous | S5 | S5 | | S7 | | 配送中骑手需持续上报位置，长时间无上报视为违约，转入已取消 |

# 异常路径

| ID | 名称 | 触发 | 转移序列 | 恢复策略 |
|---|---|---|---|---|
| EX1 | 商家接单超时 | 商家在接单时限内未接单 | T8 | 系统自动取消订单并全额退款 |
| EX2 | 配送严重超时 | 出餐后 30 分钟内未送达 | T9 | 系统自动取消订单，通知骑手停止配送并退款 |

# 资源池

```yaml
- id: RP1
  name: 骑手运力池
  type: 在线骑手集合
  capacity: dynamic
  allocationRule: 订单进入配送中（S5）时分配一名骑手，占用一份运力
  releaseRule: 订单送达（S6）或取消（S7）后释放运力
  constraints:
    - 同一骑手同时配送的在途订单数不超过 10
    - 每个订单在任一时刻最多占用一名骑手的运力
    - 骑手仅在备餐完成后（S4→S5）可被分配
  checkMethod: 查询骑手当前在途订单数与在线状态
  crossInvariantIds:
    - CI1
```

# 外部事件

```yaml
- id: EE1
  name: 支付成功
  source: payment_gateway
  triggerAction: pay_success
  idempotencyKey: order_id
  ordering: by_event_time
  onDelay: continue
  onDuplicate: ignore
- id: EE2
  name: 退款到账
  source: payment_gateway
  triggerAction: refund_received
  idempotencyKey: refund_id
  ordering: by_arrival_time
  onDelay: continue
  onDuplicate: ignore
```

# 附属实体

```yaml
- id: refund_order
  name: 退款单
  belongsTo: S7（本协议）
  instanceKey: refund_order.id
  lifecycleDependency: 随订单取消级联创建与关闭
  cascadeRules:
    - 订单取消（进入 S7）时创建退款单
    - 支付网关推送退款到账后关闭退款单
  stateSpace:
    dimensions:
      - name: refund_status
        type: enum[created, processing, completed]
        initial: created
      - name: refund_amount
        type: integer
        initial: 0
  invariants:
    - refund_amount <= order_paid_amount
    - 退款单仅在订单进入 S7 后创建
- id: rider_assignment
  name: 骑手配送单
  belongsTo: S5（本协议）
  instanceKey: rider_assignment.id
  lifecycleDependency: 随订单配送生命周期
  cascadeRules:
    - 订单进入 S5 时创建配送单
    - 订单送达或取消后关闭配送单
  stateSpace:
    dimensions:
      - name: rider_id
        type: string
        initial: ""
      - name: delivery_location
        type: enum[merchant, on_way, delivered]
        initial: merchant
  invariants:
    - 同一骑手在途配送单数不超过 10
    - delivery_location 从 merchant → on_way → delivered 单向流转
```

# 消极保证

```yaml
- id: NA1
  name: 支付网关不可用时不阻塞履约
  expression: payment_gateway_unavailable 不影响商家接单、备餐与配送
  scope: S2, S3, S4
  declaredBy: customer
  checkMethod: 支付网关断连场景测试
- id: NA2
  name: 骑手定位上报失败不丢单
  expression: rider_location_report_failure 不导致订单状态回退
  scope: S5
  declaredBy: customer
  checkMethod: 骑手端断网模拟测试
```

# 契约层

```yaml
parties:
  - customer
  - merchant
  - rider
  - system
  - payment_gateway
expectedInformationFields:
  - create_request
  - pay_success_request
  - accept_request
  - finish_preparing_request
  - assign_rider_request
  - auto_cancel_no_rider_request
  - confirm_delivery_request
  - cancel_request
  - auto_cancel_accept_timeout_request
  - auto_cancel_delivery_timeout_request
  - reject_by_merchant_request
```
```

### 4.3 第三步：校验与推演

```bash
# ① 完备性检查（机械层 + AI 语义层）
protochain check

# ② AI 推演（可达性、死锁、活性、一致性）
protochain reason

# ③ 形式化验证（自动选择形式化工具；配置 tlc 后走真实 TLC 模型检查，见 2.5 节）
protochain formalize
```

> **注意**：`reason` 和 `formalize` 需要 AI 适配器配置。`check` 的机械层不依赖 AI，AI 语义层可通过 `--no-ai` 跳过。

**活性判定语义（弱活性）**：`reason` 会解析模型的「活性语义声明（协议正式定义）」——若声明采用弱活性（终态可达 + 无死锁）、并明确"不采用全路径强活性、生命周期循环是合法业务"，则 reason 按 `weak` 模式判定（报告 `liveness.mode: "weak"`），含停用/启用等循环的实体生命周期模型不会因"并非所有路径最终到达终态"被误判。无该声明时按强活性判定。

**不变量可表达性分级（TLA+ 骨架）**：状态级不变量（如 `state \in States`）会原样进入 TLA+；**数据级不变量**（如 `forall u1,u2: u1.external_uid=...`，引用数据字段/全称量词）非法 TLA+ 语法——生成器检测到自然语言量词（forall/exists）或非 ASCII 表达式时自动降级为 `TRUE` 并在注释标注 `degraded: data-level`（与守卫降级策略一致）。**模型层实践**：数据级不变量表达式写 `TRUE`，在描述中写明真实保障来源（如"由 T1 守卫 + 存储唯一索引 uk_xxx 保证；TLC 单实体状态机不追踪该数据"），推导与 verify 比对层按描述执行。TLC 对状态机结构做真实模型检查，数据级保障由守卫 + 存储约束承担。

### 4.4 第四步：推导接口与契约

```bash
# ⑤ 规格推导（纯机械，无 AI）
# 从每个 action 推导系统接口，从每个 state/invariant 推导观测接口
protochain derive-specs
# 产出: derived/specs.json

# ④ 契约推导（从规格投影四层契约）
protochain derive-contracts
# 产出: derived/contracts.json
```

`specs.json` 中的接口分为两类：

- **系统接口**（`kind: "system"`）：对应每个 `transition.action`，如 `create`、`accept`、`confirm_delivery`
- **观测接口**（`kind: "observation"`）：对应每个状态和不变量，如 `observe_已创建`、`observe_INV1`

### 4.5 第五步：生成测试

```bash
# ⑥ 测试工具代码生成
protochain generate-tests
# 产出: derived/test-tool/*.ts（4个文件：模型定义、场景加载、执行器、断言器）

# ⑦ 测试用例生成
protochain generate-cases
# 产出: derived/test-cases.json

# 自定义覆盖度准则
protochain generate-cases --criterion path --max-path-length 10
```

覆盖度准则选项：

| 准则 | 说明 | 验收标准 |
|------|------|---------|
| `state` | 状态覆盖 | 100% 状态被访问 |
| `transition` | 转移覆盖 | 100% 转移被执行 |
| `path` | 路径覆盖 | 路径数 > 0 |

> **P3 生成 loop**：配置 `ai.useForGeneration: true`（§2.6）后，⑥/⑦ 从单次生成升级为
> "生成 → 机械预检（tsc/schema/覆盖度）→ 修正 → 重试"，受 `ai.loop` 硬预算约束；
> 预算耗尽仍未通过则步骤失败并给出最后一次机械反馈，不会无限重试。

### 4.6 第六步：生成实现骨架

```bash
# ⑨ 接口骨架生成
protochain generate-scaffold
# 产出: impl-scaffold/interfaces.d.ts

# 指定输出路径
protochain generate-scaffold -o src/__generated__/interfaces.ts
```

生成的骨架包含 TypeScript 类型定义，开发者按骨架实现代码。

### 4.7 第七步：配置接口绑定

`derive-specs` 产出了 `InterfaceSpec[]`（定义了什么），但还没说怎么连接到实际系统（定义了怎么调用）。绑定配置填的就是这个缺口。

```bash
# 先看看 derive-specs 产出了哪些接口
cat derived/specs.json | jq '.[].name'
# 输出示例：create, pay_success, accept, finish_preparing, assign_rider, auto_cancel_no_rider,
#           confirm_delivery, cancel, auto_cancel_accept_timeout, auto_cancel_delivery_timeout,
#           reject_by_merchant, observe_未创建, observe_已创建, observe_已支付, observe_INV1, ...
```

编辑 `protochain.config.yaml`，为每个接口配置传输层绑定：

```yaml
bindings:
  roles:
    R-Customer:
      roleId: R-Customer
      baseUrl: https://portal.internal/api
      auth: bearer
      authConfig:
        tokenEnv: PORTAL_TOKEN
  interfaces:
    - action: create
      roleId: R-Customer
      transport:
        type: http
        method: POST
        path: /v1/orders
    - action: cancel
      roleId: R-Customer
      transport:
        type: http
        method: POST
        path: /v1/orders/{id}/cancel
    - action: observe_已创建              # 观测接口也必须绑定
      roleId: R-Customer
      transport:
        type: http
        method: GET
        path: /v1/orders/{id}
    - action: observe_已支付
      roleId: R-Customer
      transport:
        type: http
        method: GET
        path: /v1/orders/{id}
```

> **两种场景的处理**：
>
> | 场景 | 配置时机 | 说明 |
> |------|---------|------|
> | **对接已有系统**（如已有的 Kafka/NSQ 消息队列、已有的 REST API） | 可以在写 model.md 之前就配置 | 接口是已知的、固定的；直接绑定到已知的 topic/endpoint |
> | **本系统提供的接口**（协议模型推导后才知道有哪些接口） | 必须在 `derive-specs` 之后配置 | 接口名（如 `create`、`accept`）是由协议推导出来的，配置前需要先知道有哪些 |

绑定完整性校验：

```bash
# 检查所有系统接口和观测接口是否都已绑定
# 系统接口缺失 → 报错（valid=false）
# 观测接口缺失 → 报错（valid=false，保证验证独立性）
protochain bind
```

输出示例（只绑定了 2 个系统接口 + 2 个观测接口时）：

```
绑定完整性检查：✗ 未通过
  系统接口: 11 个
  观测接口: 14 个
  未绑定的系统接口 (9):
    ✗ pay_success
    ✗ accept
    ✗ finish_preparing
    ...（其余略）
  未绑定的观测接口 (12):
    ✗ observe_备餐中
    ✗ observe_已出餐
    ...（其余略）
```

### 4.8 第八步：实现检查与验证

```bash
# ⑧ 实现完整性检查（扫描源码，检查接口是否实现）
protochain check-impl --src src/ --src lib/

# ⑩ 一致性验证（通过绑定层调用真实实现，比对行为与协议预期）
protochain verify
```

> **验证前置：环境变量（必读）**。绑定角色通过 `authConfig.tokenEnv` 从环境变量读取认证令牌。verify 前需 export（不 export 时 verify 不阻断，但相关接口将因 401 报偏差）：

```bash
export ADMIN_TOKEN=<管理令牌>    # R-Op 角色（管理/清理/停用/注销等操作）
export PORTAL_TOKEN=<用户令牌>   # R-User 角色（注册/登录/登出/映射配置等操作）
```

verify 启动时扫描当前环境所有角色绑定中的 `*Env` 字段（`tokenEnv` / `usernameEnv` / `passwordEnv` / `keyEnv` / `brokersEnv` / `nsqdTcpEnv` / `nsqlookupdHttpEnv` / `connectionEnv`），生成环境依赖清单落盘 `<系统根>/derived/env-deps.json`。未设置的环境变量打印显式告警（含角色、接口列表、预计失败类型），但**不阻断执行**；对应接口的 401 偏差文案区分两种情形：

- 令牌环境变量未配置：`401 认证失败：令牌环境变量 ADMIN_TOKEN 未配置`
- 令牌已发送但被拒绝：`401 认证失败：令牌无效（需要管理令牌）`

`verify` 的执行路径：
```
specs.json + test-cases.json + bindings（+ scenarios/*.yaml 可选）
  → 对每条测试用例的每一步转移：
    1. 通过绑定层调用真实系统接口（触发动作）
    2. 通过观测接口独立读取系统状态（不是信任动作响应）
    3. 将实际状态与协议预期状态比较
    4. 记录偏差
```

`verify` 的运行时参数（runtimeParams）来源，优先级从高到低：

1. **场景文件 params**（`protocol/scenarios/*.yaml`）：场景的 `expectedActions` 与测试路径的动作序列完全一致时命中，其 `params` 作为初始运行时参数（最高优先级，不被响应覆盖）
2. **动作响应字段注入**：如 `add` 返回 `{ serverId: "srv-001" }`，后续路径模板 `{serverId}` / 请求体自动使用该值
3. **currentState**：每一步自动维护

状态词表：观测接口/动作响应返回的系统词汇（如 `status: "online"`）通过 `bindings.stateMap`（协议状态 ID → 系统状态值）归一化后与协议状态 ID 比较；缺省时仅接受状态 ID 或状态名。详见 [6.4](#64-运行时参数runtimeparams) 与 [6.5](#65-状态词表映射statemap)。

### 4.9 一键执行

```bash
# 从 check 到 verify，自动跑完整个流程
protochain run --from check --to verify -y

# 仅执行到 formalize
protochain run --to formalize -y

# 从 derive-specs 开始（前提：前置步骤已通过）
protochain run --from derive-specs -y
```

`-y` 参数跳过交互式检查点确认。不加 `-y` 时，在 `reason`、`formalize`、`derive-contracts`、`generate-tests`、`generate-cases`、`verify` 之后会暂停等待人工确认。

---

## 五、多协议系统开发工作流

当系统由多个相互协作的子协议组成时，使用多协议模式。

### 5.1 初始化多协议项目

```bash
protochain init-multi \
  -s "SaaS内网映射系统" \
  -p "P1:用户配额同步,P2:入口配置,P3:节点连接,P4:计费结算"

cd saas-mapping
```

生成结构：

```
saas-mapping/
├── protochain.config.yaml
├── protocol/
│   ├── P1-用户配额同步/
│   │   └── model.md
│   ├── P2-入口配置/
│   │   └── model.md
│   ├── P3-节点连接/
│   │   └── model.md
│   ├── P4-计费结算/
│   │   └── model.md
│   └── composition.md        # 组合层协议
└── derived/
```

### 5.1.1 协议建模驱动开发（可选：init-runner 初始化编排实例）

当开发流程需要"多 agent 协作编排"（任务拆分、交接单、机械验收、回退、人工终审）时，用 `init-runner` 在建模工程之上再初始化一个 **protocol-runner 编排实例**：

```bash
protochain init-runner -s "SaaS内网映射系统" -p "P1:转发服务器管理,P2:用户注册登录,P3:内网映射配置"
```

生成结构（在 init-multi 基础上增加）：

```
项目根/
├── modeling/                    # 协议建模骨架（同 init-multi）
│   ├── protocol/P1..Pn/model.md
│   └── protochain.config.yaml   # 已含 bindings 段
├── docs/architecture.md         # 工程架构约束（技术栈/部署形态/架构决策）
├── impl/CONVENTIONS.md          # 实现规范（工程资产：命名、分层、存储约定）
└── protocol-runner/             # 编排实例（可移植，随项目版本化）
    ├── project.yaml             # 单元/阶段/交接单/闭包/环境/执行器
    ├── checklists/              # M/D/B/I/V/R 六单元清单
    ├── schemas/ scripts/ env/   # 产物 schema、自举/断言脚本、环境
    ├── executor-hooks.mjs       # 真实 human 终审执行器
    └── README.md                # 自带手册（实例化/运行说明）
```

- **占位符**：`{{PROJECT_NAME}}`/`{{MODELING_DIR}}`/`{{IMPL_DIR}}` 已替换（相对实例目录）；`{{API_KEY}}` 由使用者在生成的 modeling/protochain.config.yaml 中填写；
- **可移植**：生成的实例不含任何工具链源码路径，依赖 protochain（PATH 或 `{{PROTOCHAIN}}`）与 protocol-runner 引擎（编译版 `dist/runner.js` 或 bin）；
- **工程约束落点**：架构决策（技术栈/部署/架构）写 `docs/architecture.md`，实现规范（MySQL 命名等）写 `impl/CONVENTIONS.md`——均为工程资产、随项目版本化；I（实现）单元 `read-conventions` 读取遵循、`check-naming`（`scripts/check-mysql-naming.mjs`）机械验收，不合格机械回退；
- **第一需求自举**：`protocol-runner --project protocol-runner/` 后，M 单元 `init-modeling` 补全建模目录 → D 单元 `produce-derive` 跑十步推演（formalize/TLC 闸门）→ B/I/V → R 人工终审（`--resolve-escalation` 三问）；
- **模型缺陷闭环**：formalize/TLC 未通过 → m→d 验收失败 → 机械回退 M（derive 阶段 rollbackMap model→model）。

### 5.2 组合层协议

编辑 `protocol/composition.md`，描述子协议间的交互关系：

```markdown
---
name: SaaS内网映射系统
version: 1.0.0
roles:
  - id: operator
    name: 运维人员
---

# 背景

多协议组成的 SaaS 内网映射系统。

# 协议矩阵

| 协议 | 名称 | 关键状态 | 关键转移 |
|---|---|---|---|
| P1 | 用户配额同步 | sync_user_quota | 用户可用/锁定 |
| P2 | 入口配置 | create, delete | 配置可用/失效 |
| P3 | 节点连接 | establish_connection | 已连接/断开 |
| P4 | 计费结算 | settle | 已结算/欠费 |

# 协议依赖图

P1 → P2 (入口创建依赖用户配额状态)
P2 → P3 (节点连接依赖入口配置)
P1 → P4 (计费依赖配额)
P3 → P4 (计费依赖连接时长)

# 跨协议时序约束

| ID | 触发协议 | 触发事件 | 影响协议 | 影响动作 | 时限 |
|---|---|---|---|---|---|
| CROSS-1 | P1 | user_locked | P2 | reject_create | 30s 内 |
```

### 5.3 执行流程

多协议系统的执行分为子协议独立校验和组合层跨协议校验两个维度。`--dir` 始终指向系统根，全局 `--protocol <Pn>` 指定要操作的子协议（单协议项目无需指定）。

```bash
# 第一阶段：所有子协议独立跑完 check（可加 --protocol，或用旧写法 --dir protocol/P1）
protochain run --to check -y --protocol P1
protochain run --to check -y --protocol P2
# ...

# 第二阶段：组合层检查
protochain check-composition        # ①-C 组合层完备性

# 第三阶段：各子协议 reason
protochain reason --protocol P1
protochain reason --protocol P2
# ...

# 第四阶段：跨协议不变量检查
protochain check-cross-invariants   # ②-C

# 第五阶段：跨协议形式化
protochain formalize-cross          # ③-C

# 第六阶段：子协议接口推导
protochain run --from derive-specs -y --protocol P1
protochain run --from derive-specs -y --protocol P2
# ...

# 第七阶段：跨协议契约与用例
protochain derive-cross-contracts   # ④-C
protochain generate-cross-cases     # ⑦-C
```

子协议是独立的协议单元：`check` / `reason` / `derive-specs` / `check-impl` / `verify` / `version` 等单协议命令均可配合 `--protocol <Pn>` 对某个子协议单独执行。子协议产物（derived/、版本快照、编排状态）落在 `protocol/<Pn>/` 下，组合层命令从同路径消费，互不干扰。

---

## 六、接口绑定与真实验证

接口绑定层解决"纸上用例"与实际实现的对接问题。它将工具链推导的逻辑接口映射到真实的传输层配置。

> **配置时机**：见 [4.7 第七步：配置接口绑定](#47-第七步配置接口绑定)。简言之——对接已有系统的接口可以提前配置，本系统推导出的接口必须在 `derive-specs` 之后配置。

### 6.1 配置绑定

在 `protochain.config.yaml` 中配置 `bindings` 段：

```yaml
bindings:
  roles:
    R-User:
      roleId: R-User
      baseUrl: https://portal.internal/api
      auth: bearer
      authConfig:
        tokenEnv: PORTAL_TOKEN
      headers:
        X-Tenant-Id: "tenant-001"

  interfaces:
    # HTTP 系统接口
    - action: create
      roleId: R-User
      transport:
        type: http
        method: POST
        path: /v1/entries
        params:
          - logicalName: currentState
            in: body

    - action: delete
      roleId: R-User
      transport:
        type: http
        method: DELETE
        path: /v1/entries/{id}

    # Kafka 事件接口（fire-and-forget）
    - action: sync_user_quota
      roleId: R-OpSystem
      transport:
        type: kafka
        topic: user-quota-events
        serde: json
        responseMode: none

    # Kafka 请求-响应接口（wait for reply）
    - action: notify_lock
      roleId: R-OpSystem
      transport:
        type: kafka
        topic: lock-events
        keyField: user_id
        serde: json
        responseMode: reply_topic
        responseTopic: lock-events-resp
        correlationIdField: correlation_id

    # Kafka 事件接口（fire + poll observation）
    - action: trigger_billing
      roleId: R-OpSystem
      transport:
        type: kafka
        topic: billing-events
        serde: json
        responseMode: poll

    # NSQ 事件接口（fire-and-forget）
    - action: collect_logs
      roleId: R-LogCollector
      transport:
        type: nsq
        topic: log-collection
        serde: json
        responseMode: none

    # NSQ 请求-响应接口（wait for reply）
    - action: sync_status
      roleId: R-LogCollector
      transport:
        type: nsq
        topic: status-events
        serde: json
        responseMode: reply_topic
        responseTopic: status-events-resp
        correlationIdField: request_id
        channel: verify-channel       # 可选，不配则自动生成

    # 观测接口（独立读取状态）
    - action: observe_entry_state
      roleId: R-User
      transport:
        type: http
        method: GET
        path: /v1/entries/{id}/state

    # 观测接口（数据库直查）
    - action: observe_entry_run_status
      roleId: R-System
      transport:
        type: db_query
        dbType: postgres
        query: SELECT run_status FROM entries WHERE entry_id = $1
        connectionEnv: ENTRY_DB_URL
```

#### 多环境切换（environments + `--env`）

绑定配置可声明多个环境，**共享 `roles` / `interfaces`**，每个环境只覆盖角色的 `baseUrl` 与 `authConfig`（及 `kafka` / `nsq` 字段），适合"本地建模验证 / 预发环境"等场景：

```yaml
bindings:
  defaultEnv: dev                # 未指定 --env 时使用的环境
  environments:
    dev:                         # 本地建模验证：127.0.0.1 + 本地令牌
      roles:
        R-Op:
          baseUrl: http://127.0.0.1:8787
          authConfig:
            tokenEnv: ADMIN_TOKEN
        R-User:
          baseUrl: http://127.0.0.1:8787
          authConfig:
            tokenEnv: PORTAL_TOKEN
    staging:                     # 预发环境：远程地址 + 独立令牌
      roles:
        R-Op:
          baseUrl: https://staging.relay.example.com
          authConfig:
            tokenEnv: STAGING_ADMIN_TOKEN
        R-User:
          baseUrl: https://staging.relay.example.com
          authConfig:
            tokenEnv: STAGING_PORTAL_TOKEN
  roles:                         # 基础角色（environments 未覆盖时使用，单环境项目可直接用）
    R-Op:
      roleId: R-Op
      baseUrl: http://127.0.0.1:8787
      auth: bearer
      authConfig:
        tokenEnv: ADMIN_TOKEN
  interfaces: ...
```

- `--env <名称>`：`bind` / `verify` / `run` 均支持；未指定用 `defaultEnv`；两者皆无或未配置 `environments` 段时保持单环境行为（**向后兼容**）
- 环境覆盖按角色合并：`authConfig` / `kafka` / `nsq` 为**深合并**（只覆盖声明的字段），其余字段浅覆盖
- 环境切换后，verify 的环境变量扫描按当前环境的 `*Env` 字段执行（如 staging 扫描 `STAGING_ADMIN_TOKEN` 而非 `ADMIN_TOKEN`），`derived/env-deps.json` 同步反映

```bash
protochain bind --protocol P1 --env dev        # 用 dev 环境校验绑定完整性
protochain verify --protocol P2 --env staging  # 用 staging 环境执行一致性验证
```

### 6.2 绑定验证

```bash
# 检查所有系统接口和观测接口是否都已绑定
protochain bind
```

输出示例：

```
绑定完整性检查：✗ 未通过
  系统接口: 5 个
  观测接口: 3 个
  未绑定的系统接口 (2):
    ✗ create
    ✗ delete
  未绑定的观测接口 (1):
    ✗ observe_已创建
```

### 6.3 传输类型

| 类型 | 阶段 | 说明 | 配置示例 |
|------|------|------|---------|
| `http` | **P0 已实现** | REST API 调用 | `type: http, method: POST, path: /v1/entries` |
| `kafka` | **P1 已实现** | Kafka 消息队列 | `type: kafka, topic: events, serde: json, responseMode: none` |
| `nsq` | **P1 已实现** | NSQ 轻量级 pub/sub | `type: nsq, topic: events, serde: json, responseMode: none` |
| `db_query` | P1 计划中 | 数据库直查观测 | `type: db_query, dbType: postgres, query: SELECT ...` |
| `grpc` | P2 计划中 | gRPC 服务调用 | `type: grpc, service: X, method: Y` |

#### Kafka 配置详解

| 字段 | 说明 | 可选值 |
|------|------|--------|
| `topic` | Kafka topic 名称 | 字符串 |
| `serde` | 消息序列化格式 | `json`（已实现）/ `avro` / `protobuf`（待实现） |
| `keyField` | 用作 partition key 的字段名，从 runtimeParams 中读取 | 可选 |
| `responseMode` | 响应模式 | `none` / `reply_topic` / `poll` |
| `responseTopic` | 当 `responseMode=reply_topic` 时，等待响应的 topic | 条件必填 |
| `correlationIdField` | 匹配响应的字段名 | 默认 `correlation_id` |
| `timeoutMs` | 超时毫秒数 | 默认 10000 |

三种响应模式：

| 模式 | 行为 | 返回 |
|------|------|------|
| `none` | 发送后立即返回，不等待 | `{ sent: true }` |
| `reply_topic` | 发送后等待 `responseTopic` 上的匹配消息 | 匹配到的消息体 |
| `poll` | 发送后立即返回，由上层 verifier 轮询观测接口 | `{ sent: true, pollMode: true }` |

角色绑定的 Kafka 专用配置：

```yaml
roles:
  R-OpSystem:
    roleId: R-OpSystem
    kafka:
      brokersEnv: OP_KAFKA_BROKERS       # 环境变量名（不配则 fallback KAFKA_BROKERS）
      consumerGroup: protochain-verify
      sasl:                               # 可选，SASL 认证
        mechanism: scram-sha-256          # plain / scram-sha-256 / scram-sha-512
        usernameEnv: KAFKA_USER
        passwordEnv: KAFKA_PASS
```

#### NSQ 配置详解

| 字段 | 说明 | 可选值 |
|------|------|--------|
| `topic` | NSQ topic 名称 | 字符串 |
| `serde` | 消息体序列化格式（NSQ 原始字节） | 仅 `json` |
| `channel` | consumer channel 名称（reply_topic 模式用，不配则自动生成） | 可选 |
| `responseMode` | 响应模式 | `none` / `reply_topic` / `poll` |
| `responseTopic` | 当 `responseMode=reply_topic` 时，等待响应的 topic | 条件必填 |
| `correlationIdField` | 匹配响应的字段名 | 默认 `correlation_id` |
| `timeoutMs` | 超时毫秒数 | 默认 30000 |

三种响应模式：

| 模式 | 行为 | 返回 |
|------|------|------|
| `none` | pub 后立即返回，不等待 | `{ sent: true }` |
| `reply_topic` | pub 后订阅 `responseTopic` 的 channel，按 `correlationIdField` 匹配 | 匹配到的消息体 |
| `poll` | pub 后立即返回，由上层 verifier 轮询观测接口 | `{ sent: true, pollMode: true }` |

角色绑定的 NSQ 专用配置：

```yaml
roles:
  R-LogCollector:
    roleId: R-LogCollector
    nsq:
      nsqdTcpEnv: LOG_NSQD_TCP            # nsqd TCP 地址环境变量（格式 host:port）
      nsqlookupdHttpEnv: LOG_LOOKUPD      # 可选，nsqlookupd HTTP 地址（逗号分隔）
      responseTimeoutMs: 30000             # 可选，reply_topic 默认等待 30s
```

> **NSQ vs Kafka 选择建议**：
> - 需要高吞吐、多分区有序消费 → **Kafka**
> - 需要低运维、轻量级 pub/sub、每个消费者独立获取全部消息 → **NSQ**
> - NSQ 没有 consumer group 概念，每个 channel 收到 topic 的完整消息副本

### 6.4 运行时参数（runtimeParams）

bindings 定义的是参数的**形状与落点**（逻辑参数 → body/query/path/header、路径模板 `{x}`、Kafka `keyField`/`correlationIdField`），参数**值**由 `verify` 在运行时提供。来源按优先级从高到低：

| 优先级 | 来源 | 说明 |
|-------|------|------|
| 1（最高） | 场景文件 `params` | `protocol/scenarios/*.yaml` 的 `params` 段，按 `expectedActions` 与测试路径动作序列匹配；不被响应注入覆盖 |
| 2 | 动作响应字段注入 | 动作响应的**顶层原始字段**（字符串/数字/布尔，除保留字段 nextState/currentState/isInState/error/ok/sent/pollMode 等）自动注入，供后续路径模板/请求体使用。**不依赖 nextState 字段** |
| 3 | `currentState` | 每一步自动维护的当前状态 |

> **注入触发条件**：只要动作调用成功（2xx）且响应体含原始字段即注入——与响应是否含 `nextState` 无关。例如 `add` 返回 `{ serverId, status }`，`serverId` 即注入，后续 `/v1/servers/{serverId}/...` 自动替换。观测接口（GET）的路径参数（如 `{id}`、`{serverId}`）用同一 runtimeParams 填充。

场景文件示例（`protocol/scenarios/SC1.yaml`）：

```yaml
id: SC1
name: 服务器添加-退役
expectedActions: [add, retire]   # 与测试路径的动作序列一致才命中
params:
  serverId: srv-001              # 初始运行时参数（最高优先级）
```

> **多条路径**：测试路径按动作序列区分（`test-cases.json` 的每条 PATH 是一个动作序列）。一个场景文件只命中一条路径（`expectedActions` 必须与路径动作序列**完全一致**）。若协议有 N 条不同动作序列的路径，需 N 个场景文件（如 P2 的 7 条路径 → sc-01.yaml ~ sc-07.yaml）。不配场景文件也能验证——路径变量靠响应注入提供。

#### 场景 setup 段（测试前清理/准备）

场景文件可声明 `setup` 动作数组：每条**命中该场景的测试路径执行前**，按声明顺序调用绑定接口（复用绑定执行逻辑），用于清理上次验证残留的状态，保证同一场景文件可重复验证（如 P2 的注册用例：deregister 是逻辑注销，同名 register 在记录残留时会 409，需先物理删除）。

```yaml
id: SC-01
name: 注册-注销
expectedActions: [register, deregister]
setup:
  - action: purge_user          # 物理删除 alice 的用户记录与令牌（幂等，不存在也 200）
    params:
      username: alice
params:
  username: alice
  password: pw-alice
```

- `setup` 动作从 `bindings.interfaces` 按 `action` 直接解析（**不要求出现在 ⑤ specs 中**，如测试专用清理接口 `purge_user` / `purge_mapping` / `purge_server`），同样按 `--protocol` 过滤
- setup 失败（401、未绑定等）→ 该测试路径记偏差且不执行，偏差文案带 `setup:<action>` 前缀便于定位
- 无 `setup` 段时行为不变（向后兼容）

> 若某个路径变量（如 `{serverId}`）既没有场景 params、也没有动作响应提供，请求会按字面量路径发出（如 `/v1/servers/{serverId}`）导致 404——偏差报告中会体现。

### 6.5 状态词表映射（stateMap）

当系统的状态表达与协议状态 ID 不一致时（如系统返回 `status: "online"`，协议期望 `S2`），在 `bindings` 配置状态词表：

```yaml
bindings:
  stateMap:
    S1: offline
    S2: online
    S3: maintain
    S4: retired
  roles: ...
  interfaces: ...
```

归一化规则（依次尝试）：状态 ID 本身 → 状态名 → `stateMap` 映射值；都不匹配则按偏差处理。观测接口响应可取 `currentState` / `isInState` / `status` 字段（REST 资源体常见 `status`）。

### 6.6 多协议 bindings 隔离（protocol 字段）

多个子协议存在**同名 action**（如 P2/P3 都有 `enable`/`disable`/`delete`）时，必须为绑定条目打 `protocol` 标，verify / bind 按 `--protocol <Pn>` 过滤，否则会命中其他协议的同名绑定（如 P3 的 `enable` 请求到 P2 的 `/v1/users/{userId}/enable`）。

绑定条目 schema（`bindings.interfaces` 数组项）：

| 字段 | 必填 | 说明 |
|------|------|------|
| `action` | 是 | 逻辑接口名 = `InterfaceSpec.name`（动作名或 `observe_*`） |
| `roleId` | 是 | 对应 `bindings.roles` 中的角色 |
| `transport` | 是 | 传输配置（type/method/path/params 或 topic/serde/responseMode 等，见 6.3） |
| `protocol` | 多协议项目必填 | 子协议 ID（如 `P3`）；未打标条目作为兼容兜底，仅当无 protocol 命中时使用 |

过滤规则：

- 指定 `--protocol <Pn>` 时：保留 `protocol: <Pn>` 与**未打标**的条目，剔除其他协议条目；同 action 多命中时 protocol 命中优先
- 未指定（单协议项目）：使用全部条目，行为不变
- 未打标条目命中时会给出 `建议补充 protocol: <Pn>` 告警（`protochain bind` 可见）

```yaml
bindings:
  interfaces:
    # P2 用户管理
    - { action: enable, roleId: R-Op,  protocol: P2, transport: { type: http, method: POST, path: /v1/users/{userId}/enable } }
    # P3 映射管理
    - { action: enable, roleId: R-User, protocol: P3, transport: { type: http, method: POST, path: /v1/mappings/{mappingId}/enable } }
```

> `protochain bind --protocol Pn` 与 `protochain verify --protocol Pn` 使用同一过滤规则，行为一致。

### 6.7 verify 报告结构

`verify` 产出 `derived/verification/verification-report.json`，分两层：

- **authoritative（权威层，代码生成）**：每条用例的通过/失败/跳过与偏差详情
  - **路径用例**：来自 ⑦ `test-cases.json`，绑定模式下逐转移调用真实接口判定；**未绑定/无实现时跳过，跳过 ≠ 失败**
  - **negative-assurance 条目**：每个不变量（INV1/INV2…）一条，检查表达式非空且作用域声明——这是"通过: 2"的来源（非接口调用）
  - 总体 `passed = failed === 0`（跳过不影响通过判定）
- **auxiliary（辅助层，AI 可选）**：自然语言摘要，**非权威**，不作为自动化输入

控制台摘要 `通过: X / 失败: Y / 跳过: Z` 中的 `通过` 混合了路径用例与 negative-assurance 条目。

---

## 七、protocol-runner 集成（harness 子任务模式，P3）

设计依据：《protocol-runner 仓库 harness-design.md》§7（与 protochain 的衔接）。
protochain 作为 protocol-runner 的 **LLM 子任务执行器**（`config.driver: "protochain"`）接入，
通过 `exec-task` 子任务模式（实现：[src/exec-task/index.ts](../src/exec-task/index.ts)）消费结构化任务、回传结构化回执。

### 7.1 子任务模式（exec-task）

```bash
protochain exec-task <taskFile> --result <resultFile> [--dir <modelingDir>] [--persist-state]
```

- `taskFile`：protocol-runner `driver: protochain` 构造的 JSON（`steps` / `goal` / `useAI` /
  `context.modelPath` / `inputContract` / `writeDomain` / `budget` / `preflightAssertions`）。
  步骤来自执行器配置 `steps` 或 checklist 步骤 id；支持多协议（`--dir` 指向多协议建模根 + 子协议清单）。
- `resultFile`：写回结构化回执 `status`（completed/failed/aborted）+ `summary`/`reason` +
  `artifacts`/`partialArtifacts` + 账本 `facts`/`effects`/`openItems` + `cost`（含 loop `iterations`/`corrections`）。
- `--persist-state`：写 `orchestrator-state.yaml` 兼容既有 acceptance（默认无状态）。

### 7.2 预算与 preflight 语义

- `task.context.budget` 覆盖 `config.ai.loop`（`effectiveConfig`）：protocol-runner 实例在
  `executors[].config.budget` 声明生成 loop 硬预算，`TaskPackage.budget` 透传后由
  `generation-loop` 执行（§2.6：maxIterations/maxTokens/maxToolCalls 任一耗尽即失败）。
- `preflightAssertions` 在子任务模式下**只注入提示文本、不在 loop 内执行**（executed=0，
  与 protocol-runner DSH driver 的 P2 bridge 语义一致）；权威 acceptance 由 protocol-runner
  在子任务边界执行。
- AI 只进请求步骤自身的生成 loop；隐式前置推导（specs/contracts）固定走确定性路径，不为隐式重推导消耗预算。

### 7.3 边界红线

- 写域由 protocol-runner 侧 `runSandboxed` 快照强制（越界写入即失败）；exec-task 不自行宣布 acceptance 通过。
- 不侵入 `reason` / `formalize` 的代码确定性预判（BFS/SCC 主导，AI 不可推翻）。

---

## 八、迭代与版本管理

### 8.1 保存版本快照

```bash
# 修改 model.md 前保存当前版本
protochain version save
# 产出: protocol/versions/v1.0.0-20260731T120000/model.md + metadata.json
```

### 8.2 查看版本历史

```bash
protochain version list
protochain version show v1.0.0
```

### 8.3 差分与影响分析

```bash
# 修改 model.md 后，与保存的快照比较
protochain diff --old v1.0.0 --new v1.1.0
# 产出: diff/model-diff.json（结构化差异）+ diff/impact-analysis.json

# 分析受影响的下游产物
protochain impact
```

### 8.4 变更分类

```bash
# 将变更分类为"范式重协商"或"协议微调"
protochain version classify
# 产出: diff/classification.json
```

两类变更的语义：

- **范式重协商（paradigm_renegotiation）**：状态/转移的根本性改变，需要全量重新推导
- **协议微调（protocol_tweak）**：局部修改（如新增 guard 条件），增量推导即可

### 8.5 变更传播

```bash
# 清理因协议变更而 stale 的派生文件，生成增量重推导计划
protochain propagate --clean
# 产出: diff/propagate-plan.json
```

---

## 九、项目目录结构

```
project/
├── protochain.config.yaml          # 工具链配置
├── protocol/
│   ├── model.md                    # 协议权威源（单协议模式）
│   ├── scenarios/                  # 场景描述（可选）
│   ├── composition.md              # 组合层协议（多协议模式）
│   ├── P1-xxx/model.md             # 子协议权威源（多协议模式）
│   ├── P2-xxx/model.md
│   └── versions/                   # 版本快照
│       └── v1.0.0-xxx/
│           ├── model.md
│           └── metadata.json
├── derived/                        # 所有工具链推导产物
│   ├── completeness-report.json    # ① check 产出
│   ├── reasoning-report.json       # ② reason 产出
│   ├── formal/                     # ③ formalize 产出
│   │   └── formal-report.json
│   ├── specs.json                  # ⑤ derive-specs 产出
│   ├── contracts.json              # ④ derive-contracts 产出
│   ├── test-tool/                  # ⑥ generate-tests 产出
│   │   ├── protocol-model.ts
│   │   ├── scenario-loader.ts
│   │   ├── protocol-executor.ts
│   │   └── consistency-asserter.ts
│   ├── test-cases.json             # ⑦ generate-cases 产出
│   ├── impl-check/                 # ⑧ check-impl 产出
│   │   └── impl-check-report.json
│   ├── verification/               # ⑩ verify 产出
│   │   └── verification-report.json
│   ├── composition/                # 组合层产出
│   │   ├── completeness-report.json
│   │   ├── cross-contracts.json
│   │   └── cross-cases.json
│   └── cross-invariants-report.json
├── diff/                           # 版本差异化产出
│   ├── model-diff.json
│   ├── impact-analysis.json
│   ├── classification.json
│   └── propagate-plan.json
├── impl-scaffold/                  # 接口骨架输出
│   └── interfaces.d.ts
└── src/                            # 开发者实现代码
    └── ...
```

---

## 十、常见问题

### Q: 哪些命令需要 AI？

`reason`、`formalize`、`generate-tests`、`generate-cases` 需要 AI 适配器。其他命令（`check` 的机械层、`derive-specs`、`check-impl`、`generate-scaffold`、`bind`）是纯机械执行。

不带 AI 配置时，`check` 只执行机械层。其余需要 AI 的命令会报错退出。

### Q: 如何跳过某个步骤？

`protochain run` 支持 `--from`/`--to` 精确控制执行区间：

```bash
# 跳过 check，从 reason 开始
protochain run --from reason --to verify -y
```

注意：前置步骤必须已通过检查才能执行（工具链会从状态文件读取前置步骤的结果）。

### Q: derive-specs 和 derive-contracts 的编号为什么是 ⑤ 和 ④？

DAG 依赖图决定了执行序：`derive-specs`(⑤) 的输出是 `derive-contracts`(④) 的输入，所以 ⑤ 必须在 ④ 之前执行。编号只表示逻辑分组（④-⑤ 都在 formalize 之后，是平级步骤）。

### Q: formalize 如何调用真实的 TLC 模型检查器？

在 `protochain.config.yaml` 配置 `tlc` 段（见 [2.5 节](#25-tlc-模型检查器配置可选)）后，`formalize` 会通过 portable JRE + tla2tools.jar 真实运行 TLC 模型检查，不变量通过/反例为确定性结论（报告中 `toolExecuted: true`）。仅当 TLC 完全无法启动（未配置 / java 缺失）时降级为 AI 推演验证，报告标注 `tla-ai-fallback`；工具启动后的失败（不变量违反、超时）直接报告，不再尝试 AI。例外：代码生成骨架因生成器无法翻译自然语言守卫/不变量表达式而解析失败时（未产出结论），自动降级为 AI 推演验证；退化模式用户自写的 TLA+ 规格解析失败仍为权威失败。

### Q: 如何配置覆盖度？

在 `protochain.config.yaml` 中设置：

```yaml
coverage:
  criterion: path           # state | transition | path
  maxPathLength: 5          # path 准则下最大路径长度
```

也可在命令行覆盖：

```bash
protochain generate-cases --criterion transition
```

### Q: verify 全部报 401"认证失败：令牌环境变量 XXX 未配置"？

verify 通过绑定角色的 `authConfig.tokenEnv` 从环境变量读取认证令牌（如 `ADMIN_TOKEN` / `PORTAL_TOKEN`）。未设置时：

1. verify 启动会打印环境变量缺失告警（含角色、接口列表、预计失败类型），依赖清单落盘 `derived/env-deps.json`
2. 相关接口返回 401 且文案为"认证失败：令牌环境变量 XXX 未配置"（区别于"令牌无效"——后者表示令牌已发送但被服务器拒绝）
3. 解决方案：`export ADMIN_TOKEN=... PORTAL_TOKEN=...` 后重新执行 verify（见 [4.8 节](#48-第八步实现检查与验证)）
4. 若令牌已 export 但仍 401"令牌无效"，说明令牌值与服务器预期不符（如与建模 server 启动时使用的 `ADMIN_TOKEN` 不一致）

### Q: 如何清理验证残留状态，保证 verify 可重复执行？

场景文件的 `setup` 段在每条测试路径执行前调用清理接口（如 `purge_user` 物理删除用户记录）。P2 场景已内置；需要清理其他实体时，在场景文件中声明对应清理动作（见 [6.4 节场景 setup 段](#64-运行时参数runtimeparams)）。手动全量重置可调用建模服务的 `POST /v1/reset`（需管理令牌）。

### Q: 绑定配置可以复用吗？

可以通过 YAML 锚点复用角色配置：

```yaml
bindings:
  roles:
    R-User: &role-user
      roleId: R-User
      baseUrl: https://portal.internal/api
      auth: bearer
      authConfig:
        tokenEnv: PORTAL_TOKEN
```

### Q: 当前传输类型支持状态？

| 传输类型 | 支持状态 |
|---------|---------|
| `http` | ✅ P0 已实现，可通过 `verify` 调用真实 HTTP 接口 |
| `kafka` | ✅ P1 已实现，支持 none / reply_topic / poll 三种响应模式 + SASL 认证 |
| `nsq` | ✅ P1 已实现，支持 none / reply_topic / poll 三种响应模式 + nsqlookupd 服务发现 |
| `db_query` | ⬜ P1 计划中，当前返回 501 + 错误消息 |
| `grpc` | ⬜ P2 计划中，当前返回 501 + 错误消息 |

### Q: Kafka 需要安装什么依赖？

`kafkajs` 是可选依赖，运行时按需动态加载。首次使用 Kafka 传输时如未安装，会返回 error 消息提示 `npm install kafkajs`。

### Q: Kafka broker 地址如何配置？

两种方式：

1. 在角色绑定的 `kafka.brokersEnv` 中指定环境变量名（如 `OP_KAFKA_BROKERS`）
2. 不配置 `brokersEnv`，工具链自动 fallback 到 `KAFKA_BROKERS` 环境变量

多集群场景建议为每个角色使用独立的 `brokersEnv` 变量名以区分 broker 地址。

### Q: NSQ 需要安装什么依赖？

`nsqjs` 是可选依赖，运行时按需动态加载。首次使用 NSQ 传输时如未安装，会返回 error 消息提示 `npm install nsqjs`。

### Q: NSQ nsqd 地址如何配置？

两种方式：

1. 在角色绑定的 `nsq.nsqdTcpEnv` 中指定环境变量名（如 `LOG_NSQD_TCP`），值为 `host:port` 格式
2. 不配置 `nsqdTcpEnv`，工具链自动 fallback 到 `NSQD_TCP_ADDRESS` 环境变量

nsqlookupd（服务发现）为可选配置，通过 `nsq.nsqlookupdHttpEnv` 指定，格式为逗号分隔的 HTTP 地址列表。

### Q: NSQ 和 Kafka 应该选哪个？

| 维度 | Kafka | NSQ |
|------|-------|-----|
| 吞吐量 | 百万/秒级 | 万/秒级 |
| 持久化 | 磁盘 + 日志段 | 内存 + 溢出磁盘 |
| 消费模型 | consumer group（分区独占） | channel（广播副本） |
| 运维复杂度 | 较高（ZooKeeper/KRaft） | 较低（无外部协调依赖） |
| 适合场景 | 大规模事件流、跨系统数据同步 | 异步任务分发、实时通知、轻量级解耦 |
