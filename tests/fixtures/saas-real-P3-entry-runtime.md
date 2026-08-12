---
name: 访问入口运行状态协议
version: 1.0.0
purpose: 定义访问入口的运行状态生命周期（4 态），反映转发服务器上入口实例的实时情况，作为 SaaS 内网映射系统的子协议 P3
roles:
  - id: system
    name: 系统
    responsibilities: 检测隧道连接状态、执行超时清理、管理入口实例
    roleType: consensus
  - id: client
    name: 客户端
    responsibilities: 建立和维持隧道连接
    roleType: participant
---

# 背景

运行状态反映转发服务器上入口实例的实时情况，仅当配置状态=已启用时有意义。运行状态由隧道连接情况决定，独立于配置状态维度。当配置状态≠已启用时，转发服务器上不应有入口实例。

# 核心概念

- **入口实例**：转发服务器上为某个入口创建的转发进程
- **隧道连接**：客户端与转发服务器之间的长连接，为特定入口转发公网流量
- **2 分钟重连窗口**：隧道断开后客户端有 2 分钟时间重连，超时则实例被清理

# 协作流程

客户端与转发服务器建立隧道连接后，转发服务器创建入口实例（实例正常）。隧道断开后进入实例断开，2 分钟内重连则恢复，超时则清理实例回到无实例。配置状态变化也会触发实例清理。

# 状态空间

| ID | 名称 | 类型 | 描述 | 角色 |
|---|---|---|---|---|
| S1 | 无实例 | initial | 转发服务器上没有该入口实例 | system |
| S2 | 实例正常 | normal | 隧道连接已建立，实例在运行，可转发流量 | system |
| S3 | 实例断开 | normal | 隧道断开，进入 2 分钟重连窗口 | system |
| S4 | 实例已清理 | normal | 超过 2 分钟未重连，实例已被清理（回到 S1 等价态） | system |

# 转移规则

| ID | 名称 | from | to | action | trigger | guard | effects | triggerType | actionType | affectsDimensions |
|---|---|---|---|---|---|---|---|---|---|---|
| T1 | 建立隧道连接 | S1 | S2 | tunnel_establish | client | config_enabled | create_instance | system | state_transition | |
| T2 | 隧道断开 | S2 | S3 | tunnel_disconnect | system | | | system | state_transition | |
| T3 | 重连恢复 | S3 | S2 | tunnel_reconnect | client | | | system | state_transition | |
| T4 | 超时清理 | S3 | S4 | timeout_cleanup | system | reconnect_timeout_2min | cleanup_instance | system | state_transition | |
| T5 | 配置停用清理 | S2,S3 | S1 | config_disabled_cleanup | system | config_not_enabled | cleanup_instance | system | state_transition | |

# 不变量

| ID | 名称 | 表达式 | 作用状态 | declaredBy | invariantClass |
|---|---|---|---|---|---|
| INV1 | 只有已启用+实例正常才转发流量 | forward_traffic_only_when_S2 | S2 | system | cross_protocol |
| INV2 | 配置状态≠已启用时不应有实例 | no_instance_when_not_enabled | S1,S3,S4 | system | cross_protocol |

# 时序约束

| ID | 名称 | 类型 | 源 | 目标 | boundMs | onViolation | schedule |
|---|---|---|---|---|---|---|---|
| TM1 | 重连超时 | timeout | S3 | S4 | 120000 | S4 | |

# 资源池

```yaml
- id: RP1
  name: 入口实例资源
  type: 转发服务器上的入口实例
  capacity: per_server_limit
  allocationRule: 隧道建立时在转发服务器上创建入口实例
  releaseRule: 隧道断开超时或配置停用时清理入口实例
  constraints:
    - 同一入口在同一时刻最多只有一个活跃实例
    - 同一入口实例只属于一台转发服务器
  checkMethod: 查询转发服务器实例列表
```

# 外部事件

```yaml
- id: EE1
  name: 隧道建立
  source: client
  triggerAction: tunnel_establish
  idempotencyKey: connection_id
  ordering: by_event_time
  onDelay: drop
  onDuplicate: ignore
- id: EE2
  name: 隧道断开
  source: system
  triggerAction: tunnel_disconnect
  idempotencyKey: connection_id
  ordering: by_detection_time
  onDelay: continue
  onDuplicate: ignore
```

# 附属实体

```yaml
- id: tunnel_connection
  name: 隧道连接
  belongsTo: S2（P3）
  instanceKey: connection.id
  lifecycleDependency: 随入口运行状态级联
  cascadeRules:
    - 隧道断开后 2 分钟内可重连
    - 超过 2 分钟未重连则实例被清理
  stateSpace:
    dimensions:
      - name: connection_status
        type: enum[established, disconnected]
        initial: disconnected
  invariants:
    - 同一入口同一时刻最多只有一个活跃隧道连接
```

# 消极保证

```yaml
- id: NA1
  name: 配置停用时自动清理
  expression: config_not_enabled_implies_no_instance
  scope: S1,S3,S4
  declaredBy: system
  checkMethod: 配置状态与实例存在性比对
```
