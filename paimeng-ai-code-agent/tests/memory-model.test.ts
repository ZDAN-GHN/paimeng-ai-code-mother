import { describe, expect, it } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { BusinessError } from '@/server/http';
import { aliasNotConfiguredMessage, isAliasNotConfigured, resolveSummaryModel, summarizeHistory, summaryAliasName } from '@/server/memory-model';
import type { AliasModel } from '@/server/models/adapters';
import type { SummaryModelSource } from '@/server/memory-model';

function generateResult(text: string, finish: 'stop' | 'length' | 'content-filter' | 'tool-calls' = 'stop'): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: finish, raw: finish },
    usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } },
    warnings: [],
  };
}

function mockModel(doGenerate: () => Promise<LanguageModelV4GenerateResult>) {
  return new MockLanguageModelV4({ modelId: 'memory-test', doGenerate });
}

function binding(overrides: Partial<AliasModel> = {}): AliasModel {
  return { alias: 'codegen.default', providerId: 'primary', modelName: 'codegen-model', apiKeySource: 'env', capabilities: { streaming: true, toolCalling: true, structuredOutput: false, imageInput: false }, model: mockModel(async () => generateResult('ok')), ...overrides };
}

const fallback: SummaryModelSource = { model: mockModel(async () => generateResult('fallback')), alias: 'codegen.default', providerId: 'primary', modelName: 'codegen-model' };

describe('isAliasNotConfigured', () => {
  it('只认 registry 的固定未配置文案', () => {
    expect(isAliasNotConfigured(new BusinessError(503, 50300, aliasNotConfiguredMessage(summaryAliasName)), summaryAliasName)).toBe(true);
    expect(isAliasNotConfigured(new BusinessError(503, 50300, '模型配置尚未成功加载'), summaryAliasName)).toBe(false);
    expect(isAliasNotConfigured(new BusinessError(500, 50300, aliasNotConfiguredMessage(summaryAliasName)), summaryAliasName)).toBe(false);
    expect(isAliasNotConfigured(new Error(aliasNotConfiguredMessage(summaryAliasName)), summaryAliasName)).toBe(false);
  });
});

describe('resolveSummaryModel', () => {
  it('memory.summarize 已配置时使用它', async () => {
    const fromAlias = binding({ alias: summaryAliasName, modelName: 'summarizer' });
    const resolved = await resolveSummaryModel(async () => fromAlias, fallback);
    expect(resolved.alias).toBe(summaryAliasName);
    expect(resolved.modelName).toBe('summarizer');
  });

  it('别名未配置时回退到本次生成模型', async () => {
    const resolved = await resolveSummaryModel(async () => { throw new BusinessError(503, 50300, aliasNotConfiguredMessage(summaryAliasName)); }, fallback);
    expect(resolved).toBe(fallback);
  });

  it('其他模型配置错误必须原样抛出', async () => {
    const other = new BusinessError(503, 50300, '已检测到更新的模型配置但加载失败，拒绝使用旧模型配置');
    await expect(resolveSummaryModel(async () => { throw other; }, fallback)).rejects.toBe(other);
    const network = new Error('ECONNREFUSED');
    await expect(resolveSummaryModel(async () => { throw network; }, fallback)).rejects.toBe(network);
  });
});

describe('summarizeHistory', () => {
  const base = { system: '系统提示', prompt: '历史回合', outputTokens: 512, timeoutMs: 5000 };

  it('返回文本与 token 用量', async () => {
    const result = await summarizeHistory({ ...base, model: mockModel(async () => generateResult('  摘要内容  ')) });
    expect(result).toEqual({ ok: true, text: '摘要内容', finishReason: 'stop', inputTokens: 10, outputTokens: 5 });
  });

  it('输出达到长度上限算失败，绝不保存半句摘要', async () => {
    const result = await summarizeHistory({ ...base, model: mockModel(async () => generateResult('半句话', 'length')) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('truncated');
  });

  it('空文本算失败', async () => {
    const result = await summarizeHistory({ ...base, model: mockModel(async () => generateResult('   ')) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('empty');
  });

  it('非 stop 终态（内容过滤、工具调用）都算失败', async () => {
    for (const finish of ['content-filter', 'tool-calls'] as const) {
      const result = await summarizeHistory({ ...base, model: mockModel(async () => generateResult('看起来完整的一句话', finish)) });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('unexpected-finish');
    }
  });

  it('上游忽略输出上限返回超大文本时算失败，不保存超预算摘要', async () => {
    const result = await summarizeHistory({ ...base, outputTokens: 32, model: mockModel(async () => generateResult('x'.repeat(1000))) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('over-budget');
      expect(result.detail).toContain('32');
    }
  });

  it('信号已取消时即使模型正常返回也拒绝', async () => {
    const result = await summarizeHistory({ ...base, model: mockModel(async () => generateResult('完整摘要')), signal: AbortSignal.abort() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('cancelled');
  });

  it('调用异常算失败且不泄露密钥', async () => {
    const result = await summarizeHistory({ ...base, model: mockModel(async () => { throw new Error('Bearer abcdef123456 被拒绝'); }) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('failed');
      expect(result.detail).not.toContain('abcdef123456');
    }
  });

  it('超时算失败', async () => {
    const hanging = new MockLanguageModelV4({
      modelId: 'memory-hang',
      doGenerate: options =>
        new Promise<LanguageModelV4GenerateResult>((_, reject) => {
          options.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    const result = await summarizeHistory({ ...base, model: hanging, timeoutMs: 25 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('timeout');
  }, 5000);
});
