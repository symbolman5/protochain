# E7 P0 设计笔记（Web 检阅界面 — 只读静态）

> 来源：IMPLEMENTATION-PLAN.md §E7、IMPLEMENTATION-ACCEPTANCE.md §E7 P0、E7-P0-START.txt
> 设计日期：2026-08-22
> 设计范围：纯机械 `derive-web` 命令 + 静态站点工程（VitePress）+ `web serve` 起服务
> 不在 P0 范围（明确防范围蔓延，附录 B.4）：mock 服务 / 团队协作 / 环境管理 / Apifox 克隆；模型侧输入管理（在线编辑 scenarios / bindings）；Web 服务接触令牌环境变量

---

## 1. 目标与约束

| 约束 | 说明 |
|---|---|
| 模块落点 | 新建 `src/webgen/index.ts`（与 `src/bindgen/` 命名一致；与 `web/` 站点工程分离） |
| 站点工程 | `web/`（VitePress 静态站点） |
| 100% 机械 | `derive-web` 不依赖 AI；只读 derived/*.json + model-diff.json + impact-analysis.json |
| 双产物 | `web/data.json`（结构化数据）+ 静态站点产物（VitePress `.vitepress/dist/`） |
| 零运行时依赖 | `protochain` 命令工具链的 `package.json` **不增加** 运行时依赖；vitepress 仅 devDependency |
| 安全 | web 产物不接触 `authConfig.token` / `stateMap.secret` 等敏感字段；本地 web serve 不读 env 变量 |
| 与 E2 耦合 | 强依赖 specs.json envelope（requestSchema / responseSchema 已结构化） |
| 与 E3 关系 | 正交：E3 骨架生成供 P1 在线编辑场景；P0 仅只读，bindings 仍可作为只读展示 |

---

## 2. 顶层产物设计

```ts
// src/webgen/index.ts 导出

/** web/data.json 顶层（站点工程读取的"数据库"） */
export interface WebDataJson {
  schemaVersion: '1.0';
  generatedAt: string;
  sourceModelVersion: string;
  /** 协议元数据（人读） */
  protocol: {
    name: string;
    version: string;
    purpose: string;
    roles: Array<{ id: string; name: string; roleType?: string }>;
  };
  /** 接口目录（来自 specs.json envelope） */
  interfaces: WebInterfaceView[];
  /** 测试用例浏览器（来自 derived/test-cases.json） */
  testCases: WebTestCaseView[];
  /** 验证报告对比（来自 derived/verification/verification-report.json） */
  verification: WebVerificationView;
  /** 模型 diff（来自 derived/diff/model-diff.json，可选） */
  diff: WebDiffView | null;
  /** 影响分析（来自 derived/impact-analysis.json，可选） */
  impact: WebImpactView | null;
  /** 实现完整性状态（来自 derived/impl-check/impl-check-report.json） */
  implCheck: WebImplCheckView | null;
  /** 状态机图（mermaid 源码，逐 state 一份） */
  stateMachine: { mermaid: string };
  /** 安全边界：标记哪些字段被脱敏 */
  redactionNotice: string[];
}
```

### 2.1 接口详情（WebInterfaceView）

```ts
export interface WebInterfaceView {
  id: string;
  name: string;
  kind: 'system' | 'observation';
  actionType?: 'state_transition' | 'attribute_update';
  /** JSON Schema（来自 specs.json requestSchema/responseSchema） */
  requestSchema?: JSONSchema;
  responseSchema?: JSONSchema;
  /** 自然语言保留（任何 schemaKind 都有人读说明） */
  description: string;
  inputs: FieldSpec[];
  outputs: FieldSpec[];
  precondition?: string;
  postconditions: string[];
  /** E2 引入：结构化表达式 */
  preconditions?: SchemaExpression[];
  postconditionExpressions?: SchemaExpression[];
  sideEffects?: SchemaExpression[];
  schemaKind?: 'structured' | 'legacy-stub' | 'description-only';
  schemaDegradedReasons?: string[];
  /** 关联不变量（观测接口） */
  invariantIds?: string[];
}
```

### 2.2 测试用例浏览器（WebTestCaseView）

```ts
export interface WebTestCaseView {
  id: string;
  /** 路径长度 */
  length: number;
  /** 路径上的状态 ID 序列 */
  stateIds: string[];
  /** 路径上的转移 ID 序列 */
  transitionIds: string[];
  description?: string;
  hasException?: boolean;
  /** 是否被验证覆盖（来自 derived/verification/verification-report.json） */
  verificationPassed?: boolean;
  verificationSkipped?: boolean;
  /** 偏差列表（来自 verification-report.json caseResults[].deviations） */
  deviations?: Array<{
    action: string;
    state: string;
    kind: string;
    expected: string;
    actual: string;
    field?: string;
    legacy?: string;
    impl?: string;
  }>;
}
```

### 2.3 验证报告对比（WebVerificationView）

```ts
export interface WebVerificationView {
  /** 是否通过 */
  passed: boolean;
  counts: { passed: number; failed: number; skipped: number };
  /** 来源：是否存在 */
  hasReport: boolean;
  /** 偏差分类统计 */
  deviationSummary: {
    stateMismatch: number;
    fieldMismatch: number;
    missingAction: number;
    invariantViolation: number;
    timingViolation: number;
    other: number;
  };
  /** 用于"双跑对账"展示的列：协议预期（legacy）vs impl 实际（impl）逐字段对比 */
  sideBySide: Array<{
    action: string;
    state: string;
    field: string;
    legacy: string;
    impl: string;
    matched: boolean;
  }>;
}
```

### 2.4 模型 diff / impact（WebDiffView / WebImpactView）

```ts
export interface WebDiffView {
  /** 元数据变更 */
  metadataChanges: FieldChange[];
  /** 可读层变更 */
  readableChanges: FieldChange[];
  /** 可推演层变更 */
  derivableChanges: DerivableChange[];
  diffedAt: string;
  /** 人读：变更摘要 */
  summary: string;
}

