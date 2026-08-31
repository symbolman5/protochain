# 匿名发布+认领的公网资源 SaaS

> 协议版本：**1.0.0** | 检阅时间：2026-08-31T17:04:46.102Z

描述匿名发布 + 认领的公网资源 SaaS 的完整协作规则：专用工具匿名发布资源（短时内网映射 / 长期文件托管），匿名访问者凭公网地址访问或带码进入认领流程，账号持有者认领资源成为归属人，运营审查封禁，运维管理服务器与证书，系统自身承担调度与观测。本文件为六张清单形态（操作=改实体维度、无状态机段、实体维度带 kind 断言），数据源为 model-lab/model.js

## 总览

| 指标 | 值 |
| --- | --- |
| 角色数 | 6 |
| 系统接口 | 24 |
| 观测接口 | 11 |
| 测试用例 | 0 |
| 验证通过 / 失败 | 0 / 0 |

## 快速跳转

- [接口列表](interfaces/) — 35 个接口的请求/响应结构与守卫
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
| publisher_tool | 专用工具（发布端） | participant |
| anonymous_visitor | 匿名访问者 | participant |
| account_holder | 账号持有者（认领者） | participant |
| operator | 运营人员 | participant |
| ops | 运维人员 | participant |
| system | 系统自身（调度与观测） | consensus |

## 安全边界

- 本产物由 derive-web 机械生成；不含 authConfig.token/secret/password 等敏感字段。
- 本产物不读取 bindings.yaml；不读取进程环境变量。
- P0 范围仅只读展示；编辑能力在 P1 提供。
