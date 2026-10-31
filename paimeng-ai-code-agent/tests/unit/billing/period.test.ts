import { describe, expect, it } from 'vitest';
import { isCurrentPeriod, naiveTime, nextPeriodStart, parseNaiveTime, periodOf, periodRange } from '@/server/billing/period';

const utc = (text: string) => new Date(`${text}Z`);

describe('北京时间账期', () => {
  it('账期边界在北京时间的 1 号 00:00，不在 UTC 的 1 号 00:00', () => {
    expect(periodOf(utc('2026-01-31T15:59:59.999'))).toBe('2026-01');
    expect(periodOf(utc('2026-01-31T16:00:00.000'))).toBe('2026-02');
    expect(periodOf(utc('2026-02-28T15:59:59.999'))).toBe('2026-02');
    expect(periodOf(utc('2026-02-28T16:00:00.000'))).toBe('2026-03');
  });

  it('跨年时账期与区间都跟着进位', () => {
    expect(periodOf(utc('2026-12-31T15:59:59.999'))).toBe('2026-12');
    expect(periodOf(utc('2026-12-31T16:00:00.000'))).toBe('2027-01');
    expect(periodRange('2026-12').end.toISOString()).toBe('2026-12-31T16:00:00.000Z');
    expect(periodRange('2027-01').start.toISOString()).toBe('2026-12-31T16:00:00.000Z');
  });

  it('区间是半开的：包含起点，不含终点', () => {
    const { start, end } = periodRange('2026-03');
    expect(start.toISOString()).toBe('2026-02-28T16:00:00.000Z');
    expect(end.toISOString()).toBe('2026-03-31T16:00:00.000Z');
    expect(periodOf(start)).toBe('2026-03');
    expect(periodOf(end)).toBe('2026-04');
  });

  it('月末时刻的下一个账期起点就是本账期终点', () => {
    expect(nextPeriodStart(utc('2026-01-15T00:00:00.000')).toISOString()).toBe('2026-01-31T16:00:00.000Z');
    expect(nextPeriodStart(utc('2026-12-15T00:00:00.000')).toISOString()).toBe('2026-12-31T16:00:00.000Z');
  });

  it('isCurrentPeriod 用同一套账期口径', () => {
    expect(isCurrentPeriod('2026-02', utc('2026-01-31T16:00:00.000'))).toBe(true);
    expect(isCurrentPeriod('2026-02', utc('2026-01-31T15:59:59.999'))).toBe(false);
  });

  it('非法账期直接报错，不静默当成当前账期', () => {
    expect(() => periodRange('2026-13')).toThrow(/账期格式/);
    expect(() => periodRange('2026-1')).toThrow(/账期格式/);
  });

  it('库里时间按 UTC 解析，和服务端 now() 同格式往返', () => {
    const instant = utc('2026-03-01T08:30:00.123');
    expect(parseNaiveTime(naiveTime(instant)).toISOString()).toBe(instant.toISOString());
    expect(naiveTime(instant)).toBe('2026-03-01 08:30:00.123');
  });
});
