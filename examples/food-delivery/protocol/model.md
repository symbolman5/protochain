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
