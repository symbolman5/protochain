# observe_INV2

> 接口 ID: `IF_OBS_INV_INV2` | 类型: **观测** | schemaKind: **structured**

## 请求参数 (requestSchema)

*(无)*

## 响应体 (responseSchema)

| 字段 | 类型 | 说明 | 必填 |
| --- | --- | --- | --- |
| holds | boolean | 不变量 支付幂等键唯一（INV2）当前是否成立 | ✓ |

## 后置条件 (postconditionExpressions)

- 不变量 INV2（unique(payment_id)）：谓词 unique(payment_id)：payment_id 元素唯一（uniqueItems；数据级不变量直连 E4 SQL 校验生成器）

## 关联不变量

- INV2
