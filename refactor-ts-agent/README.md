# 在独立目录运行 React 与 TypeScript 应用

本目录包含 Next.js、React、TypeScript、Vercel AI SDK、MySQL 和 Drizzle 的独立应用。运行新应用无需启动旧 Java 后端或旧 Vue 平台。所有命令都在 `refactor-ts-agent/` 内执行。

## 启动开发环境

需要 Node.js 24.15 或更新的 24 版本、npm、Docker，以及可运行 Chromium 沙箱的 Linux 环境。Docker 守护进程必须已启动。

1. 复制 `.env.example` 为 `.env`。本地默认使用 `MYSQL_ROOT_PASSWORD=root`，应用专用账号为 `paimeng_ts`，密码为 `root`。`DATABASE_URL` 已填写专用开发库地址，`REDIS_URL` 已填写无密码本地 Redis 地址。已有 `.env` 的真实模型配置保留。
2. 执行 `npm ci`。
3. 执行 `npm run assets:import`。此命令只读取旧平台的派蒙图片，写入新应用的 `public/`。
4. 执行 `npm run infra:up`。固定命名的 MySQL 和 Redis 容器启动并等待健康检查。该命令读取 `.env`，不生成或改写凭据。
5. 执行 `npm run db:migrate`。迁移完成后显示“独立 TS 数据库迁移完成”。重复执行会核对已有迁移的校验和。迁移包含 `006_model_registry.sql`（模型配置表与状态行）、`007_provider_api_format.sql`（提供商 API 格式、可空密钥引用与密文字段）、`008_provider_headers.sql`（提供商自定义请求头 JSON 列）与 `009_conversation_summary.sql`（每个应用的滚动摘要一行）；随后执行一次 `npm run db:init-models`，把现有 `.env` 的模型配置写入数据库（仅当表仍为空且版本为零；幂等，已有配置不会被覆盖）。
6. 执行 `docker pull node:24-alpine`。Vue 生成工程使用该镜像进行隔离构建。
7. 执行 `npx playwright install chromium`。发布封面截图和浏览器测试都需要 Chromium。若系统缺少浏览器依赖，按 Playwright 的报错安装系统依赖。
8. 执行 `npm run dev:all` 同时启动管理端与预览进程，输出按 `[app]`、`[preview]` 前缀合并，按 Ctrl-C 一起停止；也可以在一个终端执行 `npm run preview`，在另一个终端执行 `npm run dev`。两个进程的端口分别取自 `APP_ORIGIN` 与 `PREVIEW_ORIGIN`，端口已被占用时 `dev:all` 会直接报错退出。
9. 打开 `http://localhost:3000`，注册并登录。

`.env.example` 默认使用真实模型。配置真实模型前，可以在本地 `.env` 中显式设置 `AI_MODE=fixture`，运行确定的验收样本。fixture 使用真实 SDK 工具循环，但不代表真实模型质量已验证。

平台统一入口为 `http://localhost:3000`。普通页面使用 `/`、`/user/login`、`/user/register`、`/app/chat/{id}` 和 `/app/edit/{id}`。管理员页面使用同一入口下的 `/admin/userManage`、`/admin/appManage` 和 `/admin/chatManage`，登录角色决定是否显示管理菜单，服务端再次校验权限。

生成限流默认沿用旧版策略，按用户每 60 秒允许 1 次，跨应用共享。`CHAT_RATE_LIMIT_TYPE` 可选 `API`、`USER`、`IP`，其中 `API` 表示整个生成接口共用一个窗口；`CHAT_RATE_LIMIT_RATE` 与 `CHAT_RATE_LIMIT_INTERVAL` 覆盖次数（1-1000）与窗口秒数（1-86400）。`IP` 类型沿用旧版做法，按 `X-Forwarded-For` 首段计数、缺失时用 `X-Real-IP`，因此必须由可信前置代理覆盖这两个请求头并阻止直连应用，否则调用方更换该头即可绕过限制；两个头都缺失时，直连请求会共用 `ip:unknown` 窗口。`CHAT_RATE_LIMIT_MESSAGE` 覆盖提示文案，留空时按窗口与次数生成默认文案。

`http://127.0.0.1:3001` 只提供 AI 生成网站的预览、发布副本及封面，不是管理员前端，也不是另一套用户平台。预览在平台页面中通过 iframe 打开，使用不同主机名隔离登录 Cookie。日常操作只需打开统一平台入口。默认本地配置下，打开 `127.0.0.1:3000` 的平台页面会自动跳转到 `localhost:3000`，保留页面路径与查询参数。API 不执行此跳转，直接来自别名或预览来源的写请求仍会被来源校验拒绝。

