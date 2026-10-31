import 'server-only';
import { and, eq } from 'drizzle-orm';
import { db } from '@/server/infra/db';
import { BusinessError } from '@/server/infra/http';
import { creditCharges, users } from '@/server/infra/schema';
import { idSchema } from '@/shared/contracts';
import {
  maxGrantCredits, poolLabels, poolOfSource, sourceLabels,
  type AdminUserUsage, type ChargeReversalReceipt, type ChargeStatus, type CreditPool, type GrantSource,
} from '@/shared/billing';
import { accountSnapshot, chargesOf, effectiveCreditsOf, entriesOfCharge, recordGrant, reverseCharge } from './ledger';

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

/**
 * 后台查账（92）：一个用户的额度快照 + 最近账单，成本与估算质量一并返回。
 * 金额一律给有效金额（Σ entries），成本用 `costUsd` 的 null 表达「未知」——
 * 这里不做任何折算，界面也不需要自己算钱。
 */
export async function userUsage(input: { userId: string; limit: number }): Promise<AdminUserUsage> {
  const userId = idSchema.parse(input.userId);
  const [user] = await db().select({ id: users.id }).from(users)
    .where(and(eq(users.id, BigInt(userId)), eq(users.isDelete, 0))).limit(1);
  if (!user) throw new BusinessError(404, 40400, '用户不存在');

  const [account, charges] = await Promise.all([
    accountSnapshot(userId),
    chargesOf({ userId, limit: input.limit, includeCost: true }),
  ]);
  return {
    userId,
    account,
    charges,
    estimatedRatio: ratioOf(charges.filter(charge => charge.estimated).length, charges.length),
    unpricedRatio: ratioOf(charges.filter(charge => charge.unpriced).length, charges.length),
  };
}

/** 按账单条数的比例，保留 4 位小数：界面乘 100 就是百分比，不把估算包装成精确金额。 */
function ratioOf(matched: number, total: number): number {
  return total === 0 ? 0 : Math.round(matched / total * 10_000) / 10_000;
}

/**
 * 管理员整笔冲正（92）：复用 90 的 `reverseCharge`，不另写一套冲正逻辑，因此共享同一份幂等保护。
 * 三种结果必须能区分：
 * - 账单不存在 → 404；
 * - 已经整笔冲正过 → `reversed: false`（重复提交不再退款，界面提示「已冲正」）；
 * - 没有分录可退（`unpriced` / 0 Credit）→ 409 明确说「无需冲正」，不让按钮假装退了钱。
 */
export async function reverseChargeByAdmin(input: {
  chargeId: string;
  reason: string;
  operatorId: string;
}): Promise<ChargeReversalReceipt> {
  const [charge] = await db().select({ generationId: creditCharges.generationId }).from(creditCharges)
    .where(eq(creditCharges.generationId, input.chargeId)).limit(1);
  if (!charge) throw new BusinessError(404, 40400, '账单不存在');

  const result = await reverseCharge(input.chargeId, { reason: input.reason, operatorId: input.operatorId });
  if (!result.reversed && (await entriesOfCharge(input.chargeId)).length === 0) {
    throw new BusinessError(409, 40900, '这笔账单没有可冲正的金额（待处理或 0 Credit），无需冲正');
  }
  const [projection] = await db().select({ status: creditCharges.status }).from(creditCharges)
    .where(eq(creditCharges.generationId, input.chargeId)).limit(1);
  return {
    reversed: result.reversed,
    entries: result.entries,
    status: projection.status as ChargeStatus,
    effectiveCredits: await effectiveCreditsOf(input.chargeId),
  };
}
