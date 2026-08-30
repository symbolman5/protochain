# claim_code_expire

> 接口 ID: `IF_SYS_T23` | 类型: **系统** | 动作类型: `state_transition` | schemaKind: **legacy-stub**

## 降级理由

- guard 表达式 "兑付状态=未使用 且 有效期状态=有效 且 超过有效期" 未机械提取为 JSON Schema（未按受限谓词语法书写，显式降级不静默，R2-1）

## 请求参数 (requestSchema)

| 字段 | 类型 | 说明 | 必填 |
| --- | --- | --- | --- |
| currentState | string | 当前状态（期望 S1，可选枚举值: -/S0/S1/S2/S3/S4）
`CAS 断言`：状态转移前置校验（resource 实际状态 == currentState 才执行；hsk-ng Disable/Enable/Delete 走 Disable/Enable/Delete(ctx, ownerID, id, req.CurrentState)）。 | ✓ |

## 响应体 (responseSchema)

| 字段 | 类型 | 说明 | 必填 |
| --- | --- | --- | --- |
| nextState | string | 转移后状态（期望: S1，可选枚举值: S0/S1/S2/S3/S4） | ✓ |
| effects | array | 副作用：有效期状态=已失效（未认领资源永久不可认领，见关系 资源→认领码 onGone） |  |

## 前置条件 (preconditions)

- kind=`legacy-stub`：guard 表达式含中文标点，自然语言未机械提取：兑付状态=未使用 且 有效期状态=有效 且 超过有效期

## 后置条件 (postconditionExpressions)

- 有效期状态=已失效（未认领资源永久不可认领，见关系 资源→认领码 onGone）

## 副作用描述 (postconditions)

- 有效期状态=已失效（未认领资源永久不可认领，见关系 资源→认领码 onGone）
