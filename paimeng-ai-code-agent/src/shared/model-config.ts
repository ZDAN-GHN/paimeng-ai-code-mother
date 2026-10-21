import { z } from 'zod';

/** 业务必需别名：缺失或禁用的完整配置会被写入事务拒绝。 */
export const requiredModelAliases = ['codegen.default', 'route.classify'] as const;
export type RequiredModelAlias = typeof requiredModelAliases[number];

/**
 * 业务可用的可选别名：不配置时对应功能优雅降级（当前只有语音输入），配置后由注册表按名字解析。
 * 管理端据此在别名列表里标注用途、并提供预填了名字与能力的新建入口。
 */
export const optionalModelAliases = {
  'version.summary': {
    label: '版本概述',
    purpose: '给每个应用版本起一句 20 字以内的中文概括（版本历史里显示）；未配置时用「改动 N 个文件」这类兜底文案',
    capabilities: { streaming: false, toolCalling: false, structuredOutput: false, imageInput: false },
  },
  'speech.transcribe': {
    label: '语音输入转写',
    purpose: '浏览器录音转文字，需要提供商提供 OpenAI 兼容的 /audio/transcriptions 接口；未配置时聊天页禁用麦克风按钮',
    /** 转写不走对话补全，声明上没有流式/工具/结构化输出需求。 */
    capabilities: { streaming: false, toolCalling: false, structuredOutput: false, imageInput: false },
  },
} as const satisfies Record<string, { label: string; purpose: string; capabilities: ModelAliasCapabilities }>;
export type OptionalModelAlias = keyof typeof optionalModelAliases;

/** 别名用途说明；未知别名返回 null（界面不标注）。 */
export function aliasPurposeOf(alias: string): { label: string; purpose: string } | null {
  return alias in optionalModelAliases ? optionalModelAliases[alias as OptionalModelAlias] : null;
}

/** 第一版支持的 API 格式；值写入 model_provider.api_format。 */
export const providerApiFormats = ['openai-chat', 'openai-responses', 'anthropic-messages'] as const;
export type ProviderApiFormat = typeof providerApiFormats[number];

/** 管理端展示名：中文用途 + 协议入口。 */
export const providerApiFormatLabels: Record<ProviderApiFormat, string> = {
  'openai-chat': 'OpenAI Chat Completions（/chat/completions）',
  'openai-responses': 'OpenAI Responses API（/responses）',
  'anthropic-messages': 'Anthropic Messages API（/messages）',
};

/** 密钥来源：引用环境变量，或直接输入（服务端加密后入库）。 */
export const providerKeySources = ['env', 'inline'] as const;
export type ProviderKeySource = typeof providerKeySources[number];

/** 显式初始化命令创建的默认提供商标识，创建后不可改名。 */
export const defaultModelProviderId = 'env-default';

/** 始终允许作为模型密钥引用的环境变量；其余名称必须显式加入部署允许名单。 */
export const baseModelApiKeyEnv = 'AI_API_KEY';

export function allowedModelApiKeyEnvs(configured: readonly string[]): readonly string[] {
  return [baseModelApiKeyEnv, ...configured];
}

export function isAllowedModelApiKeyEnv(name: string, configured: readonly string[]): boolean {
  return allowedModelApiKeyEnvs(configured).includes(name);
}

/** 单行状态表主键，`revision` 与 `refreshEpoch` 都写在这一行上。 */
export const modelConfigStateId = 'models';

export const decimalVersionSchema = z.string().regex(/^(?:0|[1-9][0-9]*)$/, '版本号必须是十进制字符串').refine(value => /^(?:0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= 18446744073709551615n, '版本号超出范围');
export type ModelConfigVersion = { revision: string; refreshEpoch: string };

export const modelIdentifierSchema = z.string().min(1).max(64).regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/, '标识只能包含小写字母、数字、点、下划线和短横线');
export const modelAliasNameSchema = modelIdentifierSchema;
export const modelProviderIdSchema = modelIdentifierSchema;
export const modelApiKeyEnvSchema = z.string().max(128, '环境变量名最长 128 个字符').regex(/^[A-Z][A-Z0-9_]*$/, '环境变量名只能包含大写字母、数字和下划线');
export const modelBaseUrlSchema = z.string().min(1).max(2048);

/** 思考强度等级：AI SDK 的统一参数 `reasoning`，各 API 格式由提供方自行映射。 */
export const reasoningLevels = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningLevel = typeof reasoningLevels[number];

