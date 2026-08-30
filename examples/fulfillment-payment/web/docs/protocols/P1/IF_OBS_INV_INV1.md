# observe_INV1

> [← 返回 P1 履约协议](../P1/) | 接口 ID: `IF_OBS_INV_INV1` | 类型: **观测** | schemaKind: **structured**

## 输出字段

| 字段名 | 类型 | 说明 |
| --- | --- | --- |
| holds | boolean | 不变量 履约数量一致（INV1）当前是否成立 |

## 后置条件（结构化）

- 不变量 INV1（fulfillment_qty == order_qty）：谓词 fulfillment_qty == order_qty：跨字段相等（结构表达：字段必填；相等语义超出单文档 JSON Schema 范围，由不变量级校验承接）

## 关联不变量

- INV1

## 跨协议引用（与本接口相关）

*(本接口未涉及跨协议引用)*

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

[← 返回 P1 履约协议](../P1/) | [项目总览](../../)
