# CC Switch 自定义兼容性配置调研（只读）

- 调研日期：2026-10-13
- CC Switch 版本：`d9a62313c8a276216ed40245c638753606831e95`（2026-10-13 10:36:31 +0800，`fix(ui): panel flicker (#8201)`），浅克隆到 `/tmp/cc-switch`
- OpenCode Go 官方文档：https://opencode.ai/v2/docs/console/go/
- 结论：CC Switch 的「自定义兼容性」由**三套独立机制**组成，分别服务不同链路；本项目是服务端直连上游，只需要其中「自定义请求头」这一套，用 AI SDK 原生 `headers` 即可，不需要本地代理覆盖机制。

## 1. 截图对应哪个 UI

截图里的两个区块都在 **Pi 供应商表单** `src/components/providers/forms/PiProviderForm.tsx:1564-1577`。截图本身只能证明 Pi 表单用 `compat`，不能据此推断 OpenCode 的机制；OpenCode 侧的 `options.headers` 是另一处代码证据（见 3a）：

| 截图区块 | 组件 | i18n key | 默认文案 |
| --- | --- | --- | --- |
| 请求头 | `RequestHeadersEditor` | `opencode.headersHint` | 随供应商请求发送的可选 HTTP 请求头，如 HTTP-Referer 或 X-Title。 |
| 接口兼容性 | `StructuredOptionsEditor` | `pi.form.compatibility` / `pi.form.compatibilityHint` | 接口兼容性 / 调整兼容端点或本地服务的请求行为。 |

- `RequestHeadersEditor`（`src/components/providers/forms/RequestHeadersEditor.tsx`）：key/value 行编辑器，key 占位符 `X-Title`，value 占位符 `CC Switch`，支持增删改、重名检测（大小写不敏感）。
- `StructuredOptionsEditor`（`src/components/providers/forms/StructuredOptionsEditor.tsx`）：任意 key/value 选项，value 按 JSON 解析（`parseOptionValue`：能 JSON.parse 就转成 number/bool/object，否则当字符串），key 占位符 `supportsDeveloperRole`，value 占位符 `false`。
- 两者是**独立机制**：请求头进 `headers`，接口兼容性进 `compat`（透传给 SDK 的任意选项）。

## 2. 数据模型（`src/types.ts`）

```ts
// OpenCode 供应商选项（types.ts:858-864）
export interface OpenCodeProviderOptions {
  baseURL?: string;
  apiKey?: string;
  headers?: Record<string, string>;   // 自定义请求头
  [key: string]: unknown;             // 额外选项（timeout、setCacheKey 等）
}

// OpenClaw 供应商配置（types.ts:942）
headers?: Record<string, string>;     // 自定义请求头（如 User-Agent）

// ProviderMeta（types.ts:170-173, 231, 940 附近）
export interface LocalProxyRequestOverrides {
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
}
// ...
customUserAgent?: string;             // Custom User-Agent for local proxy routing. Only applied by the local proxy.
localProxyRequestOverrides?: LocalProxyRequestOverrides;  // Only applied by the local proxy after route transforms.
```

## 3. 请求生效链路

### 3a. OpenCode / Pi 直连（additive app）

表单 → `settingsConfig`（`OpenCodeProviderConfig`）→ `options.headers` 与 `options` 里的额外键。

- `normalizeRequestHeaders`（`src/components/providers/forms/helpers/requestHeaders.ts:3-14`）：只 trim key、去掉 draft 前缀，**不**过滤受保护头。
- 这些 headers 由 AI SDK provider 直接发给上游。

### 3b. 本地代理的自定义 User-Agent（Claude / Codex / Gemini 等）

链路：`ProviderMeta.customUserAgent` → `parse_custom_user_agent`（`src-tauri/src/provider.rs:647`）→ `meta.custom_user_agent_header()` → `forwarder.rs:2267-2282`。

生效点：

