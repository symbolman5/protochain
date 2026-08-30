# observe_INV1

> 接口 ID: `IF_OBS_INV_INV1` | 类型: **观测** | schemaKind: **structured**

## 请求参数 (requestSchema)

*(无)*

## 响应体 (responseSchema)

| 字段 | 类型 | 说明 | 必填 |
| --- | --- | --- | --- |
| holds | boolean | 不变量 履约数量一致（INV1）当前是否成立 | ✓ |

## 后置条件 (postconditionExpressions)

- 不变量 INV1（fulfillment_qty == order_qty）：谓词 fulfillment_qty == order_qty：跨字段相等（结构表达：字段必填；相等语义超出单文档 JSON Schema 范围，由不变量级校验承接）

## 关联不变量

- INV1
