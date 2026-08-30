---
name: 匿名发布+认领的公网资源 SaaS
version: 1.0.0
purpose: 描述匿名发布 + 认领的公网资源 SaaS 的完整协作规则：专用工具匿名发布资源（短时内网映射 / 长期文件托管），匿名访问者凭公网地址访问或带码进入认领流程，账号持有者认领资源成为归属人，运营审查封禁，运维管理服务器与证书，系统自身承担调度与观测
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
    ttl: 待定（建议与未认领资源保留期一致，见待确认 #2）
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
    ttl: 由证书自身 notAfter 决定，系统只观测不签发（档位见 domain_cert.有效期档）
    revoke: 运维在控制台吊销 ⇒ 数据面停止装载；机构侧吊销本系统不感知
    premise: 权威来自系统外部（证书由外部 CA 签发、运维仅登记），本地可验证——这正是凭证的定义；机构可信、私钥不泄露、多域名下 SNI 必须命中正确证书
---

# 背景

本协议描述「匿名发布 + 认领」的公网资源 SaaS 的协作规则：专用工具匿名把内网资源（短时内网映射 / 长期文件托管）发布到公网，匿名访问者凭公网地址访问；账号持有者凭认领码认领资源成为归属人，在控制台移除自己的资源；运营审查与封禁违规资源；运维管理转发服务器与域名证书；系统自身承担心跳超时判定、健康探测、配额重算、认领码过期、证书巡检与已移除资源回收。

模型数据源为 model-lab/model.js 六张清单（角色 6 / 操作 24 / 实体 10 含维度 16 / 关系 12 / 凭证 3 / 不变量 11），本文件为其 protochain 状态机 DSL 重建（范式转换：实体-维度 → 聚合生命周期状态机）。

# 核心概念

- **资源**：匿名发布 + 认领的公网资源单元，其生命周期是本协议的主状态机（未发布 → 已发布 → 已认领 / 已封禁 / 已移除）
- **认领码**：发布时派生的凭证，一码唯一绑一资源，是「无归属 → 有归属」的唯一路径
- **短时映射实例**：短时内网映射形态资源的运行实例，连接状态只能观测（心跳），任何角色都写不了
- **文件对象**：长期文件托管形态资源的运行实例，存在性只能观测（上传）
- **账号配额**：账号下的文件空间档位与映射并发档位，由调度任务重算（observed，连续量压成档位）
- **转发服务器 / 转发服务器实例**：运维登记的基础设施记录与可观测的健康实例（记录与实例分开，见转发服务器.在册状态注释）
- **控制面 / 数据面**：访问策略的权威面与兑现面；数据面副本由 INV-11 约束（T_sync 内收敛）

# 协作流程

专用工具匿名发布资源后资源进入已发布（归属=无归属、访问策略=拒绝、审核=待审），同时派生认领码。匿名访问者无码访问被拒绝（访问策略=拒绝），带码访问进入认领流程（未登录则先引导登录）。账号持有者登录并认领后资源进入已认领（访问策略=放行），可被公网访问。运营审查资源判定通过或违规，违规资源可被封禁进入已封禁（认领码不可兑付，INV-7）。归属人可移除资源进入已移除，底层文件对象 / 映射实例随后由系统回收（INV-10）。运维登记 / 下线转发服务器与接入域名、登记 / 吊销域名证书。系统自身周期性执行心跳超时判定、健康探测、配额重算、证书巡检、认领码过期与已移除资源回收。

# 异常处理原则

- 短时映射失联（工具退出 / 断网）由心跳超时判定兜底，连接状态=离线，并发占用随后释放（INV-5）
- 证书过期 / 吊销 / 缺失时该域名 HTTPS fail-closed（INV-8）
- 转发服务器离线或已下线时其上资源不可达，待迁移到健康实例（INV-9）
- 封禁用户的连带（名下资源访问策略=拒绝）由补偿任务异步完成（INV-6，T_ban 内收敛）
- 数据面访问策略副本超期未同步时数据面 fail-closed，停止兑现该资源（INV-11）

# 状态空间

