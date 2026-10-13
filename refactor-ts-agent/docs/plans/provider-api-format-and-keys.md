# 提供商「API 格式」与密钥两种来源

依据：用户 2026-10-12 反馈（截图 `/tmp/pi-clipboard-3afdbb14-....png`，编辑提供商弹窗）

> 「不是适配器，是 api 格式，应该要支持选择多种 api 格式，如 openai-response、anthropic...，密钥要支持环境变量和直接输入密钥的方式，反正放到数据库还可以做加密，没事的。」

目标：把当前唯一可用的 `adapter = openai-compatible` 改成可选多种 **API 格式**，并让密钥既支持 **环境变量引用**（现状）也支持 **直接输入**（密文入库）。

## 现状（已实现，步骤 1–6 的成果）

- 表 `ts_model_provider`（`refactor-ts-agent/migrations/006_model_registry.sql`）：`adapter VARCHAR(64) NOT NULL`、`apiKeyEnv VARCHAR(128) NOT NULL`、`baseUrl`、`options JSON`、`enabled`。
- `refactor-ts-agent/src/shared/model-config.ts:8` `providerAdapters = ['openai-compatible']`；`:53` `adapter`、`:55` `apiKeyEnv` 必填；`:201` 视图里有 `apiKeyConfigured`。
- `refactor-ts-agent/src/server/models/adapters.ts:36` `resolveModelApiKey()` 只认环境变量名（受 `MODEL_API_KEY_ENV_ALLOWLIST` 白名单约束）；`:58` `buildLanguageModel()` 无条件用 `createOpenAICompatible(...).chatModel()`。
- 管理端 `refactor-ts-agent/src/components/model-manager.tsx:573`「适配器」Select（只一个值）、`:590`「密钥引用」Select（只能选环境变量名）。
- 只有 `@ai-sdk/openai-compatible`（3.0.65）被安装；`@ai-sdk/openai`、`@ai-sdk/anthropic` 未安装。

## 设计

### 1. `adapter` → `apiFormat`（API 格式）

三种格式（第一版）：

| 值 | 界面标签 | 协议 | 使用的 SDK 包 |
| --- | --- | --- | --- |
| `openai-chat` | OpenAI Chat Completions | `POST {baseUrl}/chat/completions` | `@ai-sdk/openai-compatible`（已有） |
| `openai-responses` | OpenAI Responses API | `POST {baseUrl}/responses` | `@ai-sdk/openai`（新增依赖） |
| `anthropic-messages` | Anthropic Messages API | `POST {baseUrl}/messages`（`x-api-key`） | `@ai-sdk/anthropic`（新增依赖） |

- 旧值 `openai-compatible` 在迁移里映射为 `openai-chat`；遇到未知旧值直接让迁移失败（不静默改写）。
- 协议选项（`options`）按格式白名单化：`providerOptionKeysByFormat: Record<ProviderApiFormat, readonly ModelProviderOptionKey[]>`。
  - `openai-chat`：`includeUsage`、`supportsStructuredOutputs`、`supportsMultiPartToolContent`（与现状一致）。
  - `openai-responses` / `anthropic-messages`：只保留安装后从 `*.d.ts` **核实存在**的选项；没有对应语义的开关在界面上隐藏，保存时按所选格式白名单严格校验（`strictObject`），格式切换后残留的选项键 → 400 并提示。
- `buildLanguageModel()` 按 `apiFormat` 分发构造模型（`createOpenAI({name,baseURL,apiKey}).responses(modelName)`、`createAnthropic({name,baseURL,apiKey}).languageModel(modelName)`），仍然 `wrapLanguageModel` + `defaultSettingsMiddleware` + `Object.freeze`，别名绑定语义不变。

### 2. 密钥两种来源

- 数据模型：`apiKeyEnv VARCHAR(128) NULL` + 新增 `apiKeyCiphertext VARCHAR(2048) NULL`，**恰好一个非空**（应用层校验；不依赖 MySQL CHECK 以便兼容旧版本）。
- 写入契约 `apiKeySource: 'env' | 'inline'`：
  - `env`：沿用 `apiKeyEnv` + `MODEL_API_KEY_ENV_ALLOWLIST` 白名单，行为不变。
  - `inline`：请求体带明文 `apiKey`，服务端加密后写入 `apiKeyCiphertext`；读取视图**只**回 `apiKeySource`、`apiKeyConfigured`，绝不回明文，也不回密文。
- 加密：`src/server/models/secrets.ts`，AES-256-GCM，密文格式 `v1:<iv>:<tag>:<ciphertext>`（base64url）。
  - 主密钥优先取环境变量 `MODEL_SECRET_KEY`（hex/base64/≥32 字节原文派生 32 字节）；未设置时自动生成并保存 `runtime/model-secret.key`（0600）作为本地兜底。
  - 解密失败 → `ModelConfigInvalidError` → 503，错误信息只说明「密钥无法解密，请重新保存」，不泄漏任何密文/明文。
- 编辑语义：编辑弹窗里 `inline` 密钥留空 = 保持原密钥；从 `inline` 切回 `env` 会删除密文。

