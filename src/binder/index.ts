/**
 * 接口绑定解析器（P0a/P0b 桩实现）
 *
 * 完整实现参见 docs/binding-mechanism-plan.md 第 4.2 节。
 *
 * 多协议隔离：InterfaceBinding 支持 protocol 字段（子协议归属）。
 * 按协议过滤规则：
 * - protocolId 未提供（单协议项目）→ 使用全部绑定条目
 * - protocolId 提供 → 保留 protocol 命中或未打标的条目，剔除其他协议的条目；
 *   同 action 多命中时 protocol 命中优先于未打标兜底（解决 P2/P3 同名 action 冲突）
 *
 * E3 扩展：mergeBindings(skeleton, manual) —— 把 derive-bindings 产物（机械骨架）与
 * 人工编辑的 bindings.yaml 合并。合并结果等价于「完整 BindingConfig」。
 */

import type {
  InterfaceSpec,
  BindingConfig,
  ResolvedBinding,
  BindingValidationReport,
  InterfaceBinding,
  RoleBinding,
  ErrorMapEntry,
} from '../model/types.js';

/**
 * 合并骨架与人工 bindings。
 *
 * 合并规则（按优先级 manual > skeleton）：
 * 1. roles：manual.roles 浅合并 skeleton.roles（人工填的 baseUrl/headers/auth 覆盖默认）
 * 2. interfaces：按 action 合并
 *    - action 在 manual 中存在 → 用 manual（人工可改 method/path/transport）
 *    - action 在 manual 中不存在 + 在 skeleton 中存在 → 保留 skeleton（新增接口自动绑定）
 *    - action 在 skeleton 中不存在 + 在 manual 中存在 → 保留 manual（向后兼容：旧 bindings 有 skeleton 未推导的接口）
 * 3. stateMap：manual.stateMap 浅合并 skeleton.stateMap（人工确认的系统词优先）
 * 4. 顺序：interfaces 中「manual 条目排前 + skeleton-only 条目在后」（保持可读性）
 * 5. 其他字段（defaultEnv / environments / crossProtocolObservations）：取 manual；manual 缺省则取 skeleton
 * 6. errorMap：manual 覆盖 skeleton 同 key（与 stateMap 同构；用于 E11 错误绑定）
 *
 * 边界：
 * - 同一 action 在 skeleton 和 manual 中都存在，但 transport.type 不同（HTTP vs Kafka）
 *   → 不强制要求一致，仅 warning（允许人工为某接口选 Kafka 而 skeleton 默认 HTTP）
 *   → 当前实现：直接用 manual.transport（人工已显式覆盖，不算偏差）
 */
export function mergeBindings(
  skeleton: BindingConfig,
  manual: BindingConfig
): BindingConfig {
  // 1. roles 合并：manual 浅覆盖 skeleton 同名条目，未在 manual 出现的 skeleton 角色保留
  const mergedRoles: Record<string, RoleBinding> = { ...(skeleton.roles ?? {}) };
  for (const [rid, r] of Object.entries(manual.roles ?? {})) {
    mergedRoles[rid] = { ...mergedRoles[rid], ...r };
  }

  // 2. interfaces 合并：保留全部 manual 条目（向后兼容）+ skeleton 中 manual 未覆盖的条目
  const manualActions = new Set((manual.interfaces ?? []).map((b) => b.action));
  const skeletonOnly = (skeleton.interfaces ?? []).filter(
    (b) => !manualActions.has(b.action)
  );
  // 顺序：manual 在前（人工编辑的重点），skeleton-only 在后
  const mergedInterfaces: InterfaceBinding[] = [
    ...(manual.interfaces ?? []),
    ...skeletonOnly,
  ];

  // 3. stateMap 合并：manual 覆盖 skeleton 同 key
  const mergedStateMap: Record<string, string> = { ...(skeleton.stateMap ?? {}) };
  for (const [k, v] of Object.entries(manual.stateMap ?? {})) {
    mergedStateMap[k] = v;
  }

  // 6. E11：errorMap 合并（与 stateMap 同构；manual 覆盖 skeleton 同 key）
  const mergedErrorMap: Record<string, ErrorMapEntry> = { ...(skeleton.errorMap ?? {}) };
  for (const [k, v] of Object.entries(manual.errorMap ?? {})) {
    mergedErrorMap[k] = { ...mergedErrorMap[k], ...v };
  }

  // 4. 其他字段：manual 优先；manual 缺省则回退 skeleton
  const merged: BindingConfig = {
    roles: mergedRoles,
    interfaces: mergedInterfaces,
    stateMap: Object.keys(mergedStateMap).length > 0 ? mergedStateMap : undefined,
    errorMap: Object.keys(mergedErrorMap).length > 0 ? mergedErrorMap : undefined,
    defaultEnv: manual.defaultEnv ?? skeleton.defaultEnv,
    environments:
      manual.environments ?? (skeleton as { environments?: BindingConfig['environments'] }).environments,
    crossProtocolObservations:
      manual.crossProtocolObservations ?? skeleton.crossProtocolObservations,
  };
  return merged;
}

