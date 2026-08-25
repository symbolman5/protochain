export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    // jsdom 依赖树含 ESM-only 包 @exodus/bytes（html-encoding-sniffer 引用）；
    // jest CJS 运行时无法转换 node_modules ESM → 映射到语义对齐的 CJS 垫片。
    '^@exodus/bytes(?:/(?:encoding-lite|encoding))?\\.js$': '<rootDir>/tests/stubs/exodus-bytes.cjs',
    '^@exodus/bytes$': '<rootDir>/tests/stubs/exodus-bytes.cjs'
  },
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/cli/index.ts'
  ],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { useESM: true }]
  }
};
