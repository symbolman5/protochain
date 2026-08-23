# 错误建模与错误管理方案（error-modeling-plan）

> 版本：v0.1（2026-08-23）
> 范围：工具链侧建模错误结构改进、骨架 ↔ 业务错误结构 binding、实现时错误统一管理
> 读者：工具链维护者、实例（hsk-ng / strangler-fig）建模工程师
> 前置依赖：E2.1 契约层 `contracts[]`（requestSchema/responseSchema）、binding 机制（derive-bindings / mergeBindings / stateMap）

---

## 0. 背景与动机

现状缺口（代码事实）：

- **骨架层无错误结构**：`# 异常路径` 表的 `ExceptionPathDef` 只有 `id/name/trigger/transitionIds/recovery`，错误码（如 P3 的 `domain_not_owned`、`token_invalid_role`）散落在"异常处理原则"散文与"处理"列自由文本里，parser 不解析、不校验。
- **接口无错误契约**：`InterfaceSpec` 只有 requestSchema/responseSchema，全 `src/` 搜索 `errorSchema/errorCode/errorResponse` 零命中；契约层 `contracts[]` 同样无错误响应字段。
- **binding 无错误映射**：`bindings.yaml` 只有 roles/interfaces/environments/stateMap，无任何错误结构（hsk-ng 实例甚至未使用 stateMap）。
- **验证层只能事后观察到错误**：`Deviation` 记录 httpStatus/responseBody，但错误返回无法归一化到协议错误码；`RESERVED_INJECT_KEYS` 保留 `error/ok`，运行时错误被当偏差证据而非契约断言。
- **系统内部故障（DB 不通、数据异常）不在建模范围**：transport 层有运行时错误处理（504/401/error 字段），但属于执行细节，非建模产物。

本方案的目标：

1. 把"业务上存在哪些错误"结构化进骨架层（model.md），成为权威源的一部分。
2. 把"真实系统怎么表达这些错误"放进绑定层（bindings.yaml errorMap），与 stateMap 同构。
3. 让 verify 按契约机械断言错误返回，无法归类的 5xx/504 独立记为系统故障，可观测、可报告。
4. 统一实现阶段各类错误的分类、对象形态与报告展示。

---

## 1. 三层错误模型（总览）

错误在系统中天然分三层，分别落在三个载体上，遵循"单一权威源 → 机械推导"原则：

| 层 | 载体 | 职责 | 现状 → 目标 |
|---|---|---|---|
| L1 骨架层 | model.md 异常路径 + 契约层 | 声明**业务上存在哪些错误**（协议错误码、错误响应结构） | ◐ 异常路径有语义无结构 → 补错误码列 + `errorResponses[]` |
| L2 绑定层 | bindings.yaml `errorMap` | 声明**真实系统怎么表达这些错误**（HTTP status、系统错误码、错误体字段位置） | ✗ 无 → 新增 `errorMap`（与 `stateMap` 同构） |
| L3 运行/验证层 | transport + verifier | 按 L1/L2 契约**机械断言**错误返回，无法归类的记为系统故障 | ◐ 只能观察到偏差 → 新增 `error_mismatch` 偏差 + `errorSummary` |

配套约定：

- **统一错误返回 envelope**（§4.2）：接口错误响应的推荐结构。
- **统一工具链错误对象**（§4.1）：`ToolchainError` + `ErrorCategory`，贯穿全链路。

---

## 2. 骨架层：建模错误结构改进

### 2.1 异常路径结构化：错误码列

`ExceptionPathDef` 增加 `errorCode`（本异常路径对应的协议错误码，协议内唯一）：

```
| ID | 名称 | 触发 | 转移 | 处理 | 错误码 |
|---|---|---|---|---|---|
| EX2 | 域名未归属 | 归属域名非本人 claim | 创建 | domain_not_owned，拒绝 | domain_not_owned |
```

```ts
export interface ExceptionPathDef {
  id: string;
  name: string;
  trigger: string;
  transitionIds: string[];
  recovery?: string;
  /** 本异常路径对应的协议错误码（唯一，snake_case） */
  errorCode?: string;
}
```

落地：

