# 在独立目录运行 React 与 TypeScript 应用

本目录包含 Next.js、React、TypeScript、Vercel AI SDK、Postgres 和 Drizzle 的独立应用。运行新应用无需启动旧 Java 后端或旧 Vue 平台。所有命令都在 `paimeng-ai-code-agent/` 内执行。

生成入口只有一个引擎：请求提交给常驻的 pi-durable harness 进程（单写进程 + attach，实现在 `src/server/durable/`），Next 只做鉴权与 SSE 转发，所以浏览器断连不会取消任务。一条命令起全套见下面的 `npm run dev`。数据库是 Postgres，**同实例两库**：`paimeng_app` 放业务表，`paimeng_agent` 放 harness 的会话存储（表名与列名见 `docs/plans/pi-durable-m4.md`，部署形态见 `docs/plans/pi-durable-deployment.md`）。

## 启动开发环境

需要 Node.js 24.15 或更新的 24 版本、npm、Docker，以及可运行 Chromium 沙箱的 Linux 环境。Docker 守护进程必须已启动。

1. 复制 `.env.example` 为 `.env`。`DATABASE_URL` 已填写产品 Postgres 库（`postgres://postgres:postgres@127.0.0.1:5432/paimeng_app`），`DURABLE_PG_URL` 是同实例的存储库（`…/paimeng_agent`），`REDIS_URL` 已填写无密码本地 Redis 地址。`MYSQL_LEGACY_URL` 只给一次性业务行搬迁用，运行期不连接旧库。已有 `.env` 的真实模型配置保留。
2. 执行 `npm ci`。
3. 执行 `npm run assets:import`。此命令只读取旧平台的派蒙图片，写入新应用的 `public/`。
4. 执行 `npm run infra:up`。固定命名的 Redis 容器启动并等待健康检查；产品 Postgres 不在这个 compose 里，由本机自己的容器提供（见第 5 步）。该命令读取 `.env`，不生成或改写凭据。
5. 执行 `npm run durable:pg` 确保 Postgres 就绪（连接本机自己的 Postgres 容器 `zslm-postgres`，127.0.0.1:5432，建好 `paimeng_app`、`paimeng_app_test`、`paimeng_agent`、`paimeng_agent_test` 四个 database，再打印 server_version 与各库大小），再执行 `npm run db:migrate`。迁移完成后显示“产品 Postgres 库迁移完成”，依次执行尚未应用的 SQL 迁移；`001_initial.sql` 建业务表，`002_drop_rate_limit.sql` 删除已迁往 Redis 的限流表。重复执行会核对已有迁移的校验和。随后执行一次 `npm run db:init-models`，把现有 `.env` 的模型配置写入数据库（仅当表仍为空且版本为零；幂等，已有配置不会被覆盖）。从旧 MySQL 库升级时额外跑一次 `npm run db:import-mysql`（只搬业务行，幂等，见 `docs/plans/pi-durable-m4.md`）。
6. 执行 `docker pull node:24-alpine`。Vue 生成工程使用该镜像进行隔离构建。
7. 执行 `npx playwright install chromium`。发布封面截图和浏览器测试都需要 Chromium。若系统缺少浏览器依赖，按 Playwright 的报错安装系统依赖。
8. 执行 `npm run dev` 启动全套开发进程：harness（5599）、预览（3001）与管理端（3000），输出按 `[harness]`、`[preview]`、`[app]` 前缀合并，Ctrl-C 一起停止。它要求本机 Postgres 容器已在跑（不在跑就直接报错，不会自己起数据库）。也可以分开跑：`npm run durable:harness`、`npm run preview`、`npm run dev:web`（只起 Next）。
9. 打开 `http://localhost:3000`，注册并登录。
10. 浏览器打开 `http://localhost:3000` 登录后进入应用，生成由第 8 步起的 harness 执行；`http://localhost:3000/app/chat/<应用 ID>` 是对话页。Ctrl-C 会一起收尾 harness、预览与 Next；数据库不属于该脚本，不会被停。

