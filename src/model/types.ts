/**
 * 协议驱动自验证工具链 - 核心类型系统
 *
 * 设计依据：《协议驱动自验证工具链设计方案》第二节"规范表示"
 *
 * 核心原则：
 * - SourceProtocolModel 是单一权威源（含 metadata/readable/derivable）
 * - DerivedArtifacts 是投影产物，不可直接编辑
 * - 修改 derivable 才改变协议，DerivedArtifacts 由代码/AI 重新推导生成
 */

// ============================================================================
// 第一部分：源模型（权威源）
// ============================================================================

/**
 * 元数据层 —— 使用方的声明性意图
 * 工具链不解释，只透传与跟踪。变更类型声明影响 versioner 分类优先级。
 */
export interface MetadataLayer {
  /** 协议名称 */
  name: string;
  /** 协议版本号（语义化版本） */
  version: string;
  /** 协议意图的自然语言描述 */
  purpose: string;
  /** 参与角色列表（role id → 角色名） */
  roles: RoleDeclaration[];
  /** 使用方对变更类型的显式声明（优先级最高） */
  changeDeclarations?: ChangeDeclaration[];
  /** 待使用方确认的项（由 versioner 维护） */
  pendingConfirmations?: ConfirmableItem[];
  /** 活性语义声明：weak=弱活性（终态可达，默认）；strong=强活性（所有路径终达终态） */
  liveness?: LivenessMode;
}

/** 活性判定模式：weak=每个可达状态存在到达终态的路径；strong=所有路径最终到达终态 */
export type LivenessMode = 'weak' | 'strong';

export interface RoleDeclaration {
  id: string;
  name: string;
  /** 角色职责描述 */
  responsibilities?: string;
  // 扩展：角色类型
  roleType: 'consensus' | 'participant';   // 共识方 / 参与方
  /** 匿名参与方标注（如公网访问者） */
  anonymous?: boolean;
}

export interface ChangeDeclaration {
  /** 声明作用的元素 ID（如不变量 ID、状态 ID） */
  targetId: string;
  /** 使用方声明：paradigm_renegotiation | protocol_tweak */
  changeType: 'paradigm_renegotiation' | 'protocol_tweak';
  /** 声明理由 */
  reason: string;
}

/**
 * 可读层 —— 面向人阅读的协议描述
 * 不参与机械推导，但作为语义层检查与人工检查点的输入
 */
export interface ReadableLayer {
  /** 协议背景与目标 */
  background: string;
  /** 核心概念与术语 */
  concepts: ConceptDef[];
  /** 端到端协作流程描述（自然语言） */
  workflow: string;
  /** 异常处理原则 */
  exceptionHandling?: string;
}

export interface ConceptDef {
  term: string;
  definition: string;
}

/**
 * 可推演层 —— 权威源的核心，所有推导的输入
 *
 * 正常模式：结构化对象（states/transitions/invariants/timing）
 * 退化模式：degraded=true，formalSpecRaw 保留形式化语言原文，
 *           结构化字段为空或部分填充（策略B：尽可能提取）
 */
export interface DerivableLayer {
  /** 是否退化模式（形式化语言表达） */
  degraded: boolean;
  /** 退化模式下的形式化语言原文（如 TLA+ 源码） */
  formalSpecRaw?: string;
  /** 退化模式下的形式化语言类型 */
  formalLanguage?: 'tla' | 'scxml' | 'alloy' | 'decision-table' | 'unknown';

  /** 状态空间 */
  states: StateDef[];
  /** 转移规则 */
  transitions: TransitionDef[];
  /** 不变量 */
  invariants: InvariantDef[];
  /** 时序约束 */
  timing: TimingDef[];
  /** 异常路径（显式声明的非正常路径） */
  exceptions: ExceptionPathDef[];

  /** 初始状态 ID（必须指向 states 中的某个状态） */
  initialStateId?: string;
  /** 终态 ID 列表 */
  terminalStateIds: string[];
  // 扩展：可选声明段（按系统特征选用，均挂载在 DerivableLayer）
  resourcePools?: ResourcePoolDef[];
  instantiation?: InstantiationDef;
  externalEvents?: ExternalEventDef[];
  negativeAssurances?: NegativeAssuranceDef[];
  subsidiaryEntities?: SubsidiaryEntityDef[];
  /** 守卫翻译声明（协议侧权威源）：把自然语言守卫映射为可注入骨架的 TLA+ 片段 */
  guardTranslations?: GuardTranslationDef[];
  /**
   * G7-S5a（X9 / P1-5 判据11）：事务边界声明段（可选段「事务边界」解析产物）。
   * - undefined = 模型未启用该机制（老模型形态）→ 跨实体未声明事务边界走告警（迁移截止日 2026-09-30）；
   * - 非 undefined（含空数组）= 已启用（新模型形态）→ 跨实体未声明事务边界硬失败。
   */
  transactionBoundaries?: TransactionBoundaryDef[];
}

/**
 * 守卫翻译声明 —— 模型侧声明自然语言守卫的 TLA+ 表达方式。
 * 工具链不解释任何具体语义（不认识动作名/变量名），只按本声明机械拼接骨架：
 * 匹配到目标转移时，用 guardExpr 替换守卫占位，并把 prologue/initConjuncts/
 * nextDisjuncts/invariants/typeConjuncts 原样注入骨架对应位置。
 * 换协议只需在 model.md 改写本段，工具链无需变更。
 */
export interface GuardTranslationDef {
  /** 声明 ID（如 CT3） */
  id: string;
  /** 目标转移匹配：action 动作名（与 actions 二选一或并用） */
  action?: string;
  /** 目标转移匹配：动作名列表（一次声明覆盖多个动作，如 CT4 的 disable/deregister） */
  actions?: string[];
  /** 目标转移匹配：守卫包含的文本（进一步限定，可选） */
  guardContains?: string;
  /** 注入的 TLA+ 守卫表达式（替换原骨架守卫占位，如 "HasNoMappings"） */
  guardExpr: string;
  /** 骨架前导声明（VARIABLE / 谓词定义 / 抽象动作定义等），按行插入 VARIABLES 与 States 之间 */
  prologue: string[];
  /** Init 附加合取（如 "mappings = {}"） */
  initConjuncts: string[];
  /** Next 附加析取项（抽象动作调用，如 "AbstractMappingAdd"），插入转移析取之后 */
  nextDisjuncts: string[];
  /** 附加不变量（如 CT3Invariant），并入 AllInvariants */
  invariants: GuardInvariantDef[];
  /** TypeInvariant 附加合取（如 "mappings \\subseteq {1, 2}"） */
  typeConjuncts: string[];
  /** Spec 的 stuttering 变量元组（含守卫涉及的全部变量） */
  stutterVars: string[];
}

export interface GuardInvariantDef {
  id: string;
  expression: string;
}

// ============================================================================
// W1-b 关系断言（01-relations-modeling.md §3 W1-b 定案）
// ============================================================================

/**
 * W1-b 关系断言种类（仅三种；excludes 首版裁出，R1-1 定案）。
 * 断言 → 投影 kind → 比对口径映射表（NR1-2 定案）：
 * - depends_on（B 前置 A）→ sequence 投影存在 fromId=b、toId=a 条目
 * - sequence（A 先于 B）→ sequence 投影存在 fromId=a、toId=b 条目
 * - shares_invariant（A、B 共享不变量）→ invariant_scope 投影存在 scopeStateIds ⊇ {a, b} 条目
 * 不在映射表的断言种类（如 excludes）→ parser 拒绝解析并报硬错误（无映射即无校验）。
 */
export type RelationAssertionKind = 'depends_on' | 'sequence' | 'shares_invariant';

/**
 * W1-b 关系断言（人写声明，仅断言语义——不是关系事实源）。
 * 断言 a/b 的元素语义：depends_on / sequence 为转移 ID；shares_invariant 为状态 ID。
 * checker 机械层对照 buildRelations(model) 投影比对，不一致即硬失败。
 */
export interface RelationAssertion {
  id: string;
  kind: RelationAssertionKind;
  /** 关系元素 A（depends_on/sequence 为转移 ID；shares_invariant 为状态 ID） */
  a: string;
  /** 关系元素 B（depends_on/sequence 为转移 ID；shares_invariant 为状态 ID） */
  b: string;
  /** 可选说明（人读） */
  note?: string;
  /** 断言标记（恒 true：仅断言语义，关系永远由机械投影推导） */
  assert: true;
}

export interface StateDef {
  id: string;
  name: string;
  /** 状态类型 */
  type: 'initial' | 'normal' | 'terminal' | 'error';
  /** 状态语义描述 */
  description?: string;
  /** 进入该状态时成立的事实（可选，用于推导观测接口） */
  facts?: string[];
  /** 该状态关联的角色 ID 列表 */
  roleIds?: string[];
  // 扩展：多维度状态
  dimensions?: StateDimension[];
}

export interface StateDimension {
  name: string;
  type: string;                    // enum[...] 或基本类型
  initial: string | number | boolean;
  /** 声明该维度在何条件下有意义（与不变量联动） */
  validWhen?: string;
  /**
   * X1（P0-1）：维度 kind——declared=角色意图可写；observed=仅事实（system/external）可写。
   * 缺省 = 未标注，由 buildDimensionKinds 机械推导或走降级（dimension-kind-undetermined）。
   */
  kind?: 'declared' | 'observed';
  /** kind 来源：derived=机械推导（W(dim) 写入方集合）；asserted=人写断言（model.md 显式声明） */
  kindSource?: 'derived' | 'asserted';
}

export interface TransitionDef {
  id: string;
  name: string;
  /** 源状态 ID（多源转移支持逗号分隔，如 "S1,S2" → ["S1", "S2"]） */
  from: string[];
  /** 目标状态 ID */
  to: string;
  /** 触发动作名称（动作→系统接口的依据） */
  action: string;
  /** 触发该转移的角色 ID */
  triggerRoleId?: string;
  /** 守卫条件（布尔表达式文本） */
  guard?: string;
  /** 动作副作用描述（用于生成接口规格） */
  effects?: string[];
  /** 是否异常转移（异常路径的一部分） */
  isException?: boolean;
  // 扩展字段
  triggerType: 'role' | 'system' | 'external';   // 扩展
  trigger: string;                                // 角色ID | 'system' | 外部系统角色
  actionType: 'state_transition' | 'attribute_update';  // 扩展
  affectsDimensions: string[];                     // 扩展：影响哪些状态维度（attribute_update 时为空）
  /** 属性变更效果（actionType=attribute_update 时声明） */
  attributeEffects?: AttributeEffect[];
}

