/**
 * 北京时间的账期算术。配额按北京自然月发放与失效（规则与触发点见 `docs/billing-operations.md`「月度配额」），
 * 这里只放纯函数：所有「现在」都由调用方以 `Date` 传入，测试才能控时。
 *
 * 时区固定 UTC+8，没有夏令时；账期字符串是 `YYYY-MM`。
 */

const beijingOffsetMs = 8 * 60 * 60 * 1000;
const periodPattern = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** 某一时刻所属的北京自然月。 */
export function periodOf(instant: Date): string {
  return new Date(instant.getTime() + beijingOffsetMs).toISOString().slice(0, 7);
}

/** 账期的半开区间 [start, end)，两端都是 UTC 时刻：北京时间该月 1 号 00:00。 */
export function periodRange(period: string): { start: Date; end: Date } {
  const match = periodPattern.exec(period);
  if (!match) throw new Error(`账期格式必须是 YYYY-MM：${period}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const start = new Date(Date.UTC(year, month - 1, 1) - beijingOffsetMs);
  const end = new Date(Date.UTC(year, month, 1) - beijingOffsetMs);
  return { start, end };
}

/** 下一个北京 1 号 00:00 的 UTC 时刻，也就是当前账期的结束时刻。 */
export function nextPeriodStart(instant: Date): Date {
  return periodRange(periodOf(instant)).end;
}

export function isCurrentPeriod(period: string, at: Date): boolean {
  return periodOf(at) === period;
}

/** 库里时间列是 UTC 朴素时间戳（`YYYY-MM-DD HH:MM:SS.mmm`），换算成 Date 时按 UTC 解析。 */
export function parseNaiveTime(value: string): Date {
  return new Date(`${value.replace(' ', 'T')}Z`);
}

/** Date → UTC 朴素时间戳，与 `infra/db` 的 `now()` 同格式，可直接写库。 */
export function naiveTime(value: Date): string {
  return value.toISOString().slice(0, 23).replace('T', ' ');
}
