# 模型别名与动态配置

状态：已实现（步骤 1–5 已合入 `refactor-ts-agent/`，本文件描述当前行为）。范围为 `refactor-ts-agent/`。

用户已确定：配置保存在 DB；提供管理端编辑界面；默认缓存 TTL 为 5 秒，并支持手动立即生效。沿用 AI SDK，在应用内统一解析模型，不增加独立模型网关服务。

## 当前实现与部署

已落地的组件与行为：

- `migrations/006_model_registry.sql` 创建 `ts_model_provider`、`ts_model_alias`、`ts_model_config_state` 三张表，并插入固定状态行 `models`（`revision=0`、`refreshEpoch=0`）。迁移只建表与状态行，不读取密钥、不写死上游模型名。`migrations/007_provider_api_format.sql` 把 `adapter` 改名为 `apiFormat`（旧值 `openai-compatible` 映射为 `openai-chat`，未知值会让迁移失败而不静默改写）、允许 `apiKeyEnv` 为空并新增 `apiKeyCiphertext`，`migrations/008_provider_headers.sql` 新增自定义请求头列 `headers`（JSON）。三者都通过 `npm run db:migrate` 执行。
- 迁移后执行一次 `npm run db:init-models`。该命令幂等：仅当配置仍为初始空态（提供商与别名均为空、`revision=0`、`refreshEpoch=0`）时，从现有 `AI_BASE_URL` / `AI_MODEL` / `AI_API_KEY` 建立一个提供商与两个别名；已有配置不会被覆盖。
- 表已迁移且为空时，解析会临时用环境变量构造两个别名以兼容升级。此回退要求迁移后的表可读且为空；读取失败不等于为空，不会回退到环境变量。一旦 DB 初始化成功（存在配置行或版本非零），DB 即成为唯一来源。
- 解析路径：`src/server/models/registry.ts` 提供 `resolveBinding` / `resolveModel`；`src/server/model.ts` 的 `modelFor` 解析 `codegen.default`，`routeCodeGenType` 解析 `route.classify`。`src/server/agent.ts` 在任务开始时解析一次并把绑定冻结到整个工具循环，在途任务不受后续配置变更影响。
- 管理接口：`src/server/models/admin.ts` 与 `src/app/api/[...path]/route.ts` 暴露 `/api/model/admin/*`；管理页面为 `/admin/modelManage`。页面“保存成功”只代表服务端本地 schema、密钥引用与业务能力校验通过，不代表上游密钥或模型可用；连通性探测只在管理员点击「测试连接」/「获取模型」时发起（见下文）。

环境变量：

- 密钥来源二选一：`apiKeySource='env'` 时 DB 只存引用名（`apiKeyEnv`），允许引用的名单默认为 `AI_API_KEY`，其余通过 `MODEL_API_KEY_ENV_ALLOWLIST`（逗号分隔）显式加入；`apiKeySource='inline'` 时明文不入库，服务端用 AES-256-GCM 加密后只存 `apiKeyCiphertext`（`v1:<iv>:<tag>:<ciphertext>`），主密钥来自 `MODEL_SECRET_KEY`（64 位十六进制、32 字节 base64 或任意口令，scrypt 派生），未设置时自动生成 `runtime/model-secret.key`（0600）。管理接口只返回 `apiKeySource` 与是否已配置，不回显明文或密文。自定义请求头是普通配置（明文入库），不要放密钥；密钥始终用专用密钥字段。
- 地址只允许无内嵌凭据、无查询、无片段的 HTTP(S)。`http:` 对**本机与局域网字面量**（`localhost`/`*.localhost`、`127.0.0.0/8`、`10/8`、`172.16/12`、`192.168/16`、`::1`、IPv6 链路本地 `fe80::/10` 与 ULA `fc00::/7`）直接放行——自建网关常见形态 `http://127.0.0.1:8787/v1` 不需要额外配置；判定只看字面量、不做 DNS 解析，也**不含** `169.254/16`（避免把云元数据地址当本机）。其余 `http:` origin 需写进 `MODEL_INTERNAL_BASE_URL_ORIGINS`（逗号分隔）；`https:` 不受该名单限制。
- 管理端可以在已部署的密钥引用之间热切换，无需重启。**轮换某个环境变量的值**（例如替换 `AI_API_KEY` 的密钥）需要更新进程环境并重启进程；DB 配置变更本身不要求重启。

