# 匿名发布资源

> 接口 ID: `IF_SYS_OP1` | 类型: **系统** | 动作类型: `state_transition` | schemaKind: **legacy-stub**

## 降级理由

- guard 表达式 "发布形态合法（短时内网映射 | 长期文件托管 二选一）· 无账号、无配额校验（见待确认 #1）" 未机械提取为 JSON Schema（未按受限谓词语法书写，显式降级不静默，R2-1）

## 请求参数 (requestSchema)

*(无)*

## 响应体 (responseSchema)

| 字段 | 类型 | 说明 | 必填 |
| --- | --- | --- | --- |
| effects | array | 状态变更副作用：派生 1 个认领码 |  |

## 前置条件 (preconditions)

- kind=`legacy-stub`：guard 表达式含中文标点，自然语言未机械提取：发布形态合法（短时内网映射 | 长期文件托管 二选一）· 无账号、无配额校验（见待确认 #1）

## 后置条件 (postconditionExpressions)

- 派生 1 个认领码

## 副作用描述 (postconditions)

- 派生 1 个认领码