`DURABLE_HARNESS_URL` 是 Next 的 attach 地址（默认 `http://127.0.0.1:5599`），`DURABLE_PG_URL` 是 harness 存储库，`DURABLE_HARNESS_PORT` 配置监听端口。生成模型默认每轮从产品库解析 `codegen.default`，管理端修改后无需重启。只有本地/测试需要显式覆盖时，才同时设置 `DURABLE_MODEL_BASE_URL` / `DURABLE_MODEL_API_KEY` / `DURABLE_MODEL_ID`；缺项会报错。`npm run dev` 不再从其他工具的模型配置派生凭据。

确定性生成夹具运行在 harness：`DURABLE_FAUX_MODEL=1` 用于可控等待/工具行为，`DURABLE_FAUX_FIXTURE=1` 用于完整文件生成。`AI_MODE=fixture` 只控制产品侧的测试行为，不能单独开启 harness 夹具。生产环境必须额外显式设置 `ALLOW_TEST_FIXTURE=1` 才允许夹具，隔离 E2E 启动器会自动设置这些测试变量。

平台统一入口为 `http://localhost:3000`。普通页面使用 `/`、`/user/login`、`/user/register`、`/app/chat/{id}` 和 `/app/edit/{id}`。管理员页面使用同一入口下的 `/admin/userManage`、`/admin/appManage` 和 `/admin/chatManage`，登录角色决定是否显示管理菜单，服务端再次校验权限。

生成限流默认沿用旧版策略，按用户每 60 秒允许 1 次，跨应用共享。`CHAT_RATE_LIMIT_TYPE` 可选 `API`、`USER`、`IP`，其中 `API` 表示整个生成接口共用一个窗口；`CHAT_RATE_LIMIT_RATE` 与 `CHAT_RATE_LIMIT_INTERVAL` 覆盖次数（1-1000）与窗口秒数（1-86400）。`IP` 类型沿用旧版做法，按 `X-Forwarded-For` 首段计数、缺失时用 `X-Real-IP`，因此必须由可信前置代理覆盖这两个请求头并阻止直连应用，否则调用方更换该头即可绕过限制；两个头都缺失时，直连请求会共用 `ip:unknown` 窗口。`CHAT_RATE_LIMIT_MESSAGE` 覆盖提示文案，留空时按窗口与次数生成默认文案。窗口由 `REDIS_URL` 指向的 Redis 原子 Lua 操作维护，键为 `user:<id>` / `ip:<ip>` / `api:app.chat.gen.code`。额度在 Postgres 事务前预留，后续权限、重复请求或全局并发拒绝时只退还原窗口；频率超限返回原有 429/42900，且不写生成行或租约。Redis 不可用时放行，并记录脱敏的结构化 warn。

`http://127.0.0.1:3001` 只提供 AI 生成网站的预览、发布副本及封面，不是管理员前端，也不是另一套用户平台。预览在平台页面中通过 iframe 打开，使用不同主机名隔离登录 Cookie。日常操作只需打开统一平台入口。默认本地配置下，打开 `127.0.0.1:3000` 的平台页面会自动跳转到 `localhost:3000`，保留页面路径与查询参数。API 不执行此跳转，直接来自别名或预览来源的写请求仍会被来源校验拒绝。

需要管理员时，执行 `npm run db:admin -- 账号`。此命令只修改独立 TS 数据库。应用创建者通过应用详情或编辑页修改名称或删除应用。管理员可在应用编辑页或应用管理页编辑其他用户的应用，不能代替创建者生成、下载或部署。

## 使用本机自己的数据库容器

产品库是 Postgres 16，落在**本机自己的容器**里（`zslm-postgres`，宿主地址 `127.0.0.1:5432`，命名卷 `zslm-postgres-data`）。此容器不归本仓库管：`compose.yaml` 里没有 postgres 服务，`npm run durable:pg` 只**连接 + 建库 + 健康检查**，不会起、停或清空任何容器；它需要容器已经在跑。同一个实例里四个 database：开发库 `paimeng_app` 与存储库 `paimeng_agent`，集成测试库 `paimeng_app_test` 与 `paimeng_agent_test`；连接串在 `.env`，账号与口令取容器自身的配置。表名与列名见 `docs/plans/pi-durable-m4.md`，部署与并发/清扫说明见 `docs/plans/pi-durable-deployment.md`。