/** 思考强度中文标签；不指定时完全不发送该参数。 */
export const reasoningLevelLabels: Record<ReasoningLevel, string> = {
  none: '关闭思考',
  minimal: '最低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '更高',
  max: '最高',
};

/** DeepSeek Chat 格式的思考开关（请求体 `thinking: {type}`）；不指定时不发送该字段。 */
export const thinkingSwitchValues = ['enabled', 'disabled'] as const;
export type ThinkingSwitch = typeof thinkingSwitchValues[number];

export const thinkingSwitchLabels: Record<ThinkingSwitch, string> = {
  enabled: '强制开启思考',
  disabled: '强制关闭思考',
};

const providerOptionFlags = {
  includeUsage: z.boolean().optional(),
  supportsStructuredOutputs: z.boolean().optional(),
  supportsMultiPartToolContent: z.boolean().optional(),
  thinkingSwitch: z.enum(thinkingSwitchValues).optional(),
};

/** 管理端可编辑的兼容选项键，由 schema 派生，避免两处名单漂移。 */
export const modelProviderOptionKeys = Object.keys(providerOptionFlags) as (keyof typeof providerOptionFlags)[];
export type ModelProviderOptionKey = typeof modelProviderOptionKeys[number];

export const modelProviderOptionLabels: Record<ModelProviderOptionKey, string> = {
  includeUsage: '统计用量',
  supportsStructuredOutputs: '支持结构化输出',
  supportsMultiPartToolContent: '支持多段工具内容',
  thinkingSwitch: '思考开关（DeepSeek Chat）',
};

/** 取值不是布尔开关的选项键；界面要用下拉而不是开关渲染。 */
export const modelProviderChoiceOptionKeys: readonly ModelProviderOptionKey[] = ['thinkingSwitch'];

/** 非布尔选项的下拉取值（空值表示不发送该字段）。 */
export const modelProviderOptionChoices: Record<'thinkingSwitch', readonly { value: ThinkingSwitch; label: string }[]> = {
  thinkingSwitch: thinkingSwitchValues.map(value => ({ value, label: thinkingSwitchLabels[value] })),
};

export const providerOptionsSchema = z.strictObject(providerOptionFlags).default({});
export type ModelProviderOptions = z.infer<typeof providerOptionsSchema>;

/** 每种 API 格式允许的选项键；没有对应语义的格式留空，界面据此隐藏开关。 */
export const providerOptionKeysByFormat: Record<ProviderApiFormat, readonly ModelProviderOptionKey[]> = {
  'openai-chat': ['includeUsage', 'supportsStructuredOutputs', 'supportsMultiPartToolContent', 'thinkingSwitch'],
  'openai-responses': [],
  'anthropic-messages': [],
};

/** 校验选项名是否被该格式支持；合规时返回 null。 */
export function providerOptionsIssue(apiFormat: ProviderApiFormat, options: ModelProviderOptions): string | null {
  const allowed = providerOptionKeysByFormat[apiFormat];
  const unsupported = Object.keys(options).filter(key => !allowed.includes(key as ModelProviderOptionKey));
  if (!unsupported.length) return null;
  return `${providerApiFormatLabels[apiFormat]} 不支持选项 ${unsupported.join('、')}，请清空该格式不支持的选项`;
}

export const providerHeaderLimit = 32;
export const providerHeaderNameLimit = 128;
export const providerHeaderValueLimit = 1024;

/**
 * 由系统生成的鉴权与传输头。鉴权头由当前密钥来源生成，传输头会破坏 HTTP 语义；
 * 两者都不允许自定义覆盖，否则 SDK 请求与连通性探测会出现不同鉴权或畸形传输。
 */
export const protectedProviderHeaderNames = [
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-goog-api-key',
  'api-key',
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'keep-alive',
  'proxy-authenticate',
  'cookie',
  'set-cookie',
] as const;

export function isProtectedProviderHeader(name: string): boolean {
  return (protectedProviderHeaderNames as readonly string[]).includes(name.trim().toLowerCase());
}

/** 请求头名称：RFC 7230 token 字符集，拒绝控制字符与 CRLF，且不能是系统生成的鉴权/传输头。 */
export const providerHeaderNameSchema = z
  .string()
  .min(1, '请求头名称不能为空')
  .max(providerHeaderNameLimit, `请求头名称最长 ${providerHeaderNameLimit} 个字符`)
  .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/, '请求头名称只能包含 token 允许的字符')
  .refine(name => !isProtectedProviderHeader(name), '该请求头由系统生成，不能自定义');

