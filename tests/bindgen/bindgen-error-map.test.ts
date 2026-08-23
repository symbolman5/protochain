/**
 * E11 errorMap 骨架推导 + mergeBindings + validateBindings — bindgen/binder 单测
 *
 * 设计依据：IMPLEMENTATION-PLAN.md §E11、docs/error-modeling-plan.md §3
 *
 * 覆盖：
 * - bindgen：从 specs.errorResponses 派生 errorMap 骨架（httpStatus + 默认 bodyField='code'）
 * - mergeBindings：errorMap manual > skeleton 优先级
 * - validateBindings：specs.errorResponses 中的 errorCode 缺绑 → valid=false
 * - validateBindings：errorMap 中含 specs 没声明的 errorCode → warning
 */

import {
  deriveErrorMap,
  deriveSkeletonBindings,
  SKELETON_MARKER,
} from '../../src/bindgen/index.js';
import { mergeBindings, validateBindings } from '../../src/binder/index.js';
import type {
  BindingConfig,
  InterfaceSpec,
  JSONSchema,
} from '../../src/model/types.js';

const errorRespSchema: JSONSchema = {
  type: 'object',
  properties: { code: { type: 'string' } },
};

function makeSpec(
  name: string,
  errorResponses?: Array<{
    id: string;
    errorCode: string;
    httpStatus: number;
    bodySchema?: JSONSchema;
  }>
): InterfaceSpec {
  return {
    id: `IF_SYS_${name}`,
    kind: 'system',
    sourceId: name,
    name,
    inputs: [],
    outputs: [],
    errorResponses,
  };
}

function makeMiniModel() {
  return {
    metadata: {
      name: 'Test',
      version: '1.0.0',
      purpose: 'p',
      roles: [
        { id: 'R', name: 'R', roleType: 'participant' as const },
      ],
    },
    readable: { background: '', concepts: [], workflow: '' },
    derivable: {
      degraded: false,
      states: [],
      transitions: [],
      invariants: [],
      timing: [],
      exceptions: [],
      terminalStateIds: [],
    },
  };
}

describe('bindgen - E11 errorMap skeleton', () => {
  test('正向：从 specs.errorResponses 派生 errorMap（httpStatus + bodyField=code）', () => {
    const specs = [
      makeSpec('create_mapping', [
        { id: 'ERR-01', errorCode: 'domain_not_owned', httpStatus: 409, bodySchema: errorRespSchema },
      ]),
    ];
    const { errorMap, warnings } = deriveErrorMap(specs);
    expect(errorMap.domain_not_owned?.httpStatus).toBe(409);
    expect(errorMap.domain_not_owned?.bodyField).toBe('code');
    expect(warnings.length).toBeGreaterThan(0);
  });

  test('反向：specs 无 errorResponses → errorMap 空 + warning', () => {
    const specs = [makeSpec('create')];
    const { errorMap, warnings } = deriveErrorMap(specs);
    expect(Object.keys(errorMap)).toHaveLength(0);
    expect(warnings.some((w) => w.includes('errorMap 初始为空'))).toBe(true);
  });

  test('正向：多条 specs 各自带 errorResponses → errorMap 合并去重', () => {
    const specs = [
      makeSpec('s1', [
        { id: 'ERR-01', errorCode: 'code_a', httpStatus: 409 },
        { id: 'ERR-02', errorCode: 'code_b', httpStatus: 403 },
      ]),
      makeSpec('s2', [
        { id: 'ERR-03', errorCode: 'code_c', httpStatus: 500 },
        // 重复：同样 code_a 在另一 spec 里
        { id: 'ERR-04', errorCode: 'code_a', httpStatus: 409 },
      ]),
    ];
    const { errorMap } = deriveErrorMap(specs);
    expect(Object.keys(errorMap)).toEqual(['code_a', 'code_b', 'code_c']);
  });
});