## 现状与目标

当前 `src/server/model.ts` 从 `getConfig()` 读取 `AI_BASE_URL`、`AI_API_KEY`、`AI_MODEL`，每次创建 OpenAI-compatible 模型。代码生成与生成类型分类使用同一套配置。具体模型名已在环境变量中，但缺少独立业务别名、多提供商配置和运行时编辑入口。

`src/server/agent.ts` 在创建 `ToolLoopAgent` 前解析一次模型，后续工具循环继续使用该对象。保持这个生命周期：配置变化影响后续解析，不替换已经开始的任务所持有的模型和参数。

已安装 `ai@7.0.130`、`@ai-sdk/openai-compatible@3.0.65`、`@ai-sdk/openai@4.0.91`、`@ai-sdk/anthropic@4.0.78`、Drizzle、mysql2 和 Zod。使用 AI SDK 的 `customProvider` 将项目别名映射到 `LanguageModel`；提供商适配层按 `apiFormat` 构造具体模型（`openai-chat` → `@ai-sdk/openai-compatible`，`openai-responses` → `@ai-sdk/openai` 的 `.responses()`，`anthropic-messages` → `@ai-sdk/anthropic` 的 `.messages()`）。业务调用只接触别名及 SDK 公共类型。

第一版接通两个业务别名：

| 别名 | 用途 | 必需能力 |
| --- | --- | --- |
| `codegen.default` | 应用生成 Agent | 流式文本、工具调用 |
| `route.classify` | 判断 HTML、多文件、Vue、React 类型 | 能完成 `Output.object` 的结构化结果校验 |

同一个物理模型可以绑定多个别名。管理端可增加备用别名，但增加别名不会自动产生新业务功能。图片生成和代码评审在有对应调用链时再接入。

## DB 结构

实际迁移为 `migrations/006_model_registry.sql`（建表与状态行）、`migrations/007_provider_api_format.sql`（API 格式与密钥字段）与 `migrations/008_provider_headers.sql`（自定义请求头列）。

### `ts_model_provider`：提供商连接

| 字段 | 草案类型 | 含义 |
| --- | --- | --- |
| `id` | VARCHAR(64)，主键 | 项目内提供商标识，创建后不改名 |
| `displayName` | VARCHAR(128) | 管理端显示名称 |
| `apiFormat` | VARCHAR(64) | API 格式，取值 `openai-chat`、`openai-responses`、`anthropic-messages`；由迁移从旧的 `adapter` 列改名而来 |
| `baseUrl` | VARCHAR(2048) | API 根地址 |
| `apiKeyEnv` | VARCHAR(128)，可空 | 引用环境变量时的变量名，例如 `AI_API_KEY`；直接输入密钥时为空 |
| `apiKeyCiphertext` | VARCHAR(2048)，可空 | 直接输入密钥的密文 `v1:<iv>:<tag>:<ciphertext>`，引用环境变量时为空 |
| `options` | JSON | 有 schema 的协议兼容选项 |
| `headers` | JSON，可空 | 自定义请求头，键值均为字符串；旧记录为 NULL 时按空集合读取 |
| `enabled` | BOOLEAN | 是否可供新请求使用 |
| `createTime`、`updateTime` | DATETIME(3) | 创建与修改时间 |

密钥来源二选一，接口不回显明文或密文，只返回 `apiKeySource` 与当前实例是否配置。引用环境变量时必须来自服务端明确允许的模型密钥名单，不能引用任意环境变量；直接输入的密钥用 AES-256-GCM 加密后只存密文，主密钥来自 `MODEL_SECRET_KEY`，未设置时自动生成 `runtime/model-secret.key`（0600），该文件丢失后需要重新输入密钥。管理端可以热切换到已经部署的另一密钥来源或引用；新增或轮换环境变量中的密钥值仍需要更新进程环境。

`options` 按 API 格式白名单化：`openai-chat` 支持布尔项 `includeUsage`、`supportsStructuredOutputs`、`supportsMultiPartToolContent` 与命名项 `thinkingSwitch`（`none`/`enabled`/`disabled`，非 `none` 时用 `transformRequestBody` 在请求体追加 `thinking:{type}`，用于 DeepSeek Chat 格式的思考开关）；`openai-responses` 与 `anthropic-messages` 没有可配置的协议选项（当前 SDK 的这两个 provider 没有对应设置），提交不支持的选项会被拒绝。需要特殊请求或响应处理时，增加有测试的命名兼容配置，再由管理端选择；不在 DB 存 JavaScript 函数或任意执行脚本。新增 API 格式或适配器代码仍需要部署。