/** 请求头值：限定为 Node fetch 能编码为 ByteString 的字符，拒绝控制字符、CRLF 与首尾空白，避免保存成功但发送失败。 */
export const providerHeaderValueSchema = z
  .string()
  .min(1, '请求头值不能为空')
  .max(providerHeaderValueLimit, `请求头值最长 ${providerHeaderValueLimit} 个字符`)
  .regex(/^[\x20-\x7e\x80-\xff]+$/, '请求头值包含非法字符')
  .refine(value => value.trim() === value, '请求头值首尾不能有空白字符');

/** 自定义请求头集合：名称大小写不敏感去重，数量不超过 providerHeaderLimit。 */
export const providerHeadersSchema = z
  .record(z.string(), providerHeaderValueSchema)
  .superRefine((headers, ctx) => {
    const names = Object.keys(headers);
    if (names.length > providerHeaderLimit) {
      ctx.addIssue({ code: 'custom', message: `自定义请求头最多 ${providerHeaderLimit} 条` });
    }
    const seen = new Set<string>();
    for (const name of names) {
      const parsed = providerHeaderNameSchema.safeParse(name);
      if (!parsed.success) {
        ctx.addIssue({ code: 'custom', message: parsed.error.issues[0]?.message ?? '请求头名称不合法' });
        continue;
      }
      const lower = name.toLowerCase();
      if (seen.has(lower)) ctx.addIssue({ code: 'custom', message: `请求头 ${name} 与已有名称大小写重复` });
      seen.add(lower);
    }
  });
export type ModelProviderHeaders = z.infer<typeof providerHeadersSchema>;

const providerFields = {
  id: modelProviderIdSchema,
  displayName: z.string().min(1).max(128),
  apiFormat: z.enum(providerApiFormats),
  baseUrl: modelBaseUrlSchema,
  options: providerOptionsSchema,
  headers: providerHeadersSchema.optional(),
  enabled: z.boolean(),
};

/** 直接输入密钥的明文上限；加密后的密文固定留在 apiKeyCiphertext(2048) 之内。 */
export const modelApiKeySecretSchema = z.string().max(1024, '直接输入的密钥最长 1024 个字符');
/** 直接输入密钥的密文，格式 `v1:<iv>:<tag>:<ciphertext>`。 */
export const modelApiKeyCiphertextSchema = z.string().min(1).max(2048);

/** 写入口径：引用环境变量，或提交明文密钥（空串表示保持已保存的密钥）。 */
export const modelProviderWriteSchema = z.discriminatedUnion('apiKeySource', [
  z.strictObject({ ...providerFields, apiKeySource: z.literal('env'), apiKeyEnv: modelApiKeyEnvSchema }),
  z.strictObject({ ...providerFields, apiKeySource: z.literal('inline'), apiKey: modelApiKeySecretSchema }),
]);
export type ModelProviderWriteInput = z.infer<typeof modelProviderWriteSchema>;

/** 存储口径：直接输入的密钥只保留密文，明文不进入任何持久层类型。 */
export const modelProviderInputSchema = z.discriminatedUnion('apiKeySource', [
  z.strictObject({ ...providerFields, apiKeySource: z.literal('env'), apiKeyEnv: modelApiKeyEnvSchema }),
  z.strictObject({ ...providerFields, apiKeySource: z.literal('inline'), apiKeyCiphertext: modelApiKeyCiphertextSchema }),
]);
export type ModelProviderInput = z.infer<typeof modelProviderInputSchema>;
export type ModelProvider = ModelProviderInput & { createTime: string; updateTime: string };

export const aliasCapabilitiesSchema = z.strictObject({
  streaming: z.boolean(),
  toolCalling: z.boolean(),
  structuredOutput: z.boolean(),
  // 视觉能力：默认 false，库里已有别名行（无该字段）仍能解析。发送图片前必须显式开启。
  imageInput: z.boolean().default(false),
});
export type ModelAliasCapabilities = z.infer<typeof aliasCapabilitiesSchema>;

export const aliasSettingsSchema = z.strictObject({
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  maxOutputTokens: z.number().int().min(1).max(1000000).optional(),
  reasoning: z.enum(reasoningLevels).optional(),
  /**
   * 这个别名指向的模型是不是 DeepSeek 类混合推理模型：是时多轮回放会给 assistant 消息回写
   * `reasoning_content`（哪怕空串），否则上游 thinking 模式报 400。按别名而非提供商配置——
   * 网关下并非每个模型都是 DeepSeek 类。
   */
  reasoningContentPassthrough: z.boolean().optional(),
}).default({});
export type ModelAliasSettings = z.infer<typeof aliasSettingsSchema>;

