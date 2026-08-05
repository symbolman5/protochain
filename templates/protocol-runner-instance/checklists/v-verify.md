# v-verify 步骤清单（验证单元）

- [ ] produce-verify: 运行真实 verify 并产出验收报告（无参考实现时建模-only 跳过并记录） command=scripts/produce-verify.mjs
- [ ] pick-target: 按迭代对象选目标（模型参考实现；部署目标按需添加）
- [ ] classify: 偏差分类（实现/模型/环境/混合）
- [ ] self-check: 自校验：verify passed && failed=0