| ID | 名称 | 类型 | 描述 | 角色 |
|---|---|---|---|---|
| S0 | 未发布 | initial | 资源记录尚未创建，发布动作的前置；系统与基础设施（服务器/域名/证书/配额）操作独立运行于此背景态 | system |
| S1 | 已发布 | normal | 匿名发布完成：归属=无归属、处置=正常、访问策略=拒绝、审核=待审；等待认领或审查 | publisher_tool, anonymous_visitor, account_holder, operator |
| S2 | 已认领 | normal | 认领完成：归属=已认领、访问策略=放行；可被公网访问（短时映射在线或文件存在时） | account_holder, anonymous_visitor, operator |
| S3 | 已封禁 | terminal | 运营封禁：处置=已封禁、访问策略=拒绝；认领码不可兑付（INV-7） | operator |
| S4 | 已移除 | terminal | 归属人移除：处置=已移除、访问策略=拒绝；底层文件对象/映射实例随后回收（INV-10） | account_holder, system |

# 转移规则

| ID | 名称 | from | to | action | trigger | guard | effects | triggerType | actionType | affectsDimensions |
|---|---|---|---|---|---|---|---|---|---|---|
| T1 | 匿名发布资源 | S0 | S1 | publish_resource | publisher_tool | 发布形态合法（短时内网映射 或 长期文件托管 二选一）；无账号、无配额校验（配额校验在认领时，见待确认 #1） | 新建资源记录（归属状态=无归属，处置状态=正常，访问策略=拒绝，审核状态=待审）；派生 1 个认领码（兑付状态=未使用） | role | state_transition | 形态,归属状态,处置状态,访问策略,审核状态,兑付状态 |
| T2 | 审查资源 | S1 | S1 | review_resource | operator | 审核状态=待审 | 审核状态=通过或违规（仅一个维度、无独立审核记录，留痕见待确认 #8） | role | state_transition | 审核状态 |
| T3 | 认领资源 | S1 | S2 | claim_resource | account_holder | 归属状态=无归属 且 处置状态=正常 且 兑付状态=未使用 且 有效期状态=有效 且 账号状态=正常 且（形态=短时内网映射 → 映射并发状态≠已用尽）且（形态=长期文件托管 → 文件空间状态≠已用尽） | 归属状态=已认领；访问策略=放行；兑付状态=已使用。跨实体同一事务（事务边界 TX2）——这是 INV-2 能标 always 的唯一依据 | role | state_transition | 归属状态,访问策略,兑付状态 |
| T4 | 移除资源 | S2 | S4 | remove_resource | account_holder | 处置状态≠已移除 | 处置状态=已移除；访问策略=拒绝（底层实例随后回收，INV-10） | role | state_transition | 处置状态,访问策略 |
| T5 | 封禁资源 | S1, S2 | S3 | ban_resource | operator | 审核状态=违规 | 处置状态=已封禁；访问策略=拒绝（认领码不可兑付由 INV-7 以强一致承载） | role | state_transition | 处置状态,访问策略 |
| T6 | 封禁用户 | S2 | S2 | ban_user | operator | 账号状态=正常 | 账号状态=已封禁；名下资源访问策略=拒绝由补偿任务异步完成（非同一事务，事务边界 TX3）——INV-6 只能标 eventually_within 的原因 | role | state_transition | 账号状态,访问策略 |
| T7 | 登录 | S1 | S1 | login | account_holder | 账号状态=正常 | 签发登录会话（凭证：登录会话，本地可验证） | role | state_transition | |
| T8 | 请求访问资源（无认领码） | S2 | S2 | request_access | anonymous_visitor | 访问策略=放行 且 处置状态=正常 | 无。判断接口：不改状态，但系统依据状态决定代理还是拒绝 | role | state_transition | |
| T9 | 携带认领码访问 | S1 | S1 | visit_with_claim_code | anonymous_visitor | 归属状态=无归属 且 处置状态=正常 且 兑付状态=未使用 且 有效期状态=有效 | 无。判断接口：依据状态决定进认领页还是拒绝（未登录则先引导登录） | role | state_transition | |
| T10 | 上传文件内容 | S1 | S1 | upload_file | system | 形态=长期文件托管 且 处置状态=正常 | 存在性=存在（专用工具上传、系统观测写入；上传途中「记录已建、字节未完整」落于缺失档，见待确认 #23） | system | state_transition | 存在性 |
| T11 | 上报心跳 | S2 | S2 | report_heartbeat | system | 形态=短时内网映射 且 处置状态=正常 | 连接状态=在线（专用工具上报心跳、系统观测写入） | system | state_transition | 连接状态 |
| T12 | 结束运行 / 断开 | S2 | S2 | disconnect_mapping | system | 连接状态=在线 | 连接状态=离线（并发占用随后释放，INV-5） | system | state_transition | 连接状态 |
| T13 | 心跳超时判定 | S2 | S2 | heartbeat_timeout | system | 连接状态=在线 且 超过 T_hb 未收到心跳 | 连接状态=离线 | system | state_transition | 连接状态 |
| T14 | 探测转发服务器健康 | S0 | S0 | probe_server_health | system | 转发服务器.在册状态=在册（跨层 guard：作用在实例上，条件看它的记录） | 服务状态=健康或降级或离线 | system | state_transition | 服务状态 |
| T15 | 登记转发服务器 | S0 | S0 | register_server | ops | 新建登记（无既有状态 guard） | 在册状态=在册（服务状态由观测填充） | role | state_transition | 在册状态 |
| T16 | 下线转发服务器 | S0 | S0 | deregister_server | ops | 在册状态=在册 | 在册状态=已下线 | role | state_transition | 在册状态 |
| T17 | 登记接入域名 | S0 | S0 | register_domain | ops | 新建登记（无既有状态 guard） | 在册状态=在册 | role | state_transition | 在册状态 |
| T18 | 下线接入域名 | S0 | S0 | deregister_domain | ops | 在册状态=在册 | 在册状态=已下线 | role | state_transition | 在册状态 |
| T19 | 登记 / 更换域名证书 | S0 | S0 | register_cert | ops | 接入域名.在册状态=在册 | 域名覆盖=已覆盖（有效期档不由本操作写入，由「重算证书有效期档」从证书内容观测得出；证书在外部取得后登记，系统只接收结果） | role | state_transition | 域名覆盖 |
| T20 | 吊销域名证书 | S0 | S0 | revoke_cert | ops | 域名覆盖=已覆盖 | 域名覆盖=未覆盖（转发服务器停止装载） | role | state_transition | 域名覆盖 |
| T21 | 重算账号配额 | S0 | S0 | recalc_quota | system | 周期性全量重算 | 文件空间状态 / 映射并发状态 按当前实际占用刷新 | system | state_transition | 文件空间状态,映射并发状态 |
| T22 | 重算证书有效期档 | S0 | S0 | recalc_cert_validity | system | 周期性巡检 | 有效期档=有效或临近过期或已过期 | system | state_transition | 有效期档 |
| T23 | 认领码过期 | S1 | S1 | claim_code_expire | system | 兑付状态=未使用 且 有效期状态=有效 且 超过有效期 | 有效期状态=已失效（未认领资源永久不可认领，见关系 资源→认领码 onGone） | system | state_transition | 有效期状态 |
| T24 | 回收已移除资源 | S4 | S4 | recycle_removed | system | 处置状态=已移除 且 超过保留期 | 删除文件对象；清除映射实例；归档记录（异步补偿，事务边界 TX4） | system | state_transition | 存在性,连接状态 |

