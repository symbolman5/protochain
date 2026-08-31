---
name: 资源发布与兑现
version: 1.0.0
purpose: 匿名 SaaS 多协议拆分（R3b）· P2 资源发布与兑现：资源、认领码、短时映射实例、文件对象。本子协议自包含六张清单（操作=改实体维度、无状态机段、实体维度带 kind 断言）；跨协议约束（配额 INV-3/4 跨 P1、封禁连带 INV-6 跨 P1、服务器依赖 INV-9/数据面副本 INV-11 跨 P3）走组合层 protocol/composition.md
roles:
  - id: publisher_tool
    name: 专用工具（发布端）
    responsibilities: 匿名把内网资源（http 服务 / 文件 / 站点）发布到公网，并在运行期间维持短时映射活跃。跑在用户机器上：会退出、会断网、版本不可控；它不是系统状态的一部分，在线状态落在「短时映射实例.连接状态」
    roleType: participant
  - id: anonymous_visitor
    name: 匿名访问者
    responsibilities: 用公网地址访问资源；携带认领码时进入认领流程。无账号，既包含「认领后公开访问」的人，也包含「带码来访触发认领」的人
    roleType: participant
    anonymous: true
  - id: account_holder
    name: 账号持有者（认领者）
    responsibilities: 认领匿名资源成为归属人（账号登录在 P1 账号域，本域承接认领资源/移除资源）；认领时校验账号状态与配额档位（跨协议引用 P1）
    roleType: participant
  - id: operator
    name: 运营人员
    responsibilities: 审查用户发布的资源，发现违规可封禁资源；封禁用户（账号侧）在 P1 账号域，本域承接封禁资源的资源侧
    roleType: participant
  - id: system
    name: 系统自身（调度与观测）
    responsibilities: 心跳超时判定、认领码过期、已移除资源回收（调度/观测写入 observed 维度）
    roleType: consensus
credentials:
  - name: 认领码
    issuer: system
    holder: publisher_tool
    redeemer: account_holder
    selfContained: needs-lookup
    ttl: "待定（建议与未认领资源保留期一致，见待确认 #2）"
    revoke: 资源被移除或封禁即失效；一旦兑付不可再用
    premise: 码空间足够大不可枚举（防暴力猜解）；仅经 HTTPS 传递；不得落日志与 Referer
---

# 背景

本子协议描述匿名 SaaS 的资源发布与兑现协作规则：专用工具匿名发布资源（资源 ＋ 认领码，同一事务 TX1）后资源维度进入 归属=无归属、处置=正常、访问策略=拒绝、审核=待审，同时派生认领码；匿名访问者无码访问被拒绝（访问策略=拒绝），带码访问进入认领流程。账号持有者认领（资源 ＋ 认领码，同一事务 TX2）后 归属=已认领、访问策略=放行、兑付状态=已使用。运营审查与封禁资源（INV-7）。归属人移除资源（INV-10）。系统自身执行心跳超时判定、认领码过期与已移除资源回收。跨协议：认领时校验账号状态/配额档位（P1）、资源由转发服务器实例兑现（P3，INV-9）、访问策略副本推送数据面（P3，INV-11）。

模型数据源为 model-lab/model.js 六张清单，本文件为其 P2 资源域切片（R3b 拆分，自包含可独立 derive/check）。

# 核心概念

- **资源**：匿名发布 + 认领的公网资源单元，五个维度（形态 / 归属状态 / 处置状态 / 访问策略 / 审核状态），操作直接改维度、无单一状态轴
- **认领码**：发布时派生的凭证，一码唯一绑一资源，是「无归属 → 有归属」的唯一路径；兑付状态（declared，角色写）与有效期状态（observed，系统写）为两个独立维度
- **短时映射实例**：短时内网映射形态资源的运行实例，连接状态只能观测（心跳），任何角色都写不了
- **文件对象**：长期文件托管形态资源的运行实例，存在性只能观测（上传）
- **控制面 / 数据面**：访问策略的权威面（本域）与兑现面（P3 转发服务器实例）；数据面副本由组合层 INV-11 约束（T_sync 内收敛）

# 协作流程

专用工具匿名发布资源（资源＋认领码，同一事务 TX1）。匿名访问者无码访问被拒绝（访问策略=拒绝），带码访问进入认领流程（未登录则先引导登录，登录在 P1）。账号持有者认领（资源＋认领码，同一事务 TX2；guard 校验账号状态与配额档位——跨协议引用 P1，见操作段改写说明）后 归属=已认领、访问策略=放行、兑付状态=已使用，可被公网访问（数据面兑现见 P3）。运营审查资源判定通过或违规，违规资源可被封禁（处置=已封禁、访问策略=拒绝、认领码不可兑付，INV-7）。归属人可移除资源（处置=已移除、访问策略=拒绝，INV-10），底层文件对象 / 映射实例随后由系统回收（TX4）。系统自身周期性执行心跳超时判定（连接状态=离线，INV-5）、认领码过期（有效期状态=已失效）与已移除资源回收。

