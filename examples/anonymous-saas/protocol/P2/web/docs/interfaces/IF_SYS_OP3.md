# 结束运行 / 断开

> 接口 ID: `IF_SYS_OP3` | 类型: **系统** | 动作类型: `state_transition` | schemaKind: **legacy-stub**

## 降级理由

- guard 表达式 "连接状态=在线" 未机械提取为 JSON Schema（未按受限谓词语法书写，显式降级不静默，R2-1）

## 请求参数 (requestSchema)

*(无)*

## 响应体 (responseSchema)

| 字段 | 类型 | 说明 | 必填 |
| --- | --- | --- | --- |
| effects | array | 状态变更副作用：并发占用随后释放（见 INV-5） |  |

## 前置条件 (preconditions)

- kind=`legacy-stub`：guard 表达式含中文标点，自然语言未机械提取：连接状态=在线

## 后置条件 (postconditionExpressions)

- 并发占用随后释放（见 INV-5）

## 副作用描述 (postconditions)

- 并发占用随后释放（见 INV-5）