export interface AttributeEffect {
  field: string;
  operation: 'set' | 'increment' | 'append' | 'remove';
  value?: string;
}

export interface InvariantDef {
  id: string;
  name: string;
  /** 不变量表达式（形式化或半形式化文本） */
  expression: string;
  /** 作用状态 ID 列表（空表示全局不变量） */
  scopeStateIds?: string[];
  /** 不变量语义描述 */
  description?: string;
  /** 使用方声明该不变量需重协商（元数据声明覆盖） */
  declaredAsRenegotiation?: boolean;
  // 扩展
  declaredBy: string;                  // 必须是共识方角色ID
  invariantClass: 'intra_protocol' | 'cross_protocol' | 'cross_instance';  // 扩展
  // ── E4 扩展：数据级不变量声明 ──
  /**
   * 校验层级（默认 state-machine，由遗留 model.md 无 level 列时补全）：
   * - state-machine：进入 TLA+ 形式化验证；
   * - data：数据级（SQL/存储相关），不进 TLA+，归入 formal-report.json 的
   *         `deferredToSqlValidation` 段，由 verify 的 SQL 校验路径承接。
   */
  level?: 'state-machine' | 'data';
  /**
   * 数据级不变量的"实现侧责任"分类：
   * - storage：保证来自数据库（schema 唯一约束/外键/类型检查等）；
   * - guard：保证来自业务代码守卫（impl.service.go 等）。
   * 仅 level=data 时有效。
   */
  source?: 'storage' | 'guard';
  /**
   * 数据级不变量关联的存储表名（仅 level=data && source=storage 时必填）。
   * 用于 verify 阶段生成"对该表该表达式的只读 SELECT"语句。
   */
  storageRef?: string;
  /**
   * P2-8（G7-S4）：不变量补救声明 —— 拆「检测方式」+「处置动作」。
   * - detection：如何检测违约（可机械消费 → 生成收敛断言用例 X12）；缺省 → 显式降级记录（不静默）。
   * - action：处置动作（自由文本，永远留给人看，不做机械消费）。
   * 老模型无此字段 → undefined（兼容零回归）。
   */
  remedy?: {
    /** 如何检测违约 —— 可生成断言（X12 收敛断言数据源）；缺省显式降级记录 */
    detection?: SchemaExpression;
    /** 处置动作 —— 自由文本，给人看 */
    action: string;
  };
}

export interface TimingDef {
  id: string;
  name: string;
  /** 时序约束类型 */
  type: 'response' | 'deadline' | 'timeout' | 'ordering' | 'continuous' | 'scheduled';
  /** 源事件（动作名或状态 ID） */
  source: string;
  /** 目标事件（动作名或状态 ID） */
  target: string;
  /** 约束值（毫秒，deadline/timeout 适用） */
  boundMs?: number;
  /** continuous: 违约时转移的目标状态ID */
  onViolation?: string;
  /** scheduled: 定时规则（cron 或自然语言） */
  schedule?: string;
  /** 自然语言描述 */
  description?: string;
}

export interface ExceptionPathDef {
  id: string;
  name: string;
  /** 异常触发条件 */
  trigger: string;
  /** 涉及的转移 ID 序列 */
  transitionIds: string[];
  /** 恢复策略 */
  recovery?: string;
  /**
   * E11：本异常路径对应的协议错误码（协议内唯一，snake_case）。
   * - 命名规则：`^[a-z][a-z0-9]*(_[a-z0-9]+)*$`
   * - 必须至少被一个契约层 contracts[].errorResponses 引用（闭合校验由 checker 负责）
   * 缺省视为兼容老协议（不报错）。
   */
  errorCode?: string;
}

// ============================================================================
// 可选声明段（扩展：按系统特征选用，挂载在 DerivableLayer）
// ============================================================================

export interface ResourcePoolDef {
  id: string;
  name: string;
  type: string;                       // 如 '(server_id, port) 二元组'
  capacity: string | number;          // 可为动态声明
  allocationRule: string;
  releaseRule: string;
  constraints: string[];
  checkMethod: string;
  /**
   * 资源池不变量映射到组合层跨协议不变量的 ID 列表。
   * 方法论要求：资源池不变量（如"同一 (server_id, port) 二元组不可被两个入口同时占用"）
   * 作为跨协议不变量在组合层声明，此字段记录映射关系。
   * checker 校验：每个 constraint 必须有对应的 crossInvariantId，否则标记为"待组合层声明"。
   */
  crossInvariantIds?: string[];
}

export interface InstantiationDef {
  type: 'template';
  instanceKey: string;                 // 如 'entry.id'
  instanceLifecycle: string;
  instanceInvariants: string[];
  crossInstanceInvariants: string[];  // ID 引用组合层的跨实例不变量
  crossInstanceInvariantsLocation: 'composition';
}

export interface ExternalEventDef {
  id: string;
  name: string;
  source: string;                      // 引用组合层 external_dependencies
  triggerAction: string;
  idempotencyKey?: string;
  ordering?: 'by_event_time' | 'by_arrival_time';
  onDelay?: string;
  onDuplicate?: string;
}

export interface NegativeAssuranceDef {
  id: string;
  name: string;
  expression: string;
  scope: string;
  declaredBy: string;                 // 必须是共识方
  checkMethod: string;
}

export interface SubsidiaryEntityDef {
  id: string;
  name: string;
  belongsTo: string;                  // 主实体引用，如 'entry（P2）'
  instanceKey: string;
  lifecycleDependency: string;
  cascadeRules: string[];
  stateSpace: { dimensions: StateDimension[] };
  invariants: string[];
}

/**
 * G7-S5a（X9 / P1-5 判据11）：事务边界声明 —— model.md 新增可选段「事务边界」。
 *
 * 语义：一条接口的 affectsDimensions 跨 ≥2 个实体（object/facet）时，其原子性/
 * 时间语义必须显式声明事务边界，否则无法判定多实体操作的一致性模型：
 * - same_transaction：同库事务内原子提交（相关 InvariantDef 可标 always）；
 * - async_compensation：跨实体异步补偿（相关不变量必须 eventually_within + boundMs，
 *   且必须存在对应 CompensationContract）。
 * 未声明 ⇒ 新模型硬失败；老模型（无事务边界段的模型）告警至迁移截止日 2026-09-30（决策 D-2）。
 */
export interface TransactionBoundaryDef {
  /** 声明 ID（如 TX1），协议内唯一 */
  id: string;
  /** 覆盖的接口名：与转移 action（或转移 id）对齐 */
  interface: string;
  /** 事务边界类型：同一事务 / 异步补偿 */
  boundaryType: 'same_transaction' | 'async_compensation';
  /** 可选说明（人读） */
  description?: string;
}

/**
 * 契约层 —— 从 Markdown 解析后用于一致性校验与 specifier 字段消费（E2.1）
 *
 * 设计决策：
 * - parties / expectedInformationFields 仍作为「校验输入」存在（E2 设计）
 * - contracts[] 是 E2.1 新增字段：每项对应一个 transition 派生接口，
 *   声明 requestSchema / responseSchema（结构化），specifier 据此消费
 */
export interface ContractLayerInput {
  /** 契约方（角色 ID 列表） */
  parties: string[];
  /** 期望的信息契约条目（用于校验推导出的契约是否覆盖） */
  expectedInformationFields?: string[];
  /**
   * E2.1：每个接口的契约条目（按 interface 名字 / sourceId 对齐）
   * - requestSchema / responseSchema 形态符合 JSON Schema（与 InterfaceSpec 同子集）
   * - preconditions / postconditions / sideEffects 可为结构化表达式或字符串列表
   * 缺省 → 不影响 specifier（兼容老协议）
   */
  contracts?: ContractEntry[];
}

/**
 * E11：单条接口错误响应契约（挂在契约层 contracts[].errorResponses）
 * - id: 契约内唯一（如 ERR-01）
 * - errorCode: 协议错误码，与 ExceptionPathDef.errorCode 对齐
 * - httpStatus: 期望传输状态码（4xx 业务错误；5xx 不在此声明，见 system_fault 边界）
 * - bodySchema: 错误体 JSON Schema（可被 ajv 编译）
 */
export interface ErrorResponseDef {
  id: string;
  errorCode: string;
  httpStatus: number;
  bodySchema?: JSONSchema;
  description?: string;
}

/**
 * E2.1：契约层单条接口契约
 * - interface: 与 transition.action 对齐的契约名（如 register / bind）
 * - requestSchema / responseSchema: 结构化字段定义（可被 ajv 编译）
 * - preconditions / postconditions / sideEffects: 可选结构化表达式（数组形式）
 * - errorResponses: E11 接口错误响应契约列表（每个 errorCode 引用异常路径声明的错误码）
 */
export interface ContractEntry {
  interface: string;
  /** 对应的源 ID（如 transitionId）；缺省等于 interface */
  sourceId?: string;
  requestSchema?: JSONSchema;
  responseSchema?: JSONSchema;
  preconditions?: SchemaExpression[];
  postconditions?: SchemaExpression[];
  sideEffects?: SchemaExpression[];
  /**
   * E11：接口错误响应契约（specifier 投影到 InterfaceSpec.errorResponses）
   * 缺省视为兼容老协议（不报错）。
   */
  errorResponses?: ErrorResponseDef[];
  /**
   * 接口分型声明 // C-4（10 §4）contract-layer declaration；TI2
   * 可选扩展：老协议无此键 → undefined（无声明，机械兜底由投影器负责）。
   */
  interfaceType?: InterfaceType;
  /** 可选描述 */
  description?: string;
}

/**
 * 源协议模型 —— 工具链所有操作的单一权威源
 */
export interface SourceProtocolModel {
  metadata: MetadataLayer;
  readable: ReadableLayer;
  derivable: DerivableLayer;
  /** 契约层输入（仅用于校验） */
  contractInput?: ContractLayerInput;
  /**
   * W1-b 关系断言（01 §3 W1-b 定案，T3 TC1 交付）。
   * - 可选声明段"关系断言"解析产物；仅断言语义（assert: true），不是关系事实源；
   * - checker 机械层（TC2）对照 buildRelations(model) 投影比对，不一致即硬失败；
   * - 无断言段 → 缺省（老 model.md 零回归）。
   */
  relationAssertions?: RelationAssertion[];
  /** 源文件路径 */
  sourcePath?: string;
  /** 解析时间戳 */
  parsedAt?: string;
}

// ============================================================================
// 组合层模型（新增）：composition.md 解析产物，独立的权威源
// ============================================================================

