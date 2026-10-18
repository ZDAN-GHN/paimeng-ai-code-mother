# Pi Durable 学习笔记（面试复盘用）

状态：学习笔记（2026-10-18）。不是设计稿，不改代码。基线分支 `feat/pi-durable-migration`。
上游权威文档：`node_modules/@earendil-works/pi-durable/README.md`（768 行，字段级语义都在这）。
本文只做「挑重点 + 映射到我们的代码 + 面试怎么讲」，细节以那篇 README 为准。

---

## 0. 一句话

**pi-durable 是一个「可持久化的 agent 宿主」：会话、模型轮次、工具调用、你自己定义的状态，
在被展示给任何人之前先提交进存储；进程中途死掉，重开同一个存储就从断点继续。**

它解决的是普通 agent 循环（`while(messages) { model → tool → model }` 全在内存里）解决不了的三件事：
进程崩溃、用户断连、上下文无限增长。上游自己标注 **Experimental**，API 会在版本间变。

依赖三件套（读代码时先分清边界）：

| 包 | 管什么 | 我们代码里的痕迹 |
| --- | --- | --- |
| `@earendil-works/pi-ai` | 模型访问：provider、流式、思考等级、token 用量 | `harness.ts` 的 `createProvider` / `openAICompletionsApi` |
| `@earendil-works/chord` | 响应式状态与文档层；`Context` 携带取消信号 | 每次调用末尾都传的 `context`、`BACKGROUND_CONTEXT` |
| `@earendil-works/pi-durable` | 会话、条目、任务、提交、压缩、工具、扩展 | `Harness.open(...)`、`defineTool`、`CodingTools` |

---

## 1. 为什么我们要换（改造成本换回了什么）

改造前（`main@d0c9797`）是自研的：AI SDK 循环在 Next.js 请求的处理函数里跑，`req.signal` 接进生成
AbortController，`ts_message` / `ts_generation` / `ts_generation_lease` / `ts_app_summary` 是自建表，
`memory-*.ts` 自研窗口与滚动摘要，`prepareStep` 自研插话注入。

引进 pi-durable 后删掉的东西（`pi-durable-m3.md` §7.1 有文件级清单）：
`memory-window.ts` / `memory-context.ts` / `memory-consolidate.ts` / `memory-serialize.ts` /
`memory-store.ts` / `memory-types.ts` / `memory-model.ts` 七个文件、`agent.ts` 里约 570 行旧循环、
`ts_message` / `ts_app_summary` / `ts_generation_lease` 三张表。

换回来的四条能力（也是面试时最该讲的卖点）：

1. **断连 ≠ 取消**。旧实现把请求信号接进生成，浏览器一掉线生成就死。新结构里 http 请求的
   `AbortSignal` **只**作用在 SSE 视图那一个 `watch` 上，任务上下文拿不到它，所以在结构上不可能发生。
2. **`kill -9` 能续跑**。任务每步把 checkpoint 提交进存储，重开同一存储 `resume()` 就从上一个 checkpoint 继续。
3. **上下文增长交给框架**。compaction（两档阈值 + 手动）取代自研窗口/摘要/游标。
4. **转录只有一份真相**。条目同时带「给模型的 messages」和「给 UI 的 JSON」，不再需要把工具调用
   序列化成文本喂模型（`tool-transcript.ts` 只剩「给人读的历史文本」这一个用途）。

---

## 2. 核心概念（9 个，必须能顺口解释）

按「打开 → 提交 → 跑 → 恢复」的顺序记：

