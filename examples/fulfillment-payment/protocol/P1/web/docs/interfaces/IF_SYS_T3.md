# complete_fulfillment

> 接口 ID: `IF_SYS_T3` | 类型: **系统** | 动作类型: `state_transition` | schemaKind: **structured**

## 请求参数 (requestSchema)

| 字段 | 类型 | 说明 | 必填 |
| --- | --- | --- | --- |
| fulfillment_qty | integer |  | ✓ |
| order_qty | integer |  | ✓ |
| currentState | string | 当前状态（期望 S2，可选枚举值: -/S0/S1/S2/S3/S4）
`CAS 断言`：状态转移前置校验（resource 实际状态 == currentState 才执行；hsk-ng Disable/Enable/Delete 走 Disable/Enable/Delete(ctx, ownerID, id, req.CurrentState)）。 | ✓ |

## 响应体 (responseSchema)

| 字段 | 类型 | 说明 | 必填 |
| --- | --- | --- | --- |
| nextState | string | 转移后状态（期望: S3，可选枚举值: S0/S1/S2/S3/S4） | ✓ |

## 错误响应 (errorResponses)

| ID | 错误码 | HTTP Status | bodySchema | 说明 |
| --- | --- | --- | --- | --- |
| er_stock_insufficient | ERR_STOCK_INSUFFICIENT | 409 | — | 库存不足，无法开始履约 |
| er_fulfillment_timeout | ERR_FULFILLMENT_TIMEOUT | 408 | — | 履约超时未完成 |