- parser：`normalizeHeader` 增加 `错误码/errorcode` 列映射，`rowToException` 读取。
- **兼容**：旧表无该列 → 不填、不报错、不改变现有行为。

### 2.2 接口错误契约：contracts[].errorResponses

契约层 `contracts[]` 增加 `errorResponses`——每个接口可声明自己的错误返回结构：

```yaml
contracts:
  - interface: create_mapping
    requestSchema: { ... }
    responseSchema: { ... }
    errorResponses:
      - id: ERR-01
        errorCode: domain_not_owned    # 引用异常路径声明的错误码（跨引用校验）
        httpStatus: 409                 # 期望的传输状态码
        bodySchema:                     # 错误体 JSON Schema（与 requestSchema 同子集）
          type: object
          properties:
            code:      { type: string, enum: [domain_not_owned] }
            message:   { type: string }
            requestId: { type: string }
          required: [code, message]
      - id: ERR-02
        errorCode: domain_taken
        httpStatus: 409
        bodySchema: { type: object, properties: { code: { type: string, enum: [domain_taken] } } }
```

新类型：

```ts
/** 单条接口错误响应契约（挂在契约层 contracts[]） */
export interface ErrorResponseDef {
  id: string;                    // 契约内唯一（ERR-01）
  errorCode: string;             // 协议错误码，与 ExceptionPathDef.errorCode 对齐
  httpStatus: number;            // 传输层状态码（4xx=业务错误；5xx 不在此声明）
  bodySchema?: JSONSchema;       // 错误体结构（JSON Schema 子集）
  description?: string;
}
ContractEntry 增加: errorResponses?: ErrorResponseDef[];
```

落地：

- parser：`parseContractEntry` 增加 `errorResponses` 数组解析（复用 `parseJsonSchemaValue` 校验 bodySchema，形态非法抛 ParseError）。
- specifier：`deriveSystemInterface` 把命中契约的 `errorResponses` 原样投影到 `InterfaceSpec`（与 requestSchema 同通道）；无契约时为空。

```ts
export interface InterfaceSpec {
  // ... 现有字段
  /** 接口错误响应契约（契约层 errorResponses 投影） */
  errorResponses?: ErrorResponseDef[];
}
```

### 2.3 checker 校验规则（新增，纯机械）

checker 增加错误契约一致性检查（referenceIssues / fieldIssues 通道）：

| 规则 | 级别 | 说明 |
|---|---|---|
| errorCode 唯一 | error | 协议内错误码不得重复（含异常路径 + 契约） |
| 命名规范 | error | `^[a-z][a-z0-9]*(_[a-z0-9]+)*$`（snake_case） |
| 异常路径错误码 ↔ 契约错误码闭合 | error | 异常路径声明的每个 errorCode 必须被至少一个接口的 errorResponses 引用；契约引用的 errorCode 必须能在异常路径中找到（可追溯到 EX-id） |
| httpStatus 语义 | warning | 5xx 不应声明为业务错误响应（5xx 属系统故障，见 §4.3） |
| bodySchema.code enum 含 errorCode | warning | 错误体结构里 code 字段的 enum 应覆盖自身 errorCode |

### 2.4 m-check 语义闸门（可选）

错误码命名/唯一性校验前置到模型入口（M 单元），与 CORE-VALUE §4.4 同方向——让"写错错误码"在建模阶段被拦下，而非推导阶段。

### 2.5 兼容策略

老模型无错误码列 / 无 errorResponses → 全部降级为空，行为与现状一致（与 description-only 同哲学）。

---

## 3. 绑定层：骨架 ↔ 业务错误结构

### 3.1 errorMap 设计（bindings.yaml）

与现有 `stateMap`（协议状态 ID ↔ 系统状态词）**同构**：协议错误码 ↔ 真实系统错误表达。

```yaml
# bindings.yaml（新增段）
errorMap:
  domain_not_owned:            # key = 协议错误码（来自 model.md 异常路径/契约）
    httpStatus: 409            # 期望状态码（可选，缺省不校验）
    systemCode: E40901         # 真实系统错误码（缺省 = 协议错误码）
    bodyField: code            # 错误体中承载错误码的字段路径（支持 a.b.c）
    bodyFieldValue: DOMAIN_NOT_OWNED   # 系统码值（与协议码不同名时填）
  token_invalid_role:
    httpStatus: 403
    systemCode: AUTH4032
    bodyField: err.code
    bodyFieldValue: TOKEN_ROLE_INVALID
```

