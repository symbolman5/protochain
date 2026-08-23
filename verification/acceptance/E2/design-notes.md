# E2 设计笔记（specs.json 升级到 JSON Schema）

> 来源：IMPLEMENTATION-PLAN.md §E2、IMPLEMENTATION-ACCEPTANCE.md §E2
> 设计日期：2026-08-22
> 设计范围：specs.json 从"接口目录（name/type/description 三件套）"升级为"可机械断言的契约"（含完整 JSON Schema）。

---

## 1. 目标与约束

| 约束 | 说明 |
|---|---|
| 依赖 | 仅复用 `package.json:16` 已有 `ajv@^8.17.1`，不新增依赖 |
| MR 约束 | E1 的 pre-check 钩子与本任务同一个 MR 合并提交 |
| 兼容性 | 老格式 specs.json 必须自动迁移 + 显式 `kind="legacy-stub"` 标记 + 报警；不能强制破坏 |
| 退化兼容 | 自然语言 guard / effects 继续可用，但降级为 description-only，不进 schema |
| 不破坏权威源 | verifier 只在 specs.json（新格式）下做字段级对比；老格式仍跑原状态 ID 偏差 |

## 2. 顶层 schema 设计

```ts
interface SpecsEnvelope {
  schemaVersion: '1.0';              // 文档版本号
  generatedAt: string;                // ISO 时间
  sourceModelVersion: string;         // 源 model.md version
  migrated?: boolean;                 // 是否从老格式迁移而来
  migrationWarnings?: string[];       // 迁移期报警
  specs: InterfaceSpec[];             // 现有 Spec 数组（含扩展 schema 字段）
}
```

兼容性策略：
- derive-specs 在写入 `derived/specs.json` 时总是写 Envelope 形态
- checker/verifier 启动时若发现顶层就是裸 `InterfaceSpec[]`，自动包裹为 Envelope（旧格式兼容）+ 报警一次
- CLI 退出码不受迁移报警影响，但迁移会将 `migrated=true + migrationWarnings` 写入 envelope

## 3. InterfaceSpec 扩展字段

```ts
interface InterfaceSpec {
  // ... 既有字段 ...
  /** request/response 等的 JSON Schema（可被 ajv 编译） */
  requestSchema?: JSONSchema;
  responseSchema?: JSONSchema;
  /** 结构化前置/后置/副作用（已在 E1 规范中提及：表达式数组，每项 {kind,expression?,description?,schema?}） */
  preconditions?: SchemaExpression[];
  postconditions?: SchemaExpression[];
  sideEffects?: SchemaExpression[];
  /** 标记：当 schema 缺失或仅含 description 时显式标记，便于校验/消费者识别 */
  schemaKind?: 'structured' | 'legacy-stub' | 'description-only';
  /** 字段级降级理由（例："guard 为自然语言，未机械提取"） */
  schemaDegradedReasons?: string[];
}

/** 结构化表达式 —— 与 guard/effects 表达语义、前置后置副作用统一 */
interface SchemaExpression {
  /** 表达式种类：JSON Schema 子文档 / 文本描述 / 标记 */
  kind: 'json-schema' | 'description-only' | 'legacy-stub';
  description?: string;     // 自然语言说明（始终保留）
  schema?: JSONSchema;      // 当 kind='json-schema' 时填
}
```

## 4. specifier 重构策略

specifier 由「机械映射 inputs/outputs」扩展为「机械推导 JSON Schema」：

### 4.1 系统接口 schema 推导
- **requestSchema**：从 inputs 推导（仅在字段含 `type` 时映射 JSON Schema 类型；含 `required` 标记时进 `required` 数组）
  - 类型映射：`string/number/integer/boolean/array/object` → 同名
  - 兜底：缺 type 时给 `{"type":"string"}` + 备注（description）
  - 限制：`guard` 是自然语言时（如 `form_valid`、`has_request`），提取的 guard params 仍进 schema（作为 `boolean` 参数），但**整体 precondition** 标注为 `legacy-stub`
- **responseSchema**：从 outputs 推导
  - `nextState`/`currentState` 强制 `string`，enumeration = 协议状态 ID 全集
  - `effects` 强制 `string[]`
  - 其他字段遵循 requestSchema 同样映射
- **preconditions**：当 `t.guard` 是结构化（如 `count > 0`）则推导为 `{ type:'json-schema', schema:{...} }`；否则降级 `{ kind:'legacy-stub', description: t.guard }`
- **postconditions**：`t.effects` 每条作为 description（effects 本身是 narrative 列表，机械不出 schema）
- **sideEffects**：与 postconditions 同源（保留别名兼容）

### 4.2 观测接口 schema 推导
- **outputSchema** 固定：`isInState`(boolean) + 可选 `facts`(string[]) + `holds`(boolean)
- requestSchema 通常为空（观测接口无入参）；特殊：多维观测接口的每个 dimension 进 schema `properties`

### 4.3 schemaKind 判定
- `structured`：requestSchema / responseSchema 都被 ajv 编译通过 + preconditions 非 legacy-stub
- `legacy-stub`：precondition 含有 legacy-stub 或 expression 仅有 description-only
- `description-only`：无任何结构化字段，仅有 name+description

## 5. checker 适配

checker 不主动引入 ajv 编译（ajv 编译在 specifier 出口做一遍即可）；checker 只做：
- 校验 `specs.json` 是合法 JSON；
- 校验每个 `requestSchema`/`responseSchema` 含 `type` 字段（机械必填）；
- 校验 `schemaKind` 字段名合法。

ajv 编译放在 steps/specify.ts 的 writeReport 之前，`passed` 取决于编译成功。

## 6. verifier 字段级偏差

引入新能力：
- 对 system 接口，当响应体包含对象，按 `responseSchema.properties` 一一对比每个字段
- 报告 deviation 形式：`action: "approve", state: "S2", kind: "field_mismatch", field: "response.approver_id", legacy: "Y", impl: "Z"`
- 兼容：老格式 specs.json（无 schema）→ 沿用原 state_mismatch 路径（不崩）

新增 `Deviation.kind`：
- `field_mismatch`：字段级偏差（业务字段比对）
- `state_mismatch`：状态 ID 偏差（既有）
- 其他保留

`Deviation` 新增字段 `field?: string`；响应体为比较对象时同时填 `legacy?: string` 与 `impl?: string`。

## 7. CLI 兼容

- `protochain derive-specs` 永远写 Envelope，log 行加："specs.json: schemaVersion=1.0, migrated=false（旧格式输入时）"
- 若用户 `--legacy-input <path>` 指定老格式 specs.json（已存在的）：CLI 读入 → migrate → 输出新格式；报警写到 stderr
- 同一 MR 合并提交（IMPLEMENTATION-PLAN §E1 交付物 3 约束）

## 8. 验收对应

| 验收 | 实现 |
|---|---|
| ajv 编译 specs.json 全部通过 | steps/specify.ts 写报告前 ajv.compile() 全部 schema，失败 → step.passed=false + 报错 |
| 抽查接口 requestSchema/responseSchema 非空 | specifier 输出保证 |
| verify 报告含「字段 X：legacy=Y, impl=Z」 | verification-report.json 的 deviations[].kind='field_mismatch' + field/legacy/impl 字段 |
| 老格式 specs.json 自动迁移 + legacy-stub 显式标记 | readReport 启动时若裸数组则迁移后返回新 Envelope；migrationWarnings 写到 envelope |
