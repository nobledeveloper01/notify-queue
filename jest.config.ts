import type { Config } from 'jest';

// Native ESM: Nest 12 ships ES modules only, so tests run through ts-jest's
// ESM mode (npm scripts set NODE_OPTIONS=--experimental-vm-modules).
const config: Config = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testRegex: String.raw`.*\.(spec|e2e-spec|integration-spec)\.ts$`,
  extensionsToTreatAsEsm: ['.ts'],
  // Source imports use explicit `.js` extensions (NodeNext); map them back to `.ts`.
  moduleNameMapper: {
    [String.raw`^(\.{1,2}/.*)\.js$`]: '$1',
  },
  transform: {
    [String.raw`^.+\.ts$`]: ['ts-jest', { useESM: true, tsconfig: 'tsconfig.json' }],
  },
  // Integration and concurrency suites share one test database and truncate
  // it; running files serially keeps them from wiping each other's rows.
  // Concurrency *within* a test is real: each simulated worker has its own pool.
  maxWorkers: 1,
  testTimeout: 30_000,
  clearMocks: true,
  restoreMocks: true,
};

export default config;
