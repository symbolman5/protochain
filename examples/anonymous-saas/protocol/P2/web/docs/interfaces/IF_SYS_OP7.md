# 认领资源

> 接口 ID: `IF_SYS_OP7` | 类型: **系统** | 动作类型: `state_transition` | schemaKind: **legacy-stub**

## 降级理由

- guard 表达式 "归属状态=无归属 ∧ 处置状态=正常 ∧ 认领码.兑付状态=未使用 ∧ 账号状态（P1 账号域）=正常 ∧ (形态=短时内网映射 ⇒ 映射并发状态（P1 账号配额）≠已用尽) ∧ (形态=长期文件托管 ⇒ 文件空间状态（P1 账号配额）≠已用尽)" 未机械提取为 JSON Schema（未按受限谓词语法书写，显式降级不静默，R2-1）

## 请求参数 (requestSchema)

*(无)*

## 响应体 (responseSchema)

| 字段 | 类型 | 说明 | 必填 |
| --- | --- | --- | --- |
| effects | array | 状态变更副作用：跨实体同一事务 TX2——这是 INV-2 能标 always 的唯一依据; 若拆成两步，INV-2 必须降级为 eventually_within |  |

## 前置条件 (preconditions)

- kind=`legacy-stub`：guard 表达式含中文标点，自然语言未机械提取：归属状态=无归属 ∧ 处置状态=正常 ∧ 认领码.兑付状态=未使用 ∧ 账号状态（P1 账号域）=正常 ∧ (形态=短时内网映射 ⇒ 映射并发状态（P1 账号配额）≠已用尽) ∧ (形态=长期文件托管 ⇒ 文件空间状态（P1 账号配额）≠已用尽)

## 后置条件 (postconditionExpressions)

- 跨实体同一事务 TX2——这是 INV-2 能标 always 的唯一依据
- 若拆成两步，INV-2 必须降级为 eventually_within

## 副作用描述 (postconditions)

- 跨实体同一事务 TX2——这是 INV-2 能标 always 的唯一依据
- 若拆成两步，INV-2 必须降级为 eventually_within