类型（模型 types.ts 绑定段）：

```ts
/** 错误映射条目：协议错误码 → 真实系统错误表达 */
export interface ErrorMapEntry {
  /** 期望 HTTP 状态码（4xx 业务错误；缺省不校验） */
  httpStatus?: number;
  /** 真实系统错误码（缺省 = 协议错误码） */
  systemCode?: string;
  /** 错误体中承载错误码的字段路径（如 code / err.code / msg.code） */
  bodyField?: string;
  /** 系统错误码值（与 systemCode 不同名时使用；缺省 = systemCode） */
  bodyFieldValue?: string;
  /** 非 HTTP 传输（kafka/nsq 消息）内的错误码字段路径 */
  messageField?: string;
}
BindingConfig 增加: errorMap?: Record<string, ErrorMapEntry>;
```

### 3.2 derive-bindings 机械推导 + 合并

- bindgen：从 `specs.errorResponses` 派生 errorMap 骨架（协议码 → `{httpStatus}` 占位；systemCode/bodyField/bodyFieldValue 待人工确认——与 roles baseUrl 的"待人工确认项"同等待遇，计入 `manualConfirmItems`）。
- mergeBindings：增加 errorMap 合并规则（manual 覆盖 skeleton 同 key，与 interfaces 合并规则 3 同款）。

### 3.3 binder 校验

`validateBindings` 增加：

- specs 所有 `errorResponses[].errorCode` 必须在 errorMap 有条目，缺失 → `valid=false`（与"观测接口缺绑即失败"同纪律）。
- errorMap 里的码不在 specs/异常路径中 → warning（可能残留）。

### 3.4 verify 断言（核心闭环）

binding-runner 增加错误判定路径——当传输结果 `ok=false` 时：

```
非2xx/错误响应
 ├─ httpStatus ≥ 500 → system_fault 类别（记录，不匹配 errorMap）
 ├─ 命中 errorMap（bodyField 提取值 == bodyFieldValue/systemCode，且 httpStatus 匹配）
 │    ├─ 该步场景/路径期望错误 → ✓ 通过（错误格式符合契约）
 │    └─ 该步期望成功 → deviation（unexpected_error）
 └─ 未命中 errorMap → deviation error_mismatch（错误格式未声明/未对齐）
```

- `Deviation.kind` 增加 `'error_mismatch'`；复用现有 httpStatus/responseBody 记录实际值。
- `expected` 填 `errorMap 期望（status:code）`，`actual` 填实际提取值。
- 场景层支持期望错误（`ScenarioParamSource` 增加字段）：

```yaml
# scenarios/sc-XX.yaml
id: SC-05
name: P3 域名被占 → domain_taken
expectedActions: [create_mapping]
expectedError:
  errorCode: domain_taken     # 协议错误码
  httpStatus: 409
```

verify 遇到 `expectedError` 断言：实际错误必须命中该 errorCode 的 errorMap 条目。

### 3.5 多协议作用域

错误码在**协议内唯一**；errorMap key 支持 `P3:domain_taken` 前缀语法（与 `InterfaceBinding.protocol` 隔离同款），同名 action 的跨协议错误码不撞车。

---

## 4. 实现时错误统一管理

### 4.1 统一错误对象（工具链内部）

所有模块抛错/上报统一走一个对象，带类别与模型可追溯性：

```ts
export type ErrorCategory =
  | 'model_error'          // 骨架层：结构/引用/契约/错误码建模错误
  | 'binding_error'        // 绑定层：errorMap 缺失/不一致、transport 配置错误
  | 'transport_error'      // 传输层：超时/网络/连接（504 等）
  | 'protocol_violation'   // 验证层：state/invariant/timing/field/error mismatch
  | 'system_fault';        // 系统内部故障：5xx/DB 不通/数据异常（可观测不可建模）

export interface ToolchainError {
  category: ErrorCategory;
  code: string;                    // 工具链错误码：TC_MODEL_DUP_ERROR_CODE / TC_BIND_ERROR_UNMAPPED ...
  severity: 'error' | 'warning' | 'info';
  message: string;
  elementRef?: { protocol?: string; elementId?: string; field?: string };  // 追溯到模型元素
  protocolErrorCode?: string;      // 若关联协议错误码
  transport?: { status?: number; body?: unknown };  // 运行时证据
}
```

