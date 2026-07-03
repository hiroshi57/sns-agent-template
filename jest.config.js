/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: {
        // テスト用の緩和設定
        strict: false,
        esModuleInterop: true,
      },
    }],
  },
  moduleNameMapper: {
    // dotenv の副作用を無効化
    '^dotenv/config$': '<rootDir>/tests/__mocks__/dotenv-config.js',
  },
  collectCoverageFrom: [
    'src/utils/holiday.ts',
    'src/pipeline/runner.ts',
    'src/utils/rss-health-tracker.ts',
    'src/utils/posted-url-cache.ts',
    'src/utils/trend-hashtags.ts',
  ],
  coverageReporters: ['text', 'lcov'],
};
