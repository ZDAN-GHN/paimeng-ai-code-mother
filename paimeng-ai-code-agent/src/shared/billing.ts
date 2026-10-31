import { z } from 'zod';
import { idSchema } from './contracts';

/**
 * 计费共享契约（docs/specs/credit-billing.md）：client 与 server 都要用的 DTO、zod schema 与展示标签。
 * 只追加、不重排——87（Rate card）、89（Charge）、92（Admin 用量）各自往这里加自己的段落。
 * 这里不许 import `server-only` 或 drizzle：它同时被浏览器打包。
 */

// ---- Credit pool 与 Credit grant（migrations/010_credit_grant_account.sql）----

/** Credit pool：配额池按周期发放并重置，余额池由购买或发放而来且不重置；扣减总是先配额池、后余额池。 */
export const creditPools = ['quota', 'balance'] as const;
export type CreditPool = typeof creditPools[number];
export const creditPoolSchema = z.enum(creditPools);

/** Credit grant 的来源：只有 purchase 计入 Overdraft 基数。 */
export const grantSources = ['purchase', 'admin_grant', 'monthly_quota'] as const;
export type GrantSource = typeof grantSources[number];
export const grantSourceSchema = z.enum(grantSources);

export const poolLabels: Record<CreditPool, string> = { quota: '配额池', balance: '余额池' };
export const sourceLabels: Record<GrantSource, string> = { purchase: '购买', admin_grant: '管理员补偿', monthly_quota: '月度配额' };

/** 单笔手工发放上限：挡住表单里多打一个零变成巨额入账。 */
export const maxGrantCredits = 1_000_000;

/** 来源决定池；`credit_grant_pool_of_source` 这个数据库 CHECK 是同一规则的另一处表达。 */
export function poolOfSource(source: GrantSource): CreditPool {
  return source === 'monthly_quota' ? 'quota' : 'balance';
}

/** `POST admin/billing/grant` 的请求体。requestId 是幂等键：同一次提交的重试复用它，成功后才换新的。 */
export const grantRequestSchema = z.object({
  userId: idSchema,
  pool: creditPoolSchema,
  credits: z.number().refine(
    value => Number.isInteger(value) && value >= 1 && value <= maxGrantCredits,
    `发放金额必须是 1 到 ${maxGrantCredits} 之间的整数 Credit`,
  ),
  source: grantSourceSchema,
  note: z.string().trim().max(500).optional(),
  requestId: z.string().trim().min(1).max(128).optional(),
});
export type GrantRequest = z.infer<typeof grantRequestSchema>;

/** 发放接口的回执：`created=false` 表示这次是重放，账本没有新增行。 */
export type GrantReceipt = { grantId: string; credits: number; created: boolean };

/** 一笔 Credit grant 的可追溯形状，管理界面的发放回执用它展示。 */
export type CreditGrantView = {
  id: string;
  userId: string;
  pool: CreditPool;
  credits: number;
  source: GrantSource;
  note: string | null;
  requestId: string | null;
  grantedBy: string | null;
  period: string | null;
  createTime: string;
};

/** `GET billing/summary`：Owner 自己的双池余额、近 60 天购买额与由此推导的透支线。 */
export type AccountSnapshot = {
  quota: number;
  balance: number;
  total: number;
  purchasedCredits60d: number;
  overdraft: number;
};
