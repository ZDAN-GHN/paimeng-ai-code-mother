import { describe, expect, it } from 'vitest';
import { generationStopReasons, type GenerationStopReason } from '@/shared/contracts';
import { isPlatformFault, platformFaultStopReasons, platformReversalReason } from '@/shared/billing';

/**
 * 终态归责表（04-settlement-design.md §4）：只有平台自身故障整笔冲正，其余终态一律按实收。
 * 这张表是纯数据，用全词汇表断言，保证「新增一个停止原因」时不会悄悄落进免费或收费的任何一侧。
 */

describe('终态归责', () => {
  it('只有 initialization-failed 与 lease-lost 判为平台故障', () => {
    expect([...platformFaultStopReasons]).toEqual(['initialization-failed', 'lease-lost']);
  });

  it('词汇表里每个停止原因都落在明确的一侧', () => {
    const platform = generationStopReasons.filter(reason => isPlatformFault(reason));
    expect(platform).toEqual(['lease-lost', 'initialization-failed']);
    // interrupted 按实收：进程崩溃时 token 确实烧掉了，规格把它排除在平台故障之外
    expect(isPlatformFault('interrupted')).toBe(false);
    expect(isPlatformFault('cancelled')).toBe(false);
    expect(isPlatformFault('question')).toBe(false);
    const charged = generationStopReasons.filter(reason => !isPlatformFault(reason));
    expect(charged).toHaveLength(generationStopReasons.length - platformFaultStopReasons.length);
  });

  it('没有停止原因时不算平台故障', () => {
    const missing: GenerationStopReason | null = null;
    expect(isPlatformFault(missing)).toBe(false);
  });

  it('自动冲正写固定的原因文案，便于界面与对账区分自动与人工', () => {
    expect(platformReversalReason).toBe('平台故障自动退还');
  });
});
