---
name: 资源发布与兑现
protocolId: P2
---

# 组件定义

```yaml
components:
  - name: control-plane
    description: 管理面：发布/认领/移除/审查/封禁/调度（P2 资源域控制面；跨 P1/P2/P3 组件归属见 composition.md）
    baseUrl: https://control.example.com
    auth: bearer
  - name: data-plane
    description: 数据面：访问兑现/文件上传/心跳/断开（观测事实采集；数据面服务兑现依赖 P3）
    baseUrl: https://data.example.com
    auth: none
```

# 组件映射

```yaml
interfaceImplementations:
  - interface: 匿名发布资源
    component: control-plane
    description: 匿名发布登记资源记录并派生认领码（管理类写路径）
  - interface: 认领资源
    component: control-plane
    description: 认领资源（跨资源与认领码同一事务；guard 跨协议校验 P1 账号/配额）
  - interface: 移除资源
    component: control-plane
    description: 归属人移除资源
  - interface: 审查资源
    component: control-plane
    description: 运营审查资源
  - interface: 封禁资源
    component: control-plane
    description: 运营封禁资源
  - interface: 心跳超时判定
    component: control-plane
    description: 心跳超时判定（调度）
  - interface: 认领码过期
    component: control-plane
    description: 认领码过期判定（调度）
  - interface: 回收已移除资源
    component: control-plane
    description: 已移除资源回收（调度）
  - interface: 请求访问资源（无认领码）
    component: data-plane
    description: 兑现公网访问（代理/拒绝判定，服务兑现依赖 P3）
  - interface: 携带认领码访问
    component: data-plane
    description: 携带认领码访问的跳转判定
  - interface: 上传文件内容
    component: data-plane
    description: 文件上传兑现
  - interface: 上报心跳
    component: data-plane
    description: 心跳接收（观测事实采集）
  - interface: 结束运行 / 断开
    component: data-plane
    description: 断开事件接收（观测事实采集）
dimensionStorage:
  - dimension: 形态
    table: resources
    description: 资源记录（短时内网映射/长期文件托管）
  - dimension: 归属状态
    table: resources
  - dimension: 处置状态
    table: resources
  - dimension: 访问策略
    table: resources
    description: 从归属状态派生的冗余副本（INV-1）
  - dimension: 审核状态
    table: resources
  - dimension: 连接状态
    table: mapping_instances
  - dimension: 存在性
    table: files
  - dimension: 兑付状态
    table: claim_codes
  - dimension: 有效期状态
    table: claim_codes
componentTransfers:
  - from: control-plane
    to: data-plane
    channel: event
    mode: async
    description: 推送访问策略副本（组合层 INV-11，跨 P2/P3；T_sync 内收敛，超期未同步数据面 fail-closed）
  - from: data-plane
    to: control-plane
    channel: event
    mode: async
    description: 上报心跳/断开等观测事件（INV-5 离线释放数据来源）
```

# 接口契约

```yaml
contracts:
  - interface: 匿名发布资源
    path: /publish-anonymous-resource
    method: POST
    authorization: 认领码
  - interface: 上报心跳
    path: /report-heartbeat
    method: GET
    authorization: 认领码
  - interface: 结束运行 / 断开
    path: /finish-运行-disconnect
    method: GET
    authorization: 认领码
  - interface: 上传文件内容
    path: /upload-file-content
    method: GET
    authorization: 认领码
  - interface: 请求访问资源（无认领码）
    path: /request-access-resource-无-claim-码
    method: POST
  - interface: 携带认领码访问
    path: /carry-claim-码-access
    method: POST
  - interface: 认领资源
    path: /claim-resource
    method: POST
    authorization: 认领码
  - interface: 移除资源
    path: /remove-resource
    method: POST
    authorization: 认领码
  - interface: 审查资源
    path: /review-resource
    method: POST
  - interface: 封禁资源
    path: /ban-resource
    method: POST
  - interface: 心跳超时判定
    path: /heartbeat-timeout-judge
    method: POST
  - interface: 认领码过期
    path: /claim-码-expire
    method: POST
  - interface: 回收已移除资源
    path: /recycle-已-remove-resource
    method: POST
```

## 降级记录

- path 转写未全部命中字典（保留原文片段，人工确认，T1b）：结束运行 / 断开（finish-运行-disconnect）、
  请求访问资源（无认领码）（request-access-resource-无-claim-码）、携带认领码访问（carry-claim-码-access）、
  认领码过期（claim-码-expire）、回收已移除资源（recycle-已-remove-resource）；
- requestSchema/responseSchema 缺省（引用协议层契约可选，viewer 显示「接口契约未声明」降级）。
