# publish_resource

> 接口 ID: `IF_SYS_T1` | 类型: **系统** | 动作类型: `state_transition` | schemaKind: **legacy-stub**

## 降级理由

- guard 表达式 "发布形态合法（短时内网映射 或 长期文件托管 二选一）；无账号、无配额校验（配额校验在认领时，见待确认 #1）" 未机械提取为 JSON Schema（未按受限谓词语法书写，显式降级不静默，R2-1）

## 请求参数 (requestSchema)

| 字段 | 类型 | 说明 | 必填 |
| --- | --- | --- | --- |
| currentState | string | 当前状态（期望 S0，可选枚举值: -/S0/S1/S2/S3/S4）
`CAS 断言`：状态转移前置校验（resource 实际状态 == currentState 才执行；hsk-ng Disable/Enable/Delete 走 Disable/Enable/Delete(ctx, ownerID, id, req.CurrentState)）。 | ✓ |

## 响应体 (responseSchema)

| 字段 | 类型 | 说明 | 必填 |
| --- | --- | --- | --- |
| nextState | string | 转移后状态（期望: S1，可选枚举值: S0/S1/S2/S3/S4） | ✓ |
| effects | array | 副作用：新建资源记录（归属状态=无归属，处置状态=正常，访问策略=拒绝，审核状态=待审）; 派生 1 个认领码（兑付状态=未使用） |  |

## 前置条件 (preconditions)

- kind=`legacy-stub`：guard 表达式含中文标点，自然语言未机械提取：发布形态合法（短时内网映射 或 长期文件托管 二选一）；无账号、无配额校验（配额校验在认领时，见待确认 #1）

## 后置条件 (postconditionExpressions)

- 新建资源记录（归属状态=无归属，处置状态=正常，访问策略=拒绝，审核状态=待审）
- 派生 1 个认领码（兑付状态=未使用）

## 副作用描述 (postconditions)

- 新建资源记录（归属状态=无归属，处置状态=正常，访问策略=拒绝，审核状态=待审）
- 派生 1 个认领码（兑付状态=未使用）
