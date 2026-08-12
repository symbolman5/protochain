---
name: 入口协议
version: 1.0.0
purpose: 定义入口（entry）的创建、启停与端口绑定，作为 SaaS 系统的子协议 P2
roles:
  - id: tenant_admin
    name: 租户管理员
    responsibilities: 创建入口、绑定端口
    roleType: consensus
  - id: platform
    name: 平台
    responsibilities: 调度入口生命周期
    roleType: consensus
  - id: entry_runtime
    name: 入口运行时
    responsibilities: 执行入口逻辑
    roleType: participant
---

# 背景

入口协议定义 SaaS 系统中入口（entry）的生命周期。入口是租户接入流量的实体，绑定 (server_id, port) 二元组作为资源。本协议含多维度状态、外部事件触发、资源池约束与附属实体（端口）。

# 核心概念

- **入口**: 租户创建的流量接入实体
- **端口**: 入口绑定的网络端口，附属实体，随入口生命周期级联
- **资源池**: (server_id, port) 二元组不可被两个入口同时占用

# 协作流程

租户管理员创建入口，平台分配端口并启动入口。入口运行中接收外部流量。停止入口后释放端口资源。

# 状态空间

| ID | 名称 | 类型 | 描述 | 角色 |
|---|---|---|---|---|
| S1 | 草稿 | initial | 入口创建中 | tenant_admin |
| S2 | 运行中 | normal | 入口运行 | entry_runtime |
| S3 | 已停止 | terminal | 入口停止 | tenant_admin |

# 转移规则

| ID | 名称 | from | to | action | 触发 | 触发类型 | 动作类型 | 影响维度 | guard |
|---|---|---|---|---|---|---|---|---|---|
| T1 | 创建 | S1 | S2 | create | tenant_admin | role | state_transition | | port_allocated |
| T2 | 接收流量 | S2 | S2 | receive_traffic | upstream | external | attribute_update | traffic_count | |
| T3 | 停止 | S2 | S3 | stop | tenant_admin | role | state_transition | | |

# 不变量

| ID | 名称 | 表达式 | 作用状态 | 声明方 | 不变量类别 |
|---|---|---|---|---|---|
| INV1 | 端口独占 | port_unique(entry) | S2 | platform | intra_protocol |

# 时序约束

| ID | 名称 | 类型 | 源 | 目标 | 定时 | 违约转移 |
|---|---|---|---|---|---|---|
| TM1 | 健康检查 | scheduled | heartbeat | check | every 30s | S3 |

# 资源池

```yaml
- id: RP1
  name: 端口资源池
  type: (server_id, port) 二元组
  capacity: dynamic
  allocationRule: 创建入口时分配空闲端口
  releaseRule: 停止入口时释放端口
  constraints:
    - 同一 (server_id, port) 二元组不可被两个入口同时占用
  checkMethod: 查询端口分配表
  crossInvariantIds:
    - CI1
```

# 外部事件

```yaml
- id: EE1
  name: 上游流量事件
  source: upstream
  triggerAction: receive_traffic
  idempotencyKey: request_id
  ordering: by_event_time
  onDelay: drop
  onDuplicate: ignore
```

# 附属实体

```yaml
- id: port
  name: 端口
  belongsTo: entry（P2）
  instanceKey: port.id
  lifecycleDependency: 随入口生命周期级联
  cascadeRules:
    - 入口停止时端口释放
    - 入口删除时端口回收
  stateSpace:
    dimensions:
      - name: bound
        type: enum[bound, free]
        initial: free
  invariants:
    - 端口绑定状态与入口运行状态一致
```

# 消极保证

```yaml
- id: NA1
  name: 无未授权访问
  expression: not exists(access without valid_token)
  scope: S2
  declaredBy: platform
  checkMethod: 审计日志检查
```
