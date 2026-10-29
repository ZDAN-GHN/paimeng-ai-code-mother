# Pi Durable 数据模型设计（Postgres 迁移 · 第一阶段 · 交付二）

> 归档：记录当时的设计、迁移与验收。当前行为见[部署说明](../../pi-durable-deployment.md)与[模型配置](../../provider-convergence.md)。

> 历史文档：本文记录当时的状态。其中提到的 `src/server/memory-*.ts`、自研滚动摘要与 `spike/` 实验目录已随整合第三步删除，去向与判据见 [pi-durable-m3.md](pi-durable-m3.md) §7。

状态：**设计稿**（2026-10-18）。本文件在分支 `feat/pi-durable-migration` 上写成，只做设计，不含产品代码改动。可行性判据（Postgres storage 原型 + 官方一致性套件）见 `spike/pi-durable-pg/README.md`；上游 spike 的接口侦察与四实验结论见分支 `spike/pi-durable` 的 `docs/plans/pi-durable-migration.md`。

基线：`main@d0c9797`。现有库为 MySQL 8，表定义在 `paimeng-ai-code-agent/migrations/001..013`，Drizzle 映射在 `src/server/schema.ts`。

## 0. 一句话结论

pi-durable 已经把「会话 / 转录 / 任务 / 输入队列 / 文档」这套结构定好了，**对话历史这类表我们一张都不用自己设计**：`ts_message`、`ts_app_summary`、`ts_generation`、`ts_generation_lease`、旧的 `chat_history` 与围绕它们自研的窗口 / 摘要 / 游标 / 租约 / 插话注入代码可以整体删除。必须留下的只有真正属于业务的表（用户、应用、部署、附件、模型配置、限流、发号器），它们去掉 `ts_` 前缀后按业务域命名即可。唯一需要**新增**的是「应用 → pi-durable 会话」的映射。D2 记账有一半能被 pi-durable 的用量文档直接满足，另一半（逐轮 / 分类 / 可修复性账目）**不满足**，最小代价是保留一张任务级 / 一张步骤级的业务账目表。

## 1. pi-durable 现成的结构（我们不再自己造）

这一节回答「哪些结构直接用它的」。物理上它落在 8 张存储表里（`conversations`、`entries`、`tasks`、`submissions`、`documents`、`document_revisions`、`record_ids`、`durable_metadata`，见 `spike/pi-durable-pg/src/pg-storage.ts` 的迁移），但**我们不直接写这些表**，只通过 `Storage` 接口读写的语义结构是：

| pi-durable 结构 | 语义 | 取代我们现在的什么 |
| --- | --- | --- |
| `conversations` | 会话身份、fork 祖先、创建者归属。`ROOT_CONVERSATION_ID = 1` 保留 | 「一个应用一条对话」这件事的载体（我们原先是 `ts_message.appId` 隐式表达） |
| `entries` | 转录条目：`pi.user` / `pi.system` / `pi.assistant` / `pi.tool-result` / `pi.compaction`。每条带 `model`（给模型的 messages）与 `data`（给 UI 的 JSON），`head` / `edits` 支持上下文裁剪 | `ts_message`（聊天消息）、`chat_history`（旧 Java 历史）、`src/server/tool-transcript.ts` 生成的 Java 约定历史文本 |
| `tasks` | durable 任务记录：`GenerationTask`（每轮生成）/ `ToolTask`（每次工具调用）/ `CompactionTask`。带 `input`、`checkpoint`、`outcome`（completed / failed / aborted / orphaned / faulted）、`startedAt` / `endedAt`、`abortRequested` | `ts_generation`（任务态 + stopReason + error + messageId）、`ts_generation_lease`（单应用单生成） |
| `submissions` | 用户输入的受管生命周期（queued / placed / done / unanswered）、`requestId` 会话内去重、`whenBusy: steer \| follow-up \| reject` | `POST app/chat/steer` 的 409 语义 + `agent.ts` 的 `prepareStep` 插话注入；`pi.inbox` 文档是排队/插话队列的读模型 |
| `documents` + `document_revisions` | 作用域为 session / conversation / task 的 JSON 文档，支持 latest / rewindable 历史、fork、按 `Seq` 的 point-in-time（`findDocument(address, at)`）。内容以 JSONB + chord delta 存 | `ts_app_summary`（滚动摘要 + 两个覆盖游标 + 乐观并发 version） |
| 内置文档 `pi.live` | 当前生成的流式 partial、工具槽、压缩状态、失败 | `generation-feedback.ts` 的部分归约、`data-progress` 事件的中间状态 |
| 内置文档 `pi.usage` | 会话累计用量：`models[provider/modelId]`、`tools[toolName]` | D2 的一部分（见 §5） |
| 内置文档 `pi.provider` | 会话身份（UUIDv7），pi-ai 用它填 `x-opencode-session` 路由头 | `models.json` 里的 `sendSessionAffinityHeaders` 开关 |
| 内置文档 `pi.inbox` / `pi.agent` | 插话/排队队列、agent 状态 | 自研队列与状态 |