落地范围：

- parser/specifier/checker 抛错统一携带 category+code（替代散落的 ParseError 字符串）。
- bindgen/binder 校验告警统一为 ToolchainError。
- transport 执行器返回纳入（见 §4.4）。
- verifier 偏差可挂 protocolErrorCode。

### 4.2 接口侧统一错误返回 envelope

协议层约定所有接口错误响应用统一 envelope（骨架层模板，可裁剪；**不强制**，未用 envelope 的走 errorMap.bodyField 提取）：

```json
{ "code": "domain_not_owned", "message": "域名未归属", "requestId": "req-...", "details": {} }
```

- 骨架层：契约 `errorResponses[].bodySchema` 用此模板（details 可按接口定制）。
- 绑定层：`errorMap.bodyField` 默认指向 `code`。
- 验证层：verify 断言 `code` 字段值 == errorMap 目标值。

### 4.3 system_fault 边界（数据库不通、数据异常）

- **建模边界**：不建模（与 CORE-VALUE §4.3"数据级不变量降级"同一哲学——5xx 不是业务契约）。
- **可观测**：verify 报告把 5xx/504 独立归类为 system_fault 计数，不静默、不当作业务偏差。
- **可追踪**：报告记录 httpStatus + responseBody 摘要（复用 Deviation 现有字段），与业务错误分开统计。

### 4.4 transport 运行时错误接入统一模型

`TransportResult` 现有 `{status, data, ok}` 已够承载；新增统一错误归一化函数（transport 层不做业务判断，只标记类别）：

```ts
export function classifyTransportError(res: TransportResult): ErrorCategory
// 2xx → 成功；4xx → 业务错误（交 verify 按 errorMap 匹配）；
// 5xx/504 → system_fault；网络/超时 → transport_error
```

### 4.5 scenarios + test-tool + implcheck

- scenarios 增加 `expectedError`（§3.4）——错误场景成为测试意图，可进 web 管理（复用 E7-P1 feedback scenarios CRUD）。
- test-tool 生成的 ProtocolImplementation 契约不感知错误（仍按 nextState 判定）；错误断言全部走 binding-runner 路径（保持 test-tool 与 binding 双路径不重复）。
- implcheck（可选扩面）：实现侧错误返回是否命中 errorMap（bodyField 字段存在性静态扫描）。

### 4.6 verify 报告扩展

`VerificationReport` 增加 `errorSummary`：

```ts
errorSummary?: {
  /** 按协议错误码聚合：errorCode → 次数（命中 errorMap 且符合预期） */
  matched: Record<string, number>;
  /** 未命中 errorMap 的错误响应（error_mismatch 偏差） */
  unmapped: Array<{ action: string; httpStatus: number; responseBody: unknown }>;
  /** 系统内部故障（5xx/504）计数 */
  systemFault: number;
};
```

### 4.7 web 展示扩展

目标：接口详情展示"绑定后的完整接口"= 业务字段（requestSchema/responseSchema）+ 错误结构（errorResponses）+ 传输绑定（transport/errorMap）。

- 接口详情页：
  - "请求/响应"表（业务字段，随 specs.json 投影）——已实现；
  - 新增"错误响应"表（errorResponses：错误码/status/bodySchema）——与 requestSchema 同级机械推演，随 specs.json，不读 bindings；
  - 新增"传输绑定"表 + "错误映射"表——**绑定视图**（见下）。
- **绑定视图（新增机制）**：derive-web 机械读 bindings.yaml 的**非敏感投影子集**（`interfaces[].action/roleId/protocol/transport` + `errorMap`），构造 `WebBindingView`；**authConfig/tls 密钥段不读取**，`redactSensitiveFields` 整键删除兜底。红线语义不变："不读 bindings.yaml 敏感段"，但可安全展示非敏感绑定信息，满足"绑定后的完整接口"展示。
- verification 页：errorSummary 段（matched/unmapped/systemFault 三列）。