- `forwarder.rs:2531-2540`：遍历原始 headers 时，若存在 `user-agent` 且 `custom_user_agent` 非空 → 替换为自定义 UA（`saw_user_agent` 去重，只替换第一个）。
- `forwarder.rs:2606-2612`：若原始请求没有 UA → 追加 `custom_user_agent` 或 `opencode_fallback_user_agent`。

优先级：**显式自定义 UA** 会替换客户端已有的 `user-agent`；**OpenCode 回退 UA** 只在客户端原始请求没有 UA 时才追加（`forwarder.rs:2606-2612`），因此回退 UA 不高于客户端原始 UA，两者不会同时生效。

- OpenCode 回退 UA（`forwarder.rs:2327-2334`）：`cc-switch/<CARGO_PKG_VERSION>`，仅当 `custom_user_agent.is_none() && is_opencode_upstream(host)`（host 是 `opencode.ai` 或 `*.opencode.ai`）**且原始请求没有 UA**。
- Copilot 指纹 UA 不可覆盖（`is_copilot` 时 `custom_user_agent = None`）。
- 校验：`parse_custom_user_agent` 用 `http::HeaderValue::from_str`，只拒绝控制字符（除 `\t` 外的 0x00–0x1F 与 0x7F）；非法值三条运行时路径都静默忽略，前端给非阻断红字提示（`src/lib/userAgent.ts`）。
- 预设（`src/config/userAgentPresets.ts`）：`claude-cli/2.1.161 (external, cli)`、`claude-cli/2.1.161`、`claude-code/1.0.0`、`claude-code/0.1.0`、`Kilo-Code/1.0`。

### 3c. 本地代理请求覆盖（`localProxyRequestOverrides`）

UI：`LocalProxyRequestOverridesField.tsx`——「本地代理请求覆盖」，两个 JSON textarea：Header 覆盖 / Body 覆盖。

校验（`src/lib/requestOverrides.ts`）：

- header name 必须匹配 RFC 9110 token（`isValidHttpHeaderName`：`/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/`）。
- header value 不能含控制字符（`isValidHttpHeaderValue`）。
- **受保护头黑名单** `PROTECTED_LOCAL_PROXY_HEADER_NAMES`（40+ 个）：`host`、`content-length`、`transfer-encoding`、`connection`、`proxy-authorization`、`proxy-authenticate`、`te`、`trailer`、`upgrade`、`accept-encoding`、`content-type`、`authorization`、`x-api-key`、`x-goog-api-key`、`chatgpt-account-id`、`session_id`、`x-client-request-id`、`x-codex-window-id`、`x-forwarded-host`、`x-forwarded-port`、`x-forwarded-proto`、`forwarded`、`cf-*`、`true-client-ip`、`fastly-client-ip`、`x-azure-*`、`akamai-origin-hop`、`x-request-id`、`x-correlation-id`、`x-trace-id`、`x-amzn-trace-id`、`x-b3-*`、`traceparent`、`tracestate` 等。
- body 覆盖禁止 `stream` 字段（`parseBodyOverrideJson`）。

生效点：

- body：`forwarder.rs:2050-2058` → `apply_local_proxy_body_overrides`（`:4253`）→ `merge_json_override` 递归合并（顶层 `stream` 跳过）。
- headers：`forwarder.rs:2664-2671` → `apply_local_proxy_header_overrides`（`:4307`）→ `headers.insert(name, value)`（**覆盖**同名头），跳过受保护头与非法值。
- 时机：在路由转换**之后**、出站定稿之前。

## 4. OpenCode Go 的官方要求（关键）

官方文档 https://opencode.ai/v2/docs/console/go/ 明确：

1. **User-Agent**：「Identify itself with its own user agent, such as `my-coding-agent/1.0`, rather than a generic SDK or HTTP-library name.」——要求的是**自定义 UA 能力**，不是某个固定值。
2. **Session ID**：「Send a stable session ID in `x-opencode-session` for each conversation」——要求每个对话发送稳定的会话 ID。