已实测：真实对话（01）、compaction（02）、`kill -9` 续跑（03，工具/模型/replay-safe 三种）在 Postgres 后端上行为与 SQLite 后端一致。所以这几类结构「现成可用」不是纸面结论。

## 2. 因此可以删除的自建表与自研代码（「少写代码」清单）

**可以删除的表**

| 表 | 去向 |
| --- | --- |
| `ts_message` | pi-durable `entries` |
| `ts_app_summary` | pi-durable `pi.compaction` 条目 + `CompactionTask` 的 checkpoint（覆盖游标由 `head` 表达） |
| `ts_generation` | `GenerationTask` 任务记录（`status` / `error` / 生命周期都在 outcome 与时间戳里） |
| `ts_generation_lease` | 单会话单活跃 run（`submit({ whenBusy })` + 任务态） |
| `chat_history`（旧 Java） | 放弃（见 §6） |

**可以整段删除的自研代码**（文件名按当前主工作区）

| 代码 | 现在做什么 | 迁移后 |
| --- | --- | --- |
| `src/server/memory-window.ts`、`memory-context.ts`、`memory-consolidate.ts`、`memory-serialize.ts`、`memory-types.ts`、`memory-step.ts` | 上下文窗口、滚动摘要、覆盖游标、逐轮记忆 | 全部由 compaction（阈值两档：阻塞 / 后台）取代 |
| `src/server/generation-store.ts` 中的窗口 / 游标 / 租约部分 | 生成租约与历史窗口 | 由会话 busy 与 `entries` 扫描取代 |
| `src/server/agent.ts` 的 `prepareStep` 插话注入、`POST app/chat/steer` 的路由与 409 分支 | 中途插话 | `submit({ whenBusy: "steer" })` + `pi.inbox` |
| `src/server/agent.ts` 的 `retryableStreamErrors` / `streamRetrySettings` 包装 | 流式重试（传输层断裂转错误 part） | `settings.retry` + `settings.stream`（**有未验证项**，见 §7） |
| `src/server/tool-transcript.ts` 的历史文本格式 | 把工具调用渲染成模型可读文本 | 模型上下文直接由 `entries.model` 组成，不再需要这层文本化（UI 展示由 `entries.data` 承担） |
| `src/components/chat/generation-feedback.ts` 的时间线归约 | 把 `data-progress` 归约成时间线 | 订阅 `viewState()` / `watch()`（前端契约要重写） |
| `src/server/generation-instructions.ts` 里的上下文拼装（保留业务提示词部分） | 系统提示拼装 | 由扩展的 `sections` 每轮重渲 |

**不能直接删的**：SSE 保活（`agent.ts` 的 `buildKeepAliveMs`、`http.ts` 的 `withHeartbeat`）。原因是项目已复现的坑：构建阶段容器 `npm ci` 15–25s 无字节 + 容器启动引发的链路状态变化会让 Firefox 掐断连接（见项目约束 #40/#41）。pi-durable 的进度提交只在**状态发生变化**时产生，构建工具静默执行期间同样没有字节。迁移后要么把构建输出通过工具 `api.output()` 流出去（推荐，顺带解决可观测性），要么保留心跳。这一条**与 storage 后端无关**，先记下。

## 3. 必须留下的业务表与命名映射

原则：去掉 `ts_` 前缀，按业务域命名；`app`、`user` 这类已经是对的（`user` 在 Postgres 里不能作为无引号表名使用——实测 `CREATE TABLE user(...)` 语法错误，所以它加域前缀）。

