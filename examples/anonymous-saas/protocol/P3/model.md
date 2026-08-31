---
name: 基础设施
version: 1.0.0
purpose: 匿名 SaaS 多协议拆分（R3b）· P3 基础设施：转发服务器、转发服务器实例、接入域名、域名证书。本子协议自包含六张清单（操作=改实体维度、无状态机段、实体维度带 kind 断言）；跨协议约束（映射/文件依赖服务器 INV-9、数据面访问策略副本 INV-11 跨 P2）走组合层 protocol/composition.md
roles:
  - id: ops
    name: 运维人员
    responsibilities: 管理转发服务器与所用域名证书（含多域名、SNI）。面向基础设施，不面向用户资源；与运营侧管理员是否细分见待确认 #22
    roleType: participant
  - id: system
    name: 系统自身（调度与观测）
    responsibilities: 转发服务器健康探测、证书有效期档巡检（observed 维度由观测/巡检写入）
    roleType: consensus
  - id: anonymous_visitor
    name: 匿名访问者（仅凭证引用）
    responsibilities: 凭证「域名证书」的兑现方引用（客户端做链式校验）；本域无以其为发起者的操作，行为在 P2 资源域
    roleType: participant
credentials:
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

本子协议描述匿名 SaaS 的基础设施协作规则：运维人员登记 / 下线转发服务器与接入域名、登记 / 更换 / 吊销域名证书；系统自身周期性探测转发服务器健康（服务状态档位）与重算证书有效期档。跨协议：短时映射实例 / 文件对象由转发服务器实例兑现（P2 资源域依赖本域，INV-9）；数据面访问策略副本由控制面推送（P2 → 本域数据面，INV-11）。

模型数据源为 model-lab/model.js 六张清单，本文件为其 P3 基础设施切片（R3b 拆分，自包含可独立 derive/check）。

# 核心概念

- **转发服务器 / 转发服务器实例**：运维登记的基础设施记录（在册状态，declared）与可观测的健康实例（服务状态，observed）——记录与实例分开：登记后实例可能还没起来，下线后实例可能还在排空连接
- **接入域名 / 域名证书**：在册状态（declared）与 域名覆盖/有效期档（declared/observed）；在册域名必须存在有效证书（INV-8）

# 协作流程

运维登记转发服务器（在册状态=在册）、下线转发服务器（在册状态=已下线）；登记 / 下线接入域名；登记 / 更换域名证书（接入域名.在册状态=在册 时置域名覆盖=已覆盖）、吊销域名证书（域名覆盖=未覆盖，转发服务器停止装载）。系统自身周期性探测转发服务器健康（服务状态=健康 | 降级 | 离线）与重算证书有效期档（有效期档=有效 | 临近过期 | 已过期）。在册域名必须有有效证书（INV-8，T_cert 续期窗口内收敛，超期 fail-closed）。

# 操作

```yaml
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
  op: 探测转发服务器健康
  target: 转发服务器实例
  guard: 转发服务器.在册状态=在册（跨层 guard：作用在实例上，条件看它的记录）
  change: 转发服务器实例.服务状态=健康 | 降级 | 离线
  trigger: observed
- role: system
  op: 重算证书有效期档
  target: 域名证书
  guard: （周期性巡检）
  change: 域名证书.有效期档=有效 | 临近过期 | 已过期
  trigger: scheduled
```

# 实体维度

```yaml
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
```

# 不变量

| ID | 名称 | 表达式 | 声明方 | 不变量类别 | 描述 | 级别 | 处置动作 | 检测方式 |
|---|---|---|---|---|---|---|---|---|
| INV-8 | 在册域名必有有效证书 | 接入域名.在册状态=在册 ⇒ 存在 有效期档≠已过期 ∧ 域名覆盖=已覆盖 的证书 | system | intra_protocol | 最终一致（证书签发依赖外部 CA）；收敛上界见 TM5（T_cert 续期窗口） | state-machine | 告警运维；期间该域名 HTTPS fail-closed（拒绝握手） | 在册域名证书覆盖与有效期档巡检 |

# 时序约束

| ID | 名称 | 类型 | 源 | 目标 | 约束值(ms) | 违约转移 | schedule | 描述 |
|---|---|---|---|---|---|---|---|---|
| TM5 | 证书续期窗口 | deadline | 重算证书有效期档 | INV-8 | 1209600000 | | | 在册域名存在有效证书的续期窗口 T_cert（占位值 14 天，待使用方确认） |

# 关系

```yaml
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
```

# 组件映射

```yaml
interfaceImplementations:
  - { interface: 登记转发服务器, component: control-plane, description: 运维登记转发服务器 }
  - { interface: 下线转发服务器, component: control-plane, description: 运维下线转发服务器 }
  - { interface: 登记接入域名, component: control-plane, description: 运维登记接入域名 }
  - { interface: 下线接入域名, component: control-plane, description: 运维下线接入域名 }
  - { interface: 登记 / 更换域名证书, component: control-plane, description: 运维登记/更换域名证书 }
  - { interface: 吊销域名证书, component: control-plane, description: 运维吊销域名证书 }
  - { interface: 探测转发服务器健康, component: data-plane, description: 健康探测（观测事实采集） }
  - { interface: 重算证书有效期档, component: control-plane, description: 证书有效期档巡检（调度） }
dimensionStorage:
  - { dimension: 在册状态, table: servers, description: 转发服务器在册状态 }
  - { dimension: 服务状态, table: servers_instances }
  - { dimension: 在册状态, table: domains, description: 接入域名在册状态 }
  - { dimension: 域名覆盖, table: certs }
  - { dimension: 有效期档, table: certs }
componentTransfers:
  - { from: control-plane, to: data-plane, channel: event, mode: async, description: 装载/停止装载域名证书（SNI 选择前提；证书过期或吊销 ⇒ fail-closed） }
  - { from: data-plane, to: control-plane, channel: event, mode: async, description: 上报健康探测观测事件 }
```

<!--
R3b 拆分备注（P3 基础设施）：
1. 来源：examples/anonymous-saas/protocol/model.md（R3a 单协议六张清单版）按「实体关系簇 + 角色边界」拆分。
2. 操作分布（8）：登记转发服务器/下线转发服务器/登记接入域名/下线接入域名/登记更换域名证书/吊销域名证书
   （运维）+ 探测转发服务器健康/重算证书有效期档（系统自身）。
3. 角色补充：anonymous_visitor 仅为凭证「域名证书」redeemer 的引用闭合（R-KIND-11 D）而声明——
   该角色行为在 P2 资源域，本域 R-KIND-4 对其发「无触发接口」告警（warning，非硬失败），属预期。
4. 本域承接跨协议不变量在 P3 侧的条目：INV-9（跨 P2，服务器离线资源不可达）、INV-11（跨 P2，数据面访问策略
   副本）落组合层；intra 不变量 INV-8 留在本域，其时序约束 TM5 留本域。
5. 关系分布：派生（转发服务器→转发服务器实例）、绑定（域名证书→接入域名、转发服务器→域名证书）留本域；
   跨域绑定/运行依赖（短时映射实例→转发服务器实例、文件对象→转发服务器实例）由组合层依赖图 + INV-9 承接。
6. 本域无跨 ≥2 实体的操作，无需「事务边界」段。
-->
