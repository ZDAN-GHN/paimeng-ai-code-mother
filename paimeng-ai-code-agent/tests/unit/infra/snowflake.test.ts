import { describe, expect, it } from 'vitest';
import { snowflakeCandidate, SNOWFLAKE_EPOCH } from '@/server/infra/snowflake';

const time = (elapsed: bigint) => SNOWFLAKE_EPOCH + elapsed;

describe('MyBatis Flex 1.11.1 雪花位布局与时间边界', () => {
  it('保留原 epoch、41 位时间和低 22 位节点序列布局', () => {
    expect(SNOWFLAKE_EPOCH).toBe(1680411660000n);
    expect(snowflakeCandidate(0n, time(123456789n))).toEqual({ id: 517815303929856n });
    expect(snowflakeCandidate(517815303929856n, time(123456789n))).toEqual({ id: 517815303929857n });
    expect(snowflakeCandidate(517815303929857n, time(123456790n))).toEqual({ id: 517815308124160n });
  });

  it('同毫秒 12 位序列耗尽后等待下一毫秒，不回绕复用 ID', () => {
    const previous = (10n << 22n) | 4095n;
    expect(snowflakeCandidate(previous, time(10n))).toEqual({ waitMilliseconds: 1 });
    expect(snowflakeCandidate(previous, time(11n))).toEqual({ id: 46137344n });
  });

  it('固定毫秒的 4096 个号码互不重复，第 4097 个等待真实时钟推进', () => {
    const ids: bigint[] = [];
    let previous = 0n;
    for (let index = 0; index < 4096; index++) {
      const result = snowflakeCandidate(previous, time(1n));
      if (!('id' in result)) throw new Error('序列提前耗尽');
      previous = result.id; ids.push(previous);
    }
    expect(new Set(ids).size).toBe(4096);
    expect(ids[0]).toBe(4194304n);
    expect(ids[4095]).toBe(4198399n);
    expect(snowflakeCandidate(previous, time(1n))).toEqual({ waitMilliseconds: 1 });
    expect(snowflakeCandidate(previous, time(2n))).toEqual({ id: 8388608n });
  });

  it('保留 5 毫秒回拨容忍等待，超出容忍值立即拒绝发号', () => {
    const previous = 10n << 22n;
    expect(snowflakeCandidate(previous, time(5n))).toEqual({ waitMilliseconds: 10 });
    expect(() => snowflakeCandidate(previous, time(4n))).toThrow('时钟回拨超过 5 毫秒');
  });

  it('拒绝早于 epoch 与超过 41 位时间范围的值，避免有符号 64 位溢出', () => {
    expect(() => snowflakeCandidate(0n, SNOWFLAKE_EPOCH - 1n)).toThrow('41 位范围');
    expect(() => snowflakeCandidate(0n, time(1n << 41n))).toThrow('41 位范围');
    const result = snowflakeCandidate(0n, time((1n << 41n) - 1n));
    expect(result).toEqual({ id: 9223372036850581504n });
  });
});
