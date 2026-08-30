# 匿名发布+认领的公网资源 SaaS

> 协议版本：**1.0.0** | 检阅时间：2026-08-30T15:13:57.023Z

描述匿名发布 + 认领的公网资源 SaaS 的完整协作规则：专用工具匿名发布资源（短时内网映射 / 长期文件托管），匿名访问者凭公网地址访问或带码进入认领流程，账号持有者认领资源成为归属人，运营审查封禁，运维管理服务器与证书，系统自身承担调度与观测

## 总览

| 指标 | 值 |
| --- | --- |
| 角色数 | 6 |
| 系统接口 | 24 |
| 观测接口 | 16 |
| 测试用例 | 55 |
| 验证通过 / 失败 | 0 / 0 |

## 快速跳转

- [接口列表](interfaces/) — 40 个接口的请求/响应结构与守卫
- [测试用例浏览器](test-cases) — 路径覆盖度与偏差
- [验证报告对比](verification) — legacy vs impl 双跑对账
- [模型 diff / impact](diff) — 变更 → 受影响步骤/产物

## 状态机图（mermaid）

```mermaid
stateDiagram-v2
    S0 : S0: 未发布 (初始)
    S1 : S1: 已发布
    S2 : S2: 已认领
    S3 : S3: 已封禁 (终态)
    S4 : S4: 已移除 (终态)
    S0 --> S1 : publish_resource[发布形态合法（短时内网映射 或 长期文件托管 二选一）；无账号、无配额校验（配额校验在认领时，见待确认 #1）]
    S1 --> S1 : review_resource[审核状态=待审]
    S1 --> S2 : claim_resource[归属状态=无归属 且 处置状态=正常 且 兑付状态=未使用 且 有效期状态=有效 且 账号状态=正常 且（形态=短时内网映射 → 映射并发状态≠已用尽）且（形态=长期文件托管 → 文件空间状态≠已用尽）]
    S2 --> S4 : remove_resource[处置状态≠已移除]
    S1 --> S3 : ban_resource[审核状态=违规]
    S2 --> S3 : ban_resource[审核状态=违规]
    S2 --> S2 : ban_user[账号状态=正常]
    S1 --> S1 : login[账号状态=正常]
    S2 --> S2 : request_access[访问策略=放行 且 处置状态=正常]
    S1 --> S1 : visit_with_claim_code[归属状态=无归属 且 处置状态=正常 且 兑付状态=未使用 且 有效期状态=有效]
    S1 --> S1 : upload_file[形态=长期文件托管 且 处置状态=正常]
    S2 --> S2 : report_heartbeat[形态=短时内网映射 且 处置状态=正常]
    S2 --> S2 : disconnect_mapping[连接状态=在线]
    S2 --> S2 : heartbeat_timeout[连接状态=在线 且 超过 T_hb 未收到心跳]
    S0 --> S0 : probe_server_health[转发服务器.在册状态=在册（跨层 guard：作用在实例上，条件看它的记录）]
    S0 --> S0 : register_server[新建登记（无既有状态 guard）]
    S0 --> S0 : deregister_server[在册状态=在册]
    S0 --> S0 : register_domain[新建登记（无既有状态 guard）]
    S0 --> S0 : deregister_domain[在册状态=在册]
    S0 --> S0 : register_cert[接入域名.在册状态=在册]
    S0 --> S0 : revoke_cert[域名覆盖=已覆盖]
    S0 --> S0 : recalc_quota[周期性全量重算]
    S0 --> S0 : recalc_cert_validity[周期性巡检]
    S1 --> S1 : claim_code_expire[兑付状态=未使用 且 有效期状态=有效 且 超过有效期]
    S4 --> S4 : recycle_removed[处置状态=已移除 且 超过保留期]
```

> 复制上述 mermaid 段落到 <https://mermaid.live> 可渲染。

## 角色

| ID | 名称 | 类型 |
| --- | --- | --- |
| publisher_tool | 专用工具（发布端） | participant |
| anonymous_visitor | 匿名访问者 | participant |
| account_holder | 账号持有者（认领者） | participant |
| operator | 运营人员 | participant |
| ops | 运维人员 | participant |
| system | 系统自身（调度与观测） | consensus |

## 安全边界

- 本产物由 derive-web 机械生成；不含 authConfig.token/secret/password 等敏感字段。
- 本产物不读取 bindings.yaml；不读取进程环境变量。
- P0 范围仅只读展示；编辑能力在 P1 提供。
