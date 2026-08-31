# 携带认领码访问

> 接口 ID: `IF_SYS_OP6` | 类型: **系统** | 动作类型: `state_transition` | schemaKind: **legacy-stub**

## 降级理由

- guard 表达式 "归属状态=无归属 ∧ 处置状态=正常 ∧ 认领码.兑付状态=未使用" 未机械提取为 JSON Schema（未按受限谓词语法书写，显式降级不静默，R2-1）

## 请求参数 (requestSchema)

*(无)*

## 响应体 (responseSchema)

| 字段 | 类型 | 说明 | 必填 |
| --- | --- | --- | --- |
| effects | array | 状态变更副作用：无; 判断接口：依据状态决定进认领页还是拒绝（未登录则先引导登录） |  |

## 前置条件 (preconditions)

- kind=`legacy-stub`：guard 表达式含中文标点，自然语言未机械提取：归属状态=无归属 ∧ 处置状态=正常 ∧ 认领码.兑付状态=未使用

## 后置条件 (postconditionExpressions)

- 无
- 判断接口：依据状态决定进认领页还是拒绝（未登录则先引导登录）

## 副作用描述 (postconditions)

- 无
- 判断接口：依据状态决定进认领页还是拒绝（未登录则先引导登录）
