import { describe, expect, it } from 'vitest';
import {
  allowedModelApiKeyEnvs,
  decimalVersionSchema,
  isAllowedModelApiKeyEnv,
  modelAliasInputSchema,
  modelBaseUrlIssue,
  modelConfigIssues,
  modelConfigListIssues,
  modelInternalOriginIssue,
  modelProviderInputSchema,
  modelProviderOptionKeys,
  modelProviderWriteSchema,
  aliasSettingsSchema,
  providerOptionKeysByFormat,
  providerApiFormats,
  providerHeaderLimit,
  providerHeaderNameLimit,
  providerHeaderValueLimit,
  providerOptionsIssue,
  capabilitiesForSlot,
  missingSlotCapabilities,
  modelCapabilityLabels,
  modelSlotOf,
  modelSlots,
  reasoningLevels,
  requiredModelAliases,
  thinkingSwitchValues,
  type ModelAliasInput,
  type ModelProviderInput,
  type ModelProviderOptions,
  type ModelProviderWriteInput,
  type ProviderApiFormat,
  type ProviderKeySource,
} from '@/shared/model-config';

const policy = { allowedApiKeyEnvs: [], internalOrigins: ['http://model-gateway.internal:8080'] };

type ProviderDraft = {
  id: string;
  displayName: string;
  apiFormat: ProviderApiFormat;
  baseUrl: string;
  apiKeySource: ProviderKeySource;
  apiKeyEnv: string;
  apiKeyCiphertext: string;
  apiKey: string;
  options: ModelProviderOptions;
  enabled: boolean;
};

const providerDraft = (overrides: Partial<ProviderDraft> = {}): ProviderDraft => ({
  id: 'primary',
  displayName: '主提供商',
  apiFormat: 'openai-chat',
  baseUrl: 'https://api.example.test/v1',
  apiKeySource: 'env',
  apiKeyEnv: 'AI_API_KEY',
  apiKeyCiphertext: 'v1:iv:tag:ciphertext',
  apiKey: 'sk-test',
  options: {},
  enabled: true,
  ...overrides,
});

function providerCommon(draft: ProviderDraft) {
  return {
    id: draft.id,
    displayName: draft.displayName,
    apiFormat: draft.apiFormat,
    baseUrl: draft.baseUrl,
    options: draft.options,
    enabled: draft.enabled,
  };
}

const provider = (overrides: Partial<ProviderDraft> = {}): ModelProviderInput => {
  const draft = providerDraft(overrides);
  return draft.apiKeySource === 'env'
    ? { ...providerCommon(draft), apiKeySource: 'env', apiKeyEnv: draft.apiKeyEnv }
    : { ...providerCommon(draft), apiKeySource: 'inline', apiKeyCiphertext: draft.apiKeyCiphertext };
};

const providerWrite = (overrides: Partial<ProviderDraft> = {}): ModelProviderWriteInput => {
  const draft = providerDraft(overrides);
  return draft.apiKeySource === 'env'
    ? { ...providerCommon(draft), apiKeySource: 'env', apiKeyEnv: draft.apiKeyEnv }
    : { ...providerCommon(draft), apiKeySource: 'inline', apiKey: draft.apiKey };
};

const codegenAlias = (overrides: Partial<ModelAliasInput> = {}): ModelAliasInput => ({
  alias: 'codegen.default',
  providerId: 'primary',
  modelName: 'gpt-test',
  capabilities: { streaming: true, toolCalling: true, structuredOutput: false, imageInput: false },
  settings: {},
  enabled: true,
  ...overrides,
});

const routeAlias = (overrides: Partial<ModelAliasInput> = {}): ModelAliasInput => ({
  alias: 'route.classify',
  providerId: 'primary',
  modelName: 'gpt-test',
  capabilities: { streaming: false, toolCalling: false, structuredOutput: true, imageInput: false },
  settings: {},
  enabled: true,
  ...overrides,
});