提供商可选一组自定义请求头（`headers`），存在 `ts_model_provider.headers`（JSON），与 `options` 分开。名称必须是 RFC token，大小写不敏感去重；值必须是首尾无空白的可打印/扩展 ASCII，且能编码为 ByteString（即 ByteString 范围），避免保存成功但发送时抛错；最多 32 条，名称 128、值 1024 字符。`authorization`、`proxy-authorization`、`x-api-key`、`x-goog-api-key`、`api-key`、`host`、`content-length`、`connection`、`transfer-encoding`、`te`、`trailer`、`upgrade`、`keep-alive`、`proxy-authenticate`、`cookie`、`set-cookie` 由系统生成，提交即拒绝（大小写不敏感）。适配层把这组头同时传给 `createOpenAICompatible` / `createOpenAI` / `createAnthropic`，并在 `src/server/models/adapters.ts` 的自定义 middleware 里合并到每次调用的参数头中，因为 AI SDK 会为每次调用注入带自己后缀的 `user-agent`，仅靠 provider 配置会被覆盖；生成、流式、结构化（含 `route.classify`）与探测共用同一组头。头在构造时复制并冻结进任务快照，之后修改配置不影响在途绑定。

提供商连通性探测走 `POST /api/model/admin/provider/models`：按当前填写（密钥留空时用库里已保存的密文）向上游发一次 `GET {baseUrl}/models`，并带上该提供商已保存的自定义请求头（密钥仍由密钥来源生成，自定义头不能覆盖鉴权头）；`openai-chat`/`openai-responses` 用 `Authorization: Bearer`，`anthropic-messages` 用 `x-api-key` + `anthropic-version: 2023-06-01`；解析 `{data:[{id, display_name?}]}` 并归一为 `{id, label}`，最多 1000 条（`providerModelListLimit`，命中上限时管理界面会提示可能被截断）。每次点击都会重新请求上游（`cache-control: no-cache`，不使用缓存）；10 秒超时、不跟随重定向、错误不回显密钥或自定义头值（响应片段先对两者脱敏再截断）、上游失败返回 502/50200。该探测只验证地址与密钥能列模型，不代表所选模型与格式可推理；结果只用于管理界面候选列表，不落库。

### `ts_model_alias`：项目别名映射

| 字段 | 草案类型 | 含义 |
| --- | --- | --- |
| `alias` | VARCHAR(64)，主键 | 项目别名，例如 `codegen.default` |
| `providerId` | VARCHAR(64)，外键 | 对应提供商 |
| `modelName` | VARCHAR(256) | 上游实际模型名，仅配置层使用 |
| `capabilities` | JSON | 声明的工具调用、流式输出、结构化输出能力 |
| `settings` | JSON | schema 限定的调用设置，如 temperature、maxOutputTokens |
| `enabled` | BOOLEAN | 是否可供新请求使用 |
| `createTime`、`updateTime` | DATETIME(3) | 创建与修改时间 |

能力声明用于提前检查业务配置，不代表上游一定支持。结构化输出能力需区分原生 JSON schema 与经适配验证可用的方式；不能把关闭 `supportsStructuredOutputs` 当作所有模型都支持分类的证明。

`settings` 按 SDK 的调用设置处理：通过 `defaultSettingsMiddleware` 或明确传入调用参数应用。当前版本 `.chatModel(modelId)` 只接受模型名；不能把 temperature 等当成它的第二个参数。`.languageModel(modelId, config)` 的第二个参数用于适配器配置，也不等同于通用生成参数。

`settings.reasoning`（`none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`，缺省不传）是 SDK 的统一思考参数，`defaultSettingsMiddleware` **不支持**该字段，因此适配层用自定义 `reasoningMiddleware` 注入 `params.reasoning`，各格式映射如下：