# 不变量

| ID | 名称 | 表达式 | 作用状态 | 声明方 | 不变量类别 | 描述 | 级别 | 处置动作 | 检测方式 |
|---|---|---|---|---|---|---|---|---|---|
| INV-1 | 放行须已认领且正常 | 访问策略=放行 ⇒ 归属状态=已认领 且 处置状态=正常 | S2 | system | intra_protocol | 强一致（同一记录内）。数据面需本地可判定，故访问策略从归属状态派生后冗余存储，由本不变量保证一致 | state-machine | 拒绝访问，控制面告警并修正；修正期内数据面以本地副本为准 | 访问策略与归属状态一致性扫描 |
| INV-2 | 认领唯一性 | 归属状态=已认领 ⇒ 兑付状态=已使用 且 归属账号唯一 | S2 | system | intra_protocol | 强一致（认领需跨资源与认领码的同一事务，事务边界 TX2） | state-machine | 拒绝重复认领；检测到双花即冻结资源并告警 | 认领事务的兑付状态与归属账号唯一性校验 |
| INV-3 | 并发上限 | 同一账号下 连接状态=在线 的实例数 ≤ 并发上限 | S2 | system | intra_protocol | 最终一致（并发计数依赖观测心跳，天然滞后）；收敛上界见 TM2（T_stat） | state-machine | 超限则拒绝新的认领，并强制离线最旧的实例 | 并发占用计数与配额档位对账 |
| INV-4 | 空间上限 | 账号下文件对象占用总量 ≤ 空间上限 | S2 | system | intra_protocol | 最终一致（占用统计滞后于写入与回收）；收敛上界见 TM3（T_space） | state-machine | 拒绝新上传；超限部分在回收前只读 | 空间占用统计与配额档位对账 |
| INV-5 | 离线不计并发 | 连接状态=离线 ⇒ 不计入并发占用 | S2 | system | intra_protocol | 最终一致；收敛上界见 TM4（T_hb + T_stat） | state-machine | 修正计数并释放配额余量；展示与配额判断以修正后为准 | 离线实例计数修正扫描 |
| INV-6 | 封禁连带 | 账号状态=已封禁 ⇒ 其名下资源 访问策略=拒绝 | S2 | system | intra_protocol | 最终一致（跨账号与资源两个聚合，异步补偿，事务边界 TX3）；收敛上界见 TM5（T_ban） | state-machine | 补偿任务批量置拒绝并告警；未完成前数据面可能仍按本地副本放行（风险） | 封禁账号名下资源访问策略扫描 |
| INV-7 | 封禁即不可访问 | 处置状态=已封禁 ⇒ 访问策略=拒绝 且 认领码不可兑付 | S3 | system | intra_protocol | 强一致（资源与认领码在同一事务内更新） | state-machine | 拒绝访问与认领；运营解除前保持 | 封禁资源访问与认领路径校验 |
| INV-8 | 在册域名必有有效证书 | 接入域名.在册状态=在册 ⇒ 存在 有效期档≠已过期 且 域名覆盖=已覆盖 的证书 | S0 | system | intra_protocol | 最终一致（证书签发依赖外部 CA）；收敛上界见 TM6（T_cert 续期窗口） | state-machine | 告警运维；期间该域名 HTTPS fail-closed（拒绝握手） | 在册域名证书覆盖与有效期档巡检 |
| INV-9 | 服务器离线资源不可达 | 转发服务器实例.服务状态=离线 或 转发服务器.在册状态=已下线 ⇒ 落在其上的映射实例与文件对象不可达 | S2 | system | intra_protocol | 最终一致（健康检查有周期）；收敛上界见 TM7（T_mig） | state-machine | 重新绑定到健康实例；未迁移前该资源不可达 | 健康检查与实例绑定扫描 |
| INV-10 | 移除即拒绝 | 处置状态=已移除 ⇒ 访问策略=拒绝 | S4 | system | intra_protocol | 强一致（同一记录内） | state-machine | 拒绝访问并触发底层回收（回收时机与可恢复性见待确认 #18） | 已移除资源访问策略校验 |
| INV-11 | 数据面副本一致 | 数据面访问策略副本 = 控制面 资源.访问策略 | S2 | system | intra_protocol | 最终一致（控制面 → 数据面推送）；收敛上界见 TM8（T_sync） | state-machine | 超期未同步 ⇒ 数据面 fail-closed（停止兑现该资源） | 数据面副本与控制面访问策略对账 |

