/**
 * E2E 里唯一读取平台与预览地址的地方。
 *
 * 隔离运行（`npm run test:e2e:isolated`）会通过 APP_ORIGIN / PREVIEW_ORIGIN 把它起的临时服务
 * 交给 spec，所以在 spec 里写死 `http://localhost:3000` 或直接读这几个环境变量都是错的：
 * 2026-10-13 一次「隔离运行换端口」就让 10 个用例集体 ECONNREFUSED，原因就是各 spec 自己发明地址。
 * 静态检查 `npx tsx scripts/check-e2e-patterns.ts` 会拦住这两种写法。
 */

/** 管理端地址：隔离运行时指向临时应用服务，否则与 playwright.config.ts 的默认值一致。 */
export function appOrigin(): string {
  return process.env.APP_ORIGIN ?? 'http://localhost:3000';
}

/** 预览/部署地址：隔离运行时指向临时预览服务。 */
export function previewOrigin(): string {
  return process.env.PREVIEW_ORIGIN ?? 'http://127.0.0.1:3001';
}
