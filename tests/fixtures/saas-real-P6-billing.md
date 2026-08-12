---
name: 经营系统对接协议
version: 1.0.0
purpose: 定义与外部经营系统的事件同步协议，作为 SaaS 内网映射系统的子协议 P6
roles:
  - id: system
    name: 系统
    responsibilities: 接收经营系统事件、执行对应操作、保障系统继续运行
    roleType: consensus
  - id: billing_system
    name: 经营系统
    responsibilities: 推送用户与配额变更事件
    roleType: participant
---

# 背景

经营系统对接协议定义本系统与外部经营系统的交互规则。经营系统负责用户注册、配额购买等经营行为，通过事件同步方式与本系统对接。事件可能延迟、重复、乱序，本系统需要保证幂等处理和继续运行。

# 核心概念

- **经营系统**：外部系统，负责用户经营行为（注册、配额购买、锁定）
- **事件同步**：经营系统向本系统推送用户与配额变更事件
- **消极保证**：经营系统不可用时本系统继续运行，不阻塞等待

# 协作流程

经营系统推送用户注册、配额变更、锁定/解锁事件。本系统接收事件并同步用户和配额状态。事件延迟、重复、乱序时本系统仍能正确运行。本系统也支持经营系统查询用户使用情况（入口列表、配额使用、流量消耗）。

# 状态空间

| ID | 名称 | 类型 | 描述 | 角色 |
|---|---|---|---|---|
| S1 | 正常运行 | initial | 经营系统连接正常，事件正常同步 | system |
| S2 | 经营系统不可用 | normal | 经营系统断连，事件延迟积压，本系统继续运行 | system |

# 转移规则

| ID | 名称 | from | to | action | trigger | guard | effects | triggerType | actionType | affectsDimensions |
|---|---|---|---|---|---|---|---|---|---|---|
| T1 | 经营系统断连 | S1 | S2 | billing_disconnect | system | | | system | state_transition | billing_status |
| T2 | 经营系统恢复 | S2 | S1 | billing_reconnect | billing_system | | | external | state_transition | billing_status |

# 不变量

| ID | 名称 | 表达式 | 作用状态 | declaredBy | invariantClass |
|---|---|---|---|---|---|
| INV1 | 事件幂等 | each_event_idempotent | S1,S2 | system | intra_protocol |
| INV2 | 事件去重 | duplicate_events_ignored | S1,S2 | system | intra_protocol |
| INV3 | 经营系统不可用不影响现有入口 | billing_unavailable不影响已启用入口 | S2 | system | cross_protocol |

# 时序约束

| ID | 名称 | 类型 | 源 | 目标 | boundMs | onViolation | schedule |
|---|---|---|---|---|---|---|---|
| TM1 | 用户锁定后入口停用时限 | deadline | S1 | S1 | 60000 | | |
| TM2 | 流量耗尽后关闭时限 | deadline | S1 | S1 | 60000 | | |
| TM3 | 配额减少后暂停超额入口时限 | deadline | S1 | S1 | 60000 | | |
| TM4 | 服务器下线后迁移时限 | deadline | S1 | S1 | 60000 | | |
| TM5 | 流量配额重置后恢复时限 | deadline | S1 | S1 | 60000 | | |
| TM6 | 入口状态变更后通知推送时限 | deadline | S1 | S1 | 60000 | | |
| TM7 | 配额到期后冻结时限 | deadline | S1 | S1 | 60000 | | |
| TM8 | 续期后恢复时限 | deadline | S1 | S1 | 60000 | | |

# 资源池

```yaml
- id: RP1
  name: 事件去重缓存
  type: 已处理事件 ID 集合
  capacity: dynamic
  allocationRule: 收到事件时缓存事件 ID
  releaseRule: 事件超过去重窗口后释放
  constraints:
    - 同一事件 ID 最多处理一次
  checkMethod: 查询事件去重缓存
```

# 外部事件

```yaml
- id: EE1
  name: 新增用户
  source: billing_system
  triggerAction: user_created
  idempotencyKey: user_id
  ordering: by_event_time
  onDelay: continue
  onDuplicate: ignore
- id: EE2
  name: 新增配额包
  source: billing_system
  triggerAction: quota_added
  idempotencyKey: quota_package_id
  ordering: by_event_time
  onDelay: continue
  onDuplicate: ignore
- id: EE3
  name: 减少配额包
  source: billing_system
  triggerAction: quota_reduced
  idempotencyKey: quota_package_id
  ordering: by_event_time
  onDelay: continue
  onDuplicate: ignore
- id: EE4
  name: 锁定用户
  source: billing_system
  triggerAction: user_locked
  idempotencyKey: user_id
  ordering: by_event_time
  onDelay: continue
  onDuplicate: ignore
- id: EE5
  name: 解锁用户
  source: billing_system
  triggerAction: user_unlocked
  idempotencyKey: user_id
  ordering: by_event_time
  onDelay: continue
  onDuplicate: ignore
- id: EE6
  name: 变更配额包类型
  source: billing_system
  triggerAction: quota_type_changed
  idempotencyKey: quota_package_id
  ordering: by_event_time
  onDelay: continue
  onDuplicate: ignore
```

# 消极保证

```yaml
- id: NA1
  name: 经营系统不可用时继续运行
  expression: billing_system_unavailable不影响系统核心功能（入口转发不中断、入口管理不阻塞）
  scope: S2
  declaredBy: system
  checkMethod: 经营系统断连后功能完整性测试
- id: NA2
  name: 滞后期间新建入口回溯校验
  expression: billing_unavailable期间允许新建入口，恢复后回溯校验配额
  scope: S2
  declaredBy: system
  checkMethod: 经营系统恢复后配额回溯检查
```