export interface CompositionModel {
  metadata: CompositionMetadata;
  dependencyGraph: DependencyGraph;
  crossInvariants: CrossInvariantDef[];
  crossTiming: CrossTimingDef[];
  externalDependencies: ExternalDependencyDef[];
  observationInterfaces: ObservationInterfaceDef[];
  objectStateFacets: ObjectStateFacetDef[];
  securityAssumptions: SecurityAssumptionDef[];
  /** 引用的子协议清单与版本 */
  subProtocols: SubProtocolRef[];
  sourcePath?: string;
  parsedAt?: string;
}

export interface CompositionMetadata {
  systemName: string;
  version: string;
  /** changeType 枚举（B1-I2 修复）：扩展接受 protocol_extend
   *  - protocol_tweak：常规修订（小版本号变更）
   *  - paradigm_renegotiation：范式重协商（破坏性，需要共识）
   *  - protocol_extend：协议扩展（迭代新增子协议；hsk-ng 迭代 17 引入）
   */
  changeType: 'protocol_tweak' | 'paradigm_renegotiation' | 'protocol_extend';
  previousVersion?: string;
}

export interface SubProtocolRef {
  protocolId: string;        // 如 'P2'
  name: string;
  version: string;
  modelPath: string;         // protocol/P2/model.md
}

export interface DependencyGraph {
  /** Mermaid 源码（人读） */
  mermaid: string;
  /** 结构化依赖关系（工具消费） */
  edges: DependencyEdge[];
}

export interface DependencyEdge {
  from: string;              // 子协议ID
  to: string;                // 子协议ID
  dependencyType: 'state' | 'event';
  description: string;
}

export interface CrossInvariantDef {
  id: string;
  name: string;
  span: string[];           // 子协议ID列表，如 ['P1', 'P2']
  expression: string;
  declaredBy: string;       // 共识方
  checkMethod: string;
  /** 量词复杂度（决定检查策略：纯代码 vs 代码+AI） */
  complexity: 'simple_boolean' | 'first_order';
}

export interface CrossTimingDef {
  id: string;
  name: string;
  rule: string;
  span: string[];
  boundMs?: number;
}

export interface ExternalDependencyDef {
  system: string;
  direction: 'event_sync' | 'login_receipt' | 'query';
  protocol: string;         // 关联的子协议ID
  syncSemantics: string;
  syncCharacteristics: string[];
  compensation: string[];
  impactOnFailure: string;
  /** direction=query 时必须引用一个观测接口ID */
  queryObservationInterfaceId?: string;
}

export interface ObservationInterfaceDef {
  id: string;
  name: string;
  observer: string;        // 角色ID或外部系统
  scope: string;
  permissionBoundary: string;
  readOnly: true;
  observable: ObservableField[];
}

export interface ObservableField {
  protocol: string;        // 子协议ID
  object: string;         // 如 'entry'
  fields: string[];
  filter?: string;
}

export interface ObjectStateFacetDef {
  object: string;
  idKey: string;
  facets: FacetRef[];
  crossFacetConstraints: CrossFacetConstraint[];
}

export interface FacetRef {
  protocol: string;
  dimensions: string[];
  description: string;
}

export interface CrossFacetConstraint {
  expression: string;
  /** 该约束可追溯到的不变量ID */
  tracesToInvariantId: string;
}

export interface SecurityAssumptionDef {
  id: string;
  assumption: string;
  description: string;
  impactIfViolated: string;
}

// ============================================================================
// ① 阶段跨协议引用标记（子协议 checker 收集，①-C 阶段校验）
// ============================================================================

export interface PendingCrossProtocolRef {
  /** 引用所在字段（如 'TransitionDef.trigger' / 'SubsidiaryEntityDef.belongsTo'） */
  sourceField: string;
  /** 引用的目标 ID（如 'P2.entry' / 外部系统名） */
  targetRef: string;
  /** 引用类型：跨协议 / 引用组合层 */
  refType: 'cross_protocol' | 'composition';
}

// ============================================================================
// 第二部分：派生产物（投影/推导产出，不可直接编辑）
// ============================================================================

/**
 * 派生产物集合 —— 所有自动生成的产出物
 */
export interface DerivedArtifacts {
  completeness?: CompletenessReport;
  reasoning?: ReasoningReport;
  formal?: FormalReport;
  specs?: InterfaceSpec[];
  contracts?: ContractSet;
  testTool?: TestToolCode;
  testCases?: TestCaseSet;
  implCheck?: ImplCheckReport;
  verification?: VerificationReport;
  diff?: ModelDiff;
  impact?: ImpactAnalysis;
  // 扩展产物
  compositionCompleteness?: CompositionCompletenessReport;     // ①-C
  crossInvariantReport?: CrossInvariantReport;                  // ②-C
  crossFormalReport?: FormalReport;                            // ③-C（复用 FormalReport）
  crossContracts?: CrossContractSet;                           // ④-C
  crossTestCases?: CrossTestCaseSet;                           // ⑦-C
}

// ----------------------------------------------------------------------------
// ① 完备性检查报告
// ----------------------------------------------------------------------------

export interface CompletenessReport {
  /** 机械层检查结果（代码执行） */
  mechanical: MechanicalCheckResult;
  /** 语义层检查结果（AI 执行） */
  semantic: SemanticCheckResult;
  /** 总体是否通过 */
  passed: boolean;
  /** ① 阶段标记的跨协议引用（①-C 阶段在 composition-checker 统一校验） */
  pendingCrossProtocolRefs?: PendingCrossProtocolRef[];
  /** 检查时间戳 */
  checkedAt: string;
}

export interface MechanicalCheckResult {
  passed: boolean;
  /** 结构完备性问题 */
  structuralIssues: CheckIssue[];
  /** 字段完整性问题 */
  fieldIssues: CheckIssue[];
  /** ID 交叉引用问题 */
  referenceIssues: CheckIssue[];
}

export interface SemanticCheckResult {
  passed: boolean;
  /** 语义重复问题 */
  duplicationIssues: CheckIssue[];
  /** 表达式歧义问题 */
  ambiguityIssues: CheckIssue[];
  /** 独立语义判断问题 */
  semanticIssues: CheckIssue[];
  /** 是否已执行（AI 未配置时为 false） */
  executed: boolean;
  /**
   * 语义层是否为 advisory（仅提示、不阻断）性质。
   * true：结论由 AI 判定（非确定性），只作人工参考，不参与 check 的 passed 硬门判定。
   * 解决 AI 判定跨 run 漂移导致的 check passed 翻转（问题清单 #10）。
   */
  advisory?: boolean;
}

export interface CheckIssue {
  /** 问题严重级别 */
  severity: 'error' | 'warning' | 'info';
  /** 问题类别 */
  category: string;
  /** 问题描述 */
  message: string;
  /** 关联元素 ID */
  elementId?: string;
  /** 关联元素路径（如 "states[2].name"） */
  elementPath?: string;
  /** 建议修复方式 */
  suggestion?: string;
}

// ----------------------------------------------------------------------------
// ② AI 推演报告
// ----------------------------------------------------------------------------

export interface ReasoningReport {
  passed: boolean;
  /** 可达性分析 */
  reachability: ReachabilityResult;
  /** 死锁分析 */
  deadlock: DeadlockResult;
  /** 活性分析 */
  liveness: LivenessResult;
  /** 一致性分析 */
  consistency: ConsistencyResult;
  /** AI 推演原始输出（供人工仲裁） */
  rawOutput?: string;
  /** 推演时间戳 */
  reasonedAt: string;
}

export interface ReachabilityResult {
  passed: boolean;
  /** 不可达状态 ID 列表 */
  unreachableStates: string[];
  /** 不可达转移 ID 列表 */
  unreachableTransitions: string[];
  notes?: string;
}

export interface DeadlockResult {
  passed: boolean;
  /** 死锁状态 ID 列表（无出边且非终态） */
  deadlockStates: string[];
  notes?: string;
}

export interface LivenessResult {
  passed: boolean;
  /** 无法最终到达终态的路径描述 */
  violations: string[];
  notes?: string;
  /** 判定所用的活性模式（weak/strong） */
  mode?: LivenessMode;
}

export interface ConsistencyResult {
  passed: boolean;
  /** 不变量冲突描述 */
  violations: string[];
  notes?: string;
}

// ----------------------------------------------------------------------------
// ③ 形式化验证报告
// ----------------------------------------------------------------------------

export interface FormalReport {
  passed: boolean;
  /** 选用的形式化工具 */
  tool: string;
  /** 工具适合度评分（0-1） */
  suitabilityScore: number;
  /** 生成的形式化规格源码 */
  generatedSpec: string;
  /** 规格文件路径（如 derived/formal/model.tla） */
  specFilePath?: string;
  /** 验证结果原始输出 */
  rawOutput?: string;
  /** 工具是否真实执行并产出验证结论（undefined/false = 占位或降级为 AI） */
  toolExecuted?: boolean;
  /** 不变量验证结果 */
  invariantResults: InvariantVerifyResult[];
  /**
   * E4：被推迟到 SQL 校验的数据级不变量列表（level=data）。
   * 这些项不进入 TLA+；verify 阶段由 SQL 校验路径（src/sqlcheck/）承接。
   */
  deferredToSqlValidation?: DeferredSqlInvariant[];
  /** 验证时间戳 */
  verifiedAt: string;
}

/** E4：被推迟到 SQL 校验路径的数据级不变量条目（formal-report.json 段） */
export interface DeferredSqlInvariant {
  invariantId: string;
  expression: string;
  source: 'storage' | 'guard';
  storageRef?: string;
  scopeStateIds?: string[];
}

export interface InvariantVerifyResult {
  invariantId: string;
  passed: boolean;
  /** 反例（若失败） */
  counterexample?: string;
}

// ----------------------------------------------------------------------------
// ⑤ 接口规格（动作→系统接口，状态/不变量→观测接口）
// ----------------------------------------------------------------------------

