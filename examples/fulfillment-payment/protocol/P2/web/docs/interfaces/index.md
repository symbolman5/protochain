# 接口列表

> 共 12 个接口（系统 4 + 观测 8）

| ID | 名称 | 类型 | 动作类型 | schemaKind |
| --- | --- | --- | --- | --- |
| [IF_SYS_T1](IF_SYS_T1) | pay | 系统 | state_transition | structured |
| [IF_SYS_T2](IF_SYS_T2) | pay_success | 系统 | state_transition | legacy-stub |
| [IF_SYS_T3](IF_SYS_T3) | pay_failed | 系统 | state_transition | legacy-stub |
| [IF_SYS_T4](IF_SYS_T4) | refund | 系统 | state_transition | structured |
| [IF_OBS_STATE_S0](IF_OBS_STATE_S0) | observe_待支付 | 观测 | observe | structured |
| [IF_OBS_STATE_S1](IF_OBS_STATE_S1) | observe_支付中 | 观测 | observe | structured |
| [IF_OBS_STATE_S2](IF_OBS_STATE_S2) | observe_已支付 | 观测 | observe | structured |
| [IF_OBS_STATE_S3](IF_OBS_STATE_S3) | observe_已退款 | 观测 | observe | structured |
| [IF_OBS_STATE_S4](IF_OBS_STATE_S4) | observe_支付失败 | 观测 | observe | structured |
| [IF_OBS_INV_INV1](IF_OBS_INV_INV1) | observe_INV1 | 观测 | observe | structured |
| [IF_OBS_INV_INV2](IF_OBS_INV_INV2) | observe_INV2 | 观测 | observe | structured |
| [IF_OBS_INV_INV3](IF_OBS_INV_INV3) | observe_INV3 | 观测 | observe | structured |
