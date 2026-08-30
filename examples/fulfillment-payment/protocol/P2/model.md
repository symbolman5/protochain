---
name: 支付协议
version: 1.0.0
purpose: 描述支付从发起、回调成功到退款的完整生命周期；包含 W1-b 关系断言段（三种断言各至少一条）与受限谓词语法守卫（TC1/TC2 实例载体）
roles:
  - id: customer
    name: 顾客
    responsibilities: 发起支付、发起退款
    roleType: consensus
  - id: platform
    name: 平台
    responsibilities: 协调支付、审批退款
    roleType: participant
  - id: payment_gateway
    name: 支付网关
    responsibilities: 处理支付、回调支付结果
    roleType: participant
---

# 背景

支付协议定义顾客发起支付、支付网关回调结果、平台审批退款的协作规则。核心约束是：支付金额必须与订单金额一致（`paid_amount == order_amount`），支付幂等键全局唯一（`unique(payment_id)`，数据级不变量），退款必须发生在支付成功后。

# 核心概念

- **支付幂等键**：payment_id 全局唯一，支付网关事件重复推送时幂等处理
- **支付回调**：支付网关在支付结果确定后推送回调，触发状态迁移
- **退款**：仅已支付订单可发起退款，退款后进入终态

# 协作流程

顾客发起支付后订单进入支付中状态，支付网关回调成功则进入已支付状态（可退款），回调失败则进入支付失败终态；平台审批通过后发起退款，订单进入已退款终态。

# 异常处理原则

- 支付网关回调可能延迟或重复，通过 payment_id 幂等处理
- 支付超时（5 分钟）由系统判定支付失败

# 状态空间

| ID | 名称 | 类型 | 描述 | 角色 |
|---|---|---|---|---|
| S0 | 待支付 | initial | 支付未发起 | customer |
| S1 | 支付中 | normal | 支付已发起，等待网关回调 | customer |
| S2 | 已支付 | normal | 支付成功，可退款 | customer, platform |
| S3 | 已退款 | terminal | 退款完成 | platform |
| S4 | 支付失败 | terminal | 支付失败终态 | customer |

# 转移规则

| ID | 名称 | from | to | action | trigger | guard | effects | triggerType | actionType | affectsDimensions |
|---|---|---|---|---|---|---|---|---|---|---|
| T1 | 发起支付 | S0 | S1 | pay | customer | nonNegative(amount) | | role | state_transition | |
| T2 | 支付成功回调 | S1 | S2 | pay_success | payment_gateway | 支付网关回调签名校验通过 | | role | state_transition | |
| T3 | 支付失败 | S1 | S4 | pay_failed | payment_gateway | 回调签名校验失败且重试次数超限 | | role | state_transition | |
| T4 | 发起退款 | S2 | S3 | refund | platform | nonEmpty(refund_reason) | | role | state_transition | |

# 不变量

| ID | 名称 | 表达式 | 作用状态 | 声明方 | 不变量类别 | 描述 | level | source | storageRef |
|---|---|---|---|---|---|---|---|---|---|
| INV1 | 金额一致性 | paid_amount == order_amount | S0, S1, S2 | customer | intra_protocol | 支付金额必须等于订单金额（跨字段谓词） | state-machine | | |
| INV2 | 支付幂等键唯一 | unique(payment_id) | S0, S1, S2 | customer | intra_protocol | 支付幂等键全局唯一（数据级不变量） | data | storage | payments |
| INV3 | 退款须已支付 | 仅已支付订单可发起退款 | S3 | customer | intra_protocol | 退款必须发生在支付成功后 | state-machine | | |

# 时序约束

| ID | 名称 | 类型 | 源 | 目标 | 约束值(ms) | 违约转移 | schedule | 描述 |
|---|---|---|---|---|---|---|---|---|
| TM1 | 支付超时 | timeout | pay | pay_failed | 300000 | | | 支付发起后 5 分钟内未回调成功判定为支付失败 |

# 异常路径

| ID | 名称 | 触发 | 转移序列 | 恢复策略 |
|---|---|---|---|---|
| EX1 | 支付超时 | 支付发起后 5 分钟内未回调成功 | T3 | 系统判定支付失败，通知顾客重新发起 |

# 关系断言

```yaml
- id: PA1
  kind: depends_on
  a: T2
  b: T1
  note: 支付成功回调依赖支付发起（T1 前置 T2）
- id: PA2
  kind: sequence
  a: T2
  b: T4
  note: 支付成功先于退款发起
- id: PA3
  kind: shares_invariant
  a: S0
  b: S2
  note: 支付全过程金额一致（INV1 覆盖）
```

# 契约层

```yaml
parties: [customer, platform]
contracts:
  - interface: pay
    requestSchema:
      type: object
      properties:
        amount: { type: number }
      required: [amount]
    errorResponses:
      - id: er_payment_failed
        errorCode: ERR_PAYMENT_FAILED
        httpStatus: 402
        description: 支付失败，金额扣款未成功
  - interface: refund
    requestSchema:
      type: object
      properties:
        refund_reason: { type: string }
      required: [refund_reason]
    errorResponses:
      - id: er_refund_rejected
        errorCode: ERR_REFUND_REJECTED
        httpStatus: 409
        description: 退款被拒，订单状态不允许退款
```
