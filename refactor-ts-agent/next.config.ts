import type { NextConfig } from 'next';
const config: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
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
  serverExternalPackages: ['mysql2', 'archiver', 'playwright'],
  experimental: { cpus: 2 },
};
export default config;
