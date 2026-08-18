/**
 * 多模型路由单测 —— P3 剩余部分（§7.2）
 *
 * 覆盖：
 * - 按角色解析模型：角色覆盖 > 默认 model；
 * - 同一角色缓存复用同一适配器实例，不同角色实例不同；
 * - 未配置角色模型时回退默认 model；
 * - apiKey 缺失时构造失败（与 createAIAdapter 一致，不静默降级）。
 */

import { createAIRouter, resolveRoleModel } from '../../src/ai/router.js';
import type { ProtochainConfig } from '../../src/model/types.js';

type AIConfig = NonNullable<ProtochainConfig['ai']>;

const LOCAL_CONFIG: AIConfig = {
  provider: 'local',
  model: 'default-model',
  models: {
    semantic: 'cheap-flash',
    reasoning: 'strong-pro',
    generation: 'gen-flash',
  },
};

describe('多模型路由（ai/router）', () => {
  test('按角色解析模型：角色覆盖优先，未配置角色回退默认 model', () => {
    expect(resolveRoleModel(LOCAL_CONFIG, 'semantic')).toBe('cheap-flash');
    expect(resolveRoleModel(LOCAL_CONFIG, 'reasoning')).toBe('strong-pro');
    expect(resolveRoleModel(LOCAL_CONFIG, 'generation')).toBe('gen-flash');

    const noRoleOverrides: AIConfig = { provider: 'local', model: 'fallback' };
    expect(resolveRoleModel(noRoleOverrides, 'semantic')).toBe('fallback');
    expect(resolveRoleModel(noRoleOverrides, 'reasoning')).toBe('fallback');
    expect(resolveRoleModel(noRoleOverrides, 'generation')).toBe('fallback');
  });

  test('各角色返回对应模型的适配器，且同一角色缓存复用实例', () => {
    const router = createAIRouter(LOCAL_CONFIG);

    expect(router.get('semantic').modelName).toBe('cheap-flash');
    expect(router.get('reasoning').modelName).toBe('strong-pro');
    expect(router.get('generation').modelName).toBe('gen-flash');
    expect(router.modelFor('reasoning')).toBe('strong-pro');

    // 缓存复用：同一角色两次 get 返回同一实例
    expect(router.get('semantic')).toBe(router.get('semantic'));
    // 不同角色实例不同
    expect(router.get('semantic')).not.toBe(router.get('reasoning'));
  });

  test('未配置 models 时全部角色回退默认 model', () => {
    const router = createAIRouter({ provider: 'local', model: 'single' });
    expect(router.get('semantic').modelName).toBe('single');
    expect(router.get('reasoning').modelName).toBe('single');
    expect(router.get('generation').modelName).toBe('single');
  });

  test('apiKey 缺失时构造失败（与 createAIAdapter 一致，不静默降级）', () => {
    expect(() =>
      createAIRouter({
        provider: 'openai',
        apiKey: '',
        model: 'gpt-4o',
      })
    ).toThrow(/apiKey/);
  });
});
