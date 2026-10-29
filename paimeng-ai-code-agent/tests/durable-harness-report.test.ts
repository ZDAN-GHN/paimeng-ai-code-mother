import { describe, expect, it } from 'vitest';
import { buildHarnessOptions, createHarnessRegistry, durableModels, reportSummary } from '@/server/durable/harness';

const task = { id: 7 as never, kind: 'pi.agent', conversationId: 3 as never };

describe('pi-durable 1.4.0 报告与设置', () => {
  it('onReport 的结构化信息能压成一行，parked 与迁移失败可区分', () => {
    expect(reportSummary({ type: 'task_parked', task })).toContain('task_parked task=7 kind=pi.agent conversation=3');
    expect(reportSummary({ type: 'task_faulted', task, reason: 'restart_limit' })).toContain('reason=restart_limit');
    expect(reportSummary({ type: 'migration_failed', task })).toContain('migration_failed');
    expect(reportSummary({ type: 'host_error', callback: 'now' })).toBe('host_error callback=now task=-');
    expect(reportSummary({ type: 'session_failed' })).toBe('session_failed');
  });

  it('产品 harness 显式 withdraw 失败后的排队输入，并保留调用方设置', () => {
    const options = buildHarnessOptions(durableModels(), createHarnessRegistry({ codingTools: false }), { stream: { timeoutMs: 1234 } });
    expect(options.settings).toMatchObject({ afterFailedRun: 'withdraw', stream: { timeoutMs: 1234 } });
    // restartLimit 保持 SDK 默认（不在这里固定成 Infinity 或其他值）。
    expect(options.settings && 'restartLimit' in options.settings).toBe(false);
  });

  it('调用方可以显式覆盖 afterFailedRun', () => {
    const options = buildHarnessOptions(durableModels(), createHarnessRegistry({ codingTools: false }), { afterFailedRun: 'keep' });
    expect(options.settings?.afterFailedRun).toBe('keep');
  });
});