这是产品库搬家的终点：数据原先在临时容器 `zslm-pg-paimeng`（127.0.0.1:55432，数据目录 `runtime/durable-pg/pgdata/`，已 gitignore），2026-10-18 四个库（schema + 数据）整体迁到 `zslm-postgres` 后该容器已删除，`runtime/durable-pg/pgdata/` 作为当时的备份目录保留，确认新库无误后可以自行删掉。

旧 MySQL 容器 `zslm-mysql`（`runtime/mysql/`，库 `paimeng_ai_code_mother_ts`）**保留作归档**：本步把业务行搬到 Postgres，没有删除旧库。`compose.yaml` 里的 mysql 服务只在需要回看旧数据时启动。

Redis 容器固定为 `zslm-redis`，宿主连接地址为 `127.0.0.1:6379`，使用逻辑库 0。按本地开发要求不设置密码，连接字符串为 `redis://127.0.0.1:6379/0`。Redis 镜像固定到已验证的官方镜像摘要。

本地弱密码和无密码 Redis 只用于这两个回环端口的开发服务。容器内的 Redis 关闭 protected mode，以接受 Docker 转发连接；宿主端口仍只绑定 `127.0.0.1`。这些默认值不用于公网或生产环境。

Redis 启用 AOF 持久化，数据存入固定命名卷 `paimeng-ts-refactor-redis-data`。容器仅发布到宿主回环地址，并设置 `unless-stopped` 重启策略。Docker 守护进程启动时会恢复未被手动停止的容器。Redis 使用默认宿主端口 6379。原先占用 6379 的旧项目容器 `paimeng-redis` 已不存在（2026-10-14 复核：`docker inspect` 报 no such object，`ss -ltnp` 显示 6379 无监听），因此 Redis 从临时的 6381 切回默认端口，数据卷保留。

重复执行 `npm run durable:pg` 只会补建缺的 database 并重新打印状态，不动已有数据。`npm run infra:status` / `npm run infra:stop` 管的是 compose 里的 Redis（以及归档用的 mysql），不涉及 Postgres。备份用 `pg_dump`；删 `runtime/durable-pg/pgdata/` 或 `docker volume rm zslm-postgres-data` 会丢失数据库数据。

执行 `npm run verify:infra`，检查 `.env` 里 Postgres 连接串指向的库能建临时表并读写（主机、端口、账号都从连接串解析），以及 Redis 无密码连接和键值读写。需要验证 Redis 重启持久化时，执行 `npm run verify:infra -- --restart-redis`。该命令只重启本项目 Redis，并在验证后删除自己创建的唯一测试键。

Redis 承担生成频率限流；登录会话、生成任务与对话转录仍保存在 Postgres（转录作为 pi-durable 条目）。测试固定使用独立 Redis DB15，只清理精确测试键。

## 业务主键与升级

用户与应用的新主键使用雪花 ID，保留原 MyBatis Flex 1.11.1 的起始时间与位布局。计算和数据库读写使用 `bigint`，HTTP 返回十进制字符串。业务主键不接受数据库发号（Postgres 侧不是 identity / serial），已有记录不重编号。例如原应用 `42` 继续使用 `runtime/code_output/html_42/`。对话转录的排序由 pi-durable 的条目 id 决定。

本地 TS 平台使用数据中心 0、机器 0，并通过同一 Postgres 库的 `id_sequence` 持久化发号。并发进程、模块热重载和重启共享已提交的发号下界。业务事务开始前先提交发号短事务；失败可以留下空号，不能复用已预留号码。雪花 ID 有时间顺序，不是随机 ID，也不替代接口归属鉴权。

空库直接执行 `npm run db:migrate`。从旧 MySQL 产品库升级（本步实际路径）：备份旧库 → `npm run durable:pg` → `npm run db:migrate` → `npm run db:import-mysql`，命令与回滚方式见 `docs/plans/pi-durable-m4.md` §4。已执行的迁移保持原校验和。

