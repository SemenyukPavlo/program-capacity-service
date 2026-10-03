// Testcontainers (undici 7) needs Node 22+; fail with a clear hint instead of an obscure undici stack trace.
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 22) {
  throw new Error(
    `Node ${process.versions.node} detected; this project requires Node 22+. Run \`nvm use\` (see .nvmrc).`,
  );
}

/** @type {import('jest').Config} */
const tsJest = ['ts-jest', { tsconfig: 'tsconfig.json' }];

module.exports = {
  projects: [
    {
      displayName: 'unit',
      testMatch: ['<rootDir>/test/unit/**/*.spec.ts'],
      transform: { '^.+\\.ts$': tsJest },
      testEnvironment: 'node',
    },
    {
      displayName: 'integration',
      testMatch: ['<rootDir>/test/integration/**/*.spec.ts'],
      transform: { '^.+\\.ts$': tsJest },
      testEnvironment: 'node',
      globalSetup: '<rootDir>/test/integration/global-setup.ts',
      globalTeardown: '<rootDir>/test/integration/global-teardown.ts',
      setupFiles: ['reflect-metadata'],
      slowTestThreshold: 30,
    },
  ],
};
