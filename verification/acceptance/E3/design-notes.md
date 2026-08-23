# E3 设计笔记（binding 骨架自动生成）

> 来源：IMPLEMENTATION-PLAN.md §E3、IMPLEMENTATION-ACCEPTANCE.md §E3
> 设计日期：2026-08-22
> 设计范围：把 ⑤ 推导的 `specs.json`（E2 产物）机械投影为 `bindings.skeleton.yaml`，让 ⑦ 之前的「从零写 bindings.yaml」降级为「在骨架上确认 baseUrl/headers/stateMap」。

---

## 1. 目标与约束

| 约束 | 说明 |
|---|---|
| 模块落点 | 新建 `src/bindgen/index.ts`（与 `src/binder/` 拼写区分；`bindgen`=骨架生成器，`binder`=完整性校验器） |
| 不引入新依赖 | 复用 E2 的 envelope、schema-builder、现有 `yaml` 包 |
| 与 E2 强耦合 | 必须等 specs.json 含完整 requestSchema/responseSchema 后才能做 method/path/params 推导；老格式 specs.json 触发 envelopeMigrate 后再推导 |
| 老格式 bindings.yaml 兼容 | bind 命令继续接受「无 skeleton 字段」的传统写法（不再要求「从零写」指「人工不写骨架」，不是「人工不写完整 bindings」） |
| 边界 | HTTP 默认推导；Kafka/NSQ/Grpc/DbQuery 仅生成占位骨架（method/path 标 TODO），避免无 schema 推导误判 |
| stateMap 派生 | 从 specs.json 的 `observe_*` 派生初始归一化表（仅协议状态 ID → 协议状态名），待人工补外部系统词 |

## 2. 顶层产物设计

```ts
// src/bindgen/index.ts 导出
export interface SkeletonBindings {
  /** 推导时间（ISO） */
  generatedAt: string;
  /** 源 model.md version */
  sourceModelVersion: string;
  /** 源 specs.json 是否 envelope 形态 */
  sourceEnvelope: boolean;
  /** 是否从老格式 specs.json 迁移而来 */
  sourceMigrated: boolean;
  /** 迁移期报警（CLI 透传） */
  sourceMigrationWarnings: string[];
  /** 角色（占位 baseUrl + 默认 auth=none） */
  roles: Record<string, RoleBinding>;
  /** 接口绑定骨架（按 specs.name 一一对应） */
  interfaces: InterfaceBinding[];
  /** 状态词表初始（observe_<stateId> → state.name）；待人工补外部系统词 */
  stateMap: Record<string, string>;
  /** 统计：生成率（除 baseUrl/headers/authConfig/stateMap 确认项外的字段占比） */
  stats: SkeletonStats;
}

export interface SkeletonStats {
  total: number;
  system: number;
  observation: number;
  /** 生成成功（无需人工修改 method/path/transport.type） */
  generated: number;
  /** 部分生成（method/path/transport 留 TODO） */
  partial: number;
  /** 生成率：generated / total */
  generationRate: number;
}
```

`bindings.skeleton.yaml` 顶部增加 `__protochain_skeleton__: true` 标记，避免人工编辑后被覆盖；`bind` 命令识别此标记后才会走 `mergeBindings(skeleton, manual)`。

## 3. 推导规则

### 3.1 角色（roles）

- 来源：specs.json 中 system/observation 接口涉及的触发角色（`InterfaceSpec.outputs` 的 nextState 隐含），与 `model.metadata.roles` 取并集
- 字段：
  - `roleId`：角色 ID
  - `baseUrl`：`https://TODO.example.com`（占位；人工必须替换）
  - `auth: 'none'`（占位；默认无认证，提示人工按需切换 bearer/basic/...）
  - `headers: {}`（空占位）
- 兜底：若 specs 中无任何系统接口触发角色（退化模式）→ 角色段仅含 `default` 一个角色，警告「无显式角色，按 default 兜底」

### 3.2 接口（interfaces）

按 `specs.json` 的接口顺序遍历，逐条生成 InterfaceBinding：

| 接口类型 | method | path | params | transport.type |
|---|---|---|---|---|
| system（HTTP 默认） | POST | `/<snake_case(action)>` | requestSchema.properties 中所有 required=true 的字段 | `'http'` |
| system（HTTP + state_transition） | POST（按默认） | `/<snake_case(action)>` | 同上 | `'http'` |
| system（attribute_update） | PATCH | `/<snake_case(action)>` | 同上 | `'http'` |
| observation（state/invariant） | GET | `/observe/<stateId 或 invariantId>` | 空（观测无入参） | `'http'` |
| observation（resource pool） | GET | `/observe/<poolId>` | 空 | `'http'` |
| observation（multi-dimension） | GET | `/observe/<stateId>/<dim>` | dim 进 query | `'http'` |

**Kafka/NSQ/Grpc/DbQuery 留 TODO**：specs.json 不携带传输偏好信息，无法机械推导（可能同时存在 HTTP/Kafka 两种实现路径）；骨架生成时 transport 段注 `__todo__: "kafka/nsq/grpc/db_query — 需要人工指定"`。当前验收范围内仅以 HTTP 推导为"生成成功"，其他为"部分生成"。