/**
 * 按协议过滤绑定条目。
 * 保留：protocol === protocolId 的条目 + 未打标（protocol 缺省）的兼容条目；
 * 剔除其他协议命中的条目。同 action 时 protocol 命中排前。
 */
export function filterInterfaces(
  interfaces: InterfaceBinding[],
  protocolId?: string
): InterfaceBinding[] {
  if (!protocolId) return interfaces;
  return interfaces
    .filter((b) => b.protocol === undefined || b.protocol === protocolId)
    .sort(
      (a, b) =>
        (a.protocol === protocolId ? 0 : 1) - (b.protocol === protocolId ? 0 : 1)
    );
}

/**
 * 应用绑定环境（bindings.environments）。
 * 选择规则：--env 显式指定 → 命中该环境；未指定 → defaultEnv；两者皆无或环境不存在 → 原样返回（向后兼容）。
 * 环境覆盖仅作用于角色：共享 roles 基础上按角色合并 baseUrl / auth / authConfig / headers / kafka / nsq。
 */
export function applyBindingEnvironment(
  config: BindingConfig,
  envName?: string
): BindingConfig {
  const name = envName ?? config.defaultEnv;
  const envs = config.environments;
  if (!name || !envs || !envs[name]) return config;
  const env = envs[name];
  const roles: Record<string, RoleBinding> = {};
  for (const [roleId, base] of Object.entries(config.roles ?? {})) {
    const override = env.roles?.[roleId];
    if (!override) {
      roles[roleId] = base;
      continue;
    }
    const merged: RoleBinding = { ...base, ...override };
    if (override.authConfig) {
      merged.authConfig = { ...base.authConfig, ...override.authConfig };
    }
    if (override.kafka) {
      merged.kafka = { ...base.kafka, ...override.kafka };
    }
    if (override.nsq) {
      merged.nsq = { ...base.nsq, ...override.nsq };
    }
    roles[roleId] = merged;
  }
  return { ...config, roles };
}

export function resolveBindings(
  specs: InterfaceSpec[],
  config: BindingConfig,
  protocolId?: string
): ResolvedBinding[] {
  const filtered = filterInterfaces(config.interfaces ?? [], protocolId);
  const roleBindings = config.roles ?? {};

  return specs.map((spec) => {
    const binding = filtered.find((b) => b.action === spec.name);
    const roleBinding = binding ? roleBindings[binding.roleId] : undefined;

    return { spec, binding, roleBinding };
  });
}

