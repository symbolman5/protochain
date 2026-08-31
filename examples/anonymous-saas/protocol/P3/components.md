---
name: 基础设施
protocolId: P3
---

# 组件定义

```yaml
components:
  - name: control-plane
    description: 管理面：服务器/域名/证书登记与调度（P3 基础设施控制面；跨 P1/P2/P3 组件归属见 composition.md）
    baseUrl: https://control.example.com
    auth: bearer
  - name: data-plane
    description: 数据面：健康探测与证书装载（观测事实采集；SNI 选择前提，fail-closed）
    baseUrl: https://data.example.com
    auth: none
```

# 组件映射

```yaml
interfaceImplementations:
  - interface: 登记转发服务器
    component: control-plane
    description: 运维登记转发服务器
  - interface: 下线转发服务器
    component: control-plane
    description: 运维下线转发服务器
  - interface: 登记接入域名
    component: control-plane
    description: 运维登记接入域名
  - interface: 下线接入域名
    component: control-plane
    description: 运维下线接入域名
  - interface: 登记 / 更换域名证书
    component: control-plane
    description: 运维登记/更换域名证书
  - interface: 吊销域名证书
    component: control-plane
    description: 运维吊销域名证书
  - interface: 探测转发服务器健康
    component: data-plane
    description: 健康探测（观测事实采集）
  - interface: 重算证书有效期档
    component: control-plane
    description: 证书有效期档巡检（调度）
dimensionStorage:
  - dimension: 在册状态
    table: servers
    description: 转发服务器在册状态
  - dimension: 服务状态
    table: servers_instances
  - dimension: 在册状态
    table: domains
    description: 接入域名在册状态
  - dimension: 域名覆盖
    table: certs
  - dimension: 有效期档
    table: certs
componentTransfers:
  - from: control-plane
    to: data-plane
    channel: event
    mode: async
    description: 装载/停止装载域名证书（SNI 选择前提；证书过期或吊销 ⇒ fail-closed）
  - from: data-plane
    to: control-plane
    channel: event
    mode: async
    description: 上报健康探测观测事件
```

# 接口契约

```yaml
contracts:
  - interface: 登记转发服务器
    path: /register-forward-server
    method: POST
  - interface: 下线转发服务器
    path: /deregister-forward-server
    method: POST
  - interface: 登记接入域名
    path: /register-domain
    method: POST
  - interface: 下线接入域名
    path: /deregister-domain
    method: POST
  - interface: 登记 / 更换域名证书
    path: /upsert-domain-cert
    method: POST
  - interface: 吊销域名证书
    path: /revoke-domain-cert
    method: POST
  - interface: 探测转发服务器健康
    path: /probe-forward-server-health
    method: GET
  - interface: 重算证书有效期档
    path: /recompute-cert-expiry
    method: POST
```

## 降级记录

- requestSchema/responseSchema 缺省（引用协议层契约可选，viewer 显示「接口契约未声明」降级）；
- 全部契约未声明 authorization（凭证「域名证书」redeemer 为匿名访问者，非本域调用方凭证）→
  viewer 显示 none + 组件模型未声明降级。