export interface InterfaceSpec {
  /** 接口 ID */
  id: string;
  /** 接口类型 */
  kind: 'system' | 'observation';
  /** 关联的动作名（系统接口）或状态/不变量 ID（观测接口） */
  sourceId: string;
  /** 接口名称 */
  name: string;
  /** 输入参数 */
  inputs: FieldSpec[];
  /** 输出参数 */
  outputs: FieldSpec[];
  /** 前置条件（守卫条件投影） */
  precondition?: string;
  /** 后置条件（effects 投影） */
  postconditions?: string[];
  /** 关联的不变量 ID 列表（观测接口适用） */
  invariantIds?: string[];
  /** 是否退化模式下生成（标注"代码+AI"） */
  degradedAssist?: boolean;
  // 扩展字段（派生产物字段可选：取决于生成器策略）
  actionType?: 'state_transition' | 'attribute_update';   // 扩展
  triggerType?: 'role' | 'system' | 'external';           // 扩展
  affectsDimensions?: string[];                            // 扩展
  /** 资源池可用性观测接口 */
  observesResourcePoolId?: string;
  // -----------------------------------------------------------------------------
  // E2 (specs.json 升级到 JSON Schema) 扩展字段
  // -----------------------------------------------------------------------------
  /** 请求参数 JSON Schema（可被 ajv 编译）。缺省视为 description-only，标记 legacy-stub */
  requestSchema?: JSONSchema;
  /** 响应体 JSON Schema（可被 ajv 编译） */
  responseSchema?: JSONSchema;
  /** 结构化前置条件表达式（每项 kind='json-schema'|'legacy-stub'|'description-only'） */
  preconditions?: SchemaExpression[];
  /** 结构化后置条件表达式（effects 投影） */
  postconditionExpressions?: SchemaExpression[];
  /** 结构化副作用表达式（与 postconditions 等价，便于消费方识别） */
  sideEffects?: SchemaExpression[];
  /** schema 完整度分类 */
  schemaKind?: 'structured' | 'legacy-stub' | 'description-only';
  /** 降级理由列表（如 'guard 自然语言未机械提取'） */
  schemaDegradedReasons?: string[];
  /**
   * E2.1：契约层字段消费来源标识（contracts[] 中对应的 interface 名）。
   * 若该字段非空，表示该 spec 的 requestSchema/responseSchema 由契约层提供
   * （schemaKind 通常为 structured）。缺省表示按 guard 派生（兼容老协议）。
   */
  contractSource?: string;
  /**
   * E11：接口错误响应契约（契约层 contracts[].errorResponses 投影）。
   * - 字段形态：每个错误响应含 id/errorCode/httpStatus/bodySchema
   * - binder 校验时「specs.errorResponses[].errorCode 必须全部命中 bindings.errorMap」
   * - verifier 按 errorMap 归类（命中/未命中/5xx → system_fault）
   * 缺省视为兼容老协议（无错误契约）。
   */
  errorResponses?: ErrorResponseDef[];
  /**
   * E11 后续问题 5：契约承载接口标记。
   * - true 表示该 spec 是「未匹配任何 transition 的契约」的承载接口
   *   （contract.interface 找不到对应 transition.id/action 时由 specifier 派生），
   *   用于把契约 errorResponses / requestSchema / responseSchema 投影到 specs，
   *   补齐 errorMap 缺口。
   * - kind 仍为 system，但 sourceId 与 transition 解耦；不入状态机推演。
   * - 缺省视为正常状态机系统接口。
   */
  isContractCarrier?: boolean;
  /**
   * 接口分型声明投影 // C-4（10 §4）projection of contract-layer declaration
   * - 搬运契约层 ContractEntry.interfaceType（权威声明，10 §3-2）；无声明 → undefined
   * - specs/WebDataJson 1.0 schemaVersion 不变（可选扩展字段）
   */
  declaredInterfaceType?: InterfaceType;
}

// ============================================================================
// JSON Schema 子集（E2 新增；不复用社区类型以避免重型依赖）
// 与 ajv 8 兼容：type/properties/required/items/enum/description/format/default
// ============================================================================

export interface JSONSchema {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  enum?: unknown[];
  description?: string;
  format?: string;
  default?: unknown;
  additionalProperties?: boolean | JSONSchema;
  /** 数组场景下的最小/最大元素数（约束次数） */
  minItems?: number;
  maxItems?: number;
  // ── W2 谓词翻译扩展（07-execution-T3 TC3）──
  /** 字符串最小长度（nonEmpty 谓词） */
  minLength?: number;
  maxLength?: number;
  /** 正则模式（matchesPattern 谓词） */
  pattern?: string;
  /** 数值下界（nonNegative 谓词） */
  minimum?: number;
  maximum?: number;
  /** 数组元素唯一（unique 谓词；数据级不变量直连 E4 SQL 校验生成器） */
  uniqueItems?: boolean;
  /** 常量相等（跨字段相等约束的结构承载，可选） */
  const?: unknown;
}

/**
 * 结构化表达式 —— guard/effects/precondition/postcondition 统一形态（E2）
 */
export interface SchemaExpression {
  kind: 'json-schema' | 'description-only' | 'legacy-stub';
  /** 自然语言说明；任何 kind 下都保留，作为人读入口 */
  description?: string;
  /** 结构化子文档；kind='json-schema' 时填 */
  schema?: JSONSchema;
}

export interface FieldSpec {
  name: string;
  type: string;
  description?: string;
  required?: boolean;
}

// ----------------------------------------------------------------------------
// ④ 契约集（规格在协作边界的投影，四层契约）
// ----------------------------------------------------------------------------

export interface ContractSet {
  /** 契约方（角色组合） */
  parties: string[];
  /** 信息契约 */
  information: InformationContract;
  /** 时序契约 */
  timing: TimingContract;
  /** 约束契约 */
  constraint: ConstraintContract;
  /** 不变量契约 */
  invariant: InvariantContract;
}

export interface InformationContract {
  /** 各方需提供的字段 */
  fields: ContractField[];
  /** 信息流向（from → to → field） */
  flows: InformationFlow[];
}

export interface ContractField {
  name: string;
  type: string;
  providedBy: string;
  consumedBy: string[];
  description?: string;
}

export interface InformationFlow {
  from: string;
  to: string;
  fieldName: string;
  triggerAction?: string;
}

export interface TimingContract {
  /** 时序约束的契约投影 */
  constraints: TimingContractEntry[];
}

export interface TimingContractEntry {
  timingId: string;
  type: TimingDef['type'];
  source: string;
  target: string;
  boundMs?: number;
  /** 受约束的契约方 */
  parties: string[];
}

export interface ConstraintContract {
  /** 守卫条件的契约投影 */
  guards: GuardContractEntry[];
}

export interface GuardContractEntry {
  transitionId: string;
  action: string;
  guard?: string;
  /** 受约束的契约方 */
  parties: string[];
}

export interface InvariantContract {
  /** 不变量的契约投影 */
  invariants: InvariantContractEntry[];
}

export interface InvariantContractEntry {
  invariantId: string;
  expression: string;
  /** 相关契约方 */
  parties: string[];
  /** AI 辅助判断的相关性说明 */
  relevanceNote?: string;
  /** 是否退化模式下 AI 辅助 */
  degradedAssist?: boolean;
}

// ----------------------------------------------------------------------------
// ⑥ 测试工具代码
// ----------------------------------------------------------------------------

export interface TestToolCode {
  /** 场景加载器源码 */
  scenarioLoader: string;
  /** 协议执行器源码 */
  protocolExecutor: string;
  /** 一致性断言器源码 */
  consistencyAsserter: string;
  /** 协议模型源码（从 SourceProtocolModel 生成） */
  protocolModel: string;
  /** 生成时间戳 */
  generatedAt: string;
}

/**
 * test-tool 可执行入口契约（阶段 A）：
 * 生成产物（derived/test-tool/）经 loader 编译/import 后，暴露统一执行入口——
 * protocol-executor 的 `executePath(transitionIds, implementation)`（按转移 ID 执行，
 * 绕开同名动作索引丢键）与 protocol-model 的 `TRANSITIONS`（转移表，供用例映射）。
 */
export interface TestToolModule {
  /** 编译后的 protocol-executor 模块（契约：executePath(transitionIds, implementation)） */
  executor: {
    executePath: (
      transitionIds: string[],
      implementation: ProtocolImplementationStubShape,
    ) => Promise<TestToolPathOutcome>;
    [key: string]: unknown;
  };
  /** 编译后的 protocol-model 模块（契约：导出 TRANSITIONS） */
  model: { TRANSITIONS: Array<{ id: string; action: string; from: string[]; to: string }> };
  /** 编译后的 scenario-loader / consistency-asserter 模块 */
  scenarioLoader: unknown;
  consistencyAsserter: unknown;
  /** 生成文件清单（meta.json.files） */
  toolFiles: string[];
  generatedAt?: string;
}

/** ProtocolImplementation 的形态约束（executePath 收到的实现对象） */
export interface ProtocolImplementationStubShape {
  [action: string]: (currentState: string) => Promise<{ nextState: string; effects?: string[] }>;
}

/** executePath 逐条用例的返回形态（ConsistencyResult 子集） */
export interface TestToolPathOutcome {
  passed: boolean;
  error?: string;
  finalState?: string;
  [key: string]: unknown;
}

/** test-tool 消费记录的用例级结果 */
export interface TestToolCaseResult {
  pathId: string;
  passed: boolean;
  error?: string;
}

/** test-tool 消费报告（verify 权威层的证据来源） */
export interface TestToolRunReport {
  consumed: true;
  executedCases: number;
  passedCases: number;
  failedCases: number;
  caseResults: TestToolCaseResult[];
  toolFiles: string[];
  generatedAt?: string;
}

// ----------------------------------------------------------------------------
// ⑦ 测试用例集 + 覆盖度报告
// ----------------------------------------------------------------------------

export interface TestCaseSet {
  /** 协议路径用例 */
  paths: ProtocolPath[];
  /** 覆盖度报告 */
  coverage: CoverageReport;
  /** 生成时间戳 */
  generatedAt: string;
  /**
   * G7-S4（X5/X6/X12）：对抗性用例（observed 直写违例 / guard 失败后状态不变 / 收敛断言）。
   * 缺省 = 老行为（无对抗用例）。
   */
  adversarialCases?: AdversarialCase[];
  /**
   * G7-S4：差额降级记录（R4）与检测缺省降级（P2-8）。
   * 用例数 < 理论上限的差额必须在此显式记录，不得静默。
   */
  degradedReasons?: string[];
}

/** G7-S4 对抗性用例种类 */
export type AdversarialCaseKind = 'observed-write' | 'guard-failure' | 'convergence';

/**
 * G7-S4：单条对抗性用例（X5 / X6 / X12）。
 * body 为可执行测试脚本（.test.ts 形态）；X6 用例 body 头部必须含 R5 冻结边界声明
 * （mock 掉调度器/定时器），否则视为未完成任务。
 */
