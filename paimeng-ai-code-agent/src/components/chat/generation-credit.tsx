'use client';
import { poolLabels, type BillingChargeView } from '@/shared/billing';

/**
 * 一次助手回复下的 Credit 行：总额 + 分池明细（docs/specs/credit-billing.md「界面上必须出现的三件事」）。
 *
 * 三种不确定状态都不显示成精确数字：`estimated` 标「估算」、`partial`/`unpriced` 显示待处理、
 * `reversed` 显示已退还。分池明细只列原始扣减分录——冲正分录是账本内部事实，不从账单行里露出来。
 */
export function GenerationCredit({ charge }: { charge: BillingChargeView }) {
  const split = charge.entries
    .filter(entry => entry.reversalOf === null && entry.credits > 0)
    .map(entry => `${poolLabels[entry.pool]} ${entry.credits}`)
    .join(' + ');
  const detail = split ? `（${split}）` : '';
  if (charge.status === 'reversed') return <p className="generation-credit" role="status">本次生成已全额退还{detail}</p>;
  if (charge.status === 'unpriced') return <p className="generation-credit" role="status">本次消耗待处理（缺少费率或用量，未扣费）</p>;
  if (charge.status === 'partial') return <p className="generation-credit" role="status">本次消耗 {charge.credits} Credit，另有步骤待处理{detail}</p>;
  if (charge.status === 'estimated') return <p className="generation-credit" role="status">本次消耗约 {charge.credits} Credit（估算）{detail}</p>;
  return <p className="generation-credit" role="status">本次消耗 {charge.credits} Credit{detail}</p>;
}