需要管理员时，执行 `npm run db:admin -- 账号`。此命令只修改独立 TS 数据库。应用创建者通过应用详情或编辑页修改名称或删除应用。管理员可在应用编辑页或应用管理页编辑其他用户的应用，不能代替创建者生成、下载或部署。

## 使用固定的本地数据库容器

MySQL 容器固定为 `zslm-mysql`，宿主连接地址为 `127.0.0.1:3306`。本地管理账号为 `root`，密码为 `root`。应用继续使用专用账号 `paimeng_ts`，本地密码同样为 `root`，仅访问专用开发库与测试库。开发库为 `paimeng_ai_code_mother_ts`，集成测试库为 `paimeng_ai_code_mother_ts_test`，两个库位于同一个 MySQL 容器。MySQL 数据继续保存在 `runtime/mysql/`。

已有 MySQL 数据目录初始化后，修改 `.env` 不会自动修改数据库内的账号密码。密码变更需要在此专用容器内同步账号后再重启应用，本次已完成同步并保留已有数据。

Redis 容器固定为 `zslm-redis`，宿主连接地址为 `127.0.0.1:6379`，使用逻辑库 0。按本地开发要求不设置密码，连接字符串为 `redis://127.0.0.1:6379/0`。Redis 镜像固定到已验证的官方镜像摘要。

本地弱密码和无密码 Redis 只用于这两个回环端口的开发服务。容器内的 Redis 关闭 protected mode，以接受 Docker 转发连接；宿主端口仍只绑定 `127.0.0.1`。这些默认值不用于公网或生产环境。

Redis 启用 AOF 持久化，数据存入固定命名卷 `paimeng-ts-refactor-redis-data`。两个容器仅发布到宿主回环地址，并设置 `unless-stopped` 重启策略。Docker 守护进程启动时会恢复未被手动停止的容器。MySQL 与 Redis 都使用默认宿主端口（3306 与 6379）。原先占用 6379 的旧项目容器 `paimeng-redis` 已不存在（2026-10-14 复核：`docker inspect` 报 no such object，`ss -ltnp` 显示 6379 无监听），因此 Redis 从临时的 6381 切回默认端口，数据卷保留。

重复执行 `npm run infra:up` 会复用固定容器与数据。执行 `npm run infra:status` 查看状态，执行 `npm run infra:stop` 停止两个容器但保留数据。重新开发时再次执行 `npm run infra:up`。删除 `runtime/mysql/` 或执行删除卷的 Docker 命令会丢失数据库数据，日常启动和停止不需要这些操作。

执行 `npm run verify:infra`，检查宿主端口、MySQL root 登录、应用账号临时表读写，以及 Redis 无密码连接和键值读写。需要验证 Redis 重启持久化时，执行 `npm run verify:infra -- --restart-redis`。该命令只重启本项目 Redis，并在验证后删除自己创建的唯一测试键。

Redis 已作为本地开发服务提供连接。当前平台会话、消息和生成任务仍保存在 MySQL，未改为依赖 Redis。旧项目的数据库及缓存服务不受影响。

## 业务主键与升级

用户、应用和文本聊天记录的新主键使用雪花 ID，保留原 MyBatis Flex 1.11.1 的起始时间与位布局。计算和数据库读写使用 `bigint`，HTTP 返回十进制字符串。三个业务主键取消自增，已有记录不重编号。例如原应用 `42` 继续使用 `runtime/code_output/html_42/`。内部消息排序列 `ts_message.sequence` 仍然自增。

本地 TS 平台使用数据中心 0、机器 0，并通过同一 MySQL 中的 `ts_snowflake_state` 持久化发号。并发进程、模块热重载和重启共享已提交的发号下界。业务事务开始前先提交发号短事务；失败可以留下空号，不能复用已预留号码。雪花 ID 有时间顺序，不是随机 ID，也不替代接口归属鉴权。

已有 TS 数据库升级时，先停止平台写入。执行 `npm run verify:id-migration -- prepare`、`npm run db:migrate`、`npm run verify:id-migration -- verify`，再恢复平台。验证脚本比较既有记录和应用 `42` 的源码摘要，不输出密码或会话令牌。首次空库直接执行 `npm run db:migrate`。已执行的迁移保持原校验和，新策略由 `003_snowflake_ids.sql` 提供。