export interface AdversarialCase {
  id: string;
  kind: AdversarialCaseKind;
  /** 数据源定位（model.md 声明）——J2 旅程验收：失败信息能指回具体声明 */
  source: string;
  /** 被测接口/转移标识（如 transition action 或不变量 ID） */
  interfaceId: string;
  /** X5/X6：期望调用必须失败 */
  expectFailure?: boolean;
  /** X6：调用前须快照并断言取值完全一致的维度（affectsDimensions 投影） */
  stateImmutableDimensions?: string[];
  /** X6：被置否的合取项序号（0 基） */
  negatedConjunct?: number;
  /** X6：被置否的合取项原文 */
  conjunctText?: string;
  /** X12：制造违约的说明（不变量表达式原文） */
  violation?: string;
  /** X12：收敛等待上限（boundMs，来自关联时序约束；缺省=未声明） */
  boundMs?: number;
  /** X12：收敛断言（remedy.detection 原文） */
  detection?: string;
  /** 用例文件正文（可执行测试脚本；X6 头部含 R5 冻结边界声明） */
  body: string;
}

export interface ProtocolPath {
  id: string;
  /** 路径上的转移 ID 序列 */
  transitionIds: string[];
  /** 路径上的状态 ID 序列 */
  stateIds: string[];
  /** 路径长度 */
  length: number;
  /** 是否含异常路径 */
  hasException?: boolean;
  /** 路径描述 */
  description?: string;
}

export interface CoverageReport {
  /** 覆盖度准则 */
  criterion: 'state' | 'transition' | 'path';
  /** 状态覆盖情况 */
  stateCoverage: CoverageDetail;
  /** 转移覆盖情况 */
  transitionCoverage: CoverageDetail;
  /** 路径覆盖情况（可选） */
  pathCoverage?: CoverageDetail;
  /** 未覆盖项的处置建议 */
  uncoveredDispositions: UncoveredDisposition[];
  /** 最大路径长度限制（路径覆盖准则时） */
  maxPathLength?: number;
}

export interface CoverageDetail {
  total: number;
  covered: number;
  coveredIds: string[];
  uncoveredIds: string[];
  ratio: number;
}

export interface UncoveredDisposition {
  elementId: string;
  elementType: 'state' | 'transition' | 'path';
  /** 处置方式：冗余规则删除 / 遗漏场景补充 / 低频异常保留 */
  disposition: 'redundant_delete' | 'missing_supplement' | 'low_frequency_keep';
  reason: string;
}

// ----------------------------------------------------------------------------
// ⑧ 实现完整性检查报告
// ----------------------------------------------------------------------------

export interface ImplCheckReport {
  passed: boolean;
  /** 接口存在性检查结果 */
  interfaceChecks: InterfaceCheck[];
  /** 检查时间戳 */
  checkedAt: string;
}

export interface InterfaceCheck {
  interfaceId: string;
  interfaceName: string;
  /** 是否在实现中找到 */
  found: boolean;
  /** 实现位置（如文件:行号） */
  location?: string;
  /** 缺失原因 */
  missingReason?: string;
}

// ----------------------------------------------------------------------------
// ⑩ 一致性验证报告
// ----------------------------------------------------------------------------

export interface VerificationReport {
  /** 权威层：结构化测试结果（代码生成） */
  authoritative: AuthoritativeVerification;
  /** 可选辅助层：自然语言摘要（AI 生成，非权威） */
  auxiliary?: AuxiliarySummary;
  // ── E4 扩展：数据级不变量 SQL 校验 + by-design 段 ──
  /**
   * 数据级不变量 SQL 校验结果段：
   * - ran：是否实际跑了 SQL 校验（false 表示 --skip-sql-check 或 storage 未连接）；
   * - skippedReason：跳过的具体原因；
   * - items：每条数据级不变量的校验结果。
   */
  sqlInvariantCheck?: SqlInvariantCheckReport;
  /**
   * 由 impl 守卫保证、工具链不可消除的不可测试项（level=data && source=guard）。
   * E4 验收要求：在 verify 报告中显式列出，不静默。
   */
  byDesignNotTestedByToolchain?: ByDesignNotTestedItem[];
  /**
   * E11：错误契约验证汇总（按错误码 / 未命中 / 系统故障聚合）。
   * - matched：errorCode → 命中 errorMap 且符合契约/期望 的次数
   * - unmapped：未命中 errorMap 的错误响应（error_mismatch 偏差）
   * - systemFault：5xx/504 计数（不建模为业务错误，可观测可报告）
   * 缺省视为兼容老协议。
   */
  errorSummary?: ErrorSummary;
  /** 验证时间戳 */
  verifiedAt: string;
}

/**
 * E11：错误契约验证汇总段。
 * - matched：errorCode → 命中 errorMap 次数
 * - unmapped：未命中的错误响应（按 action 记）
 * - systemFault：5xx/504 系统故障计数（与业务错误分开统计）
 * - expected：场景层声明的期望错误（scenario.expectedError）统计
 */
export interface ErrorSummary {
  matched: Record<string, number>;
  unmapped: Array<{ action: string; httpStatus?: number; protocolErrorCode?: string; systemCode?: unknown }>;
  systemFault: number;
  /** 期望错误命中：场景层 expectedError 命中数；用于"错误场景断言通过"统计 */
  expected?: Record<string, number>;
}

/** E4：SQL 校验报告 */
export interface SqlInvariantCheckReport {
  /** 是否真实跑了 SQL 校验 */
  ran: boolean;
  /** 跳过原因（ran=false 时必填） */
  skippedReason?: string;
  /** 真实执行的连接（Dsn / Driver 脱敏形式；不暴露密码） */
  connection?: { driver: 'mysql' | 'postgres'; host: string; port: number; database: string };
  /** 各条 SQL 校验条目 */
  items: SqlInvariantCheckItem[];
}

/** E4：单条 SQL 校验条目 */
export interface SqlInvariantCheckItem {
  invariantId: string;
  passed: boolean;
  /** 生成的只读 SELECT 语句（脱敏后或原样，记日志用） */
  sql: string;
  /** 实际查询结果行数（COUNT/SUM 等聚合返回 1 行；UNIQUE 违反返回违反计数） */
  rowCount?: number;
  /** 失败的说明（如：UNIQUE 违反 → 重复行数） */
  failureReason?: string;
}

/** E4：by-design 段条目（impl 守卫保证，工具链不可消除） */
export interface ByDesignNotTestedItem {
  invariantId: string;
  expression: string;
  reason: string;
  /** 守卫所在的源码位置（人工登记，例如 "service.go L695-707"） */
  guardLocation?: string;
}

export interface AuthoritativeVerification {
  passed: boolean;
  /** 通过/失败/跳过计数 */
  counts: { passed: number; failed: number; skipped: number };
  /** 每个测试用例的结果 */
  caseResults: CaseResult[];
  /** 场景相关告警（如声明了场景但无路径命中） */
  scenarioWarnings?: string[];
  /** test-tool 消费记录（阶段 B 证据：本次验证确由生成测试工具执行） */
  testTool?: {
    consumed: true;
    executedCases: number;
    passedCases: number;
    failedCases: number;
    toolFiles: string[];
    generatedAt?: string;
  };
}

export interface CaseResult {
  pathId: string;
  passed: boolean;
  skipped?: boolean;
  /** 偏差详情（失败时） */
  deviations?: Deviation[];
  /** 命中的场景 id（未命中为 null；未声明场景为 undefined） */
  scenarioMatch?: { id: string } | null;
  /** 实际注入的运行时参数来源明细（key → 'scenario' | 'response'） */
  injectedParams?: Record<string, 'scenario' | 'response'>;
  /** 是否含降级信任（无观测绑定且信任协议预期/响应 nextState 而通过） */
  degraded?: boolean;
  /** 参数注入/场景冲突告警（如数组参数注入、种子字段覆盖响应注入被跳过） */
  warnings?: string[];
}

export interface Deviation {
  /** 偏差发生的动作 */
  action: string;
  /** 偏差发生的状态 */
  state: string;
  /** 协议预期值 */
  expected: string;
  /** 实际值 */
  actual: string;
  /**
   * 偏差类型。
   * - state_mismatch / invariant_violation / timing_violation / missing_action / field_mismatch：原有
   * - error_mismatch（E11）：错误响应未命中 errorMap（业务错误未声明或字段名不匹配）
   * - unexpected_error（E11）：该步场景期望成功，但实际收到业务错误
   */
  kind:
    | 'state_mismatch'
    | 'invariant_violation'
    | 'timing_violation'
    | 'missing_action'
    | 'field_mismatch'
    | 'error_mismatch'
    | 'unexpected_error';
  /** 路径内失败步骤索引（0-based；setup 阶段为 -1） */
  stepIndex?: number;
  /** 传输层状态码（HTTP 等） */
  httpStatus?: number;
  /** 响应体摘要（超长截断） */
  responseBody?: unknown;
  // ── E2 字段级偏差扩展 ──
  /** 业务字段路径（如 "response.approver_id"）；field_mismatch 时填 */
  field?: string;
  /** 协议侧（legacy）字段值（来自 specs.json responseSchema 描述） */
  legacy?: string;
  /** impl 侧字段值（来自实际响应） */
  impl?: string;
}

export interface AuxiliarySummary {
  /** 自然语言摘要 */
  summary: string;
  /** 偏差分类 */
  deviationCategories?: string[];
}

// ----------------------------------------------------------------------------
// 迭代支持：差分与影响分析
// ----------------------------------------------------------------------------

export interface ModelDiff {
  /** 元数据层差异 */
  metadataChanges: FieldChange[];
  /** 可读层差异 */
  readableChanges: FieldChange[];
  /** 可推演层差异 */
  derivableChanges: DerivableChange[];
  /** 差分时间戳 */
  diffedAt: string;
}

export interface FieldChange {
  path: string;
  kind: 'added' | 'removed' | 'modified';
  oldValue?: string;
  newValue?: string;
}

export interface DerivableChange {
  elementType: 'state' | 'transition' | 'invariant' | 'timing' | 'exception';
  elementId: string;
  kind: 'added' | 'removed' | 'modified';
  /** 字段级变更（如不变量表达式） */
  fieldChanges?: FieldChange[];
  /** 是否需要 AI 语义等价判断（不变量表达式变更） */
  needsSemanticJudgment?: boolean;
}

export interface ImpactAnalysis {
  /** 受影响的下游步骤 */
  affectedSteps: StepId[];
  /** 受影响的派生产物 */
  affectedArtifacts: string[];
  /** 建议的增量重推导路径 */
  incrementalPlan: StepId[];
  /** 分析时间戳 */
  analyzedAt: string;
}

// ----------------------------------------------------------------------------
// 变更分类
// ----------------------------------------------------------------------------

export type ChangeType = 'paradigm_renegotiation' | 'protocol_tweak';