# 时序约束

| ID | 名称 | 类型 | 源 | 目标 | 约束值(ms) | 违约转移 | schedule | 描述 |
|---|---|---|---|---|---|---|---|---|
| TM1 | 并发统计收敛 | deadline | recalc_quota | INV-3 | 30000 | | | 并发占用统计收敛上界 T_stat（= T_hb + 统计周期；占位值，待使用方确认，见待确认 #4） |
| TM2 | 空间统计收敛 | deadline | recalc_quota | INV-4 | 30000 | | | 空间占用统计收敛上界 T_space（占位值，待使用方确认） |
| TM3 | 离线释放收敛 | deadline | heartbeat_timeout | INV-5 | 60000 | | | 离线后并发占用释放收敛上界 T_hb + T_stat（占位值，待使用方确认） |
| TM4 | 封禁连带收敛 | deadline | ban_user | INV-6 | 60000 | | | 封禁用户后名下资源访问策略置拒绝的异步补偿上界 T_ban（占位值，待使用方确认） |
| TM5 | 证书续期窗口 | deadline | recalc_cert_validity | INV-8 | 1209600000 | | | 在册域名存在有效证书的续期窗口 T_cert（占位值 14 天，待使用方确认） |
| TM6 | 迁移收敛 | deadline | probe_server_health | INV-9 | 120000 | | | 服务器离线后映射/文件迁移上界 T_mig（健康检查周期 + 迁移时长；占位值，待使用方确认） |
| TM7 | 数据面同步收敛 | deadline | claim_resource | INV-11 | 30000 | | | 控制面 → 数据面访问策略副本推送收敛上界 T_sync（占位值，待使用方确认） |
| TM8 | 定时巡检扫描 | scheduled | S1 | S1 | | | * * * * * | 系统定时任务（心跳超时判定/认领码过期/配额重算/证书巡检/资源回收）的扫描节拍（周期占位，待使用方确认） |