| 旧名 | 新名 | 理由 |
| --- | --- | --- |
| `user` | `app_user` | 业务名保留，但 Postgres 无引号不允许 `user` 做表名；加域前缀避免到处加引号 |
| `app` | `app` | 已符合（应用）。迁移 013 的 `deployedRuntimeUrl` / `databaseUser` / `databasePasswordCiphertext` 继续挂在它上面（部署与应用 1:1） |
| `ts_session` | `user_session` | 登录会话属用户域 |
| `ts_snowflake_state` | `id_sequence` | 业务主键发号器（应用的雪花 ID）；与 pi-durable 自己的 `mintId` 是**两个独立命名空间**，互不影响 |
| `ts_rate_limit` | `rate_limit` | 限流，基础设施 |
| `ts_model_provider` | `model_provider` | 模型域（提供商、API 格式、密钥密文、自定义头） |
| `ts_model_alias` | `model_alias` | 模型域（别名 → provider/modelName + capabilities/settings） |
| `ts_model_config_state` | `model_config_state` | 模型域（配置 revision / refreshEpoch，热更新用） |
| `ts_attachment` | `attachment` | 附件域（原图 objectKey、派生 previewKey、尺寸、hash） |
| `ts_message` | —（删） | → `entries` |
| `chat_history` | —（删） | 旧 Java 数据，放弃 |
| `ts_app_summary` | —（删） | → `pi.compaction` |
| `ts_generation` | `generation`（可选保留，见 §5） | 任务态交给 `GenerationTask`；若要「应用/用户维度的审计行」再保留一张 |
| `ts_generation_step` | `generation_step`（可选保留，见 §5） | 用量/耗时逐轮账目 |
| `ts_generation_lease` | —（删） | → 会话 busy |
| （新增） | `app.conversation_id`（列）或 `app_conversation`（表） | 应用 ↔ pi-durable `ConversationId` 的映射，见 §4 |

**模板**：模板不是数据库表，是 `paimeng-ai-code-agent/templates/` 下的文件树（`static-templates` 用例守着），迁移不涉及。

**命名细节**：现有列名是 camelCase（`appName`、`userId`、`createTime`）。Postgres 会把无引号标识符折叠成小写，camelCase 列必须处处加双引号。建议这次改写统一用 snake_case 列名（`app_name`、`user_id`、`create_time`），否则每个查询都要带引号，容易漏。这是机械改动，但要一次性做干净。

## 4. 新增：应用 ↔ 会话映射

pi-durable 的会话 ID 由它自己铸造（root = 1，其余 `mintId()`），我们记不住。当前模型是「一个应用一条对话」，所以最小改动是给 `app` 加一列：

- `app.conversation_id bigint NULL` —— 第一次为该应用开对话时写入；为空表示还没聊过。
- 语义：一个 app 恰好一条 conversation。这与现状（`ts_message.appId` 分桶）一致。
- 如果以后要「一个应用多条分支对话」，再升级成 `app_conversation(app_id, conversation_id, title, ...)` 表；现在不要提前建。

会话创建时用 `ownership: { kind: "ownerless" }`（顶层的、由外部请求驱动的会话），由 `Harness` 管理调度。

## 5. D2 记账：pi-durable 能满足多少、最少要补什么

现有记账（迁移 010/011）：`ts_generation`（任务级：`status`、`stopReason`、`messageId`、应用/用户）+ `ts_generation_step`（每步一行：`kind = model | summary | build`、`round`、`stepNumber`、`durationMs` / `modelMs` / `toolMs`、五类 token、`finishReason`、`status`、`stage`、`repairable`、`toolCalls`）。

**能直接满足的**

- **每条回复的用量块**（产品需求「一条回复一个用量块」）：pi-ai 的 `AssistantMessage` 自带 `usage`，随 `entries` 一起持久化。前端按条目读即可，**不需要业务表**。现在需要 `ts_generation.messageId` 把用量挂到消息上，迁移后这个链接天然存在（用量就在那条 assistant 条目里）。
- **会话累计用量**：`pi.usage` 文档（`models[provider/modelId]`、`tools[toolName]`），配套 `harness.usage()`。
- **任务级生命周期**：`GenerationTask` 的 outcome（completed / failed / aborted / faulted）、`startedAt` / `endedAt`、`input` / `checkpoint`。`stopReason` 的绝大多数取值（正常结束、步数、超时、取消、模型失败）都能映射到 outcome + 我们写进 `input` 的业务字段。`input` 是我们自定义的，可以塞 `appId` / `userId`，所以「按应用/用户查生成」也可以走 `scanTasks({ kind: "generation", conversationId })`。
- **工具耗时**：`pi.tool-result` 条目与 `ToolTask` 结果自带 `durationMs`。

