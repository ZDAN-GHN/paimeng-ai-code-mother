import { describe, expect, it } from 'vitest';
import { stopReasonOf } from '@/server/generation-accounting';

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

  it('没有 abort 时保留调用点已经定下的原因', () => {
    expect(stopReasonOf({ current: 'completed', cancelled: false })).toBe('completed');
    expect(stopReasonOf({ current: 'verification-failed', cancelled: false })).toBe('verification-failed');
    expect(stopReasonOf({ current: 'no-changes', cancelled: false })).toBe('no-changes');
    expect(stopReasonOf({ current: 'step-limit', cancelled: false })).toBe('step-limit');
  });
});