### 3. 迁移 `007_provider_api_format.sql`

```sql
ALTER TABLE ts_model_provider CHANGE COLUMN adapter apiFormat VARCHAR(64) NOT NULL;
UPDATE ts_model_provider SET apiFormat = 'openai-chat' WHERE apiFormat = 'openai-compatible';
ALTER TABLE ts_model_provider MODIFY COLUMN apiKeyEnv VARCHAR(128) NULL;
ALTER TABLE ts_model_provider ADD COLUMN apiKeyCiphertext VARCHAR(2048) NULL;
```

同步 `refactor-ts-agent/src/server/schema.ts` 的 `modelProviders` 列定义。

### 4. 管理端 UI（`refactor-ts-agent/src/components/model-manager.tsx`）

- 「适配器」Select → 「API 格式」Select（三项，标签用中文 + 协议名，选项来自 `/api/model/admin/config` 返回的格式清单，不在前端硬编码）。
- 新增「密钥来源」Radio.Group：`环境变量`（原 Select）/ `直接输入`（`Input.Password`，编辑态占位「已保存，留空不修改」）。
- 列表列「适配器」→「API 格式」；密钥列显示 `环境变量 AI_API_KEY` 或 `直接输入（已加密）`。

### 5. 文档

- `.env.example`：新增 `MODEL_SECRET_KEY=`（说明：生产建议显式设置并备份，否则只能靠 `runtime/model-secret.key` 解密已保存的密钥）。
- `refactor-ts-agent/README.md`「模型统一管理」段：API 格式与选项矩阵、两种密钥来源、加密与轮换。
- `refactor-ts-agent/docs/implementation-contract.md`：提供商写入契约（`apiKeySource`、格式枚举、视图不回显密钥）。

## 实施清单

- [x] 安装依赖：`npm install @ai-sdk/openai@4.0.91 @ai-sdk/anthropic@4.0.78`（已验证 peer 仅要求 `zod`，与现有 `zod 4.6.5` 兼容）。
- [x] 读两个包的 `dist/index.d.ts`，核实 `.responses()` / Messages 入口、settings 字段名与可用的协议选项，据此写死选项映射（不猜）。
- [x] `migrations/007_provider_api_format.sql` + `src/server/schema.ts`。
- [x] `src/shared/model-config.ts`：`providerApiFormats`+标签、写入/内部/视图三套 schema、按格式的选项白名单、`apiKeySource` 校验。
- [x] `src/server/models/secrets.ts`（加解密 + 主密钥解析），`adapters.ts` 改用 `resolveModelApiKey` 支持两种来源 + 按格式构造模型。
- [x] `src/server/models/store.ts`（行↔字段映射、upsert 写密文、校验）、`admin.ts`（视图映射不回显）、`config.ts`（`MODEL_SECRET_KEY`）。
- [x] `src/components/model-manager.tsx`：API 格式、密钥来源、选项联动。
- [x] 测试：`tests/models/secrets.test.ts`（新增）、`tests/models/adapters.test.ts`（三格式请求形状：`/chat/completions`、`/responses`、`/messages` + `x-api-key`）、`tests/model-config.test.ts`（格式/选项/密钥来源校验）、`tests/integration/model-admin.test.ts`（inline 往返、DB 只有密文、视图不回显、格式切换 400）、`tests/e2e/model-manage.spec.ts`（直接输入密钥后 DB 无明文）。
- [x] 文档四项（见上）。

## 验证步骤

1. `npm run db:test:setup`（测试库应用 007）。
2. `npm run type-check`。
3. `npx vitest run tests/models tests/model-config.test.ts tests/integration/model-admin.test.ts tests/integration/model-store.test.ts`。
4. `npm test` 全量。
5. `E2E_APP_PORT=<空闲> E2E_PREVIEW_PORT=<空闲> npm run test:e2e:isolated -- tests/e2e/model-manage.spec.ts`。
6. `npm run build`。
7. `git diff --check`。

## 风险与未决

- **需要新增 2 个依赖**（`@ai-sdk/openai`、`@ai-sdk/anthropic`，均为官方包）；需联网 `npm install`。
- **开发库需要 `npm run db:migrate`**（与 006 时一样，纯新增/改名，不删数据）；测试库由 `db:test:setup` 自动应用。
- **真实上游兼容性无法验证**：本机没有 Anthropic/OpenAI 凭证，只能用本地假端点验证请求形状（路径、鉴权头、请求体、别名 settings 落点），「真机能通」仍属未验证。
- **主密钥兜底**：未设置 `MODEL_SECRET_KEY` 时用 `runtime/model-secret.key`；该文件丢失则已保存的直接密钥不可解密（报错明确、需重新输入）。
- **格式切换的选项残留**：保存时会因格式白名单而 400；界面在切换时清空不兼容选项。

## 需要用户确认

1. 三种 API 格式（openai-chat / openai-responses / anthropic-messages）是否够？要不要再加 `google-gemini`？
2. 是否同意新增上述两个依赖（需要联网安装）？
3. 主密钥用环境变量 `MODEL_SECRET_KEY`、未设置时自动生成 `runtime/model-secret.key` 兜底，是否接受？
