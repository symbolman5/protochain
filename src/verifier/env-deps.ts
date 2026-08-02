/**
 * 环境变量依赖扫描与告警 —— verify 前置校验（不阻断执行）
 *
 * 职责：
 * 1. 扫描当前环境（bindings.environments 解析后）所有角色绑定中的 *Env 字段
 *    （tokenEnv / usernameEnv / passwordEnv / keyEnv / brokersEnv / nsqdTcpEnv / nsqlookupdHttpEnv / connectionEnv）
 * 2. 生成环境依赖清单落盘 <系统根>/derived/env-deps.json
 * 3. 未设置的环境变量打印显式告警（含角色、接口列表、预计失败类型），不阻断 verify
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BindingConfig, RoleBinding } from '../model/types.js';
import { findConfigPath } from '../project/context.js';
import { filterInterfaces } from '../binder/index.js';

/** 单个环境变量依赖 */
export interface EnvDependency {
  /** 环境变量名 */
  envName: string;
  /** 所属角色 */
  roleId: string;
  /** 配置来源（如 authConfig.tokenEnv / kafka.brokersEnv） */
  source: string;
  /** 使用该角色的绑定接口（protocol 过滤后） */
  interfaces: string[];
  /** 缺失时的预计失败类型 */
  expectedFailure: string;
}

/** 环境依赖扫描报告（env-deps.json 结构） */
export interface EnvDepsReport {
  /** 生效的绑定环境名（--env 或 defaultEnv） */
  env?: string;
  dependencies: EnvDependency[];
  /** 未设置的环境变量名（去重） */
  missing: string[];
  generatedAt: string;
}

/** 角色级 *Env 字段扫描 */
function collectRoleEnvDeps(
  role: RoleBinding,
  interfaces: string[]
): EnvDependency[] {
  const deps: EnvDependency[] = [];
  const cfg = role.authConfig ?? {};
  const push = (envName: string, source: string, expectedFailure: string) => {
    deps.push({ envName, roleId: role.roleId, source, interfaces, expectedFailure });
  };
  if (cfg.tokenEnv) push(cfg.tokenEnv, 'authConfig.tokenEnv', 'HTTP 401 未认证（Bearer 令牌缺失）');
  if (cfg.usernameEnv) push(cfg.usernameEnv, 'authConfig.usernameEnv', 'HTTP 401 未认证（Basic 凭据缺失）');
  if (cfg.passwordEnv) push(cfg.passwordEnv, 'authConfig.passwordEnv', 'HTTP 401 未认证（Basic 凭据缺失）');
  if (cfg.keyEnv) push(cfg.keyEnv, 'authConfig.keyEnv', 'HTTP 401 未认证（API Key 缺失）');
  if (role.kafka?.brokersEnv) push(role.kafka.brokersEnv, 'kafka.brokersEnv', 'Kafka 连接失败（broker 地址缺失）');
  if (role.kafka?.sasl?.usernameEnv) push(role.kafka.sasl.usernameEnv, 'kafka.sasl.usernameEnv', 'Kafka SASL 认证失败');
  if (role.kafka?.sasl?.passwordEnv) push(role.kafka.sasl.passwordEnv, 'kafka.sasl.passwordEnv', 'Kafka SASL 认证失败');
  if (role.nsq?.nsqdTcpEnv) push(role.nsq.nsqdTcpEnv, 'nsq.nsqdTcpEnv', 'NSQ 连接失败（nsqd 地址缺失）');
  if (role.nsq?.nsqlookupdHttpEnv) push(role.nsq.nsqlookupdHttpEnv, 'nsq.nsqlookupdHttpEnv', 'NSQ 服务发现不可用');
  return deps;
}

/**
 * 扫描绑定中的环境变量依赖。
 * @param bindings 环境解析后的 bindings（调用方先 applyBindingEnvironment）
 * @param protocolId 多协议项目中的子协议 ID（过滤 interfaces）
 */
export function scanEnvDependencies(
  bindings: BindingConfig,
  protocolId?: string
): EnvDepsReport {
  const deps: EnvDependency[] = [];
  const filtered = filterInterfaces(bindings.interfaces ?? [], protocolId);
  const interfacesByRole = new Map<string, string[]>();
  for (const b of filtered) {
    const list = interfacesByRole.get(b.roleId) ?? [];
    list.push(b.action);
    interfacesByRole.set(b.roleId, list);
    // 传输层连接串环境变量（db_query）
    if (b.transport.type === 'db_query' && b.transport.connectionEnv) {
      deps.push({
        envName: b.transport.connectionEnv,
        roleId: b.roleId,
        source: 'transport.connectionEnv',
        interfaces: [b.action],
        expectedFailure: '数据库查询失败（连接串缺失）',
      });
    }
  }
  for (const [roleId, base] of Object.entries(bindings.roles ?? {})) {
    deps.push(...collectRoleEnvDeps(base, interfacesByRole.get(roleId) ?? []));
  }

  // 按环境变量名合并接口列表
  const byEnv = new Map<string, EnvDependency>();
  for (const d of deps) {
    const existing = byEnv.get(d.envName);
    if (existing) {
      existing.interfaces = Array.from(new Set([...existing.interfaces, ...d.interfaces]));
      continue;
    }
    byEnv.set(d.envName, d);
  }
  const dependencies = Array.from(byEnv.values());

  return {
    dependencies,
    missing: Array.from(new Set(
      dependencies.filter((d) => !process.env[d.envName]).map((d) => d.envName)
    )),
    generatedAt: new Date().toISOString(),
  };
}

/**
 * 扫描并落盘环境依赖清单到 <系统根>/derived/env-deps.json（无配置文件时跳过落盘）。
 */
export function writeEnvDepsReport(
  rootDir: string,
  bindings: BindingConfig,
  protocolId?: string,
  envName?: string
): EnvDepsReport {
  const report = scanEnvDependencies(bindings, protocolId);
  report.env = envName ?? bindings.defaultEnv;
  const configPath = findConfigPath(rootDir);
  if (configPath) {
    const derivedDir = join(dirname(configPath), 'derived');
    mkdirSync(derivedDir, { recursive: true });
    writeFileSync(
      join(derivedDir, 'env-deps.json'),
      JSON.stringify(report, null, 2),
      'utf-8'
    );
  }
  return report;
}

/**
 * 生成缺失环境变量告警文本（无缺失返回 undefined）。
 */
export function formatEnvDepsWarnings(report: EnvDepsReport): string | undefined {
  if (report.missing.length === 0) return undefined;
  const lines = [
    `环境变量缺失（${report.missing.length} 个）——verify 不会阻断，但相关接口将因认证/连接失败而报偏差：`,
  ];
  for (const name of report.missing) {
    const dep = report.dependencies.find((d) => d.envName === name);
    lines.push(
      `  - ${name}（角色 ${dep?.roleId ?? '?'}，接口 ${dep?.interfaces.join(', ') || '?'}）` +
        `→ 预计 ${dep?.expectedFailure ?? '失败'}`
    );
  }
  lines.push(`  提示：先 export ${report.missing.join(' ')} 再执行 verify（详见手册 4.8 节）`);
  return lines.join('\n');
}