执行 `npx vitest run tests/snowflake.test.ts tests/integration/snowflake-ids.test.ts`，核对位布局、序列耗尽、时钟回拨、三类主键、事务回滚、独立进程并发及导入。先执行 `npm run db:test:setup`，测试仅连接专用测试库，不调用模型。Drizzle 的 `.$defaultFn()` 是同步字段钩子，不能直接调用当前异步持久化发号器。

## 配置真实模型

在忽略的 `.env` 内设置 `AI_MODE=provider`、`AI_API_KEY`、`AI_MODEL` 和 `AI_BASE_URL`。模型服务必须支持 OpenAI 兼容聊天、工具调用及 JSON mode。首页创建应用时同步调用模型选择生成类型，生成及修改时再执行工具循环。配置只由服务端读取。

缺少模型配置时，生成请求返回明确错误。服务端不会自动改用 fixture。生产运行默认禁止 fixture。正式运行使用 provider，以下生产验收命令中的 `ALLOW_TEST_FIXTURE=1` 仅供本地测试。

## 模型统一管理

模型配置保存在产品 Postgres 库的 `model_provider` / `model_alias` / `model_config_state` 三张表，由 `migrations/001_initial.sql` 创建、`npm run db:migrate` 执行；迁移后执行一次 `npm run db:init-models`，把当前 `.env` 的 `AI_BASE_URL` / `AI_MODEL` / `AI_API_KEY` 写入数据库。初始化只在配置仍为初始空态时进行，已有配置不会被覆盖。类型分类等 Next 调用在配置仍为初始空态时保留环境变量兼容路径；生成入口要求产品库已配置并启用 `codegen.default`，或显式设置完整 `DURABLE_MODEL_*` 覆盖。读取失败不会静默选择另一模型。

`codegen.default` 驱动 harness 的应用生成（流式与工具调用），`route.classify` 驱动应用创建前的类型分类（结构化输出）。管理员在 `/admin/modelManage` 编辑提供商与别名；生成每轮重新读取配置，保存后对下一轮生效，在途运行保持原绑定。类型分类仍在 Next，通过同一模型注册表解析 `route.classify`，沿用 5 秒 TTL 与“保存并立即生效”的共享刷新序号。它只返回应用类型，不需要创建持久化生成会话。

提供商按 API 格式构造模型：`openai-chat`（OpenAI 兼容 `/chat/completions`，支持 `includeUsage`、`supportsStructuredOutputs`、`supportsMultiPartToolContent` 三个布尔选项，以及命名选项 `thinkingSwitch`）、`openai-responses`（OpenAI Responses API `/responses`）、`anthropic-messages`（Anthropic Messages API `/messages`）。后两种格式没有可配置协议选项，管理端会隐藏相应开关；提交该格式不支持的选项会返回 400。`thinkingSwitch` 只对 `openai-chat` 生效，取值 `none`（默认，不追加）、`enabled`、`disabled`；非 `none` 时在请求体追加 DeepSeek 的 `thinking: {"type": …}`。

每个提供商可额外配置一组自定义请求头（`headers`），单独存在 `model_provider.headers`（JSON），与协议选项分开。名称须是 RFC 7230 token（字母、数字及 `!#$%&'*+-.^_|~` 与反引号），大小写不敏感去重；值须是首尾无空白的可打印/扩展 ASCII（可编码为 ByteString）；最多 32 条，名称最多 128、值最多 1024 字符。`authorization`、`proxy-authorization`、`x-api-key`、`x-goog-api-key`、`api-key`、`host`、`content-length`、`connection`、`transfer-encoding`、`te`、`trailer`、`upgrade`、`keep-alive`、`proxy-authenticate`、`cookie`、`set-cookie` 由系统生成，不能自定义；鉴权仍走密钥来源，避免 SDK 与探测鉴权不一致。自定义头对三种格式的生成、流式与结构化调用都生效，也随「测试连接」「获取模型」的 `GET /models` 一起发送；上游错误回显这些值时，响应片段先脱敏再截断。示例：`User-Agent: paimeng-ai-code-mother/1.0`（本应用自己的标识，不是伪装成其他客户端）。OpenCode Go 那种每对话动态稳定的会话头（如 `x-opencode-session`）不是固定值，暂未接入。

