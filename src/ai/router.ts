/**
 * 多模型路由 —— 对应《Harness 架构设计》§7.2
 *
 * 分层原则：窄模型做检索/语义层检查，强模型做推理/形式化，生成类步骤单独指定。
 * 与 protochain 的"代码预判（确定性）+ AI 复核（推理）"对应：
 * - semantic   ：语义层检查（check / verify 辅助摘要 / diff / version 分类等）用便宜模型；
 * - reasoning  ：reason / formalize / derive-contracts 用强模型；
 * - generation ：generate-tests / generate-cases 的生成 loop。
 *
 * 未配置某角色的模型时回退到 ai.model；未配置 ai 时调用方应自行走确定性路径。
 */
import type { AIAdapter, ProtochainConfig } from '../model/types.js';
import { createAIAdapter } from './adapter.js';

export type AIRole = 'semantic' | 'reasoning' | 'generation';

export interface AIRouter {
  /** 按角色返回适配器；同一角色缓存复用同一实例 */
  get(role: AIRole): AIAdapter;
  /** 按角色解析模型名（纯解析，供观测/测试） */
  modelFor(role: AIRole): string | undefined;
}

type AIConfig = NonNullable<ProtochainConfig['ai']>;

const ALL_ROLES: AIRole[] = ['semantic', 'reasoning', 'generation'];

export function resolveRoleModel(config: AIConfig, role: AIRole): string | undefined {
  return config.models?.[role] ?? config.model;
}

/**
 * 创建多模型路由器。按角色解析模型名并构造适配器；
 * 若任一角色因缺少 apiKey 等无法构造，立即抛出（与 createAIAdapter 行为一致，
 * 由调用方决定是告警降级还是中断）。
 */
export function createAIRouter(config: AIConfig): AIRouter {
  const adapters = new Map<AIRole, AIAdapter>();
  for (const role of ALL_ROLES) {
    adapters.set(
      role,
      createAIAdapter({
        provider: config.provider,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: resolveRoleModel(config, role),
      })
    );
  }

  return {
    get(role: AIRole): AIAdapter {
      const adapter = adapters.get(role);
      if (!adapter) {
        throw new Error(`未知 AI 角色：${role}`);
      }
      return adapter;
    },
    modelFor(role: AIRole): string | undefined {
      return resolveRoleModel(config, role);
    },
  };
}
