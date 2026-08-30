# probe_server_health

> 接口 ID: `IF_SYS_T14` | 类型: **系统** | 动作类型: `state_transition` | schemaKind: **legacy-stub**

## 降级理由

- guard 表达式 "转发服务器.在册状态=在册（跨层 guard：作用在实例上，条件看它的记录）" 未机械提取为 JSON Schema（未按受限谓词语法书写，显式降级不静默，R2-1）

## 请求参数 (requestSchema)

| 字段 | 类型 | 说明 | 必填 |
| --- | --- | --- | --- |
| currentState | string | 当前状态（期望 S0，可选枚举值: -/S0/S1/S2/S3/S4）
`CAS 断言`：状态转移前置校验（resource 实际状态 == currentState 才执行；hsk-ng Disable/Enable/Delete 走 Disable/Enable/Delete(ctx, ownerID, id, req.CurrentState)）。 | ✓ |
| guard | string | 守卫条件参数（来自 guard: 转发服务器.在册状态=在册（跨层 guard：作用在实例上，条件看它的记录））（schema 声明类型 "any" 作为描述，机械映射为 string） | ✓ |

## 响应体 (responseSchema)

| 字段 | 类型 | 说明 | 必填 |
| --- | --- | --- | --- |
| nextState | string | 转移后状态（期望: S0，可选枚举值: S0/S1/S2/S3/S4） | ✓ |
| effects | array | 副作用：服务状态=健康或降级或离线 |  |

## 前置条件 (preconditions)

- kind=`legacy-stub`：guard 表达式含中文标点，自然语言未机械提取：转发服务器.在册状态=在册（跨层 guard：作用在实例上，条件看它的记录）

## 后置条件 (postconditionExpressions)

- 服务状态=健康或降级或离线

## 副作用描述 (postconditions)

- 服务状态=健康或降级或离线