别名弹窗的「思考强度」写入 `settings.reasoning`，取值 `none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`，留空表示不指定（不传思考参数）。SDK 的统一 `reasoning` 参数由 `src/server/models/adapters.ts` 的自定义 middleware 注入，各格式映射为：`openai-chat` → `reasoning_effort`；`openai-responses` → `reasoning.effort`（适配层同时打开 `forceReasoning`，否则上游会忽略未知模型名的思考配置）；`anthropic-messages` → `thinking` 预算（按 `max_tokens` 比例换算，最低 1024）。上游不支持的等级由上游自行拒绝，本项目不做收窄。

提供商弹窗的「测试连接」与别名弹窗的「获取模型」都会请求上游 `GET {baseUrl}/models`（`openai-chat` / `openai-responses` 用 `Authorization: Bearer`，`anthropic-messages` 用 `x-api-key` + `anthropic-version`），每次点击都会重新请求上游（带 `cache-control: no-cache`，不使用缓存）、10 秒超时、不跟随重定向、错误信息不回显密钥与自定义请求头的值；「获取模型」的结果只填充当前对话框的候选列表（最多 1000 条，命中上限时界面会提示可能被截断），不落库。密钥来源为“直接输入”且表单留空时，探测沿用数据库里已保存的密文。「获取模型」失败的原因会显示在别名的「上游模型名」下方。

生成的时长预算都在 `.env`：`GENERATION_TIMEOUT_MS`（毫秒，默认 `0`，表示不限制整次生成任务；旧版写死 10 分钟）；`MODEL_REPLY_TIMEOUT_MS`（毫秒，默认 `900000`）限制单次模型回复的时长，超时中止并记为「单次回复超时」；每个模型请求的失败重试次数由 `MODEL_RETRY_LIMIT`（默认 `5`，0-5）控制，请求阶段与流开始之后的失败共用这个上限。上游输出到达 token 上限（`finishReason = length`）不再判为失败：文件已经落盘就继续构建，模型可以在下一轮对话里根据构建结果补齐。

长对话上下文由 harness 的 pi-durable compaction 管理。用户消息、模型消息和工具结果保存在 harness 转录中，`GET app/messages` 直接从转录派生页面历史；产品库不保留另一份消息表或滚动摘要表。

密钥有两种来源。引用环境变量时只存引用名（`apiKeyEnv`），默认允许 `AI_API_KEY`，其余通过 `MODEL_API_KEY_ENV_ALLOWLIST`（逗号分隔）加入；直接输入时明文不落库，服务端用 AES-256-GCM 加密后只存密文（`apiKeyCiphertext`，格式 `v1:<iv>:<tag>:<ciphertext>`），主密钥取自 `MODEL_SECRET_KEY`（64 位十六进制、32 字节 base64 或任意口令，scrypt 派生），未设置时自动生成 `runtime/model-secret.key`（权限 600）。管理接口只返回 `apiKeySource` 与当前实例是否已配置，绝不返回明文或密文；编辑态密钥留空表示保持已保存的值。该密钥文件丢失后已保存的密钥无法解密，需要在管理端重新输入。

地址只允许无内嵌凭据、无查询、无片段的 HTTP(S)；`http:` 对本机与局域网地址（`localhost`、`127.0.0.0/8`、`10/8`、`172.16/12`、`192.168/16`、`::1`，例如自建网关 `http://127.0.0.1:8787/v1`）直接放行，其它来源的 origin 需写进 `MODEL_INTERNAL_BASE_URL_ORIGINS`（逗号分隔）。管理端可在已部署的密钥引用之间热切换；轮换环境变量里的密钥值需要更新进程环境并重启进程。

页面提示“保存成功”只代表服务端完成本地 schema、密钥引用与业务能力校验，不代表上游密钥或模型可用。「测试连接」/「获取模型」只验证地址与密钥能列出模型，不代表所选模型和格式一定能推理。

## 图片输入与语音输入

