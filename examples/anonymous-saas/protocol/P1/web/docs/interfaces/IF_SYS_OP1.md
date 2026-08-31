# 登录

> 接口 ID: `IF_SYS_OP1` | 类型: **系统** | 动作类型: `state_transition` | schemaKind: **legacy-stub**

## 降级理由

- guard 表达式 "账号.账号状态=正常" 未机械提取为 JSON Schema（未按受限谓词语法书写，显式降级不静默，R2-1）

## 请求参数 (requestSchema)

*(无)*

## 响应体 (responseSchema)

| 字段 | 类型 | 说明 | 必填 |
| --- | --- | --- | --- |
| effects | array | 状态变更副作用：签发登录会话（凭证：登录会话，可本地验证） |  |

## 前置条件 (preconditions)

- kind=`legacy-stub`：guard 表达式含中文标点，自然语言未机械提取：账号.账号状态=正常

## 后置条件 (postconditionExpressions)

- 签发登录会话（凭证：登录会话，可本地验证）

## 副作用描述 (postconditions)

- 签发登录会话（凭证：登录会话，可本地验证）
