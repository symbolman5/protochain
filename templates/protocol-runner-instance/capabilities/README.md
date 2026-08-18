# capabilities（实例层能力资产）

模板自带 `active/plugins/dsh-protocol-runner/`——protocol-runner × DSH 插件
（写域校验 + `protocol_runner_finish` 账本 + `protocol_runner_preflight`），由
`scripts/dsh-driver.mjs` 以 `--patch` 注入 DSH headless 会话。

参考 hsk-ng 的完整能力治理布局可扩展：

```text
capabilities/
├── active/            # 当前生效插件/manifest
├── staging/           # 待验证能力提案（propose_capability 落点）
├── variants/          # 按单元/profile 的 cordis.patch 变体
└── versions/          # 能力版本快照（promote/rollback）
```
