# 绑定视图（E11）

> 安全边界：仅展示非敏感投影子集（roles baseUrl/headers + interfaces transport + errorMap）。
> authConfig/tls 密钥段不读取。（本产物由 derive-web 机械生成；不含 authConfig.token/secret/password 等敏感字段。）

## 角色绑定

| roleId | baseUrl | auth | headers 数 |
| --- | --- | --- | --- |
| customer | https://api.shop.example.com | — | 0 |
| platform | https://api.platform.example.com | — | 0 |
| merchant | https://api.merchant.example.com | — | 0 |
| payment_gateway | https://api.pay.example.com | — | 0 |

## 接口绑定（transport）

| action | roleId | protocol | type | method | path |
| --- | --- | --- | --- | --- | --- |
| confirm_order | platform | P1 | http | POST | /v1/orders/confirm |
| start_fulfillment | merchant | P1 | http | POST | /v1/fulfillment/start |
| complete_fulfillment | merchant | P1 | http | POST | /v1/fulfillment/complete |
| refund_cancel | platform | P1 | http | POST | /v1/orders/refund-cancel |
| pay | payment_gateway | P2 | http | POST | /v2/payments |
| refund | platform | P2 | http | POST | /v2/refunds |

## 状态词表 (stateMap)

*(无)*

## 错误映射表 (errorMap)

| 错误码 | httpStatus | systemCode | bodyField | bodyFieldValue | messageField |
| --- | --- | --- | --- | --- | --- |
| ERR_ORDER_NOT_FOUND | 404 | — | code | — | — |
| ERR_STOCK_INSUFFICIENT | 409 | — | code | — | — |
| ERR_FULFILLMENT_TIMEOUT | 408 | — | code | — | — |
| ERR_PAYMENT_FAILED | 402 | — | code | — | — |
| ERR_REFUND_REJECTED | 409 | — | code | — | — |

## 缺绑错误码 (unmappedErrorCodes)

*(无 — 所有错误码均已绑定)*

## 警告

*(无)*

## 异常路径

| ID | 名称 | 错误码 |
| --- | --- | --- |
| EX1 | 履约超时 | — |
