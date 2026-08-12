---
name: 监控协议
version: 1.0.0
purpose: 定义监控（monitor）的启用、告警触发与关闭生命周期，作为 SaaS 系统的子协议 P5
roles:
  - id: tenant_admin
    name: 租户管理员
    responsibilities: 启用/关闭监控、查看告警
    roleType: consensus
  - id: system
    name: 系统
    responsibilities: 自动触发告警、执行监控检查
    roleType: participant
  - id: monitor_runtime
    name: 监控运行时
    responsibilities: 采集指标、触发告警规则
    roleType: participant
---

# 背景

监控协议定义 SaaS 系统中监控能力的生命周期管理。租户可为入口启用监控，系统在检测到异常指标时自动触发告警，运维人员处理后可解除告警状态。本协议支持告警与入口的关联关系。

# 核心概念

- **监控**: 对入口流量和节点资源的指标采集与异常检测
- **告警**: 指标超出阈值时系统自动生成的异常通知
- **告警关联**: 告警事件与所属入口的绑定关系

# 协作流程

租户管理员为入口启用监控，系统持续采集指标。发现异常时自动触发告警，运维人员处理告警后解除。租户可关闭监控停止采集。

# 状态空间

| ID | 名称 | 类型 | 描述 | 角色 |
|---|---|---|---|---|
| S1 | 未监控 | initial | 入口尚未启用监控 | tenant_admin |
| S2 | 监控中 | normal | 监控正常运行，指标正常 | monitor_runtime |
| S3 | 告警中 | normal | 已触发告警，等待处理 | monitor_runtime |
| S4 | 已关闭 | terminal | 监控已关闭，停止指标采集 | tenant_admin |

# 转移规则

| ID | 名称 | from | to | action | 触发 | 触发类型 | 动作类型 | 影响维度 | guard |
|---|---|---|---|---|---|---|---|---|---|
| T1 | 启用监控 | S1 | S2 | enable_monitoring | tenant_admin | role | state_transition | | entry_exists |
| T2 | 关闭监控 | S2 | S4 | disable_monitoring | tenant_admin | role | state_transition | | |
| T3 | 触发告警 | S2 | S3 | trigger_alert | system | system | state_transition | alert_count | threshold_exceeded |
| T4 | 解除告警 | S3 | S2 | resolve_alert | tenant_admin | role | state_transition | alert_count | alert_handled |

# 不变量

| ID | 名称 | 表达式 | 作用状态 | 声明方 | 不变量类别 |
|---|---|---|---|---|---|
| INV1 | 告警关联入口 | forall a: exists e: alert_entry(a) = entry_id(e) | S3 | platform | intra_protocol |

# 时序约束

| ID | 名称 | 类型 | 源 | 目标 | 约束值(ms) | 描述 |
|---|---|---|---|---|---|---|
| TM1 | 告警未解除超时 | timeout | trigger_alert | resolve_alert | 3600000 | 告警触发后 1 小时内须处理解除 |