执行 `npx vitest run tests/snowflake.test.ts tests/integration/snowflake-ids.test.ts`，核对位布局、序列耗尽、时钟回拨、三类主键、事务回滚、独立进程并发及导入。先执行 `npm run db:test:setup`，测试仅连接专用测试库，不调用模型。Drizzle 的 `.$defaultFn()` 是同步字段钩子，不能直接调用当前异步持久化发号器。

## 配置真实模型

在忽略的 `.env` 内设置 `AI_MODE=provider`、`AI_API_KEY`、`AI_MODEL` 和 `AI_BASE_URL`。模型服务必须支持 OpenAI 兼容聊天、工具调用及 JSON mode。首页创建应用时同步调用模型选择生成类型，生成及修改时再执行工具循环。配置只由服务端读取。

缺少模型配置时，生成请求返回明确错误。服务端不会自动改用 fixture。生产运行默认禁止 fixture。正式运行使用 provider，以下生产验收命令中的 `ALLOW_TEST_FIXTURE=1` 仅供本地测试。

## 模型统一管理

模型配置保存在 MySQL。表结构由 `migrations/006_model_registry.sql` 创建、`migrations/007_provider_api_format.sql` 补充提供商 API 格式与密钥字段、`migrations/008_provider_headers.sql` 新增自定义请求头列，`npm run db:migrate` 执行；迁移后执行一次 `npm run db:init-models`，把当前 `.env` 的 `AI_BASE_URL` / `AI_MODEL` / `AI_API_KEY` 写入数据库。初始化只在配置仍为初始空态时进行，已有配置不会被覆盖。表已迁移且为空时，解析会临时用环境变量构造两个别名以兼容升级；读取失败不等于表空，不会回退到环境变量；DB 初始化后 DB 是唯一来源。

注册表支持两个业务别名：`codegen.default`（应用生成 Agent，需流式与工具调用）和 `route.classify`（生成类型分类，需结构化输出）。管理员在 `/admin/modelManage` 编辑提供商与别名；“保存”约 5 秒内对后续请求生效，“保存并立即生效”会在事务中递增共享刷新序号，让其他实例在下一次解析时跳过 TTL。在途生成任务继续使用开始时解析的绑定。

提供商按 API 格式构造模型：`openai-chat`（OpenAI 兼容 `/chat/completions`，支持 `includeUsage`、`supportsStructuredOutputs`、`supportsMultiPartToolContent` 三个布尔选项，以及命名选项 `thinkingSwitch`）、`openai-responses`（OpenAI Responses API `/responses`）、`anthropic-messages`（Anthropic Messages API `/messages`）。后两种格式没有可配置协议选项，管理端会隐藏相应开关；提交该格式不支持的选项会返回 400。`thinkingSwitch` 只对 `openai-chat` 生效，取值 `none`（默认，不追加）、`enabled`、`disabled`；非 `none` 时在请求体追加 DeepSeek 的 `thinking: {"type": …}`。

每个提供商可额外配置一组自定义请求头（`headers`），单独存在 `ts_model_provider.headers`（JSON），与协议选项分开。名称须是 RFC 7230 token（字母、数字及 `!#$%&'*+-.^_|~` 与反引号），大小写不敏感去重；值须是首尾无空白的可打印/扩展 ASCII（可编码为 ByteString）；最多 32 条，名称最多 128、值最多 1024 字符。`authorization`、`proxy-authorization`、`x-api-key`、`x-goog-api-key`、`api-key`、`host`、`content-length`、`connection`、`transfer-encoding`、`te`、`trailer`、`upgrade`、`keep-alive`、`proxy-authenticate`、`cookie`、`set-cookie` 由系统生成，不能自定义；鉴权仍走密钥来源，避免 SDK 与探测鉴权不一致。自定义头对三种格式的生成、流式与结构化调用都生效，也随「测试连接」「获取模型」的 `GET /models` 一起发送；上游错误回显这些值时，响应片段先脱敏再截断。示例：`User-Agent: paimeng-ai-code-mother/1.0`（本应用自己的标识，不是伪装成其他客户端）。OpenCode Go 那种每对话动态稳定的会话头（如 `x-opencode-session`）不是固定值，暂未接入。

别名弹窗的「思考强度」写入 `settings.reasoning`，取值 `none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`，留空表示不指定（不传思考参数）。SDK 的统一 `reasoning` 参数由 `src/server/models/adapters.ts` 的自定义 middleware 注入，各格式映射为：`openai-chat` → `reasoning_effort`；`openai-responses` → `reasoning.effort`（适配层同时打开 `forceReasoning`，否则上游会忽略未知模型名的思考配置）；`anthropic-messages` → `thinking` 预算（按 `max_tokens` 比例换算，最低 1024）。上游不支持的等级由上游自行拒绝，本项目不做收窄。

