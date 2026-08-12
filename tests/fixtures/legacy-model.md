---
name: 遗留协议
version: 1.0.0
purpose: 验证遗留 model.md（无扩展字段）的迁移补全规则
roles:
  - id: operator
    name: 操作员
    responsibilities: 执行操作
  - id: system
    name: 系统
    responsibilities: 系统调度
---

# 背景

遗留协议，用于验证决策8 迁移补全规则：triggerType/trigger 从 triggerRoleId 推断，declaredBy 默认取首个共识角色，invariantClass 默认 intra_protocol。

# 核心概念

- **操作**: 操作员发起的动作

# 协作流程

操作员提交请求，系统处理后返回结果。

# 状态空间

| ID | 名称 | 类型 | 描述 | 角色 |
|---|---|---|---|---|
| S1 | 初始 | initial | 起始 | operator |
| S2 | 处理中 | normal | 系统处理 | system |
| S3 | 完成 | terminal | 终态 | operator |

# 转移规则

| ID | 名称 | from | to | action | 触发 | guard |
|---|---|---|---|---|---|---|
| T1 | 提交 | S1 | S2 | submit | operator | form_valid |
| T2 | 完成 | S2 | S3 | complete | | |

# 不变量

| ID | 名称 | 表达式 | 作用状态 |
|---|---|---|---|
| INV1 | 完整性 | S3 implies processed | S3 |

# 时序约束

| ID | 名称 | 类型 | 源 | 目标 | 约束值(ms) |
|---|---|---|---|---|---|
| TM1 | 响应时效 | response | submit | complete | 5000 |
