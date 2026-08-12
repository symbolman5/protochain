---
name: 推送节点与长连接协议
version: 1.0.0
purpose: 定义推送节点生命周期（4 态）与消息推送连接管理，作为 SaaS 内网映射系统的子协议 P4
roles:
  - id: user
    name: 用户
    responsibilities: 注册、删除推送节点
    roleType: consensus
  - id: system
    name: 系统
    responsibilities: 检测连接状态、管理消息推送
    roleType: participant
  - id: client
    name: 客户端
    responsibilities: 建立和维持消息推送连接
    roleType: participant
---

# 背景

推送节点是用户注册的客户端代理，用于接收访问入口状态变更的通知。节点通过消息推送连接与转发服务器保持长连接。节点状态由连接情况决定，入口可以绑定一个推送节点作为通知目标。

# 核心概念

- **推送节点**：用户注册的客户端代理，用于接收入口状态变更通知
- **消息推送连接**：客户端与转发服务器之间的长连接，用于推送通知
- **心跳超时**：客户端周期性发送心跳，超时则断开连接

# 协作流程

用户注册推送节点（已注册），客户端建立消息推送连接后节点上线（在线）。连接断开后进入离线态，客户端重新建立连接后回到在线态。用户可删除节点（需先解除所有入口绑定）。

# 状态空间

| ID | 名称 | 类型 | 描述 | 角色 |
|---|---|---|---|---|
| S1 | 已注册 | initial | 节点已注册，尚未建立消息推送连接 | user |
| S2 | 在线 | normal | 消息推送连接已建立，可接收通知 | client |
| S3 | 离线 | normal | 消息推送连接断开 | system |
| S4 | 已删除 | terminal | 节点已删除 | user |

# 转移规则

| ID | 名称 | from | to | action | trigger | guard | effects | triggerType | actionType | affectsDimensions |
|---|---|---|---|---|---|---|---|---|---|---|
| T1 | 注册节点 | - | S1 | register | user | | | role | state_transition | |
| T2 | 节点上线 | S1 | S2 | connect | client | | | system | state_transition | |
| T3 | 节点重连上线 | S3 | S2 | reconnect | client | | | system | state_transition | |
| T4 | 节点离线 | S2 | S3 | disconnect | system | | | system | state_transition | |
| T5 | 删除节点 | S1,S2,S3 | S4 | delete | user | no_entry_bound | | role | state_transition | |

# 不变量

| ID | 名称 | 表达式 | 作用状态 | declaredBy | invariantClass |
|---|---|---|---|---|---|
| INV1 | 同一节点最多一个活跃连接 | at_most_one_active_connection_per_node | S2 | user | intra_protocol |
| INV2 | 连接不可冒充 | connection_not_impersonable | S2 | user | cross_protocol |
| INV3 | 删除前必须解绑 | delete_requires_no_bound_entry | S1,S2,S3 | user | intra_protocol |

# 时序约束

| ID | 名称 | 类型 | 源 | 目标 | boundMs | onViolation | schedule |
|---|---|---|---|---|---|---|---|
| TM1 | 通知推送时限 | deadline | S2 | S3 | 60000 | | |

# 外部事件

```yaml
- id: EE1
  name: 消息推送连接建立
  source: client
  triggerAction: connect
  idempotencyKey: connection_id
  ordering: by_event_time
  onDelay: drop
  onDuplicate: ignore
- id: EE2
  name: 消息推送连接断开
  source: system
  triggerAction: disconnect
  idempotencyKey: connection_id
  ordering: by_detection_time
  onDelay: continue
  onDuplicate: ignore
```

# 附属实体

```yaml
- id: push_connection
  name: 消息推送连接
  belongsTo: S2（P4）
  instanceKey: connection.id
  lifecycleDependency: 随推送节点生命周期级联
  cascadeRules:
    - 节点注册后可建立消息推送连接
    - 节点删除时连接关闭
  stateSpace:
    dimensions:
      - name: connection_status
        type: enum[established, disconnected]
        initial: disconnected
  invariants:
    - 同一节点同一时刻最多只有一个消息推送连接
```

# 消极保证

```yaml
- id: NA1
  name: 离线期间不补发通知
  expression: missed_notifications_during_offline_not_replayed
  scope: S3
  declaredBy: user
  checkMethod: 通知送达日志检查
```