| API 格式 | SDK 发出的上游字段 | 说明 |
| --- | --- | --- |
| `openai-chat` | `reasoning_effort: <level>` | `@ai-sdk/openai-compatible` 的既有映射；DeepSeek 还可用 `thinking` 开关 |
| `openai-responses` | `reasoning: {effort: <level>}` | 必须同时打开 provider 选项 `forceReasoning`，否则 SDK 会因模型名未知而丢弃该字段 |
| `anthropic-messages` | `thinking: {type: 'enabled', budget_tokens}` | 预算按 `max_tokens` 比例换算，最低 1024 |

上游是否接受某个等级由上游决定；本项目只做枚举校验，不按厂商收窄。DeepSeek 三种格式的对照见 `README.md` 与官方文档（Responses 用 `reasoning.effort`，Chat 用 `reasoning_effort` + `thinking`，Anthropic 兼容端点用 `output_config.effort`）。
DeepSeek 的 Responses 格式把思考文本放在 `output[].content`（`type: 'reasoning_text'`）、流式事件叫 `response.reasoning_text.delta`，而 AI SDK 只解析 `response.reasoning_summary_text.delta` 与 `summary`，所以该格式的响应会先经 `src/server/models/responses-reasoning.ts` 兼容改写（SSE 只改写 `delta` 事件并把 `content_index` 映射为 `summary_index`，`.done` 事件原样透传，非流式把 `content` 复制成 `summary`）再交给 SDK；单测在 `tests/models/responses-reasoning.test.ts`。Chat 格式不需要这层改写，`reasoning_content` 由 `@ai-sdk/openai-compatible` 原生解析。

### `ts_model_config_state`：共享版本

固定一行，主键为 `models`。

| 字段 | 草案类型 | 含义 |
| --- | --- | --- |
| `id` | VARCHAR(32)，主键 | 固定为 `models` |
| `revision` | BIGINT | 每次成功写配置递增 |
| `refreshEpoch` | BIGINT | 每次手动生效递增 |
| `updateTime` | DATETIME(3) | 最近一次变更时间 |

API 中版本值以十进制字符串传输，避免 JavaScript 大整数精度丢失。

配置写入在同一事务中锁定状态行、检查 `expectedRevision`、校验修改后的完整配置、写数据并递增 `revision`。并发编辑版本冲突返回 HTTP 409，界面保留输入并提示重新加载。引用中的提供商不能硬删除，必需别名不能删除、禁用或指向已禁用的提供商。

## 生效规则

### 普通保存：5 秒 TTL

每个进程保存不可变快照，包含 `revision`、`refreshEpoch`、加载时间及组装后的别名注册表。

默认 TTL 固定为 5000 ms。缓存到期后的首次模型解析加载最新完整配置；没有请求时不定时读整表。正常 DB 可用时，一次保存后超过 5 秒才开始解析的新请求会使用最新配置。TTL 从一致读事务开始计时，而不是从加载完成计时，所以较慢的查询不会把有效期顺延；60 秒宽限期与降级判断也沿用这个起点。

采用请求触发的缓存方式，不承诺空闲实例恰好在第 5 秒完成加载。管理端列表始终直接读取 DB，显示 DB 版本与处理该请求的实例缓存版本，两者含义不同。

### 手动立即生效：共享刷新序号

不能只清当前进程缓存，否则请求被负载均衡到另一实例时仍可能继续使用旧快照。

第一版采用 MySQL 共享 `refreshEpoch`，无需新增 Redis 客户端或订阅连接：

1. 每次业务模型解析前，读取状态行的 `refreshEpoch`。缓存 TTL 只减少完整配置读取，不缓存这一轻量检查。
2. 管理员点击“立即生效”，提交当前看到的 `expectedRevision`。
3. 服务端锁状态行，检查版本，校验当前完整配置，然后在事务中递增 `refreshEpoch` 并提交。
4. 接口提交成功后返回 `{revision, refreshEpoch}`。当前实例可提前安装刚校验的快照，但这不是其他实例生效的依据。
5. 其他实例在下一次解析时发现序号变化，跳过 TTL 并等待完整快照加载后再返回模型。

“立即”的契约：手动操作成功提交之后才开始解析的新请求，在 DB 可用时使用该配置或后续更新的有效配置；不再等待 5 秒 TTL。已经读完刷新序号、正在解析或生成的请求可以继续用原快照。

这保证请求使用的版本，不保证所有空闲实例已提前更新缓存。接口不显示“所有实例已确认”，第一版不新增实例发现和确认机制。