以下错误码**不是官方文档实证**，只是 CC Switch 源码注释里的说法，需与上面的官方要求分开看：缺 `x-opencode-session` → `400 MissingSessionID`、缺 UA → Cloudflare `403 Access denied`（`forwarder.rs:2321-2328` 注释）。本项目未实测这些响应。

CC Switch 的应对：自动补 `cc-switch/<version>` 作为回退 UA，或让用户在表单里配自定义 UA。

**结论**：用户所说「OpenCode Go 官方说需要带上 user-agent」= 需要能配置自定义 User-Agent（或至少让客户端自动补一个）。官方文档**没有**规定具体 UA 值。

## 5. 本项目集成映射

现有相关文件（路径前缀 `refactor-ts-agent/`）：

- `src/shared/model-config.ts`：`ModelProviderWriteInput`（`apiKeySource`/`apiKeyEnv`/`apiKeyCiphertext`/`baseUrl`/`apiFormat`/`options`）、`providerOptionFlags`（`includeUsage`/`supportsStructuredOutputs`/`supportsMultiPartToolContent`/`thinkingSwitch`）。
- `src/server/models/adapters.ts`：按 `apiFormat` 分派到 AI SDK provider；`options` 传给 provider。
- `src/server/models/probe.ts`：`GET /models`。
- `src/server/models/store.ts` / `registry.ts`：配置读写与缓存。
- `src/components/model-manager.tsx`：提供商弹窗（API 格式、密钥来源、选项白名单、测试连接、获取模型）。

AI SDK 原生能力（本项目已依赖）：

- `@ai-sdk/openai-compatible` 的 `createOpenAICompatible({ baseUrl, apiKey, headers })`——`headers` 合并进每个请求。
- `@ai-sdk/openai` / `@ai-sdk/anthropic` 同样支持 `headers`。
- `providerOptions` 可传格式特定选项。
- 自定义 `fetch` 可完全控制请求。

**本项目不需要** CC Switch 的本地代理覆盖机制（那是给「客户端 → CC Switch 代理 → 上游」用的）。本项目是服务端直连上游，直接用 AI SDK 的 `headers` 即可。

### 建议最小范围

1. `ModelProviderWriteInput` 增加 `headers?: Record<string, string>`（自定义请求头，如 User-Agent）。
2. `adapters.ts` 把 `headers` 传给各 AI SDK provider 的 `headers` 选项。
3. `probe.ts` 的 `GET /models` 带上同一份 `headers`（保持一致）。
4. UI：提供商弹窗加「请求头」编辑器（key/value 行，参考 `RequestHeadersEditor`）。
5. 校验：header name 用 RFC 9110 token；value 不含控制字符；可选地警告受保护头（`authorization`、`host` 等）。
6. 可选：`localProxyRequestOverrides` 式的 body 覆盖——本项目暂不需要（AI SDK 的 `providerOptions` 已能传格式特定选项）。

## 6. 已合并 vs 未合并

- `customUserAgent`、`localProxyRequestOverrides`、`RequestHeadersEditor`、`StructuredOptionsEditor` 都存在于固定的当前提交（`d9a6231`）——这是直接读代码得到的结论，仅说明它们在该快照里存在，未核对其 PR/合并历史。
- 早期 web 搜索到的 issue #6357 / PR #2287（Claude Desktop 自定义上游请求头）是同类需求的其他方案；本次没有找到它们被合并进 `d9a6231` 的证据，不能宣称「已并入 `localProxyRequestOverrides`」。
- OpenClaw User-Agent toggle（commit `cc15d7b`）是 OpenClaw 专属，与本项目无关。

## 7. 缺口

- OpenCode Go 官方文档没有给出具体 UA 值要求（只说 `such as my-coding-agent/1.0`），「官方要求带 User-Agent」的**具体值**无法从官方文档确认。
- 用户截图里的「接口兼容性」是 **Pi 表单**的 `compat` 字段（任意 key/value 透传给 SDK），与「请求头」是两个独立机制，不要混为一谈。
