import { afterEach, describe, expect, it } from 'vitest';
import { getConfig } from '@/server/config';

const keys = [
  'MEMORY_ENABLED',
  'MEMORY_CONTEXT_BUDGET_TOKENS',
  'MEMORY_RECENT_BUDGET_TOKENS',
  'MEMORY_SUMMARY_INPUT_TOKENS',
  'MEMORY_SUMMARY_OUTPUT_TOKENS',
  'MEMORY_CALL_TIMEOUT_MS',
  'MEMORY_MIN_NEW_TURNS',
  'MEMORY_RETRY_INTERVAL_MS',
] as const;

afterEach(() => {
  for (const key of keys) delete process.env[key];
});

describe('memory config', () => {
  it('默认启用并给出保守预算', () => {
    expect(getConfig().memory).toEqual({
      enabled: true,
      contextTokens: 24000,
      recentTokens: 12000,
      summaryInputTokens: 24000,
      summaryOutputTokens: 2048,
      callTimeoutMs: 60000,
      minNewTurns: 4,
      retryIntervalMs: 120000,
    });
  });

  it('开关接受 true/false/1/0 并拒绝其他值', () => {
    process.env.MEMORY_ENABLED = 'false';
    expect(getConfig().memory.enabled).toBe(false);
    process.env.MEMORY_ENABLED = '0';
    expect(getConfig().memory.enabled).toBe(false);
    process.env.MEMORY_ENABLED = 'true';
    expect(getConfig().memory.enabled).toBe(true);
    process.env.MEMORY_ENABLED = '1';
    expect(getConfig().memory.enabled).toBe(true);
    process.env.MEMORY_ENABLED = 'maybe';
    expect(() => getConfig()).toThrow();
  });

  it('覆盖数值预算', () => {
    process.env.MEMORY_CONTEXT_BUDGET_TOKENS = '50000';
    process.env.MEMORY_RECENT_BUDGET_TOKENS = '20000';
    process.env.MEMORY_SUMMARY_INPUT_TOKENS = '40000';
    process.env.MEMORY_SUMMARY_OUTPUT_TOKENS = '4096';
    process.env.MEMORY_CALL_TIMEOUT_MS = '30000';
    process.env.MEMORY_MIN_NEW_TURNS = '6';
    process.env.MEMORY_RETRY_INTERVAL_MS = '300000';
    expect(getConfig().memory).toMatchObject({
      contextTokens: 50000,
      recentTokens: 20000,
      summaryInputTokens: 40000,
      summaryOutputTokens: 4096,
      callTimeoutMs: 30000,
      minNewTurns: 6,
      retryIntervalMs: 300000,
    });
  });

  it('空白值回退到默认', () => {
    process.env.MEMORY_CONTEXT_BUDGET_TOKENS = '';
    process.env.MEMORY_MIN_NEW_TURNS = '  ';
    expect(getConfig().memory.contextTokens).toBe(24000);
    expect(getConfig().memory.minNewTurns).toBe(4);
  });

  it('拒绝越界数值', () => {
    const invalid: Array<[string, string]> = [
      ['MEMORY_CONTEXT_BUDGET_TOKENS', '1000'],
      ['MEMORY_RECENT_BUDGET_TOKENS', '100'],
      ['MEMORY_SUMMARY_INPUT_TOKENS', '1000'],
      ['MEMORY_SUMMARY_OUTPUT_TOKENS', '64'],
      ['MEMORY_CALL_TIMEOUT_MS', '500'],
      ['MEMORY_MIN_NEW_TURNS', '0'],
      ['MEMORY_RETRY_INTERVAL_MS', '100'],
    ];
    for (const [key, value] of invalid) {
      process.env[key] = value;
      expect(() => getConfig(), `${key}=${value}`).toThrow();
      delete process.env[key];
    }
  });

  it('预算之间必须互相校验', () => {
    process.env.MEMORY_SUMMARY_OUTPUT_TOKENS = '30000';
    expect(() => getConfig()).toThrow(/MEMORY_SUMMARY_OUTPUT_TOKENS/);
    delete process.env.MEMORY_SUMMARY_OUTPUT_TOKENS;
    process.env.MEMORY_RECENT_BUDGET_TOKENS = '23000';
    expect(() => getConfig()).toThrow(/MEMORY_RECENT_BUDGET_TOKENS/);
  });
});
