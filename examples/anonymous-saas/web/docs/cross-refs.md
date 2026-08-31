# 跨协议引用矩阵 —— 匿名发布+认领的公网资源 SaaS（多协议拆分）

> 跨协议引用总数：**12**（机械提取，参照 E1-I2 跨协议引用识别口径）

## 共享实体 / 关联矩阵

*(composition.md 未声明对象状态切面)*

## 跨协议观测接口

*(composition.md 未声明观测接口)*

## 跨协议守卫 / 字段引用（按引用源→目标分组）

### P1 → P2（3 条）

| 源接口 | 源字段 | 类型 | 目标 | 上下文 |
| --- | --- | --- | --- | --- |
| IF_SYS_OP2 | outputs[0].description | guard | P2 | …下资源访问策略置为拒绝由补偿任务异步完成（跨协议：P2 资源域，组合层 INV-6，T_ban 内收敛） |
| IF_SYS_OP2 | postconditions[0] | guard | P2 | …下资源访问策略置为拒绝由补偿任务异步完成（跨协议：P2 资源域，组合层 INV-6，T_ban 内收敛） |
| IF_SYS_OP2 | sideEffects[0].description | guard | P2 | …下资源访问策略置为拒绝由补偿任务异步完成（跨协议：P2 资源域，组合层 INV-6，T_ban 内收敛） |

### P2 → P3（3 条）

| 源接口 | 源字段 | 类型 | 目标 | 上下文 |
| --- | --- | --- | --- | --- |
| IF_SYS_OP5 | outputs[0].description | guard | P3 | …不改状态，但系统依据状态决定代理还是拒绝（数据面兑现见 P3） |
| IF_SYS_OP5 | postconditions[1] | guard | P3 | …不改状态，但系统依据状态决定代理还是拒绝（数据面兑现见 P3） |
| IF_SYS_OP5 | sideEffects[1].description | guard | P3 | …不改状态，但系统依据状态决定代理还是拒绝（数据面兑现见 P3） |

### P2 → P1（6 条）

| 源接口 | 源字段 | 类型 | 目标 | 上下文 |
| --- | --- | --- | --- | --- |
| IF_SYS_OP7 | precondition | guard | P1 | … 认领码.兑付状态=未使用 ∧ 账号状态（P1 账号域）=正常 ∧ (形态=短时内网映射 ⇒ 映… |
| IF_SYS_OP7 | precondition | guard | P1 | …∧ 账号状态（P1 账号域）=正常 ∧ (形态=短时内网映射 ⇒ 映射并发状态（P1 账号配额）≠已用尽) ∧ (形态=长期文件托管 ⇒… |
| IF_SYS_OP7 | precondition | guard | P1 | …发状态（P1 账号配额）≠已用尽) ∧ (形态=长期文件托管 ⇒ 文件空间状态（P1 账号配额）≠已用尽) |
| IF_SYS_OP7 | preconditions[0].description | guard | P1 | … 认领码.兑付状态=未使用 ∧ 账号状态（P1 账号域）=正常 ∧ (形态=短时内网映射 ⇒ 映… |
| IF_SYS_OP7 | preconditions[0].description | guard | P1 | …∧ 账号状态（P1 账号域）=正常 ∧ (形态=短时内网映射 ⇒ 映射并发状态（P1 账号配额）≠已用尽) ∧ (形态=长期文件托管 ⇒… |
| IF_SYS_OP7 | preconditions[0].description | guard | P1 | …发状态（P1 账号配额）≠已用尽) ∧ (形态=长期文件托管 ⇒ 文件空间状态（P1 账号配额）≠已用尽) |

## 跨协议不变量覆盖映射

| 不变量 | 名称 | span | 声明方 | 复杂度 | 关联接口 |
| --- | --- | --- | --- | --- | --- |
| INV-3 | 并发上限（跨 P1/P2） | P1, P2 | system | simple_boolean | *(无)* |
| INV-4 | 空间上限（跨 P1/P2） | P1, P2 | system | simple_boolean | *(无)* |
| INV-6 | 封禁连带（跨 P1/P2） | P1, P2 | system | simple_boolean | *(无)* |
| INV-9 | 服务器离线资源不可达（跨 P2/P3） | P2, P3 | system | simple_boolean | *(无)* |
| INV-11 | 数据面访问策略副本一致（跨 P2/P3） | P2, P3 | system | simple_boolean | *(无)* |
