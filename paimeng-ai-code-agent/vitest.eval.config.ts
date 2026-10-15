import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * 手工评估用的配置：不参与 `npm run test`，因为它会调用真实模型并跑真实容器构建。
 * 跑法见 package.json 的 `eval:repair`；产物写到 runtime/eval-repair/<时间戳>/。
 */
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)), 'server-only': fileURLToPath(new URL('./tests/server-only.ts', import.meta.url)) } },
  test: {
    include: ['tests/manual/**/*.eval.ts'],
    fileParallelism: false,
    testTimeout: 15 * 60 * 1000,
    hookTimeout: 5 * 60 * 1000,
    env: { APP_ORIGIN: 'http://localhost:3000', PREVIEW_ORIGIN: 'http://127.0.0.1:3001', CHAT_RATE_LIMIT_TYPE: 'USER', CHAT_RATE_LIMIT_RATE: '1', CHAT_RATE_LIMIT_INTERVAL: '60', CHAT_RATE_LIMIT_MESSAGE: '' },
  },
});
