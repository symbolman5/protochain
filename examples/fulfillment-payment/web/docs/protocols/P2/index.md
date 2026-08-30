# P2 —— 支付协议

> 版本：**1.0.0** | 接口总数：**12**（系统 4 + 观测 8）

## 接口列表

| ID | 名称 | 类型 | schemaKind |
| --- | --- | --- | --- |
| [IF_SYS_T1](IF_SYS_T1) | pay | 系统 | structured |
| [IF_SYS_T2](IF_SYS_T2) | pay_success | 系统 | legacy-stub |
| [IF_SYS_T3](IF_SYS_T3) | pay_failed | 系统 | legacy-stub |
| [IF_SYS_T4](IF_SYS_T4) | refund | 系统 | structured |
| [IF_OBS_STATE_S0](IF_OBS_STATE_S0) | observe_待支付 | 观测 | structured |
| [IF_OBS_STATE_S1](IF_OBS_STATE_S1) | observe_支付中 | 观测 | structured |
| [IF_OBS_STATE_S2](IF_OBS_STATE_S2) | observe_已支付 | 观测 | structured |
| [IF_OBS_STATE_S3](IF_OBS_STATE_S3) | observe_已退款 | 观测 | structured |
| [IF_OBS_STATE_S4](IF_OBS_STATE_S4) | observe_支付失败 | 观测 | structured |
| [IF_OBS_INV_INV1](IF_OBS_INV_INV1) | observe_INV1 | 观测 | structured |
| [IF_OBS_INV_INV2](IF_OBS_INV_INV2) | observe_INV2 | 观测 | structured |
| [IF_OBS_INV_INV3](IF_OBS_INV_INV3) | observe_INV3 | 观测 | structured |

## 跨协议引用

- 引用其他协议：**0** 条
- 被其他协议引用：**4** 条

### 被其他协议引用

| 源协议 | 源接口 | 源字段 | 目标 | 类型 | 上下文 |
| --- | --- | --- | --- | --- | --- |
| P1 | IF_SYS_T4 | precondition | S_refunded | guard | 退款已批准 且 P2.S_refunded |
| P1 | IF_SYS_T4 | preconditions[0].description | S_refunded | guard | …点，自然语言未机械提取：退款已批准 且 P2.S_refunded |
| P1 | IF_SYS_T4 | inputs[1].description | S_refunded | guard | 守卫条件参数（来自 guard: 退款已批准 且 P2.S_refunded） |
| P1 | IF_SYS_T4 | inputs[2].description | S_refunded | guard | 守卫条件参数（来自 guard: 退款已批准 且 P2.S_refunded） |

## 更多信息

- [测试用例浏览器](test-cases) — 路径覆盖度与偏差
- [验证报告对比](verification) — legacy vs impl 双跑对账
- [模型 diff / impact](diff) — 变更 → 受影响步骤/产物
- [绑定视图](bindings) — 传输绑定与错误映射