提供商弹窗的「测试连接」与别名弹窗的「获取模型」都会请求上游 `GET {baseUrl}/models`（`openai-chat` / `openai-responses` 用 `Authorization: Bearer`，`anthropic-messages` 用 `x-api-key` + `anthropic-version`），每次点击都会重新请求上游（带 `cache-control: no-cache`，不使用缓存）、10 秒超时、不跟随重定向、错误信息不回显密钥与自定义请求头的值；「获取模型」的结果只填充当前对话框的候选列表（最多 1000 条，命中上限时界面会提示可能被截断），不落库。密钥来源为“直接输入”且表单留空时，探测沿用数据库里已保存的密文。「获取模型」失败的原因会显示在别名的「上游模型名」下方。

生成的时长预算都在 `.env`：`GENERATION_TIMEOUT_MS`（毫秒，默认 `0`，表示不限制整次生成任务；旧版写死 10 分钟）；`MODEL_REPLY_TIMEOUT_MS`（毫秒，默认 `900000`）限制单次模型回复的时长，超时中止并记为「单次回复超时」；每个模型请求的失败重试次数由 `MODEL_RETRY_LIMIT`（默认 `2`，0-5）控制。上游输出到达 token 上限（`finishReason = length`）不再判为失败：文件已经落盘就继续构建，模型可以在下一轮对话里根据构建结果补齐。

长对话默认启用「滚动摘要 + 最近完整回合」。超预算时，较早的完整回合会被压缩成一段固定分节（当前目标 / 用户要求与约束 / 已完成内容 / 决策与理由 / 待办 / 失败与取消尝试 / 重要文件等）的摘要，作为历史消息（明确标注为低信任参考）发给模型，最近若干回合仍带完整原文。原始聊天记录和界面上的完整历史都不删减，只是不再全部塞进模型上下文。表结构由 `migrations/009_conversation_summary.sql` 创建，`npm run db:migrate` 执行。开关与预算都在 `.env`：`MEMORY_ENABLED`（默认 `true`，设为 `false` 回到旧的「最近 20 条消息」行为）、`MEMORY_CONTEXT_BUDGET_TOKENS`（默认 `24000`）、`MEMORY_RECENT_BUDGET_TOKENS`（默认 `12000`）、`MEMORY_SUMMARY_INPUT_TOKENS`（默认 `24000`）、`MEMORY_SUMMARY_OUTPUT_TOKENS`（默认 `2048`）、`MEMORY_CALL_TIMEOUT_MS`（默认 `60000`）、`MEMORY_MIN_NEW_TURNS`（默认 `4`）、`MEMORY_RETRY_INTERVAL_MS`（默认 `120000`）；token 数为粗估（约等于字符数除以 2，中英混排下偏差较大），只用于判断是否整理，不保证精确。摘要模型是可选别名 `memory.summarize`（在「模型管理 → 别名」里配置）；未配置时复用本次生成所用的模型，配置错误不会被误判为「未配置」。摘要调用失败、超时或返回空内容时，保留上一版摘要与覆盖位置，降级为「旧摘要 + 装得下的最近完整回合」，并按 `MEMORY_RETRY_INTERVAL_MS` 冷却后重试；整理失败不会中断本轮生成，也不会推进覆盖位置。整理期间界面会显示「正在整理历史上下文，请稍候…」，结束、失败或取消后自动消失。摘要是**有损**压缩：它可能丢掉细节，且本项目的摘要质量只在受控测试模型下验证过，未用真实模型评测过输出质量。

密钥有两种来源。引用环境变量时只存引用名（`apiKeyEnv`），默认允许 `AI_API_KEY`，其余通过 `MODEL_API_KEY_ENV_ALLOWLIST`（逗号分隔）加入；直接输入时明文不落库，服务端用 AES-256-GCM 加密后只存密文（`apiKeyCiphertext`，格式 `v1:<iv>:<tag>:<ciphertext>`），主密钥取自 `MODEL_SECRET_KEY`（64 位十六进制、32 字节 base64 或任意口令，scrypt 派生），未设置时自动生成 `runtime/model-secret.key`（权限 600）。管理接口只返回 `apiKeySource` 与当前实例是否已配置，绝不返回明文或密文；编辑态密钥留空表示保持已保存的值。该密钥文件丢失后已保存的密钥无法解密，需要在管理端重新输入。