# 异常路径

| ID | 名称 | 触发 | 转移序列 | 恢复策略 |
|---|---|---|---|---|
| EX1 | 短时映射失联 | 工具退出 / 断网超过 T_hb 未收到心跳 | T13 | 连接状态=离线；并发占用释放（INV-5）；资源不可达直至工具重连（是否复用同一实例身份待确认） |
| EX2 | 证书过期或吊销 | 域名证书 有效期档=已过期 或 域名覆盖=未覆盖 | T22, T20 | 对应 SNI 的 TLS 握手失败（fail-closed）；告警运维续期（INV-8，T_cert 窗口内） |
| EX3 | 服务器离线 | 转发服务器实例.服务状态=离线 或 转发服务器.在册状态=已下线 | T14 | 其上映射/文件不可达；重新绑定到健康实例（INV-9，T_mig 内；是否自动迁移待确认） |
| EX4 | 已移除资源回收 | 处置状态=已移除 且 超过保留期 | T24 | 删除文件对象 / 清除映射实例 / 归档记录（回收时机与可恢复性待确认 #18） |

# 事务边界

```yaml
- id: TX1
  interface: publish_resource
  boundaryType: same_transaction
  description: 发布创建资源记录并派生认领码（兑付状态=未使用），跨资源与认领码同一事务
- id: TX2
  interface: claim_resource
  boundaryType: same_transaction
  description: 认领同时改资源（归属状态/访问策略）与认领码（兑付状态），跨实体同一事务——INV-2 标 always 的依据
- id: TX3
  interface: ban_user
  boundaryType: async_compensation
  description: 封禁用户跨账号与资源两个聚合，名下资源访问策略=拒绝由补偿任务异步完成（INV-6 只能标 eventually_within 的原因）
- id: TX4
  interface: recycle_removed
  boundaryType: async_compensation
  description: 回收已移除资源删除文件对象/清除映射实例，异步清理任务
```

# 关系