describe('模型密钥引用允许名单', () => {
  it('始终允许 AI_API_KEY，其余名称必须显式声明', () => {
    expect(allowedModelApiKeyEnvs(['PRIMARY_KEY'])).toEqual(['AI_API_KEY', 'PRIMARY_KEY']);
    expect(isAllowedModelApiKeyEnv('AI_API_KEY', [])).toBe(true);
    expect(isAllowedModelApiKeyEnv('PRIMARY_KEY', [])).toBe(false);
    expect(isAllowedModelApiKeyEnv('PRIMARY_KEY', ['PRIMARY_KEY'])).toBe(true);
  });

  it('密钥引用名只接受大写环境变量名，最长 128 个字符', () => {
    expect(modelProviderInputSchema.safeParse(provider({ apiKeyEnv: 'lowercase' })).success).toBe(false);
    expect(modelProviderInputSchema.safeParse(provider({ apiKeyEnv: 'AI_API_KEY' })).success).toBe(true);
    expect(modelProviderInputSchema.safeParse(provider({ apiKeyEnv: `A${'B'.repeat(127)}` })).success).toBe(true);
    expect(modelProviderInputSchema.safeParse(provider({ apiKeyEnv: `A${'B'.repeat(128)}` })).success).toBe(false);
  });
});

describe('API 格式、选项与密钥来源', () => {
  it('只接受已注册的 API 格式，旧适配器名不再合法', () => {
    expect(providerApiFormats).toEqual(['openai-chat', 'openai-responses', 'anthropic-messages']);
    for (const apiFormat of providerApiFormats) {
      expect(modelProviderInputSchema.safeParse(provider({ apiFormat })).success).toBe(true);
      expect(modelProviderWriteSchema.safeParse(providerWrite({ apiFormat })).success).toBe(true);
    }
    expect(modelProviderInputSchema.safeParse({ ...provider(), adapter: 'openai-compatible' }).success).toBe(false);
  });

  it('选项白名单随格式变化，未知选项被拒绝', () => {
    expect(providerOptionsIssue('openai-chat', { includeUsage: true })).toBeNull();
    expect(providerOptionsIssue('openai-responses', { includeUsage: true })).toContain('不支持选项 includeUsage');
    expect(providerOptionsIssue('anthropic-messages', { supportsStructuredOutputs: true })).toContain(
      '不支持选项 supportsStructuredOutputs',
    );
    expect(providerOptionsIssue('openai-responses', {})).toBeNull();
    expect(modelProviderInputSchema.safeParse(provider({ options: { includeUsage: true } })).success).toBe(true);
  });

  it('校验会把格式不支持的选项报成配置问题', () => {
    const issues = modelConfigIssues(
      [provider({ apiFormat: 'openai-responses', options: { includeUsage: true } })],
      [codegenAlias(), routeAlias()],
      policy,
    );
    expect(issues.some(issue => issue.includes('不支持选项 includeUsage'))).toBe(true);
  });

  it('直接输入的密钥在写入口径是明文、存储口径只有密文', () => {
    expect(modelProviderWriteSchema.safeParse(providerWrite({ apiKeySource: 'inline' })).success).toBe(true);
    expect(modelProviderWriteSchema.safeParse(providerWrite({ apiKeySource: 'inline', apiKey: '' })).success).toBe(true);
    expect(modelProviderWriteSchema.safeParse(providerWrite({ apiKeySource: 'inline', apiKey: 'x'.repeat(1025) })).success).toBe(false);
    expect(modelProviderInputSchema.safeParse(provider({ apiKeySource: 'inline' })).success).toBe(true);
    expect(modelProviderInputSchema.safeParse(providerWrite({ apiKeySource: 'inline' })).success).toBe(false);
    expect(modelProviderWriteSchema.safeParse(provider({ apiKeySource: 'inline' })).success).toBe(false);
  });

  it('两种来源都要求各自的密钥字段', () => {
    expect(modelProviderInputSchema.safeParse({ ...provider(), apiKeySource: 'inline', apiKeyEnv: 'AI_API_KEY' }).success).toBe(false);
    expect(modelProviderWriteSchema.safeParse({ ...providerWrite(), apiKeySource: 'env', apiKey: 'sk-test' }).success).toBe(false);
  });

  it('思考开关只对 openai-chat 生效，且只接受开关枚举', () => {
    expect(thinkingSwitchValues).toEqual(['enabled', 'disabled']);
    expect(providerOptionKeysByFormat['openai-chat']).toContain('thinkingSwitch');
    expect(providerOptionKeysByFormat['openai-responses']).toEqual([]);
    expect(providerOptionKeysByFormat['anthropic-messages']).toEqual([]);
    expect(modelProviderInputSchema.safeParse(provider({ options: { thinkingSwitch: 'disabled' } })).success).toBe(true);
    const invalidSwitch: unknown = { ...provider(), options: { thinkingSwitch: 'off' } };
    expect(modelProviderInputSchema.safeParse(invalidSwitch).success).toBe(false);
    expect(providerOptionsIssue('openai-responses', { thinkingSwitch: 'enabled' })).toContain('不支持选项 thinkingSwitch');
    const issues = modelConfigIssues(
      [provider({ apiFormat: 'anthropic-messages', options: { thinkingSwitch: 'enabled' } })],
      [codegenAlias(), routeAlias()],
      policy,
    );
    expect(issues.some(issue => issue.includes('不支持选项 thinkingSwitch'))).toBe(true);
  });
});