export interface WebImpactView {
  affectedSteps: string[];
  affectedArtifacts: string[];
  incrementalPlan: string[];
  analyzedAt: string;
  /** 人读：变更 → 受影响接口/用例/骨架（V6 缺口补面） */
  humanReadable: Array<{
    trigger: string;        // e.g. "transition T1 added"
    affected: string[];       // e.g. ["interface submit", "test-case path-1"]
  }>;
}
```

### 2.5 实现完整性状态（WebImplCheckView）

```ts
export interface WebImplCheckView {
  hasReport: boolean;
  passed: boolean;
  total: number;
  found: number;
  missing: number;
  /** 缺失接口清单（用于"补哪些 action"） */
  missingActions: Array<{ interfaceId: string; interfaceName: string; location?: string }>;
}
```

---

## 3. 静态站点工程结构（web/）

```
web/
├── package.json            # 仅含 vitepress 作为 devDep（站点工程独立）
├── docs/
│   ├── .vitepress/
│   │   ├── config.ts       # VitePress 配置：nav/sidebar + 4 类页面路由
│   │   └── dist/           # VitePress build 产物（web serve 起这里；E7-I1 修复后默认路径）
│   ├── index.md            # 首页（protocol 元数据 + 总览）
│   ├── interfaces/
│   │   ├── index.md        # 接口列表（表格 + 跳详情）
│   │   └── [id].md         # 接口详情（生成期一次性创建 N 个文件）
│   ├── test-cases.md        # 测试用例浏览器
│   ├── verification.md     # 验证报告对比
│   ├── diff.md             # 模型 diff/impact 可视化
│   └── public/
│               └── data.json # 镜像 web/data.json（站点运行时读取）
```

**E7-I1 修复**（v0.5）：站点工程 dist 路径为 `web/docs/.vitepress/dist/`（与 VitePress 默认 outDir `docs/.vitepress/dist` 一致）；`protochain web-serve` 默认 distDir 与此处对齐。

### 3.1 关键决策

| 决策 | 理由 |
|---|---|
| 用 VitePress | 与 PLAN §E7 敲定一致；纯静态 + 内置 markdown + Vue 组件便于扩展 P1 |
| 静态站点内容由 `derive-web` 一次性写出 | VitePress build 只接受静态 .md 输入；运行时不再调用 protochain |
| data.json 镜像在 `web/docs/public/` | 站点读取时绕开 CORS（public 目录默认放静态资源） |
| 状态机图预生成 mermaid 源码 | 不在 web/ 引入 mermaid runtime；页面给出源码段让人贴 https://mermaid.live 查看 |
| 4 类页面路由 | 与附录 B / §E7 P0 一致：接口列表/详情 + 用例浏览器 + 双跑对比 + diff/impact |
| 接口详情页生成 N 个 `.md` 文件 | VitePress 静态站点无法"动态路由"；按 id 一次性写出最简单 |

### 3.2 数据加载策略

站点页面在 VitePress build 阶段嵌入 `web/docs/public/data.json`；运行时通过 `fetch('/data.json')` 读取。这样：
- `web/data.json` 是 derive-web 写出的唯一权威产物（人在工程根读）
- `web/docs/public/data.json` 是其副本（站点工程隔离）
- 同一份数据双份落盘：验收时直接 cat web/data.json；站点运行时读 public/data.json

---

## 4. derive-web 主流程

```
protochain derive-web [--dir <root>]
  ├── 1. readReport(dir, 'derived/specs.json')  # Envelope 形态（E2 产物）
  ├── 2. readReport(dir, 'derived/test-cases.json')  # 可选
  ├── 3. readReport(dir, 'derived/verification/verification-report.json')  # 可选
  ├── 4. readReport(dir, 'derived/impl-check/impl-check-report.json')  # 可选
  ├── 5. readReport(dir, 'derived/diff/model-diff.json')  # 可选
  ├── 6. readReport(dir, 'derived/impact-analysis.json')  # 可选
  ├── 7. parseProtocolFile(<root>/protocol/model.md)  # 仅用于元数据 + 状态机图
  ├── 8. 构造 WebDataJson（纯机械映射，敏感字段过滤）
  ├── 9. 写出 web/data.json
  ├── 10. 写出 web/docs/public/data.json（站点工程副本）
  ├── 11. 写出 web/docs/index.md + web/docs/interfaces/index.md + web/docs/interfaces/<id>.md × N + web/docs/test-cases.md + web/docs/verification.md + web/docs/diff.md
  └── 12. npx vitepress build  → web/docs/.vitepress/dist/
