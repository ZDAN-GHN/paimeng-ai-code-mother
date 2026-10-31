import { loadEnvFile } from 'node:process';
import { readFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { testDatabaseUrl } from '../../support/test-database-url';
import { GET, POST } from '@/app/api/[...path]/route';
import { db, getPool } from '@/server/infra/db';
import { users } from '@/server/infra/schema';

/**
 * 计费集成测试的共享入口：只操作隔离的 `_test` 库，迁移可重复执行。
 * 与 `tests/integration/generation/generation-budget.test.ts` 同一套做法，抽出来避免每个文件复制一份。
 */

const duplicateCodes = new Set(['42P07', '42701', '42710', '42P06']);
const appOrigin = 'http://localhost:3000';

let loaded = false;

/** 在任何数据库访问之前调用：加载 .env、把 DATABASE_URL 指到 _test 库、把模型配置固定成夹具。 */
export function loadBillingDatabase() {
  if (!loaded) {
    loadEnvFile('.env');
    process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');
    process.env.AI_MODE = 'fixture';
    loaded = true;
  }
  return getPool();
}

/** 逐条执行迁移语句；表/列/索引已存在视为成功，让「库比 worktree 新」也能跑。 */
export async function applyBillingMigrations(...names: string[]): Promise<void> {
  const pool = loadBillingDatabase();
  for (const name of names) {
    const text = await readFile(`migrations/${name}`, 'utf8');
    for (const raw of text.split(';')) {
      const statement = raw.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n').trim();
      if (!statement) continue;
      try {
        await pool.query(statement);
      } catch (error) {
        const code = (error as { code?: string }).code ?? '';
        if (!duplicateCodes.has(code)) throw error;
      }
    }
  }
}

export type Envelope<T> = { code: number; data: T; message: string };

/** 直接调用路由处理器，走真实的 guardRequest / 鉴权 / 信封。 */
export async function billingRequest(path: string, data?: unknown, session?: string): Promise<Response> {
  const method = data === undefined ? 'GET' : 'POST';
  const request = new Request(`${appOrigin}/api/${path}`, {
    method,
    headers: {
      origin: appOrigin,
      ...(session ? { cookie: session } : {}),
      ...(data === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  return (method === 'GET' ? GET : POST)(request, { params: Promise.resolve({ path: path.split('?')[0].split('/') }) });
}

export async function envelopeOf<T = unknown>(response: Response): Promise<Envelope<T>> {
  return await response.json() as Envelope<T>;
}

export type BillingTestUser = { id: string; account: string; cookie: string };

/** 通过注册与登录接口造一个真实用户；管理员靠改库升级角色（角色每次请求重读数据库）。 */
export async function createBillingUser(options: { role?: 'user' | 'admin' } = {}): Promise<BillingTestUser> {
  loadBillingDatabase();
  const account = `billing_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const credentials = { userAccount: account, userPassword: 'password123', checkPassword: 'password123' };
  const registered = await envelopeOf<string>(await billingRequest('user/register', credentials));
  if (registered.code !== 0) throw new Error(`注册测试用户失败：${registered.message}`);
  const login = await billingRequest('user/login', credentials);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('测试用户登录未返回会话');
  if (options.role === 'admin') {
    await db().update(users).set({ userRole: 'admin' }).where(eq(users.id, BigInt(registered.data)));
  }
  return { id: registered.data, account, cookie };
}