export function validateBindings(
  specs: InterfaceSpec[],
  config: BindingConfig,
  protocolId?: string
): BindingValidationReport {
  const missingSystem: string[] = [];
  const missingObservation: string[] = [];
  const warnings: string[] = [];
  const roleIds = new Set(Object.keys(config.roles ?? {}));

  const filtered = filterInterfaces(config.interfaces ?? [], protocolId);

  // 同协议内同 action 重复定义 → 告警（后命中的条目永远不会被使用）
  const seenAction = new Map<string, number>();
  filtered.forEach((b, idx) => {
    const key = `${b.action}@${b.protocol ?? '(未打标)'}`;
    const prev = seenAction.get(key);
    if (prev !== undefined) {
      warnings.push(
        `action "${b.action}" 在协议 ${b.protocol ?? '(未打标)'} 下重复定义（第 ${prev + 1} 与第 ${
          idx + 1
        } 条，过滤后顺序），后者不会被使用`
      );
    } else {
      seenAction.set(key, idx);
    }
  });

  for (const spec of specs) {
    const binding = filtered.find((b) => b.action === spec.name);
    if (!binding) {
      if (spec.kind === 'system') {
        missingSystem.push(spec.name);
      } else if (spec.kind === 'observation') {
        missingObservation.push(spec.name);
      }
      continue;
    }

    // 多协议：命中未打标条目（而非 protocol 命中）→ 提示打标归属
    if (protocolId && binding.protocol === undefined) {
      warnings.push(
        `${spec.name}: 命中未打标的绑定条目（建议补充 protocol: ${protocolId}，避免与其他子协议同名 action 冲突）`
      );
    }

    // 校验 roleId 存在性
    if (!roleIds.has(binding.roleId)) {
      warnings.push(
        `${spec.name}: roleId "${binding.roleId}" 未在 bindings.roles 中定义`
      );
    }

    // 校验 Kafka responseMode 完整性
    if (
      binding.transport.type === 'kafka' &&
      binding.transport.responseMode === 'reply_topic' &&
      !binding.transport.responseTopic
    ) {
      warnings.push(
        `${spec.name}: responseMode='reply_topic' 但未配置 responseTopic`
      );
    }

    // 校验 NSQ responseMode 完整性
    if (
      binding.transport.type === 'nsq' &&
      binding.transport.responseMode === 'reply_topic' &&
      !binding.transport.responseTopic
    ) {
      warnings.push(
        `${spec.name}: [nsq] responseMode='reply_topic' 但未配置 responseTopic`
      );
    }
  }

  // ── E11：错误契约完整性（errorMap 必须覆盖 specs.errorResponses 中的所有 errorCode）──
  const unmappedErrorCodes: string[] = [];
  const declaredErrorCodes = new Set<string>();
  for (const spec of specs) {
    for (const er of spec.errorResponses ?? []) {
      declaredErrorCodes.add(er.errorCode);
      if (!config.errorMap || !(er.errorCode in config.errorMap)) {
        unmappedErrorCodes.push(er.errorCode);
      }
    }
  }

  // errorMap 中多余的 errorCode（不在 specs/异常路径中）→ warning（可能残留）
  let extraErrorCodes: string[] | undefined;
  if (config.errorMap) {
    extras: for (const code of Object.keys(config.errorMap)) {
      if (!declaredErrorCodes.has(code)) {
        if (!extraErrorCodes) extraErrorCodes = [];
        extraErrorCodes.push(code);
        warnings.push(
          `errorMap 中的错误码 "${code}" 未在 specs.errorResponses 中声明（可能是残留）`
        );
      }
    }
  }
  if (unmappedErrorCodes.length > 0) {
    const dedup = Array.from(new Set(unmappedErrorCodes));
    for (const code of dedup) {
      warnings.push(
        `errorCode "${code}" 在 specs.errorResponses 中声明但未在 bindings.errorMap 绑定（bind 失败）`
      );
    }
  }

  return {
    valid:
      missingSystem.length === 0 &&
      missingObservation.length === 0 &&
      unmappedErrorCodes.length === 0,
    missingSystem,
    missingObservation,
    warnings,
    unmappedErrorCodes: unmappedErrorCodes.length > 0 ? Array.from(new Set(unmappedErrorCodes)) : undefined,
    extraErrorCodes,
  };
}

export function findBinding(
  resolved: ResolvedBinding[],
  action: string
): ResolvedBinding | undefined {
  return resolved.find((r) => r.spec.name === action);
}
