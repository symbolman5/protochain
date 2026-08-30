# observe_已确认

> [← 返回 P1 履约协议](../P1/) | 接口 ID: `IF_OBS_STATE_S1` | 类型: **观测** | schemaKind: **structured**

## 输出字段

| 字段名 | 类型 | 说明 |
| --- | --- | --- |
| isInState | boolean | 当前是否处于 已确认（S1）状态 |

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
