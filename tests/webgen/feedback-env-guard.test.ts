/**
 * env-guard 单测 —— E7-P1 安全面（红线条目）
 *
 * 覆盖：
 *   - 敏感键名识别：TOKEN/SECRET/PASSWORD/APIKEY/PASSWD/CREDENTIAL（不区分大小写）
 *   - scrubProcessEnv()：删除所有敏感键，且只删敏感键
 *   - filterEnvForChild()：白名单 + 显式覆盖；不会透传敏感键
 *   - assertSecretLeak()：捕获「值等于或包含已知 secret」的子树
 *   - 兜底：filterEnvForChild 即使白名单写错也不漏敏感键
 */

import {
  isSensitiveEnvKey,
  scrubProcessEnv,
  filterEnvForChild,
  assertSecretLeak,
  SENSITIVE_ENV_KEY_PATTERNS,
  CHILD_ENV_ALLOWLIST,
  checkProcEnvironForSecrets,
  maskSensitiveEnvKey,
} from '../../src/webgen/feedback/env-guard.js';

describe('feedback/env-guard: 敏感键名识别', () => {
  test('TOKEN/SECRET/PASSWORD/APIKEY 类键名命中（不区分大小写）', () => {
    expect(isSensitiveEnvKey('TOKEN')).toBe(true);
    expect(isSensitiveEnvKey('SECRET')).toBe(true);
    expect(isSensitiveEnvKey('PASSWORD')).toBe(true);
    expect(isSensitiveEnvKey('API_KEY')).toBe(true);
    expect(isSensitiveEnvKey('LEGACY_TOKEN')).toBe(true);
    expect(isSensitiveEnvKey('auth_token_secret')).toBe(true);
    expect(isSensitiveEnvKey('apiKey')).toBe(true);
    expect(isSensitiveEnvKey('mysql_PASSWD')).toBe(true);
    expect(isSensitiveEnvKey('GITHUB_CREDENTIAL')).toBe(true);
    expect(isSensitiveEnvKey('MY_CREDENTIAL')).toBe(true);
  });
  test('非敏感键名不命中', () => {
    expect(isSensitiveEnvKey('PATH')).toBe(false);
    expect(isSensitiveEnvKey('HOME')).toBe(false);
    expect(isSensitiveEnvKey('USER')).toBe(false);
    expect(isSensitiveEnvKey('LANG')).toBe(false);
    expect(isSensitiveEnvKey('NODE_ENV')).toBe(false);
    expect(isSensitiveEnvKey('PROTOCHAIN_ROOT')).toBe(false);
  });
  test('SENSITIVE_ENV_KEY_PATTERNS 非空且为正则数组', () => {
    expect(SENSITIVE_ENV_KEY_PATTERNS.length).toBeGreaterThan(0);
    for (const r of SENSITIVE_ENV_KEY_PATTERNS) expect(r).toBeInstanceOf(RegExp);
  });
  test('CHILD_ENV_ALLOWLIST 含 PATH/HOME/PWD 等基础键', () => {
    expect(CHILD_ENV_ALLOWLIST).toContain('PATH');
    expect(CHILD_ENV_ALLOWLIST).toContain('HOME');
    expect(CHILD_ENV_ALLOWLIST).toContain('PWD');
  });
});

describe('feedback/env-guard: scrubProcessEnv', () => {
  beforeEach(() => {
    // 清理副作用
    delete process.env.__TEST_LEGACY_TOKEN;
    delete process.env.__TEST_APIKEY;
    delete process.env.__TEST_USER_KEEPER;
  });
  test('从 process.env 整键删除所有敏感键；非敏感键保留', () => {
    process.env.__TEST_LEGACY_TOKEN = 'secret123';
    process.env.__TEST_APIKEY = 'akey-456';
    process.env.__TEST_USER_KEEPER = 'keep-me';
    expect(process.env.__TEST_LEGACY_TOKEN).toBe('secret123');
    const removed = scrubProcessEnv();
    expect(removed).toEqual(expect.arrayContaining([expect.stringMatching(/__TEST_LEGACY_TOKEN/)]));
    expect(removed).toEqual(expect.arrayContaining([expect.stringMatching(/__TEST_APIKEY/)]));
    // 敏感键被删
    expect(process.env.__TEST_LEGACY_TOKEN).toBeUndefined();
    expect(process.env.__TEST_APIKEY).toBeUndefined();
    // 非敏感键保留
    expect(process.env.__TEST_USER_KEEPER).toBe('keep-me');
    delete process.env.__TEST_USER_KEEPER;
  });
  test('可重复调用：第二次进入幂等（无残留）', () => {
    process.env.__TEST_LEGACY_TOKEN2 = 's';
    expect(scrubProcessEnv().some((k) => k === '__TEST_LEGACY_TOKEN2')).toBe(true);
    expect(scrubProcessEnv().length).toBe(0);
  });
  test('真实存在的 LEGACY_TOKEN 也可清', () => {
    process.env.LEGACY_TOKEN = 'X';
    expect(process.env.LEGACY_TOKEN).toBe('X');
    const r = scrubProcessEnv();
    expect(r).toContain('LEGACY_TOKEN');
    expect(process.env.LEGACY_TOKEN).toBeUndefined();
  });
});

