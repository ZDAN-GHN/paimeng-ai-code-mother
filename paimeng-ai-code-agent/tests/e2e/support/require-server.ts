import { appOrigin } from './app-origin';

/**
 * 裸跑 `npx playwright test` 时先确认应用在跑。
 *
 * 没有这一步时，没起服务会得到 N 个用例各自的 ECONNREFUSED / 超时，
 * 看起来像功能坏了；实际只是跑法不对（2026-10-21 一次 12 个用例集体「失败」）。
 * 这里不启动任何服务，只把跑法问题变成一句能照做的话。
 */
export default async function requireServer(): Promise<void> {
  const origin = appOrigin();
  const hint = `先起服务：npm run test:e2e:isolated（它会自己拉隔离的应用/预览/harness，默认 3000）；
或 E2E_APP_PORT=3020 E2E_PREVIEW_PORT=3021 npm run test:e2e:isolated。
只想跑自己开着的 dev server，就确认 APP_ORIGIN 指向它。`;
  let reachable = false;
  try {
    const response = await fetch(`${origin}/api/health`, {
      headers: { origin },
      signal: AbortSignal.timeout(3000),
    });
    reachable = response.ok;
  } catch {
    reachable = false;
  }
  if (!reachable) throw new Error(`E2E 目标应用不可达：${origin}。\n${hint}`);
}
