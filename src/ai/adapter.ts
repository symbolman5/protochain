/**
 * AI 适配器接口与实现
 *
 * 设计依据：《协议驱动自验证工具链设计方案》第四节 AI集成
 *
 * 适配器只负责调用 AI 和解析输出，不负责检查点逻辑。
 * 检查点门控由 orchestrator 承担。
 *
 * 支持三种适配器：
 * - OpenAI（含兼容接口）
 * - Anthropic
 * - Local（本地模型 / 占位实现，用于无 AI 环境下的开发与测试）
 */

import type { AIAdapter, AIPrompt, AIResponse } from '../model/types.js';

// ============================================================================
// OpenAI 适配器
// ============================================================================

export interface OpenAIAdapterConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

export class OpenAIAdapter implements AIAdapter {
  name = 'openai';
  private config: Required<OpenAIAdapterConfig>;

  /** 当前使用的模型名（供多模型路由观测/测试） */
  get modelName(): string {
    return this.config.model;
  }

  constructor(config: OpenAIAdapterConfig) {
    this.config = {
      apiKey: config.apiKey,
      model: config.model ?? 'gpt-4o',
      baseUrl: config.baseUrl ?? 'https://api.openai.com/v1',
    };
  }

  async complete(prompt: AIPrompt): Promise<AIResponse> {
    const body = {
      model: this.config.model,
      temperature: prompt.temperature,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: this.buildUserContent(prompt) },
      ],
    };

    try {
      const res = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text();
        return { content: '', success: false, error: `HTTP ${res.status}: ${text}` };
      }

      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = data.choices?.[0]?.message?.content ?? '';
      if (!content) {
        return { content: '', success: false, error: 'AI 返回空内容' };
      }
      return { content, success: true, attempts: 1 };
    } catch (err) {
      return {
        content: '',
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private buildUserContent(prompt: AIPrompt): string {
    return [
      '## Context',
      prompt.context,
      '',
      '## Instruction',
      prompt.instruction,
      '',
      '## Output Format',
      prompt.outputFormat,
    ].join('\n');
  }
}

// ============================================================================
// Anthropic 适配器
// ============================================================================

export interface AnthropicAdapterConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

export class AnthropicAdapter implements AIAdapter {
  name = 'anthropic';
  private config: Required<AnthropicAdapterConfig>;

  /** 当前使用的模型名（供多模型路由观测/测试） */
  get modelName(): string {
    return this.config.model;
  }

  constructor(config: AnthropicAdapterConfig) {
    this.config = {
      apiKey: config.apiKey,
      model: config.model ?? 'claude-3-5-sonnet-20241022',
      baseUrl: config.baseUrl ?? 'https://api.anthropic.com/v1',
    };
  }

  async complete(prompt: AIPrompt): Promise<AIResponse> {
    const body = {
      model: this.config.model,
      temperature: prompt.temperature,
      max_tokens: 4096,
      system: prompt.system,
      messages: [
        {
          role: 'user',
          content: this.buildUserContent(prompt),
        },
      ],
    };

    try {
      const res = await fetch(`${this.config.baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text();
        return { content: '', success: false, error: `HTTP ${res.status}: ${text}` };
      }

      const data = (await res.json()) as {
        content?: { type: string; text?: string }[];
      };
      const content = data.content?.find((c) => c.type === 'text')?.text ?? '';
      if (!content) {
        return { content: '', success: false, error: 'AI 返回空内容' };
      }
      return { content, success: true, attempts: 1 };
    } catch (err) {
      return {
        content: '',
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private buildUserContent(prompt: AIPrompt): string {
    return [
      '## Context',
      prompt.context,
      '',
      '## Instruction',
      prompt.instruction,
      '',
      '## Output Format',
      prompt.outputFormat,
    ].join('\n');
  }
}

// ============================================================================
// Local 适配器（无 AI 环境下的占位实现）
// ============================================================================

export interface LocalAdapterConfig {
  /** 本地模型端点（OpenAI 兼容协议） */
  baseUrl?: string;
  model?: string;
}

export class LocalAdapter implements AIAdapter {
  name = 'local';
  private baseUrl?: string;
  private model: string;

  /** 当前使用的模型名（供多模型路由观测/测试） */
  get modelName(): string {
    return this.model;
  }

  constructor(config: LocalAdapterConfig = {}) {
    this.baseUrl = config.baseUrl;
    this.model = config.model ?? 'local';
  }

  async complete(prompt: AIPrompt): Promise<AIResponse> {
    // 若配置了 baseUrl，尝试调用本地 OpenAI 兼容端点
    if (this.baseUrl) {
      try {
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: this.model,
            temperature: prompt.temperature,
            messages: [
              { role: 'system', content: prompt.system },
              {
                role: 'user',
                content: [
                  '## Context',
                  prompt.context,
                  '## Instruction',
                  prompt.instruction,
                  '## Output Format',
                  prompt.outputFormat,
                ].join('\n'),
              },
            ],
          }),
        });
        if (!res.ok) {
          return {
            content: '',
            success: false,
            error: `本地模型 HTTP ${res.status}`,
          };
        }
        const data = (await res.json()) as {
          choices?: { message?: { content?: string } }[];
        };
        const content = data.choices?.[0]?.message?.content ?? '';
        return content
          ? { content, success: true, attempts: 1 }
          : { content: '', success: false, error: '本地模型返回空内容' };
      } catch (err) {
        return {
          content: '',
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    // 无端点：返回未执行占位
    return {
      content: '',
      success: false,
      error:
        '未配置 AI 适配器（local 无 baseUrl）。语义层检查需要 AI，请在 protochain.config.yaml 中配置 ai.provider。',
    };
  }
}

// ============================================================================
// 适配器工厂
// ============================================================================

/** 各 provider 对应的工业标准 API key 环境变量名（config.apiKey 缺省时兜底） */
const ENV_KEY_BY_PROVIDER: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
};

export function createAIAdapter(
  config: { provider: 'openai' | 'anthropic' | 'local' | 'deepseek'; apiKey?: string; model?: string; baseUrl?: string }
): AIAdapter {
  // apiKey 优先取 config，缺省时按 provider 读对应环境变量
  const envKey = ENV_KEY_BY_PROVIDER[config.provider];
  const apiKey = config.apiKey ?? (envKey ? process.env[envKey] : undefined);

  switch (config.provider) {
    case 'openai':
      if (!apiKey) throw new Error('OpenAI 适配器需要 apiKey（config.ai.apiKey 或 OPENAI_API_KEY 环境变量）');
      return new OpenAIAdapter({
        apiKey,
        model: config.model,
        baseUrl: config.baseUrl,
      });
    case 'anthropic':
      if (!apiKey) throw new Error('Anthropic 适配器需要 apiKey（config.ai.apiKey 或 ANTHROPIC_API_KEY 环境变量）');
      return new AnthropicAdapter({
        apiKey,
        model: config.model,
        baseUrl: config.baseUrl,
      });
    case 'deepseek':
      // DeepSeek 使用 OpenAI 兼容 API
      if (!apiKey) throw new Error('DeepSeek 适配器需要 apiKey（config.ai.apiKey 或 DEEPSEEK_API_KEY 环境变量）');
      return new OpenAIAdapter({
        apiKey,
        model: config.model,
        baseUrl: config.baseUrl ?? 'https://api.deepseek.com',
      });
    case 'local':
      return new LocalAdapter({ baseUrl: config.baseUrl, model: config.model });
  }
}

/**
 * JSON 输出解析：从 AI 响应中提取 JSON（容忍 ```json 代码块包裹）
 */
export function parseAIJson<T>(content: string): T {
  const cleaned = content
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  return JSON.parse(cleaned) as T;
}
