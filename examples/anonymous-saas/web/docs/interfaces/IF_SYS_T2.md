# review_resource

> 接口 ID: `IF_SYS_T2` | 类型: **系统** | 动作类型: `state_transition` | schemaKind: **legacy-stub**

## 降级理由

- guard 表达式 "审核状态=待审" 未机械提取为 JSON Schema（未按受限谓词语法书写，显式降级不静默，R2-1）

## 请求参数 (requestSchema)

| 字段 | 类型 | 说明 | 必填 |
| --- | --- | --- | --- |
| currentState | string | 当前状态（期望 S1，可选枚举值: -/S0/S1/S2/S3/S4）
`CAS 断言`：状态转移前置校验（resource 实际状态 == currentState 才执行；hsk-ng Disable/Enable/Delete 走 Disable/Enable/Delete(ctx, ownerID, id, req.CurrentState)）。 | ✓ |

## 响应体 (responseSchema)

| 字段 | 类型 | 说明 | 必填 |
| --- | --- | --- | --- |
| nextState | string | 转移后状态（期望: S1，可选枚举值: S0/S1/S2/S3/S4） | ✓ |
| effects | array | 副作用：审核状态=通过或违规（仅一个维度、无独立审核记录，留痕见待确认 #8） |  |

## 前置条件 (preconditions)

- kind=`legacy-stub`：guard 表达式含中文标点，自然语言未机械提取：审核状态=待审

## 后置条件 (postconditionExpressions)

- 审核状态=通过或违规（仅一个维度、无独立审核记录，留痕见待确认 #8）

## 副作用描述 (postconditions)

- 审核状态=通过或违规（仅一个维度、无独立审核记录，留痕见待确认 #8）