**不能满足的**

- **逐轮 / 分类账目**：`pi.usage` 是**按 provider/model 累计的汇总**，不是逐次账目；compaction 的摘要调用也并进 `models` 桶，无法与正常模型调用区分。所以「第 N 轮、kind = model/summary/build、这一轮各类 token 多少」这种行它给不出。
- **`repairable` / `stage`**：构建失败的可修复性分类是我们业务逻辑（`build-feedback.ts` 的 `classifyBuildFailure`），不在 pi-durable 的模型里。
- **构建尝试的独立账目**：构建是我们自定义的 `ToolTask`，它的 `durationMs` 在，但 token 不是模型的，语义与 `model` 行不同。

**最小补充**（不要过度设计）

1. **保留 `generation` 一条任务级业务行**（去掉 `ts_` 前缀），因为 pi-durable 的任务记录不携带我们的 `appId` / `userId` 业务身份，而前端「历史回复」与按应用列表需要它。列与现在基本一致，`stopReason` / `messageId` 保留。
2. **保留 `generation_step` 逐轮账目**，仅当「构建修复成功率」这类统计还要用（`eval:repair` 的产物）。它在迁移后由扩展 hook（`GenerationTask` / `ToolTask` 的 `hook`）继续写，不依赖 storage 后端。
3. 如果这两条都不需要（作品集展示为主，不做统计），可以**连这两张表一起删**，用量展示完全走条目自带 usage + `pi.usage`。这是「少写代码」与「保留审计」之间的取舍，建议先按 1 保留、2 延迟决定。

## 6. 旧数据处理

现有 MySQL 里的消息 / 生成 / 摘要数据只存在于开发与测试库（项目是作品集性质，用户与数据都是本机造的）。建议：

- **业务行搬过去**：`user` / `app` / `model_*` / `attachment` / `rate_limit` / 登录会话。这些用一次性脚本按新表名与 snake_case 列重建即可，量小。
- **对话数据放弃**：`ts_message` / `chat_history` / `ts_app_summary` / `ts_generation*` 不迁。理由是转录格式完全不同（pi-durable 的 `entries` 是「模型 messages + UI data」的双通道，且压缩、head、fork 语义都在里面），做一次保真迁移的收益远小于成本，而旧数据没有保存价值。
- 迁移本身（MySQL → Postgres）是另一件事：Drizzle schema 要从 `mysql-core` 改成 `pg-core`，查询里的 `?` 占位符、`ON DUPLICATE KEY`、`COLLATE`、自增语法都要重写。这属于「Postgres 迁移」的常规工程量，本文只标注它存在，不算设计难点。

## 7. 未决与风险

1. **单进程独占 storage**。`Storage` 契约要求单写者（`commit` 由 Session 串行、`mintId` 必须跨重开全局单调）。Postgres 本身允许多连接，但契约不允许两个进程同时铸 ID。原型用 `pg_advisory_lock` 强制「一进程一个 storage」，第二个进程 `open()` 直接失败。当前部署（多请求共享一个 MySQL）要变成「一个写进程持有会话存储，其他客户端只读/订阅」，水平扩展受限。要水平扩展需要「单写进程 + attach」或改写契约，后者不建议。
2. **传输层断裂是否自动重发未验证**。上游 spike 的模型中断都是进程级 `kill -9`；「连接被浏览器/中间层掐断但进程还活着」（正是 #40/#41 那类）没有复现。我们现在的 `retryableStreamErrors` 就是为它写的，迁移前必须单独验证 `settings.retry` / `settings.stream` 是否覆盖。
3. **SSE 保活不可删**（见 §2）——除非把构建输出流出去。
4. **前端契约要重写**。现在是自定义 `data-progress` 等 SSE 事件；迁过去要改成订阅 `viewState()` / `watch()`，`generation-feedback.ts` 的时间线归约大部分作废。
5. **列名大小写**（§3）需要在改写 Postgres 业务表时一次定清。
6. **文档化身 / point-in-time 语义**：已在 Postgres 原型上通过一致性套件（`findDocument(address, at)`、rewindable、fork、delta 重放），但**产品层还没用到**，实际用法（例如「回到某条消息重新生成」）还需在集成阶段验证。

## 8. 复现

可行性判据（Postgres storage 原型 + 官方一致性套件 + 三实验）的复现步骤与实测数字见 `spike/pi-durable-pg/README.md`。设计结论（本文件）不依赖运行，可单独阅读。
