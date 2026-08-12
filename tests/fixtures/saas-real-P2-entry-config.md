---
name: 访问入口配置状态协议
version: 1.0.0
purpose: 定义访问入口的配置状态生命周期（7 态），作为 SaaS 内网映射系统的子协议 P2
roles:
  - id: user
    name: 用户
    responsibilities: 创建、启用、停用、删除入口
    roleType: consensus
  - id: system
    name: 系统
    responsibilities: 执行配额耗尽关闭、冻结、归档、续期恢复等自动状态转移
    roleType: consensus
  - id: operator
    name: 运营方
    responsibilities: 管理服务器资源，配置分配规则
    roleType: participant
---

# 背景

访问入口是 SaaS 内网映射系统的核心管理对象。入口的配置状态反映"用户想不想让它跑"和"系统允不允许它跑"，由用户的启用/停用意图、配额状态、流量配额等决定。本协议使用配置状态维度，运行状态维度由 P3 协议独立管理。

# 核心概念

- **访问入口**：用户创建的流量接入点，绑定域名+端口组合
- **配置状态**：由用户意图和系统约束决定的状态维度（待启用/已启用/已停用/已关闭/已冻结/已归档/已删除）
- **公网资源**：域名+端口组合，创建时从资源池分配，已归档态下回收
- **配额包绑定**：入口绑定一个配额包，决定带宽/并发限制

# 协作流程

用户创建入口后进入待启用态，用户启用后进入已启用态。转发过程中可能因流量耗尽（已关闭）、配额到期（已冻结）等系统事件触发状态转移。冻结超时 7 天进入已归档态，公网资源被回收。用户可手动停用或删除入口。

# 状态空间

| ID | 名称 | 类型 | 描述 | 角色 |
|---|---|---|---|---|
| S1 | 待启用 | initial | 刚创建，用户还没启用 | user |
| S2 | 已启用 | normal | 用户主动启用，准备转发 | user |
| S3 | 已停用 | normal | 用户主动停用，保留资源和配置 | user |
| S4 | 已关闭 | normal | 免费流量配额耗尽，系统强制停用 | system |
| S5 | 已冻结 | normal | 配额包到期，系统强制停用 | system |
| S6 | 已归档 | normal | 冻结超时 7 天，公网资源回收，仅保留配置信息 | system |
| S7 | 已删除 | terminal | 终态，所有资源和配置信息清除 | user |

# 转移规则

| ID | 名称 | from | to | action | trigger | guard | effects | triggerType | actionType | affectsDimensions |
|---|---|---|---|---|---|---|---|---|---|---|
| T1 | 创建入口 | - | S1 | create | user | quota_sufficient,resource_available | allocate_domain_port | role | state_transition | |
| T2 | 用户启用 | S1 | S2 | enable | user | | | role | state_transition | |
| T3 | 用户停用 | S2 | S3 | disable | user | | cleanup_instance | role | state_transition | |
| T4 | 用户重新启用 | S3 | S2 | reenable | user | | | role | state_transition | |
| T5 | 流量耗尽关闭 | S2 | S4 | close | system | traffic_quota_exhausted | | system | state_transition | |
| T6 | 流量重置恢复 | S4 | S2 | recover | system | quota_reset | | system | state_transition | |
| T7 | 配额到期冻结 | S2 | S5 | freeze | system | quota_package_expired | | system | state_transition | |
| T8 | 冻结超时归档 | S5 | S6 | archive | system | freeze_timeout_7d | release_public_resource | system | state_transition | |
| T9 | 续期恢复（冻结） | S5 | S2 | renew | system | quota_renewed | | external | state_transition | |
| T10 | 续期恢复（归档） | S6 | S2 | renew_archived | system | quota_renewed | allocate_domain_port | external | state_transition | |
| T11 | 删除入口 | S1,S3,S4,S5,S6 | S7 | delete | user | | release_resources | role | state_transition | |
| T12 | 锁定停用 | S2 | S3 | lock_disable | system | user_locked | cleanup_instance | system | state_transition | |

# 不变量

| ID | 名称 | 表达式 | 作用状态 | declaredBy | invariantClass |
|---|---|---|---|---|---|
| INV1 | 非终态入口独占域名+端口 | non_terminal_entry_has_unique_domain_port | S1,S2,S3,S4,S5 | user | intra_protocol |
| INV2 | 只有已启用可转发 | only_enabled_forwards_traffic | S2 | user | intra_protocol |
| INV3 | 已归档无公网资源 | archived_has_no_public_resource | S6 | user | intra_protocol |
| INV4 | 已删除不可操作 | deleted_no_operation | S7 | user | intra_protocol |
| INV5 | 已关闭不可手动激活 | closed_no_manual_activate | S4 | system | intra_protocol |
| INV6 | 已冻结不可手动激活 | frozen_no_manual_activate | S5 | system | intra_protocol |

# 时序约束

| ID | 名称 | 类型 | 源 | 目标 | boundMs | onViolation | schedule |
|---|---|---|---|---|---|---|---|
| TM1 | 冻结超时归档 | timeout | S5 | S6 | 604800000 | S6 | |
| TM2 | 流量配额重置 | scheduled | S4 | S2 | | | 0 0 1 * * |

# 资源池

```yaml
- id: RP1
  name: 域名+端口资源池
  type: (domain, server_id, port) 三元组
  capacity: dynamic
  allocationRule: 创建入口时从在线服务器的可用端口池分配空闲端口，从域名池分配域名
  releaseRule: 入口删除或进入已归档态时释放域名和端口回资源池
  constraints:
    - 同一 (domain, server_id, port) 三元组不可被两个入口同时占用
    - 只有在线服务器的端口才可分配
  checkMethod: 查询域名分配表和端口分配表
  crossInvariantIds:
    - CI3
```

# 外部事件

```yaml
- id: EE1
  name: 流量配额耗尽
  source: system
  triggerAction: close
  idempotencyKey: entry_id
  ordering: by_detection_time
  onDelay: continue
  onDuplicate: ignore
- id: EE2
  name: 流量配额重置
  source: system
  triggerAction: recover
  idempotencyKey: entry_id
  ordering: by_event_time
  onDelay: continue
  onDuplicate: ignore
- id: EE3
  name: 配额包到期
  source: system
  triggerAction: freeze
  idempotencyKey: entry_id
  ordering: by_detection_time
  onDelay: continue
  onDuplicate: ignore
- id: EE4
  name: 续期配额
  source: billing_system
  triggerAction: renew
  idempotencyKey: entry_id
  ordering: by_event_time
  onDelay: continue
  onDuplicate: ignore
- id: EE5
  name: 用户锁定
  source: billing_system
  triggerAction: lock_disable
  idempotencyKey: user_id
  ordering: by_event_time
  onDelay: continue
  onDuplicate: ignore
```

# 附属实体

```yaml
- id: port
  name: 端口
  belongsTo: S2（P2）
  instanceKey: port.id
  lifecycleDependency: 随入口生命周期级联
  cascadeRules:
    - 入口创建时分配端口
    - 入口删除时释放端口回服务器端口池
    - 入口进入已归档态时释放端口
  stateSpace:
    dimensions:
      - name: bound
        type: enum[bound, free]
        initial: free
  invariants:
    - 端口绑定状态与入口非终态一致
```

# 消极保证

```yaml
- id: NA1
  name: 经营系统不可用时入口继续运行
  expression: billing_system_unavailable不影响已启用入口转发
  scope: S2
  declaredBy: user
  checkMethod: 经营系统断连测试
```
