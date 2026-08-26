/**
 * T4 buildInterfaceDetails 投影器（09-execution-T4.md TD4 / 08-project-viewer-design.md §5）
 *
 * 产出：web/interface-details.json（顶层 { schemaVersion:"1.0", kind:"interface-details",
 * generatedAt, protocolVersions, entries }）。
 *
 * 五类来源归属（08 §5.2 字段表逐行，viewer 零推导的前提——所有 join 在本投影器内完成）：
 * ① interface 段 = InterfaceSpec 权威（补 sourceId）+ triggerRoleId 字段搬运（TD2 backfill 产物）；
 * ② relation 段 = 工具链 join：ownedTransitions / preconditionStates / postconditionStates /
 *    coveredInvariants（invariantScope 按后置状态命中）/ diffImpact（diffView 受影响口径）；
 * ③ binding 段 = 复用 buildBindingView 非敏感投影 + 按接口过滤；无 bindings → {hasBindings:false}；
 * ④ diffImpact 口径（08 §5.2.1）：affected=true 携带全部字段搬运，否则 false 全空；
 * ⑤ crossRefs 段 = 组合层 crossRefs.filter(fromApi === interface.id) + downlink 解析（R10，
 *    对目标协议数据按 状态 id → 接口 id → 资源池 id 查表；viewer 只读 resolved，不做 target 推断）。
 *
 * 边界：只对"该协议当前数据文件"中的接口生成条目（diff 新增接口不进旧协议 entries——
 * 08 §5.2.1 防误报口径）；不重算 buildBindingView / invariantScope / diffView / crossRefs
 * 已有产物（复用）；不做 relations 全量 / timing / mermaid / testCases（08 §5.1 排除）；
 * downlink 不解析转移 id（08 R18-2：crossRefs target 不会是转移 id）。
 */

import type {
  InterfaceSpec,
  FieldSpec,
  JSONSchema,
  SchemaExpression,
  ErrorResponseDef,
  DownlinkRef,
  ProjectInterfaceDetailData,
  ProjectInterfaceDetailEntry,
  ProjectInterfaceDetailInterface,
  ProjectInterfaceRelation,
  ProjectCoveredInvariant,
  ProjectDiffImpact,
  ProjectInterfaceBinding,
  ProjectCrossRefWithDownlink,
} from '../model/types.js';
import type { WebDataJson, WebBindingView } from './index.js';
import type { CrossProtocolRef } from './composition.js';

/** 单个子协议的接口详情输入 */
export interface InterfaceDetailsProtocolInput {
  protocolId: string;
  /** InterfaceSpec 权威（补 sourceId；webData 视图不含 sourceId） */
  specs: InterfaceSpec[];
  /** buildWebData 产物（含 TD2 triggerRoleId backfill；stateMachine/diffView 为 join 数据源） */
  webData: WebDataJson;
}

export interface BuildInterfaceDetailsInputs {
  /** 逐子协议输入（只对当前数据文件的接口生成条目） */
  protocols: InterfaceDetailsProtocolInput[];
  /** 组合层 crossRefs（全量；投影器内 filter fromApi === interface.id） */
  crossRefs: CrossProtocolRef[];
  /** buildBindingView 非敏感投影（全项目 allSpecs 构造；无 bindings → hasBindings=false 视图） */
  bindingView: WebBindingView | undefined;
}

/**
 * 主构造器：由逐子协议（specs + webData）+ 组合层 crossRefs + bindingView 构造 interface-details。
 */
export function buildInterfaceDetails(inputs: BuildInterfaceDetailsInputs): ProjectInterfaceDetailData {
  const { protocols, crossRefs, bindingView } = inputs;
  // 目标协议数据索引（downlink 查表：状态 id → 接口 id → 资源池 id）
  const targetData = new Map<string, WebDataJson>();
  for (const p of protocols) targetData.set(p.protocolId, p.webData);

  const entries: ProjectInterfaceDetailData['entries'] = {};
  const protocolVersions: Record<string, string> = {};
  for (const p of protocols) {
    protocolVersions[p.protocolId] = p.webData.sourceModelVersion;
    const protoEntries: Record<string, ProjectInterfaceDetailEntry> = {};
    for (const spec of p.specs) {
      protoEntries[spec.id] = buildEntry(p, spec, crossRefs, bindingView, targetData);
    }
    entries[p.protocolId] = protoEntries;
  }

  return {
    schemaVersion: '1.0',
    kind: 'interface-details',
    generatedAt: new Date().toISOString(),
    protocolVersions,
    entries,
  };
}