输入框支持附图（选择文件 / 粘贴 / 拖放），缩略图可删除与重试上传；发送后图片出现在消息气泡里，点击可放大。限制：JPEG/PNG/WebP，单张 5 MiB，单条消息最多 4 张且合计 12 MiB。上传接口 `POST /api/app/attachment/upload`（multipart：`appId` + 可重复的 `images`，仅创建者），读取接口 `GET /api/app/attachment?appId=&id=`（二进制，仅创建者）。消息里只存附件标识，服务端送模型时才读真实字节；历史轮次不重复发送图片，只留 `[图片：文件名]` 占位。上传的图会另存一份进工作区（静态 `assets/uploads/`、工程 `public/uploads/`），模型只有在用户明确要求时才应把它当页面素材引用。**要让生成模型能看图，必须在「模型管理 → 别名」里给该别名打开「图片输入」**（默认关闭，未开启时带图请求会被明确拒绝而不是静默失败）。

语音输入用浏览器 `MediaRecorder` 录音（最长 120 秒），转写后把文本追加进输入框（不自动发送）。转写走可选别名 `speech.transcribe`：在「模型管理 → 别名」里新增该别名，指向一个 OpenAI 兼容的 `/audio/transcriptions` 服务（例如 whisper），上游模型名填 `whisper-1` 之类的转写模型。**未配置该别名时麦克风按钮禁用并说明原因**，不会假装可用。音频上限 10 MiB，只接受 webm/ogg/mp4/mpeg/wav。

## 测试入口

| 命令 | 范围 | 依赖 |
| --- | --- | --- |
| `npm test` | 日常逻辑、文件与本地 HTTP 协议测试 | 无数据库、Docker 或浏览器；按启动时 CPU/内存余量并行 |
| `npm run test:integration` | 数据库、Redis 限流、harness、断连与重启 | Postgres 测试库和 Redis DB15，串行 |
| `npm run test:system` | 真实容器构建、浏览器截图与素材加载 | Postgres、Docker、Chromium，串行 |
| `npm run test:all` | 上述三组依次执行 | 完整环境 |

`npm test` 的 setup 会在测试尝试启动子进程、浏览器、Redis 客户端或访问产品数据库时直接报错，并指出正确目录。不要用跳过或空 mock 隐藏这些依赖；把需要它们的测试放进对应目录。日常改动先跑相关文件，构建/发布改动再跑 system。CI 自动执行同一个 `npm test`；完整环境检查可从 Tests workflow 的 `full` 输入手动触发。

## 运行完整测试

1. 执行 `npm run durable:pg` 确保本机 Postgres 已就绪，再执行 `npm run db:test:setup`。此命令确保同实例的 `paimeng_app_test` 与 `paimeng_agent_test` 存在，并在前者上执行测试库迁移。
2. 执行 `npm run type-check`。
3. 执行 `npm run test:all`。完整测试需要 Postgres、Docker 镜像和 Chromium，不会因缺少依赖而跳过相关检查。durable 回归用例（`tests/integration/durable-m1`）需要同一个 Postgres；没有 Postgres 时这组用例会打印原因并 skip。
4. 串行执行 `npm run test:e2e:isolated`。启动器负责构建并启动 Next、预览和独立端口的夹具 harness，强制使用两个 Postgres 测试库与 Redis DB15，等待健康检查并在退出时清理进程。默认使用 3000/3001；端口被开发栈占用时可设置 `E2E_APP_PORT=3020 E2E_PREVIEW_PORT=3021`，harness 端口默认自动分配，也可用 `E2E_HARNESS_PORT` 指定。
5. 执行 `npm run verify:boundary`，核对旧项目与已有删除状态。

集成测试在数据库操作前统一解析 URL，只将专用开发库或测试库映射到 `paimeng_app_test`；URL 不允许查询选项，防止测试连接目标含糊。`tests/integration/durable-m1` 的 harness 存储用 `paimeng_agent_test`。测试只清理自己创建的记录。隔离浏览器测试使用 `paimeng_app_test` 与 `paimeng_agent_test`，不会复用开发 harness。运行浏览器测试时一次只启动一个测试命令，避免报告目录被另一轮测试覆盖。

浏览器截图写入 `runtime/evidence/`，HTML 报告写入 `playwright-report/`。这些运行文件已被忽略。只验证默认入口跳转、注册登录、会话 Cookie 隔离与来源拒绝时，执行 `npm run test:e2e -- tests/e2e/platform-origin.spec.ts`。这两项浏览器回归测试不调用模型，也不需要预览服务运行。

