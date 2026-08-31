---
name: 匿名发布+认领的公网资源 SaaS
version: 1.0.0
purpose: 描述匿名发布 + 认领的公网资源 SaaS 的完整协作规则：专用工具匿名发布资源（短时内网映射 / 长期文件托管），匿名访问者凭公网地址访问或带码进入认领流程，账号持有者认领资源成为归属人，运营审查封禁，运维管理服务器与证书，系统自身承担调度与观测。本文件为六张清单形态（操作=改实体维度、无状态机段、实体维度带 kind 断言），数据源为 model-lab/model.js
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
    responsibilities: 认领匿名资源成为归属人，并在 Web 控制台查看 / 移除自己的资源。认领是从「无归属」到「有归属」的唯一路径；拥有两个配额
    roleType: participant
  - id: operator
    name: 运营人员
    responsibilities: 审查用户发布的资源，发现违规可封禁资源，甚至封禁用户。人工判断，有自由裁量；封禁是写操作，进模型
    roleType: participant
  - id: ops
    name: 运维人员
    responsibilities: 管理转发服务器与所用域名证书（含多域名、SNI）。面向基础设施，不面向用户资源；与运营侧管理员是否细分见待确认 #22
    roleType: participant
  - id: system
    name: 系统自身（调度与观测）
    responsibilities: 心跳超时判定、转发服务器健康探测、配额重算、认领码过期、证书巡检、已移除资源回收。没有用户但仍是角色；所有 observed 维度由它或观测事实写入；完全可控的转发服务器行为归到它名下而不单列角色
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
  - name: 登录会话
    issuer: system
    holder: account_holder
    redeemer: account_holder
    selfContained: local-verify
    ttl: 短，具体待定
    revoke: 主动退出即失效；账号被封禁后需等令牌过期或查吊销列表——自包含带来撤销窗口（INV-6）
    premise: 传输与存储保密；是否绑定设备 / 来源待确认
  - name: 域名证书
    issuer: ops
    holder: ops
    redeemer: anonymous_visitor
    selfContained: local-verify
    ttl: 由证书自身 notAfter 决定，系统只观测不签发（档位见 域名证书.有效期档）
    revoke: 运维在控制台吊销 ⇒ 数据面停止装载；机构侧吊销本系统不感知
    premise: 权威来自系统外部（证书由外部 CA 签发、运维仅登记），本地可验证——这正是凭证的定义；机构可信、私钥不泄露、多域名下 SNI 必须命中正确证书
---

# 背景

本协议描述「匿名发布 + 认领」的公网资源 SaaS 的协作规则：专用工具匿名把内网资源（短时内网映射 / 长期文件托管）发布到公网，匿名访问者凭公网地址访问；账号持有者凭认领码认领资源成为归属人，在控制台移除自己的资源；运营审查与封禁违规资源；运维管理转发服务器与域名证书；系统自身承担心跳超时判定、健康探测、配额重算、认领码过期、证书巡检与已移除资源回收。

模型数据源为 model-lab/model.js 六张清单（角色 6 / 操作 24 / 实体维度 16 / 关系 12 / 凭证 3 / 不变量 11），本文件为 protochain 六张清单 DSL 重建（六张清单形态：操作 = 改实体维度，无状态机段，实体维度带 kind 断言）。

# 核心概念

- **资源**：匿名发布 + 认领的公网资源单元，五个维度（形态 / 归属状态 / 处置状态 / 访问策略 / 审核状态），操作直接改维度、无单一状态轴
- **认领码**：发布时派生的凭证，一码唯一绑一资源，是「无归属 → 有归属」的唯一路径；兑付状态（declared）与有效期状态（observed）为两个独立维度
- **短时映射实例**：短时内网映射形态资源的运行实例，连接状态只能观测（心跳），任何角色都写不了
- **文件对象**：长期文件托管形态资源的运行实例，存在性只能观测（上传）
- **账号配额**：账号下的文件空间档位与映射并发档位，由调度任务重算（observed，连续量压成档位）
- **转发服务器 / 转发服务器实例**：运维登记的基础设施记录与可观测的健康实例（记录与实例分开）
- **控制面 / 数据面**：访问策略的权威面与兑现面；数据面副本由 INV-11 约束（T_sync 内收敛）

