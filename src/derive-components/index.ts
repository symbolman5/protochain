/**
 * derive-components（T1b）：协议模型 → components.md 候选骨架（纯机械）
 *
 * 设计依据：《协议驱动自验证工具链设计方案》§1.4 骨架推导三步（component-model-derivation.md）：
 * - ① 机械推导 components.md 候选骨架，条目标 kindSource: derived + confirmed: false（待确认）；
 * - ② 人工补充业务细节 → 标 asserted（W1-a/W1-b 同构）；
 * - ③ 边界：组件边界是架构决策，机械只承诺「骨架可生成、可确认」，不承诺正确。
 *
 * 启发式规则：
 * - 接口→组件：按角色聚簇（每 triggerRoleId = 候选组件，操作归组）+ 凭证 redeemer 归属；
 * - 维度→存储：按实体聚合（每实体 = 候选表，table=实体名转英文 ID）；
 * - 组件→传输：按关系类型（运行依赖/派生 → 候选传输边），channel 按 mode 默认（sync→http / async→event）；
 * - 组件定义：name（角色聚簇名转英文 ID）、baseUrl（TODO 占位）、auth（由凭证 selfContained 推断）；
 * - 接口契约：path（action 名语义化转写，中文→kebab-case 英文可配字典）、method（默认 POST，
 *   triggerType=observed 用 GET）、authorization（凭证引用；无 → none）。
 *
 * 产物：derived/components.skeleton.md（候选骨架，不写回 components.md——人工确认后落盘）。
 * 语法与 components.md 一致（T1a parser 可 round-trip 解析），额外字段 kindSource/confirmed
 * 以 YAML 注释/字段标注（parser 忽略未知字段，零冲突）。
 *
 * 覆盖率统计：接口/维度/关系被骨架覆盖的比例；未覆盖者显式列出。
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  SourceProtocolModel,
  ComponentMappingDef,
  ComponentDef,
  ComponentContractDef,
  RelationDef,
} from '../model/types.js';

// ============================================================================
// 类型定义
// ============================================================================

/** 候选骨架条目统一标注（derived + 待确认） */
export interface DerivedFlag {
  kindSource: 'derived';
  confirmed: false;
}

export interface DerivedComponentSkeleton {
  /** 候选组件定义（角色聚簇） */
  components: Array<ComponentDef & DerivedFlag & { cluster: string }>;
  /** 候选三张映射表 */
  mapping: ComponentMappingDef;
  /** 候选接口契约 */
  contracts: ComponentContractDef[];
  /** 覆盖率统计 */
  coverage: {
    interfaceCovered: number;
    interfaceTotal: number;
    dimensionCovered: number;
    dimensionTotal: number;
    relationCovered: number;
    relationTotal: number;
    /** 未覆盖对象显式列出 */
    unmappedInterfaces: string[];
    unmappedDimensions: string[];
    unmappedRelations: string[];
  };
  /** 降级记录（显式不静默） */
  warnings: string[];
  sourceModelVersion?: string;
  generatedAt: string;
}

export interface DeriveComponentsOptions {
  /** 中文 action → 英文 path 转写字典（action 名 → path 片段）；缺省用内置最小字典 */
  dict?: Record<string, string>;
  /** 输出骨架路径（默认 <rootDir>/derived/components.skeleton.md） */
  outputPath?: string;
  /** 覆盖已存在产物（与 derive-storage 同 force 语义） */
  force?: boolean;
}

// ============================================================================
// 工具：英文 ID 转写
// ============================================================================

/** 内置最小转写字典（anonymous-saas 常见操作词；可经 options.dict 覆盖扩充） */
const DEFAULT_DICT: Record<string, string> = {
  匿名发布: 'publish-anonymous',
  发布: 'publish',
  认领: 'claim',
  资源: 'resource',
  移除: 'remove',
  审查: 'review',
  封禁: 'ban',
  用户: 'user',
  登录: 'login',
  登记: 'register',
  更换: 'replace',
  域名: 'domain',
  证书: 'certificate',
  吊销: 'revoke',
  重算: 'recompute',
  配额: 'quota',
  过期: 'expire',
  回收: 'recycle',
  心跳: 'heartbeat',
  超时: 'timeout',
  判定: 'judge',
  请求: 'request',
  访问: 'access',
  携带: 'carry',
  上传: 'upload',
  文件: 'file',
  内容: 'content',
  上报: 'report',
  结束: 'finish',
  断开: 'disconnect',
  探测: 'probe',
  健康: 'health',
  账号: 'account',
  服务器: 'server',
  下线: 'offline',
};