**actionType 判定**：复用 specifier 已写入的 `InterfaceSpec.actionType`（`state_transition` → POST，`attribute_update` → PATCH）。

### 3.3 响应映射（responseMapping）—— v0.1 仅占位

不在 E3 验收范围（IMPLEMENTATION-PLAN §E3 "从 responseSchema 机械推导"），但 specifier E2 已给出 responseSchema；为避免破坏现有 `InterfaceBinding` 类型，先不引入 responseMapping 字段。

> **简化决策**：原 §E3 的 responseMapping 在 v0.5 验收时进一步讨论（model/types.ts 中 TransportBinding 没有 responseMapping 字段，引入会冲击现有结构）。本轮 E3 落地为「HTTP method/path/params + baseUrl/headers/auth 兜底」。

### 3.4 stateMap 初始派生

- 来源：specs.json 的 `observe_<stateName>` 观测接口（state 派生），mapping 规则：`{ "<stateId>": "<stateName>" }`
- 兜底：若 specs.json 无 state 观测接口（如纯不变量协议）→ stateMap 空 + warning
- 人工补全：stateMap 是 `Record<string, string>`（stateId → 系统对外暴露的状态值），如 `{S1:'offline',S2:'online'}`。骨架给出协议侧默认映射，人工补系统侧

## 4. mergeBindings(skeleton, manual) 设计

```ts
// src/binder/index.ts 新增
export function mergeBindings(
  skeleton: SkeletonBindings,
  manual: BindingConfig
): BindingConfig {
  // 1. roles 合并：manual.roles 优先（人工填的 baseUrl/headers/auth 覆盖 skeleton 默认）
  // 2. interfaces 合并：按 action 匹配
  //    - manual 中 action 已在 skeleton → 用 manual 条目（人工可改 method/path/transport）
  //    - manual 中 action 不在 skeleton → 保留 manual（向后兼容老 bindings.yaml）
  //    - skeleton 中 action 不在 manual → 保留 skeleton（新增接口自动获得绑定）
  // 3. stateMap 合并：manual.stateMap 优先（人工确认的系统词）
  // 4. 顺序：interfaces 中「skeleton-only 条目排在 manual-only 后」，保持可读性
}
```

**兼容性校验**：
- 老格式 bindings.yaml（无 `__protochain_skeleton__` 标记）→ `mergeBindings` 不调用，直接返回 manual
- 混合：若 manual 中 action 在 skeleton 存在但 transport.type 不同 → 不强制要求一致，仅 warning（允许人工为某接口选 Kafka 而 skeleton 默认 HTTP）

## 5. CLI 集成

```bash
protochain derive-bindings \
  --dir <project> \
  [--specs <path>]                  # 默认 derived/specs.json
  [--output <path>]                 # 默认 <dir>/derived/bindings.skeleton.yaml
  [--force]                         # 覆盖已存在骨架
```

输出：
- `derived/bindings.skeleton.yaml`：骨架（人工在此基础上编辑）
- `derived/bindings-generation-report.json`：统计报告（生成率 + 警告）
- 控制台：生成率 + 待确认项（baseUrl/headers/authConfig/stateMap 4 类）

`bind` 命令保持现状（接受 `__protochain_skeleton__: true` 的 skeleton 文件）；不传 `--skeleton` 时按老格式读 manual bindings。

## 6. 验收对应

| 验收 | 实现 |
|---|---|
| 40/40 接口条目生成 | `interfaces.length === specs.length` |
| 生成率 ≥ 80%（除 baseUrl/headers/authConfig/stateMap 外无需人工） | `stats.generationRate` 字段；测试用例 12 接口 HTTP 全部 generated（100%），40 接口同口径 |
| bind 校验通过 | 用 mergeBindings(skeleton, manual 填 baseUrl) 后跑 `validateBindings`，missingSystem=0 / missingObservation=0 |
| 老格式 specs.json 自动迁移后能推导骨架 | derive-bindings 走 `loadSpecsEnvelope`；envelope.source='array-migrated' 时打印迁移报警 |
| 老 bindings.yaml（无骨架）继续工作 | `bind` 命令不强制要求 skeleton 段；mergeBindings 仅在 skeleton 存在时调用 |
| hsk-ng 18 单运行通过 | 端到端：approval-flow 12 接口 → 12/12 generated；E3 范围不实际部署 hsk-ng（生成口径一致即可） |

## 7. 不在 E3 范围（明确不做）

- Kafka/NSQ/Grpc/DbQuery 机械推导（仅占位 TODO）—— 等 E5（TS client）+ E7（Web）联动
- responseMapping 字段引入（破坏现有 TransportBinding 类型；留 v0.5+）
- stateMap 自动从 impl 反向推断（impl 侧依赖外部服务，本轮无 schema）
- 增量更新（partial skeleton 合并）—— v0.5+ 增量骨架，按 `--force` 覆盖
- bindings.yaml 自身增量 schema（继续沿用现有 BindingConfig 类型）
