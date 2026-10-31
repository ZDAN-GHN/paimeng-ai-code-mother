import { getPool } from '../../src/server/infra/db';
import { rebuildAccount } from '../../src/server/billing/ledger';
import { auditAccount, pendingSettlements, reconcileSettlements } from '../../src/server/billing/settlement';

/**
 * 补结算与余额核对的运维入口（issue #93）。默认 dry-run，`--apply` 才写库。
 * 业务逻辑全在 `src/server/billing/settlement.ts`，这里只做参数解析、目标库校验与输出。
 *
 *   npm run billing:reconcile                        # 列出终态缺账 / 待补价的账单
 *   npm run billing:reconcile -- --apply             # 执行补结算（可加 --limit=200）
 *   npm run billing:reconcile -- --user <id>         # 核对某个用户的两池余额
 *   npm run billing:reconcile -- --user <id> --apply # 按账本事实重写该用户的余额快照
 *
 * 运行说明见 `docs/billing-operations.md`。
 */

const url = new URL(process.env.DATABASE_URL ?? '');
if (!/^paimeng_app(?:_test)?$/.test(url.pathname.slice(1))) throw new Error('仅允许对独立的 paimeng_app 库执行补结算');

const args = process.argv.slice(2);
const apply = args.includes('--apply');

function optionOf(flag: string): string | undefined {
  const inline = args.find(arg => arg.startsWith(`${flag}=`));
  if (inline !== undefined) return inline.slice(flag.length + 1);
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} 需要一个值`);
  return value;
}

const userId = optionOf('--user');
const limitOption = optionOf('--limit');
const limit = limitOption === undefined ? undefined : Number(limitOption);
if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error('--limit 需要正整数');
if (userId !== undefined && !/^\d+$/u.test(userId)) throw new Error('--user 需要数字用户 ID');

try {
  if (userId !== undefined) {
    const audit = await auditAccount(userId);
    console.log(`用户 ${userId} 的余额核对`);
    console.log(`  期望（grant − entry）：配额 ${audit.expected.quota}，余额 ${audit.expected.balance}`);
    console.log(`  快照（credit_account）：配额 ${audit.actual.quota}，余额 ${audit.actual.balance}`);
    console.log(`  差异（快照 − 期望）：配额 ${audit.diff.quota}，余额 ${audit.diff.balance}`);
    const drifted = audit.diff.quota !== 0 || audit.diff.balance !== 0;
    if (!drifted) console.log('  快照与账本事实一致。');
    else if (!apply) console.log('  快照有差异；加 --apply 会按账本事实重写快照（不动 grant / entry）。');
    else {
      const repaired = await rebuildAccount(userId);
      console.log(`  已按账本事实重写快照：配额 ${repaired.quota}，余额 ${repaired.balance}`);
    }
  } else if (!apply) {
    const items = await pendingSettlements({ limit });
    console.log(`待补结算 ${items.length} 条（dry-run，加 --apply 才写库）`);
    for (const item of items) {
      const charge = item.chargeStatus === null ? '缺账' : `账单 ${item.chargeStatus} / ${item.credits ?? 0} Credit`;
      console.log(`- ${item.generationId}（${charge}）：${item.reason}`);
    }
  } else {
    const run = await reconcileSettlements({ limit });
    const other = run.results.length - run.settled - run.skipped;
    console.log(`扫描 ${run.scanned} 条：新结算 ${run.settled}，仍待处理 ${run.skipped}，补记或失败 ${other}`);
    for (const item of run.results) {
      console.log(`- ${item.generationId}  ${item.outcome}${item.reason ? `：${item.reason}` : ''}`);
    }
  }
} catch (error) {
  console.error(`补结算失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await getPool().end();
}
