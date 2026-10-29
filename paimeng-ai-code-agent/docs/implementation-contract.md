# 实现契约

## 数据与 HTTP 边界

所有新实现位于 `paimeng-ai-code-agent/`。旧项目只读，业务 API 不代理旧 Java 服务。公共类型定义在 `src/shared/contracts.ts`。

JSON 成功响应为 `{code:0,data,message:"ok"}`。失败返回业务错误码和对应 HTTP 状态。所有业务 ID 使用十进制字符串，数据库使用 BIGINT。用户、应用和文本聊天历史的新增主键统一由 `src/server/snowflake.ts` 生成，计算及查询使用 `bigint`，不读取数值型 `insertId`。

雪花 ID 保留 MyBatis Flex 1.11.1 的 epoch `1680411660000` 和 41 位时间、5 位数据中心、5 位机器、12 位序列布局。同毫秒序列耗尽后等待真实时钟推进。回拨不超过 5 毫秒时等待恢复，超出容忍值拒绝发号。生成值限定在正的有符号 64 位范围，对外返回十进制字符串。

当前 TS 平台明确使用数据中心 0、机器 0，所有接入同一 Postgres 库的进程共享 `id_sequence` 行锁与已提交下界。发号短事务在业务事务取得行锁前提交，业务失败允许留下空号但不能回退发号状态。此策略替代原 JVM 的 MAC 与 PID 推导，不声称与旧运行进程使用相同节点。独立数据库与未参与协调的旧 Java 发号器不在此唯一性保证内。

业务主键不接受数据库发号（Postgres 侧 `app_user.id` / `app.id` 等既不是 identity 也不是 serial，只有记账表 `generation_step.id` 用自增序列），仅改变插入策略。已有 ID、关联字段及源码目录保持不变。生成任务使用请求 UUID 作为主键，UI 消息 id 用雪花 ID 或请求 UUID 派生的确定性 id。

管理 API 挂载 `/api`，校验请求来源。所有 POST 请求需要精确匹配 `APP_ORIGIN` 的 Origin，读取请求体时按实际 UTF-8 字节数限制为 100000 字节。会话使用独立的 `paimeng_ts_session` Cookie，服务端只存令牌摘要。角色读取当前数据库记录，不依赖客户端声明。

## 用户 API

- POST `/api/user/register` 接收 `{userAccount,userPassword,checkPassword}`，返回用户 ID。
- POST `/api/user/login` 返回用户安全视图，并设置会话 Cookie。
- GET `/api/user/get/login` 返回当前用户，POST `/api/user/logout` 撤销当前会话。
- GET `/api/user/get/vo?id=` 返回公开用户视图。GET `/api/user/get?id=` 要求管理员。
- POST `/api/user/list/page/vo`、`/api/user/update` 和 `/api/user/delete` 要求管理员。

用户视图不返回密码摘要。密码使用带盐 scrypt。导入的旧 MD5 摘要只在新库登录成功后升级。删除用户撤销其会话，管理员不能删除当前登录账号。

## 应用 API 与权限

- POST `/api/app/add` 接收 `{initPrompt,codeGenType?,templateId?}`，返回应用 ID。`templateId` 只接受已注册模板，未知模板返回 400 `不支持的工程模板`；显式模板与 `codeGenType` 冲突时返回 400 `模板与应用类型不匹配`。所有新建应用按类型自动套用模板：HTML 为 `html`，多文件为 `multi-file`，Vue 为 `vue-ts`，React 为 `react-ts`，初始化只在此时发生一次。
- 首页技术栈下拉默认「自动选择」，也可显式选择原生 HTML、原生多文件、Vue + TypeScript、React + TypeScript 四种模板之一。自动选择时创建按钮可用，仅提交 `{initPrompt}` 走 AI 路由；显式选择时提交 `{initPrompt,templateId}`。API 未指定 `templateId`/`codeGenType` 时仍同步调用 `routeCodeGenType` 模型路由，并按类型自动套对应模板；简单展示、多文件静态页面、复杂交互分别选择 HTML、多文件、前端工程。工程类型里需求明确要求 React 或 Vue 时按需求选，未指明技术栈时默认 Vue，因此路由可以返回 `react_project` 并自动使用 React 模板。用户也可以在首页技术栈下拉里显式指定模板，此时以用户选择为准。显式类型仍供 API 和测试使用。初始需求上限为 1000 字。
- GET `/api/app/get/vo?id=` 返回公开应用信息，其中 `template` 给出模板 id 与版本，未使用模板的旧应用为 null。
- POST `/api/app/my/list/page/vo` 返回当前用户的应用分页。POST `/api/app/good/list/page/vo` 返回优先级至少 99 的精选应用。
- POST `/api/app/update` 接收 `{id,appName}`，只允许创建者修改名称。
- POST `/api/app/delete` 接收 `{id}`，允许创建者或管理员逻辑删除应用。
- POST `/api/app/deploy` 接收 `{appId}`，GET `/api/app/download/{appId}` 返回 ZIP。这两项只允许创建者。
- 管理员使用 `/api/app/admin/list/page/vo`、`/api/app/admin/get/vo?id=`、`/api/app/admin/update` 和 `/api/app/admin/delete`。