# 操作

```yaml
- role: publisher_tool
  op: 匿名发布资源
  target: 资源 ＋ 认领码
  guard: "发布形态合法（短时内网映射 | 长期文件托管 二选一）· 无账号、无配额校验（见待确认 #1）"
  change: "资源.归属状态=无归属 ∧ 资源.处置状态=正常 ∧ 资源.访问策略=拒绝 ∧ 资源.审核状态=待审 ∧ 认领码.兑付状态=未使用；派生 1 个认领码"
  trigger: role
- role: publisher_tool
  op: 上报心跳
  target: 短时映射实例
  guard: 资源.形态=短时内网映射 ∧ 资源.处置状态=正常
  change: 短时映射实例.连接状态=在线
  trigger: observed
- role: publisher_tool
  op: 结束运行 / 断开
  target: 短时映射实例
  guard: 连接状态=在线
  change: "短时映射实例.连接状态=离线；并发占用随后释放（见 INV-5）"
  trigger: observed
- role: publisher_tool
  op: 上传文件内容
  target: 文件对象
  guard: 资源.形态=长期文件托管 ∧ 资源.处置状态=正常
  change: 文件对象.存在性=存在
  trigger: observed
- role: anonymous_visitor
  op: 请求访问资源（无认领码）
  target: 资源
  guard: 访问策略=放行 ∧ 处置状态=正常
  change: 无。判断接口：不改状态，但系统依据状态决定代理还是拒绝（数据面兑现见 P3）
  trigger: role
- role: anonymous_visitor
  op: 携带认领码访问
  target: 资源
  guard: 归属状态=无归属 ∧ 处置状态=正常 ∧ 认领码.兑付状态=未使用
  change: 无。判断接口：依据状态决定进认领页还是拒绝（未登录则先引导登录）
  trigger: role
- role: account_holder
  op: 认领资源
  target: 资源 ＋ 认领码
  guard: "归属状态=无归属 ∧ 处置状态=正常 ∧ 认领码.兑付状态=未使用 ∧ 账号状态（P1 账号域）=正常 ∧ (形态=短时内网映射 ⇒ 映射并发状态（P1 账号配额）≠已用尽) ∧ (形态=长期文件托管 ⇒ 文件空间状态（P1 账号配额）≠已用尽)"
  change: "资源.归属状态=已认领 ∧ 资源.访问策略=放行 ∧ 认领码.兑付状态=已使用。跨实体同一事务 TX2——这是 INV-2 能标 always 的唯一依据；若拆成两步，INV-2 必须降级为 eventually_within"
  trigger: role
- role: account_holder
  op: 移除资源
  target: 资源
  guard: 处置状态≠已移除
  change: "资源.处置状态=已移除 ∧ 资源.访问策略=拒绝（底层实例随后回收，见 INV-10）"
  trigger: role
- role: operator
  op: 审查资源
  target: 资源
  guard: 审核状态=待审
  change: 审核状态=通过 | 违规
  trigger: role
- role: operator
  op: 封禁资源
  target: 资源
  guard: 审核状态=违规
  change: "资源.处置状态=已封禁 ∧ 资源.访问策略=拒绝 ∧ 认领码不可兑付"
  trigger: role
- role: system
  op: 心跳超时判定
  target: 短时映射实例
  guard: 连接状态=在线 ∧ 超过 T_hb 未收到心跳
  change: 短时映射实例.连接状态=离线
  trigger: scheduled
- role: system
  op: 认领码过期
  target: 认领码
  guard: 认领码.兑付状态=未使用 ∧ 超过有效期
  change: 认领码.有效期状态=已失效
  trigger: scheduled
- role: system
  op: 回收已移除资源
  target: 资源 ＋（文件对象 ｜ 短时映射实例）
  guard: 处置状态=已移除 ∧ 超过保留期
  change: "文件对象.存在性=缺失 ∧ 短时映射实例.连接状态=离线；删除文件对象 / 清除映射实例 / 归档记录"
  trigger: scheduled
```

# 实体维度

