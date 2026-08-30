# 接口列表

> 共 11 个接口（系统 4 + 观测 7）

| ID | 名称 | 类型 | 动作类型 | schemaKind |
| --- | --- | --- | --- | --- |
| [IF_SYS_T1](IF_SYS_T1) | confirm_order | 系统 | state_transition | structured |
| [IF_SYS_T2](IF_SYS_T2) | start_fulfillment | 系统 | state_transition | legacy-stub |
| [IF_SYS_T3](IF_SYS_T3) | complete_fulfillment | 系统 | state_transition | structured |
| [IF_SYS_T4](IF_SYS_T4) | refund_cancel | 系统 | state_transition | legacy-stub |
| [IF_OBS_STATE_S0](IF_OBS_STATE_S0) | observe_已创建 | 观测 | observe | structured |
| [IF_OBS_STATE_S1](IF_OBS_STATE_S1) | observe_已确认 | 观测 | observe | structured |
| [IF_OBS_STATE_S2](IF_OBS_STATE_S2) | observe_履约中 | 观测 | observe | structured |
| [IF_OBS_STATE_S3](IF_OBS_STATE_S3) | observe_已履约完成 | 观测 | observe | structured |
| [IF_OBS_STATE_S4](IF_OBS_STATE_S4) | observe_已取消 | 观测 | observe | structured |
| [IF_OBS_INV_INV1](IF_OBS_INV_INV1) | observe_INV1 | 观测 | observe | structured |
| [IF_OBS_INV_INV2](IF_OBS_INV_INV2) | observe_INV2 | 观测 | observe | structured |