# 协作流程

专用工具匿名发布资源（资源＋认领码，同一事务 TX1）后资源维度进入 归属=无归属、处置=正常、访问策略=拒绝、审核=待审，同时派生认领码。匿名访问者无码访问被拒绝（访问策略=拒绝），带码访问进入认领流程（未登录则先引导登录）。账号持有者登录并认领（资源＋认领码，同一事务 TX2）后 归属=已认领、访问策略=放行、兑付状态=已使用，可被公网访问。运营审查资源判定通过或违规，违规资源可被封禁（处置=已封禁、访问策略=拒绝，认领码不可兑付，INV-7）。归属人可移除资源（处置=已移除、访问策略=拒绝），底层文件对象 / 映射实例随后由系统回收（INV-10）。运维登记 / 下线转发服务器与接入域名、登记 / 吊销域名证书。系统自身周期性执行心跳超时判定、健康探测、配额重算、证书巡检、认领码过期与已移除资源回收。

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
  change: 无。判断接口：不改状态，但系统依据状态决定代理还是拒绝
  trigger: role
- role: anonymous_visitor
  op: 携带认领码访问
  target: 资源
  guard: 归属状态=无归属 ∧ 处置状态=正常 ∧ 认领码.兑付状态=未使用
  change: 无。判断接口：依据状态决定进认领页还是拒绝（未登录则先引导登录）
  trigger: role
- role: account_holder
  op: 登录
  target: 账号
  guard: 账号.账号状态=正常
  change: 签发登录会话（凭证：登录会话，可本地验证）
  trigger: role
- role: account_holder
  op: 认领资源
  target: 资源 ＋ 认领码
  guard: "归属状态=无归属 ∧ 处置状态=正常 ∧ 认领码.兑付状态=未使用 ∧ 账号.账号状态=正常 ∧ (形态=短时内网映射 ⇒ 账号配额.映射并发状态≠已用尽) ∧ (形态=长期文件托管 ⇒ 账号配额.文件空间状态≠已用尽)"
  change: "资源.归属状态=已认领 ∧ 资源.访问策略=放行 ∧ 认领码.兑付状态=已使用。跨实体同一事务——这是 INV-2 能标 always 的唯一依据；若拆成两步，INV-2 必须降级为 eventually_within"
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
- role: operator
  op: 封禁用户
  target: 账号 ＋ 资源
  guard: 账号.账号状态=正常
  change: "账号.账号状态=已封禁；名下资源访问策略置为拒绝，由补偿任务异步完成（跨账号与资源两个聚合，非同一事务）——INV-6 只能标 eventually_within 的原因"
  trigger: role
- role: ops
  op: 登记转发服务器
  target: 转发服务器
  guard: （新建登记，无既有状态 guard）
  change: 转发服务器.在册状态=在册（服务状态由观测填充）
  trigger: role
- role: ops
  op: 下线转发服务器
  target: 转发服务器
  guard: 在册状态=在册
  change: 转发服务器.在册状态=已下线
  trigger: role
- role: ops
  op: 登记接入域名
  target: 接入域名
  guard: （新建登记，无既有状态 guard）
  change: 接入域名.在册状态=在册
  trigger: role
- role: ops
  op: 下线接入域名
  target: 接入域名
  guard: 在册状态=在册
  change: 接入域名.在册状态=已下线
  trigger: role
- role: ops
  op: 登记 / 更换域名证书
  target: 域名证书
  guard: 接入域名.在册状态=在册
  change: "域名证书.域名覆盖=已覆盖；有效期档不由本操作写入，由「重算证书有效期档」从证书内容观测得出；证书由运维在外部取得后登记进来，系统只接收结果——颁发机构不是本系统组件，不进模型"
  trigger: role
- role: ops
  op: 吊销域名证书
  target: 域名证书
  guard: 域名覆盖=已覆盖
  change: 域名证书.域名覆盖=未覆盖（转发服务器停止装载）
  trigger: role
- role: system
  op: 心跳超时判定
  target: 短时映射实例
  guard: 连接状态=在线 ∧ 超过 T_hb 未收到心跳
  change: 短时映射实例.连接状态=离线
  trigger: scheduled