```yaml
- from: resource
  to: account
  type: 绑定
  constraint: 一个资源最多绑定一个归属账号；认领即建立，认领后不可转让（待确认）
  onGone: 账号被封禁 ⇒ 名下资源访问策略=拒绝（INV-6），记录保留；账号注销未建模（待确认）
- from: resource
  to: mapping_instance
  type: 派生
  constraint: 仅当 形态=短时内网映射；0..1 个。实例不可被声明、生命周期不同步、身份需追溯 ⇒ 与记录分开
  onGone: 实例离线 ⇒ 资源不可达、并发占用释放（INV-5）；记录保留，工具重连是否复用同一实例身份待确认
- from: resource
  to: file_object
  type: 派生
  constraint: 仅当 形态=长期文件托管；1 个
  onGone: 文件缺失 ⇒ 资源不可达并告警；记录保留至回收。上传途中（记录已建、字节未完整）落于「缺失」档（待确认）
- from: resource
  to: claim_code
  type: 派生
  constraint: 发布时生成 1 个，一码唯一绑一资源
  onGone: 码失效或已使用 ⇒ 无归属资源永久不可认领；是否补发待确认
- from: mapping_instance
  to: forward_server_instance
  type: 绑定
  constraint: 同一时刻只绑一台，绑定唯一。落点是运行层事实，故绑到实例而不是记录
  onGone: 转发服务器记录下线 ⇒ 实例路由失效，需重新绑定到别的实例
- from: mapping_instance
  to: forward_server_instance
  type: 运行依赖
  constraint: 只在运行实例之间成立——记录之间没有运行依赖；依赖图无环
  onGone: 实例离线 ⇒ 实例不可达，需迁到健康节点；是否自动迁移待确认
- from: file_object
  to: forward_server_instance
  type: 运行依赖
  constraint: 文件托管的读取同样在转发服务器兑现
  onGone: 实例离线 ⇒ 文件不可下载；文件本身不丢
- from: forward_server
  to: forward_server_instance
  type: 派生
  constraint: 0..1 个（已登记但还没起来 ⇒ 无实例）。实例不可被声明只能观测，生命周期不同步（登记先于实例、下线后实例还在排空），身份需追溯（哪台机器）
  onGone: 实例消失（探测中断、机器销毁）⇒ 该服务器不可承接新映射，记录保留待运维处置；期间其上已有映射不可达（INV-9）
- from: domain_cert
  to: access_domain
  type: 绑定
  constraint: 一张证书可覆盖多个在册域名；每个在册域名至少一张有效证书（INV-8）
  onGone: 域名下线 ⇒ 证书保留至过期，仍可覆盖其他域名
- from: forward_server
  to: domain_cert
  type: 绑定
  constraint: 配置层：这台机器须持有所服务域名的全部有效证书。绑到记录而不是实例——运维配的是机器，装载发生在其派生的实例上；SNI 选择的前提
  onGone: 证书过期或吊销 ⇒ 对应 SNI 的 TLS 握手失败（fail-closed）
- from: account
  to: account_quota
  type: 组合
  constraint: 生命周期同步、配额身份无需独立追溯 ⇒ 按判据应并入账号；模型暂分开记（待确认）
  onGone: 账号消失 ⇒ 配额同时消失（本模型中账号不可注销）；反过来：配额记录缺失 ⇒ 按默认档初始化为「有余量」，不阻塞查看与封禁
- from: resource
  to: account_quota
  type: 约束关联
  constraint: 共享「并发上界 / 空间上界」不变量，但两者不互相指向
  onGone: 无指向可消失；任一方越界由 INV-3 / INV-4 的违约处置覆盖
```

# 组件映射

```yaml
interfaceImplementations:
  - { interface: publish_resource, component: control-plane, description: 匿名发布登记资源记录并派生认领码（管理类写路径） }
  - { interface: claim_resource, component: control-plane, description: 认领资源（跨资源与认领码同一事务） }
  - { interface: remove_resource, component: control-plane, description: 归属人移除资源 }
  - { interface: review_resource, component: control-plane, description: 运营审查资源 }
  - { interface: ban_resource, component: control-plane, description: 运营封禁资源 }
  - { interface: ban_user, component: control-plane, description: 运营封禁用户（异步补偿名下资源访问策略） }
  - { interface: login, component: control-plane, description: 账号登录签发会话 }
  - { interface: register_server, component: control-plane, description: 运维登记转发服务器 }
  - { interface: deregister_server, component: control-plane, description: 运维下线转发服务器 }
  - { interface: register_domain, component: control-plane, description: 运维登记接入域名 }
  - { interface: deregister_domain, component: control-plane, description: 运维下线接入域名 }
  - { interface: register_cert, component: control-plane, description: 运维登记/更换域名证书 }
  - { interface: revoke_cert, component: control-plane, description: 运维吊销域名证书 }
  - { interface: recalc_quota, component: control-plane, description: 账号配额重算（调度） }
  - { interface: recalc_cert_validity, component: control-plane, description: 证书有效期档巡检（调度） }
  - { interface: claim_code_expire, component: control-plane, description: 认领码过期判定（调度） }
  - { interface: recycle_removed, component: control-plane, description: 已移除资源回收（调度） }
  - { interface: heartbeat_timeout, component: control-plane, description: 心跳超时判定（调度） }
  - { interface: request_access, component: data-plane, description: 兑现公网访问（代理/拒绝判定） }
  - { interface: visit_with_claim_code, component: data-plane, description: 携带认领码访问的跳转判定 }
  - { interface: upload_file, component: data-plane, description: 文件上传兑现 }
  - { interface: report_heartbeat, component: data-plane, description: 心跳接收（观测事实采集） }
  - { interface: disconnect_mapping, component: data-plane, description: 断开事件接收（观测事实采集） }
  - { interface: probe_server_health, component: data-plane, description: 健康探测（观测事实采集） }
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

# 附属实体

```yaml
- id: resource
  name: 资源
  belongsTo: 本协议（资源生命周期 S0-S4）
  instanceKey: resource.id
  lifecycleDependency: 随资源生命周期（S0→S1 创建记录，S3/S4 终态保留至回收）
  cascadeRules:
    - 发布（S0→S1）时创建资源记录
    - 封禁进入 S3 / 移除进入 S4 后记录保留至回收
  stateSpace:
    dimensions:
      - name: 形态
        type: enum[短时内网映射, 长期文件托管]
        initial: 短时内网映射
        kind: declared
      - name: 归属状态
        type: enum[无归属, 已认领]
        initial: 无归属
        kind: declared
      - name: 处置状态
        type: enum[正常, 已封禁, 已移除]
        initial: 正常
        kind: declared
      - name: 访问策略
        type: enum[拒绝, 放行]
        initial: 拒绝
        kind: declared
      - name: 审核状态
        type: enum[待审, 通过, 违规]
        initial: 待审
        kind: declared
  invariants:
    - INV-1
    - INV-10
