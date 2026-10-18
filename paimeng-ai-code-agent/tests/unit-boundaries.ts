import { vi } from 'vitest';

const outsideUnit = (resource: string): never => {
  throw new Error(`unit 测试不能启动 ${resource}：数据库/子进程用 tests/integration，Docker/浏览器用 tests/system；运行 npm run test:all。`);
};

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: () => outsideUnit('子进程'),
  spawnSync: () => outsideUnit('子进程'),
  exec: () => outsideUnit('子进程'),
  execSync: () => outsideUnit('子进程'),
  execFile: () => outsideUnit('子进程'),
  execFileSync: () => outsideUnit('子进程'),
}));

vi.mock('playwright', () => ({
  chromium: { launch: () => outsideUnit('Chromium') },
  firefox: { launch: () => outsideUnit('Firefox') },
  webkit: { launch: () => outsideUnit('WebKit') },
}));

vi.mock('@/server/db', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/server/db')>(),
  db: () => outsideUnit('Postgres'),
  getPool: () => outsideUnit('Postgres'),
}));

vi.mock('redis', async (importOriginal) => ({
  ...await importOriginal<typeof import('redis')>(),
  createClient: () => outsideUnit('Redis'),
}));