/** 角色/实体/中文名 → 英文 ID（kebab-case） */
export function toEnglishId(
  name: string,
  dict?: Record<string, string>,
  warnings?: string[]
): string {
  const d = dict ?? DEFAULT_DICT;
  const trimmed = name.trim();
  // 已经是 ASCII kebab/snake（角色 ID、英文名）→ 直接归一 kebab
  if (/^[a-zA-Z0-9_\-]+$/.test(trimmed)) {
    return trimmed.replace(/_/g, '-').toLowerCase();
  }
  // 中文名：按字典逐词替换；未命中词保留原文（kebab 化空白/符号）+ 降级记录
  const parts: string[] = [];
  let rest = trimmed;
  let degraded = false;
  while (rest.length > 0) {
    let matched = false;
    // 最长词优先匹配
    const keys = Object.keys(d).sort((a, b) => b.length - a.length);
    for (const k of keys) {
      if (rest.startsWith(k)) {
        parts.push(d[k]);
        rest = rest.slice(k.length);
        matched = true;
        break;
      }
    }
    if (!matched) {
      const ch = rest[0];
      // 收集一段连续非字典命中字符（含分隔符）作为原文
      let run = ch;
      let j = 1;
      while (j < rest.length) {
        const nextKey = Object.keys(d).sort((a, b) => b.length - a.length).find((k) => rest.slice(j).startsWith(k));
        if (nextKey) break;
        run += rest[j];
        j += 1;
      }
      rest = rest.slice(j);
      const cleaned = run.replace(/[\s/（）()·＋+|,，。]+/g, '-').replace(/^-+|-+$/g, '');
      if (cleaned) {
        parts.push(cleaned);
        degraded = true;
      }
    }
  }
  const id = parts.filter(Boolean).join('-').replace(/-+/g, '-').toLowerCase();
  if (degraded && warnings) {
    warnings.push(`action "${name}" 未全部命中转写字典 → path 保留原文片段（${id}），人工确认（T1b）`);
  }
  return id || 'unnamed';
}

// ============================================================================
// 核心推导
// ============================================================================

/** 收集接口清单（六张清单操作优先；否则状态机转移） */
function collectInterfaces(model: SourceProtocolModel): Array<{
  name: string;
  triggerRoleId?: string;
  triggerType?: string;
}> {
  const out: Array<{ name: string; triggerRoleId?: string; triggerType?: string }> = [];
  const seen = new Set<string>();
  for (const op of model.derivable.operations ?? []) {
    if (seen.has(op.name)) continue;
    seen.add(op.name);
    out.push({ name: op.name, triggerRoleId: op.triggerRoleId, triggerType: op.triggerType });
  }
  for (const t of model.derivable.transitions ?? []) {
    const name = t.action ?? t.id;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, triggerRoleId: t.triggerRoleId, triggerType: t.triggerType });
  }
  return out;
}

/** 实体 → 归属组件（变更该实体维度的操作组件，多数归；无 → 'shared'） */
function buildEntityToComponent(
  model: SourceProtocolModel,
  ifaceToComponent: Map<string, string>
): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  for (const op of model.derivable.operations ?? []) {
    const comp = ifaceToComponent.get(op.name);
    if (!comp) continue;
    for (const e of op.targetEntities ?? []) {
      const ent = e.replace(/（[^）]*）|\([^)]*\)/g, '').trim();
      if (!ent) continue;
      if (!counts.has(ent)) counts.set(ent, new Map());
      const m = counts.get(ent)!;
      m.set(comp, (m.get(comp) ?? 0) + 1);
    }
  }
  const out = new Map<string, string>();
  for (const [ent, m] of counts) {
    let best: string | null = null;
    let bestCount = 0;
    for (const [c, n] of m) {
      if (n > bestCount) {
        best = c;
        bestCount = n;
      }
    }
    out.set(ent, best ?? 'shared');
  }
  return out;
}

