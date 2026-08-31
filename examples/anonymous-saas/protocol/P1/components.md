---
name: 账号域
protocolId: P1
---

# 组件定义

```yaml
components:
  - name: control-plane
    description: 管理面：账号登录/封禁/配额重算（P1 账号域控制面；跨 P1/P2/P3 组件归属见 composition.md）
    baseUrl: https://control.example.com
    auth: bearer
  - name: data-plane
    description: 数据面：上报资源占用统计输入等观测事件（组合层 INV-3/4 对账数据来源）
    baseUrl: https://data.example.com
    auth: none
```

# 组件映射

```yaml
interfaceImplementations:
  - interface: 登录
    component: control-plane
    description: 账号登录签发会话
  - interface: 封禁用户
    component: control-plane
    description: 运营封禁用户（账号侧置账号状态=已封禁；资源侧补偿由组合层 INV-6 承接）
  - interface: 重算账号配额
    component: control-plane
    description: 账号配额档位重算（调度；占用统计输入来自 P2 资源域）
dimensionStorage:
  - dimension: 账号状态
    table: accounts
  - dimension: 文件空间状态
    table: quotas
  - dimension: 映射并发状态
    table: quotas
componentTransfers:
  - from: data-plane
    to: control-plane
    channel: event
    mode: async
    description: 上报资源占用统计输入等观测事件（组合层 INV-3/4 对账数据来源）
```

# 接口契约

```yaml
contracts:
  - interface: 登录
    path: /login
    method: POST
    authorization: 登录会话
  - interface: 封禁用户
    path: /ban-user
    method: POST
  - interface: 重算账号配额
    path: /recompute-account-quota
    method: POST
```

## 降级记录

- requestSchema/responseSchema 缺省（引用协议层契约可选，viewer 显示「接口契约未声明」降级）；
- 封禁用户 / 重算账号配额 未声明 authorization（调用侧无对应凭证）→ viewer 显示 none + 组件模型未声明降级。