验证短窗口、手机及横屏中的发送区域，以及点击发送和快捷键时，执行 `npm run test:e2e -- tests/e2e/chat-composer.spec.ts`。普通 Enter 发送，Shift + Enter 换行，Ctrl / Command + Enter 也可发送。测试使用独立样本账号和应用，通过浏览器拦截生成接口并返回 SDK 消息流，不调用真实模型。它验证发送操作和回复显示，不代表供应商模型生成质量已验证。聊天区域按动态视口高度限制消息区，输入框和发送按钮保持可见。

## 验证生产构建与重启

以下过程使用专用本地验收数据，不进行生产部署。停止开发进程后再构建，避免开发服务与生产构建同时写入 `.next/`。

1. 在开发或本地验收服务仍运行时，执行 `AI_MODE=fixture npm run verify:restart -- prepare`。脚本保存专用样本的会话、完整工具消息、生成状态及预览摘要。
2. 停止本目录的开发服务。保留 Postgres 和预览服务。
3. 执行 `ALLOW_TEST_FIXTURE=1 npm run build`。
4. 执行 `AI_MODE=fixture ALLOW_TEST_FIXTURE=1 npm start`，保持该进程运行。
5. 在另一个终端执行 `AI_MODE=fixture npm run verify:restart -- verify`。脚本核对保存的数据，下载源代码，并提交下一轮对话。
6. 执行 `npm run test:e2e`，验证构建后的页面及接口。

重新执行整套重启验证时，从 prepare 开始。快照包含本地验收会话 Cookie，文件使用仅当前用户可读写的权限，并位于忽略的运行目录。不要分享快照。

正式使用 provider 时，执行 `npm run build` 和 `npm start`。运行目录、数据库与模型配置仍由当前应用目录和服务端环境提供。Next.js 的构建追踪排除 `runtime/` 和 `.env`，运行数据不会打包进构建输出。

## 导入旧数据副本

本项目只接受 `paimeng_app` 或 `paimeng_app_test` 数据库名。它不会自动连接旧库（`npm run db:import-mysql` 需要显式给出 `MYSQL_LEGACY_URL`）。

## 从旧 MySQL 库搬迁业务行（一次性）

`npm run db:import-mysql` 把旧 MySQL 产品库的业务行搬进 Postgres：用户、应用、登录会话、附件、模型配置、限流与发号下界。按主键 upsert，可以重复执行。**对话数据不搬**（旧 `ts_message` / `chat_history` / `ts_app_summary` 放弃），`app.conversation_id` 一律留空，harness 在下次生成时重建会话。命令与回滚方式见 `docs/plans/pi-durable-m4.md`。

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
- 文件操作使用 pi-durable 的 `read/write/edit`；写入不检查产品形状。模板依赖集合、版本和锁文件在构建的 source 阶段核对，再在隔离容器里执行 `npm ci`、类型检查（Vue 用 `vue-tsc --noEmit`，React 用 `tsc --noEmit`）与 `vite build`。失败诊断交回模型，旧 `dist` 与预览保留，只有验证通过才替换产物。
- 新增模板：把目录放到 `templates/<id>/<version>/`，在 `projectTemplates` 注册，并在 `src/server/templates.ts` 的 `definitions` 里补文件清单、入口与类型检查命令。依赖必须落在该技术栈的允许集合内（Vue 为 `BUILD_DEPENDENCIES`，React 为 `REACT_DEPENDENCIES`）。

## 查阅实现与限制

[接口与模块契约](docs/implementation-contract.md) 描述权限、消息及任务状态。[迁移差异](docs/migration-contracts.md) 说明原路径和有意变更。[产物与隔离限制](docs/artifacts.md) 记录构建依赖、预览与本地封面行为。[决策与验收记录](docs/migrations/ts-unified/decisions.tsv) 保存实施证据。

支持 HTML、多文件、Vue 和 React 静态前端生成。模板构建、预览、下载、发布及本地封面均由产品服务负责；封面保存在 `runtime/covers/`。旧 Java/Vue 代码与 MySQL 容器保留归档，运行新平台无需启动旧应用。
