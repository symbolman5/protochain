---
name: 六张清单测试协议
version: 0.1.0
purpose: R1a 验收：六张清单形态（操作=改实体维度、无状态机段）解析为完整 IR
roles:
  - id: publisher
    name: 发布端
    responsibilities: 匿名发布资源、上报心跳
    roleType: consensus
  - id: visitor
    name: 匿名访问者
    responsibilities: 请求访问资源
    roleType: participant
  - id: system
    name: 系统自身
    responsibilities: 定时回收、心跳超时判定
    roleType: participant
---

# 背景

六张清单形态测试协议：验证 parser 对「操作」段与「实体维度」段的解析（R1a）。
本模型无状态空间/转移规则段——操作 = 改实体维度，系统无单一状态轴。

# 核心概念

- **资源**：被匿名发布的记录实体，带归属/处置/访问策略等维度
- **认领码**：资源派生的凭证，带兑付状态
- **操作**：改实体维度，不是状态间迁移

# 协作流程

发布端匿名发布资源（资源 ＋ 认领码），访问者请求访问资源，系统定时判定心跳超时。

# 操作

```yaml
- role: publisher
  op: 匿名发布资源
  target: 资源 ＋ 认领码
  guard: 发布形态合法
  change: 资源.归属状态=无归属 ∧ 资源.处置状态=正常 ∧ 认领码.兑付状态=未使用；派生 1 个认领码
  trigger: role
- role: visitor
  op: 请求访问资源
  target: 资源
  guard: 资源.访问策略=放行
  change: 无。判断接口：不改状态，系统依据状态决定放行还是拒绝
  trigger: role
- role: system
  op: 心跳超时判定
  target: 短时映射实例
  guard: 连接状态=在线 ∧ 超过 T_hb 未收到心跳
  change: 连接状态=离线
  trigger: scheduled
- role: system
  op: 收到退款回调
  target: 账号
  guard: 账号.账号状态=正常
  change: 账号状态=已退款
  trigger: cross
```

# 实体维度

```yaml
- entity: 资源
  etype: 记录
  dim: 归属状态
  kind: declared
  domain: "{无归属, 已认领}"
- entity: 资源
  etype: 记录
  dim: 访问策略
  kind: declared
  domain: "{拒绝, 放行}"
- entity: 认领码
  etype: 凭证
  dim: 兑付状态
  kind: declared
  domain: "{未使用, 已使用, 已失效}"
- entity: 短时映射实例
  etype: 运行实例
  dim: 连接状态
  kind: observed
  domain: "{在线, 离线}"
- entity: 账号
  etype: 记录
  dim: 账号状态
  kind: observed
  domain: "{正常, 已封禁}。R1b 语义修正：由 cross 外部事件（收到退款回调，trigger=cross→external）写入，observed 才与机械推导自洽（declared + external 写入 = R-KIND-2 断言冲突）"
```

# 不变量

| ID | 名称 | 表达式 | 作用状态 | 声明方 | 不变量类别 | 描述 |
|---|---|---|---|---|---|---|
| INV1 | 认领码状态合法 | 认领码.兑付状态 ∈ {未使用, 已使用, 已失效} | | publisher | intra_protocol | 认领码兑付状态是资源生命周期的派生事实 |
