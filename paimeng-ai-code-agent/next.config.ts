import type { NextConfig } from 'next';
const config: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  // 隔离的 dev 检查（npm run test:e2e:dev）要在你已占着 3000 的同一个工程目录里再起一个 dev server；
  // Next 16 用 <distDir>/dev/lock 做单例锁，换一个 distDir 就能并行。默认行为不变。
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  redirects() {
    const platform = new URL(process.env.APP_ORIGIN ?? 'http://localhost:3000');
    if (platform.hostname !== 'localhost') return [];
    return [{
      source: '/:path((?!api(?:/|$)|_next(?:/|$)).*)',
      has: [{ type: 'host', value: '127\\.0\\.0\\.1' }],
      destination: `${platform.origin}/:path`,
      permanent: false,
    }];
  },
  outputFileTracingRoot: process.cwd(),
  outputFileTracingIncludes: { '/*': ['./templates/**/*'] },
  outputFileTracingExcludes: {
    '/*': ['./runtime/**/*', './.env', './.env.*'],
    'next-server': ['runtime/**/*', '.env', '.env.*'],
  },
  turbopack: { root: process.cwd() },
  serverExternalPackages: ['archiver', 'playwright'],
  experimental: { cpus: 2 },
};
export default config;
