import { defineConfig } from 'vitest/config';
import { availableParallelism, freemem, loadavg } from 'node:os';
import { fileURLToPath } from 'node:url';

const unitWorkers = Math.max(1, Math.min(
  availableParallelism() - Math.ceil(loadavg()[0]),
  Math.floor(freemem() / 1024 ** 3),
));

export default defineConfig({
  resolve: { alias: {
    '@': fileURLToPath(new URL('./src', import.meta.url)),
    'server-only': fileURLToPath(new URL('./tests/support/server-only.ts', import.meta.url)),
  } },
  test: {
    testTimeout: 30000,
    env: {
      APP_ORIGIN: 'http://localhost:3000', PREVIEW_ORIGIN: 'http://127.0.0.1:3001',
      REDIS_URL: 'redis://127.0.0.1:6379/15',
      CHAT_RATE_LIMIT_TYPE: 'USER', CHAT_RATE_LIMIT_RATE: '1',
      CHAT_RATE_LIMIT_INTERVAL: '60', CHAT_RATE_LIMIT_MESSAGE: '', BUILD_TIMEOUT_MS: '300000',
    },
    // These suites share storage resets and fixed ports; never run projects together.
    projects: [
      { extends: true, test: {
        name: 'unit', sequence: { groupOrder: 0 }, include: ['tests/unit/**/*.test.ts', 'tests/support/**/*.test.ts'],
        setupFiles: ['tests/support/unit-boundaries.ts'],
        fileParallelism: true, maxWorkers: unitWorkers,
      } },
      { extends: true, test: {
        name: 'integration', sequence: { groupOrder: 1 }, include: ['tests/integration/**/*.test.ts'], fileParallelism: false,
        setupFiles: ['tests/support/integration-resources.ts'],
      } },
      { extends: true, test: {
        name: 'system', sequence: { groupOrder: 2 }, include: ['tests/system/**/*.test.ts'], fileParallelism: false,
        setupFiles: ['tests/support/integration-resources.ts'],
      } },
    ],
  },
});
