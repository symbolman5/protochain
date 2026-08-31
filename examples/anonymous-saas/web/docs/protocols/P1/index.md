# P1 —— 账号域

> 版本：**1.0.0** | 接口总数：**3**（系统 3 + 观测 0）

## 接口列表

| ID | 名称 | 类型 | schemaKind |
| --- | --- | --- | --- |
| [IF_SYS_OP1](IF_SYS_OP1) | 登录 | 系统 | legacy-stub |
| [IF_SYS_OP2](IF_SYS_OP2) | 封禁用户 | 系统 | legacy-stub |
| [IF_SYS_OP3](IF_SYS_OP3) | 重算账号配额 | 系统 | legacy-stub |

## 跨协议引用

- 引用其他协议：**3** 条
- 被其他协议引用：**6** 条

### 引用其他协议

| 源接口 | 源字段 | 目标协议 | 目标 | 类型 | 上下文 |
| --- | --- | --- | --- | --- | --- |
| [IF_SYS_OP2](IF_SYS_OP2) | outputs[0].description | P2 | — | guard | …下资源访问策略置为拒绝由补偿任务异步完成（跨协议：P2 资源域，组合层 INV-6，T_ban 内收敛） |
| [IF_SYS_OP2](IF_SYS_OP2) | postconditions[0] | P2 | — | guard | …下资源访问策略置为拒绝由补偿任务异步完成（跨协议：P2 资源域，组合层 INV-6，T_ban 内收敛） |
| [IF_SYS_OP2](IF_SYS_OP2) | sideEffects[0].description | P2 | — | guard | …下资源访问策略置为拒绝由补偿任务异步完成（跨协议：P2 资源域，组合层 INV-6，T_ban 内收敛） |

### 被其他协议引用

| 源协议 | 源接口 | 源字段 | 目标 | 类型 | 上下文 |
| --- | --- | --- | --- | --- | --- |
| P2 | IF_SYS_OP7 | precondition | — | guard | … 认领码.兑付状态=未使用 ∧ 账号状态（P1 账号域）=正常 ∧ (形态=短时内网映射 ⇒ 映… |
| P2 | IF_SYS_OP7 | precondition | — | guard | …∧ 账号状态（P1 账号域）=正常 ∧ (形态=短时内网映射 ⇒ 映射并发状态（P1 账号配额）≠已用尽) ∧ (形态=长期文件托管 ⇒… |
| P2 | IF_SYS_OP7 | precondition | — | guard | …发状态（P1 账号配额）≠已用尽) ∧ (形态=长期文件托管 ⇒ 文件空间状态（P1 账号配额）≠已用尽) |
| P2 | IF_SYS_OP7 | preconditions[0].description | — | guard | … 认领码.兑付状态=未使用 ∧ 账号状态（P1 账号域）=正常 ∧ (形态=短时内网映射 ⇒ 映… |
| P2 | IF_SYS_OP7 | preconditions[0].description | — | guard | …∧ 账号状态（P1 账号域）=正常 ∧ (形态=短时内网映射 ⇒ 映射并发状态（P1 账号配额）≠已用尽) ∧ (形态=长期文件托管 ⇒… |
| P2 | IF_SYS_OP7 | preconditions[0].description | — | guard | …发状态（P1 账号配额）≠已用尽) ∧ (形态=长期文件托管 ⇒ 文件空间状态（P1 账号配额）≠已用尽) |

## 更多信息

- [测试用例浏览器](test-cases) — 路径覆盖度与偏差
- [验证报告对比](verification) — legacy vs impl 双跑对账
- [模型 diff / impact](diff) — 变更 → 受影响步骤/产物
- [绑定视图](bindings) — 传输绑定与错误映射
