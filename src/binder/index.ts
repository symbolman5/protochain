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
 */

import type {
  InterfaceSpec,
  BindingConfig,
  ResolvedBinding,
  BindingValidationReport,
  InterfaceBinding,
  RoleBinding,
} from '../model/types.js';

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

  return {
    valid: missingSystem.length === 0 && missingObservation.length === 0,
    missingSystem,
    missingObservation,
    warnings,
  };
}

export function findBinding(
  resolved: ResolvedBinding[],
  action: string
): ResolvedBinding | undefined {
  return resolved.find((r) => r.spec.name === action);
}
