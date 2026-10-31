import { loadEnvFile } from 'node:process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { searchWithFallback } from '@/server/generation/tools/web/providers';

// vitest 不加载 .env（与 durable-dev/next 的 loadEnvFile 不同），先补上服务端会读到的配置，
// 再允许外部显式覆盖（container 是宿主机起在 127.0.0.1 的固定端口）。
loadEnvFile(join(process.cwd(), '.env'));

/** 自建 SearXNG 的真实链路冒烟：本机 19555 端口、JSON 输出已启用。跑前需要容器在线。 */
describe('SearXNG 实例可用性（本机 19555）', () => {
  it.skipIf(process.env.SEARXNG_LIVE !== '1')('降级链首个源给出结果并归因 searxng', async () => {
    const out = await searchWithFallback('Next.js 16', { maxResults: 5 });
    expect(out.provider).toBe('searxng');
    expect(out.results.length).toBeGreaterThan(0);
    for (const hit of out.results) expect(hit.url).toMatch(/^https?:\/\//);
  }, 30000);
});