代价是每次模型解析多一次小查询。查询发生在一次分类或生成任务开始时，不发生在每个 token 或 Agent 工具步骤上；与现有 MySQL 依赖一致。若后续吞吐证明该查询成为瓶颈，再评估 Redis 通知及丢消息后的补偿。

### 完整快照与并发加载

- 加载状态行、提供商和别名必须在同一个一致性读事务中完成，避免混用两个版本。
- 新快照全部解析、校验、构造成功后，一次替换引用；不能原地修改旧注册表。请求保留模型与设置的不可变绑定。
- 同一进程并发刷新复用一个加载 Promise；共享加载不由某个请求的取消信号中止。
- 请求读到的刷新序号为最低要求。若正在加载的结果仍低于该序号，必须继续读取，不能直接复用较旧的 Promise 结果。
- 版本只前进，慢加载不能覆盖新快照；TTL 与 60 秒宽限期都从一致读事务开始计时，而不是从加载完成计时。

### 加载失败与配置故障

区分暂时不能读取配置、配置被禁用和模型调用失败：

- 首次启动没有有效快照，加载失败时返回 HTTP 503，不凭空换模型。
- TTL 到期但 DB 暂时不可读，未观察到更高刷新序号时，可最多沿用距上次一致读开始 60 秒内的旧快照；记录降级状态，超时后拒绝新的模型调用。失败后有约 1 秒退避，只暂缓整份快照重载；共享刷新序号仍会在每次解析时探测，因此退避窗口内出现的更高 `refreshEpoch` 不会被旧绑定掩盖。降级沿用旧快照不会重置其年龄。
- 已读到更高的 `refreshEpoch`，新快照却无法加载时，本次解析返回 503，不能用旧配置声称手动生效成功。
- 正常读到的禁用操作或不满足业务能力的映射不能被旧快照掩盖；经管理 API 修改时应提前拒绝破坏必需别名的操作。
- 数据绕过 API 被直接改坏，完整快照校验失败时拒绝新的调用，并在管理状态中给出不含秘密的原因。运维 SQL 也必须遵守共享版本更新协议。
- 上游鉴权失败、模型不存在、429 或输出协议错误属于模型调用故障，沿用旧快照并不能解决。按现有调用错误处理，不自动切换到其他别名，不重放已经执行工具的生成任务。

因此运行时配置编辑不要求重启，也不主动中断在途任务；错误模型名、失效密钥和上游故障仍可能让新调用失败。`last-known-good` 只处理有界的配置读取故障。

## 管理端

新增 `/admin/modelManage`，复用当前 Ant Design、`AdminGuard` 与管理员导航约定，服务端每个接口仍独立调用 `requireAdmin`。

页面包含：

- 提供商列表与编辑弹窗：显示名称、地址、适配器、密钥引用、兼容选项、启用状态。
- 别名列表与编辑弹窗：别名、提供商、上游模型名、能力、生成参数、启用状态。
- 配置状态：DB 版本、当前实例缓存版本、是否降级及最近加载错误；不暗示掌握其他实例状态。
- “保存”提示“已保存，后续请求通常在 5 秒内使用新配置”；“立即生效”提示“后续请求将使用新配置，正在生成的任务继续”。
- 可选“保存并立即生效”：同一事务同时递增版本和刷新序号，避免两步操作中另一管理员写入。

第一版不自动发起付费连通性探测，只在管理员显式点击「测试连接」/「获取模型」时探测。保存时执行本地 schema、密钥引用和业务能力校验；真实模型的工具调用、流式与结构化质量另行验证。管理端支持引用环境变量与直接输入密钥两种来源，直接输入的明文不落库（AES-256-GCM 加密后只存密文）。

## API 草案

沿用现有 `/api` 路由分发、JSON 业务响应、会话和 POST Origin 校验。

| 方法与路径 | 功能 | 主要输入 |
| --- | --- | --- |
| POST `/api/model/admin/config` | 读取完整配置与当前实例状态 | `{}` |
| POST `/api/model/admin/provider/upsert` | 新建或修改提供商 | `{provider, expectedRevision, applyImmediately?}` |
| POST `/api/model/admin/alias/upsert` | 新建或修改别名 | `{alias, expectedRevision, applyImmediately?}` |
| POST `/api/model/admin/provider/delete` | 删除未被引用的提供商 | `{id, expectedRevision}` |
| POST `/api/model/admin/alias/delete` | 删除非必需别名 | `{alias, expectedRevision}` |
| POST `/api/model/admin/apply` | 已保存配置立即生效 | `{expectedRevision}` |

