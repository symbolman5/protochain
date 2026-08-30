# 绑定视图（E11）

> 未读取到 bindings.yaml。本页面仅在 `<rootDir>/bindings.yaml` 或
> `protochain.config.yaml#bindings` 存在时填充。

非敏感投影子集（roles baseUrl/headers + interfaces transport + errorMap）：
见各接口详情页"绑定视图"段。

## 安全边界

- 不读取 authConfig.tokenEnv/secretEnv/passwordEnv
- 不读取 tls.caFile/keyPath/certPath
- 仅 transport/errorMap/stateMap 入站
