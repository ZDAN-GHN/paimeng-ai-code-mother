import { getPool } from '../../src/server/infra/db';
import { issueMonthlyQuota } from '../../src/server/billing/quota';

/**
 * 月度配额补发入口：默认试运行，`--apply` 才写库。
 *
 * 常规路径是懒触发的——注册时与读取额度摘要（`GET billing/summary`）时自动补当期配额；
 * 这个入口只在停机跨月之后一次性补齐全库，或由外部 cron 定时调用。
 * 幂等键是 (user_id, period)，所以反复跑不会多发。
 */
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const limitArg = args.find(arg => arg.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.slice('--limit='.length)) : undefined;
if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error('--limit 必须是正整数');

const url = new URL(process.env.DATABASE_URL ?? '');
if (!/^paimeng_app(?:_test)?$/.test(url.pathname.slice(1))) throw new Error('仅允许对独立的 paimeng_app 库发放配额');

const run = await issueMonthlyQuota({ dryRun: !apply, limit });
console.log(`${apply ? '已发放' : '试运行（加 --apply 才写库）'}：账期 ${run.period}，待发放用户 ${run.scanned}，实际发放 ${run.granted}`);
await getPool().end();