```

**边界（明确不做）**：
- 不调 `generate-cases` 等 AI 步骤的产物；纯机械读 derived/*.json
- 不读 env 变量；不接受 `--token` / `--secret` 等参数
- 不写真实基址 / 不执行 HTTP 调用；site build 失败时返回错误（不静默）

---

## 5. 敏感字段过滤（安全边界）

按附录 B.4 + §E7 P0 安全要求，**web 产物不接触**：

| 字段路径 | 来源 | 过滤策略 |
|---|---|---|
| `bindings.yaml.roles[*].authConfig.tokenEnv` | manual | 完全不入站数据：web 不读 bindings.yaml |
| `bindings.yaml.roles[*].authConfig.secretEnv` | manual | 同上 |
| `bindings.yaml.roles[*].authConfig.passwordEnv` | manual | 同上 |
| `bindings.yaml.roles[*].authConfig.certPath/keyPath/caPath` | manual | 同上 |
| `bindings.yaml.stateMap[*]` 中疑似 secret | manual | web 完全不读 stateMap；stateMap 在 derive-web 范围内不消费 |
| 进程 env（如 `AUTH_TOKEN`） | runtime | web serve 进程不读 env（仅 stdlib http.createServer） |
| specifier 输出中的 `stateMap.secret` | specifier | specifier 不输出此字段（设计约束）；specs.json 无此字段 |

**验证手段**：unit test 构造一个含 `authConfig.tokenEnv='SECRET_TOKEN_XYZ'` 的 bindings.yaml，断言 web/data.json 不含 `SECRET_TOKEN_XYZ`；构造一个含 env 变量的进程，断言 web serve 不读 process.env（通过在子进程环境清空 env 测试）。

---

## 6. web serve 命令

```
protochain web-serve [--port <port>] [--host <host>] [--dir <root>] [--dist-dir <path>] [--skip-probe]
  ├── 1. 检查 web/docs/.vitepress/dist/index.html 存在 → 不存在则提示先 derive-web
  │       （E7-I1 修复：默认 distDir 与 derive-web outDir 对齐）
  ├── 2. 从 web/data.json 读 interfaces[0].id 构造接口详情探针路径
  │       （E7-I2 修复：不再硬编码 IF_SYS_T1；--skip-probe 可关闭）
  ├── 3. 启动 Node http server（stdlib http.createServer）serve web/docs/.vitepress/dist
  │       （E7-I3 修复：handleRequest 顶层 try/catch；畸形 URL → 400 不崩进程）
  ├── 4. 探针（仅 console 打印）：
  │       GET /                              # 首页
  │       GET /interfaces/                   # 接口列表
  │       GET /interfaces/<id>                # 接口详情（动态 ID）
  │       GET /test-cases.html                # 测试用例浏览器
  │       GET /verification.html              # 双跑对比
  │       GET /diff.html                      # diff/impact
  └── 5. 监听 SIGINT/SIGTERM 优雅退出