- id: mapping_instance
  name: 短时映射实例
  belongsTo: resource（形态=短时内网映射）
  instanceKey: mapping_instance.id
  lifecycleDependency: 随资源生命周期，仅短时内网映射形态存在
  cascadeRules:
    - 发布短时映射资源时创建实例
    - 资源移除或回收后清除实例
  stateSpace:
    dimensions:
      - name: 连接状态
        type: enum[在线, 离线]
        initial: 离线
        kind: observed
  invariants:
    - INV-5
- id: file_object
  name: 文件对象
  belongsTo: resource（形态=长期文件托管）
  instanceKey: file_object.id
  lifecycleDependency: 随资源生命周期，仅长期文件托管形态存在
  cascadeRules:
    - 发布文件托管资源时创建对象记录
    - 上传成功后存在性=存在
    - 资源回收后删除
  stateSpace:
    dimensions:
      - name: 存在性
        type: enum[存在, 缺失]
        initial: 缺失
        kind: observed
  invariants: []
- id: account
  name: 账号
  belongsTo: 本协议（账号体系）
  instanceKey: account.id
  lifecycleDependency: 独立生命周期（注册于系统外部，注销未建模）
  cascadeRules:
    - 账号被封禁后名下资源访问策略置拒绝（INV-6，异步补偿）
  stateSpace:
    dimensions:
      - name: 账号状态
        type: enum[正常, 已封禁]
        initial: 正常
        kind: declared
  invariants:
    - INV-6
- id: account_quota
  name: 账号配额
  belongsTo: account（组合关系，暂分开记）
  instanceKey: account_quota.id
  lifecycleDependency: 随账号生命周期（组合关系；配额记录缺失时按默认档「有余量」初始化）
  cascadeRules:
    - 账号消失 ⇒ 配额同时消失（本模型账号不可注销）
    - 配额记录缺失 ⇒ 按默认档初始化为「有余量」，不阻塞查看与封禁
  stateSpace:
    dimensions:
      - name: 文件空间状态
        type: enum[有余量, 已用尽, 已超限]
        initial: 有余量
        kind: observed
      - name: 映射并发状态
        type: enum[有余量, 已用尽, 已超限]
        initial: 有余量
        kind: observed
  invariants:
    - INV-3
    - INV-4
- id: forward_server
  name: 转发服务器
  belongsTo: 本协议（基础设施）
  instanceKey: forward_server.id
  lifecycleDependency: 独立生命周期（运维登记/下线）
  cascadeRules:
    - 登记创建在册记录
    - 下线后实例仍可能排空连接
  stateSpace:
    dimensions:
      - name: 在册状态
        type: enum[在册, 已下线]
        initial: 已下线
        kind: declared
  invariants:
    - INV-9
- id: forward_server_instance
  name: 转发服务器实例
  belongsTo: forward_server（派生）
  instanceKey: forward_server_instance.id
  lifecycleDependency: 派生自转发服务器记录（登记后实例才可能起来，下线后实例继续排空）
  cascadeRules:
    - 登记后实例被健康探测填充服务状态
    - 服务器下线后实例继续排空连接
  stateSpace:
    dimensions:
      - name: 服务状态
        type: enum[健康, 降级, 离线]
        initial: 离线
        kind: observed
  invariants:
    - INV-9