/** 单条目构造（五段） */
function buildEntry(
  p: InterfaceDetailsProtocolInput,
  spec: InterfaceSpec,
  crossRefs: CrossProtocolRef[],
  bindingView: WebBindingView | undefined,
  targetData: Map<string, WebDataJson>
): ProjectInterfaceDetailEntry {
  const view = p.webData.interfaces.find((v) => v.id === spec.id);
  const edges = p.webData.stateMachine.edges;
  // ownedTransitions：系统接口 = edges 中 action === sourceId 的 edge.id；观测接口空数组
  const ownedEdges = spec.kind === 'system' ? edges.filter((e) => e.action === spec.sourceId) : [];
  const preconditionStates = unique(ownedEdges.flatMap((e) => e.from));
  const postconditionStates = unique(ownedEdges.map((e) => e.to));

  const entry: ProjectInterfaceDetailEntry = {
    protocolId: p.protocolId,
    interface: buildInterfaceSection(spec, view),
    relation: {
      ownedTransitions: ownedEdges.map((e) => e.id),
      preconditionStates,
      postconditionStates,
      coveredInvariants: computeCoveredInvariants(p.webData.stateMachine.invariantScope ?? {}, postconditionStates),
      diffImpact: computeDiffImpact(p.webData.diffView, spec.id),
    },
    binding: buildInterfaceBinding(spec, bindingView),
    crossRefs: buildCrossrefs(crossRefs.filter((r) => r.fromApi === spec.id), targetData),
  };
  return entry;
}

/** ① 接口自身段（08 §5.2 interface.* 行；InterfaceSpec 权威 + view 补 triggerRoleId） */
function buildInterfaceSection(
  spec: InterfaceSpec,
  view: WebDataJson['interfaces'][number] | undefined
): ProjectInterfaceDetailInterface {
  return {
    id: spec.id,
    name: spec.name,
    kind: spec.kind,
    sourceId: spec.sourceId,
    actionType: view?.actionType ?? spec.actionType,
    triggerRoleId: view?.triggerRoleId ?? null,
    description: view?.description ?? spec.precondition ?? spec.name,
    schemaKind: spec.schemaKind,
    schemaDegradedReasons: spec.schemaDegradedReasons,
    isContractCarrier: spec.isContractCarrier ?? null,
    requestSchema: spec.requestSchema,
    responseSchema: spec.responseSchema,
    inputs: (spec.inputs ?? []) as FieldSpec[],
    outputs: (spec.outputs ?? []) as FieldSpec[],
    precondition: spec.precondition,
    preconditions: spec.preconditions as SchemaExpression[] | undefined,
    postconditions: spec.postconditions ?? [],
    postconditionExpressions: spec.postconditionExpressions as SchemaExpression[] | undefined,
    sideEffects: spec.sideEffects as SchemaExpression[] | undefined,
    invariantIds: spec.invariantIds ?? [],
    observesResourcePoolId: spec.observesResourcePoolId ?? null,
    errorResponses: (spec.errorResponses ?? []) as ErrorResponseDef[],
  };
}

/** ② coveredInvariants：invariantScope.scopeStateIds 包含该接口后置状态的不变量（08 §5.2） */
function computeCoveredInvariants(
  invariantScope: NonNullable<WebDataJson['stateMachine']['invariantScope']>,
  postconditionStates: string[]
): ProjectCoveredInvariant[] {
  const post = new Set(postconditionStates);
  if (post.size === 0) return [];
  const out: ProjectCoveredInvariant[] = [];
  for (const [id, scope] of Object.entries(invariantScope)) {
    if (scope.scopeStateIds.some((sid) => post.has(sid))) {
      out.push({
        id,
        name: scope.name,
        scopeStateIds: scope.scopeStateIds.slice(),
        carrierRoleIds: (scope.carrierRoleIds ?? []).slice(),
      });
    }
  }
  return out;
}

/** ② diffImpact（08 §5.2.1 防误报口径：affectedInterfaces 含该接口 id → 携带全字段；否则 false 全空） */
function computeDiffImpact(
  diffView: WebDataJson['diffView'],
  interfaceId: string
): ProjectDiffImpact {
  if (
    diffView &&
    Array.isArray(diffView.affectedInterfaces) &&
    diffView.affectedInterfaces.includes(interfaceId)
  ) {
    return {
      affected: true,
      changedTransitions: (diffView.changedTransitions ?? []).slice(),
      changedStates: (diffView.changedStates ?? []).slice(),
      changedOthers: (diffView.changedOthers ?? []).map((c) => ({
        elementType: c.elementType,
        elementId: c.elementId,
        kind: c.kind,
      })),
      summary: diffView.summary ?? null,
    };
  }
  return {
    affected: false,
    changedTransitions: [],
    changedStates: [],
    changedOthers: [],
    summary: null,
  };
}