### 4.8 工具链错误码表

```
TC_MODEL_*      建模错误（DUP_ERROR_CODE / BAD_ERROR_CODE / REF_UNRESOLVED / CONTRACT_MISSING）
TC_BIND_*       绑定错误（ERROR_UNMAPPED / ERROR_STATUS_MISMATCH / ERROR_FIELD_MISSING）
TC_VERIFY_*     验证偏差（ERROR_MISMATCH / UNEXPECTED_ERROR / SYSTEM_FAULT）
```

---

## 5. 实施顺序

| 阶段 | 内容 | 模块 |
|---|---|---|
| P0 | 类型扩展（ExceptionPathDef.errorCode / ErrorResponseDef / errorMap / Deviation.error_mismatch）+ parser + specifier 投影 | types / parser / specifier |
| P0 | checker 错误契约校验 + bindgen 骨架推导 + binder 校验 | checker / bindgen / binder |
| P1 | verify 错误断言 + errorSummary + scenarios.expectedError | verifier / scenario schema |
| P1 | web 绑定视图（接口详情错误响应表 + 传输绑定 + errorMap 投影）+ verification errorSummary | webgen |
| P2 | ToolchainError 统一重构 + transport 分类接入 + implcheck 扩展 | 全模块 |

---

## 6. 红线与不变量

1. **错误码权威在 model.md**（异常路径 + 契约层）；binding 只做"协议码 ↔ 系统码"映射，不发明错误码——违反即模型错误。
2. **errorMap 缺失 = bind 失败**（与观测接口缺绑同纪律），强制"骨架错误结构"与"业务错误表达"对齐。
3. **5xx 不建模为业务错误**——system_fault 只可观测、可报告，不进入契约。
4. **web 安全红线不破**：绑定视图只读 bindings.yaml 非敏感投影子集（transport/errorMap），authConfig/tls 密钥段不读取、不出现在任何 web 产物；errorMap/errorResponses 本身无敏感字段，可机械展示。
5. **老模型零破坏**：无错误码列/无 errorResponses/无 errorMap → 全部降级空，行为与现在一致。

---

## 附录 A：与现有机制的对齐点

| 本方案概念 | 对齐的现有机制 | 位置 |
|---|---|---|
| errorMap（协议码 ↔ 系统码） | stateMap（协议状态 ID ↔ 系统状态词） | [types.ts 绑定段](file:///work/protochain/src/model/types.ts) / [binding-runner.ts:22-24](file:///work/protochain/src/verifier/binding-runner.ts) |
| contracts[].errorResponses | contracts[].requestSchema/responseSchema（E2.1） | [parser parseContractEntry](file:///work/protochain/src/parser/index.ts#L1011-L1048) / [specifier deriveSystemInterface](file:///work/protochain/src/specifier/index.ts#L151-L330) |
| derive-bindings 错误骨架 | binding 骨架推导（method/path/params） | [bindgen/index.ts](file:///work/protochain/src/bindgen/index.ts) |
| error_mismatch 偏差 | Deviation.kind 六种偏差 | [types.ts:1144-1168](file:///work/protochain/src/model/types.ts) |
| errorMap 缺失 = bind 失败 | 观测接口缺绑 = valid=false | [binder/index.ts validateBindings](file:///work/protochain/src/binder/index.ts#L153-L235) |
| errorSummary web 段 | verification 页偏差统计 | [webgen/index.ts buildVerificationView](file:///work/protochain/src/webgen/index.ts#L429-L484) |
| 绑定视图（非敏感投影展示） | feedback 读 bindings + redactSensitiveFields 脱敏 | [webgen/index.ts:268](file:///work/protochain/src/webgen/index.ts#L268-L282) / [feedback/store.ts readBindingsFile](file:///work/protochain/src/webgen/feedback/store.ts#L267-L294) |
| system_fault 边界 | 数据级不变量降级（CORE-VALUE §4.3） | [CORE-VALUE.md](file:///work/protochain/CORE-VALUE.md) |

---

> 反馈：本文档定位为工具链维护者的实现方案；如与 USAGE.md / CORE-VALUE.md 冲突，以命令行与代码事实为准。