| 概念 | 一句话 | 关键点 |
| --- | --- | --- |
| **Harness** | 一个打开的 storage + 在上面跑 agent 的全部机械 | `Harness.open(storage, {models, registry, settings, env}, context)`；`resume()` 续跑；`closed` 在关闭/存储故障时 settle |
| **Conversation** | 一个转录（transcript）；`root()` 首次用时创建 | 句柄本身不持状态，用 `id` 比较；可 `fork()` |
| **Entry** | 不可变的转录记录 | 内置 kind：`pi.user` / `pi.assistant` / `pi.tool-result` / `pi.system` / `pi.reset` / `pi.compaction`；也能自定义 kind（我们用了 `app.user`） |
| **Commit** | 一次原子写 | `conversation.commit(tx => ...)` 可以在同一个提交里追加条目 + 改文档 + 建任务，全成或全不成 |
| **Document** | 和转录放在一起的类型化 JSON 状态 | `pi.agent`（模型/工具/cwd）、`pi.provider`（会话身份 UUIDv7，填 `x-opencode-session`）、`pi.live`（进行中的 partial 与工具槽）、`pi.inbox`（排队输入）、`pi.usage` |
| **Task** | 每步存 checkpoint 的持久状态机 | 内置 `pi.generation`（一轮生成，拥有它这轮所有 `pi.tool`）/ `pi.tool`（一次工具调用）/ compaction 任务 |
| **Submission** | 交给会话的一次输入，可等待 | `submit({type:"input", content, requestId?}, ctx)`；相同 `requestId` 重放不重复提交；`whenBusy: "steer" \| "follow-up"(默认) \| "reject"` |
| **Extension / Registry** | 具名的工具+提示词段+钩子+任务包；Registry 是进程装了哪些 | 会话里**存的是名字**，代码卸载后只是暂时不生效；同名后装的替换先装的 |
| **Agent** | 一条会话跑什么：模型、思考等级、扩展、工具、指令、cwd | 存进 `pi.agent`；每次使用才对 registry 解析；改配置从下一次请求生效 |

两个容易混的词：

- **turn**：一次模型响应 + 它的工具调用。
- **run**：从一次输入到最终答复之间的所有 turn。会话在 run 进行中就是 busy。

一次「问了答」的条目/任务形状（面试可以画这个）：

```text
submit(input)          → pi.user
  pi.generation        → pi.system（提示词或工具变了才写）、pi.assistant（带 tool calls）
    pi.tool × n        → pi.tool-result × n（由这次 generation 拥有并等它跑完）
  pi.generation        → pi.assistant（最终答复）→ submission done
```

---

## 3. 三条硬规则（「durable」到底靠什么成立）

### 3.1 展示前先提交（commit before show）

`viewState()` / `watch()` 给 UI 的一切都是**已提交状态**；部分输出默认每 100ms 提交一次
（`settings.progress.partialIntervalMs` / `outputIntervalMs`）。崩溃最多丢这 100ms。
→ 管理层含义：UI 刷新/重连不需要「补做」，读存储就有。

### 3.2 每个副作用都是一个独立 task + 显式 replay 策略

`defineTool({...})` 的每次调用是它自己的持久任务，**intent 在 `execute()` 之前提交**。进程在调用中途死：

- `replay: "safe"` → 重开后**重跑**；
- 否则（默认 `"unsafe"`）→ 模型拿到一个 `interrupted` 错误结果 + 已经提交的输出，**不重跑**。

我们每个工具都显式声明了（`src/server/durable/harness-server.ts`，`GET /tools` 可读回）：

| 工具 | replay | 判据 |
| --- | --- | --- |
| `readFile` / `listFiles` | safe | 纯读 |
| `writeFiles` | safe | 写**完整内容**，同参重跑得到同样字节 |
| `modifyFile` | **unsafe** | 精确匹配替换不幂等（要么二次生效，要么匹配已消失而报错） |
| `deleteFile` | **unsafe** | 重跑时文件已不在 |
| `buildPreview` | safe | 同源码同产物，先 stage 再原子替换 dist |
| `m1_wait` | unsafe | 刻意留着钉「被中断的工具不重跑」这条语义（`tests/integration/durable-m1/restart.test.ts`） |
| 联网四个工具 | 三个 safe、`importImage` unsafe | 读类安全；落盘类不安全 |

