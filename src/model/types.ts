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
}

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
 * 契约层 —— 从 Markdown 解析后仅用于跨层一致性校验
 * 不作为模型的可编辑部分（设计决策：契约是从规格投影的产物）
 */
export interface ContractLayerInput {
  /** 契约方（角色 ID 列表） */
  parties: string[];
  /** 期望的信息契约条目（用于校验推导出的契约是否覆盖） */
  expectedInformationFields?: string[];
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
  changeType: 'protocol_tweak' | 'paradigm_renegotiation';
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
  /** 验证时间戳 */
  verifiedAt: string;
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
  /** 验证时间戳 */
  verifiedAt: string;
}

export interface AuthoritativeVerification {
  passed: boolean;
  /** 通过/失败/跳过计数 */
  counts: { passed: number; failed: number; skipped: number };
  /** 每个测试用例的结果 */
  caseResults: CaseResult[];
}

export interface CaseResult {
  pathId: string;
  passed: boolean;
  skipped?: boolean;
  /** 偏差详情（失败时） */
  deviations?: Deviation[];
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
  /** 偏差类型 */
  kind: 'state_mismatch' | 'invariant_violation' | 'timing_violation' | 'missing_action';
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
}
