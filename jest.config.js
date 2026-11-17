// Unit tests for the NestJS server. Co-located as src/ ... .spec.ts.
// Fast and DB-free: pure business-rule modules and services with mocked
// repositories. DB-backed suites live under test/ ... .e2e-spec.ts (test:e2e).
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  setupFiles: ['reflect-metadata'],
  // Mirror the tsconfig `@/*` -> `src/*` path alias for imports pulled in by
  // the unit under test (rootDir is already `src`).
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/$1' },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.json', isolatedModules: true }],
  },
  collectCoverageFrom: ['**/*.ts', '!**/*.spec.ts', '!**/*.d.ts', '!main.ts'],
  coverageDirectory: '../coverage',
  testEnvironment: 'node',
  // The gate must not fail a package that has no tests yet.
  passWithNoTests: true,
};