管理员更新可修改名称、封面及优先级。管理员可读取应用消息和任务状态，不能为其他创建者生成、取消、下载或发布。应用编辑页允许创建者或管理员进入，管理员保存调用管理接口。普通及管理员更新均记录 `editTime`，与 `updateTime` 分开保留。

应用查询支持名称、封面、初始提示词、发布密钥、生成类型、优先级及归属筛选。排序字段来自显式合法列名单，包括部署时间、编辑时间及用户 ID；历史分页遵从合法排序字段与方向，不接受任意 SQL 字符串。

## Agent 消息与任务

POST `/api/app/chat/gen/code` 接收 `{appId,message:UIMessage,requestId:UUID}`。只接受一条用户文本消息，拒绝客户端伪造的系统消息及历史字段。服务端锁定应用后读取权威历史，工具目录绑定当前应用。生成不在 Next 进程里执行：请求提交给常驻的 pi-durable harness 进程（唯一写者，`DURABLE_HARNESS_URL`，默认 `http://127.0.0.1:5599`），Next 只做 attach 客户端与 SSE 转发，所以浏览器断连只停止转发，harness 里的任务照常跑完（`npm run dev` 一条命令起 Postgres + harness + Next）。一个应用对应 harness 里恰好一条会话（`app.conversationId`）；映射指向不存在的会话时清掉重建。

- GET `/api/app/messages?appId=` 返回完整 `UIMessage[]`，包括工具输入、输出、状态及文本。
- GET `/api/app/generation?appId=` 返回当前 `Generation` 或 null。
- POST `/api/app/generation/cancel` 接收 `{appId}`，请求取消当前任务。只在模型仍在写文件时生效；文件已写完进入构建后忽略该请求，构建继续完成，避免丢弃已经生成好的代码。
- GET `/api/chatHistory/app/{appId}?pageSize=10&lastCreateTime=` 返回原文本历史分页。
- POST `/api/chatHistory/admin/list/page/vo` 返回管理员历史分页。

消息、任务及应用历史要求创建者或管理员权限。生成与取消只允许创建者。

任务状态包括 `generating`、`building`、`ready`、`failed` 和 `cancelled`。每个应用只有一个活动任务。同一个请求 UUID 不重复执行。生成限流默认按用户每 60 秒 1 次，跨应用共享，可用 `CHAT_RATE_LIMIT_TYPE`（`API`/`USER`/`IP`）、`CHAT_RATE_LIMIT_RATE`、`CHAT_RATE_LIMIT_INTERVAL`、`CHAT_RATE_LIMIT_MESSAGE` 覆盖。计数保存在 `rate_limit`，与任务创建在同一事务内，位置在重复请求与租约检查之后，锁顺序为 app_user → app → rate_limit。

`IP` 类型沿用旧版转发头信任模型，要求可信前置代理覆盖 `X-Forwarded-For`/`X-Real-IP` 并阻止直连；无这两个头时直连请求共用 `ip:unknown`。超限请求随事务回滚，不消耗次数。
生成输入沿用旧版护轨：总文本不超过 1000 字、不能为空，并拒绝原敏感词和注入模式。可视化定位上下文包含在这个总长度内。模型上下文由 harness 进程自己管理（pi-durable 的会话转录按容量阈值压缩），平台没有自研的窗口/滚动摘要层：原 `MEMORY_*` 环境变量、`memory-*.ts` 与滚动摘要表已随整合第三步删除，表本身也随换 Postgres 一并清掉。平台不再有自己的消息表：完整消息与全部历史作为 pi-durable 条目持久保存在 harness 存储里，供页面恢复和查询，原始消息不删减。