**这是一道高频面试题**：「你怎么判断哪些工具能重放？」答案是**按副作用幂等性判断，且默认必须是不安全**——
框架语义是宁可丢一次执行，也不重复副作用。

### 3.3 单写者（one process owns a storage）

`Storage` 契约要求**一个进程独占**（提交由 Session 串行、`mintId` 必须跨重开全局单调），
框架**自己不提供跨进程锁**。我们用 `pg_try_advisory_lock` 强制：第二个进程 `open()` 直接抛
`Postgres storage is already open by another process`（`src/server/durable/storage-pg.ts`）。

→ 这就是为什么产品稳态是「一个常驻 harness + 可多份 Next（attach 客户端）」，
水平扩展只在 Next 层成立（见 `pi-durable-deployment.md` §1.4）。

---

## 4. 一次生成在我们系统里的完整链路

```text
浏览器 (app/chat/<id>)
  │  POST app/chat/gen/code                GET /api/durable/.../agent-events (SSE/NDJSON)
  ▼
Next 进程（attach 客户端，不打开 storage）
  │  src/server/durable-engine.ts：beginGeneration 落业务行/限流/租约
  │  → POST /submit /configure /abort；GET /agent-events（request.signal 只作用这一个）
  ▼
harness 常驻进程（唯一写者，127.0.0.1:5599）
  │  Harness.open(PostgresStorage) → 会话 root()/resume()
  │  pi.generation → 模型 → pi.tool(buildPreview → 真实 docker buildApp)
  ▼
Postgres（业务库 paimeng_app + 存储库 paimeng_agent，同实例两库）
```

三个必须记住的限界：

1. **`request.signal` 只允许传给 `/events` 这一条 watch。** POST/submit 路径拿不到任何信号，
   所以「浏览器掉线 = 取消生成」在结构上不可能发生。旧实现是反例，注释里点名了旧代码的行号。
2. **SSE 保活不能删。** 构建阶段容器 `npm ci` 15–25s 无字节，而**状态没变化就不会有提交/事件**；
   加上宿主机新建容器 = veth 变化会让 Firefox 掐断连接（项目约束 #40/#41）。所以观察者每 1s 补一个
   `started` 事件保活。
3. **harness 与 Next 必须看到同一份 `runtime/`。** Next 的最终验证和 harness 的 `buildPreview`
   调的是同一个 `buildApp`；不共享就会出现「构建成功但预览空」。

---

## 5. 代码地图（按「改哪里看哪里」整理）

| 文件 | 行数 | 职责 | 读它的理由 |
| --- | --- | --- | --- |
| `src/server/durable/harness.ts` | ~150 | 组装：provider（OpenAI 兼容）、`CodingTools`、`NodeExecutionEnv`、`onReport`、`durableModel()` 的 compat 开关 | **最短的一篇**，先读它建立全局 |
| `src/server/durable/harness-server.ts` | ~940 | 常驻进程：路由（`/submit` `/events` `/state` `/configure` `/abort` `/tools` `/conversations`）、产品工具实现、产品事件 → harness 事件的翻译、构建容器清扫 | 产品语义都在这里；工具与 replay 表也在这 |
| `src/server/durable/storage-pg.ts` | ~1100 | 自研 Postgres `Storage` 后端：9 张表、事务、`mintId`、`pg_advisory_lock`、`resetPostgresStorage` | 想看「框架的存储契约长什么样」就读它 |
| `src/server/durable/faux-model.ts` | ~80 | 确定性桩模型 | 测试为什么不需要 API key |
| `src/server/durable-engine.ts` | ~1040 | 产品侧 attach 客户端：app↔会话映射（`app.conversation_id`）、事件翻译成前端既有 UI 流、记账落库、租约心跳与取消 | **产品与框架的接缝**，面试最容易被问的一段 |
| `src/app/api/durable/[...path]/route.ts` | — | Next 侧 attach 代理；鉴权（`requireUser` + `getApp` 所有权，管理员不例外）在代理之前 | 讲「权限边界在哪」 |
| `scripts/durable-dev.ts` | — | 一条命令起全套：探端口 → 按需起 Postgres → 起 harness（从 `~/.pi/agent/models.json` 派生 `DURABLE_MODEL_*`）→ 轮询 `/health` → 起 Next | 讲本地怎么复现 |
| `tests/integration/durable-m1/*` | 11 文件 | 契约级回归：断连、重启、replay 策略、插话、附件、构建工具、路由鉴权、联网 | 每条对应一个你能讲的故事 |

