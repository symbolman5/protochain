# P2 —— 资源发布与兑现

> 版本：**1.0.0** | 接口总数：**18**（系统 13 + 观测 5）

## 接口列表

| ID | 名称 | 类型 | schemaKind |
| --- | --- | --- | --- |
| [IF_SYS_OP1](IF_SYS_OP1) | 匿名发布资源 | 系统 | legacy-stub |
| [IF_SYS_OP2](IF_SYS_OP2) | 上报心跳 | 系统 | legacy-stub |
| [IF_SYS_OP3](IF_SYS_OP3) | 结束运行 / 断开 | 系统 | legacy-stub |
| [IF_SYS_OP4](IF_SYS_OP4) | 上传文件内容 | 系统 | legacy-stub |
| [IF_SYS_OP5](IF_SYS_OP5) | 请求访问资源（无认领码） | 系统 | legacy-stub |
| [IF_SYS_OP6](IF_SYS_OP6) | 携带认领码访问 | 系统 | legacy-stub |
| [IF_SYS_OP7](IF_SYS_OP7) | 认领资源 | 系统 | legacy-stub |
| [IF_SYS_OP8](IF_SYS_OP8) | 移除资源 | 系统 | legacy-stub |
| [IF_SYS_OP9](IF_SYS_OP9) | 审查资源 | 系统 | legacy-stub |
| [IF_SYS_OP10](IF_SYS_OP10) | 封禁资源 | 系统 | legacy-stub |
| [IF_SYS_OP11](IF_SYS_OP11) | 心跳超时判定 | 系统 | legacy-stub |
| [IF_SYS_OP12](IF_SYS_OP12) | 认领码过期 | 系统 | legacy-stub |
| [IF_SYS_OP13](IF_SYS_OP13) | 回收已移除资源 | 系统 | legacy-stub |
| [IF_OBS_INV_INV-1](IF_OBS_INV_INV-1) | observe_INV-1 | 观测 | structured |
| [IF_OBS_INV_INV-2](IF_OBS_INV_INV-2) | observe_INV-2 | 观测 | structured |
| [IF_OBS_INV_INV-5](IF_OBS_INV_INV-5) | observe_INV-5 | 观测 | structured |
| [IF_OBS_INV_INV-7](IF_OBS_INV_INV-7) | observe_INV-7 | 观测 | structured |
| [IF_OBS_INV_INV-10](IF_OBS_INV_INV-10) | observe_INV-10 | 观测 | structured |

## 跨协议引用

- 引用其他协议：**9** 条
- 被其他协议引用：**3** 条

### 引用其他协议

| 源接口 | 源字段 | 目标协议 | 目标 | 类型 | 上下文 |
| --- | --- | --- | --- | --- | --- |
| [IF_SYS_OP5](IF_SYS_OP5) | outputs[0].description | P3 | — | guard | …不改状态，但系统依据状态决定代理还是拒绝（数据面兑现见 P3） |
| [IF_SYS_OP5](IF_SYS_OP5) | postconditions[1] | P3 | — | guard | …不改状态，但系统依据状态决定代理还是拒绝（数据面兑现见 P3） |
| [IF_SYS_OP5](IF_SYS_OP5) | sideEffects[1].description | P3 | — | guard | …不改状态，但系统依据状态决定代理还是拒绝（数据面兑现见 P3） |
| [IF_SYS_OP7](IF_SYS_OP7) | precondition | P1 | — | guard | … 认领码.兑付状态=未使用 ∧ 账号状态（P1 账号域）=正常 ∧ (形态=短时内网映射 ⇒ 映… |
| [IF_SYS_OP7](IF_SYS_OP7) | precondition | P1 | — | guard | …∧ 账号状态（P1 账号域）=正常 ∧ (形态=短时内网映射 ⇒ 映射并发状态（P1 账号配额）≠已用尽) ∧ (形态=长期文件托管 ⇒… |
| [IF_SYS_OP7](IF_SYS_OP7) | precondition | P1 | — | guard | …发状态（P1 账号配额）≠已用尽) ∧ (形态=长期文件托管 ⇒ 文件空间状态（P1 账号配额）≠已用尽) |
| [IF_SYS_OP7](IF_SYS_OP7) | preconditions[0].description | P1 | — | guard | … 认领码.兑付状态=未使用 ∧ 账号状态（P1 账号域）=正常 ∧ (形态=短时内网映射 ⇒ 映… |
| [IF_SYS_OP7](IF_SYS_OP7) | preconditions[0].description | P1 | — | guard | …∧ 账号状态（P1 账号域）=正常 ∧ (形态=短时内网映射 ⇒ 映射并发状态（P1 账号配额）≠已用尽) ∧ (形态=长期文件托管 ⇒… |
| [IF_SYS_OP7](IF_SYS_OP7) | preconditions[0].description | P1 | — | guard | …发状态（P1 账号配额）≠已用尽) ∧ (形态=长期文件托管 ⇒ 文件空间状态（P1 账号配额）≠已用尽) |

### 被其他协议引用

| 源协议 | 源接口 | 源字段 | 目标 | 类型 | 上下文 |
| --- | --- | --- | --- | --- | --- |
| P1 | IF_SYS_OP2 | outputs[0].description | — | guard | …下资源访问策略置为拒绝由补偿任务异步完成（跨协议：P2 资源域，组合层 INV-6，T_ban 内收敛） |
| P1 | IF_SYS_OP2 | postconditions[0] | — | guard | …下资源访问策略置为拒绝由补偿任务异步完成（跨协议：P2 资源域，组合层 INV-6，T_ban 内收敛） |
| P1 | IF_SYS_OP2 | sideEffects[0].description | — | guard | …下资源访问策略置为拒绝由补偿任务异步完成（跨协议：P2 资源域，组合层 INV-6，T_ban 内收敛） |

## 更多信息

- [测试用例浏览器](test-cases) — 路径覆盖度与偏差
- [验证报告对比](verification) — legacy vs impl 双跑对账
- [模型 diff / impact](diff) — 变更 → 受影响步骤/产物
- [绑定视图](bindings) — 传输绑定与错误映射
