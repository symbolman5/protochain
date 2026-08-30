# pay_success

> [← 返回 P2 支付协议](../P2/) | 接口 ID: `IF_SYS_T2` | 类型: **系统** | schemaKind: **legacy-stub**

## 降级理由

- guard 表达式 "支付网关回调签名校验通过" 未机械提取为 JSON Schema（未按受限谓词语法书写，显式降级不静默，R2-1）

## 输入字段

| 字段名 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| currentState | string | ✓ | 当前状态（期望为 S1）
`CAS 断言`：模型要求；impl 可容忍 currentState=="" 时取实体实际状态。 |

## 输出字段

| 字段名 | 类型 | 说明 |
| --- | --- | --- |
| nextState | string | 转移后状态（S2） |

## 前置条件（自然语言）

支付网关回调签名校验通过

## 前置条件（结构化）

- kind=`legacy-stub`：guard 表达式含中文标点，自然语言未机械提取：支付网关回调签名校验通过

## 跨协议引用（与本接口相关）

### 被其他协议接口引用

| 源协议 | 源接口 | 源字段 | 类型 | 上下文 |
| --- | --- | --- | --- | --- |
| P1 | IF_SYS_T4 | precondition | guard | 退款已批准 且 P2.S_refunded |
| P1 | IF_SYS_T4 | preconditions[0].description | guard | …点，自然语言未机械提取：退款已批准 且 P2.S_refunded |
| P1 | IF_SYS_T4 | inputs[1].description | guard | 守卫条件参数（来自 guard: 退款已批准 且 P2.S_refunded） |
| P1 | IF_SYS_T4 | inputs[2].description | guard | 守卫条件参数（来自 guard: 退款已批准 且 P2.S_refunded） |

## 绑定视图（E11）

### 传输绑定（命中本接口）

| action | roleId | protocol | type | method | path |
| --- | --- | --- | --- | --- | --- |
| (无) | — | — | — | — | — |

### 错误映射表 (errorMap) —— 本接口命中行

*(本接口 errorResponses 未命中 errorMap 任何条目 — 见下"缺绑错误码")*

### 状态词表 (stateMap) —— 项目级共享

*(无)*

### 缺绑错误码（本接口相关）

*(无 — 本接口 errorResponses 全部命中 errorMap)*

### 警告

*(无)*

### 安全边界

- bindings.yaml 由 redactSensitiveFields 兜底过滤（敏感字段名整键删除）
- 仅展示非敏感投影子集（interfaces transport + errorMap + stateMap）

---

[← 返回 P2 支付协议](../P2/) | [项目总览](../../)
