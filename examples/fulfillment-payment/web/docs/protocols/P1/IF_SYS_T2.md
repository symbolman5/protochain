# start_fulfillment

> [← 返回 P1 履约协议](../P1/) | 接口 ID: `IF_SYS_T2` | 类型: **系统** | schemaKind: **legacy-stub**

## 降级理由

- guard 表达式 "库存充足且订单已确认" 未机械提取为 JSON Schema（未按受限谓词语法书写，显式降级不静默，R2-1）

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

库存充足且订单已确认

## 前置条件（结构化）

- kind=`legacy-stub`：guard 表达式含中文标点，自然语言未机械提取：库存充足且订单已确认

## 跨协议引用（与本接口相关）

*(本接口未涉及跨协议引用)*

## 绑定视图（E11）

### 传输绑定（命中本接口）

| action | roleId | protocol | type | method | path |
| --- | --- | --- | --- | --- | --- |
| start_fulfillment | merchant | P1 | http | POST | /v1/fulfillment/start |

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

[← 返回 P1 履约协议](../P1/) | [项目总览](../../)
