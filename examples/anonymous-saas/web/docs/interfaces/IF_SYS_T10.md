# upload_file

> 接口 ID: `IF_SYS_T10` | 类型: **系统** | 动作类型: `state_transition` | schemaKind: **legacy-stub**

## 降级理由

- guard 表达式 "形态=长期文件托管 且 处置状态=正常" 未机械提取为 JSON Schema（未按受限谓词语法书写，显式降级不静默，R2-1）

## 请求参数 (requestSchema)

| 字段 | 类型 | 说明 | 必填 |
| --- | --- | --- | --- |
| currentState | string | 当前状态（期望 S1，可选枚举值: -/S0/S1/S2/S3/S4）
`CAS 断言`：状态转移前置校验（resource 实际状态 == currentState 才执行；hsk-ng Disable/Enable/Delete 走 Disable/Enable/Delete(ctx, ownerID, id, req.CurrentState)）。 | ✓ |

## 响应体 (responseSchema)

| 字段 | 类型 | 说明 | 必填 |
| --- | --- | --- | --- |
| nextState | string | 转移后状态（期望: S1，可选枚举值: S0/S1/S2/S3/S4） | ✓ |
| effects | array | 副作用：存在性=存在（专用工具上传、系统观测写入; 上传途中「记录已建、字节未完整」落于缺失档，见待确认 #23） |  |

## 前置条件 (preconditions)

- kind=`legacy-stub`：guard 表达式含中文标点，自然语言未机械提取：形态=长期文件托管 且 处置状态=正常

## 后置条件 (postconditionExpressions)

- 存在性=存在（专用工具上传、系统观测写入
- 上传途中「记录已建、字节未完整」落于缺失档，见待确认 #23）

## 副作用描述 (postconditions)

- 存在性=存在（专用工具上传、系统观测写入
- 上传途中「记录已建、字节未完整」落于缺失档，见待确认 #23）
