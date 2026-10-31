import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { db, getPool, now } from '@/server/infra/db';
import { nextSnowflakeId } from '@/server/infra/snowflake';
import {
  appAuthority, apps, creditAccounts, creditCharges, creditEntries, creditGrants, generationExecutions,
  generationInputs, generationSteps, generationTransitions, generations, sessions, users, versionRecords,
} from '@/server/infra/schema';
import { publicUser } from '@/server/auth/auth';
import { recordGrant } from '@/server/billing/ledger';
import { harnessChatResponse } from '@/server/generation/durable-engine';
import { generationFor } from '@/server/generation/generation-store';
import { testDatabaseUrl } from '../../support/test-database-url';
import { applyBillingMigrations, billingRateProvider, purgeBillingRateCards, seedBillingRate } from '../billing/support';
import { baseUrl, freePort, harnessAvailable, postgresReachable, postgresUrl, startHarness, stopHarness, waitHealthy } from './support';

/**
 * 运行期透支熔断的中止链路（票 95）：真 harness 子进程 + 真 `harnessChatResponse`。
 *
 * 要验证的四件事在这里一次跑通：① `#flushPending` 每个模型步骤之后现算 Owner 的未结算消耗；
 * ② 超线时同时打断本地观察流（`stop.signal`）与 harness 侧的 run（`/abort`）——只停本地信号，
 *    harness 会继续烧 token；③ 中止走正常终态：`stop_reason='overdraft'`、state 不变成 ready（不发布）；
 * ④ 账单按已发生用量照实记录，单次响应越线的部分不会被抹掉。
 *
 * faux 模型上报的用量恒为 0，无法靠它把额度烧穿，所以本用例在模型调用进行中直接往 `generation_step`
 * 写一条「一次响应就烧掉 2000 Credit」的用量行——中止链路、停止原因与账单都是真的，
 * 只有这条用量是注入的。纯计费口径在 tests/integration/billing/overdraft.test.ts 覆盖。
 */

process.env.DATABASE_URL = testDatabaseUrl('postgres://postgres:postgres@127.0.0.1:5432/paimeng_app');
process.env.AI_MODE = 'fixture';

const available = harnessAvailable() && await postgresReachable(postgresUrl);
if (!available) process.stderr.write('[overdraft-abort] 跳过：需要本地 Postgres 与产品 harness\n');

const rateModel = 'model-overdraft-harness';
const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

let userId = 0n;
let appId = 0n;
const createdGenerations: string[] = [];
let runDir = '';

beforeAll(async () => {
  await applyBillingMigrations(
    '008_credit_rate_card.sql', '010_credit_grant_account.sql', '012_credit_charge_entry.sql',
    '014_credit_entry_audit.sql', '018_credit_entry_reason_length.sql',
  );
  userId = await nextSnowflakeId();
  appId = await nextSnowflakeId();
  await db().insert(users).values({
    id: userId, userAccount: `overdraft_${randomUUID()}`, userPassword: 'unused', userRole: 'user',
    createTime: now(), updateTime: now(),
  });
  await db().insert(apps).values({
    id: appId, appName: '透支熔断验收', initPrompt: '透支熔断验收', codeGenType: 'html',
    userId, createTime: now(), updateTime: now(),
  });
  // 准入要求可用额度 > 0；透支线来自购买，这里没有 purchase，所以透支线是 0。
  await recordGrant({ userId: String(userId), pool: 'balance', credits: 500, source: 'admin_grant' });
  await seedBillingRate({ modelName: rateModel });
  runDir = await mkdtemp(join(tmpdir(), 'overdraft-abort-'));
});

afterAll(async () => {
  if (createdGenerations.length) {
    await db().delete(versionRecords).where(inArray(versionRecords.generationId, createdGenerations));
    await db().delete(generationTransitions).where(inArray(generationTransitions.generationId, createdGenerations));
    await db().delete(generationSteps).where(inArray(generationSteps.generationId, createdGenerations));
    await db().delete(creditEntries).where(inArray(creditEntries.chargeId, createdGenerations));
    await db().delete(creditCharges).where(inArray(creditCharges.generationId, createdGenerations));
    await db().delete(generations).where(inArray(generations.id, createdGenerations));
  }
  await db().delete(generationInputs).where(eq(generationInputs.appId, appId));
  await db().delete(generationExecutions).where(eq(generationExecutions.appId, appId));
  await db().delete(appAuthority).where(eq(appAuthority.appId, appId));
  await db().delete(apps).where(eq(apps.id, appId));
  await db().delete(creditGrants).where(eq(creditGrants.userId, userId));
  await db().delete(creditAccounts).where(eq(creditAccounts.userId, userId));
  await db().delete(sessions).where(eq(sessions.userId, userId));
  await db().delete(users).where(eq(users.id, userId));
  await purgeBillingRateCards();
  await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
  await getPool().end().catch(() => undefined);
});

