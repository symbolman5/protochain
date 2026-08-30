# 履约协议

> 协议版本：**1.0.0** | 检阅时间：2026-08-30T14:14:23.490Z

描述订单确认、履约执行到履约完成的完整生命周期，守卫条件包含受限谓词语法命中与自然语言未命中两类样例（W2 实例载体）

## 总览

| 指标 | 值 |
| --- | --- |
| 角色数 | 3 |
| 系统接口 | 4 |
| 观测接口 | 7 |
| 测试用例 | 2 |
| 验证通过 / 失败 | 0 / 0 |

## 快速跳转

- [接口列表](interfaces/) — 11 个接口的请求/响应结构与守卫
- [测试用例浏览器](test-cases) — 路径覆盖度与偏差
- [验证报告对比](verification) — legacy vs impl 双跑对账
- [模型 diff / impact](diff) — 变更 → 受影响步骤/产物

## 状态机图（mermaid）

```mermaid
stateDiagram-v2
    S0 : S0: 已创建 (初始)
    S1 : S1: 已确认
    S2 : S2: 履约中
    S3 : S3: 已履约完成 (终态)
    S4 : S4: 已取消 (终态)
    S0 --> S1 : confirm_order[nonEmpty(order_id)]
    S1 --> S2 : start_fulfillment[库存充足且订单已确认]
    S2 --> S3 : complete_fulfillment[fulfillment_qty == order_qty]
    S2 --> S4 : refund_cancel[退款已批准 且 P2.S_refunded]
```

> 复制上述 mermaid 段落到 <https://mermaid.live> 可渲染。

## 角色

| ID | 名称 | 类型 |
| --- | --- | --- |
| customer | 顾客 | consensus |
| platform | 平台 | participant |
| merchant | 商家 | participant |

## 安全边界

- 本产物由 derive-web 机械生成；不含 authConfig.token/secret/password 等敏感字段。
- 本产物不读取 bindings.yaml；不读取进程环境变量。
- P0 范围仅只读展示；编辑能力在 P1 提供。