/** ③ binding 段（08 §5.2 binding 行：复用 buildBindingView + 按接口过滤；无 bindings → hasBindings=false） */
function buildInterfaceBinding(
  spec: InterfaceSpec,
  bindingView: WebBindingView | undefined
): ProjectInterfaceBinding | null {
  if (!bindingView || !bindingView.hasBindings) {
    return { hasBindings: false };
  }
  // 命中行：iface.id/sourceId 匹配 bindings.interfaces[].action（与 composition.ts
  // renderProjectInterfaceBindingSection L1186-1189 口径一致）
  const hits = (bindingView.interfaces ?? []).filter(
    (ib) => ib.action === spec.sourceId || ib.action === spec.id
  );
  const out: ProjectInterfaceBinding = { hasBindings: true };
  if (hits.length > 0) {
    out.transport = hits.map((ib) => {
      const t: { type: string; method?: string; path?: string; roleId?: string; protocol?: string } = {
        type: ib.transport?.type ?? 'unknown',
      };
      if (ib.transport?.method) t.method = ib.transport.method;
      if (ib.transport?.path) t.path = ib.transport.path;
      if (ib.roleId !== undefined) t.roleId = ib.roleId;
      if (ib.protocol !== undefined) t.protocol = ib.protocol;
      return t;
    });
  }
  // errorMapHits：该接口声明的 errorCode 命中 errorMap 的行（ErrorMapEntry 字段搬运）
  const errorMapHits: ProjectInterfaceBinding['errorMapHits'] = [];
  for (const er of spec.errorResponses ?? []) {
    const entry = bindingView.errorMap?.[er.errorCode];
    if (entry) {
      const hit: { errorCode: string; httpStatus?: number; systemCode?: string; bodyField?: string; bodyFieldValue?: string; messageField?: string } = {
        errorCode: er.errorCode,
      };
      if (entry.httpStatus !== undefined) hit.httpStatus = entry.httpStatus;
      if (entry.systemCode !== undefined) hit.systemCode = entry.systemCode;
      if (entry.bodyField !== undefined) hit.bodyField = entry.bodyField;
      if (entry.bodyFieldValue !== undefined) hit.bodyFieldValue = entry.bodyFieldValue;
      if (entry.messageField !== undefined) hit.messageField = entry.messageField;
      errorMapHits.push(hit);
    }
  }
  if (errorMapHits.length > 0) out.errorMapHits = errorMapHits;
  if (bindingView.stateMap && Object.keys(bindingView.stateMap).length > 0) {
    out.stateMap = bindingView.stateMap;
  }
  // unmappedErrorCodes：该接口声明但 errorMap 未覆盖（buildBindingView 已有计算，按接口过滤）
  const declared = (spec.errorResponses ?? []).map((er) => er.errorCode);
  const unmapped = declared.filter((code) => !bindingView.errorMap || !bindingView.errorMap[code]);
  if (unmapped.length > 0) out.unmappedErrorCodes = unmapped;
  return out;
}

/** ⑤ crossRefs 段（08 §5.2 crossRefs 行 + §5.2.3 downlink 解析 R10） */
function buildCrossrefs(
  refs: CrossProtocolRef[],
  targetData: Map<string, WebDataJson>
): ProjectCrossRefWithDownlink[] {
  return refs.map((r) => ({
    kind: r.kind,
    toProtocol: r.toProtocol,
    ...(r.target !== undefined ? { target: r.target } : {}),
    sourceField: r.sourceField,
    context: r.context,
    downlink: resolveDownlink(r, targetData.get(r.toProtocol)),
  }));
}

/**
 * downlink 解析（08 §5.2.3 R10）：对目标协议数据按 状态 id → 接口 id → 资源池 id 查表；
 * 命中 → {resolved:true, kind, protocolId, target}；全部未命中 → {resolved:false, kind:null,
 * protocolId, target, reason:语义别名降级文案}。viewer 只读 resolved，不做任何 target 语义推断。
 */
function resolveDownlink(
  ref: CrossProtocolRef,
  targetData: WebDataJson | undefined
): DownlinkRef {
  const protocolId = ref.toProtocol;
  const target = ref.target ?? '';
  const base = { protocolId, target };
  if (!targetData || !target) {
    return {
      resolved: false,
      kind: null,
      ...base,
      reason: `语义别名：${protocolId} 当前版本状态集无 ${target || ''}，接口/资源池亦无命中`,
    };
  }
  // ① 状态 id（stateMachine.nodes[].id）
  const stateIds = new Set(targetData.stateMachine?.nodes?.map((n) => n.id) ?? []);
  if (stateIds.has(target)) return { resolved: true, kind: 'state', ...base };
  // ② 接口 id（interfaces[].id）
  const ifaceIds = new Set(targetData.interfaces?.map((i) => i.id) ?? []);
  if (ifaceIds.has(target)) return { resolved: true, kind: 'interface', ...base };
  // ③ 资源池 id（observesResourcePoolId 命中的资源池字段）
  const poolIds = new Set(
    (targetData.interfaces ?? []).map((i) => i.observesResourcePoolId).filter((x): x is string => Boolean(x))
  );
  if (poolIds.has(target)) return { resolved: true, kind: 'resourcePool', ...base };
  return {
    resolved: false,
    kind: null,
    ...base,
    reason: `语义别名：${protocolId} 当前版本状态集无 ${target}，接口/资源池亦无命中`,
  };
}

/** 去重保序 */
function unique(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of arr) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}
