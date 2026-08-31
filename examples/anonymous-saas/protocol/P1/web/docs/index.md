# 账号域

> 协议版本：**1.0.0** | 检阅时间：2026-08-30T17:53:07.974Z

匿名 SaaS 多协议拆分（R3b）· P1 账号域：账号、账号配额、登录会话凭证。本子协议自包含六张清单（操作=改实体维度、无状态机段、实体维度带 kind 断言）；跨协议约束（配额与资源占用 INV-3/4、封禁连带 INV-6）走组合层 protocol/composition.md

## 总览

| 指标 | 值 |
| --- | --- |
| 角色数 | 3 |
| 系统接口 | 3 |
| 观测接口 | 0 |
| 测试用例 | 0 |
| 验证通过 / 失败 | 0 / 0 |

## 快速跳转

- [接口列表](interfaces/) — 3 个接口的请求/响应结构与守卫
- [测试用例浏览器](test-cases) — 路径覆盖度与偏差
- [验证报告对比](verification) — legacy vs impl 双跑对账
- [模型 diff / impact](diff) — 变更 → 受影响步骤/产物

## 状态机图（mermaid）

```mermaid
stateDiagram-v2
```

> 复制上述 mermaid 段落到 <https://mermaid.live> 可渲染。

## 角色

| ID | 名称 | 类型 |
| --- | --- | --- |
| account_holder | 账号持有者（认领者） | participant |
| system | 系统自身（调度与观测） | consensus |
| operator | 运营人员 | participant |

## 安全边界

- 本产物由 derive-web 机械生成；不含 authConfig.token/secret/password 等敏感字段。
- 本产物不读取 bindings.yaml；不读取进程环境变量。
- P0 范围仅只读展示；编辑能力在 P1 提供。
