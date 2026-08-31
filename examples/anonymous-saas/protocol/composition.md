# 系统元数据

```yaml
systemName: 匿名发布+认领的公网资源 SaaS（多协议拆分）
version: 0.1.0
changeType: protocol_extend
```

# 子协议清单

```yaml
- protocolId: P1
  name: 账号域
  version: 1.0.0
  modelPath: protocol/P1/model.md
- protocolId: P2
  name: 资源发布与兑现
  version: 1.0.0
  modelPath: protocol/P2/model.md
- protocolId: P3
  name: 基础设施
  version: 1.0.0
  modelPath: protocol/P3/model.md
```

# 依赖图

```mermaid
graph LR
  P1[账号域]
  P2[资源发布与兑现]
  P3[基础设施]
  P1 --> P2
  P2 --> P3
  P2 -. 事件 .-> P3
```

```yaml
- from: P1
  to: P2
  dependencyType: state
  description: 配额→资源：账号配额 约束关联 资源（认领时校验账号状态/配额档位、配额重算统计资源占用；INV-3/4 跨 P1/P2）
- from: P2
  to: P3
  dependencyType: state
  description: 资源→服务器：短时映射实例/文件对象 运行依赖 转发服务器实例（映射实例绑定转发服务器实例；INV-9 服务器离线资源不可达）
- from: P2
  to: P3
  dependencyType: event
  description: 控制面→数据面推送访问策略副本（INV-11，T_sync 内收敛；超期未同步数据面 fail-closed）
```

# 跨协议不变量

### INV-3: 并发上限（跨 P1/P2）

```yaml
id: INV-3
name: 并发上限（跨 P1/P2）
span: [P1, P2]
expression: 同一账号下 连接状态=在线 的短时映射实例数 ≤ 并发上限（P1 账号配额.映射并发状态 档位；P2 短时映射实例.连接状态 在线计数）
declaredBy: system
checkMethod: 并发占用计数（P2 短时映射实例在线数）与账号配额档位（P1）对账；收敛上界 XT1（T_stat）
complexity: simple_boolean
```

### INV-4: 空间上限（跨 P1/P2）

```yaml
id: INV-4
name: 空间上限（跨 P1/P2）
span: [P1, P2]
expression: 账号下文件对象占用总量 ≤ 空间上限（P1 账号配额.文件空间状态 档位；P2 文件对象.存在性 占用统计）
declaredBy: system
checkMethod: 空间占用统计（P2 文件对象）与账号配额档位（P1）对账；收敛上界 XT2（T_space）
complexity: simple_boolean
```

### INV-6: 封禁连带（跨 P1/P2）

```yaml
id: INV-6
name: 封禁连带（跨 P1/P2）
span: [P1, P2]
expression: 账号状态=已封禁（P1 账号）⇒ 其名下资源 访问策略=拒绝（P2 资源）
declaredBy: system
checkMethod: 封禁账号（P1）名下资源访问策略（P2）扫描；异步补偿，收敛上界 XT3（T_ban）
complexity: simple_boolean
```

### INV-9: 服务器离线资源不可达（跨 P2/P3）

```yaml
id: INV-9
name: 服务器离线资源不可达（跨 P2/P3）
span: [P2, P3]
expression: 转发服务器实例.服务状态=离线（P3）∨ 转发服务器.在册状态=已下线（P3）⇒ 落在其上的映射实例与文件对象不可达（P2）
declaredBy: system
checkMethod: 健康检查（P3）与实例绑定扫描（P2）；重新绑定到健康实例，收敛上界 XT4（T_mig）
complexity: simple_boolean
```

### INV-11: 数据面访问策略副本一致（跨 P2/P3）

```yaml
id: INV-11
name: 数据面访问策略副本一致（跨 P2/P3）
span: [P2, P3]
expression: 数据面（P3 转发服务器实例所见）访问策略副本 = 控制面 资源.访问策略（P2）
declaredBy: system
checkMethod: 数据面副本与控制面访问策略对账；控制面→数据面推送，收敛上界 XT5（T_sync）
complexity: simple_boolean
```

# 跨协议时序

### XT1: 并发统计收敛

```yaml
id: XT1
name: 并发统计收敛
rule: 重算账号配额（P1）收敛并发占用统计的上界 T_stat = T_hb + 统计周期（INV-3 bound，占位值，待使用方确认）
span: [P1, P2]
boundMs: 30000
```

### XT2: 空间统计收敛

```yaml
id: XT2
name: 空间统计收敛
rule: 重算账号配额（P1）收敛空间占用统计的上界 T_space（INV-4 bound，占位值，待使用方确认）
span: [P1, P2]
boundMs: 30000
```

### XT3: 封禁连带收敛

```yaml
id: XT3
name: 封禁连带收敛
rule: 封禁用户（P1）后名下资源访问策略置拒绝（P2）的异步补偿上界 T_ban（INV-6 bound，占位值，待使用方确认）
span: [P1, P2]
boundMs: 60000
```

### XT4: 迁移收敛

```yaml
id: XT4
name: 迁移收敛
rule: 服务器离线（P3）后映射/文件迁移上界 T_mig = 健康检查周期 + 迁移时长（INV-9 bound，占位值，待使用方确认）
span: [P2, P3]
boundMs: 120000
```

### XT5: 数据面同步收敛

```yaml
id: XT5
name: 数据面同步收敛
rule: 控制面（P2）→ 数据面（P3）访问策略副本推送收敛上界 T_sync（INV-11 bound，占位值，待使用方确认）
span: [P2, P3]
boundMs: 30000
```

### XT6: 定时巡检扫描

```yaml
id: XT6
name: 定时巡检扫描
rule: 系统定时任务（心跳超时判定/认领码过期/配额重算/证书巡检/资源回收）的扫描节拍（周期占位，待使用方确认）
span: [P1, P2, P3]
```

<!--
R3b 组合层备注：
1. 拆分来源：examples/anonymous-saas/protocol/model.md（R3a 单协议六张清单版，11 条不变量）。
2. 跨协议不变量分布（原 11 条 → 子协议 or 组合层）：
   - 组合层 5 条：INV-3（并发上限，P1/P2）、INV-4（空间上限，P1/P2）、INV-6（封禁连带，P1/P2）、
     INV-9（服务器离线资源不可达，P2/P3）、INV-11（数据面访问策略副本一致，P2/P3）；
   - P2 intra 5 条：INV-1/2/5/7/10；P3 intra 1 条：INV-8；P1 intra 0 条。
   合计 5+5+1+0 = 11，无遗漏（R3b-4）。
3. 事件契约：组合层无独立「事件契约」段——derive-cross-contracts 从依赖图 edges 派生事件契约；
   「推送访问策略副本」（INV-11）以 dependencyType=event 的 P2→P3 边承载。
4. 依赖方向：P1→P2（配额→资源，INV-3/4）、P2→P3（资源→服务器，INV-9）+ P2→P3 事件（INV-11 副本推送）。
5. 原时序约束分布：TM1/2（配额统计）→ XT1/XT2，TM4（封禁连带）→ XT3，TM6（迁移）→ XT4，
   TM7（数据面同步）→ XT5，TM8（定时巡检）→ XT6；TM3（离线释放）留 P2、TM5（证书续期）留 P3。
-->