```

**实现**：src/webgen/serve.ts（独立小文件；非 VitePress 内置 vite preview；因为 vite preview 在某些 CI 中需要额外配置）。

---

## 7. 验收对应

| 验收 | 实现 |
|---|---|
| derive-web 100% 机械 | `src/webgen/index.ts` 不导入 `ai/`；不读 process.env；仅读 derived/*.json + model.md |
| web/data.json + 静态站点产物落盘 | writeFileSync 双产物 + VitePress build 产物（断言 `web/docs/.vitepress/dist/index.html` 存在；E7-I1 修复后路径） |
| protochain web serve 起服务 | http.createServer（stdlib）；CLI 注册 web-serve 子命令；默认 distDir `web/docs/.vitepress/dist`；探针从 `web/data.json` 动态构造（E7-I1/I2 修复） |
| 四类页面人读（非裸 JSON） | generate 阶段写 .md + 嵌入式 Vue 组件读取 public/data.json 渲染；接口详情用表格展示 requestSchema/responseSchema |
| P0 无运行时依赖 | package.json 不新增 vitepress 运行时依赖（vitepress 仅 devDependency）；web serve 用 stdlib http |
| 安全 | 不读 process.env；不读 bindings.yaml（仅读 derived/*）；test 断言 `SECRET_TOKEN_XYZ` 不入 web 产物 |

---

## 8. 与 E# 的接口表（依 E7-P0-START.txt §6 复述）

| 接口 | 来源 | P0 用途 |
|---|---|---|
| specs.json (Envelope) | E2 | 接口列表/详情页（带 schema） |
| test-cases.json | E2 | 测试用例浏览器 |
| verification-report.json | E2 + implcheck | 双跑报告对比（field_mismatch 列） |
| impl-check-report.json | implcheck | 实现完整性状态 |
| diff/model-diff.json | versioner (differ) | 模型 diff 可视化 |
| impact-analysis.json | versioner (differ) | 影响分析可视化（V6 缺口补面） |
| bindings.skeleton.yaml | E3 | P0 仅作为只读 reference（不消费；P1 联动） |
| protocol/model.md | parser | 仅取元数据（purpose/roles）+ 状态机图（states/transitions） |

---

## 9. 不在 E7 P0 范围（明确不做）

- mock 服务 / 团队协作 / 环境管理 / Apifox 克隆（附录 B.4 红线）
- 模型侧输入管理（在线编辑 scenarios / bindings）→ P1
- Web 服务接触令牌环境变量 → P1 也禁止
- 多协议 diff（cross-protocol）→ P1（composition data）
- VitePress 主题定制 / 国际化 → 维持 default theme
- 全文搜索 → VitePress 默认搜索可用即可，P0 不投入额外配置

---

## 10. v0.5 变更日志（2026-08-22 独立复验后修复）

独立复验发现 8 条 issues（[IMPLEMENTATION-ISSUES.md §4 E7-I1~I8](file:///work/protochain/IMPLEMENTATION-ISSUES.md)），v0.5 全量修复：

| ID | 严重度 | 修复内容 |
|---|---|---|
| E7-I1 | 中 | web-serve 默认 distDir `web/.vitepress/dist` → `web/docs/.vitepress/dist`（与 derive-web outDir 对齐） |
| E7-I2 | 中 | startServe 默认探针硬编码 IF_SYS_T1 → CLI 启动前读 `web/data.json` 取真实接口 ID 构造探针；新增 `--skip-probe` |
| E7-I3 | 中 | `resolveStaticPath` 的 `decodeURIComponent` 包 try/catch（畸形 URL → null → 400）；`handleRequest` 顶层 try/catch 兜底（单请求不再杀死进程） |
| E7-I4 | 低 | CLI derive-web 删除死代码 `basicPages`；exit 判定改为显式 existsSync 5 类页面（index/interfaces-index/test-cases/verification/diff） |
| E7-I5 | 低 | 端到端脱敏测试改为向 envelope.specs 注入真实敏感键 tokenEnv/secretEnv；断言敏感值 + 敏感键名均不出现 |
| E7-I6 | 低 | `redactSensitiveFields` 改为整键删除（而非替换为 `[REDACTED]`）；与验收口径"字段不出现"严格对齐 |
| E7-I7 | 低 | 新增 `readOptionalJsonWithStatus`：status 字段区分 'missing' / 'corrupt' / 'ok'；CLI warning 文案区分"未找到 xxx" vs "xxx 存在但 JSON 解析失败" |
| E7-I8 | 低 | `deriveWeb` 在写产物前 existsSync 检查；未传 `--force` → 抛 `web 产物已存在；如需覆盖请传 --force`；`--force` 真正生效 |

**端到端复验**（2026-08-22 v0.5）：
- `npx tsc --noEmit` → 0 errors
- `npx jest` → 58 suites / 833 cases 全过（含 7 项 E7-I* 新增修复测试）
- CLI 端到端：`/tmp/e7p0-v05` 跑 derive-specs → derive-web --no-build → web-serve（默认 distDir）→ 6 URL × 200；畸形 URL `/%zz` → 400，server 仍存活