export const modelAliasInputSchema = z.strictObject({
  alias: modelAliasNameSchema,
  providerId: modelProviderIdSchema,
  modelName: z.string().min(1).max(256),
  capabilities: aliasCapabilitiesSchema,
  settings: aliasSettingsSchema,
  enabled: z.boolean(),
});
export type ModelAliasInput = z.infer<typeof modelAliasInputSchema>;
export type ModelAlias = ModelAliasInput & { createTime: string; updateTime: string };

export type ModelConfigSnapshot = ModelConfigVersion & {
  providers: ModelProvider[];
  aliases: ModelAlias[];
};

export type ModelConfigPolicy = {
  allowedApiKeyEnvs: readonly string[];
  internalOrigins: readonly string[];
};

/** 必需的声明能力；只校验配置声明，不代表上游一定支持。 */
const requiredCapabilities: Record<RequiredModelAlias, (capabilities: ModelAliasCapabilities) => boolean> = {
  'codegen.default': capabilities => capabilities.streaming && capabilities.toolCalling,
  'route.classify': capabilities => capabilities.structuredOutput,
};

function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** 返回内部来源条目的问题；合规时返回 null。只接受不带凭据、查询、片段和路径的 HTTP(S) 来源。 */
export function modelInternalOriginIssue(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return '必须是绝对 URL';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '只允许 HTTP(S)';
  if (url.username || url.password) return '不能包含内嵌凭据';
  if (url.search) return '不能包含查询参数';
  if (url.hash) return '不能包含片段';
  if (url.pathname !== '/' && url.pathname !== '') return '只能是来源，不能带路径';
  return null;
}

/** 校验部署配置的允许名单；只报告条目序号，不回显条目内容。 */
export function modelConfigListIssues(apiKeyEnvs: readonly string[], internalOrigins: readonly string[]): string[] {
  const issues: string[] = [];
  apiKeyEnvs.forEach((name, index) => {
    if (!modelApiKeyEnvSchema.safeParse(name).success) issues.push(`MODEL_API_KEY_ENV_ALLOWLIST 第 ${index + 1} 项不是合法的环境变量名`);
  });
  internalOrigins.forEach((origin, index) => {
    const issue = modelInternalOriginIssue(origin);
    if (issue) issues.push(`MODEL_INTERNAL_BASE_URL_ORIGINS 第 ${index + 1} 项${issue}`);
  });
  return issues;
}

/** 返回地址不合规的原因；合规时返回 null。HTTPS 默认放行，HTTP 仅放行部署显式允许的来源。 */
export function modelBaseUrlIssue(value: string, policy: { internalOrigins: readonly string[] }): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return '模型地址必须是绝对 URL';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '模型地址只允许 HTTP(S)';
  if (url.username || url.password) return '模型地址不能包含内嵌凭据';
  if (url.search) return '模型地址不能包含查询参数';
  if (url.hash) return '模型地址不能包含片段';
  if (url.protocol === 'https:') return null;
  if (isLocalModelHost(url.hostname)) return null;
  const allowed = policy.internalOrigins.some(origin => originOf(origin) === url.origin);
  return allowed ? null : '非 HTTPS 模型地址只允许本机或局域网地址（localhost、127.0.0.0/8、10/8、172.16/12、192.168/16、::1），其它来源需在 MODEL_INTERNAL_BASE_URL_ORIGINS 显式允许';
}

/**
 * 本机或局域网地址的字面量判断：HTTP 连到这些地址时不要求部署显式允许（本机模型网关、局域网推理服务）。
 * 只认字面量，不做 DNS 解析——域名（哪怕解析到内网）仍要进 MODEL_INTERNAL_BASE_URL_ORIGINS；
 * 169.254/16 也不算，避免把云元数据地址当成本机放行。
 */
export function isLocalModelHost(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  if (name === '::1' || name.startsWith('fe80:') || /^f[cd][0-9a-f]{2}:/.test(name)) return true;
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
  if (!octets) return false;
  const first = Number(octets[1]);
  const second = Number(octets[2]);
  if (first === 127 || first === 10) return true;
  if (first === 192 && second === 168) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  return false;
}

