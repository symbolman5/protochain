# claim_resource

> 接口 ID: `IF_SYS_T3` | 类型: **系统** | 动作类型: `state_transition` | schemaKind: **legacy-stub**

## 降级理由

- guard 表达式 "归属状态=无归属 且 处置状态=正常 且 兑付状态=未使用 且 有效期状态=有效 且 账号状态=正常 且（形态=短时内网映射 → 映射并发状态≠已用尽）且（形态=长期文件托管 → 文件空间状态≠已用尽）" 未机械提取为 JSON Schema（未按受限谓词语法书写，显式降级不静默，R2-1）

## 请求参数 (requestSchema)

| 字段 | 类型 | 说明 | 必填 |
| --- | --- | --- | --- |
| currentState | string | 当前状态（期望 S1，可选枚举值: -/S0/S1/S2/S3/S4）
`CAS 断言`：状态转移前置校验（resource 实际状态 == currentState 才执行；hsk-ng Disable/Enable/Delete 走 Disable/Enable/Delete(ctx, ownerID, id, req.CurrentState)）。 | ✓ |

## 响应体 (responseSchema)

| 字段 | 类型 | 说明 | 必填 |
| --- | --- | --- | --- |
| nextState | string | 转移后状态（期望: S2，可选枚举值: S0/S1/S2/S3/S4） | ✓ |
| effects | array | 副作用：归属状态=已认领; 访问策略=放行; 兑付状态=已使用。跨实体同一事务（事务边界 TX2）——这是 INV-2 能标 always 的唯一依据 |  |

## 前置条件 (preconditions)

- kind=`legacy-stub`：guard 表达式含中文标点，自然语言未机械提取：归属状态=无归属 且 处置状态=正常 且 兑付状态=未使用 且 有效期状态=有效 且 账号状态=正常 且（形态=短时内网映射 → 映射并发状态≠已用尽）且（形态=长期文件托管 → 文件空间状态≠已用尽）

## 后置条件 (postconditionExpressions)

- 归属状态=已认领
- 访问策略=放行
- 兑付状态=已使用。跨实体同一事务（事务边界 TX2）——这是 INV-2 能标 always 的唯一依据

## 副作用描述 (postconditions)

- 归属状态=已认领
- 访问策略=放行
- 兑付状态=已使用。跨实体同一事务（事务边界 TX2）——这是 INV-2 能标 always 的唯一依据
