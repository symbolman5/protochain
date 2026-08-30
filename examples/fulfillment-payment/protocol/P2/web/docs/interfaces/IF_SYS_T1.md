# pay

> 接口 ID: `IF_SYS_T1` | 类型: **系统** | 动作类型: `state_transition` | schemaKind: **structured**

## 请求参数 (requestSchema)

| 字段 | 类型 | 说明 | 必填 |
| --- | --- | --- | --- |
| amount | number |  | ✓ |
| currentState | string | 当前状态（期望 S0，可选枚举值: -/S0/S1/S2/S3/S4）
`CAS 断言`：状态转移前置校验（resource 实际状态 == currentState 才执行；hsk-ng Disable/Enable/Delete 走 Disable/Enable/Delete(ctx, ownerID, id, req.CurrentState)）。 | ✓ |

## 响应体 (responseSchema)

| 字段 | 类型 | 说明 | 必填 |
| --- | --- | --- | --- |
| nextState | string | 转移后状态（期望: S1，可选枚举值: S0/S1/S2/S3/S4） | ✓ |