/** 校验完整候选配置：必需别名、引用完整性、密钥引用与地址规则。 */
export function modelConfigIssues(
  providers: readonly ModelProviderInput[],
  aliases: readonly ModelAliasInput[],
  policy: ModelConfigPolicy,
): string[] {
  const issues: string[] = [];
  const providerIds = new Set<string>();
  for (const provider of providers) {
    if (providerIds.has(provider.id)) issues.push(`提供商标识重复：${provider.id}`);
    providerIds.add(provider.id);
    const urlIssue = modelBaseUrlIssue(provider.baseUrl, policy);
    if (urlIssue) issues.push(`提供商 ${provider.id} 的地址不合法：${urlIssue}`);
    if (provider.apiKeySource === 'env' && !isAllowedModelApiKeyEnv(provider.apiKeyEnv, policy.allowedApiKeyEnvs)) {
      issues.push(`提供商 ${provider.id} 引用了未允许的环境变量 ${provider.apiKeyEnv}`);
    }
    const optionsIssue = providerOptionsIssue(provider.apiFormat, provider.options);
    if (optionsIssue) issues.push(`提供商 ${provider.id}：${optionsIssue}`);
  }
  const providersById = new Map(providers.map(provider => [provider.id, provider]));
  const aliasNames = new Set<string>();
  for (const alias of aliases) {
    if (aliasNames.has(alias.alias)) issues.push(`别名重复：${alias.alias}`);
    aliasNames.add(alias.alias);
    const provider = providersById.get(alias.providerId);
    if (!provider) issues.push(`别名 ${alias.alias} 指向不存在的提供商 ${alias.providerId}`);
    else if (alias.enabled && !provider.enabled) issues.push(`启用中的别名 ${alias.alias} 不能指向已禁用的提供商 ${alias.providerId}`);
  }
  for (const required of requiredModelAliases) {
    const alias = aliases.find(candidate => candidate.alias === required);
    if (!alias) {
      issues.push(`缺少必需别名 ${required}`);
      continue;
    }
    if (!alias.enabled) issues.push(`必需别名 ${required} 不能禁用`);
    const provider = providersById.get(alias.providerId);
    if (provider && !provider.enabled) issues.push(`必需别名 ${required} 不能指向已禁用的提供商 ${alias.providerId}`);
    if (!requiredCapabilities[required](alias.capabilities)) issues.push(`必需别名 ${required} 声明的能力不满足业务要求`);
  }
  return issues;
}

const providerViewFields = {
  ...providerFields,
  createTime: z.string(),
  updateTime: z.string(),
  apiKeyConfigured: z.boolean(),
};

/** 管理端响应校验：只暴露密钥来源与是否已配置，不含明文、密文或密文长度。 */
export const modelProviderViewSchema = z.discriminatedUnion('apiKeySource', [
  z.strictObject({ ...providerViewFields, apiKeySource: z.literal('env'), apiKeyEnv: modelApiKeyEnvSchema }),
  z.strictObject({ ...providerViewFields, apiKeySource: z.literal('inline') }),
]);

export type ModelProviderView = z.infer<typeof modelProviderViewSchema>;

/** 由存储口径构造视图；直接输入的密钥只保留来源与「已配置」布尔值。 */
export function toModelProviderView(provider: ModelProvider, apiKeyConfigured: boolean): ModelProviderView {
  const common = {
    id: provider.id,
    displayName: provider.displayName,
    apiFormat: provider.apiFormat,
    baseUrl: provider.baseUrl,
    options: provider.options,
    headers: provider.headers ?? {},
    enabled: provider.enabled,
    createTime: provider.createTime,
    updateTime: provider.updateTime,
    apiKeyConfigured,
  };
  return provider.apiKeySource === 'env'
    ? { ...common, apiKeySource: 'env', apiKeyEnv: provider.apiKeyEnv }
    : { ...common, apiKeySource: 'inline' };
}

export const modelAliasViewSchema = modelAliasInputSchema.extend({
  createTime: z.string(),
  updateTime: z.string(),
});

/** 管理端可选的 API 格式及其选项键，界面不硬编码这些名单。 */
export const modelProviderFormatViewSchema = z.strictObject({
  value: z.enum(providerApiFormats),
  label: z.string(),
  optionKeys: z.array(z.enum(modelProviderOptionKeys)),
});
export type ModelProviderFormatView = z.infer<typeof modelProviderFormatViewSchema>;

export const modelProviderFormatViews: readonly ModelProviderFormatView[] = providerApiFormats.map(value => ({
  value,
  label: providerApiFormatLabels[value],
  optionKeys: [...providerOptionKeysByFormat[value]],
}));

