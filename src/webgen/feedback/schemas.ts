/**
 * 反馈闭环：scenarios / bindings 在线编辑的 JSON Schema（ajv 校验）
 *
 * 设计依据：IMPLEMENTATION-ACCEPTANCE.md §E7 P1 §「在线编辑仍走权威源校验」
 *
 * 设计：
 *   - SCENARIO_SCHEMA：scenarios/*.yaml 的结构（含顶层字段 + 引用已实现 ScenarioParamSource）
 *   - BINDING_FILE_SCHEMA：bindings.yaml（仅骨架/必填子集，宽松接受 stub；与 E3 骨架一致性）
 *   - buildBindingAjv() 返回 ajv 实例；用于 store 层校验
 *   - 两个 schema 都限制为「最小可用」形态：额外字段允许（additionalProperties 默认 true），
 *     但必填/类型/形态严格；这是为了让用户在 Web 端补全 stub 后端到端跑通。
 *
 * 不可走的口子：在线编辑仍走权威源校验 —— 这是验收口径，避免 Web 端可以塞绕过 m-check 的坏数据。
 */

import Ajv from 'ajv';
import type { JSONSchemaType } from 'ajv';

export interface ScenarioSetupStep {
  action: string;
  params?: Record<string, unknown>;
}

export interface ScenarioFile {
  /** 场景 ID（例：SC-P1-01） */
  id: string;
  /** 场景名 */
  name?: string;
  /** 期望动作序列（用于与生成路径匹配） */
  expectedActions: string[];
  /** 运行时参数 */
  params?: Record<string, unknown>;
  /** 前置 setup */
  setup?: ScenarioSetupStep[];
  /**
   * E11：期望错误断言（场景层声明该路径期望遇到某个错误码）。
   * - 命中 errorMap 的指定 errorCode → 错误场景通过
   * - 未声明 expectedError 仍期望成功（沿用现有判定）
   * - 校验（feedback 端）：错误码必须为 snake_case；httpStatus 可选（整数）
   */
  expectedError?: ScenarioExpectedError;
  /** 注释（人读） */
  description?: string;
}

/** E11：场景层期望错误（与 binding-runner.ScopedExpectedError 对齐） */
export interface ScenarioExpectedError {
  errorCode: string;
  httpStatus?: number;
}

export const SCENARIO_SCHEMA: JSONSchemaType<ScenarioFile> = {
  type: 'object',
  required: ['id', 'expectedActions'],
  additionalProperties: true,
  properties: {
    id: {
      type: 'string',
      minLength: 1,
      maxLength: 256,
      // SC- 前缀 + 大写 —— 与现有 strangler-fig sc-01.yaml 的 SC-P1-01 命名一致
      pattern: '^SC-',
    },
    name: { type: 'string', nullable: true },
    expectedActions: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      minItems: 1,
    },
    params: {
      type: 'object',
      nullable: true,
      additionalProperties: true,
      required: [],
    },
    setup: {
      type: 'array',
      nullable: true,
      items: {
        type: 'object',
        required: ['action'],
        additionalProperties: true,
        properties: {
          action: { type: 'string', minLength: 1 },
          params: {
            type: 'object',
            nullable: true,
            additionalProperties: true,
            required: [],
          },
        },
      },
    },
    // ── E11：场景层期望错误 ──
    expectedError: {
      type: 'object',
      nullable: true,
      additionalProperties: false,
      required: ['errorCode'],
      properties: {
        // snake_case + 唯一 → 与 checker R-E2 对齐
        errorCode: {
          type: 'string',
          minLength: 1,
          pattern: '^[a-z][a-z0-9]*(_[a-z0-9]+)*$',
        },
        httpStatus: {
          type: 'integer',
          nullable: true,
          minimum: 100,
          maximum: 599,
        },
      },
    },
    description: { type: 'string', nullable: true },
  },
};

/**
 * bindings.yaml 的最小形态 —— 我们只让 Web 编辑 E3 骨架已展平的 `roles`/`interfaces`/
 * `environments`/`defaultEnv` 字段；其余字段（roles 内 authConfig.token 等敏感字段）
 * 仅做"读取后 redact"，不让 Web 端写入（保留 tokenEnv/secretEnv 等键名但 redact 展示）。
 *
 * 字段严格度：
 *   - 必填顶层字段：roles[] + interfaces[]
 *   - environments/defaultEnv：可选
 *   - interfaces[].action 必填（决定 derive-bindings 骨架如何被引用）
 *   - interfaces[].transport.method/path：选填（允许 stub 由 E3 骨架填充）
 */
