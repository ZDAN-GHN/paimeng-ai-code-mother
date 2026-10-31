import { describe, expect, it } from 'vitest';
import { overdraftOf } from '@/server/billing/ledger';
import { exceedsOverdraft } from '@/server/billing/settlement';

/**
 * 运行期熔断的判定规则：`预计总可用 = 双池可用 − 运行中未结算消耗`，`预计总可用 < −Overdraft` 才算超线。
 * 等号不算超线是规格明写的（「低于负的 Overdraft 时触发」），差一个 Credit 就不该掐断生成。
 * 未结算消耗怎么算、费率怎么解析在集成用例里对真库断言，见 tests/integration/billing/overdraft.test.ts。
 */

describe('透支线判定', () => {
  it('没有购买记录时透支线为零，只有欠款才超线', () => {
    const overdraft = overdraftOf(0);
    expect(exceedsOverdraft(0, overdraft)).toBe(false);
    expect(exceedsOverdraft(1, overdraft)).toBe(false);
    expect(exceedsOverdraft(-0.5, overdraft)).toBe(true);
    expect(exceedsOverdraft(-1, overdraft)).toBe(true);
  });

  it('恰好等于负透支线不算超线，再少一个 Credit 才算', () => {
    expect(exceedsOverdraft(-200, 200)).toBe(false);
    expect(exceedsOverdraft(-201, 200)).toBe(true);
    expect(exceedsOverdraft(-500, 500)).toBe(false);
    expect(exceedsOverdraft(-501, 500)).toBe(true);
  });

  it('透支线按近 60 天购买额的 2% 计算并封顶 500，不额外给保底额度', () => {
    // 10000 × 2% = 200
    expect(exceedsOverdraft(-200, overdraftOf(10_000))).toBe(false);
    expect(exceedsOverdraft(-201, overdraftOf(10_000))).toBe(true);
    // 100000 × 2% = 2000 → 封顶 500
    expect(exceedsOverdraft(-500, overdraftOf(100_000))).toBe(false);
    expect(exceedsOverdraft(-501, overdraftOf(100_000))).toBe(true);
  });

  it('余额充足时消耗超过 500 Credit 也不掐断（有余额的长生成不被硬阈值截断）', () => {
    // 余额 3000、已消耗 2000：预计总可用 1000，远高于 −500。
    expect(exceedsOverdraft(3000 - 2000, overdraftOf(100_000))).toBe(false);
    // 同一笔消耗在余额见底时才超线。
    expect(exceedsOverdraft(100 - 2000, overdraftOf(100_000))).toBe(true);
  });

  it('小数透支线按真实数值比较，不预先取整', () => {
    // 购买 12345 → 246.9
    expect(exceedsOverdraft(-246.9, overdraftOf(12_345))).toBe(false);
    expect(exceedsOverdraft(-247, overdraftOf(12_345))).toBe(true);
  });
});