/** 凭证 redeemer → 组件 auth（local-verify → bearer；needs-lookup → oauth；无 → none） */
function componentAuthForRole(
  model: SourceProtocolModel,
  roleId: string | undefined
): { auth: 'none' | 'bearer' | 'oauth' | 'api-key'; credential?: string } {
  if (!roleId) return { auth: 'none' };
  const creds = model.metadata.credentials ?? [];
  const hit = creds.find((c) => c.redeemer === roleId || c.holder === roleId);
  if (!hit) return { auth: 'none' };
  const auth = hit.selfContained === 'local-verify' ? 'bearer' : hit.selfContained === 'needs-lookup' ? 'oauth' : 'api-key';
  return { auth, credential: hit.name };
}

/**
 * 机械推导候选骨架（pure function，确定性——同一模型两次运行产物一致）。
 */
export function deriveComponentsSkeleton(
  model: SourceProtocolModel,
  options: DeriveComponentsOptions = {}
): DerivedComponentSkeleton {
  const warnings: string[] = [];
  const dict = options.dict ?? DEFAULT_DICT;
  const ifaces = collectInterfaces(model);
  const entityDimensions = model.derivable.entityDimensions ?? [];
  const relations = model.derivable.relations ?? [];

  // ── 1. 接口→组件：角色聚簇 ──
  // 组件名 = triggerRoleId 英文 ID（无角色 → 'system'）
  const roleToComponent = new Map<string, string>();
  const componentRoles = new Map<string, string[]>();
  const ifaceToComponent = new Map<string, string>();
  for (const iface of ifaces) {
    const roleId = iface.triggerRoleId ?? 'system';
    if (!roleToComponent.has(roleId)) {
      const comp = toEnglishId(roleId, dict);
      roleToComponent.set(roleId, comp);
      componentRoles.set(comp, []);
    }
    const comp = roleToComponent.get(roleId)!;
    if (!componentRoles.get(comp)!.includes(roleId)) componentRoles.get(comp)!.push(roleId);
    ifaceToComponent.set(iface.name, comp);
  }
  const components: Array<ComponentDef & DerivedFlag & { cluster: string }> = [];
  for (const [comp, roles] of componentRoles) {
    const roleId = roles[0];
    const authInfo = componentAuthForRole(model, roleId);
    const def: ComponentDef & DerivedFlag & { cluster: string } = {
      name: comp,
      description: `角色聚簇：${roles.join(' / ')}（接口：${ifaces.filter((i) => (i.triggerRoleId ?? 'system') === roleId).map((i) => i.name).join('、')}）`,
      baseUrl: `https://TODO.${comp}.example.com`,
      auth: authInfo.auth,
      kindSource: 'derived',
      confirmed: false,
      cluster: `role:${roles.join('+')}`,
    };
    components.push(def);
  }
  components.sort((a, b) => a.name.localeCompare(b.name));

  // ── 2. 维度→存储：实体聚合 ──
  const dimRows: ComponentMappingDef['dimensionStorage'] = [];
  for (const d of entityDimensions) {
    const table = toEnglishId(d.entity, dict);
    dimRows.push({ dimension: d.dimension, table, description: `实体「${d.entity}」聚合（kind=${d.kind}，derived）` });
  }

  // ── 3. 组件→传输：关系类型（运行依赖/派生）→ 候选传输边 ──
  const entityToComponent = buildEntityToComponent(model, ifaceToComponent);
  const transferRows: ComponentMappingDef['componentTransfers'] = [];
  const coveredRelationRows: string[] = [];
  const candidateRelations = relations.filter((r) => r.type === '运行依赖' || r.type === '派生');
  for (const r of candidateRelations) {
    const fromEnt = stripRef(r.from);
    const toEnt = stripRef(r.to);
    const fromComp = entityToComponent.get(fromEnt);
    const toComp = entityToComponent.get(toEnt);
    if (!fromComp || !toComp) {
      warnings.push(`关系 ${r.from} → ${r.to}（${r.type}）端点无法归属组件（实体无操作聚簇），跳过传输候选（T1b）`);
      continue;
    }
    if (fromComp === toComp) continue; // 组件内关系不构成传输边
    transferRows.push({
      from: fromComp,
      to: toComp,
      channel: r.type === '派生' ? 'event' : 'http',
      mode: 'async',
      description: `候选传输（关系 ${r.type}：${r.from} → ${r.to}，derived）`,
    });
    coveredRelationRows.push(`${r.from}→${r.to}`);
  }
  // 去重传输边
  const seenEdges = new Set<string>();
  const uniqueTransfers = transferRows.filter((t) => {
    const k = `${t.from}→${t.to}`;
    if (seenEdges.has(k)) return false;
    seenEdges.add(k);
    return true;
  });

  // ── 4. 接口契约：path/method/authorization ──
  const contracts: ComponentContractDef[] = [];
  const mappedInterfaces = new Set<string>();
  for (const iface of ifaces) {
    const comp = ifaceToComponent.get(iface.name);
    if (!comp) continue;
    const path = `/${toEnglishId(iface.name, dict, warnings)}`;
    const method = iface.triggerType === 'observed' ? 'GET' : 'POST';
    const authInfo = componentAuthForRole(model, iface.triggerRoleId);
    const contract: ComponentContractDef = {
      interface: iface.name,
      path,
      method,
    };
    if (authInfo.credential) contract.authorization = authInfo.credential;
    contracts.push(contract);
    mappedInterfaces.add(iface.name);
  }

  // ── 5. interfaceImplementations 骨架 ──
  const implRows: ComponentMappingDef['interfaceImplementations'] = ifaces.map((iface) => ({
    interface: iface.name,
    component: ifaceToComponent.get(iface.name) ?? 'shared',
    description: '角色聚簇骨架（derived，待确认）',
  }));

  // ── 覆盖率统计 ──
  const unmappedInterfaces = ifaces.filter((i) => !mappedInterfaces.has(i.name)).map((i) => i.name);
  const mappedDims = new Set(dimRows.map((d) => d.dimension));
  const unmappedDimensions = entityDimensions
    .map((d) => d.dimension)
    .filter((x) => !mappedDims.has(x));
  const unmappedRelations = candidateRelations
    .filter((r) => !coveredRelationRows.includes(`${r.from}→${r.to}`))
    .map((r) => `${r.from}→${r.to}（${r.type}）`);

  return {
    components,
    mapping: {
      interfaceImplementations: implRows,
      dimensionStorage: dimRows,
      componentTransfers: uniqueTransfers,
    },
    contracts,
    coverage: {
      interfaceCovered: mappedInterfaces.size,
      interfaceTotal: ifaces.length,
      dimensionCovered: dimRows.length,
      dimensionTotal: entityDimensions.length,
      relationCovered: coveredRelationRows.length,
      relationTotal: candidateRelations.length,
      unmappedInterfaces,
      unmappedDimensions,
      unmappedRelations,
    },
    warnings,
    generatedAt: new Date().toISOString(),
  };
}

