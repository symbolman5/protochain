---
name: 节点协议
version: 1.0.0
purpose: 定义节点（node）的调度、运行与下线生命周期，作为 SaaS 系统的子协议 P3
roles:
  - id: platform
    name: 平台
    responsibilities: 调度节点、监控节点状态
    roleType: consensus
  - id: node_runtime
    name: 节点运行时
    responsibilities: 执行节点逻辑、上报健康状态
    roleType: participant
  - id: system
    name: 系统
    responsibilities: 执行健康检查、触发自动调度
    roleType: participant
---

# 背景

节点是 SaaS 系统中承载入口流量的计算单元。节点协议定义节点从待调度到运行、最终下线的完整生命周期，确保节点资源的合理预留与及时回收。

# 核心概念

- **节点**: 承载入口流量和业务逻辑的计算单元
- **资源预留**: 节点启动时为其分配固定资源（CPU、内存、网络）
- **健康检查**: 系统周期性检测节点运行状态

# 协作流程

平台将待调度节点分配资源并启动运行。节点运行中接受系统周期性健康检查。节点停止服务后下线回收资源。

# 状态空间

| ID | 名称 | 类型 | 描述 | 角色 |
|---|---|---|---|---|
| S1 | 待调度 | initial | 节点已创建，等待资源分配 | platform |
| S2 | 运行中 | normal | 节点正常运行，承载入口流量 | node_runtime |
| S3 | 已下线 | terminal | 节点已停止，资源已回收 | platform |

# 转移规则

| ID | 名称 | from | to | action | 触发 | 触发类型 | 动作类型 | 影响维度 | guard |
|---|---|---|---|---|---|---|---|---|---|
| T1 | 调度 | - | S1 | schedule | platform | role | state_transition | | resources_available |
| T2 | 启动 | S1 | S2 | start | platform | role | state_transition | | resource_allocated |
| T3 | 停止 | S2 | S3 | stop | platform | role | state_transition | | |
| T4 | 健康检查 | S2 | S2 | health_check | system | system | attribute_update | health_status | |

# 不变量

| ID | 名称 | 表达式 | 作用状态 | 声明方 | 不变量类别 |
|---|---|---|---|---|---|
| INV1 | 节点资源预留 | forall n: allocated_resources(n) >= required_resources(n) | S2 | platform | intra_protocol |

# 时序约束

| ID | 名称 | 类型 | 源 | 目标 | 约束值(ms) | 描述 |
|---|---|---|---|---|---|---|
| TM1 | 健康检查周期 | scheduled | health_check | health_check | 30000 | 健康检查每 30 秒周期性调度 |
| TM2 | 节点下线回收 | timeout | stop | resource_reclaim | 60000 | 节点下线后 60 秒内回收资源 |