- role: system
  op: 探测转发服务器健康
  target: 转发服务器实例
  guard: 转发服务器.在册状态=在册（跨层 guard：作用在实例上，条件看它的记录）
  change: 转发服务器实例.服务状态=健康 | 降级 | 离线
  trigger: observed
- role: system
  op: 重算账号配额
  target: 账号配额
  guard: （周期性全量重算）
  change: 账号配额.文件空间状态=按当前实际占用刷新档位 ∧ 账号配额.映射并发状态=按当前实际占用刷新档位
  trigger: scheduled
- role: system
  op: 重算证书有效期档
  target: 域名证书
  guard: （周期性巡检）
  change: 域名证书.有效期档=有效 | 临近过期 | 已过期
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
- entity: 账号
  etype: 记录
  dim: 账号状态
  kind: declared
  domain: "{正常, 已封禁}。注销未建模，见待确认 #16"
- entity: 账号配额
  etype: 记录
  dim: 文件空间状态
  kind: observed
  domain: "{有余量, 已用尽, 已超限}。占用是连续量，不可枚举，故压成档位"
- entity: 账号配额
  etype: 记录
  dim: 映射并发状态
  kind: observed
  domain: "{有余量, 已用尽, 已超限}。并发数是连续量，同样压成档位"
- entity: 转发服务器
  etype: 记录
  dim: 在册状态
  kind: declared
  domain: "{在册, 已下线}。运维声明的意图层：这台机器归我们管。与运行实例分开的理由：登记后实例可能还没起来，下线后实例可能还在排空连接"
- entity: 转发服务器实例
  etype: 运行实例
  dim: 服务状态
  kind: observed
  domain: "{健康, 降级, 离线}。只能观测健康检查。2026-08-29 从「转发服务器」拆出——原实体同时带 declared 与 observed 两类维度，按 §5 的拆分信号该拆"
- entity: 接入域名
  etype: 记录
  dim: 在册状态
  kind: declared
  domain: "{在册, 已下线}"
- entity: 域名证书
  etype: 凭证
  dim: 域名覆盖
  kind: declared
  domain: "{已覆盖, 未覆盖}。运维登记；实际是 per-(证书,域名) 的事实，模型压平了，见待确认 #19"
- entity: 域名证书
  etype: 凭证
  dim: 有效期档
  kind: observed
  domain: "{有效, 临近过期, 已过期}。由时间与 CA 签发决定，只能观测"
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
| INV-3 | 并发上限 | 同一账号下 连接状态=在线 的实例数 ≤ 并发上限 | system | intra_protocol | 最终一致（并发计数依赖观测心跳，天然滞后）；收敛上界见 TM1（T_stat） | state-machine | 超限则拒绝新的认领，并强制离线最旧的实例 | 并发占用计数与配额档位对账 |
| INV-4 | 空间上限 | 账号下文件对象占用总量 ≤ 空间上限 | system | intra_protocol | 最终一致（占用统计滞后于写入与回收）；收敛上界见 TM2（T_space） | state-machine | 拒绝新上传；超限部分在回收前只读 | 空间占用统计与配额档位对账 |
| INV-5 | 离线不计并发 | 连接状态=离线 ⇒ 不计入并发占用 | system | intra_protocol | 最终一致；收敛上界见 TM3（T_hb + T_stat） | state-machine | 修正计数并释放配额余量；展示与配额判断以修正后为准 | 离线实例计数修正扫描 |
| INV-6 | 封禁连带 | 账号状态=已封禁 ⇒ 其名下资源 访问策略=拒绝 | system | intra_protocol | 最终一致（跨账号与资源两个聚合，异步补偿，事务边界 TX3）；收敛上界见 TM4（T_ban） | state-machine | 补偿任务批量置拒绝并告警；未完成前数据面可能仍按本地副本放行（风险） | 封禁账号名下资源访问策略扫描 |
| INV-7 | 封禁即不可访问 | 处置状态=已封禁 ⇒ 访问策略=拒绝 ∧ 认领码不可兑付 | system | intra_protocol | 强一致（资源与认领码在同一事务内更新） | state-machine | 拒绝访问与认领；运营解除前保持 | 封禁资源访问与认领路径校验 |
| INV-8 | 在册域名必有有效证书 | 接入域名.在册状态=在册 ⇒ 存在 有效期档≠已过期 ∧ 域名覆盖=已覆盖 的证书 | system | intra_protocol | 最终一致（证书签发依赖外部 CA）；收敛上界见 TM5（T_cert 续期窗口） | state-machine | 告警运维；期间该域名 HTTPS fail-closed（拒绝握手） | 在册域名证书覆盖与有效期档巡检 |
| INV-9 | 服务器离线资源不可达 | 转发服务器实例.服务状态=离线 ∨ 转发服务器.在册状态=已下线 ⇒ 落在其上的映射实例与文件对象不可达 | system | intra_protocol | 最终一致（健康检查有周期）；收敛上界见 TM6（T_mig） | state-machine | 重新绑定到健康实例；未迁移前该资源不可达 | 健康检查与实例绑定扫描 |
| INV-10 | 移除即拒绝 | 处置状态=已移除 ⇒ 访问策略=拒绝 | system | intra_protocol | 强一致（同一记录内） | state-machine | 拒绝访问并触发底层回收（回收时机与可恢复性见待确认 #18） | 已移除资源访问策略校验 |
| INV-11 | 数据面副本一致 | 数据面访问策略副本 = 控制面 资源.访问策略 | system | intra_protocol | 最终一致（控制面 → 数据面推送）；收敛上界见 TM7（T_sync） | state-machine | 超期未同步 ⇒ 数据面 fail-closed（停止兑现该资源） | 数据面副本与控制面访问策略对账 |

