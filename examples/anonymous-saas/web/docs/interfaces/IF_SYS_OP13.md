# 登记转发服务器

> 接口 ID: `IF_SYS_OP13` | 类型: **系统** | 动作类型: `state_transition` | schemaKind: **legacy-stub**

## 降级理由

- guard 表达式 "（新建登记，无既有状态 guard）" 未机械提取为 JSON Schema（未按受限谓词语法书写，显式降级不静默，R2-1）

## 请求参数 (requestSchema)

*(无)*

## 响应体 (responseSchema)

*(无)*

## 前置条件 (preconditions)

- kind=`legacy-stub`：guard 表达式含中文标点，自然语言未机械提取：（新建登记，无既有状态 guard）
