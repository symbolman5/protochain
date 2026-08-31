# 探测转发服务器健康

> [← 返回 P3 基础设施](../P3/) | 接口 ID: `IF_SYS_OP7` | 类型: **系统** | schemaKind: **legacy-stub**

## 降级理由

- guard 表达式 "转发服务器.在册状态=在册（跨层 guard：作用在实例上，条件看它的记录）" 未机械提取为 JSON Schema（未按受限谓词语法书写，显式降级不静默，R2-1）

## 前置条件（自然语言）

转发服务器.在册状态=在册（跨层 guard：作用在实例上，条件看它的记录）

## 前置条件（结构化）

- kind=`legacy-stub`：guard 表达式含中文标点，自然语言未机械提取：转发服务器.在册状态=在册（跨层 guard：作用在实例上，条件看它的记录）

## 跨协议引用（与本接口相关）

### 被其他协议接口引用

| 源协议 | 源接口 | 源字段 | 类型 | 上下文 |
| --- | --- | --- | --- | --- |
| P2 | IF_SYS_OP5 | outputs[0].description | guard | …不改状态，但系统依据状态决定代理还是拒绝（数据面兑现见 P3） |
| P2 | IF_SYS_OP5 | postconditions[1] | guard | …不改状态，但系统依据状态决定代理还是拒绝（数据面兑现见 P3） |
| P2 | IF_SYS_OP5 | sideEffects[1].description | guard | …不改状态，但系统依据状态决定代理还是拒绝（数据面兑现见 P3） |

## 绑定视图（E11）

> 未读取到 bindings.yaml。本段仅在 `<rootDir>/bindings.yaml` 或
> `protochain.config.yaml#bindings` 存在时填充。

非敏感投影子集（roles baseUrl/headers + interfaces transport + errorMap）：
见各接口详情页"绑定视图"段。

## 安全边界

- bindings.yaml 由 redactSensitiveFields 兜底过滤（敏感字段名整键删除）
- 仅 transport/errorMap/stateMap 入站

---

[← 返回 P3 基础设施](../P3/) | [项目总览](../../)