对话转录（UI 消息与工具结果）的权威存储是 harness 的条目表：用户气泡随 `/submit` 的 `entry` 落成 `app.user`（`data` 通道放前端要渲染的 `UIMessage`），助手气泡直接由 pi 的原生条目派生——`pi.assistant` 是一条模型消息（文本块 + 该条目的工具调用）、`pi.tool-result` 按 `toolCallId` 并进对应工具调用，产品不再写 `app.assistant` 展示副本；`GET app/messages` 经 harness `/messages` 读回整条转录后由 `loadMessages` 投影成 UI 消息，UI 消息 id 就是条目 id；本次生成第一条 `pi.assistant` 条目 id 写进 `generation.message_id` 供用量块挂载。终态与租约释放仍在一个事务里完成（`src/server/generation-store.ts` 的 `finishGeneration`）。任务状态包括 `generating`、`building`、`ready`、`failed` 和 `cancelled`。每个应用只有一个活动任务。同一个请求 UUID 不重复执行。取消与超时只中止 harness 里仍在跑的那次运行（任务行仍是权威，由每 5 秒一次的租约心跳发现）；模型跑完后的服务端最终验证与修复轮由生成入口自己驱动，见下段。

服务端拥有构建验证权：每轮模型结束后先 `buildApp`，失败且诊断能定位到生成源码时把诊断交回模型，最多 `BUILD_REPAIR_ROUNDS`（默认 2）轮；源码指纹未变则用原始构建错误结束，不做空转。整次生成的时长上限由 `GENERATION_TIMEOUT_MS` 决定（默认 `0` 表示不限制），失去租约的旧进程不能覆盖新任务；模型调用失败的重试（含流已经开始后的 provider 错误）由 harness 进程按其 provider 配置处理，客户端只看到可读文案，原始错误留在 harness 日志里。

React 聊天页使用 AI SDK POST 流式协议。创建者首次进入空历史、无任务的新应用时自动提交初始需求一次；已存在任务、历史或历史加载失败时不会自动提交。刷新后加载服务端完整历史，工具结果保留。公开应用信息独立于私有历史和任务请求加载。

`previewUrl` 根据实际 HTML 或 Vue 构建入口是否有效判断，不以最新任务的 ready 状态为门槛。旧应用及下一轮失败、取消后仍有效的既有产物可继续预览；生成、发布和下载之间仍受写入租约保护。`sourceAvailable` 独立表示可下载源码；Vue 每次发布都在写锁内重新构建当前源码，构建失败时保留旧预览并拒绝此次发布。

POST `/api/app/build` 接收 `{appId}`，按应用现有源码重建前端预览产物，不改变任务状态、不发布。只允许创建者调用，`HTML`/`multi_file` 应用或已有有效预览时直接返回当前 `previewUrl`，没有源码时返回 409，构建失败原样返回错误。同一应用 60 秒内只尝试一次，避免源码本身有错时反复构建。聊天页在源码存在但预览产物缺失时自动调用一次该接口，因此取消生成或构建中断不再需要用户手动点「部署」才能看到预览。任务结论与应用可用状态分开呈现：预览已经可用时，历史失败只显示为提示条（说明当前预览由已有代码构建，可以继续预览、编辑或部署），状态标签按能否预览显示，不把历史失败当成当前阻塞。

## 文件与产物模块

`src/server/workspace.ts` 定义 `WorkspaceApp`，包含应用 ID 和生成类型。它提供工作目录解析，以及列出、读取、写入、精确修改和删除源文件的工具。

`src/server/artifacts.ts` 提供 `buildApp`、`deployApp`、`downloadApp`、`previewUrl`、`deployedUrl` 和 `captureCover`。源码与发布文件位于本目录的 `runtime/`，不写入旧产物。

