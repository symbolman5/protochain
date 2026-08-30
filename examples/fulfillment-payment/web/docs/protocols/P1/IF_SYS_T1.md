# confirm_order

> [← 返回 P1 履约协议](../P1/) | 接口 ID: `IF_SYS_T1` | 类型: **系统** | schemaKind: **structured**

## 输入字段

| 字段名 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| order_id | string | ✓ | confirm_order 契约层请求字段（字段 order_id，类型 string） |
| currentState | string | ✓ | 当前状态（期望 S0，可选枚举值: -/S0/S1/S2/S3/S4）
`CAS 断言`：模型要求；impl 可容忍 currentState=="" 时取实体实际状态。 |

## 输出字段

| 字段名 | 类型 | 说明 |
| --- | --- | --- |
| nextState | string | 转移后状态（S1） |

## 错误响应 (errorResponses)

| ID | 错误码 | HTTP Status | bodySchema | 说明 |
| --- | --- | --- | --- | --- |
| er_order_not_found | ERR_ORDER_NOT_FOUND | 404 | — | 订单不存在或已失效 |

## 前置条件（自然语言）

nonEmpty(order_id)

## 跨协议引用（与本接口相关）

*(本接口未涉及跨协议引用)*

## 绑定视图（E11）

### 传输绑定（命中本接口）

| action | roleId | protocol | type | method | path |
| --- | --- | --- | --- | --- | --- |
| confirm_order | platform | P1 | http | POST | /v1/orders/confirm |

### 错误映射表 (errorMap) —— 本接口命中行

| 错误码 | httpStatus | systemCode | bodyField | bodyFieldValue | messageField |
| --- | --- | --- | --- | --- | --- |
| ERR_ORDER_NOT_FOUND | 404 | — | code | — | — |

### 状态词表 (stateMap) —— 项目级共享

*(无)*

### 缺绑错误码（本接口相关）

*(无 — 本接口 errorResponses 全部命中 errorMap)*

### 警告

*(无)*

### 安全边界

- bindings.yaml 由 redactSensitiveFields 兜底过滤（敏感字段名整键删除）
- 仅展示非敏感投影子集（interfaces transport + errorMap + stateMap）

---

[← 返回 P1 履约协议](../P1/) | [项目总览](../../)