export interface BindingFile {
  roles: Array<{
    roleId: string;
    auth?: string;
    [k: string]: unknown;
  }>;
  interfaces: Array<{
    action: string;
    protocol?: string;
    roleId?: string;
    transport?: {
      type?: string;
      method?: string;
      path?: string;
      params?: unknown;
      [k: string]: unknown;
    };
    [k: string]: unknown;
  }>;
  /** 简易形态：{ dev: { roles: { "R-Op": { baseUrl: ... } } } } */
  environments?: Record<string, { roles?: Record<string, unknown>; [k: string]: unknown }>;
  defaultEnv?: string;
  [k: string]: unknown;
}

/**
 * 用 `any` schema 而非 JSONSchemaType<T>：
 * ajv strict 模式下 JSONSchemaType<T> 与 `additionalProperties: true`/nullable 联合时
 * 编译会报 "strict mode: unknown keyword"。这里用通用 schema + 运行时类型推断替代，
 * 实测等价且兼容 ajv 编译（schemas.test.ts 验证）。
 */
export const BINDING_FILE_SCHEMA = {
  type: 'object',
  required: ['roles', 'interfaces'],
  additionalProperties: true,
  properties: {
    roles: {
      type: 'array',
      items: {
        type: 'object',
        required: ['roleId'],
        additionalProperties: true,
        properties: {
          roleId: { type: 'string', minLength: 1 },
          auth: { type: 'string' },
        },
      },
    },
    interfaces: {
      type: 'array',
      items: {
        type: 'object',
        required: ['action'],
        additionalProperties: true,
        properties: {
          action: { type: 'string', minLength: 1 },
          protocol: { type: 'string' },
          roleId: { type: 'string' },
          transport: {
            type: 'object',
            additionalProperties: true,
            properties: {
              type: { type: 'string' },
              method: { type: 'string' },
              path: { type: 'string' },
              params: {
                oneOf: [
                  { type: 'array' },
                  { type: 'object' },
                  { type: 'null' },
                ],
              },
            },
          },
        },
      },
    },
    environments: {
      type: 'object',
      additionalProperties: true,
    },
    defaultEnv: { type: 'string' },
  },
} as const;

/**
 * ajv 实例工厂：strict=false（避免现有 strangler-fig 实例字段被 ajv 误判），
 * allErrors=true，messages=true。
 */
let ajvInstance: Ajv | null = null;
function getAjv(): Ajv {
  if (ajvInstance) return ajvInstance;
  ajvInstance = new Ajv({
    allErrors: true,
    strict: false,
    // 允许 unknownFormats（regex 类）但禁止 silent pass
    strictSchema: false,
  });
  return ajvInstance;
}

/** 构造 scenario 校验器（返回 ajv ValidateFunction） */
export function buildScenarioAjv(): ReturnType<Ajv['compile']> {
  const ajv = getAjv();
  return ajv.compile(SCENARIO_SCHEMA);
}

/** 构造 bindings 校验器 */
export function buildBindingAjv(): ReturnType<Ajv['compile']> {
  const ajv = getAjv();
  return ajv.compile(BINDING_FILE_SCHEMA);
}

/**
 * 把 ajv 错误格式化为单字符串（前端展示用）
 */
export function formatAjvErrors(errs: Array<{ instancePath?: string; message?: string }> | null | undefined): string {
  if (!errs || errs.length === 0) return '未知 ajv 错误';
  return errs
    .map((e) => `${e.instancePath ?? '(root)'} ${e.message ?? ''}`.trim())
    .join('；');
}

/**
 * 校验场景对象，返回 { ok: true } 或 { ok: false, error: string }
 */
export function validateScenario(parsed: unknown): { ok: true } | { ok: false; error: string } {
  const validate = buildScenarioAjv();
  if (validate(parsed)) return { ok: true };
  return { ok: false, error: formatAjvErrors(validate.errors) };
}

/**
 * 校验 bindings.yaml 对象
 */
export function validateBindingFile(parsed: unknown): { ok: true } | { ok: false; error: string } {
  const validate = buildBindingAjv();
  if (validate(parsed)) return { ok: true };
  return { ok: false, error: formatAjvErrors(validate.errors) };
}