所有写操作返回最新 `{revision, refreshEpoch}`；版本冲突返回 409，校验失败返回 400，DB 不可用返回 503。具体业务错误码实施时与当前错误约定保持一致。编辑错误不能回显密钥、完整请求头或敏感上游响应。

地址只允许无内嵌凭据的 HTTP(S)，生产默认 HTTPS；内部网关按部署允许名单接入。校验拒绝 URL 查询中的密钥与认证信息，不提供任意敏感请求头编辑。适配器和兼容配置来自服务器注册名单。

## 接入与迁移

建议模块：

- `src/shared/model-config.ts`：配置 schemas、业务别名常量、管理 API 类型。
- `src/server/models/store.ts`：DB 一致性读取、写入和版本事务。
- `src/server/models/adapters.ts`：按 API 格式构造 AI SDK 提供商、兼容配置与密钥来源解析。
- `src/server/models/secrets.ts`：直接输入密钥的 AES-256-GCM 加解密与主密钥解析（`errors.ts` 放 `ModelConfigInvalidError`）。
- `src/server/models/registry.ts`：快照、TTL、刷新序号检查和别名解析。
- `src/server/models/admin.ts`：管理服务，不混入普通应用业务模块。
- `src/server/models/probe.ts`：上游 `/models` 探测（请求头按格式、超时、脱敏错误）。
- `src/components/model-manager.tsx` 与 `src/app/admin/modelManage/page.tsx`：管理界面。

`modelFor` 保留 fixture 分支及模板感知的确定性测试模型；真实生成改为解析 `codegen.default`。`routeCodeGenType` 在真实 provider 模式单独解析 `route.classify`，不再借用生成模型。

首次初始化用显式、幂等的服务端命令，从现有环境配置建立一个提供商和两个别名。SQL 迁移只创建表与状态行，不读取密钥或硬编码上游模型名。初始化只允许 registry 尚未配置时运行，不能覆盖管理员已有配置。

表尚为空时允许临时用现有 env 配置构造两个别名，以保持升级兼容，管理端明确显示“尚未初始化，正在使用环境配置”。DB 读取失败不等同于表空；有 DB 配置后以 DB 为准，不能解析失败就偷偷回退 env。

原 `AI_BASE_URL` 和 `AI_MODEL` 保留用于首次初始化与上述空表兼容，DB 初始化后不参与业务解析；`AI_API_KEY` 可继续作为已登记的密钥引用。新密钥引用的部署允许名单需在 `.env.example` 和 README 中说明。

第一版只支持当前 OpenAI-compatible 文本协议。AI SDK 把受支持的上游响应归一到公共类型，但不保证兼容任意厂商的专有协议；有具体差异时添加经过测试的适配器或兼容配置。`customProvider.fallbackProvider` 用于未匹配模型标识的解析，不能当成调用失败自动容灾。

## 验收与验证计划

实现后需要观察到以下行为，不能仅检查注册表对象结构：

1. 初始化后分类与生成使用不同项目别名，可绑定同一或不同物理模型；真实模型名只从配置层进入 SDK。
2. 使用本地受控兼容端点，确认模型名、地址、调用参数确实进入请求；验证流式文本、工具调用和结构化输出。
3. TTL 到期前旧解析可用；到期后新解析读取更新。用可控制的时钟验证边界，避免测试等待 5 秒。
4. 两个有独立内存缓存的进程共用测试 DB：一个进程手动生效后，另一个的下一次解析跳过 TTL。
5. 两个配置同时编辑，只有正确 `expectedRevision` 的写入成功；一次完整读取不能混合提供商与别名版本。
6. 手动生效与并发加载交错时，不会返回低于已读刷新序号的快照，也不会被慢加载覆盖。
7. 模型流和工具任务进行中改配置，在途任务继续原绑定，新的任务使用新绑定；不重放旧工具调用。
8. DB 故障时覆盖冷启动 503、有界旧快照降级、60 秒边界和已观察到刷新序号后的拒绝行为。
9. 普通用户和未登录用户不能读取或修改配置；POST Origin 校验生效，API、页面与日志不泄露密钥。
10. 管理页面完成提供商编辑、别名绑定、版本冲突提示、保存及立即生效；既有 fixture、生成与模板路由检查保持通过。

