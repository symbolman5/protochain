# P3 —— 基础设施

> 版本：**1.0.0** | 接口总数：**9**（系统 8 + 观测 1）

## 接口列表

| ID | 名称 | 类型 | schemaKind |
| --- | --- | --- | --- |
| [IF_SYS_OP1](IF_SYS_OP1) | 登记转发服务器 | 系统 | legacy-stub |
| [IF_SYS_OP2](IF_SYS_OP2) | 下线转发服务器 | 系统 | legacy-stub |
| [IF_SYS_OP3](IF_SYS_OP3) | 登记接入域名 | 系统 | legacy-stub |
| [IF_SYS_OP4](IF_SYS_OP4) | 下线接入域名 | 系统 | legacy-stub |
| [IF_SYS_OP5](IF_SYS_OP5) | 登记 / 更换域名证书 | 系统 | legacy-stub |
| [IF_SYS_OP6](IF_SYS_OP6) | 吊销域名证书 | 系统 | legacy-stub |
| [IF_SYS_OP7](IF_SYS_OP7) | 探测转发服务器健康 | 系统 | legacy-stub |
| [IF_SYS_OP8](IF_SYS_OP8) | 重算证书有效期档 | 系统 | legacy-stub |
| [IF_OBS_INV_INV-8](IF_OBS_INV_INV-8) | observe_INV-8 | 观测 | structured |

## 跨协议引用

- 引用其他协议：**0** 条
- 被其他协议引用：**3** 条

### 被其他协议引用

| 源协议 | 源接口 | 源字段 | 目标 | 类型 | 上下文 |
| --- | --- | --- | --- | --- | --- |
| P2 | IF_SYS_OP5 | outputs[0].description | — | guard | …不改状态，但系统依据状态决定代理还是拒绝（数据面兑现见 P3） |
| P2 | IF_SYS_OP5 | postconditions[1] | — | guard | …不改状态，但系统依据状态决定代理还是拒绝（数据面兑现见 P3） |
| P2 | IF_SYS_OP5 | sideEffects[1].description | — | guard | …不改状态，但系统依据状态决定代理还是拒绝（数据面兑现见 P3） |

## 更多信息

- [测试用例浏览器](test-cases) — 路径覆盖度与偏差
- [验证报告对比](verification) — legacy vs impl 双跑对账
- [模型 diff / impact](diff) — 变更 → 受影响步骤/产物
- [绑定视图](bindings) — 传输绑定与错误映射
