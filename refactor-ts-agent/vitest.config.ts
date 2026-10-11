import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({resolve:{alias:{'@':fileURLToPath(new URL('./src',import.meta.url)), 'server-only':fileURLToPath(new URL('./tests/server-only.ts',import.meta.url))}},test:{include:['tests/**/*.test.ts'],fileParallelism:false,testTimeout:30000,env:{APP_ORIGIN:'http://localhost:3000',PREVIEW_ORIGIN:'http://127.0.0.1:3001',CHAT_RATE_LIMIT_TYPE:'USER',CHAT_RATE_LIMIT_RATE:'1',CHAT_RATE_LIMIT_INTERVAL:'60',CHAT_RATE_LIMIT_MESSAGE:''}}});
