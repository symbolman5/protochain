---
name: 审批流协议
version: 1.0.0
purpose: 规范申请人提交审批请求、审批人审批的协作流程，确保审批结果可追溯且满足时效约束
roles:
  - id: applicant
    name: 申请人
    responsibilities: 发起审批请求、补充材料、查阅结果
  - id: approver
    name: 审批人
    responsibilities: 审阅请求、做出审批决定
  - id: system
    name: 系统
    responsibilities: 记录状态、执行超时退回
---

# 背景

审批流是企业协作中最常见的流程之一。传统审批流常出现两类问题：一是状态不清晰导致申请人不知等待什么；二是超时处理缺失导致请求长期挂起。本协议用状态机显式定义审批协作，并引入超时退回机制保证流程活性。

# 核心概念

- **审批请求**: 申请人提交的待审批事项，包含表单与附件
- **审批状态**: 请求在协作流程中所处的阶段
- **超时退回**: 审批人在约定时限内未决策时，系统自动将请求退回申请人

# 协作流程

申请人填写表单后提交审批请求，请求进入"待审批"状态。审批人审阅后做出通过或驳回决定：通过则请求进入"已通过"终态；驳回则进入"已驳回"终态。若审批人在 24 小时内未决策，系统自动退回请求，请求回到"草稿"状态供申请人修改重提。

# 异常处理原则

超时视为异常路径，由系统主动触发退回，不阻塞流程。申请人撤回的请求进入"已撤回"终态，不可恢复。

# 状态空间

| ID | 名称 | 类型 | 描述 | 角色 |
|---|---|---|---|---|
| S1 | 草稿 | initial | 申请人编辑中 | applicant |
| S2 | 待审批 | normal | 等待审批人决策 | approver |
| S3 | 已通过 | terminal | 审批通过 | |
| S4 | 已驳回 | terminal | 审批驳回 | |
| S5 | 已撤回 | terminal | 申请人主动撤回 | |

# 转移规则

| ID | 名称 | from | to | action | trigger | guard | effects |
|---|---|---|---|---|---|---|---|
| T1 | 提交 | S1 | S2 | submit | applicant | form_valid | create_request;notify_approver |
| T2 | 通过 | S2 | S3 | approve | approver | has_request | record_approved;notify_applicant |
| T3 | 驳回 | S2 | S4 | reject | approver | has_request | record_rejected;notify_applicant |
| T4 | 撤回 | S2 | S5 | withdraw | applicant | has_request | record_withdrawn |
| T5 | 超时退回 | S2 | S1 | timeout_return | system | deadline_exceeded | reset_request;notify_applicant |

# 不变量

| ID | 名称 | 表达式 | 作用状态 | 描述 |
|---|---|---|---|---|
| INV1 | 请求唯一性 | forall r: count(active_requests(r)) <= 1 | | 同一申请人同时只能有一个活动请求 |
| INV2 | 终态不可逆 | forall t: t.from not in {S3, S4, S5} | | 终态不能作为转移的源状态 |

# 时序约束

| ID | 名称 | 类型 | 源 | 目标 | 约束值(ms) | 描述 |
|---|---|---|---|---|---|---|
| TM1 | 审批超时 | timeout | submit | approve | 86400000 | 提交后24小时内须完成审批 |
| TM2 | 退回响应 | response | timeout_return | submit | 3600000 | 退回后1小时内申请人可重新提交 |

# 异常路径

| ID | 名称 | 触发 | 转移序列 | 恢复策略 |
|---|---|---|---|---|
| EX1 | 审批超时退回 | TM1 触发 | T1,T5 | 退回申请人修改后重新提交 |
| EX2 | 申请人撤回 | 申请人主动撤回 | T4 | 流程终止，不可恢复 |

# 契约层

```yaml
parties:
  - applicant
  - approver
  - system
expectedInformationFields:
  - request_form
  - approval_result
  - notification
```