命令：`npm run durable:harness`、`npm run durable:pg`、`npm run dev:durable`。

---

## 6. 面试加分点（我们踩过、别人一般没踩过）

1. **单写者的锁是库级的。** `pg_try_advisory_lock` 的锁在 `pg_locks` 里带 `database` 列，
   所以两个 harness 指到**不同库**会各自成功，然后各铸各的 ID。部署必须断言所有 harness 的
   连接串指向同一个存储库。
2. **崩溃重放时应用映射不能只在内存里。** 我们踩过：重启后的构建报「会话 7 没有关联应用」，
   因为映射原先只存在进程内存，而重放发生在任何请求到达之前。修法是从持久化的
   `pi.agent.cwd`（`<runtimeRoot>/code_output/<codeGenType>_<appId>`）还原
   （`appRefFromWorkspace` + `conversationOf` 惰性回填）。
3. **compaction 有两档阈值**：`reserveTokens`（到 `contextWindow - reserveTokens` 就阻塞等下轮压缩）
   与 `backgroundTokens`（还差这么远就先在后台压）。provider 报上下文过长时会压缩后重试一次。
   摘要花掉的 token 也进 `pi.usage`。
4. **插话不需要自己写注入点。** `submit({whenBusy:"steer"})` 由框架放在当前工具轮之后、加入正在跑的 run；
   我们旧实现是在 `ToolLoopAgent` 的 `prepareStep` 里手动注入 messages 的。
5. **`pi.inbox` 是排队输入的读模型**，`submission.abort()` 撤回、`whenBusy:"reject"` 抛 `ConversationBusy`——
   旧实现这条语义是自己写的 409。
6. **会话身份 `pi.provider` 是 UUIDv7**，作为 `sessionId` 转发给 pi-ai 用于 provider 侧 prompt cache 与
   会话粘性；它跨重开/重试/重置/压缩/换模型存活，fork 会拿到新的。
7. **前端是订阅结构状态，不是消费自定义事件。** 两种消费方式：`viewState()`/`watch()`（结构性状态 +
   每次提交的 chord ops）与 `watchEvents()`（编码 agent 风格的 `message_start` / `tool_execution_update` …）。
   我们目前用后者翻译成前端既有协议（`data-progress`），所以前端一行未改——这是**兼容性折中**，
   不是框架的推荐形态。
8. **故障语义分三层**（README「Errors」）：存储错误**终止整个 Harness**（`SessionFailed`，之后所有等待都 reject，
   重开才能恢复）；非法请求只失败那一次调用；你自己的代码只失败自己那个单元（工具抛异常 → 错误结果，
   钩子抛异常 → 上报后跳过，提交回调抛异常 → 回滚这次提交）。
9. **`pi.usage` 是汇总不是账目。** 它按 `provider/model` 累计（压缩的摘要调用也并进同一个桶），
   给不出「第 N 轮、kind=model/summary/build、各类 token 多少」。所以我们要**保留**
   `generation`（任务级）与 `generation_step`（逐轮）两张业务表——这是「框架能替代什么、不能替代什么」
   的最好例子。
