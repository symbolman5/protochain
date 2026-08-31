---
name: 账号域
version: 1.0.0
purpose: 匿名 SaaS 多协议拆分（R3b）· P1 账号域：账号、账号配额、登录会话凭证。本子协议自包含六张清单（操作=改实体维度、无状态机段、实体维度带 kind 断言）；跨协议约束（配额与资源占用 INV-3/4、封禁连带 INV-6）走组合层 protocol/composition.md
roles:
  - id: account_holder
    name: 账号持有者（认领者）
    responsibilities: 登录 Web 控制台（认领资源、移除自己的资源在 P2 资源域）。认领是从「无归属」到「有归属」的唯一路径；拥有两个配额
    roleType: participant
  - id: system
    name: 系统自身（调度与观测）
    responsibilities: 配额重算（账号配额档位由调度任务周期性重算）；本子协议内系统自身是账号配额 observed 维度的唯一写入方
    roleType: consensus
  - id: operator
    name: 运营人员
    responsibilities: 审查用户发布的资源，发现违规可封禁资源甚至封禁用户；本子协议承接「封禁用户」的账号侧（账号状态=已封禁），名下资源访问策略=拒绝由组合层 INV-6 异步补偿承接（P2 资源域）
    roleType: participant
credentials:
  - name: 登录会话
    issuer: system
    holder: account_holder
    redeemer: account_holder
    selfContained: local-verify
    ttl: 短，具体待定
    revoke: 主动退出即失效；账号被封禁后需等令牌过期或查吊销列表——自包含带来撤销窗口（INV-6）
    premise: 传输与存储保密；是否绑定设备 / 来源待确认
---

# 背景

本子协议描述匿名 SaaS 的账号域协作规则：账号持有者登录 Web 控制台获取登录会话（凭证，可本地验证）；系统自身周期性重算账号配额档位；运营人员封禁用户时本域负责账号状态=已封禁，名下资源访问策略=拒绝由组合层补偿任务异步完成（跨 P1/P2，INV-6）。账号配额的两个档位（文件空间状态 / 映射并发状态）为 observed 维度——占用是连续量，由调度任务（重算账号配额）从 P2 资源域的实际占用统计得出。

模型数据源为 model-lab/model.js 六张清单，本文件为其 P1 账号域切片（R3b 拆分，自包含可独立 derive/check）。

# 核心概念

- **账号**：账号持有者的身份记录，维度「账号状态」（declared，正常/已封禁）
- **账号配额**：账号下的文件空间档位与映射并发档位，两个维度均为 observed（调度任务重算）；与资源域的占用约束关联见组合层 INV-3/4
- **登录会话**：账号持有者登录后签发的凭证（可本地验证）；跨协议撤销窗口见 INV-6

# 协作流程

账号持有者登录（账号状态=正常 时签发登录会话，凭证：登录会话）。运营人员封禁用户（账号状态=正常 时置账号状态=已封禁；名下资源访问策略=拒绝由组合层 INV-6 补偿任务在 T_ban 内异步完成）。系统自身周期性重算账号配额（文件空间状态 / 映射并发状态按 P2 资源域当前实际占用刷新档位，收敛上界见组合层 XT1/XT2）。

# 操作

```yaml
- role: account_holder
  op: 登录
  target: 账号
  guard: 账号.账号状态=正常
  change: 签发登录会话（凭证：登录会话，可本地验证）
  trigger: role
- role: operator
  op: 封禁用户
  target: 账号
  guard: 账号.账号状态=正常
  change: "账号.账号状态=已封禁；名下资源访问策略置为拒绝由补偿任务异步完成（跨协议：P2 资源域，组合层 INV-6，T_ban 内收敛）"
  trigger: role
- role: system
  op: 重算账号配额
  target: 账号配额
  guard: （周期性全量重算）
  change: 账号配额.文件空间状态=按当前实际占用刷新档位 ∧ 账号配额.映射并发状态=按当前实际占用刷新档位
  trigger: scheduled
```

# 实体维度

```yaml
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
```

# 关系

```yaml
- from: 账号
  to: 账号配额
  type: 组合
  constraint: "生命周期同步、配额身份无需独立追溯 ⇒ 按判据应并入账号；模型暂分开记（待确认）"
  onGone: "账号消失 ⇒ 配额同时消失（本模型中账号不可注销）；反过来：配额记录缺失 ⇒ 按默认档初始化为「有余量」，不阻塞查看与封禁"
```

<!--
R3b 拆分备注（P1 账号域）：
1. 来源：examples/anonymous-saas/protocol/model.md（R3a 单协议六张清单版）按「实体关系簇 + 角色边界」拆分。
2. 操作分布：登录（OP7）、封禁用户（OP12）、重算账号配额（OP21）三操作归本域。
   封禁用户 target 由「账号 ＋ 资源」收窄为「账号」——资源不在本子协议实体域内；
   资源侧连带（访问策略=拒绝）保留在 change 文本并转由组合层 INV-6 承接（语义等价，事务边界 TX3 随拆分取消）。
3. 本域无 intra 不变量（原 INV-3/4/6 均跨 P1/P2，落在组合层），故无「不变量」段；「时序约束」段同样归组合层（XT1/XT2/XT3）。
4. 登录会话凭证：三方（issuer=system/holder=account_holder/redeemer=account_holder）均在本域 roles 内闭合（R-KIND-11 D）。
5. 账号配额 文件空间状态/映射并发状态 为 observed（scheduled 重算写入），与 R3a 断言一致。
-->