# 时序约束

| ID | 名称 | 类型 | 源 | 目标 | 约束值(ms) | 违约转移 | schedule | 描述 |
|---|---|---|---|---|---|---|---|---|
| TM1 | 并发统计收敛 | deadline | 重算账号配额 | INV-3 | 30000 | | | 并发占用统计收敛上界 T_stat（= T_hb + 统计周期；占位值，待使用方确认，见待确认 #4） |
| TM2 | 空间统计收敛 | deadline | 重算账号配额 | INV-4 | 30000 | | | 空间占用统计收敛上界 T_space（占位值，待使用方确认） |
| TM3 | 离线释放收敛 | deadline | 心跳超时判定 | INV-5 | 60000 | | | 离线后并发占用释放收敛上界 T_hb + T_stat（占位值，待使用方确认） |
| TM4 | 封禁连带收敛 | deadline | 封禁用户 | INV-6 | 60000 | | | 封禁用户后名下资源访问策略置拒绝的异步补偿上界 T_ban（占位值，待使用方确认） |
| TM5 | 证书续期窗口 | deadline | 重算证书有效期档 | INV-8 | 1209600000 | | | 在册域名存在有效证书的续期窗口 T_cert（占位值 14 天，待使用方确认） |
| TM6 | 迁移收敛 | deadline | 探测转发服务器健康 | INV-9 | 120000 | | | 服务器离线后映射/文件迁移上界 T_mig（健康检查周期 + 迁移时长；占位值，待使用方确认） |
| TM7 | 数据面同步收敛 | deadline | 认领资源 | INV-11 | 30000 | | | 控制面 → 数据面访问策略副本推送收敛上界 T_sync（占位值，待使用方确认） |
| TM8 | 定时巡检扫描 | scheduled | 系统自身（调度与观测） | 系统自身（调度与观测） | | | * * * * * | 系统定时任务（心跳超时判定/认领码过期/配额重算/证书巡检/资源回收）的扫描节拍（周期占位，待使用方确认） |

# 关系

