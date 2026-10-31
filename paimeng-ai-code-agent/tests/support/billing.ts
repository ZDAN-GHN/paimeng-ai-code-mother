import { randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { readFile } from 'node:fs/promises';
import { and, eq, inArray } from 'drizzle-orm';
import { testDatabaseUrl } from './test-database-url';
import { GET, POST } from '@/app/api/[...path]/route';
import { db, getPool, now } from '@/server/infra/db';
import { nextSnowflakeId } from '@/server/infra/snowflake';
import {
  apps, creditAccounts, creditGrants, creditRateCard, generationSteps, generations, users,
} from '@/server/infra/schema';
import { rebuildAccount, recordGrant } from '@/server/billing/ledger';
import type { CreditPool } from '@/shared/billing';
import type { WorkspaceApp } from '@/server/workspace/workspace';

/**
 * 计费集成测试的共享入口：只操作隔离的 `_test` 库，迁移可重复执行。
 * 与 `tests/integration/generation/generation-budget.test.ts` 同一套做法，抽出来避免每个文件复制一份。
 * 它同时被 `tests/integration/billing/` 与 `tests/integration/harness/` 使用，所以按 `tests/AGENTS.md`
 * 的「跨套件 helper 放 `tests/support/`」放在这里。
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

// ---- 账单夹具 ----
//
// 结算与归责用例只需要「一个 App + 若干终态 Generation + 步骤行 + 费率 + 余额」，
// 这些造数助手放在这里复用，避免每个账单测试文件各抄一份。
// 它们只写数据、不做断言；清理由各文件的 afterAll 负责（费率行除外，见 purgeBillingRateCards）。

export const billingRateProvider = 'billing-fixture';
const seededRateProviders = new Set<string>([billingRateProvider]);
let seededApps = 0;

/** 直接插一个 App（不起工作区/执行）：结算用例不需要真实文件系统。 */
export async function seedBillingApp(ownerUserId: string): Promise<WorkspaceApp> {
  const id = await nextSnowflakeId();
  seededApps += 1;
  await db().insert(apps).values({
    id, appName: `账单测试 ${seededApps}`, initPrompt: 'billing', codeGenType: 'html',
    userId: BigInt(ownerUserId), createTime: now(), updateTime: now(),
  });
  return { id: String(id), codeGenType: 'html' };
}

/** 直接插一条终态 generation：核心结算用例不经过生命周期，只关心账本结果。 */
export async function seedBillingGeneration(input: {
  appId: string; userId: string; status?: string; stopReason?: string | null; messageId?: string | null;
}): Promise<string> {
  const id = randomUUID();
  await db().insert(generations).values({
    id, appId: BigInt(input.appId), userId: BigInt(input.userId), status: input.status ?? 'ready',
    stopReason: input.stopReason ?? 'completed', messageId: input.messageId ?? null,
    createTime: now(), updateTime: now(),
  });
  return id;
}

/** 步骤行：默认一个正常的模型步骤；token 传 null 表示上游没给用量。 */
export async function seedBillingStep(generationId: string, input: {
  kind?: string; modelName: string; providerId?: string; upstreamModelId?: string | null;
  input?: number | null; cacheRead?: number | null; cacheWrite?: number | null; output?: number | null;
  reasoning?: number | null; round?: number; stepNumber?: number;
}): Promise<void> {
  await db().insert(generationSteps).values({
    generationId,
    kind: input.kind ?? 'model',
    round: input.round ?? 1,
    stepNumber: input.stepNumber ?? 0,
    providerId: input.providerId ?? billingRateProvider,
    modelName: input.modelName,
    upstreamModelId: input.upstreamModelId ?? null,
    inputTokens: input.input === undefined ? 0 : input.input,
    cacheReadTokens: input.cacheRead === undefined ? 0 : input.cacheRead,
    cacheWriteTokens: input.cacheWrite === undefined ? 0 : input.cacheWrite,
    outputTokens: input.output === undefined ? 0 : input.output,
    reasoningTokens: input.reasoning ?? null,
    status: 'ok',
    createTime: now(),
  });
}

/** 费率版本按 modelName 区分用例，避免相互影响；生效时间固定在 2020，早于任何步骤。 */
export async function seedBillingRate(input: {
  modelName: string; providerId?: string; creditInputMiss?: number; creditInputHit?: number; creditOutput?: number;
  usdInputMiss?: string | null; usdInputHit?: string | null; usdOutput?: string | null;
}): Promise<void> {
  const providerId = input.providerId ?? billingRateProvider;
  seededRateProviders.add(providerId);
  await db().insert(creditRateCard).values({
    providerId,
    modelName: input.modelName,
    effectiveFrom: '2020-01-01 00:00:00.000',
    creditInputMiss: input.creditInputMiss ?? 600,
    creditInputHit: input.creditInputHit ?? 12,
    creditOutput: input.creditOutput ?? 2500,
    usdInputMiss: input.usdInputMiss ?? null,
    usdInputHit: input.usdInputHit ?? null,
    usdOutput: input.usdOutput ?? null,
    costBasis: input.usdInputMiss ? 'peak' : 'unknown',
    createTime: now(),
  });
}

/** 造余额：quota 池走月度配额来源，balance 池走管理员发放。 */
export async function grantBillingCredits(userId: string, pool: CreditPool, credits: number): Promise<void> {
  await recordGrant({
    userId, pool, credits,
    source: pool === 'quota' ? 'monthly_quota' : 'admin_grant',
    period: pool === 'quota' ? '2026-01' : null,
  });
}

export async function billingBalancesOf(userId: string): Promise<{ quota: number; balance: number }> {
  const rows = await db().select().from(creditAccounts).where(eq(creditAccounts.userId, BigInt(userId)));
  return {
    quota: rows.find(row => row.pool === 'quota')?.balance ?? 0,
    balance: rows.find(row => row.pool === 'balance')?.balance ?? 0,
  };
}

/**
 * 退掉注册时发的当期配额（票 91）并按账本重算两池，让用例从「配额池为 0」的已知状态出发。
 * 只有需要配额池恰好见底的分池用例才用：注册即得 500 配额这件事本身由 `quota.test.ts`
 * 与 `grants.test.ts` 覆盖。必须在造数发放之前调用（`rebuildAccount` 只按已有 grant 重算）。
 */
export async function withoutMonthlyQuota(owner: BillingTestUser): Promise<BillingTestUser> {
  await db().delete(creditGrants)
    .where(and(eq(creditGrants.userId, BigInt(owner.id)), eq(creditGrants.source, 'monthly_quota')));
  await rebuildAccount(owner.id);
  return owner;
}

/** 删除本进程插入过的全部费率版本：`_test` 库跨文件共享，费率行会互相影响。 */
export async function purgeBillingRateCards(): Promise<void> {
  const providers = [...seededRateProviders];
  await db().delete(creditRateCard).where(inArray(creditRateCard.providerId, providers));
}