`src/server/preview.ts` 创建独立静态预览 HTTP 服务，启动入口为 `scripts/dev/preview.ts`。封面及生成页面与管理端使用不同主机名。配置由 `src/server/config.ts` 校验。Vue 构建只在隔离 Docker 环境运行，详细限制见 [产物、构建与预览限制](./artifacts.md)。

## 模型配置与解析

模型配置保存在产品 Postgres 库的 `model_provider`、`model_alias`、`model_config_state` 三张表（`migrations/001_initial.sql`，列名 snake_case：`api_format`、可空 `api_key_env` 与 `api_key_ciphertext`、`headers` JSONB）。部署顺序为 `npm run db:migrate` 后执行一次 `npm run db:init-models`；初始化只在配置仍为空且版本为零时把环境变量写入 DB，已有配置不会被覆盖。表已迁移且为空时，解析临时用环境变量构造两个别名；读取失败不等于表空，不会回退环境变量。DB 初始化后 DB 是唯一来源。

两个业务别名固定为 `codegen.default` 与 `route.classify`；`src/server/model.ts` 分别解析，生成入口在任务开始时解析一次并把绑定冻结到整次生成（记账行用它，模型调用由 harness 进程按其自己的 provider 配置完成）。注册表 `src/server/models/registry.ts` 每个进程缓存不可变快照，普通保存经 5 秒 TTL 生效，TTL 从一致读事务开始计时；手动生效通过共享 `refreshEpoch` 让其他实例在下一次解析时跳过 TTL。快照读取在单个 REPEATABLE READ 只读事务中完成。

配置写入在事务中锁定 `model_config_state` 的 `models` 行并检查 `expectedRevision`，版本以十进制字符串传输。版本冲突返回 409（`40901`），引用冲突/必需别名保护返回 409（`40902`），载荷校验失败返回 400（`40000`），DB 不可用返回 503（`50300`）。引用中的提供商不能删除，必需别名不能删除、禁用或指向已禁用提供商。

管理接口（管理员会话，POST，含 Origin 校验）：

| 方法与路径 | 功能 |
| --- | --- |
| POST `/api/model/admin/config` | 读取完整配置与当前实例状态 |
| POST `/api/model/admin/provider/upsert` | 新建或修改提供商，载荷含 `expectedRevision`、可选 `applyImmediately` |
| POST `/api/model/admin/alias/upsert` | 新建或修改别名 |
| POST `/api/model/admin/provider/delete` | 删除未被引用的提供商 |
| POST `/api/model/admin/alias/delete` | 删除非必需别名 |
| POST `/api/model/admin/apply` | 已保存配置立即生效 |
| POST `/api/model/admin/provider/models` | 按当前填写（或已保存）的地址与密钥请求上游 `GET {baseUrl}/models`（每次调用都实时请求，带 `cache-control: no-cache`），返回 `{models: [{id, label}]}`，最多 1000 条 |