地址只允许无内嵌凭据、无查询、无片段的 HTTP(S)；`http:` 对本机与局域网地址（`localhost`、`127.0.0.0/8`、`10/8`、`172.16/12`、`192.168/16`、`::1`，例如自建网关 `http://127.0.0.1:8787/v1`）直接放行，其它来源的 origin 需写进 `MODEL_INTERNAL_BASE_URL_ORIGINS`（逗号分隔）。管理端可在已部署的密钥引用之间热切换；轮换环境变量里的密钥值需要更新进程环境并重启进程。

页面提示“保存成功”只代表服务端完成本地 schema、密钥引用与业务能力校验，不代表上游密钥或模型可用。「测试连接」/「获取模型」只验证地址与密钥能列出模型，不代表所选模型和格式一定能推理。

## 运行完整测试

1. 保持专用 MySQL 运行，执行 `npm run db:test:setup`。此命令只在上述 Compose 容器内创建独立测试库、授予专用用户权限，并执行测试库迁移。
2. 执行 `npm run type-check`。
3. 执行 `npm test`。完整测试需要 MySQL、Docker 镜像和 Chromium，不会因缺少依赖而跳过相关检查。
4. 保持开发服务和预览服务运行，并将本地模型设为 fixture。执行 `npm run test:e2e`。浏览器场景只创建带唯一前缀的验收账号及应用。
5. 执行 `npm run verify:boundary`，核对旧项目与已有删除状态。

集成测试在数据库操作前统一解析 URL，只将专用开发库或测试库映射到 `paimeng_ai_code_mother_ts_test`。URL 可保留 `charset` 查询参数，其他查询选项拒绝，防止测试连接目标含糊。测试只清理自己创建的记录。浏览器测试使用开发库 `paimeng_ai_code_mother_ts`，保留验收样本。运行浏览器测试时一次只启动一个测试命令，避免报告目录被另一轮测试覆盖。

浏览器截图写入 `runtime/evidence/`，HTML 报告写入 `playwright-report/`。这些运行文件已被忽略。只验证默认入口跳转、注册登录、会话 Cookie 隔离与来源拒绝时，执行 `npm run test:e2e -- tests/e2e/platform-origin.spec.ts`。这两项浏览器回归测试不调用模型，也不需要预览服务运行。

验证短窗口、手机及横屏中的发送区域，以及点击发送和快捷键时，执行 `npm run test:e2e -- tests/e2e/chat-composer.spec.ts`。普通 Enter 发送，Shift + Enter 换行，Ctrl / Command + Enter 也可发送。测试使用独立样本账号和应用，通过浏览器拦截生成接口并返回 SDK 消息流，不调用真实模型。它验证发送操作和回复显示，不代表供应商模型生成质量已验证。聊天区域按动态视口高度限制消息区，输入框和发送按钮保持可见。

## 验证生产构建与重启

以下过程使用专用本地验收数据，不进行生产部署。停止开发进程后再构建，避免开发服务与生产构建同时写入 `.next/`。

1. 在开发或本地验收服务仍运行时，执行 `AI_MODE=fixture npm run verify:restart -- prepare`。脚本保存专用样本的会话、完整工具消息、生成状态及预览摘要。
2. 停止本目录的开发服务。保留 MySQL 和预览服务。
3. 执行 `ALLOW_TEST_FIXTURE=1 npm run build`。
4. 执行 `AI_MODE=fixture ALLOW_TEST_FIXTURE=1 npm start`，保持该进程运行。
5. 在另一个终端执行 `AI_MODE=fixture npm run verify:restart -- verify`。脚本核对保存的数据，下载源代码，并提交下一轮对话。
6. 执行 `npm run test:e2e`，验证构建后的页面及接口。

重新执行整套重启验证时，从 prepare 开始。快照包含本地验收会话 Cookie，文件使用仅当前用户可读写的权限，并位于忽略的运行目录。不要分享快照。

正式使用 provider 时，执行 `npm run build` 和 `npm start`。运行目录、数据库与模型配置仍由当前应用目录和服务端环境提供。Next.js 的构建追踪排除 `runtime/` 和 `.env`，运行数据不会打包进构建输出。

## 导入旧数据副本

本项目只接受 `paimeng_ai_code_mother_ts` 或 `paimeng_ai_code_mother_ts_test` 数据库名。它不会自动连接旧数据库。