校验按变更风险执行 type-check、相关集成测试、完整现有测试与管理端浏览器流程；本地兼容端点不调用真实付费模型。生产上游兼容质量、多实例实际部署和真实模型能力仍需部署环境验证。

## 本轮验证结果（2026-10-12）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 测试库迁移 | `npm run db:test:setup` | 仅应用到 `paimeng_ai_code_mother_ts_test`，开发库与旧库未动 |
| 类型检查 | `npm run type-check` | 通过（EXIT=0） |
| 新增/受影响测试 | `npx vitest run`（7 个模型相关文件） | 75 passed |
| 完整测试 | `npm test` | 32 files / 225 tests passed（538.51s） |
| 生产构建 | `npm run build` | 通过，路由含 `/admin/modelManage` |
| 隔离浏览器回归 | `npm run test:e2e:isolated` | 55 passed（3.0m）：含新增 `model-manage.spec.ts` 5 项与既有全部流程（`multi_file`／`vue_project`／`react_project` 真实容器构建） |
| 空白与范围 | `git diff --check` | clean，改动仅限 `refactor-ts-agent/` |

关键验收项的测试落点：

- 别名与参数真正进入调用：`tests/models/adapters.test.ts`（上游模型名、地址、别名 settings 进入本地受控端点；文本、流式、工具调用、结构化输出与 `json_object` 回退）。
- TTL 与刷新序号：`tests/models/registry.test.ts`（TTL 从一致读开始计时、慢加载不重新计时、`refreshEpoch` 前进时跳过 TTL、更旧或回退快照不被安装、单飞共享、退避窗口内 epoch 前进仍立即换用）。
- 跨实例手动生效：`tests/integration/model-registry-multiprocess.test.ts`（两个独立进程共用测试 DB；手动 apply 在 TTL 内即生效，普通保存需等 TTL）。
- 一致性与并发编辑：`tests/integration/model-store.test.ts`（真实 MySQL：409 版本冲突、并发同期望版本只有一个成功、并发编辑期间一致读不出现不完整配置）。
- 在途任务绑定冻结：`tests/model-task-binding.test.ts`（循环中改写并 apply 后，当前任务仍用旧绑定，下一任务用新绑定，工具不重放）。
- 故障与脱敏：`tests/models/registry.test.ts`（冷启动 503、宽限期降级、60 秒截止、已观察到更高 epoch 后拒绝旧快照、无效配置失败关闭到成功加载）与 `tests/integration/model-admin.test.ts`（鉴权、Origin、密钥不回显、`ZodError` 归为 503）。
- 管理界面：`tests/e2e/model-manage.spec.ts`（未初始化提示、提供商与别名编辑、版本冲突后保留输入并可重载、保存并立即生效与立即生效递增刷新批次、普通用户被拒）。

复核说明（如实记录）：步骤六要求“独立复核关键事务与刷新语义”。原计划由独立只读子代理执行，该子代理在运行中被用户中止，未产出结论；因此本轮发布前的核对**由实现者本人对最终代码逐行复核**完成（`src/server/models/store.ts`、`src/server/models/registry.ts`、`src/server/models/adapters.ts`、`src/server/model.ts`、`src/server/agent.ts`），没有独立第三方结论。复核确认：写路径用 `lockState()`（`SELECT … FOR UPDATE`）加 `assertRevision` 串行化写入者；`readConfigSnapshot` 在单个 `repeatable read` 只读事务内读取状态行、提供商与别名；`applyImmediately` 在同一事务内递增 `refreshEpoch`；`observeEpoch()` 每次解析都探测共享序号且不被退避短路；`install()` 拒绝 revision 或 epoch 任一维回退的快照；`agent.ts:39` 每任务只解析一次并冻结绑定。发现的非阻塞观察（未改动）：`initializeModelConfigFromEnv` 只递增 `revision` 而不递增 `refreshEpoch`，其他实例最迟 5 秒（TTL）后可见；因初始化写入口径与环境变量等值，不构成行为差异。

未验证（本地产线不能断言）：真实付费模型的生成质量与上游厂商兼容性、生产多实例部署与密钥轮换实操、开发库迁移。

本文件的“当前实现与部署”一节描述已落地行为；其余章节保留原始设计依据。
