---
name: 租户协议
version: 1.0.0
purpose: 定义租户（tenant）的创建、激活与删除生命周期，作为 SaaS 系统的子协议 P1
roles:
  - id: tenant_admin
    name: 租户管理员
    responsibilities: 创建租户、管理租户信息
    roleType: consensus
  - id: system
    name: 系统
    responsibilities: 执行租户状态管理、超时回收
    roleType: participant
---

# 背景

租户是 SaaS 系统多租户架构的基础实体。租户协议定义租户从创建到删除的完整生命周期，确保租户在系统中的唯一性，并通过超时机制回收已停用的租户资源，防止僵尸租户堆积。

# 核心概念

- **租户**: SaaS 系统中独立的隔离单元，包含入口、节点等子资源
- **租户状态**: 租户在生命周期中所处的阶段
- **超时回收**: 租户停用超过 30 天后自动删除

# 协作流程

租户管理员创建租户（草稿），激活后进入活跃状态。租户活跃期间可管理其下的入口和节点。停用操作将租户标记为已停用，30 天后系统自动执行删除回收。

# 状态空间

| ID | 名称 | 类型 | 描述 | 角色 |
|---|---|---|---|---|
| S1 | 草稿 | initial | 租户创建中，尚未生效 | tenant_admin |
| S2 | 活跃 | normal | 租户正常运行，可使用子资源 | tenant_admin |
| S3 | 已删除 | terminal | 租户已删除，资源已回收 | system |

# 转移规则

| ID | 名称 | from | to | action | 触发 | 触发类型 | 动作类型 | 影响维度 | guard |
|---|---|---|---|---|---|---|---|---|---|
| T1 | 创建 | - | S1 | create | tenant_admin | role | state_transition | | tenant_name_valid |
| T2 | 激活 | S1 | S2 | activate | tenant_admin | role | state_transition | | tenant_info_complete |
| T3 | 停用 | S2 | S1 | deactivate | tenant_admin | role | state_transition | | has_no_active_entries |
| T4 | 删除 | S1 | S3 | delete | system | role | state_transition | | |

# 不变量

| ID | 名称 | 表达式 | 作用状态 | 声明方 | 不变量类别 |
|---|---|---|---|---|---|
| INV1 | 租户唯一 | forall t: unique(tenant_name) | S1, S2 | platform | intra_protocol |
| INV2 | 活跃租户不可删除 | forall t: not (state=S2 and action=delete) | S2 | platform | intra_protocol |

# 时序约束

| ID | 名称 | 类型 | 源 | 目标 | 约束值(ms) | 描述 |
|---|---|---|---|---|---|---|
| TM1 | 停用删除超时 | timeout | deactivate | delete | 2592000000 | 停用后 30 天内须完成删除回收 |