describe('feedback/env-guard: filterEnvForChild', () => {
  beforeEach(() => {
    delete process.env.__TEST_TOKEN;
    delete process.env.__TEST_SENSITIVE;
    process.env.PATH = process.env.PATH || '/usr/bin';
  });
  test('白名单：保留 PATH/HOME 等基础键', () => {
    process.env.HOME = '/root';
    const out = filterEnvForChild();
    expect(out.PATH).toBe(process.env.PATH);
    expect(out.HOME).toBe('/root');
  });
  test('显式覆盖：overrides 优先级 > 白名单', () => {
    const out = filterEnvForChild({ PWD: '/custom' });
    expect(out.PWD).toBe('/custom');
  });
  test('override undefined：删除该键', () => {
    process.env.HOME = '/x';
    const out = filterEnvForChild({ HOME: undefined });
    expect(out.HOME).toBeUndefined();
    // 把进程恢复
    process.env.HOME = '/x';
  });
  test('透传 tokenEnv 等敏感键：永不进入子进程（兜底）', () => {
    process.env.__TEST_TOKEN = 'secret';
    process.env.__TEST_SENSITIVE = 'BLAH';
    const out = filterEnvForChild({ __TEST_TOKEN: 'bypass' }); // 即便显式传
    // 兜底逻辑：兜底会把含敏感键名的 key 整体删除
    expect(out.__TEST_TOKEN).toBeUndefined();
    expect(out.__TEST_SENSITIVE).toBeUndefined();
  });
  test('进程含 LEGACY_TOKEN 时子进程 env 完全看不到', () => {
    process.env.LEGACY_TOKEN = 'a-secret';
    const out = filterEnvForChild();
    expect(out.LEGACY_TOKEN).toBeUndefined();
  });
  test('不返回 process.env 引用（隔离）', () => {
    const out = filterEnvForChild();
    expect(out).not.toBe(process.env);
  });
});

describe('feedback/env-guard: assertSecretLeak', () => {
  test('无已知 secrets：不抛', () => {
    expect(() => assertSecretLeak({ a: 1, b: 'hello' }, [])).not.toThrow();
  });
  test('字符串值包含 secret 子串：抛错', () => {
    expect(() =>
      assertSecretLeak({ description: 'inline LEGACY_TOKEN_VAL here' }, ['LEGACY_TOKEN_VAL']),
    ).toThrow(/泄露/);
  });
  test('嵌套对象中含 secret：抛错', () => {
    const data = {
      foo: {
        bar: [{ x: 'authConfig contains TOKEN_ABC456' }],
      },
    };
    expect(() => assertSecretLeak(data, ['TOKEN_ABC456'])).toThrow(/泄露/);
  });
  test('数组 / Number / Boolean / null 不会触发', () => {
    expect(() => assertSecretLeak([1, 2, 3], ['X'])).not.toThrow();
    expect(() => assertSecretLeak(true, ['X'])).not.toThrow();
    expect(() => assertSecretLeak(null, ['X'])).not.toThrow();
  });
  test('敏感键名下的值不再递归（避免假阴性）', () => {
    // description 含 secret 字面值；但 description 不是敏感键名 → 仍命中
    expect(() =>
      assertSecretLeak({ description: 'has SECRET_VAL' }, ['SECRET_VAL']),
    ).toThrow(/泄露/);
  });
  test('循环引用不爆栈（WeakSet）', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => assertSecretLeak(a, ['X'])).not.toThrow();
  });
});

// E7-P1-I3 修复：env 键名掩码
describe('feedback/env-guard: maskSensitiveEnvKey (E7-P1-I3)', () => {
  test('敏感键名掩码：保留前 2 字符 + 长度 + sensitive 标记，不回显完整键名', () => {
    expect(maskSensitiveEnvKey('LEGACY_TOKEN')).toBe('LE****(12,sensitive)');
    expect(maskSensitiveEnvKey('TRAE_JWT_TOKEN_PATH')).toBe('TR****(19,sensitive)');
    expect(maskSensitiveEnvKey('ADMIN_TOKEN')).toBe('AD****(11,sensitive)');
  });
  test('非敏感键名掩码：保留前 2 字符 + 长度 + kept 标记', () => {
    expect(maskSensitiveEnvKey('HOME')).toBe('HO****(4,kept)');
    expect(maskSensitiveEnvKey('NODE_ENV')).toBe('NO****(8,kept)');
  });
  test('掩码结果不含完整键名（防泄露）', () => {
    const masked = maskSensitiveEnvKey('LEGACY_TOKEN');
    expect(masked).not.toContain('LEGACY_TOKEN');
    expect(masked).not.toContain('TOKEN');
  });
  test('短键名（<2 字符）安全处理', () => {
    // 边界：极端短键名不应崩；输出形态 = '<prefix>****(<len>,<kind>)'
    const masked = maskSensitiveEnvKey('T');
    expect(masked).toMatch(/^T\*\*\*\*\(1,(kept|sensitive)\)$/);
  });
});

describe('feedback/env-guard: checkProcEnvironForSecrets (Linux only)', () => {
  test('Linux 下读 /proc/self/environ 找含 TOKEN/SECRET/PASSWORD/APIKEY 的键', () => {
    if (process.platform !== 'linux') {
      // 在非 Linux 平台返回 hasSecrets=false
      const r = checkProcEnvironForSecrets();
      expect(r.hasSecrets).toBe(false);
      return;
    }
    const r = checkProcEnvironForSecrets();
    expect(typeof r.hasSecrets).toBe('boolean');
    expect(Array.isArray(r.matchedKeys)).toBe(true);
    // Linux 下：jest 自身进程的 /proc/self/environ 不一定含 token，所以不强求 matchedKeys 非空
  });
});