```yaml
- from: 资源
  to: 账号
  type: 绑定
  constraint: "一个资源最多绑定一个归属账号；认领即建立，认领后不可转让（待确认）"
  onGone: "账号被封禁 ⇒ 名下资源访问策略=拒绝（INV-6），记录保留；账号注销未建模，见待确认 #16"
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
- from: 短时映射实例
  to: 转发服务器实例
  type: 绑定
  constraint: "同一时刻只绑一台，绑定唯一。落点是运行层事实，故绑到实例而不是记录"
  onGone: "转发服务器记录下线 ⇒ 实例路由失效，需重新绑定到别的实例"
- from: 短时映射实例
  to: 转发服务器实例
  type: 运行依赖
  constraint: "只在运行实例之间成立——记录之间没有运行依赖；依赖图无环"
  onGone: "实例离线 ⇒ 实例不可达，需迁到健康节点；是否自动迁移待确认"
- from: 文件对象
  to: 转发服务器实例
  type: 运行依赖
  constraint: "文件托管的读取同样在转发服务器兑现"
  onGone: "实例离线 ⇒ 文件不可下载；文件本身不丢"
- from: 转发服务器
  to: 转发服务器实例
  type: 派生
  constraint: "0..1 个（已登记但还没起来 ⇒ 无实例）。实例不可被声明只能观测，生命周期不同步（登记先于实例、下线后实例还在排空），身份需追溯（哪台机器）"
  onGone: "实例消失（探测中断、机器销毁）⇒ 该服务器不可承接新映射，记录保留待运维处置；期间其上已有映射不可达（INV-9）"
- from: 域名证书
  to: 接入域名
  type: 绑定
  constraint: "一张证书可覆盖多个在册域名；每个在册域名至少一张有效证书（INV-8）"
  onGone: "域名下线 ⇒ 证书保留至过期，仍可覆盖其他域名"
- from: 转发服务器
  to: 域名证书
  type: 绑定
  constraint: "配置层：这台机器须持有所服务域名的全部有效证书。绑到记录而不是实例——运维配的是机器，装载发生在其派生的实例上；SNI 选择的前提"
  onGone: "证书过期或吊销 ⇒ 对应 SNI 的 TLS 握手失败（fail-closed）"
- from: 账号
  to: 账号配额
  type: 组合
  constraint: "生命周期同步、配额身份无需独立追溯 ⇒ 按判据应并入账号；模型暂分开记（待确认）"
  onGone: "账号消失 ⇒ 配额同时消失（本模型中账号不可注销）；反过来：配额记录缺失 ⇒ 按默认档初始化为「有余量」，不阻塞查看与封禁"
- from: 资源
  to: 账号配额
  type: 约束关联
  constraint: "共享「并发上界 / 空间上界」不变量，但两者不互相指向"
  onGone: "无指向可消失；任一方越界由 INV-3 / INV-4 的违约处置覆盖"
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
- id: TX3
  interface: 封禁用户
  boundaryType: async_compensation
  description: 封禁用户跨账号与资源两个聚合，名下资源访问策略=拒绝由补偿任务异步完成（INV-6 只能标 eventually_within 的原因）
- id: TX4
  interface: 回收已移除资源
  boundaryType: async_compensation
  description: 回收已移除资源删除文件对象/清除映射实例，异步清理任务
```

# 组件映射