export interface ChangeClassification {
  /** 变更类型 */
  changeType: ChangeType;
  /** 触发原因（自然语言） */
  reason: string;
  /** 触发规则 */
  triggeredBy: Array<
    | 'role_change'
    | 'structural_change'
    | 'invariant_semantic_change'
    | 'invariant_expression_change_pending'
    | 'metadata_declaration'
    | 'default'
  >;
  /** 受影响元素 ID 列表 */
  affectedElements: string[];
}

// ----------------------------------------------------------------------------
// 版本快照
// ----------------------------------------------------------------------------

export interface VersionSnapshot {
  /** 版本号 */
  version: string;
  /** 协议名称 */
  name: string;
  /** 快照文件相对路径 */
  snapshotPath: string;
  /** 保存时间戳 */
  savedAt: string;
}

// ============================================================================
// 组合层派生产物（①-C / ②-C / ④-C / ⑦-C）
// ============================================================================

export interface CompositionCompletenessReport {
  mechanical: MechanicalCheckResult;
  semantic: SemanticCheckResult;
  passed: boolean;
  /** ①-C 阶段校验的跨协议引用结果（汇总各子协议 ① 阶段标记的 pendingCrossProtocolRefs） */
  crossProtocolRefResults: CrossProtocolRefCheckResult[];
  checkedAt: string;
}

export interface CrossProtocolRefCheckResult {
  sourceProtocol: string;
  sourceField: string;
  targetRef: string;
  resolved: boolean;
  /** 未解析时的错误说明 */
  error?: string;
}

export interface CrossInvariantReport {
  passed: boolean;
  /** 每个跨协议不变量的检查结果 */
  results: CrossInvariantCheckResult[];
  /** 实例化的多协议状态摘要（用于复现） */
  instantiatedStateSummary: string;
  checkedAt: string;
}

export interface CrossInvariantCheckResult {
  invariantId: string;
  passed: boolean;
  /** 违反时的反例（具体的多协议状态组合） */
  counterexample?: string;
  /** 检查方式：纯代码 / 代码+AI */
  checkMethod: 'code' | 'code+ai';
}

export interface CrossContractSet {
  /** 跨协议边界的事件契约 */
  eventContracts: CrossEventContract[];
  /** 影响范围契约 */
  impactContracts: CrossImpactContract[];
  /** 补偿契约 */
  compensationContracts: CrossCompensationContract[];
  /** 跨协议时序契约（组合层 CrossTimingDef 的契约投影） */
  timingContracts: CrossTimingContract[];
}

export interface CrossTimingContract {
  id: string;
  /** 关联的组合层 CrossTimingDef.id */
  crossTimingId: string;
  span: string[];
  rule: string;
  boundMs?: number;
  /** 违约时的处理（如触发补偿契约） */
  onViolation?: string;
  /** 关联的补偿契约 ID（如有） */
  compensationContractId?: string;
}

export interface CrossEventContract {
  id: string;
  fromProtocol: string;
  toProtocol: string;
  event: string;
  information: ContractField[];
  timing?: CrossTimingDef;
}

export interface CrossImpactContract {
  id: string;
  sourceEvent: string;
  affectedProtocols: string[];
  expectedResponse: string;
}

export interface CrossCompensationContract {
  id: string;
  failureScenario: string;
  compensationAction: string;
  span: string[];
}

export interface CrossTestCaseSet {
  /** 跨协议路径用例 */
  paths: CrossProtocolPath[];
  coverage: CrossCoverageReport;
  generatedAt: string;
}

export interface CrossProtocolPath {
  id: string;
  /** 跨协议的路径片段序列 */
  segments: PathSegment[];
  /** 跨协议不变量检查点 */
  crossInvariantCheckpoints: string[];
  description?: string;
}

export interface PathSegment {
  protocolId: string;
  transitionIds: string[];
  stateIds: string[];
}

export interface CrossCoverageReport {
  /** 跨协议事件覆盖 */
  eventCoverage: CoverageDetail;
  /** 跨协议不变量覆盖 */
  invariantCoverage: CoverageDetail;
  uncoveredDispositions: UncoveredDisposition[];
}

// ============================================================================
// 第三部分：使用方确认跟踪
// ============================================================================

export interface ConfirmationTracker {
  /** 当前待确认项（只读视图） */
  pendingConfirmations: Confirmation[];
  /** 添加待确认项 */
  addPending(item: ConfirmableItem): void;
  /** 确认待确认项 */
  confirm(itemId: string, confirmedBy: string, note?: string): void;
  /** 拒绝待确认项 */
  reject(itemId: string, reason: string, rejectedBy?: string): void;
  /** 获取所有待确认项 */
  getPending(): Confirmation[];
}

export interface Confirmation {
  itemId: string;
  item: ConfirmableItem;
  status: 'pending' | 'confirmed' | 'rejected';
  confirmedBy?: string;
  note?: string;
  rejectReason?: string;
  /** 创建时间戳 */
  createdAt: string;
  /** 确认/拒绝时间戳 */
  confirmedAt?: string;
}

export type ConfirmableItem =
  | { type: 'invariant_declaration'; invariantId: string }
  | { type: 'paradigm_renegotiation'; versionRange: [string, string] }
  | { type: 'self_constructed_scenario'; scenarioId: string }
  | { type: 'utility_validation'; version: string }
  // 扩展
  | { type: 'cross_invariant_declaration'; invariantId: string; span: string[] }
  | { type: 'cross_invariant_renegotiation'; versionRange: [string, string]; span: string[] }
  | { type: 'negative_assurance_declaration'; assuranceId: string }
  | { type: 'security_assumption_change'; assumptionId: string };

// ============================================================================
// 第四部分：AI 适配器接口
// ============================================================================

export interface AIAdapter {
  /** 适配器名称 */
  name: string;
  /** 调用 AI 完成任务 */
  complete(prompt: AIPrompt): Promise<AIResponse>;
}

export interface AIPrompt {
  /** 角色与约束 */
  system: string;
  /** 可推演层结构化表示（JSON 字符串） */
  context: string;
  /** 具体任务 */
  instruction: string;
  /** 输出格式要求（含 JSON Schema） */
  outputFormat: string;
  /** 温度：推演 0.1，生成 0.3 */
  temperature: number;
}

export interface AIResponse {
  /** AI 输出文本 */
  content: string;
  /** 是否成功 */
  success: boolean;
  /** 错误信息（失败时） */
  error?: string;
  /** 尝试次数 */
  attempts?: number;
}

// ============================================================================
// 第五部分：形式化工具适配器接口
// ============================================================================

export interface FormalToolAdapter {
  /** 适配器名称 */
  name: string;
  /** 检测对协议模型的适合度（0-1，规则化实现） */
  detectSuitability(model: DerivableLayer): number;
  /** 生成形式化规格 */
  generateSpec(model: DerivableLayer): string;
  /** 调用工具验证 */
  verify(spec: string): Promise<FormalReport>;
  /** 解析验证报告 */
  parseReport(raw: string): Partial<FormalReport>;
}

// ============================================================================
// 第六部分：步骤依赖 DAG
// ============================================================================

export type StepId =
  | 'check'        // ① 完备性检查
  | 'reason'       // ② AI 推演
  | 'formalize'    // ③ 形式化验证
  | 'derive-specs' // ⑤ 规格推导
  | 'derive-contracts' // ④ 契约推导
  | 'generate-tests' // ⑥ 测试工具生成
  | 'generate-cases' // ⑦ 测试用例生成
  | 'check-impl'   // ⑧ 实现完整性检查
  | 'verify'       // ⑩ 一致性验证
  // 新增：组合层步骤
  | 'check-composition'        // ①-C
  | 'check-cross-invariants'   // ②-C
  | 'formalize-cross'          // ③-C
  | 'derive-cross-contracts'   // ④-C
  | 'generate-cross-cases';    // ⑦-C

export interface StepNode {
  id: StepId;
  /** 方法论编号（①②③等） */
  methodologyNumber: string;
  /** 步骤名称 */
  name: string;
  /** 执行方 */
  executor: 'code' | 'ai' | 'code+ai';
  /** 前置步骤 ID */
  dependsOn: StepId[];
  /** 是否需要人工检查点门控 */
  hasCheckpoint: boolean;
  /** 检查点状态 */
  checkpointStatus?: 'pending' | 'approved' | 'rejected' | 'skipped';
}

export interface StepExecutionResult {
  stepId: StepId;
  passed: boolean;
  /** 产出物路径 */
  outputs?: string[];
  /** 执行时间戳 */
  executedAt: string;
  /** 错误信息 */
  error?: string;
}

// ============================================================================
// 第七部分：项目配置
// ============================================================================

// ============================================================================
// 接口绑定类型（逻辑接口 → 物理传输映射）
// 完整设计参见 docs/binding-mechanism-plan.md 第 4.1 节
// ============================================================================

// --- 传输层绑定（判别联合） ---

/** HTTP 参数映射：逻辑字段 → HTTP 参数位置与名称 */
export interface HttpParamBinding {
  logicalName: string;
  in: 'query' | 'body' | 'path' | 'header';
  physicalName?: string;
}

export interface HttpTransport {
  type: 'http';
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  params: HttpParamBinding[];
  timeoutMs?: number;
}

export interface KafkaTransport {
  type: 'kafka';
  topic: string;
  keyField?: string;
  serde: 'json' | 'avro' | 'protobuf';
  timeoutMs?: number;
  responseMode: 'none' | 'reply_topic' | 'poll';
  responseTopic?: string;
  correlationIdField?: string;
}

export interface NsqTransport {
  type: 'nsq';
  topic: string;
  channel?: string;
  serde: 'json';
  timeoutMs?: number;
  responseMode: 'none' | 'reply_topic' | 'poll';
  responseTopic?: string;
  correlationIdField?: string;
}

export interface GrpcTransport {
  type: 'grpc';
  service: string;
  method: string;
  protoFile?: string;
  timeoutMs?: number;
  metadata?: Record<string, string>;
}

export interface DbQueryTransport {
  type: 'db_query';
  dbType: 'postgres' | 'mysql' | 'mongodb' | 'sqlite';
  query: string;
  connectionEnv: string;
  timeoutMs?: number;
}

export type TransportBinding =
  | HttpTransport
  | KafkaTransport
  | NsqTransport
  | GrpcTransport
  | DbQueryTransport;

// --- 角色与接口绑定 ---

