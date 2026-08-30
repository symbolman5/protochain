# 跨协议引用矩阵 —— 履约-支付组合系统

> 跨协议引用总数：**4**（机械提取，参照 E1-I2 跨协议引用识别口径）

## 共享实体 / 关联矩阵

*(composition.md 未声明对象状态切面)*

## 跨协议观测接口

*(composition.md 未声明观测接口)*

## 跨协议守卫 / 字段引用（按引用源→目标分组）

### P1 → P2（4 条）

| 源接口 | 源字段 | 类型 | 目标 | 上下文 |
| --- | --- | --- | --- | --- |
| IF_SYS_T4 | precondition | guard | P2.S_refunded | 退款已批准 且 P2.S_refunded |
| IF_SYS_T4 | preconditions[0].description | guard | P2.S_refunded | …点，自然语言未机械提取：退款已批准 且 P2.S_refunded |
| IF_SYS_T4 | inputs[1].description | guard | P2.S_refunded | 守卫条件参数（来自 guard: 退款已批准 且 P2.S_refunded） |
| IF_SYS_T4 | inputs[2].description | guard | P2.S_refunded | 守卫条件参数（来自 guard: 退款已批准 且 P2.S_refunded） |

## 跨协议不变量覆盖映射

| 不变量 | 名称 | span | 声明方 | 复杂度 | 关联接口 |
| --- | --- | --- | --- | --- | --- |
| CI1 | 退款与履约取消一致 | P1, P2 | platform | simple_boolean | *(无)* |
| CI2 | 退款金额不超订单金额 | P1, P2 | platform | simple_boolean | *(无)* |
