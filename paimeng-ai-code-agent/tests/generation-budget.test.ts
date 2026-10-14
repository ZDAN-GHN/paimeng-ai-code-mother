import { afterEach, describe, expect, it } from 'vitest';
import { getConfig } from '@/server/config';

const keys = ['GENERATION_TIMEOUT_MS', 'MODEL_REPLY_TIMEOUT_MS', 'MODEL_RETRY_LIMIT'] as const;

describe('生成时长与重试预算可通过环境变量配置', () => {
  afterEach(() => { for (const key of keys) delete process.env[key]; });

  it('默认不限制整次生成时长，单次回复 15 分钟，重试 2 次', () => {
    expect(getConfig()).toMatchObject({ generationTimeoutMs: 0, modelReplyTimeoutMs: 900000, modelRetryLimit: 2 });
  });

  it('可显式配置整次上限、单次回复上限与重试次数，留空回退默认', () => {
    process.env.GENERATION_TIMEOUT_MS = '1800000';
    process.env.MODEL_REPLY_TIMEOUT_MS = '120000';
    process.env.MODEL_RETRY_LIMIT = '0';
    expect(getConfig()).toMatchObject({ generationTimeoutMs: 1800000, modelReplyTimeoutMs: 120000, modelRetryLimit: 0 });
    process.env.GENERATION_TIMEOUT_MS = '';
    process.env.MODEL_REPLY_TIMEOUT_MS = ' ';
    process.env.MODEL_RETRY_LIMIT = '';
    expect(getConfig()).toMatchObject({ generationTimeoutMs: 0, modelReplyTimeoutMs: 900000, modelRetryLimit: 2 });
  });

  it('越界或非法取值会被拒绝', () => {
    const invalid = [
      ['GENERATION_TIMEOUT_MS', '-1'],
      ['GENERATION_TIMEOUT_MS', '86400001'],
      ['MODEL_REPLY_TIMEOUT_MS', '999'],
      ['MODEL_REPLY_TIMEOUT_MS', 'abc'],
      ['MODEL_RETRY_LIMIT', '6'],
      ['MODEL_RETRY_LIMIT', '-1'],
    ] as const;
    for (const [key, value] of invalid) {
      process.env[key] = value;
      expect(() => getConfig(), `${key}=${value}`).toThrow();
      delete process.env[key];
    }
  });
});
