# 封禁用户

> 接口 ID: `IF_SYS_OP2` | 类型: **系统** | 动作类型: `state_transition` | schemaKind: **legacy-stub**

## 降级理由

- guard 表达式 "账号.账号状态=正常" 未机械提取为 JSON Schema（未按受限谓词语法书写，显式降级不静默，R2-1）

## 请求参数 (requestSchema)

*(无)*

## 响应体 (responseSchema)

| 字段 | 类型 | 说明 | 必填 |
| --- | --- | --- | --- |
| effects | array | 状态变更副作用：名下资源访问策略置为拒绝由补偿任务异步完成（跨协议：P2 资源域，组合层 INV-6，T_ban 内收敛） |  |

## 前置条件 (preconditions)

- kind=`legacy-stub`：guard 表达式含中文标点，自然语言未机械提取：账号.账号状态=正常

## 后置条件 (postconditionExpressions)

- 名下资源访问策略置为拒绝由补偿任务异步完成（跨协议：P2 资源域，组合层 INV-6，T_ban 内收敛）

## 副作用描述 (postconditions)

- 名下资源访问策略置为拒绝由补偿任务异步完成（跨协议：P2 资源域，组合层 INV-6，T_ban 内收敛）
