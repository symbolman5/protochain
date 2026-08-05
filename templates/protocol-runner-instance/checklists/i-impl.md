# i-impl 步骤清单（实现单元）

- [ ] init-impl: 初始化实现骨架（首个需求时；实现目录不存在则跳过真实构建）
- [ ] read-conventions: 读 ../impl/CONVENTIONS.md 与 ../docs/architecture.md 并遵循
- [ ] read-contracts: 读 specs/contracts/bindings/impl-scaffold
- [ ] sync-impl: 按契约同步实现（接口/守卫/存储）
- [ ] check-naming: MySQL 命名规范检查 command=scripts/check-mysql-naming.mjs
- [ ] build: 构建与静态检查（go build/vet 或等价）
- [ ] self-check: 自校验：构建通过 + 接口全覆盖
