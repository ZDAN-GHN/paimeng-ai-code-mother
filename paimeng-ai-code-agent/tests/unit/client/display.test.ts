import { describe, expect, it } from 'vitest';
import { formatBeijingTime, formatCodeGenType, formatStoredTime, parseStoredTime } from '@/shared/display';

/** 库里存的是 UTC 朴素时间：解析必须按 UTC，展示必须转本地。断言用 toLocaleString 独立复算，不引用被测函数自身。 */
const local = (date: Date) => date.toLocaleString('sv-SE', { hour12: false });

describe('存储时间的解析与展示', () => {
  it('空串按 UTC 解释，毫秒部分被忽略', () => {
    expect(parseStoredTime('2026-10-21 03:09:12')?.toISOString()).toBe('2026-10-21T03:09:12.000Z');
    expect(parseStoredTime('2026-10-21 03:09')?.toISOString()).toBe('2026-10-21T03:09:00.000Z');
    expect(parseStoredTime('2026-10-21T03:09:12.345')?.toISOString()).toBe('2026-10-21T03:09:12.000Z');
    expect(parseStoredTime(null)).toBeNull();
    expect(parseStoredTime('not a time')).toBeNull();
  });

  it('展示等于「按 UTC 构造后按本地格式化」的独立实现', () => {
    for (const stored of ['2026-10-21 03:09:12', '2026-01-01 00:00:00', '2026-12-31 23:59:59']) {
      const date = parseStoredTime(stored);
      expect(date).not.toBeNull();
      expect(formatStoredTime(stored)).toBe(local(date!));
    }
  });

  it('空值与无法解析的值回退到 fallback', () => {
    expect(formatStoredTime(null, '空')).toBe('空');
    expect(formatStoredTime('not a time', '空')).toBe('空');
    expect(formatStoredTime(undefined)).toBe('');
  });

  it('未注册的生成类型回退到原始值', () => {
    expect(formatCodeGenType('html')).toBe('原生 HTML 模式');
    expect(formatCodeGenType('unknown_mode')).toBe('unknown_mode');
    expect(formatCodeGenType(null)).toBe('未知类型');
  });
});

/** 配额有效期是北京时间的自然月边界，必须按固定 +8 显示，不能跟着浏览器时区漂。 */
describe('北京时间的展示', () => {
  it('固定 +8：UTC 的月末 16:00 就是北京时间次月 1 号 00:00', () => {
    expect(formatBeijingTime('2026-01-31 16:00:00.000')).toBe('2026-02-01 00:00');
    expect(formatBeijingTime('2026-01-31 15:59:00.000')).toBe('2026-01-31 23:59');
    expect(formatBeijingTime('2026-12-31 16:00:00.000')).toBe('2027-01-01 00:00');
  });

  it('空值与无法解析的值回退到 fallback', () => {
    expect(formatBeijingTime(null, '空')).toBe('空');
    expect(formatBeijingTime('not a time', '空')).toBe('空');
    expect(formatBeijingTime(undefined)).toBe('');
  });
});
