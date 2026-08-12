---
name: 用户与配额协议
version: 1.0.0
purpose: 定义用户状态（活跃/锁定）与配额管理（配额包、流量配额），作为 SaaS 内网映射系统的子协议 P1
roles:
  - id: user
    name: 用户
    responsibilities: 管理自身入口与配额使用
    roleType: consensus
  - id: billing_system
    name: 经营系统
    responsibilities: 推送用户注册、配额变更、锁定/解锁事件
    roleType: participant
  - id: system
    name: 系统
    responsibilities: 执行用户锁定、配额检查、流量配额重置
    roleType: participant
---

# 背景

用户与配额协议定义用户在 SaaS 内网映射系统中的生命周期（活跃/锁定）以及配额管理。用户拥有配额包（入口数上限、带宽上限、并发数上限）和流量配额（仅免费类型）。配额状态决定用户能否创建和管理访问入口。

# 核心概念

- **用户**：在经营系统注册后使用本系统的人，拥有配额包和流量配额
- **配额包**：用户拥有的资源池，包含入口数上限、带宽上限、并发数上限
- **流量配额**：附属实体，免费配额包用户的每月流量限制（总量、已用量、每月1号重置）
- **用户锁定**：因违规或欠费等运营原因由经营系统触发的用户禁用状态

# 协作流程

用户通过经营系统注册后，经营系统推送 user_created 事件。用户在经营系统购买配额后，经营系统推送 quota_added 事件，本系统同步配额状态。用户锁定/解锁由经营系统推送 user_locked/user_unlocked 事件触发。流量配额由本系统每月1号自动重置。

# 状态空间

| ID | 名称 | 类型 | 描述 | 角色 |
|---|---|---|---|---|
| S1 | 活跃 | initial | 用户正常状态，可管理入口和推送节点 | user |
| S2 | 锁定 | normal | 用户被锁定，不可创建入口、不可管理节点、入口不可启用 | system |

# 转移规则

| ID | 名称 | from | to | action | trigger | guard | effects | triggerType | actionType | affectsDimensions |
|---|---|---|---|---|---|---|---|---|---|---|
| T1 | 锁定用户 | S1 | S2 | lock | billing_system | | | external | state_transition | |
| T2 | 解锁用户 | S2 | S1 | unlock | billing_system | | | external | state_transition | |

# 不变量

| ID | 名称 | 表达式 | 作用状态 | declaredBy | invariantClass |
|---|---|---|---|---|---|
| INV1 | 配额不超限 | non_terminal_entry_count <= quota_cap | S1 | user | intra_protocol |
| INV2 | 锁定用户不可创建入口 | locked_user_cannot_create_entry | S2 | user | intra_protocol |
| INV3 | 锁定用户入口不可启用 | locked_user_entry_not_enabled | S2 | user | cross_protocol |

# 时序约束

| ID | 名称 | 类型 | 源 | 目标 | boundMs | onViolation | schedule |
|---|---|---|---|---|---|---|---|
| TM1 | 流量配额重置 | scheduled | S1 | S1 | | | 0 0 1 * * |

# 资源池

```yaml
- id: RP1
  name: 配额包资源池
  type: 配额包集合
  capacity: dynamic
  allocationRule: 经营系统推送 quota_added 事件时分配
  releaseRule: 经营系统推送 quota_reduced 事件时释放
  constraints:
    - 同一用户可拥有多个配额包
    - 配额包有到期时间
    - 有活跃入口的配额包不可被减少
  checkMethod: 查询用户配额分配表
  crossInvariantIds:
    - CI1
```

# 外部事件

```yaml
- id: EE1
  name: 新增用户
  source: billing_system
  triggerAction: lock
  idempotencyKey: user_id
  ordering: by_event_time
  onDelay: continue
  onDuplicate: ignore
- id: EE2
  name: 新增配额包
  source: billing_system
  triggerAction: unlock
  idempotencyKey: quota_package_id
  ordering: by_event_time
  onDelay: continue
  onDuplicate: ignore
- id: EE3
  name: 减少配额包
  source: billing_system
  triggerAction: unlock
  idempotencyKey: quota_package_id
  ordering: by_event_time
  onDelay: continue
  onDuplicate: ignore
- id: EE4
  name: 锁定用户
  source: billing_system
  triggerAction: lock
  idempotencyKey: user_id
  ordering: by_event_time
  onDelay: continue
  onDuplicate: ignore
- id: EE5
  name: 解锁用户
  source: billing_system
  triggerAction: unlock
  idempotencyKey: user_id
  ordering: by_event_time
  onDelay: continue
  onDuplicate: ignore
```

# 附属实体

```yaml
- id: traffic_quota
  name: 流量配额
  belongsTo: S1（P1）
  instanceKey: user.id
  lifecycleDependency: 随用户生命周期级联
  cascadeRules:
    - 用户创建时默认分配免费流量配额
    - 用户删除时回收流量配额
  stateSpace:
    dimensions:
      - name: 已用量
        type: integer
        initial: 0
      - name: 总量
        type: integer
        initial: quota_package.total_traffic
  invariants:
    - 流量已用量 <= 流量总量
    - 每月1号 00:00 已用量重置为 0
```

# 消极保证

```yaml
- id: NA1
  name: 经营系统不可用时继续运行
  expression: billing_system_unavailable不影响现有入口转发
  scope: S1
  declaredBy: user
  checkMethod: 经营系统断连测试
```
