---
name: 退化协议示例
version: 0.1.0
purpose: 演示可推演层超出表格表达力边界时退化为形式化语言的处理
roles:
  - id: node
    name: 节点
---

# 背景

并发协议超出有限状态机的表达力，退化为 TLA+ 形式化规格。

# 协作流程

多个节点并发读写共享资源，需保证一致性。

# 状态空间

| ID | 名称 | 类型 | 描述 |
|---|---|---|---|
| S1 | 初始 | initial | 系统启动 |

# 可推演层（形式化）

```tla
---- MODULE ConcurrentProtocol ----
EXTENDS Naturals, Sequences
VARIABLES state, queue

Init == state = "idle" /\ queue = << >>

Next == /\ state = "idle"
        /\ \E r \in Requests :
              /\ state' = "processing"
        /\ queue' = Append(queue, r)

Inv == state = "processing" => Len(queue) > 0
=============================================
```
