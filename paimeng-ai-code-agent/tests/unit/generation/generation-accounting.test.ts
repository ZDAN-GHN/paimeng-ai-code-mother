import { describe, expect, it } from 'vitest';
import { stopReasonFrom, stopReasonOf } from '@/server/generation/generation-accounting';

describe('任务级停止原因', () => {
  it('取消优先于一切，包括带原因的 abort', () => {
    expect(stopReasonOf({ current: 'verification-failed', cancelled: true, abortedReason: new Error('生成超时') })).toBe('cancelled');
  });

  it('带原因的 abort 按原因分类：超时、租约失效、其它算模型错误', () => {
    expect(stopReasonOf({ current: 'model-error', cancelled: false, abortedReason: new Error('生成超时') })).toBe('timeout');
    expect(stopReasonOf({ current: 'model-error', cancelled: false, abortedReason: new Error('单次回复超时（900 秒）') })).toBe('timeout');
    expect(stopReasonOf({ current: 'model-error', cancelled: false, abortedReason: new Error('生成任务已失效') })).toBe('lease-lost');
    expect(stopReasonOf({ current: 'model-error', cancelled: false, abortedReason: new Error('生成已停止写入') })).toBe('lease-lost');
    expect(stopReasonOf({ current: 'model-error', cancelled: false, abortedReason: new Error('上游断开') })).toBe('model-error');
  });

  it('透支线熔断单独归类，优先级高于租约失效', () => {
    expect(stopReasonOf({ current: 'model-error', cancelled: false, abortedReason: new Error('已超出透支线，生成已中止') })).toBe('overdraft');
    // 文案里同时出现「失效」时也必须是 overdraft：用户被掐断的原因不能显示成平台写权限丢失。
    expect(stopReasonOf({ current: 'model-error', cancelled: false, abortedReason: new Error('已超出透支线，生成已失效') })).toBe('overdraft');
    // 用户取消仍然优先：同一句话是用户自己停掉的时候不归因到额度。
    expect(stopReasonOf({ current: 'model-error', cancelled: true, abortedReason: new Error('已超出透支线，生成已中止') })).toBe('cancelled');
  });

  it('overdraft 在停止原因词汇表里，读回时不被当成未知值丢掉', () => {
    // 读回这一层决定 generation-store 的 effectiveStopReason 会不会把它覆盖成 null。
    expect(stopReasonFrom('overdraft')).toBe('overdraft');
  });

  it('没有 abort 时保留调用点已经定下的原因', () => {
    expect(stopReasonOf({ current: 'completed', cancelled: false })).toBe('completed');
    expect(stopReasonOf({ current: 'verification-failed', cancelled: false })).toBe('verification-failed');
    expect(stopReasonOf({ current: 'no-changes', cancelled: false })).toBe('no-changes');
    expect(stopReasonOf({ current: 'step-limit', cancelled: false })).toBe('step-limit');
  });
});
