# 登录

> [← 返回 P1 账号域](../P1/) | 接口 ID: `IF_SYS_OP1` | 类型: **系统** | schemaKind: **legacy-stub**

## 降级理由

- guard 表达式 "账号.账号状态=正常" 未机械提取为 JSON Schema（未按受限谓词语法书写，显式降级不静默，R2-1）

## 输出字段

| 字段名 | 类型 | 说明 |
| --- | --- | --- |
| effects | string[] | 状态变更副作用：签发登录会话（凭证：登录会话，可本地验证） |

## 前置条件（自然语言）

账号.账号状态=正常

## 前置条件（结构化）

- kind=`legacy-stub`：guard 表达式含中文标点，自然语言未机械提取：账号.账号状态=正常

## 后置条件（自然语言）

- 签发登录会话（凭证：登录会话，可本地验证）

## 后置条件（结构化）

- 签发登录会话（凭证：登录会话，可本地验证）

## 跨协议引用（与本接口相关）

### 被其他协议接口引用

| 源协议 | 源接口 | 源字段 | 类型 | 上下文 |
| --- | --- | --- | --- | --- |
| P2 | IF_SYS_OP7 | precondition | guard | … 认领码.兑付状态=未使用 ∧ 账号状态（P1 账号域）=正常 ∧ (形态=短时内网映射 ⇒ 映… |
| P2 | IF_SYS_OP7 | precondition | guard | …∧ 账号状态（P1 账号域）=正常 ∧ (形态=短时内网映射 ⇒ 映射并发状态（P1 账号配额）≠已用尽) ∧ (形态=长期文件托管 ⇒… |
| P2 | IF_SYS_OP7 | precondition | guard | …发状态（P1 账号配额）≠已用尽) ∧ (形态=长期文件托管 ⇒ 文件空间状态（P1 账号配额）≠已用尽) |
| P2 | IF_SYS_OP7 | preconditions[0].description | guard | … 认领码.兑付状态=未使用 ∧ 账号状态（P1 账号域）=正常 ∧ (形态=短时内网映射 ⇒ 映… |
| P2 | IF_SYS_OP7 | preconditions[0].description | guard | …∧ 账号状态（P1 账号域）=正常 ∧ (形态=短时内网映射 ⇒ 映射并发状态（P1 账号配额）≠已用尽) ∧ (形态=长期文件托管 ⇒… |
| P2 | IF_SYS_OP7 | preconditions[0].description | guard | …发状态（P1 账号配额）≠已用尽) ∧ (形态=长期文件托管 ⇒ 文件空间状态（P1 账号配额）≠已用尽) |

## 绑定视图（E11）

> 未读取到 bindings.yaml。本段仅在 `<rootDir>/bindings.yaml` 或
> `protochain.config.yaml#bindings` 存在时填充。

非敏感投影子集（roles baseUrl/headers + interfaces transport + errorMap）：
见各接口详情页"绑定视图"段。

## 安全边界

- bindings.yaml 由 redactSensitiveFields 兜底过滤（敏感字段名整键删除）
- 仅 transport/errorMap/stateMap 入站

---

[← 返回 P1 账号域](../P1/) | [项目总览](../../)
