# m-model 步骤清单（模型单元）

- [ ] init-modeling: 初始化建模目录与初始模型骨架（首个需求时执行；目录已存在则跳过） command=scripts/init-modeling.mjs
- [ ] read-order: 读变更单（../requirements/order.md）并按需求编写/修改 model.md（frontmatter/活性声明/状态空间/转移表/不变量/时序/异常路径）
- [ ] version-save: 改模型前固化当前版本（后续迭代启用）
- [ ] version-quad: 版本四连 diff → impact → classify（propagate 归 D）
- [ ] self-check: 自校验：model.md 存在 + 版本一致