```yaml
interfaceImplementations:
  - { interface: 匿名发布资源, component: control-plane, description: 匿名发布登记资源记录并派生认领码（管理类写路径） }
  - { interface: 认领资源, component: control-plane, description: 认领资源（跨资源与认领码同一事务） }
  - { interface: 移除资源, component: control-plane, description: 归属人移除资源 }
  - { interface: 审查资源, component: control-plane, description: 运营审查资源 }
  - { interface: 封禁资源, component: control-plane, description: 运营封禁资源 }
  - { interface: 封禁用户, component: control-plane, description: 运营封禁用户（异步补偿名下资源访问策略） }
  - { interface: 登录, component: control-plane, description: 账号登录签发会话 }
  - { interface: 登记转发服务器, component: control-plane, description: 运维登记转发服务器 }
  - { interface: 下线转发服务器, component: control-plane, description: 运维下线转发服务器 }
  - { interface: 登记接入域名, component: control-plane, description: 运维登记接入域名 }
  - { interface: 下线接入域名, component: control-plane, description: 运维下线接入域名 }
  - { interface: 登记 / 更换域名证书, component: control-plane, description: 运维登记/更换域名证书 }
  - { interface: 吊销域名证书, component: control-plane, description: 运维吊销域名证书 }
  - { interface: 重算账号配额, component: control-plane, description: 账号配额重算（调度） }
  - { interface: 重算证书有效期档, component: control-plane, description: 证书有效期档巡检（调度） }
  - { interface: 认领码过期, component: control-plane, description: 认领码过期判定（调度） }
  - { interface: 回收已移除资源, component: control-plane, description: 已移除资源回收（调度） }
  - { interface: 心跳超时判定, component: control-plane, description: 心跳超时判定（调度） }
  - { interface: 请求访问资源（无认领码）, component: data-plane, description: 兑现公网访问（代理/拒绝判定） }
  - { interface: 携带认领码访问, component: data-plane, description: 携带认领码访问的跳转判定 }
  - { interface: 上传文件内容, component: data-plane, description: 文件上传兑现 }
  - { interface: 上报心跳, component: data-plane, description: 心跳接收（观测事实采集） }
  - { interface: 结束运行 / 断开, component: data-plane, description: 断开事件接收（观测事实采集） }
  - { interface: 探测转发服务器健康, component: data-plane, description: 健康探测（观测事实采集） }
dimensionStorage:
  - { dimension: 形态, table: resources, description: 资源记录（短时内网映射/长期文件托管） }
  - { dimension: 归属状态, table: resources }
  - { dimension: 处置状态, table: resources }
  - { dimension: 访问策略, table: resources, description: 从归属状态派生的冗余副本（INV-1） }
  - { dimension: 审核状态, table: resources }
  - { dimension: 连接状态, table: mapping_instances }
  - { dimension: 存在性, table: files }
  - { dimension: 账号状态, table: accounts }
  - { dimension: 文件空间状态, table: quotas }
  - { dimension: 映射并发状态, table: quotas }
  - { dimension: 在册状态, table: servers, description: 转发服务器在册状态 }
  - { dimension: 服务状态, table: servers_instances }
  - { dimension: 在册状态, table: domains, description: 接入域名在册状态 }
  - { dimension: 域名覆盖, table: certs }
  - { dimension: 有效期档, table: certs }
  - { dimension: 兑付状态, table: claim_codes }
  - { dimension: 有效期状态, table: claim_codes }
componentTransfers:
  - { from: control-plane, to: data-plane, channel: event, mode: async, description: 推送访问策略副本（INV-11，T_sync 内收敛；超期未同步数据面 fail-closed） }
  - { from: data-plane, to: control-plane, channel: event, mode: async, description: 上报心跳/断开/健康探测等观测事件 }
```

<!--
R3a 范式转换备注（model.js 六张清单 → protochain 六张清单 DSL，V2 状态机版 4aa8b69 推翻重做）：
1. 六张清单形态：无状态空间/转移规则/附属实体/异常路径/契约层段；「操作」段（24 操作）与
   「实体维度」段（16+1 维度）为主范式，关系/不变量/时序约束/事务边界/组件映射段保留。
2. 操作 change 转写规则：model.js「状态变更」列原文按 parser 分句规则（∧；;。换行）重排为
   「实体.维度=值」子句（X.y=z 进 target 语义/affectsDimensions）+ 纯文本子句（进 sideEffects）；
   新建/派生/不可兑付等无维度赋值的语义保留为 sideEffects 文本。
3. 语义修正一（认领码维度拆分）：model.js 认领码.兑付状态={未使用,已使用,已失效} 由 role（认领）
   与 system（认领码过期）两类写入方写入，R-KIND-2/M10 单维度写入方集合不得混合 ⇒ 拆为
   兑付状态（declared，role 写）+ 有效期状态（observed，system 写），与状态机版 V2 同款修正，语义等价。
4. 语义修正二（凭证三方角色闭合）：model.js 凭证表签发者/持有者/兑现者可非角色（language.md 表5），
   但 R-KIND-11 D 要求闭合到 roles 段角色 ID ⇒ 认领码 redeemer「认领流程」→ account_holder、
   登录会话 redeemer「Web 控制台」→ account_holder、域名证书 issuer「证书颁发机构」→ ops
   （外部 CA 语义保留在 premise 文本），与状态机版 V2 同款修正。
5. 提示词计数勘误：R3a 提示词「25 操作 / 12 实体维度」与当前 model.js 不符（实为 24 操作 / 16 维度行、
   10 实体），以 model.js 实际为准迁移。
6. model.js open 待确认清单未迁入（相关处仅以「待确认」标注，完整列表见 model-lab/model.js §7）。
-->
