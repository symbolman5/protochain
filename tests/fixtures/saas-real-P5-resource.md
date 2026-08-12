---
name: 服务器资源协议
version: 1.0.0
purpose: 定义转发服务器资源生命周期（3 态）与域名/端口资源池管理，作为 SaaS 内网映射系统的子协议 P5
roles:
  - id: operator
    name: 运营方
    responsibilities: 管理服务器、域名、端口等基础设施资源，配置分配规则
    roleType: consensus
  - id: system
    name: 系统
    responsibilities: 执行资源分配与释放、状态管理
    roleType: participant
---

# 背景

服务器资源协议管理转发服务器的生命周期以及域名和端口资源池。运营方添加和管理转发服务器，每台服务器有离线/在线/维护中三种状态。域名和端口作为资源池，分配给用户创建的访问入口使用。

# 核心概念

- **转发服务器**：维持长连接、转发公网流量的基础设施节点
- **域名资源**：公网域名，分配给入口作为公网入口地址的一部分
- **端口资源**：归属于某台转发服务器的端口，分配给入口使用
- **资源分配规则**：运营方配置的服务器选择、域名分配、端口分配策略

# 协作流程

运营方添加转发服务器（离线），配置基本信息后上线（在线），开始参与资源分配。需要维护时进入维护中态，不再分配新资源但已有入口继续运行。下线前必须迁移入口。

# 状态空间

| ID | 名称 | 类型 | 描述 | 角色 |
|---|---|---|---|---|
| S1 | 离线 | initial | 服务器已注册但尚未上线，不参与资源分配 | operator |
| S2 | 在线 | normal | 服务器运行中，可参与资源分配 | operator |
| S3 | 维护中 | normal | 服务器维护中，不分配新资源但已有入口继续运行 | operator |

# 转移规则

| ID | 名称 | from | to | action | trigger | guard | effects | triggerType | actionType | affectsDimensions |
|---|---|---|---|---|---|---|---|---|---|---|
| T1 | 添加服务器 | - | S1 | add_server | operator | | | role | state_transition | |
| T2 | 服务器上线 | S1 | S2 | online | operator | | | role | state_transition | |
| T3 | 进入维护 | S2 | S3 | maintenance | operator | | | role | state_transition | |
| T4 | 维护恢复 | S3 | S2 | recover | operator | | | role | state_transition | |
| T5 | 服务器下线 | S2,S3 | S1 | offline | operator | all_entries_migrated | | role | state_transition | |

# 不变量

| ID | 名称 | 表达式 | 作用状态 | declaredBy | invariantClass |
|---|---|---|---|---|---|
| INV1 | 只有在线服务器可分配端口 | only_online_server_allocates_port | S2 | operator | intra_protocol |
| INV2 | 端口归属于服务器 | port_belongs_to_server | S1,S2,S3 | operator | intra_protocol |
| INV3 | 下线前必须迁移 | offline_requires_all_entries_migrated | S2,S3 | operator | intra_protocol |

# 时序约束

| ID | 名称 | 类型 | 源 | 目标 | boundMs | onViolation | schedule |
|---|---|---|---|---|---|---|---|
| TM1 | 下线迁移时限 | deadline | S2,S3 | S1 | 60000 | | |

# 资源池

```yaml
- id: RP1
  name: 域名池
  type: 域名集合
  capacity: dynamic
  allocationRule: 创建入口时从域名池中随机分配一个未分配域名
  releaseRule: 入口删除或进入已归档态时释放域名回池
  constraints:
    - 同一域名不可分配给两个入口同时使用
  checkMethod: 查询域名分配表
- id: RP2
  name: 端口池
  type: (server_id, port) 二元组集合
  capacity: per_server_capacity
  allocationRule: 根据分配策略从在线服务器的可用端口池随机分配端口
  releaseRule: 入口删除或进入已归档态时释放端口回所属服务器的端口池
  constraints:
    - 同一端口在同一服务器上不可重复分配
    - 只有在线状态的服务器端口才可分配
  checkMethod: 查询端口分配表
  crossInvariantIds:
    - CI3
```

# 外部事件

```yaml
- id: EE1
  name: 服务器心跳超时
  source: system
  triggerAction: offline
  idempotencyKey: server_id
  ordering: by_detection_time
  onDelay: continue
  onDuplicate: ignore
```

# 附属实体

```yaml
- id: domain
  name: 域名
  belongsTo: S2（P5）
  instanceKey: domain.name
  lifecycleDependency: 由运营方管理
  cascadeRules:
    - 域名分配后绑定到入口
    - 入口释放后域名回到未分配态
  stateSpace:
    dimensions:
      - name: assigned
        type: enum[assigned, free]
        initial: free
  invariants:
    - 域名分配状态与入口资源绑定一致
- id: server_port
  name: 服务器端口
  belongsTo: S2（P5）
  instanceKey: (server_id, port)
  lifecycleDependency: 随服务器生命周期级联
  cascadeRules:
    - 端口创建时归属于服务器
    - 端口分配后绑定到入口
    - 服务器下线前端口必须释放
  stateSpace:
    dimensions:
      - name: assigned
        type: enum[assigned, free]
        initial: free
  invariants:
    - 端口分配状态与入口资源绑定一致
```

# 消极保证

```yaml
- id: NA1
  name: 资源不重复分配
  expression: no_resource_double_allocation
  scope: S2
  declaredBy: operator
  checkMethod: 域名/端口分配表数据一致性检查
```
