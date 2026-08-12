# 系统元数据

```yaml
systemName: SaaS 系统
version: 0.1.0
changeType: protocol_tweak
```

# 子协议清单

```yaml
- protocolId: P1
  name: 租户协议
  version: 0.1.0
  modelPath: protocol/P1/model.md
- protocolId: P2
  name: 入口协议
  version: 0.1.0
  modelPath: protocol/P2/model.md
```

# 依赖图

```mermaid
graph LR
  P1[租户协议]
  P2[入口协议]
  P1 --> P2
```

```yaml
- from: P1
  to: P2
  dependencyType: state
  description: 租户存在是入口创建的前提
- from: P2
  to: P1
  dependencyType: event
  description: 入口状态变更通知租户
```

# 跨协议不变量

### CI1: 端口跨入口独占

```yaml
id: CI1
name: 端口跨入口独占
span: [P2]
expression: not exists(two entries sharing same (server_id, port))
declaredBy: platform
checkMethod: 查询端口分配表
complexity: first_order
```

### CI2: 入口归属租户

```yaml
id: CI2
name: 入口归属租户
span: [P1, P2]
expression: every entry belongs to a valid tenant
declaredBy: platform
checkMethod: 租户-入口关联表校验
complexity: first_order
```

# 跨协议时序

### CT1: 入口创建时效

```yaml
id: CT1
name: 入口创建时效
rule: 租户创建后 60s 内入口可达
span: [P1, P2]
boundMs: 60000
```

# 外部依赖

### upstream: 上游流量源

```yaml
system: upstream
direction: event_sync
protocol: P2
syncSemantics: 事件同步，上游推送流量事件
syncCharacteristics:
  - at_most_once
  - event_time_ordering
compensation:
  - 丢弃重复事件
  - 延迟超阈值丢弃
impactOnFailure: 入口无法接收流量
```

# 观测接口

### OI1: 入口状态观测

```yaml
id: OI1
name: 入口状态观测
observer: tenant_admin
scope: P2.entry
permissionBoundary: 仅本租户可见
readOnly: true
observable:
  - protocol: P2
    object: S2
    fields: [traffic_count]
    filter: by tenant
```

# 对象状态切面

### entry: 入口对象切面

```yaml
object: entry
idKey: entry.id
facets:
  - protocol: P2
    dimensions: [traffic_count, port_bound]
    description: 入口运行时状态维度
crossFacetConstraints:
  - expression: entry.port_bound implies port exists
    tracesToInvariantId: CI1
```

# 安全前提

### SA1: 租户隔离

```yaml
id: SA1
assumption: 租户间数据隔离
description: 不同租户的入口与流量数据相互隔离
impactIfViolated: 租户数据泄露
```