describe('提供商自定义请求头', () => {
  const withHeaders = (headers: unknown): unknown => ({ ...provider(), headers });

  it('可选：缺省与空集合都合法，普通自定义头通过', () => {
    expect(modelProviderInputSchema.safeParse(provider()).success).toBe(true);
    expect(modelProviderInputSchema.safeParse(withHeaders({})).success).toBe(true);
    const valid = { 'User-Agent': 'paimeng-ai-code-mother/1.0', 'HTTP-Referer': 'https://example.test', 'X-Title': 'paimeng' };
    expect(modelProviderInputSchema.safeParse(withHeaders(valid)).success).toBe(true);
    expect(modelProviderWriteSchema.safeParse({ ...providerWrite(), headers: { 'X-Title': 'paimeng' } }).success).toBe(true);
  });

  it('拒绝由系统生成的鉴权与传输头（名称大小写不敏感）', () => {
    for (const name of ['authorization', 'Authorization', 'X-Api-Key', 'x-goog-api-key', 'Host', 'Content-Length', 'Connection', 'Transfer-Encoding']) {
      expect(modelProviderInputSchema.safeParse(withHeaders({ [name]: 'x' })).success).toBe(false);
    }
  });

  it('拒绝名称大小写重复', () => {
    const result = modelProviderInputSchema.safeParse(withHeaders({ 'X-Title': 'a', 'x-title': 'b' }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some(issue => issue.message.includes('重复'))).toBe(true);
  });

  it('拒绝非法名称字符与 CRLF 注入', () => {
    for (const name of ['Bad Name', 'X-Title\nInjected', 'X-Title:evil', '']) {
      expect(modelProviderInputSchema.safeParse(withHeaders({ [name]: 'v' })).success).toBe(false);
    }
  });

  it('拒绝控制字符、CRLF 与首尾空白的请求头值', () => {
    for (const value of ['bad\nvalue', 'bad\rvalue', 'bad\u0000value', ' padded', 'padded ', '']) {
      expect(modelProviderInputSchema.safeParse(withHeaders({ 'X-Title': value })).success).toBe(false);
    }
    expect(modelProviderInputSchema.safeParse(withHeaders({ 'X-Title': 'ok value' })).success).toBe(true);
  });

  it('限制请求头数量与名称/值长度', () => {
    const tooMany = Object.fromEntries(Array.from({ length: providerHeaderLimit + 1 }, (_value, index) => [`X-H-${index}`, 'v']));
    expect(modelProviderInputSchema.safeParse(withHeaders(tooMany)).success).toBe(false);
    expect(modelProviderInputSchema.safeParse(withHeaders({ [`X-${'a'.repeat(providerHeaderNameLimit)}`]: 'v' })).success).toBe(false);
    expect(modelProviderInputSchema.safeParse(withHeaders({ 'X-Title': 'v'.repeat(providerHeaderValueLimit + 1) })).success).toBe(false);
    expect(modelProviderInputSchema.safeParse(withHeaders({ 'X-Title': 'v'.repeat(providerHeaderValueLimit) })).success).toBe(true);
  });
});

describe('别名思考强度', () => {
  it('接受 SDK 的思考强度枚举，拒绝未知取值', () => {
    expect(reasoningLevels).toContain('high');
    expect(reasoningLevels).toContain('xhigh');
    expect(aliasSettingsSchema.safeParse({ reasoning: 'high' }).success).toBe(true);
    const invalidLevel: unknown = { reasoning: '超高' };
    expect(aliasSettingsSchema.safeParse(invalidLevel).success).toBe(false);
    expect(aliasSettingsSchema.safeParse({}).success).toBe(true);
    expect(aliasSettingsSchema.safeParse({ reasoning: undefined }).success).toBe(true);
  });

  it('思考强度可以随别名一起保存', () => {
    const alias = codegenAlias({ settings: { reasoning: 'medium', temperature: 0.2 } });
    expect(modelAliasInputSchema.safeParse(alias).success).toBe(true);
    const invalidSettings: unknown = { ...codegenAlias(), settings: { reasoning: 'lowest' } };
    expect(modelAliasInputSchema.safeParse(invalidSettings).success).toBe(false);
  });

  it('选项键名单从 schema 派生，开关之外的键只有思考开关', () => {
    expect(modelProviderOptionKeys).toEqual(['includeUsage', 'supportsStructuredOutputs', 'supportsMultiPartToolContent', 'thinkingSwitch']);
  });
});

describe('模型地址校验', () => {
  it('HTTPS 默认放行，无凭据、无查询、无片段', () => {
    expect(modelBaseUrlIssue('https://api.openai.com/v1', policy)).toBeNull();
  });

  it('HTTP 直接放行本机与局域网地址，不需要部署允许名单', () => {
    for (const value of [
      'http://127.0.0.1:8080/v1',
      'http://127.9.9.9:1/v1',
      'http://localhost:1234/v1',
      'http://LOCALHOST:1234/v1',
      'http://[::1]:1234/v1',
      'http://10.0.0.7:8080/v1',
      'http://172.16.5.5:8080/v1',
      'http://172.31.255.254/v1',
      'http://192.168.1.20:1234/v1',
    ]) {
      expect(modelBaseUrlIssue(value, policy), value).toBeNull();
    }
  });

  it('HTTP 只放行本机/局域网或部署显式允许的来源', () => {
    expect(modelBaseUrlIssue('http://model-gateway.internal:8080/v1', policy)).toBeNull();
    expect(modelBaseUrlIssue('http://model-gateway.internal:9090/v1', policy)).toContain('局域网');
    expect(modelBaseUrlIssue('http://api.example.com/v1', policy)).not.toBeNull();
    expect(modelBaseUrlIssue('http://8.8.8.8/v1', policy)).not.toBeNull();
    expect(modelBaseUrlIssue('http://172.32.0.1/v1', policy)).not.toBeNull();
    expect(modelBaseUrlIssue('http://192.169.1.1/v1', policy)).not.toBeNull();
    expect(modelBaseUrlIssue('http://169.254.169.254/latest', policy)).not.toBeNull();
    expect(modelBaseUrlIssue('http://127.0.0.1:8080/v1', { internalOrigins: ['http://127.0.0.1:8080'] })).toBeNull();
  });

  it('拒绝内嵌凭据、查询参数、片段与非 HTTP(S)', () => {
    expect(modelBaseUrlIssue('https://user:secret@api.openai.com/v1', policy)).toContain('凭据');
    expect(modelBaseUrlIssue('https://api.openai.com/v1?api_key=secret', policy)).toContain('查询参数');
    expect(modelBaseUrlIssue('https://api.openai.com/v1#frag', policy)).toContain('片段');
    expect(modelBaseUrlIssue('ftp://api.openai.com', policy)).toContain('HTTP(S)');
    expect(modelBaseUrlIssue('not a url', policy)).toContain('绝对 URL');
  });
});

describe('部署允许名单配置', () => {
  it('合法条目通过', () => {
    expect(modelConfigListIssues(['PRIMARY_KEY'], ['http://127.0.0.1:8080', 'https://gateway.example'])).toEqual([]);
    expect(modelInternalOriginIssue('http://127.0.0.1:8080')).toBeNull();
  });

  it('非法条目被拒且不回显条目内容', () => {
    expect(modelConfigListIssues(['lowercase'], [])).toEqual(['MODEL_API_KEY_ENV_ALLOWLIST 第 1 项不是合法的环境变量名']);
    const issues = modelConfigListIssues([], ['http://user:secret@gateway.example', 'http://gateway.example/path', 'ftp://gateway.example', 'not a url']);
    expect(issues).toHaveLength(4);
    expect(issues.join('；')).not.toContain('secret');
    expect(issues[1]).toContain('第 2 项');
  });
});

describe('完整候选配置校验', () => {
  it('两个必需别名齐全且能力满足时通过', () => {
    expect(modelConfigIssues([provider()], [codegenAlias(), routeAlias()], policy)).toEqual([]);
  });

  it('缺少、禁用必需槽位或能力不符会被拒绝', () => {
    const missing = modelConfigIssues([provider()], [codegenAlias()], policy);
    expect(missing.some(issue => issue.includes('缺少必需槽位类型路由（route.classify）'))).toBe(true);
    expect(missing.some(issue => issue.includes('无法识别工程类型'))).toBe(true);
    expect(modelConfigIssues([provider()], [codegenAlias({ enabled: false }), routeAlias()], policy))
      .toContain('必需槽位代码生成（codegen.default）不能禁用');
    expect(modelConfigIssues([provider()], [codegenAlias({ capabilities: { streaming: true, toolCalling: false, structuredOutput: false, imageInput: false } }), routeAlias()], policy))
      .toContain('槽位代码生成（codegen.default）需要工具调用能力，当前未勾选');
  });

  it('别名必须指向存在的启用提供商', () => {
    expect(modelConfigIssues([provider()], [codegenAlias({ providerId: 'missing' }), routeAlias({ providerId: 'missing' })], policy).some(issue => issue.includes('不存在的提供商'))).toBe(true);
    expect(modelConfigIssues([provider({ enabled: false })], [codegenAlias(), routeAlias()], policy).some(issue => issue.includes('已禁用的提供商'))).toBe(true);
  });

  it('未允许的密钥引用与非法地址会被拒绝', () => {
    expect(modelConfigIssues([provider({ apiKeyEnv: 'PRIMARY_KEY' })], [codegenAlias(), routeAlias()], policy).some(issue => issue.includes('未允许的环境变量'))).toBe(true);
    expect(modelConfigIssues([provider({ baseUrl: 'http://evil.example/v1' })], [codegenAlias(), routeAlias()], policy).some(issue => issue.includes('地址不合法'))).toBe(true);
  });
});

describe('版本号十进制字符串', () => {
  it('接受非负十进制字符串，拒绝前导零与负数', () => {
    expect(decimalVersionSchema.parse('0')).toBe('0');
    expect(decimalVersionSchema.parse('12345678901234567890')).toBe('12345678901234567890');
    expect(decimalVersionSchema.safeParse('01').success).toBe(false);
    expect(decimalVersionSchema.safeParse('-1').success).toBe(false);
    expect(decimalVersionSchema.safeParse('1.5').success).toBe(false);
    expect(decimalVersionSchema.safeParse('18446744073709551616').success).toBe(false);
  });
});

describe('槽位清单', () => {
  it('仅有两个必需槽位，四个槽位编号唯一', () => {
    expect([...requiredModelAliases]).toEqual(['codegen.default', 'route.classify']);
    expect(modelSlots).toHaveLength(4);
    expect(new Set(modelSlots.map(slot => slot.slot)).size).toBe(4);
  });

  it('槽位要求能生成满足要求的能力声明', () => {
    for (const slot of modelSlots) {
      const capabilities = capabilitiesForSlot(slot);
      expect(missingSlotCapabilities(slot, capabilities)).toEqual([]);
      expect(missingSlotCapabilities(slot, { ...capabilities, ...Object.fromEntries(slot.requires.map(requirement => [requirement, false])) }))
        .toEqual([...slot.requires]);
    }
    expect(capabilitiesForSlot(modelSlotOf('codegen.default') ?? modelSlots[0])).toEqual({ streaming: true, toolCalling: true, structuredOutput: false, imageInput: false });
    expect(capabilitiesForSlot(modelSlotOf('route.classify') ?? modelSlots[1])).toEqual({ streaming: false, toolCalling: false, structuredOutput: true, imageInput: false });
  });

  it('每个能力都有中文名，未配置后果不为空', () => {
    for (const slot of modelSlots) {
      expect(slot.missingImpact.length).toBeGreaterThan(0);
      for (const requirement of slot.requires) expect(modelCapabilityLabels[requirement].length).toBeGreaterThan(0);
    }
    expect(modelSlotOf('unknown.slot')).toBeNull();
  });

  it('别名 schema 拒绝未知字段', () => {
    expect(modelAliasInputSchema.safeParse({ ...codegenAlias(), extra: 1 }).success).toBe(false);
  });
});
