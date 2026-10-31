import 'server-only';
import { and, eq } from 'drizzle-orm';
import { db } from '@/server/infra/db';
import { BusinessError } from '@/server/infra/http';
import { users } from '@/server/infra/schema';
import { idSchema } from '@/shared/contracts';
import { maxGrantCredits, poolLabels, poolOfSource, sourceLabels, type CreditPool, type GrantSource } from '@/shared/billing';
import { recordGrant } from './ledger';

export type GrantCreditsInput = {
  userId: string;
  pool: CreditPool;
  credits: number;
  source: GrantSource;
  note?: string | null;
  requestId?: string | null;
  grantedBy: string;
};

/**
 * 管理员发放 Credit 的用例入口：先校验「发给谁、从哪来、进哪个池」，再交给账本入账。
 * 支付回调将来复用同一入口（source=purchase + externalRef），所以业务规则必须留在这里，不能只在 HTTP 层。
 */
export async function grantCredits(input: GrantCreditsInput): Promise<{ grantId: string; credits: number; created: boolean }> {
  const userId = idSchema.parse(input.userId);
  const [user] = await db().select({ id: users.id }).from(users)
    .where(and(eq(users.id, BigInt(userId)), eq(users.isDelete, 0))).limit(1);
  if (!user) throw new BusinessError(404, 40400, '用户不存在');
  if (input.source === 'monthly_quota') throw new BusinessError(400, 40000, '月度配额按账期自动发放，不能手工发放');
  const pool = poolOfSource(input.source);
  if (input.pool !== pool) throw new BusinessError(400, 40000, `${sourceLabels[input.source]}只能进入${poolLabels[pool]}`);
  if (!Number.isInteger(input.credits) || input.credits < 1 || input.credits > maxGrantCredits) {
    throw new BusinessError(400, 40000, `发放金额必须是 1 到 ${maxGrantCredits} 之间的整数 Credit`);
  }

  const { grant, created } = await recordGrant({
    userId,
    pool,
    credits: input.credits,
    source: input.source,
    note: input.note ?? null,
    requestId: input.requestId ?? null,
    grantedBy: input.grantedBy,
  });
  return { grantId: grant.id, credits: grant.credits, created };
}