```yaml
- entity: 资源
  etype: 记录
  dim: 形态
  kind: declared
  domain: "{短时内网映射, 长期文件托管}"
- entity: 资源
  etype: 记录
  dim: 归属状态
  kind: declared
  domain: "{无归属, 已认领}"
- entity: 资源
  etype: 记录
  dim: 处置状态
  kind: declared
  domain: "{正常, 已封禁, 已移除}"
- entity: 资源
  etype: 记录
  dim: 访问策略
  kind: declared
  domain: "{拒绝, 放行}。数据面需本地可判定，故从归属状态派生后冗余存储，由 INV-1 保证一致"
- entity: 资源
  etype: 记录
  dim: 审核状态
  kind: declared
  domain: "{待审, 通过, 违规}。仅一个维度，无独立审核记录——留痕问题见待确认 #8"
- entity: 短时映射实例
  etype: 运行实例
  dim: 连接状态
  kind: observed
  domain: "{在线, 离线}。只能观测工具心跳，任何角色都写不了"
- entity: 文件对象
  etype: 运行实例
  dim: 存在性
  kind: observed
  domain: "{存在, 缺失}"
- entity: 认领码
  etype: 凭证
  dim: 兑付状态
  kind: declared
  domain: "{未使用, 已使用}。R3a 语义修正：model.js 原 {未使用,已使用,已失效} 的「已失效」拆至「有效期状态」——兑付状态只由角色写（认领），R-KIND-2/M10 单维度写入方集合不得混合"
- entity: 认领码
  etype: 凭证
  dim: 有效期状态
  kind: observed
  domain: "{有效, 已失效}。R3a 语义修正：由 model.js 兑付状态「已失效」档拆出；写方=系统自身（认领码过期，scheduled）"
```

# 不变量

| ID | 名称 | 表达式 | 声明方 | 不变量类别 | 描述 | 级别 | 处置动作 | 检测方式 |
|---|---|---|---|---|---|---|---|---|
| INV-1 | 放行须已认领且正常 | 访问策略=放行 ⇒ 归属状态=已认领 ∧ 处置状态=正常 | system | intra_protocol | 强一致（同一记录内）。数据面需本地可判定，故访问策略从归属状态派生后冗余存储，由本不变量保证一致 | state-machine | 拒绝访问，控制面告警并修正；修正期内数据面以本地副本为准 | 访问策略与归属状态一致性扫描 |
| INV-2 | 认领唯一性 | 归属状态=已认领 ⇒ 认领码.兑付状态=已使用 ∧ 归属账号唯一 | system | intra_protocol | 强一致（认领需跨资源与认领码的同一事务，事务边界 TX2） | state-machine | 拒绝重复认领；检测到双花即冻结资源并告警 | 认领事务的兑付状态与归属账号唯一性校验 |
| INV-5 | 离线不计并发 | 连接状态=离线 ⇒ 不计入并发占用 | system | intra_protocol | 最终一致；收敛上界见 TM3（T_hb + T_stat） | state-machine | 修正计数并释放配额余量；展示与配额判断以修正后为准 | 离线实例计数修正扫描 |
| INV-7 | 封禁即不可访问 | 处置状态=已封禁 ⇒ 访问策略=拒绝 ∧ 认领码不可兑付 | system | intra_protocol | 强一致（资源与认领码在同一事务内更新） | state-machine | 拒绝访问与认领；运营解除前保持 | 封禁资源访问与认领路径校验 |
| INV-10 | 移除即拒绝 | 处置状态=已移除 ⇒ 访问策略=拒绝 | system | intra_protocol | 强一致（同一记录内） | state-machine | 拒绝访问并触发底层回收（回收时机与可恢复性见待确认 #18） | 已移除资源访问策略校验 |

# 时序约束

| ID | 名称 | 类型 | 源 | 目标 | 约束值(ms) | 违约转移 | schedule | 描述 |
|---|---|---|---|---|---|---|---|---|
| TM3 | 离线释放收敛 | deadline | 心跳超时判定 | INV-5 | 60000 | | | 离线后并发占用释放收敛上界 T_hb + T_stat（占位值，待使用方确认） |

# 关系

```yaml
- from: 资源
  to: 短时映射实例
  type: 派生
  constraint: "仅当 形态=短时内网映射；0..1 个。实例不可被声明、生命周期不同步、身份需追溯 ⇒ 与记录分开"
  onGone: "实例离线 ⇒ 资源不可达、并发占用释放（INV-5）；记录保留，工具重连是否复用同一实例身份待确认"
- from: 资源
  to: 文件对象
  type: 派生
  constraint: "仅当 形态=长期文件托管；1 个"
  onGone: "文件缺失 ⇒ 资源不可达并告警；记录保留至回收。上传途中（记录已建、字节未完整）落于「缺失」档（待确认）"
- from: 资源
  to: 认领码
  type: 派生
  constraint: "发布时生成 1 个，一码唯一绑一资源"
  onGone: "码失效或已使用 ⇒ 无归属资源永久不可认领；是否补发待确认"
```

# 事务边界