/** 去除端点引用后缀（如「entry（P2）」→「entry」） */
function stripRef(name: string): string {
  return name.replace(/（[^）]*）|\([^)]*\)/g, '').trim();
}

// ============================================================================
// 产物渲染（components.skeleton.md，可被 T1a parser round-trip 解析）
// ============================================================================

export function renderSkeletonMarkdown(
  skeleton: DerivedComponentSkeleton,
  meta: { name: string; version: string }
): string {
  const c = skeleton.coverage;
  const flagNote = '# 候选骨架（derive-components · kindSource=derived · confirmed=false，人工确认后写回 components.md）';
  const parts: string[] = [];
  parts.push(`---`);
  parts.push(`name: ${meta.name}`);
  parts.push(`version: ${meta.version}`);
  parts.push(`generatedAt: ${skeleton.generatedAt}`);
  parts.push(`kindSource: derived`);
  parts.push(`---`);
  parts.push('');
  parts.push(`# 组件定义`);
  parts.push('');
  parts.push('```yaml');
  parts.push('components:');
  for (const d of skeleton.components) {
    const o: Record<string, unknown> = { name: d.name, description: d.description, baseUrl: d.baseUrl, auth: d.auth, kindSource: 'derived', confirmed: false };
    parts.push(`  - ${JSON.stringify(o)}`);
  }
  parts.push('```');
  parts.push('');
  parts.push(`# 组件映射`);
  parts.push('');
  parts.push('```yaml');
  parts.push('interfaceImplementations:');
  for (const m of skeleton.mapping.interfaceImplementations ?? []) {
    parts.push(`  - ${JSON.stringify({ ...m, kindSource: 'derived', confirmed: false })}`);
  }
  parts.push('dimensionStorage:');
  for (const m of skeleton.mapping.dimensionStorage ?? []) {
    parts.push(`  - ${JSON.stringify({ ...m, kindSource: 'derived', confirmed: false })}`);
  }
  parts.push('componentTransfers:');
  for (const m of skeleton.mapping.componentTransfers ?? []) {
    parts.push(`  - ${JSON.stringify({ ...m, kindSource: 'derived', confirmed: false })}`);
  }
  parts.push('```');
  parts.push('');
  parts.push(`# 接口契约`);
  parts.push('');
  parts.push('```yaml');
  parts.push('contracts:');
  for (const ct of skeleton.contracts) {
    parts.push(`  - ${JSON.stringify({ ...ct, kindSource: 'derived', confirmed: false })}`);
  }
  parts.push('```');
  parts.push('');
  parts.push(`## 覆盖率统计`);
  parts.push('');
  parts.push(`- 接口：${c.interfaceCovered}/${c.interfaceTotal}（${c.interfaceTotal === 0 ? '—' : ((c.interfaceCovered / c.interfaceTotal) * 100).toFixed(0) + '%'}）`);
  parts.push(`- 维度：${c.dimensionCovered}/${c.dimensionTotal}`);
  parts.push(`- 关系（运行依赖/派生 → 传输候选）：${c.relationCovered}/${c.relationTotal}`);
  if (c.unmappedInterfaces.length > 0) parts.push(`- 未覆盖接口：${c.unmappedInterfaces.join(', ')}`);
  if (c.unmappedDimensions.length > 0) parts.push(`- 未覆盖维度：${c.unmappedDimensions.join(', ')}`);
  if (c.unmappedRelations.length > 0) parts.push(`- 未覆盖关系：${c.unmappedRelations.join(', ')}`);
  if (skeleton.warnings.length > 0) {
    parts.push('');
    parts.push(`## 降级记录（schemaDegradedReasons）`);
    for (const w of skeleton.warnings) parts.push(`- ${w}`);
  }
  parts.push('');
  parts.push(flagNote);
  return parts.join('\n');
}

// ============================================================================
// 文件入口（CLI derive-components 调用）
// ============================================================================

export interface DeriveComponentsResult {
  skeleton: DerivedComponentSkeleton;
  skeletonPath: string;
  /** 骨架 markdown 文本 */
  markdown: string;
}

export function deriveComponents(
  rootDir: string,
  model: SourceProtocolModel,
  options: DeriveComponentsOptions = {}
): DeriveComponentsResult {
  const skeleton = deriveComponentsSkeleton(model, options);
  const markdown = renderSkeletonMarkdown(skeleton, {
    name: model.metadata.name,
    version: model.metadata.version,
  });
  const skeletonPath = options.outputPath ?? join(rootDir, 'derived', 'components.skeleton.md');
  if (!options.force && existsSync(skeletonPath)) {
    throw new Error(`候选骨架已存在：${skeletonPath}（如需覆盖请传 --force；骨架是机械重推产物，确认后写回 components.md）`);
  }
  mkdirSync(dirname(skeletonPath), { recursive: true });
  writeFileSync(skeletonPath, markdown, 'utf-8');
  return { skeleton, skeletonPath, markdown };
}