1. 停止新平台写入，并冻结旧库的最终快照。从旧库导出经过审查的 JSON 副本，放入新应用 `runtime/import/snapshot.json`。格式为 `{users:[],apps:[],chatHistory:[]}`，字段与原表对应。
2. 所有 ID 使用十进制字符串。日期使用 `YYYY-MM-DD HH:mm:ss`（可含毫秒）。可空字段明确使用 null。应用 `editTime` 原值会保留，旧快照未包含该字段时为 null。
3. 执行 `npm run db:import -- runtime/import/snapshot.json`。引用、日期、ID、账号冲突或字段无效时，导入整体失败，不覆盖目标记录。原 ID 与本节点发号下界同事务提交，成功后再恢复平台写入。
4. 如需同时迁移旧文件，执行 `npm run db:import -- runtime/import/snapshot.json --artifacts <旧项目根目录> --covers <已导出的封面目录>`。脚本只读旧目录，迁移快照关联的 `code_output`、`code_deploy` 和 `{deployKey}.png` 封面，拒绝覆盖新平台已有目标。加 `--strict` 可在文件缺失时中止。详细约定与文件/数据库回滚边界见 [迁移说明](docs/migration-contracts.md)。旧封面需预先导出到本地，脚本不请求 COS。

有效旧产物无需补造 ready 任务即可预览。重复部署复用原发布密钥；Vue 每次部署会先构建当前源码，构建失败时保留旧预览并拒绝这次部署。

旧密码摘要只在新库登录成功后升级为 scrypt。旧库和旧 Spring 会话保持原样，用户在新应用重新登录。

## 工程模板

`templates/<id>/<version>/` 是完整可运行的工程，AI 在复制出的工程上继续开发。新建 Vue 应用默认使用 `vue-ts@1.0.0`，新建 React 应用默认使用 `react-ts@1.0.0`；两个模板都自带一个「今日计划」任务清单示例，不需要模型先搭空工程。

- `src/shared/templates.ts` 的 `projectTemplates` 声明模板 id、版本、生成类型与运行形态；当前只有静态前端模板（Vue 与 React）。首页技术栈下拉里可显式选择模板；选「自动选择」时由模型按需求复杂度路由，需求指明 React 或 Vue 就按需求选，未指明技术栈的复杂应用默认 Vue。
- 初始化只在创建应用时发生一次，工程内 `.paimeng-template.json` 记录所用模板版本。已经有工程的应用不会被模板覆盖，模板升级需要单独的迁移流程。
- `templates/<id>/<version>/` 的 `AGENTS.md` 是给模型的开发说明：先读工程再改源码、保留入口文件与 `vite.config.ts`、不增删依赖。Vue 模板入口是 `src/main.ts`，React 模板入口是 `src/main.tsx`。
- 模板工程只允许保留该模板版本的依赖集合；改锁文件、删入口、改 `vite.config.js` 或缩减依赖会被工具拒绝。构建仍走容器隔离，但模板工程用 `npm ci` 安装，再按模板定义的命令做类型检查（Vue 用 `vue-tsc --noEmit`，React 用 `tsc --noEmit`）与 `vite build`。
- 新增模板：把目录放到 `templates/<id>/<version>/`，在 `projectTemplates` 注册，并在 `src/server/templates.ts` 的 `definitions` 里补文件清单、入口与类型检查命令。依赖必须落在该技术栈的允许集合内（Vue 为 `BUILD_DEPENDENCIES`，React 为 `REACT_DEPENDENCIES`）。

## 查阅实现与限制

[接口与模块契约](docs/implementation-contract.md) 描述权限、消息及任务状态。[迁移差异](docs/migration-contracts.md) 说明原路径和有意变更。[产物与隔离限制](docs/artifacts.md) 记录构建依赖、预览与本地封面行为。[决策与验收记录](docs/migrations/ts-unified/decisions.tsv) 保存实施证据。

本次保留 HTML、多文件和 Vue 工程生成模式及八个页面 URL。样式使用集中式 CSS，未采用计划中提出的 CSS Modules。关键桌面和移动流程经过浏览器验证，未做逐像素对比验收。

原 Java、Vue、Maven、SQL 与根目录配置保持原样。本次不删除旧入口、不切换旧服务、不提交或推送。真实模型配置由本地 `.env` 提供。本轮已观察到真实模型思考和工具调用，尚未完成生成到预览的全流程验收。外部 COS 对象存储缺少凭据，仍未验证。封面当前存储在本目录的 `runtime/covers/`。
