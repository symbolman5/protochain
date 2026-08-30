# 模型 diff / impact

> 摘要：元数据 2 项变更；可读层 3 项变更；可推演层 1 项变更
> 差分时间：2026-08-25T09:41:16.069Z

## 元数据层变更

| 路径 | 类型 | 旧值 | 新值 |
| --- | --- | --- | --- |
| metadata.version | modified | 1.0.0 | 1.1.0 |
| metadata.purpose | modified | 描述支付从发起、回调成功到退款的完整生命周期；包含 W1-b 关系断言段（三种断言各至少一条）与受限谓词语法守卫（TC1/TC2 实例载体） | 支付协议 v1→v2 演进素材（TC6 ⑤ / TC9 ⑦ diff 载体）：新增"部分退款"转移 T5 + metadata.version 升级 |

## 可读层变更

| 路径 | 类型 | 旧值 | 新值 |
| --- | --- | --- | --- |
| readable.background | modified | 支付协议定义顾客发起支付、支付网关回调结果、平台审批退款的协作规则。核心约束是：支付金额必须与订单金额一致（paid_amount == order_amount），支付幂等键全局唯一（unique(payment_id)，数据级不变量），退款必须发生在支付成功后。 | 支付协议定义顾客发起支付、支付网关回调结果、平台审批退款的协作规则。v2 新增部分退款能力：已支付订单可在全额退款之外进行部分退款（T5）。核心约束不变：支付金额必须与订单金额一致（paid_amount == order_amount），支付幂等键全局唯一（unique(payment_id)）。 |
| readable.workflow | modified | 顾客发起支付后订单进入支付中状态，支付网关回调成功则进入已支付状态（可退款），回调失败则进入支付失败终态；平台审批通过后发起退款，订单进入已退款终态。 | 顾客发起支付后订单进入支付中状态，支付网关回调成功则进入已支付状态；平台审批通过后发起全额退款（T4）或部分退款（T5），订单进入已退款终态。 |
| readable.concepts[退款] | modified | 仅已支付订单可发起退款，退款后进入终态 | 仅已支付订单可发起退款；v2 支持部分退款（退款金额 ≤ 已支付金额） |

## 可推演层变更

| 元素类型 | 元素 ID | 类型 |
| --- | --- | --- |
| transition | T5 | added |

## 影响分析

> 分析时间：2026-08-25T09:41:16.069Z

### 受影响步骤

- check
- reason
- formalize
- derive-specs
- derive-contracts
- generate-tests
- generate-cases
- check-impl
- verify

### 受影响产物

- derived/completeness-report.json
- derived/reasoning-report.json
- derived/formal/
- derived/specs.json
- derived/contracts.json
- derived/test-tool/
- derived/test-cases.json
- derived/impl-check/
- derived/verification/

### 增量重推导路径

check → reason → formalize → derive-specs → derive-contracts → generate-tests → generate-cases → check-impl → verify

### 人读映射（变更 → 受影响步骤）

- **新增 transition: T5** → check, reason, formalize, derive-specs, derive-contracts, generate-tests, generate-cases, check-impl, verify

