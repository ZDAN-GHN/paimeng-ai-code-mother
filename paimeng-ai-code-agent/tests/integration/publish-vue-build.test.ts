import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEnvFile } from 'node:process';
import { testDatabaseUrl } from '../test-database-url';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { rm } from 'node:fs/promises';
import { db, getPool, now } from '@/server/db';
import { nextSnowflakeId } from '@/server/snowflake';
import { users, apps, histories, messages, leases, generations } from '@/server/schema';
import { publicUser } from '@/server/auth';
import { workspace, writeProjectFile } from '@/server/workspace';
import { publish } from '@/server/business';
import { buildApp, deployApp } from '@/server/artifacts';
import { BUILD_DEPENDENCIES } from '@/server/build-contract';
import type { User } from '@/shared/contracts';

vi.mock('@/server/artifacts', () => ({
  buildApp: vi.fn(async () => {}),
  hasPreview: vi.fn(async () => true),
  previewUrl: vi.fn((app: { id: string; codeGenType: string }) => `http://127.0.0.1:3001/preview/${app.codeGenType}_${app.id}/`),
  deployedUrl: vi.fn((key: string) => `http://127.0.0.1:3001/deploy/${key}/`),
  deployApp: vi.fn(async () => 'ABCDEF'),
  captureCover: vi.fn(async (key: string) => `http://127.0.0.1:3001/covers/${key}.png`),
  downloadApp: vi.fn(),
  loadBuildState: async () => null,
}));

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');
process.env.AI_MODE = 'fixture';

let actor: User;
let appId: string;
const app = () => ({ id: appId, codeGenType: 'vue_project' as const });

describe('Vue 发布始终从源码构建（F03）', () => {
  beforeAll(async () => {
    const id = await nextSnowflakeId();
    await db().insert(users).values({ id, userAccount: 'ts_publish_vue_' + randomUUID(), userPassword: 'unused', userRole: 'user', createTime: now(), updateTime: now() });
    const [row] = await db().select().from(users).where(eq(users.id, id));
    actor = publicUser(row);
  });
  beforeEach(async () => {
    const id = await nextSnowflakeId();
    await db().insert(apps).values({ id, initPrompt: 'Vue 发布构建', codeGenType: 'vue_project', userId: BigInt(actor.id), createTime: now(), updateTime: now() });
    appId = id.toString();
    await writeProjectFile(app(), 'package.json', JSON.stringify({ name: 'vue-app', dependencies: { vue: BUILD_DEPENDENCIES.vue, vite: BUILD_DEPENDENCIES.vite, '@vitejs/plugin-vue': BUILD_DEPENDENCIES['@vitejs/plugin-vue'] } }));
    vi.mocked(buildApp).mockClear(); vi.mocked(deployApp).mockClear();
  });
  afterEach(async () => {
    for (const table of [leases, generations, messages, histories]) await db().delete(table).where(eq(table.appId, BigInt(appId)));
    await db().delete(apps).where(eq(apps.id, BigInt(appId)));
    await rm(workspace(app()), { recursive: true, force: true });
  });
  afterAll(async () => { await db().delete(users).where(eq(users.id, BigInt(actor.id))); await getPool().end(); });

  it('即使已存在可预览产物，发布也会重新从源码构建', async () => {
    const url = await publish({ appId }, actor);
    expect(buildApp).toHaveBeenCalledTimes(1);
    expect(deployApp).toHaveBeenCalledTimes(1);
    expect(url).toContain('/deploy/ABCDEF/');
  });
});