/** 角色绑定：将逻辑角色映射到外部系统连接信息 */
export interface RoleBinding {
  roleId: string;
  baseUrl: string;
  auth: 'none' | 'bearer' | 'basic' | 'hmac' | 'api_key' | 'mtls';
  authConfig?: {
    tokenEnv?: string;
    usernameEnv?: string;
    passwordEnv?: string;
    keyId?: string;
    secretEnv?: string;
    headerName?: string;
    keyEnv?: string;
    certPath?: string;
    keyPath?: string;
    caPath?: string;
  };
  headers?: Record<string, string>;
  /**
   * HTTPS 传输覆盖（#15）：环境自签 CA + 连接地址/SNI 与 URL host 分离时使用。
   * - caFile：环境根 CA PEM 路径（绝对路径或相对进程 cwd；不配置时按系统信任库）
   * - connectHost：连接地址覆盖（如集群节点 IP，URL host 仅用于 SNI/Host 头）
   * - servername：TLS SNI（默认 URL host）
   * - rejectUnauthorized：默认在提供 caFile 时 true（严格校验），可显式覆盖
   */
  tls?: {
    caFile?: string;
    connectHost?: string;
    servername?: string;
    rejectUnauthorized?: boolean;
  };
  kafka?: {
    brokersEnv: string;
    consumerGroup?: string;
    sasl?: {
      mechanism: 'plain' | 'scram-sha-256' | 'scram-sha-512';
      usernameEnv: string;
      passwordEnv: string;
    };
  };
  nsq?: {
    nsqdTcpEnv: string;
    nsqlookupdHttpEnv?: string;
    responseTimeoutMs?: number;
  };
}

/** 接口绑定：将逻辑接口映射到具体物理实现 */
export interface InterfaceBinding {
  /** 逻辑接口名（= InterfaceSpec.name，即 action 或 observe_*） */
  action: string;
  roleId: string;
  transport: TransportBinding;
  /**
   * 多协议项目中的子协议归属（如 'P3'）。
   * 多个子协议存在同名 action（如 enable/disable/delete）时，
   * verify / bind 按 --protocol <Pn> 过滤，取 protocol 命中的条目；
   * 未打标的条目作为兼容兜底（仅当无 protocol 命中时使用）。
   */
  protocol?: string;
}

// --- 组合层与绑定配置 ---

/** 跨协议观测接口绑定 */
export interface CrossProtocolObservationBinding {
  observationId: string;
  transport: HttpTransport | DbQueryTransport | GrpcTransport | NsqTransport;
}

/** 绑定环境：在共享 roles/interfaces 基础上按角色覆盖 baseUrl/authConfig 等（字段按角色合并，authConfig/kafka/nsq 深合并） */
export interface BindingEnvironment {
  roles?: Record<string, Partial<RoleBinding>>;
}

/** E11：错误映射条目：协议错误码 → 真实系统错误表达 */
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

export interface BindingConfig {
  roles: Record<string, RoleBinding>;
  interfaces: InterfaceBinding[];
  crossProtocolObservations?: CrossProtocolObservationBinding[];
  /**
   * 状态词表映射：协议状态 ID → 系统对外暴露的状态值。
   * 用于观测接口/动作响应中系统词汇与协议状态 ID 不一致时归一化比较，
   * 如 { S1: "offline", S2: "online" }。缺省时仅接受状态 ID / 状态名。
   */
  stateMap?: Record<string, string>;
  /**
   * E11：错误映射表（与 stateMap 同构）。
   * - 协议错误码（异常路径声明）→ 真实系统错误表达
   * - binder 校验 specs.errorResponses[].errorCode 必须命中此处（缺失即 valid=false）
   * - verifier 按此判定错误响应是否符合契约
   * 缺省视为兼容老协议。
   */
  errorMap?: Record<string, ErrorMapEntry>;
  /** 多环境绑定：默认环境名（bind/verify 未指定 --env 时使用） */
  defaultEnv?: string;
  /** 环境覆盖表：共享 roles/interfaces，每个环境覆盖角色 baseUrl 与 authConfig 等 */
  environments?: Record<string, BindingEnvironment>;
}

/** 合并后的接口绑定（逻辑规格 + 物理映射 + 角色配置三合一） */
export interface ResolvedBinding {
  spec: InterfaceSpec;
  binding: InterfaceBinding | undefined;
  roleBinding: RoleBinding | undefined;
}

/** 绑定完整性的验证报告 */
export interface BindingValidationReport {
  valid: boolean;
  missingSystem: string[];
  missingObservation: string[];
  warnings: string[];
  /**
   * E11：specs 中声明但 bindings.errorMap 未命中的 errorCode 列表。
   * - 缺失即 valid=false（与"观测接口缺绑"同纪律）
   * - 任何 errorCode 在 errorMap 中但未声明 → warning（可能残留）
   */
  unmappedErrorCodes?: string[];
  /** E11：errorMap 中声明但 specs/异常路径未声明的 errorCode 列表（warning） */
  extraErrorCodes?: string[];
  /**
   * E11：errorMap 中声明但属于其他子协议的 errorCode 列表（多协议项目跨协议共享
   * errorMap；`bind --protocol <Pn>` 按协议校验时的预期保留项，非残留）
   */
  crossProtocolErrorCodes?: string[];
}

// ============================================================================

/** TLC 模型检查器配置（tla2tools + Java 运行时） */
export interface TlcConfig {
  /**
   * java 可执行文件路径（默认 'java'，从 PATH 解析）；
   * 也可填 portable JRE 目录，运行器会自动补全 bin/java
   */
  javaPath?: string;
  /**
   * tla2tools.jar 路径（默认 'tla2tools.jar'，从当前目录解析）；
   * 也可填其所在目录，运行器会自动补全 tla2tools.jar
   */
  tla2toolsJar?: string;
  /** TLC 运行超时（毫秒，默认 60000） */
  timeoutMs?: number;
}

export interface ProtochainConfig {
  /** 协议名称 */
  name: string;
  /** AI 适配器配置 */
  ai?: {
    provider: 'openai' | 'anthropic' | 'local' | 'deepseek';
    apiKey?: string;
    model?: string;
    baseUrl?: string;
    /**
     * P3 多模型路由（§7.2）：按步骤角色覆盖 model。
     * 语义层检查用便宜模型，reason / formalize 用强模型，生成类步骤单独指定；
     * 未配置某角色时回退到 model。
     */
    models?: {
      /** 语义层检查（check / verify 辅助摘要 / diff / version 分类等） */
      semantic?: string;
      /** 推演与形式化（reason / formalize / derive-contracts） */
      reasoning?: string;
      /** 生成类步骤（generate-tests / generate-cases） */
      generation?: string;
    };
    /**
     * P3：生成类步骤（generate-tests / generate-cases）是否启用
     * "生成 -> 机械预检 -> 修正 -> 重试" loop（默认 false，保持现有确定性路径）。
     */
    useForGeneration?: boolean;
    /** P3：生成 loop 的预算（轮数 / 近似 token / AI 调用次数） */
    loop?: {
      maxIterations?: number;
      maxTokens?: number;
      maxToolCalls?: number;
    };
  };
  /** 形式化工具配置（可指定，否则自动选择） */
  formalTool?: 'tla' | 'scxml' | 'alloy' | 'decision-table' | 'auto';
  /** TLC 模型检查器配置（tla2tools.jar + Java 运行时；配置后 TLA+ 走真实模型检查） */
  tlc?: TlcConfig;
  /** 覆盖度准则 */
  coverage?: {
    criterion: 'state' | 'transition' | 'path';
    maxPathLength?: number;
  };
  /** 路径约定（默认值见设计方案） */
  paths?: {
    protocol?: string;
    derived?: string;
    scaffold?: string;
    diff?: string;
  };
  /** 接口绑定配置（逻辑接口 → 物理实现映射） */
  bindings?: BindingConfig;
  /** 独立绑定配置文件路径（相对 protochain.config.yaml；加载后覆盖内联 bindings） */
  bindingsFile?: string;
}

// ============================================================================
// T4 项目级 viewer 契约类型（08-project-viewer-design.md §4.2 / §5.1-5.2 / §5.2.3）
// 来源：08 §4.2 字段表（ProjectManifest）；08 §5.1-5.2 字段表（ProjectInterfaceDetailData
//       / ProjectInterfaceDetailEntry）；08 §5.2.3（DownlinkRef 统一形态）。
// 纪律：字段与可选性逐字对齐 08 字段表；不加 08 字段表之外的字段（含注释性字段）。
// ============================================================================

/** 项目级 manifest（08 §4.2 字段表；R1=A1 独立文件 + kind 判别，R13 composition.modelVersion，R15 manifest 侧不存 protocolVersions 拷贝，R14 独立两条文案） */
export interface ProjectManifest {
  /** "1.0"（常量，08 §4.2 schemaVersion 行） */
  schemaVersion: '1.0';
  /** "project-manifest"（常量，viewer 判别字段，08 §4.2 kind 行） */
  kind: 'project-manifest';
  /** ISO 8601 生成时刻（08 §4.2 generatedAt 行） */
  generatedAt: string;
  /** 项目元数据（08 §4.2 project.* 行：composition.md → CompositionModel.metadata 字段搬运） */
  project: {
    systemName: string;
    version: string;
    changeType: string;
  };
  /** 产物 bundle 清单（08 §4.2 bundles.* 行） */
  bundles: {
    /** 组合层 data.json（08 §4.2 bundles.composition.* 行；modelVersion = composition.metadata.version 字段搬运，R13 守卫源对 S6 声明） */
    composition: {
      file: string;
      schemaVersion: '1.1';
      modelVersion: string;
    };
    /** 接口详情产物（08 §4.2 bundles.interfaceDetails.* 行；仅声明 file/schemaVersion，不消费内容——R15；G6 起产物 schemaVersion 演进为 1.1） */
    interfaceDetails: {
      file: string;
      schemaVersion: '1.1';
    };
    /** 逐子协议条目（08 §4.2 bundles.protocols[] 行） */
    protocols: ProjectManifestProtocol[];
    /** diff 快照清单（08 §4.2 bundles.diff[] 行；无 diff 快照 → 空数组） */
    diff: ProjectManifestDiff[];
  };
  /** 独立两条文案（08 §4.3 redactionNotice，R14：不复用 REDACTION_NOTICE_LINES 第三条，不含 P0/P1 阶段编号） */
  redactionNotice: string[];
}

