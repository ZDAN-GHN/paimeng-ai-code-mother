import { describe, expect, it } from 'vitest';
import { overdraftOf, purchaseWindowStart } from '@/server/billing/ledger';

/**
 * 账本里两段与数据库无关的规则：透支线公式与近 60 天窗口起点。
 * 其余账本行为（入账、快照、幂等、回滚）只能对真实 Postgres 断言，见 tests/integration/billing/grants.test.ts。
 */

describe('透支线', () => {
  it('没有购买记录时为零', () => {
    expect(overdraftOf(0)).toBe(0);
  });

  it('按近 60 天购买额的 2% 计算', () => {
    expect(overdraftOf(1000)).toBe(20);
    expect(overdraftOf(250)).toBe(5);
  });

  it('保留小数精度，不取整也不加最低保底', () => {
    expect(overdraftOf(1)).toBe(0.02);
    expect(overdraftOf(12345)).toBe(246.9);
  });

  it('封顶 500 Credit，恰好 500 的购买额不截断', () => {
    expect(overdraftOf(25000)).toBe(500);
    expect(overdraftOf(100000)).toBe(500);
  });

  it('负数购买额按零处理，不产生负透支线', () => {
    expect(overdraftOf(-1000)).toBe(0);
  });
});

describe('近 60 天购买窗口', () => {
  it('起点是滚动 60×24 小时之前的 UTC 朴素时间戳', () => {
    expect(purchaseWindowStart(new Date('2026-10-31T12:34:56.789Z'))).toBe('2026-09-01 12:34:56.789');
  });

  it('跨月与跨年按真实日历回退，不受月份长度影响', () => {
    expect(purchaseWindowStart(new Date('2026-03-01T00:00:00.000Z'))).toBe('2025-12-31 00:00:00.000');
  });
});
