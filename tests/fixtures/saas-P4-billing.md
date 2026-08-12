---
name: 计费协议
version: 1.0.0
purpose: 定义计费（billing）的生成、处理与结算生命周期，作为 SaaS 系统的子协议 P4
roles:
  - id: platform
    name: 平台
    responsibilities: 生成计费记录、执行结算
    roleType: consensus
  - id: payment_gateway
    name: 支付网关
    responsibilities: 处理支付、发起争议
    roleType: participant
  - id: system
    name: 系统
    responsibilities: 定时触发计费、执行结算
    roleType: participant
---

# 背景

计费协议定义 SaaS 系统中计费记录从生成到结算的完整生命周期。计费记录基于入口流量和节点资源消耗生成，通过支付网关完成扣款，支持争议处理流程。

# 核心概念

- **计费记录**: 基于资源消耗生成的费用明细
- **结算**: 完成扣款并将计费记录归档
- **争议**: 支付网关发起的交易争议流程

# 协作流程

平台定时生成计费记录，进入计费状态后提交支付网关处理。正常完成后结算归档。若支付网关发起争议，则进入争议处理流程。

# 状态空间

| ID | 名称 | 类型 | 描述 | 角色 |
|---|---|---|---|---|
| S1 | 待计费 | initial | 计费记录已生成，等待处理 | platform |
| S2 | 计费中 | normal | 计费正在处理，待支付网关确认 | system |
| S3 | 已结算 | terminal | 计费已完成，记录归档 | platform |

# 转移规则

| ID | 名称 | from | to | action | 触发 | 触发类型 | 动作类型 | 影响维度 | guard |
|---|---|---|---|---|---|---|---|---|---|
| T1 | 计费 | S1 | S2 | bill | system | role | state_transition | amount | billing_record_valid |
| T2 | 结算 | S2 | S3 | settle | platform | role | state_transition | | payment_confirmed |
| T3 | 争议 | S2 | S1 | dispute | payment_gateway | external | state_transition | | dispute_raised |

# 不变量

| ID | 名称 | 表达式 | 作用状态 | 声明方 | 不变量类别 |
|---|---|---|---|---|---|
| INV1 | 计费一致性 | forall b: total_amount(b) = sum(entry_traffic_fees) + sum(node_resource_fees) | S2, S3 | platform | intra_protocol |

# 时序约束

| ID | 名称 | 类型 | 源 | 目标 | 约束值(ms) | 描述 |
|---|---|---|---|---|---|---|
| TM1 | 计费周期 | scheduled | bill | settle | 86400000 | 每日定时触发计费，24 小时内完成结算 |
