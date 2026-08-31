# 回收已移除资源

> [← 返回 P2 资源发布与兑现](../P2/) | 接口 ID: `IF_SYS_OP13` | 类型: **系统** | schemaKind: **legacy-stub**

## 降级理由

- guard 表达式 "处置状态=已移除 ∧ 超过保留期" 未机械提取为 JSON Schema（未按受限谓词语法书写，显式降级不静默，R2-1）

## 输出字段

| 字段名 | 类型 | 说明 |
| --- | --- | --- |
| effects | string[] | 状态变更副作用：删除文件对象 / 清除映射实例 / 归档记录 |

## 前置条件（自然语言）

处置状态=已移除 ∧ 超过保留期

## 前置条件（结构化）

- kind=`legacy-stub`：guard 表达式含中文标点，自然语言未机械提取：处置状态=已移除 ∧ 超过保留期

## 后置条件（自然语言）

- 删除文件对象 / 清除映射实例 / 归档记录

## 后置条件（结构化）

- 删除文件对象 / 清除映射实例 / 归档记录

## 跨协议引用（与本接口相关）

### 被其他协议接口引用

| 源协议 | 源接口 | 源字段 | 类型 | 上下文 |
| --- | --- | --- | --- | --- |
| P1 | IF_SYS_OP2 | outputs[0].description | guard | …下资源访问策略置为拒绝由补偿任务异步完成（跨协议：P2 资源域，组合层 INV-6，T_ban 内收敛） |
| P1 | IF_SYS_OP2 | postconditions[0] | guard | …下资源访问策略置为拒绝由补偿任务异步完成（跨协议：P2 资源域，组合层 INV-6，T_ban 内收敛） |
| P1 | IF_SYS_OP2 | sideEffects[0].description | guard | …下资源访问策略置为拒绝由补偿任务异步完成（跨协议：P2 资源域，组合层 INV-6，T_ban 内收敛） |

## 绑定视图（E11）

> 未读取到 bindings.yaml。本段仅在 `<rootDir>/bindings.yaml` 或
> `protochain.config.yaml#bindings` 存在时填充。

非敏感投影子集（roles baseUrl/headers + interfaces transport + errorMap）：
见各接口详情页"绑定视图"段。

## 安全边界

- bindings.yaml 由 redactSensitiveFields 兜底过滤（敏感字段名整键删除）
- 仅 transport/errorMap/stateMap 入站

---

[← 返回 P2 资源发布与兑现](../P2/) | [项目总览](../../)