/** 处理本次请求的实例自己的模型缓存状态，不代表其他实例。 */
export type ModelInstanceStatus = {
  revision: string | null;
  refreshEpoch: string | null;
  source: 'database' | 'environment' | null;
  degraded: boolean;
  readAt: number | null;
  loadedAt: number | null;
  lastError: string | null;
};

/** POST `/api/model/admin/config` 的响应：DB 配置 + 本实例状态 + UI 可选名单。 */
export type ModelAdminConfig = {
  revision: string;
  refreshEpoch: string;
  initialized: boolean;
  providers: ModelProviderView[];
  aliases: ModelAlias[];
  requiredAliases: readonly RequiredModelAlias[];
  providerFormats: readonly ModelProviderFormatView[];
  allowedApiKeyEnvs: readonly string[];
  instance: ModelInstanceStatus;
};

export const modelAdminConfigSchema = z.strictObject({});

/** 处理本次请求的实例自己的模型缓存状态，不代表其他实例。 */
export const modelInstanceStatusSchema = z.strictObject({
  revision: decimalVersionSchema.nullable(),
  refreshEpoch: decimalVersionSchema.nullable(),
  source: z.enum(['database', 'environment']).nullable(),
  degraded: z.boolean(),
  readAt: z.number().nullable(),
  loadedAt: z.number().nullable(),
  lastError: z.string().nullable(),
});

/** POST `/api/model/admin/config` 的响应：DB 配置 + 本实例状态 + UI 可选名单。 */
export const modelAdminConfigViewSchema = z.strictObject({
  revision: decimalVersionSchema,
  refreshEpoch: decimalVersionSchema,
  initialized: z.boolean(),
  providers: z.array(modelProviderViewSchema),
  aliases: z.array(modelAliasViewSchema),
  requiredAliases: z.array(z.enum(requiredModelAliases)),
  providerFormats: z.array(modelProviderFormatViewSchema),
  allowedApiKeyEnvs: z.array(z.string()),
  instance: modelInstanceStatusSchema,
});
export type ModelAdminConfigView = z.infer<typeof modelAdminConfigViewSchema>;

/** 写操作响应：写入后的配置版本。 */
export const modelConfigVersionSchema = z.strictObject({
  revision: decimalVersionSchema,
  refreshEpoch: decimalVersionSchema,
});

export const modelProviderUpsertSchema = z.strictObject({
  provider: modelProviderWriteSchema,
  expectedRevision: decimalVersionSchema,
  applyImmediately: z.boolean().optional(),
});
export type ModelProviderUpsertPayload = z.infer<typeof modelProviderUpsertSchema>;

export const modelAliasUpsertSchema = z.strictObject({
  alias: modelAliasInputSchema,
  expectedRevision: decimalVersionSchema,
  applyImmediately: z.boolean().optional(),
});
export type ModelAliasUpsertPayload = z.infer<typeof modelAliasUpsertSchema>;

export const modelProviderDeleteSchema = z.strictObject({
  id: modelProviderIdSchema,
  expectedRevision: decimalVersionSchema,
});
export type ModelProviderDeletePayload = z.infer<typeof modelProviderDeleteSchema>;

export const modelAliasDeleteSchema = z.strictObject({
  alias: modelAliasNameSchema,
  expectedRevision: decimalVersionSchema,
});
export type ModelAliasDeletePayload = z.infer<typeof modelAliasDeleteSchema>;

export const modelConfigApplySchema = z.strictObject({
  expectedRevision: decimalVersionSchema,
});
export type ModelConfigApplyPayload = z.infer<typeof modelConfigApplySchema>;

/** POST `/api/model/admin/provider/models` 的请求：与保存提供商同一份写入口径，密钥留空表示沿用已保存的密钥。 */
export const modelProviderProbeSchema = z.strictObject({ provider: modelProviderWriteSchema });
export type ModelProviderProbePayload = z.infer<typeof modelProviderProbeSchema>;

/** 上游模型下拉的条数上限：服务端按它截断，界面按它提示列表可能被截断。 */
export const providerModelListLimit = 1000;

/** 上游可用模型的下拉选项：id 用于提交，label 用于展示。 */
export const providerModelSchema = z.strictObject({ id: z.string().min(1), label: z.string().min(1) });
export const providerModelsViewSchema = z.strictObject({ models: z.array(providerModelSchema) });
export type ProviderModelsView = z.infer<typeof providerModelsViewSchema>;
