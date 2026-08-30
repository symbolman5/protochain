---
name: 履约协议
version: 1.0.0
purpose: 描述订单确认、履约执行到履约完成的完整生命周期，守卫条件包含受限谓词语法命中与自然语言未命中两类样例（W2 实例载体）
roles:
  - id: customer
    name: 顾客
    responsibilities: 提交订单、确认履约
    roleType: consensus
  - id: platform
    name: 平台
    responsibilities: 履约协调、超时扫描、退款取消
    roleType: participant
  - id: merchant
    name: 商家
    responsibilities: 开始履约、完成履约
    roleType: participant
---

# 背景

履约协议描述订单确认后商家执行履约的协作规则：顾客确认订单后，商家开始履约并在时限内完成。协议的核心约束是：履约数量必须与订单数量一致（`fulfillment_qty == order_qty`，受限谓词语法），取消路径有清晰的责任边界。

# 核心概念

- **订单确认**：顾客对订单内容确认，履约流程启动
- **履约数量**：商家实际履约的数量，须与订单数量一致（跨字段谓词约束）
- **退款取消**：支付协议退款完成后（P2.S_refunded），履约协议取消该订单

# 协作流程

顾客确认订单后订单进入已确认状态，商家开始履约并进入履约中，商家完成履约后订单进入已履约完成终态；若支付协议退款完成（P2.S_refunded），平台取消订单进入已取消终态。

# 异常处理原则

- 商家超时未履约由平台扫描兜底取消
- 退款取消以支付协议退款终态为前置条件（跨协议引用）

# 状态空间

| ID | 名称 | 类型 | 描述 | 角色 |
|---|---|---|---|---|
| S0 | 已创建 | initial | 订单已创建，待确认 | customer |
| S1 | 已确认 | normal | 顾客已确认订单 | customer |
| S2 | 履约中 | normal | 商家正在履约 | merchant |
| S3 | 已履约完成 | terminal | 履约完成，订单闭环 | customer |
| S4 | 已取消 | terminal | 订单取消（退款前置） | platform |

# 转移规则

| ID | 名称 | from | to | action | trigger | guard | effects | triggerType | actionType | affectsDimensions |
|---|---|---|---|---|---|---|---|---|---|---|
| T1 | 确认订单 | S0 | S1 | confirm_order | customer | nonEmpty(order_id) | | role | state_transition | |
| T2 | 开始履约 | S1 | S2 | start_fulfillment | merchant | 库存充足且订单已确认 | | role | state_transition | |
| T3 | 完成履约 | S2 | S3 | complete_fulfillment | merchant | fulfillment_qty == order_qty | | role | state_transition | |
| T4 | 退款取消 | S2 | S4 | refund_cancel | platform | 退款已批准 且 P2.S_refunded | | role | state_transition | |

# 不变量

| ID | 名称 | 表达式 | 作用状态 | 声明方 | 不变量类别 | 描述 |
|---|---|---|---|---|---|---|
| INV1 | 履约数量一致 | fulfillment_qty == order_qty | S2, S3 | customer | intra_protocol | 履约数量必须等于订单数量（跨字段谓词） |
| INV2 | 取消不产生履约费用 | 取消订单后不产生履约费用 | S4 | customer | intra_protocol | 退款取消路径不向顾客收取履约费用 |

# 时序约束

| ID | 名称 | 类型 | 源 | 目标 | 约束值(ms) | 违约转移 | schedule | 描述 |
|---|---|---|---|---|---|---|---|---|
| TM1 | 履约时限 | timeout | start_fulfillment | complete_fulfillment | 3600000 | | | 商家开始履约后 1 小时内必须完成 |

# 异常路径

| ID | 名称 | 触发 | 转移序列 | 恢复策略 |
|---|---|---|---|---|
| EX1 | 履约超时 | 商家开始履约后 1 小时内未完成 | T4 | 平台取消订单并联动支付协议退款 |

# 契约层

```yaml
parties: [customer, platform]
contracts:
  - interface: confirm_order
    requestSchema:
      type: object
      properties:
        order_id: { type: string }
      required: [order_id]
    errorResponses:
      - id: er_order_not_found
        errorCode: ERR_ORDER_NOT_FOUND
        httpStatus: 404
        description: 订单不存在或已失效
  - interface: complete_fulfillment
    requestSchema:
      type: object
      properties:
        fulfillment_qty: { type: integer }
        order_qty: { type: integer }
      required: [fulfillment_qty, order_qty]
    errorResponses:
      - id: er_stock_insufficient
        errorCode: ERR_STOCK_INSUFFICIENT
        httpStatus: 409
        description: 库存不足，无法开始履约
      - id: er_fulfillment_timeout
        errorCode: ERR_FULFILLMENT_TIMEOUT
        httpStatus: 408
        description: 履约超时未完成
```