10. **`stopWhen` 类陷阱的等价物**：框架里对应的是 compaction 与重试都在 `settings` 里（每次读取、从不存储），
    所以可以写成 getter 让配置热生效。

---

## 7. 阅读顺序（三遍法）

**第一遍（30 分钟，建立词汇）** — 只读上游 README 的
Concepts → Persist and Resume → Extensions → Tools 四节，读完能解释上面 §2 那张表。

**第二遍（1 小时，看骨架）** — 按这个顺序读我们的代码，每段只求「知道它在干什么」：
`harness.ts` → `durable-engine.ts` 顶部注释与 app↔会话映射 → `harness-server.ts` 的路由段 →
`tests/integration/durable-m1/restart.test.ts`（最短的一条 durable 故事）。

**第三遍（面试前，背故事）** — 读 `pi-durable-data-model.md` §1（框架现成结构 vs 我们自建的表）
与 §5（记账能替代多少）、`pi-durable-m2.md` §7（工具表 + replay 判断 + 那次真实缺陷）、
`pi-durable-deployment.md` §1.1（三个组件各独占什么）+ §5（风险与取舍）。
这三节就是「为什么这么设计」的全部论据。

---

## 8. 面试问答速记

| 问 | 答（要点） |
| --- | --- |
| 「durable」指什么？ | 状态在被展示之前先提交；每个副作用是一个带 replay 策略的持久任务；进程死后重开存储从 checkpoint 续跑。 |
| 和普通 agent loop 差在哪？ | 普通循环的状态只在内存；这里条目/文档/任务都在 commit 里原子写，且 UI 只读已提交状态。 |
| `kill -9` 后一定能续跑吗？ | 不一定。能续跑的是「任务记录 + 至少一个 checkpoint」；不安全工具只给模型 `interrupted` 错误结果不重跑；不可重放脚本按 journal 重放到同一路径。 |
| 断线为什么不再取消生成？ | 请求信号只传给 SSE 视图那一个 `watch`；提交路径与任务上下文接触不到 socket。 |
| 为什么只能一个 harness 进程？ | storage 契约要求单写者（提交串行 + `mintId` 全局单调），框架无跨进程锁；我们用 `pg_try_advisory_lock` 强制。 |
| 上下文太长怎么办？ | compaction：保留最近 `keepRecentTokens`，超过 `reserveTokens` 阈值阻塞，`backgroundTokens` 提前后台压；摘要落成 `pi.compaction` 条目，旧条目留在存储。 |
| 中途插话怎么做的？ | `submit({whenBusy:"steer"})`；框架在工具轮边界放置，不需要自己写注入点。 |
| 你们的记账为什么没全删？ | `pi.usage` 是按模型汇总的，没有逐轮/分类/可修复性；保留 `generation` + `generation_step` 两张业务表补这块。 |
| 存储挂了会怎样？ | 整个 Harness 失败关闭，之后所有等待 reject（`SessionFailed`）；提交是原子的，所以重开是自洽的，用同一 `requestId` 重提不会重复。 |
| 迁移最大的风险？ | 单写者带来的可用性/扩展限制（Postgres 成单点、harness 不能多开）、以及传输层断裂是否被 `settings.retry`/`settings.stream` 覆盖尚未验证。 |

---

## 9. 术语对照

| 上游 | 我们代码里的叫法 |
| --- | --- |
| Harness / Session | harness 进程（`harness-server.ts`） |
| Conversation | 会话；`app.conversation_id` 指向它 |
| Entry | 条目；产品里 `app.user` 是我们自定义的 kind |
| Document | 文档；我们直接用的有 `pi.agent` / `pi.live` / `pi.inbox` / `pi.usage` / `pi.provider` |
| Task | 任务；`pi.generation` / `pi.tool` |
| Extension | 扩展；我们装了 `CodingTools` + 产品工具集 |
| Execution Environment | `NodeExecutionEnv`；工具只用它碰文件与进程 |
