'use client';
import { isPlatformFault, poolLabels, type BillingChargeView } from '@/shared/billing';
import { stopReasonLabels } from './generation-usage';

/**
 * 一次生成结束后的 Credit 行（docs/specs/credit-billing.md「界面上必须出现的三件事」）：
 * 为什么结束（失败 / 用户取消 / 平台故障中止 / 等待回答）、实际收了多少、从哪个池扣的、退到了哪个池。
 *
 * 金额只用有效金额（Σ entries）：冲正之后 charge 投影已经被重算成净额，把「原扣」与「退款」再相加
 * 会显示成两笔钱或负支出。退款去向只读 `reversals` 的分池金额，不自己推算。
 * 不确定的状态不显示成精确数字：`estimated` 标「估算」，`partial` / `unpriced` 显示待结算。
 */
export function GenerationCredit({ charge }: { charge: BillingChargeView }) {
  const chargedSplit = charge.entries
    .filter(entry => entry.credits > 0)
    .map(entry => `${poolLabels[entry.pool]} ${entry.credits}`)
    .join(' + ');
  const refundSplit = charge.reversals
    .filter(entry => entry.credits < 0)
    .map(entry => `${poolLabels[entry.pool]} ${-entry.credits}`)
    .join(' + ');
  const chargedDetail = chargedSplit ? `（${chargedSplit}）` : '';
  const refundDetail = refundSplit ? `（${refundSplit}）` : '';
  const refunded = charge.reversals.reduce((sum, entry) => sum - entry.credits, 0);
  const used = charge.effectiveCredits;
  const estimateNote = charge.estimatedSteps > 0 ? '（含估算步骤）' : '';
  const reason = charge.stopReason ? stopReasonLabels[charge.stopReason] : null;
  const line = (text: string) => <p className="generation-credit" role="status">{text}</p>;

  // 平台故障的冲正与结算在同一事务里完成，所以「判成平台故障」与「已退款」是一回事；
  // 唯一没有分录可冲的情况是这次生成根本没调用模型。
  if (isPlatformFault(charge.stopReason)) {
    return refunded > 0
      ? line(`本次生成因平台故障中止，已全额退还 ${refunded} Credit${refundDetail}`)
      : line('本次生成因平台故障中止，未产生费用');
  }
  if (charge.status === 'reversed') return line(`本次生成已全额退还 ${refunded} Credit${refundDetail}`);
  if (charge.status === 'unpriced') return line('本次消耗待结算：缺少费率或用量，暂未扣费');
  if (charge.status === 'partial') return line(`本次消耗 ${used} Credit，另有步骤待结算${chargedDetail}`);
  if (charge.stopReason === 'question') {
    return line(`本轮暂停等待回答，已按实际用量收费 ${used} Credit${chargedDetail}${estimateNote}`);
  }
  if (charge.generationStatus === 'cancelled') {
    return line(`用户取消，已按实际用量收费 ${used} Credit${chargedDetail}${estimateNote}`);
  }
  if (charge.generationStatus === 'failed') {
    return line(`生成失败${reason ? `（${reason}）` : ''}，已按实际用量收费 ${used} Credit${chargedDetail}${estimateNote}`);
  }
  if (charge.status === 'estimated') return line(`本次消耗约 ${used} Credit（估算）${chargedDetail}`);
  return line(`本次消耗 ${used} Credit${chargedDetail}`);
}