- id: access_domain
  name: 接入域名
  belongsTo: 本协议（基础设施）
  instanceKey: access_domain.id
  lifecycleDependency: 独立生命周期（运维登记/下线）
  cascadeRules:
    - 登记创建在册记录
    - 下线后证书保留至过期
  stateSpace:
    dimensions:
      - name: 在册状态
        type: enum[在册, 已下线]
        initial: 已下线
        kind: declared
  invariants:
    - INV-8
- id: domain_cert
  name: 域名证书
  belongsTo: access_domain（一张证书可覆盖多个在册域名）
  instanceKey: domain_cert.id
  lifecycleDependency: 证书有效期由外部 CA 决定，系统只观测不签发
  cascadeRules:
    - 运维登记/更换证书 ⇒ 域名覆盖=已覆盖
    - 运维吊销 ⇒ 域名覆盖=未覆盖，数据面停止装载
  stateSpace:
    dimensions:
      - name: 域名覆盖
        type: enum[已覆盖, 未覆盖]
        initial: 未覆盖
        kind: declared
      - name: 有效期档
        type: enum[有效, 临近过期, 已过期]
        initial: 有效
        kind: observed
  invariants:
    - INV-8
- id: claim_code
  name: 认领码
  belongsTo: resource（发布时派生）
  instanceKey: claim_code.id
  lifecycleDependency: 随资源生命周期（发布派生，认领/过期/封禁后失效）
  cascadeRules:
    - 发布时生成 1 个，一码唯一绑一资源
    - 认领后兑付状态=已使用
    - 超过有效期后有效期状态=已失效
    - 资源封禁后不可兑付（INV-7）
  stateSpace:
    dimensions:
      - name: 兑付状态
        type: enum[未使用, 已使用]
        initial: 未使用
        kind: declared
      - name: 有效期状态
        type: enum[有效, 已失效]
        initial: 有效
        kind: observed
  invariants:
    - INV-2
    - INV-7
```

# 契约层

```yaml
parties: [publisher_tool, anonymous_visitor, account_holder, operator, ops, system]
expectedInformationFields:
  - publish_resource
  - review_resource
  - claim_resource
  - remove_resource
  - ban_resource
  - ban_user
  - login
  - request_access
  - visit_with_claim_code
  - upload_file
  - report_heartbeat
  - disconnect_mapping
  - heartbeat_timeout
  - probe_server_health
  - register_server
  - deregister_server
  - register_domain
  - deregister_domain
  - register_cert
  - revoke_cert
  - recalc_quota
  - recalc_cert_validity
  - claim_code_expire
  - recycle_removed
```

<!--
范式转换备注（model-lab model.js → protochain 状态机 DSL）：
1. 主状态机 = 资源聚合生命周期（S0 未发布 → S1 已发布 → S2 已认领 / S3 已封禁 / S4 已移除）；
   资源五维度（形态/归属状态/处置状态/访问策略/审核状态）迁入附属实体 resource 的 stateSpace.dimensions（带 kind 断言），
   同时作为「关系」段端点（R-KIND-14 端点命名空间 = 状态 ID ∪ 附属实体 ID ∪ 维度名）。
2. 认领码.兑付状态（declared）+ 新增有效期状态（observed）拆为两个维度：model.js 的「兑付状态={未使用,已使用,已失效}」
   由 role（认领/封禁）与 system（认领码过期）两类写入方写入，protochain R-KIND-2/M10 要求单维度写入方集合不得混合，
   故拆分；「已失效」语义由有效期状态=已失效承载，语义等价。
3. model.js trigger 四值映射：role→role；observed/scheduled→system（系统观测/调度，写入 observed 维度）；
   model.js 中「专用工具上报心跳」等 observed 操作的本体（发起者）保留在 effects/名称 文本中。
4. model.js 不变量 timing/bound → 时序约束段：always 类不进入时序表；
   eventually_within 类以 deadline 行承载（源=触发动作、目标=INV 编号），boundMs 为占位值（T_hb/T_stat/T_ban/T_cert/T_mig/T_sync 均待使用方确认）。
5. model.js open 待确认清单未迁入（本文件相关处仅以「待确认」标注，完整列表见 model-lab/model.js §7）。
-->
