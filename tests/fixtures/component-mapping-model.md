---
name: 组件映射 fixture
version: 1.0.0
purpose: 验证 G7-S5b（X18）组件映射段解析与 R-KIND-10 交叉一致性检查
roles:
  - id: r1
    name: 角色1
    roleType: consensus
---

# 背景

验证组件映射段（三张映射表）与交叉一致性检查。

# 状态空间

| ID | 名称 | 类型 | 描述 | 角色 |
|---|---|---|---|---|
| S0 | 初始 | initial | 初始态 | r1 |
| S1 | 已下单 | normal | 订单已提交 | r1 |
| S2 | 已支付 | terminal | 支付完成 | r1 |

# 转移规则

| ID | 名称 | from | to | action | trigger | guard | effects | triggerType | actionType | affectsDimensions |
|---|---|---|---|---|---|---|---|---|---|---|
| T1 | 下单 | S0 | S1 | place_order | r1 | | | role | state_transition | order_status |
| T2 | 支付 | S1 | S2 | confirm_payment | r1 | | | role | state_transition | payment_status |

# 附属实体

```yaml
- id: payment
  name: 支付单
  belongsTo: S1（本协议）
  instanceKey: payment.id
  lifecycleDependency: 随订单进入 S1 创建、进入 S2 关闭
  cascadeRules:
    - 订单进入 S1 时创建支付单
    - 支付完成后关闭支付单
  stateSpace:
    dimensions:
      - name: payment_status
        type: string
        initial: ""
      - name: order_status
        type: string
        initial: ""
  invariants:
    - payment_status 在支付完成前不可为 paid
```

# 组件映射

```yaml
interfaceImplementations:
  - interface: place_order
    component: order-service
    description: 订单服务承载下单接口
  - interface: confirm_payment
    component: payment-service
dimensionStorage:
  - dimension: payment_status
    table: payments
    field: status
  - dimension: order_status
    table: orders
componentTransfers:
  - from: order-service
    to: payment-service
    channel: http
    mode: sync
    description: 下单后同步请求支付
```