```yaml
- id: TX1
  interface: 匿名发布资源
  boundaryType: same_transaction
  description: 发布创建资源记录并派生认领码（兑付状态=未使用），跨资源与认领码同一事务
- id: TX2
  interface: 认领资源
  boundaryType: same_transaction
  description: 认领同时改资源（归属状态/访问策略）与认领码（兑付状态），跨实体同一事务——INV-2 标 always 的依据
- id: TX4
  interface: 回收已移除资源
  boundaryType: async_compensation
  description: 回收已移除资源删除文件对象/清除映射实例，异步清理任务
```

# 组件映射

```yaml
interfaceImplementations:
  - { interface: 匿名发布资源, component: control-plane, description: 匿名发布登记资源记录并派生认领码（管理类写路径） }
  - { interface: 认领资源, component: control-plane, description: 认领资源（跨资源与认领码同一事务；guard 跨协议校验 P1 账号/配额） }
  - { interface: 移除资源, component: control-plane, description: 归属人移除资源 }
  - { interface: 审查资源, component: control-plane, description: 运营审查资源 }
  - { interface: 封禁资源, component: control-plane, description: 运营封禁资源 }
  - { interface: 心跳超时判定, component: control-plane, description: 心跳超时判定（调度） }
  - { interface: 认领码过期, component: control-plane, description: 认领码过期判定（调度） }
  - { interface: 回收已移除资源, component: control-plane, description: 已移除资源回收（调度） }
  - { interface: 请求访问资源（无认领码）, component: data-plane, description: 兑现公网访问（代理/拒绝判定，服务兑现依赖 P3） }
  - { interface: 携带认领码访问, component: data-plane, description: 携带认领码访问的跳转判定 }
  - { interface: 上传文件内容, component: data-plane, description: 文件上传兑现 }
  - { interface: 上报心跳, component: data-plane, description: 心跳接收（观测事实采集） }
  - { interface: 结束运行 / 断开, component: data-plane, description: 断开事件接收（观测事实采集） }
dimensionStorage:
  - { dimension: 形态, table: resources, description: 资源记录（短时内网映射/长期文件托管） }
  - { dimension: 归属状态, table: resources }
  - { dimension: 处置状态, table: resources }
  - { dimension: 访问策略, table: resources, description: 从归属状态派生的冗余副本（INV-1） }
  - { dimension: 审核状态, table: resources }
  - { dimension: 连接状态, table: mapping_instances }
  - { dimension: 存在性, table: files }
  - { dimension: 兑付状态, table: claim_codes }
  - { dimension: 有效期状态, table: claim_codes }
componentTransfers:
  - { from: control-plane, to: data-plane, channel: event, mode: async, description: 推送访问策略副本（组合层 INV-11，跨 P2/P3；T_sync 内收敛，超期未同步数据面 fail-closed） }
  - { from: data-plane, to: control-plane, channel: event, mode: async, description: 上报心跳/断开等观测事件（INV-5 离线释放数据来源） }
```

<!--
R3b 拆分备注（P2 资源发布与兑现）：
1. 来源：examples/anonymous-saas/protocol/model.md（R3a 单协议六张清单版）按「实体关系簇 + 角色边界」拆分。
2. 操作分布（13）：匿名发布资源/上报心跳/结束运行断开/上传文件内容/请求访问资源（无认领码）/携带认领码访问/
   认领资源/移除资源/审查资源/封禁资源/心跳超时判定/认领码过期/回收已移除资源。
   登录/封禁用户/重算账号配额 归 P1 账号域；登记下线服务器与域名/证书操作、探测转发服务器健康、重算证书有效期档 归 P3 基础设施。
3. 语义修正一（跨协议 guard 改写）：认领资源 guard 原引用「账号.账号状态=正常」「账号配额.映射并发状态≠已用尽」
   「账号配额.文件空间状态≠已用尽」——账号/账号配额在 P1，本域「实体维度」段不含这些维度，直接保留 X.y=z 形态
   会触发判据 5 悬空硬失败（R-KIND 单协议字段命名空间）。改写为「维度名（P1 账号域）=值 / ≠值」形态保留跨域语义
   （机械提取器只认「实体.维度」与「维度=值」两种形态，括号标注不提取），跨协议约束由组合层 INV-3/4/6 承接。
4. 本域承接跨协议不变量在 P2 侧的条目：INV-3/4（跨 P1）、INV-6（跨 P1）、INV-9/11（跨 P3）落组合层；
   intra 不变量 INV-1/2/5/7/10 留在本域；INV-3/4/6/9/11 的时序约束（TM1/2/4/6/7）归组合层跨协议时序。
5. 关系分布：派生类（资源→短时映射实例/文件对象/认领码）留本域；绑定/运行依赖（资源→账号、短时映射实例→
   转发服务器实例、文件对象→转发服务器实例、资源→账号配额）端点跨域，由组合层依赖图 + 跨协议不变量承接。
6. 事务边界：TX1/TX2（same_transaction）、TX4（async_compensation）留本域；TX3（封禁用户）随操作归 P1 后取消。
-->
