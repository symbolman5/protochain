# visit_with_claim_code

> 接口 ID: `IF_SYS_T9` | 类型: **系统** | 动作类型: `state_transition` | schemaKind: **legacy-stub**

## 降级理由

- guard 表达式 "归属状态=无归属 且 处置状态=正常 且 兑付状态=未使用 且 有效期状态=有效" 未机械提取为 JSON Schema（未按受限谓词语法书写，显式降级不静默，R2-1）

## 请求参数 (requestSchema)

| 字段 | 类型 | 说明 | 必填 |
| --- | --- | --- | --- |
| currentState | string | 当前状态（期望 S1，可选枚举值: -/S0/S1/S2/S3/S4）
`CAS 断言`：状态转移前置校验（resource 实际状态 == currentState 才执行；hsk-ng Disable/Enable/Delete 走 Disable/Enable/Delete(ctx, ownerID, id, req.CurrentState)）。 | ✓ |

## 响应体 (responseSchema)

| 字段 | 类型 | 说明 | 必填 |
| --- | --- | --- | --- |
| nextState | string | 转移后状态（期望: S1，可选枚举值: S0/S1/S2/S3/S4） | ✓ |
| effects | array | 副作用：无。判断接口：依据状态决定进认领页还是拒绝（未登录则先引导登录） |  |

## 前置条件 (preconditions)

- kind=`legacy-stub`：guard 表达式含中文标点，自然语言未机械提取：归属状态=无归属 且 处置状态=正常 且 兑付状态=未使用 且 有效期状态=有效

## 后置条件 (postconditionExpressions)

- 无。判断接口：依据状态决定进认领页还是拒绝（未登录则先引导登录）

## 副作用描述 (postconditions)

- 无。判断接口：依据状态决定进认领页还是拒绝（未登录则先引导登录）
