# G7 基线记录（S0 · Linux 实测版）

> 建立：2026-08-30 · 执行者：WorkBuddy（机械判据，可复现）
> 环境：**Linux**（/work/protochain）· protochain 工具链 v0.1.0 · Node v24.18.1
> 命令根：`/work/protochain`（文档中 `C:\workspace\workflow\protochain` 已映射为此路径）
> **归位**：本文件由 model-lab/g7-baseline.md 按 Linux 实测基线更新后移入
> `verification/acceptance/VW-KIND/baseline.md`（G7 验收载体，execution-plan.md §3.1）
> 用途：S1~S6 每一步的「零新增失败」判定基准。**没有这份基线，M2 无从判定。**
> ⚠️ 与旧版（Windows 沙箱）差异：Windows 基线为 14 failed suites / 31 failed tests，
> **本文件以 Linux 实测为准（6 failed suites / 10 failed tests）**，M2 判定按本基线比对。

---

## S0-1 · `npx tsc --noEmit`

```
结果：0 errors　退出码：0
```

**基准值 = 0 errors。** 后续每一步必须维持 0。

---

## S0-2 · `npx jest --silent` 全量结果（Linux 实测）

```
Test Suites: 6 failed, 126 passed, 132 total
Tests:       10 failed, 1644 passed, 1654 total
Time:        ~12 s
```

**绝对数基准**：failed suites = **6**，failed tests = **10**。

> 求套件清单时须去重 —— jest 会把每个 FAIL 打印两次（运行开始一次 + 汇总一次）。

---

## S0-3 · 失败分类（**逐套件实测，Linux 环境**）

| # | 套件 | 失败数 | 分类 | 具体原因 |
|---|---|---|---|---|
| 1 | `tests/integration/e2_1-hskng-integration.test.ts` | 5 | **A 环境** | ENOENT 外部仓库 `C:\work\hsk-ng\modeling\...`（不存在）⇒ P1 model.md 契约集成 5 用例全挂 |
| 2 | `tests/webgen/feedback-issues.test.ts` | 3 | **A 环境** | 依赖 `/work` 下已存在 001-003 修改单 + 路径假设（Linux 落盘位置与断言不符） |
| 3 | `tests/scaffolder/e5-binding-run.test.ts` | 1 | **A 环境** | 无法定位外部项目根 `C:\work\hsk-ng\modeling` ⇒ http.ts 与 bindings.yaml 一致性用例挂 |
| 4 | `tests/webgen/feedback-server.test.ts` | 1 | **A 环境** | POST /api/issues 落盘 `/work/工具链修改单-NNN-...md` 路径假设与 Linux 不符 |
| 5 | `tests/viewer/interface-view-utils.test.ts` | 0（suite load） | **A 环境** | `Cannot use 'import.meta' outside a module`（jest ESM 加载） |
| 6 | `tests/viewer/n1-guard-c8b.test.ts` | 0（suite load） | **A 环境** | 同上 |

**合计核对**：5 + 3 + 1 + 1 = **10 failed tests**；另 2 个套件 load 失败
（Test suite failed to run，计入 failed suites 不计入 failed tests）⇒ **6 failed suites**。
**全部为 A 类环境噪声**（外部仓库缺失 / jest ESM import.meta / 路径假设），
旧版 Windows 基线的 B 类（陈旧断言）与 C 类（待查）在 Linux 上不出现。

### 对后续判定的影响

**判定方式：比对失败原因集合，而非套件名集合。**
这 6 个失败套件固定为 A 类环境噪声，任何一步若出现**新增失败**（失败原因集合中出现新错误串），
即视为回归；失败套件清单本身不变化。已在 execution-plan.md §3.1 M2 判据中写明。

---

## S0-4 · 3 份 model.md 与派生状态（口径修正后）

model.md 实际有 **3 份**，派生产物状态不同：

| 实例 | model.md | derived/ 产物 |
|---|---|---|
| `examples/food-delivery` | `protocol/model.md` | 有（S0-5 首派生后；specs/manifest/storage.schema 等） |
| `examples/fulfillment-payment` P1 | `protocol/P1/model.md` | 有 |
| `examples/fulfillment-payment` P2 | `protocol/P2/model.md` | 有 |

**M3 分母就绪**：3 份 model.md 均已有派生产物，specs.json 均带 `dimensions` 段
（S1 落地后带出维度 kind；food-delivery 4 维度全部显式降级 undetermined）。

---

## S0-5 · food-delivery 首派生（S0 时点记录）

**S0 时点（构建 c864639，S1 之前）实测 sha256（历史基线，勿改）：**

```
4dca503c0656b949  examples/food-delivery/derived/specs.json
c9c2c0c11ebc4644  examples/food-delivery/derived/manifest.json
```

**当前 HEAD（9a3dd73，S1~S6 完成）实测 sha256（2026-08-30 重跑确认）：**

```
c32036829f53f8ab  examples/food-delivery/derived/specs.json        （S1 新增 dimensions 段后更新）
8c5a133c8279ff28  examples/food-delivery/derived/manifest.json
4abe058a621c2ec1  examples/fulfillment-payment/protocol/P1/derived/specs.json
b7b21369546756c9  examples/fulfillment-payment/protocol/P1/derived/manifest.json
a4448244f114975b  examples/fulfillment-payment/protocol/P2/derived/specs.json
39a3ca9bc90f912f  examples/fulfillment-payment/protocol/P2/derived/manifest.json
```

> 注：specs.json 含 generatedAt 时间戳，重跑 sha256 必然变化；本表以「重跑后除 generatedAt
> 外逐字段一致」为准验证派生状态（G7-S7 已比对 3 份均一致）。

**M3 降级统计（G7-S7 实测）**：food-delivery 4 维度全 undetermined（100% 降级，
B-1 预期告警，记录 warning 不视为失败，schemaDegradedReasons 4 条）；P1/P2 无维度（0%）。

---

## 复现方式

```bash
cd /work/protochain
npx tsc --noEmit                                   # 期望 0 errors
npx jest --silent 2>&1 | tail -5                    # 期望 6 failed suites / 10 failed tests
npx jest --silent 2>&1 | grep "^FAIL" | sort -u     # 期望 6 个套件（见 S0-3 清单）
```