/** manifest 单条子协议声明（08 §4.2 bundles.protocols[].* 行；版本指纹字段均为守卫源对声明，非工具链断言） */
export interface ProjectManifestProtocol {
  /** 子协议 ID（如 'P1'）——SubProtocolRef.protocolId 字段搬运（08 §4.2） */
  id: string;
  /** 子协议名——SubProtocolRef.name 字段搬运 */
  name: string;
  /** model.md 相对路径（如 'protocol/P1/model.md'）——SubProtocolRef.modelPath 字段搬运 */
  modelPath: string;
  /** model.md metadata.version 字段搬运（守卫源对 S2/S3 的 manifest 侧取值） */
  modelVersion: string;
  /** pN.data.json 文件名（约定，如 'p1.data.json'） */
  dataFile: string;
  /** 该协议 pN.data.json.schemaVersion 读产物字段搬运（防御性：异常记 warnings，缺省 null） */
  dataSchemaVersion: string | null;
  /** 该协议 pN.data.json.sourceModelVersion 读产物字段搬运（守卫源对 S1/S5 的 manifest 侧取值） */
  dataSourceModelVersion: string | null;
  /** 系统根 bindings.yaml sha256 指纹；无 bindings.yaml → null（仅变更检测，不还原内容） */
  bindingsFingerprint: string | null;
  /** 该协议 specs.json 接口数（specs.length，与 SubProtocolSummary.interfaceCount 同源） */
  interfaceCount: number;
}

/** manifest 单条 diff 快照声明（08 §4.2 bundles.diff[].* 行；diff 段不参与任何守卫比对——防误报，08 §7.2） */
export interface ProjectManifestDiff {
  /** 快照 id（如 'payment-v1-v2'，工具链按 源协议+基线+目标版本 命名） */
  id: string;
  /** 产物文件名（如 'payment.diff.data.json'） */
  file: string;
  /** 该文件 schemaVersion 读产物字段搬运 */
  schemaVersion: string;
  /** diff 所属子协议（导航关联键 sourceProtocolId，R8；不参与守卫比对） */
  sourceProtocolId: string;
  /** diff.metadataChanges 中 metadata.version 的 oldValue（读 diff 段字段搬运） */
  baseModelVersion: string;
  /** 该文件 sourceModelVersion（读产物字段搬运） */
  targetModelVersion: string;
}

/** 接口详情产物顶层（08 §5.1 契约形态；R7 顶层 protocolVersions = 各协议 dataFile.sourceModelVersion 字段搬运；R18-1 kind 判别常量） */
export interface ProjectInterfaceDetailData {
  /** "1.0"（T4 基线，08 §5.1）/ "1.1"（G5 加法式演进：新增 catalog / interfaceType / bindingsFingerprintAtBuild，10 §3-3） */
  schemaVersion: '1.0' | '1.1';
  /** "interface-details"（常量，C 模内容判别字段，08 §5.1 / R18-1） */
  kind: 'interface-details';
  /** ISO 8601 生成时刻 */
  generatedAt: string;
  /** { "<Pn>": "<sourceModelVersion>" }（R7；与 manifest protocols[].dataSourceModelVersion 同源同值；守卫源对 S5 的产物侧取值） */
  protocolVersions: Record<string, string>;
  /** { "<Pn>": { "<IF_ID>": ProjectInterfaceDetailEntry } } */
  entries: Record<string, Record<string, ProjectInterfaceDetailEntry>>;
  /** 接口目录三索引 // C-1（10 §4）defensive optional；投影器恒生成（TI3） */
  catalog?: CatalogIndex;
}

/** 单接口详情条目（08 §5.2 字段表逐行；五类来源归属：① 接口自身 InterfaceSpec / ② 关系 工具链 join / ③ binding 非敏感投影 / ④ diffImpact diffView 投影 / ⑤ crossRefs 组合层 crossRefs + downlink） */
export interface ProjectInterfaceDetailEntry {
  /** 协议 ID（08 §5.2 protocolId 行：manifest protocols[].id 字段搬运，冗余便于扁平消费） */
  protocolId: string;
  /** ① 接口自身段（08 §5.2 interface.* 行） */
  interface: ProjectInterfaceDetailInterface;
  /** ② 关系段（08 §5.2 relation.* 行；工具链 join，viewer 零推导） */
  relation: ProjectInterfaceRelation;
  /** ③ binding 段（08 §5.2 binding 行；无 bindings → { hasBindings: false }） */
  binding: ProjectInterfaceBinding | null;
  /** ⑤ crossRefs 段（08 §5.2 crossRefs 行 + §5.2.3 downlink；组合层 crossRefs.filter(fromApi === interface.id)，每条内嵌 downlink） */
  crossRefs: ProjectCrossRefWithDownlink[];
}

/** 接口自身段（08 §5.2 interface.* 行；全部来自 InterfaceSpec 字段搬运，sourceId 必须从 specs.json 补——WebDataJson 视图不含） */
export interface ProjectInterfaceDetailInterface {
  id: string;
  name: string;
  kind: 'system' | 'observation';
  sourceId: string;
  actionType?: string;
  /** 触发角色 ID（TD2 backfill 后由 pN.data.json 搬运；可空） */
  triggerRoleId?: string | null;
  description: string;
  schemaKind?: string;
  schemaDegradedReasons?: string[];
  isContractCarrier?: boolean | null;
  /** 接口分型 // C-2（10 §4） */
  interfaceType?: InterfaceType;
  requestSchema?: JSONSchema;
  responseSchema?: JSONSchema;
  /** 请求示例（G6 · 10 §17.2）工具链确定性合成值，仅在 interface-details 1.1 生成，绝不回写 specs/data.json 1.0（红线③） // C-G6-1 */
  requestExample?: unknown;
  /** 响应示例（G6 · 10 §17.2） // C-G6-1 */
  responseExample?: unknown;
  /** 多语言代码样例（G6 · 10 §17.2）curl / javascript(fetch) / python(requests) // C-G6-1 */
  codeSamples?: Array<{ lang: string; label: string; code: string }>;
  inputs: FieldSpec[];
  outputs: FieldSpec[];
  precondition?: string;
  preconditions?: SchemaExpression[];
  postconditions: string[];
  postconditionExpressions?: SchemaExpression[];
  sideEffects?: SchemaExpression[];
  invariantIds?: string[];
  observesResourcePoolId?: string | null;
  errorResponses?: ErrorResponseDef[];
}

/** 关系段（08 §5.2 relation.* 行；工具链 join：ownedTransitions = edges 中 action===sourceId 的 edge.id，观测接口空数组） */
export interface ProjectInterfaceRelation {
  ownedTransitions: string[];
  preconditionStates: string[];
  postconditionStates: string[];
  /** invariantScope.scopeStateIds 包含后置状态的不变量（08 §5.2 coveredInvariants 行） */
  coveredInvariants: ProjectCoveredInvariant[];
  /** diffView.affectedInterfaces 命中 → affected=true 携带全部字段；否则 false 全空（08 §5.2.1 防误报口径） */
  diffImpact: ProjectDiffImpact;
}

/** 覆盖不变量条目（08 §5.2 coveredInvariants 行：name/scopeStateIds/carrierRoleIds） */
export interface ProjectCoveredInvariant {
  id: string;
  name: string;
  scopeStateIds: string[];
  carrierRoleIds: string[];
}

/** diffImpact 口径（08 §5.2.1：affected=false 时其余字段为空） */
export interface ProjectDiffImpact {
  affected: boolean;
  changedTransitions: string[];
  changedStates: string[];
  changedOthers: Array<{ elementType: string; elementId: string; kind: string }>;
  summary: string | null;
}

/** binding 段（08 §5.2 binding.* 行；非敏感投影，不读 authConfig/tls 密钥段；无 bindings → hasBindings=false 空视图） */
export interface ProjectInterfaceBinding {
  hasBindings: boolean;
  /** bindings.interfaces[].transport 过滤命中行（method/path/type + roleId/protocol） */
  transport?: Array<{ type: string; method?: string; path?: string; roleId?: string; protocol?: string; server?: string }>;
  /** 该接口声明的 errorCode 命中 errorMap 的行（ErrorMapEntry 字段，types.ts L1799-1811） */
  errorMapHits?: Array<{ errorCode: string } & ErrorMapEntry>;
  /** 状态词表映射（项目级共享展示） */
  stateMap?: Record<string, string> | null;
  /** 该接口声明但 errorMap 未覆盖的码（buildBindingView 计算过滤） */
  unmappedErrorCodes?: string[];
  /** bindings.yaml sha256 构建期快照 // C-3（10 §4）纯记录字段，无 `fresh` 语义、不自我判定；不可用时记 null（纯记录，不判断） */
  bindingsFingerprintAtBuild?: string | null;
}

/** crossRefs 条目（08 §5.2 crossRefs 行：组合层 crossRefs 原字段 + 内嵌 downlink 解析，R10） */
export interface ProjectCrossRefWithDownlink {
  kind: string;
  toProtocol: string;
  target?: string;
  sourceField: string;
  context: string;
  /** downlink 解析对象（08 §5.2.3：viewer 只读 resolved，不做任何 target 语义推断） */
  downlink: DownlinkRef;
}

/** downlink 统一形态（08 §5.2.3 R10：工具链预解析 target 归属；resolved=false 时 kind=null + reason 语义别名文案） */
export interface DownlinkRef {
  resolved: boolean;
  /** 下钻目标 kind（状态 id → 接口 id → 资源池 id 查表命中）；全部未命中 → null */
  kind: 'state' | 'interface' | 'resourcePool' | null;
  protocolId: string;
  target: string;
  /** resolved=false 时携带降级原因（08 §5.2.3 文案：语义别名或跨版本引用） */
  reason?: string;
}

// ============================================================================
// G5 接口详情主视图契约类型（10-interface-view-proposal.md §4 变更表 C-1 / C-2）
// 纪律：字段与可选性逐字对齐 10 §4 变更表；不加变更表之外的字段（含注释性字段）。
// ============================================================================

/** 接口分型三值 // C-2（10 §4）；三值语义与现状映射见 10 §3-2 */
export type InterfaceType = 'state_machine' | 'contract_carrier' | 'observation';

/**
 * 接口目录三索引 // C-1（10 §4）
 * - byProtocol / byRole / byPreconditionState：工具链机械投影，viewer 只读查表（10 §3-1）
 * - 键：协议 ID / 角色 ID / 前置状态 ID；归组边界规则见 10 §3-1（triggerRoleId=null 系统接口
 *   归"系统/未指派角色"组、观测接口归"观测"组；多 from 接口在多个前置状态组重复出现、不去重）
 * - 值：entries 定位引用（接口 ID 跨协议不唯一，故用 { protocolId, interfaceId } 二元键——
 *   与 viewer state.nav 既有定位约定同构，查表即定位、无推导）
 */
export interface CatalogIndex {
  byProtocol: Record<string, Array<{ protocolId: string; interfaceId: string }>>;
  byRole: Record<string, Array<{ protocolId: string; interfaceId: string }>>;
  byPreconditionState: Record<string, Array<{ protocolId: string; interfaceId: string }>>;
}