所有写操作返回 `{revision, refreshEpoch}`。提供商按 `apiFormat`（`openai-chat` / `openai-responses` / `anthropic-messages`）构造模型；协议选项按格式白名单校验，提交该格式不支持的选项返回 400/40000（布尔选项 `includeUsage`、`supportsStructuredOutputs`、`supportsMultiPartToolContent` 只属于 `openai-chat`；命名选项 `thinkingSwitch`（`none`/`enabled`/`disabled`）同样只属于 `openai-chat`，非 `none` 时在请求体追加 `thinking:{type}`）。别名的 `settings.reasoning`（`none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`）经适配层的自定义 middleware 注入 SDK 统一参数，映射为 `openai-chat` 的 `reasoning_effort`、`openai-responses` 的 `reasoning.effort`（同时打开 `forceReasoning`）、`anthropic-messages` 的 `thinking` 预算；DeepSeek 的 Responses 格式用 `response.reasoning_text.*` 事件与 `content[].reasoning_text` 承载思考，SDK 只认 `response.reasoning_summary_text.*`，因此该格式的响应先经 `src/server/models/responses-reasoning.ts` 改写（只改写 `delta` 事件，`.done` 透传，非流式把 `content` 复制成 `summary`）。密钥有两种来源：`apiKeySource='env'` 只存引用名（`apiKeyEnv`，须在允许名单内，`AI_API_KEY` 始终允许，其余通过 `MODEL_API_KEY_ENV_ALLOWLIST` 加入）；`apiKeySource='inline'` 的明文不落库，用 AES-256-GCM 加密后只存 `apiKeyCiphertext`，主密钥取自 `MODEL_SECRET_KEY`，未设置时自动生成 `runtime/model-secret.key`（0600）。接口只返回 `apiKeySource` 与当前实例是否已配置，绝不返回明文或密文；编辑态密钥留空表示保持已保存的值。地址只允许无内嵌凭据、无查询、无片段的 HTTP(S)，`http:` 对本机/局域网字面量（`localhost`、`127.0.0.0/8`、`10/8`、`172.16/12`、`192.168/16`、`::1`，只判字面量、不解析域名、不含 `169.254/16`）直接放行，其它 origin 需出现在 `MODEL_INTERNAL_BASE_URL_ORIGINS`。提供商还可配置一组自定义请求头（`headers`，JSONB 存在 `model_provider.headers`，与 `options` 分开）：名称须为 RFC token、大小写不敏感去重，值须为首尾无空白的可打印/扩展 ASCII（可编码为 ByteString），最多 32 条，名称 128、值 1024 字符；`authorization`、`proxy-authorization`、`x-api-key`、`x-goog-api-key`、`api-key`、`host`、`content-length`、`connection`、`transfer-encoding`、`te`、`trailer`、`upgrade`、`keep-alive`、`proxy-authenticate`、`cookie`、`set-cookie` 属系统生成，提交即 400；鉴权值始终由密钥来源生成。这些头在三种格式的生成、流式与结构化调用中都会发送，也随探测的 `GET /models` 发送；上游错误回显时先对密钥值与自定义头值脱敏再截断。探测接口入参非法返回 400/40000，上游不可用返回 502/50200，错误信息不回显密钥；密钥来源为 `inline` 且载荷留空时，服务端沿用已保存的密文。管理页面 `/admin/modelManage` 的“保存成功”只代表服务端本地校验通过，不代表上游密钥或模型可用。

别名的 `capabilities.imageInput`（默认 `false`，旧行解析后补齐）声明该别名能否看图：用户消息带图片附件而该别名未开启时，生成请求在开始前返回 400/40000 并说明怎么开启，不把上游原始报错丢给用户。图片附件的契约在 `src/shared/attachments.ts`：白名单 JPEG/PNG/WebP、单张 5 MiB、单条消息最多 4 张且合计 12 MiB、解码后最多 2000 万像素、送模型前最长边 2048。上传走 `POST /api/app/attachment/upload`（multipart：文本字段 `appId` + 可重复的文件字段 `images`，仅应用创建者；该通道在 `guardRequest` 与 JSON 体积上限之前分流，自行做来源校验与 13 MiB 上限），读取走 `GET /api/app/attachment?appId=&id=`（二进制、仅创建者、非本人 403）。消息里的图片只存附件标识与展示信息，不存 base64 或临时 URL；服务端在 `validateUIMessages` 之前把附件 part 摘出来，按轮次把真实字节作为 file part 追加到最后一条 user 消息，历史轮次只留 `[图片：文件名]` 占位，不重复上传字节；上传原图另存进工作区（静态 `assets/uploads/`、工程 `public/uploads/`），文件名清洗路径分隔符与控制字符，写入上限对齐 5 MiB。语音转写是可选别名 `speech.transcribe`（OpenAI 兼容 `POST {baseUrl}/audio/transcriptions`，未配置时 `GET /api/app/chat/transcribe` 返回 `enabled:false` 且 `POST` 返回 409/40900），录音由浏览器 `MediaRecorder` 完成、最长 120 秒，转写文本只追加进输入框不自动发送；音频上限 10 MiB，只接受 webm/ogg/mp4/mpeg/wav，密钥在 `speech.ts` 内现场解析、不挂到共享绑定对象上。

DB 读取失败时，冷启动无快照返回 503；已有快照时可在距上次一致读开始 60 秒内降级沿用；已观察到更高 `refreshEpoch` 却加载失败时返回 503，不用旧配置冒充生效。失败后有约 1 秒退避，只暂缓整份快照重载，不阻断共享刷新序号探测，因此退避窗口内出现的更高 `refreshEpoch` 不会被旧绑定掩盖。