describe('binder - E11 mergeBindings errorMap', () => {
  test('正向：manual.errorMap 覆盖 skeleton.errorMap 同 key', () => {
    const skeleton: BindingConfig = {
      roles: {},
      interfaces: [],
      errorMap: {
        domain_not_owned: { httpStatus: 409 },
        domain_taken: { httpStatus: 409 },
      },
    };
    const manual: BindingConfig = {
      roles: {},
      interfaces: [],
      errorMap: {
        domain_not_owned: {
          httpStatus: 409,
          systemCode: 'E40901',
          bodyField: 'code',
          bodyFieldValue: 'DOMAIN_NOT_OWNED',
        },
      },
    };
    const merged = mergeBindings(skeleton, manual);
    expect(merged.errorMap?.domain_not_owned?.systemCode).toBe('E40901');
    expect(merged.errorMap?.domain_not_owned?.bodyFieldValue).toBe('DOMAIN_NOT_OWNED');
    // skeleton only 条目保留
    expect(merged.errorMap?.domain_taken?.httpStatus).toBe(409);
  });

  test('反向：manual 无 errorMap → 沿用 skeleton.errorMap', () => {
    const skeleton: BindingConfig = {
      roles: {},
      interfaces: [],
      errorMap: { foo: { httpStatus: 400 } },
    };
    const manual: BindingConfig = { roles: {}, interfaces: [] };
    const merged = mergeBindings(skeleton, manual);
    expect(merged.errorMap?.foo?.httpStatus).toBe(400);
  });

  test('反向：双方都无 errorMap → 合并结果无 errorMap', () => {
    const skeleton: BindingConfig = { roles: {}, interfaces: [] };
    const manual: BindingConfig = { roles: {}, interfaces: [] };
    const merged = mergeBindings(skeleton, manual);
    expect(merged.errorMap).toBeUndefined();
  });
});

describe('binder - E11 validateBindings errorMap 完整性', () => {
  test('反向：specs 声明 errorCode 但 bindings.errorMap 缺失 → valid=false + unmappedErrorCodes', () => {
    const specs = [
      makeSpec('create_mapping', [
        { id: 'ERR-01', errorCode: 'domain_not_owned', httpStatus: 409 },
      ]),
    ];
    const config: BindingConfig = {
      roles: {},
      interfaces: [],
      // errorMap 缺失
    };
    const report = validateBindings(specs, config);
    expect(report.valid).toBe(false);
    expect(report.unmappedErrorCodes).toContain('domain_not_owned');
    expect(report.warnings.some((w) => w.includes('domain_not_owned'))).toBe(true);
  });

  test('正向：specs 声明 = errorMap 全覆盖 → valid=true', () => {
    const specs = [
      makeSpec('create_mapping', [
        { id: 'ERR-01', errorCode: 'domain_not_owned', httpStatus: 409 },
      ]),
    ];
    const config: BindingConfig = {
      // 关键：specs.name 必须能在 interfaces 中找到，否则 missingSystem 非空 → valid=false
      roles: { r: { roleId: 'r', baseUrl: 'http://x', auth: 'none' } },
      interfaces: [
        { action: 'create_mapping', roleId: 'r', transport: { type: 'http', method: 'POST', path: '/c' } },
      ],
      errorMap: {
        domain_not_owned: { httpStatus: 409, bodyField: 'code' },
      },
    };
    const report = validateBindings(specs, config);
    expect(report.valid).toBe(true);
    expect(report.unmappedErrorCodes).toBeUndefined();
  });

  test('反向：errorMap 中含 specs 未声明的 errorCode → warning + extraErrorCodes', () => {
    const specs: InterfaceSpec[] = [];
    const config: BindingConfig = {
      roles: {},
      interfaces: [],
      errorMap: {
        phantom_code: { httpStatus: 400 },
      },
    };
    const report = validateBindings(specs, config);
    // specs 无 errorCode → valid 本应 true（无 unmapped）
    expect(report.valid).toBe(true);
    expect(report.extraErrorCodes).toContain('phantom_code');
    expect(report.warnings.some((w) => w.includes('phantom_code'))).toBe(true);
  });

  test('兼容：specs 无 errorResponses + bindings 无 errorMap → 沿用旧行为（valid=true）', () => {
    const specs = [
      makeSpec('create', /* no errorResponses */),
    ];
    const config: BindingConfig = {
      roles: { r: { roleId: 'r', baseUrl: 'http://x', auth: 'none' } },
      interfaces: [
        { action: 'create', roleId: 'r', transport: { type: 'http', method: 'POST', path: '/c' } },
      ],
    };
    const report = validateBindings(specs, config);
    expect(report.valid).toBe(true);
    expect(report.unmappedErrorCodes).toBeUndefined();
  });
});

describe('bindgen - errorMap 集成到 skeleton', () => {
  test('正向：deriveSkeletonBindings 含 errorMap 字段', () => {
    const model = makeMiniModel();
    const specs = [
      makeSpec('create', [
        { id: 'ERR-01', errorCode: 'err_a', httpStatus: 409 },
      ]),
    ];
    const skeleton = deriveSkeletonBindings(model, specs, {
      sourceEnvelope: true,
      sourceMigrated: false,
      sourceMigrationWarnings: [],
    });
    expect(skeleton[SKELETON_MARKER]).toBe(true);
    expect(skeleton.errorMap?.err_a?.httpStatus).toBe(409);
    // manualConfirmItems 应包含 errorMap 条目
    expect(skeleton.stats.manualConfirmItems).toBeGreaterThanOrEqual(1);
  });
});
