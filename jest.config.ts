import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/packages'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleNameMapper: {
    '^@mobile-copilot/protocol$': '<rootDir>/packages/protocol/src/index.ts',
    '^@mobile-copilot/adapter-core$': '<rootDir>/packages/adapter-core/src/index.ts',
  },
  collectCoverageFrom: [
    'packages/*/src/**/*.ts',
    '!packages/mobile-app/src/store/**',
    '!packages/mobile-app/src/theme/**',
    '!packages/mobile-app/src/screens/**',
    '!packages/mobile-app/src/components/**',
    '!**/node_modules/**',
    '!**/__tests__/**',
  ],
  coverageThreshold: {
    global: {
      branches: 0,
      functions: 0,
      lines: 0,
      statements: 0,
    },
    // Per-file thresholds for tested modules — raise as coverage grows
    './packages/protocol/src/rpc.ts': {
      branches: 85,
      functions: 100,
      lines: 95,
      statements: 95,
    },
    './packages/adapter-core/src/base-auth.ts': {
      branches: 85,
      functions: 70,
      lines: 90,
      statements: 90,
    },
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: 'tsconfig.test.json',
      diagnostics: false,
    }],
  },
  // Mock vscode API for adapter-vscode tests
  // mobile-app API layer (connection.ts, rpc.ts) is testable under node; screens/components are excluded
  modulePathIgnorePatterns: [],
};

export default config;