async function waitForGeneration(generationId: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await db().select({ id: generations.id }).from(generations).where(eq(generations.id, generationId));
    if (row) return;
    await delay(50);
  }
  throw new Error('生成行没有在预期时间内创建');
}

async function waitForTerminal(generationId: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = await generationFor(String(appId));
    if (task?.id === generationId && task.status !== 'generating' && task.status !== 'building') return task;
    await delay(100);
  }
  throw new Error('生成没有在预期时间内结束');
}

/** 模型调用进行中注入一条用量：900 秒都不用等，这一步本身就是「一次响应越线」。 */
async function injectOversizedStep(generationId: string): Promise<void> {
  await db().insert(generationSteps).values({
    generationId, kind: 'model', round: 1, stepNumber: 99,
    providerId: billingRateProvider, modelName: rateModel,
    inputTokens: 2_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0,
    status: 'ok', createTime: now(),
  });
}

describe.skipIf(!available)('运行期透支熔断：真实 harness 子进程', () => {
  it('超线时中止生成、停掉 harness、不发布，并按已发生用量出账', async () => {
    const [row] = await db().select().from(users).where(eq(users.id, userId));
    const port = await freePort();
    const base = baseUrl(port);
    process.env.DURABLE_HARNESS_URL = base;
    // 首轮模型调用先等 6 秒：这段时间足够注入用量行，并在下一次步骤边界被 #flushPending 看到。
    const harness = startHarness({ port, runDir, reset: true, waitMs: 6000, finalText: 'OVERDRAFT_DONE' });
    const requestId = randomUUID();
    createdGenerations.push(requestId);
    try {
      await waitHealthy(base, 60_000);
      const response = await harnessChatResponse(
        new Request('http://localhost:3000/api/app/chat/gen/code', { method: 'POST' }),
        { appId: String(appId), requestId, message: { id: `${requestId}-user`, role: 'user', parts: [{ type: 'text', text: '透支熔断验收' }] } },
        publicUser(row),
      );
      expect(response.status).toBe(200);
      const streamed = response.text();
      await waitForGeneration(requestId);
      await injectOversizedStep(requestId);
      await streamed;

      const task = await waitForTerminal(requestId);
      expect(task).toMatchObject({ status: 'failed', stopReason: 'overdraft' });
      expect(task.error).toContain('已超出透支线');

      // 没有被发布：ready 是 publishReady 的唯一产物，状态转移与版本行都不该出现。
      const transitions = await db().select().from(generationTransitions).where(eq(generationTransitions.generationId, requestId));
      expect(transitions.map(item => item.toState)).not.toContain('ready');
      expect(await db().select().from(versionRecords).where(eq(versionRecords.generationId, requestId))).toEqual([]);

      // 账单：注入的 2000 token 档位 1200 Credit + faux 的两步（用量 0、无费率）照实汇总。
      const [charge] = await db().select().from(creditCharges).where(eq(creditCharges.generationId, requestId));
      expect(charge).toBeDefined();
      expect(charge.credits).toBe(1200);
      expect((await db().select().from(creditEntries).where(eq(creditEntries.chargeId, requestId)))
        .reduce((sum, entry) => sum + entry.credits, 0)).toBe(1200);

      // harness 侧真的停了：中断之后不该还有活着的 run。
      const runtime = await fetch(`${base}/runtime?conversationId=${await conversationIdOfApp()}`).then(res => res.json()) as { live: { run?: unknown } };
      expect(runtime.live.run).toBeFalsy();
    } finally {
      await stopHarness(harness);
    }
  }, 180_000);
});

/** 应用的 harness 会话 id：中止之后只能靠它去问 harness「run 还在不在」。 */
async function conversationIdOfApp(): Promise<number> {
  const [row] = await db().select({ conversationId: apps.conversationId }).from(apps)
    .where(and(eq(apps.id, appId)));
  if (!row?.conversationId) throw new Error('应用没有绑定 harness 会话');
  return row.conversationId;
}
