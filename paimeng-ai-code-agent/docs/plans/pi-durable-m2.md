# Pi Durable 迁移 · M2a：把生成入口接到 harness

状态：**已跑通**（2026-10-18）。分支 `feat/pi-durable-migration`，基线 `main@d0c9797`（M1 提交 `4edbdd0`/`1554dcc`/`345d60a`）。
设计输入是 `docs/plans/pi-durable-data-model.md`；M1 的链路与证据见 `docs/plans/pi-durable-m1.md`。

## 0. 一句话结论

产品的生成入口现在可以走 harness：`DURABLE_ENGINE=harness` 时，`POST app/chat/gen/code` 把输入提交给
常驻 harness 进程（`app.conversationId` 指向的会话），观察它的事件流再翻译成**既有的前端协议**，
前端一行没改。三条验收都实测通过：① 真实模型 + 真实 Postgres 下浏览器看到流式与工具条目；
② 同一应用第二次生成时，第二轮开始前的模型上下文里有第一轮的 token 与 `index.html`，模型不调用任何
工具就答出了第一轮的随机 token；③ 断连后任务继续跑完（`abortRequested=false`）、重连读到完整结果。
旧 AI SDK 路径原样保留，默认仍是它。

## 1. 改动清单

### 1.1 映射：一个应用一条会话

| 位置 | 改动 |
| --- | --- |
| `migrations/013_app_conversation.sql` | 新增 `app.conversationId BIGINT UNSIGNED NULL`：第一次为该应用生成时写入，NULL 表示还没生成过（data-model §4） |
| `src/server/schema.ts` | `apps` 加同名列（`mode:'number'`，会话 id 是小整数） |
| `src/server/business.ts` | `appView` 把 `conversationId` 从响应里摘掉：它是生成入口的内部映射，不属于前端契约 |
| `src/server/durable-engine.ts` 的 `conversationFor()` | 读取/创建：没有会话就 `POST /conversations`（`ownership: ownerless`、工作区是 `workspace(app)`），再把 id 写回 `app.conversationId` |

### 1.2 生成入口接到 harness

新增 `src/server/durable-engine.ts`（唯一的引擎实现，约 380 行），`src/app/api/[...path]/route.ts` 按开关分流：

| 位置 | 改动 |
| --- | --- |
| `route.ts` | `app/chat/gen/code`：`getConfig().durable.engine === 'harness'` 走 `harnessChatResponse`，否则走原来的 `chatResponse`；`app/generation/cancel` 同理走 `harnessCancelGeneration` |
| `harnessChatResponse` | 复用 `beginGenerationContext` 落库这次生成与用户消息（任务态、限流、租约语义都不变）→ `conversationFor(app)` → `POST /submit`（**提交完才去观察**）→ 返回同一种 UI 消息流 |
| `observeHarnessRun`（自带生命周期，调用方不 await） | 等 harness 报出这次会话的活跃运行 → `GET /agent-events?conversationId=` 读 NDJSON 事件 → 翻译成 `text-start/text-delta`、`tool-input-available/tool-output-available`、`data-progress`（files / ready / failed / cancelled）→ `finishGeneration` 落库助手消息 |
| `harnessCancelGeneration` | 任务态复用 `agent.cancelGeneration`（同一张表、同一份租约），另外 `POST /abort` 让 harness 里的会话立即停 |
| `ChunkChannel` | 观察线程 → HTTP 流的通道；**客户端断开只让转发停下**，观察与任务不受影响 |
| `src/server/agent.ts` | 只把请求体 schema 导出成 `generationRequestSchema`，两个引擎共用同一份校验（`inputSchema` 改名） |
| `src/server/generation-instructions.ts` | 加 `previewTool?: boolean`（默认 true = 原样）。harness 只有文件工具，false 时不提 `buildPreview`，也不再写「本轮没有构建工具」以外的构建命令 |
| `src/server/config.ts` | 新增 `DURABLE_ENGINE`（`legacy`/`harness`，默认 `legacy`）与 `DURABLE_HARNESS_URL`（默认 `http://127.0.0.1:5599`），暴露成 `getConfig().durable` |
| `.env.example` | 补上这两个变量的说明与默认值 |
| `scripts/durable-m1-dev.ts` | 给 Next 子进程显式设 `DURABLE_ENGINE`（默认 harness）与 `APP_ORIGIN=http://localhost:<appPort>`：产品的写接口（`guardRequest`）要求来源等于 `APP_ORIGIN`，而 Next 在 3100 上 |

### 1.3 harness 进程（spike）

`spike/pi-durable-m1/src/server.ts` 从「单会话验证服务」扩成「产品生成入口需要的会话服务」，仍然
只监听 `127.0.0.1`、仍是 storage 的唯一写者：

| 接口 | 语义 |
| --- | --- |
| `POST /conversations` | 建一条 `ownerless` 会话（`workspace` + 常驻 `instructions`），返回 `conversationId` |
| `POST /submit` | 带 `conversationId` 时提交到该会话，缺省仍是 root（M1 的脚本不受影响） |
| `POST /abort` | 中止某条会话的活跃运行（取消用） |
| `GET /agent-events?conversationId=` | **NDJSON**，一行一个 agent 事件（`message_start/update/end`、`tool_execution_start/end`、`run_end`、`task_failed`…），每秒一行 `{type:"ping"}` 保活（约束 #40/#41），随 `run_end` 结束 |
| `GET /conversations` | 只读：本进程开过哪些会话、各自的工作区（验收脚本按工作区反查会话） |
| `GET /context?conversationId=` | 只读：该会话的**模型上下文**（`messages` 的角色与文本），是「第二次生成看得到第一次痕迹」的证据接口 |
| `GET /events` `GET /state` | 原有，加 `conversationId` 参数；`/state` 的 `view.live.busy` 用来判断这次会话是否在跑 |

工具集换成产品那套：`readFile` / `writeFiles` / `modifyFile` / `deleteFile` / `listFiles`（外加 M1 脚本用的
`m1_wait`）。**框架自带的 `CodingTools` 不再安装**（`openPgHarness({ codingTools: false })`）：它带的
`bash` 能跑任意 shell，而产品明确不提供 shell —— 第一次验收跑出过模型调用 `bash` 的实况，已修掉。

### 1.4 限界（必须保留）

`harnessChatResponse` 里 HTTP 请求的 `AbortSignal` **没有**传进 `submit()` 或任务 context：
`stop` 是本引擎自己建的控制器，只在两处用得上——心跳发现任务被取消 / 生成超时，以及观察用的
`GET /agent-events` 这条 `fetch`。浏览器断连（`createUIMessageStream` 的 `execute` 被取消）只让
`ChunkChannel` 的转发停下。这与 M1 固化下来的不变量一致（`agent.ts:224` 的
`req.signal → controller.abort` 是老反例）。

### 1.5 验证脚本与用例

| 文件 | 作用 |
| --- | --- |
| `spike/pi-durable-m1/src/product.ts` | 产品接口客户端：注册/登录、建应用、读任务与消息、读 harness 的 `/conversations` `/context` `/state` |
| `spike/pi-durable-m1/src/verify-m2a.ts` | 验收 ①+②：浏览器两轮生成、流式与工具条目采样、截图、模型上下文对照 |
| `spike/pi-durable-m1/src/verify-m2a-reconnect.ts` | 验收 ③：跑到一半关掉整个浏览器，断言任务继续、结果完整落库、重连可读 |
| `spike/pi-durable-m1/src/verify-browser.ts` | M1 的浏览器脚本，提示词里的 `write` 改成 `writeFiles`（工具集换了） |
| `tests/integration/durable-m1/conversation.test.ts` | 新增：桩模型下「按会话隔离提交 + 第二次提交的模型输入里有第一次的工具结果」，无 Postgres 时 skip |
| `tests/integration/durable-m1/support.ts` | 桩模型进程支持 `workspace` / `tool` / `args`（`SPIKE_FAUX_TOOL` / `SPIKE_FAUX_ARGS`） |
| `spike/pi-durable-pg/src/faux-model.ts` | 加 `SPIKE_FAUX_ARGS`：脚本里那次工具调用可以用任意参数（例如 `readFile {path}`） |
| `tests/generation-instructions.test.ts` | 加一条：`previewTool: false` 时提示词里没有 `buildPreview` |

## 2. 切换开关

```bash
DURABLE_ENGINE=legacy   # 默认。现有 AI SDK 循环，产品行为不变
DURABLE_ENGINE=harness  # 生成提交给常驻 harness 进程，需要先起它
DURABLE_HARNESS_URL=http://127.0.0.1:5599
```

两套引擎共用 `app/chat/gen/code` 的请求体（`generationRequestSchema`）与前端 SSE 协议，切换只影响
「生成由谁执行」。`npm run dev:durable-m1` 起 Postgres（已在跑就复用）+ harness + Next（3100，
默认 `DURABLE_ENGINE=harness`、`APP_ORIGIN=http://localhost:3100`）。

## 3. 验收证据（真实运行）

环境：Postgres 55432（`spike/pi-durable-pg/pg.sh`，一次性容器）、模型 `oc-go/deepseek-v4.1-flash`（真实
HTTP 调用，`run.sh` 从 `~/.pi/agent/models.json` 派生密钥）、Next 16 dev `localhost:3100`、真实 Chromium。
原始输出与截图在 `spike/pi-durable-m1/evidence-m2a/`（`timeline-m2a.txt`、`timeline-reconnect.txt`、
`m2a-round{1,2}-{streaming,final}.png`、`reconnect-final.png`、`round{1,2}-model-context.json`、`stack.log`）。
回放：`npm run dev:durable-m1` → `cd spike/pi-durable-m1` → `npm run verify:m2a` / `npm run verify:m2a-reconnect`。

### 3.1 ① 一次真实生成经 harness 跑通（浏览器）

`timeline-m2a.txt`（文件是追加写的，最后一段就是最终代码状态的那次，`VERDICT: 7/7 assertions passed — PASS`）：

```
round1: 气泡长度序列=["0ms:0","2877ms:462","4150ms:543","38815ms:16757","41141ms:16835","41434ms:16879","41721ms:16920","42034ms:17132"]
round1: 工具条目=["列出文件","读取文件 AGENTS.md","读取文件 index.html","读取文件 .paimeng-template.json","写入文件 index.html"]
ASSERT A1 浏览器看到流式输出: PASS — 不同的气泡长度=[462,543,16757,16835,16879,16920,17132]
ASSERT A2 浏览器看到工具条目: PASS
ASSERT A3 助手消息带工具条目落库（刷新可读回）: PASS
```

流式增量是真的逐段到达（462 → 543 → 16757 字符，采样间隔 250ms，采样点 8 个不同的长度），
工具条目是产品既有的卡片文案（`tool-call.tsx` 的 `labels`），说明前端渲染层没有因为引擎变化而退化。
截图 `m2a-round1-streaming.png`（生成中）与 `m2a-round1-final.png`（完成）。

### 3.2 ② 同一应用第二次生成看得到第一次（最关键的断言）

同一份时间线：

```
round1 后模型上下文：11 条消息 / 11 条条目
ASSERT B1 第二轮开始前模型上下文里有第一轮的 token: PASS — 上下文里 命中 M2A1-5590E6
ASSERT B2 模型上下文里有第一轮写入的 index.html: PASS — 上下文里 命中 index.html
round2 答案："M2A1-5590E6"   round2 工具调用：[]
ASSERT B3 模型凭上下文答出了第一轮写入的 token: PASS
ASSERT B4 第二轮结束后上下文里仍有第一轮的工具结果: PASS — 条目=13
```

`M2A1-5590E6` 是每轮随机生成的 token，第一轮提示模型把它逐字写进 `index.html` 的 HTML 注释里；
第二轮明确要求「不要调用任何工具、不要读取文件，只凭上下文回答」，模型一次就答对了，且
`round2 工具调用：[]`（真的没有回读文件）。第二轮开始前的模型上下文原文在
`round1-model-context.json`：11 条消息里有第一轮的 `pi.tool-result`（`index.html` 全文）与随机 token。
这一条对应「重复探索」的根因——同一应用的多次生成复用同一会话（`app.conversationId`），不复用就是
每轮从零 `listFiles` + `readFile`。

### 3.3 ③ 断开重连（产品路径）

`timeline-reconnect.txt`（`VERDICT: 7/7 assertions passed — PASS`）：

```
断连前浏览器画面：{"text":39,"tools":[]}
浏览器已关闭
ASSERT D1 断连后任务仍在跑（无 abort）: PASS — harness tasks=[{"kind":"pi.generation","state":"waiting","abortRequested":false},{"kind":"pi.tool","state":"running","abortRequested":false},{"kind":"pi.tool","state":"running","abortRequested":false}] 产品状态=generating live.busy=true
重连页面在生成中看到的提示："正在生成或构建，请稍候…"
任务结束 status=ready，断连后 68s
ASSERT D2 断连后生成照常跑完并落库: PASS — 答案结尾="… M2A-RECONNECT-OK" 工具=["listFiles","readFile","readFile","readFile","writeFiles","modifyFile","listFiles"]
ASSERT D3 没有取消痕迹: PASS — 产品状态=ready stopReason=completed
ASSERT D4 harness 转录里没有 aborted: PASS — 条目=14 kinds=["pi.user","pi.system","pi.assistant","pi.tool-result"]
ASSERT D5 重连页面看到任务仍在跑: PASS
ASSERT D6 重连后读到完整结果: PASS — 工具条目=["列出文件","读取文件 AGENTS.md","读取文件 index.html","读取文件 .paimeng-template.json","写入文件 3 个文件","修改文件 style.css"]
ASSERT D7 写入结果没有重复（断连没有触发重跑）: PASS — 写入结果=["已写入 index.html、about.html、style.css"]
```

断连发生在生成开始后约 4 秒（两个工具调用正在跑），关掉整个浏览器后任务又跑了 68 秒才结束
（这一轮模型自己决定多写几个文件、还调了一次 `modifyFile`）；断连瞬间所有任务 `abortRequested=false`，
最终 `stopReason=completed`（不是 `cancelled`），转录里没有 aborted。D7 判的是「写入类结果文本没有重复」：
断连触发的重跑会把同一个调用再执行一遍、产生两条一模一样的工具结果，而模型自己分几次写文件是正常的
（第一次写时断言「只发生一次」就把正常行为判失败过，已改成这个判据）。这是 M1 那个
「浏览器掉线 = 取消生成」根因在**产品路径**上的复现与验证，不只是 spike 脚本。

### 3.4 回归测试

```bash
spike/pi-durable-pg/pg.sh start          # 需要 Postgres（55432）
cd paimeng-ai-code-agent
npx vitest run tests/integration/durable-m1    # 4 文件 8 用例全过（含新增的 conversation.test.ts）
npx tsc --noEmit                                # 干净（两个包：app 与本 worktree 的 spike/pi-durable-m1）
npx vitest run tests/generation-instructions.test.ts tests/agent-loop.test.ts \
  tests/tool-call-view.test.ts tests/generation-feedback.test.ts tests/memory-config.test.ts \
  tests/workspace.test.ts tests/password-config.test.ts tests/test-database-url.test.ts   # 8 文件 61 用例全过
npm run check:ui / npm run check:e2e            # 通过（没改 tsx 与 e2e）
```

`conversation.test.ts` 用桩模型（无真实模型、无 Docker）钉住 harness 侧接口：`POST /conversations` 的
工作区真的被工具用到（桩工具读只存在于应用工作区的文件）、提交按 `conversationId` 隔离（root 会话保持空）、
第二次提交的模型上下文里仍有第一次的工具结果。没有 Postgres 时打印原因并 skip。

未跑：本项目全量 `npm test`（约 11 分钟，含容器构建）与全量 E2E —— 按项目约束 #26/#27 由主 agent 串行跑。

## 4. 卡点与已知取舍

1. **`pi.live` 的 partial 是节流提交的**：文本块有时以整块（`block`）、有时以整条消息（`message`）
   的形式下发，只吃 `text_delta` 会把一次回复的头尾吃掉（实测第一轮丢掉开头、最后一轮少 20 字）。
   `AssistantTurn` 现在按内容下标维护权威文本块，并把「没送达的部分」补成增量；`message_end` 带的
   条目是权威版本，用它兜底。
2. **中途插话（Ctrl+Enter）在 harness 引擎下不适用**：`app/chat/steer` 仍是老实现，harness 生成期间
   没有 `steerings` 队列，会按既有语义返回 409「当前没有正在生成的步骤，插话不适用」（前端弹提示）。
   目标形态是 `submit({whenBusy:"steer"})` + 对齐 `ts_message` 与 `pi.inbox` 的展示，见 M2b。
3. **图片输入不支持**：harness 引擎显式返回 400（提示去掉图片或切回 legacy）。附件字节、工作区副本、
   模型侧 file part 都还没接。
4. **构建与里程碑没有**：`buildPreview` / 最终验证 / `data-build` 修复轮都还在 legacy 里，所以 harness
   引擎下「预览」不会刷新（静态应用写完文件看不出变化，因为预览挂的是 legacy 的构建产物）。
5. **重连没有断点续传**：重连的页面能看到任务还在跑（`app/generation` 轮询），但已经流过的文本不会
   补回来，要刷新页面从 `ts_message` 读回完整结果（M1 的老行为，前端文案也已经这么引导用户）。
6. **`conversationId` 是 MySQL 里的一个普通列**：`DURABLE_ENGINE=legacy` 时它只是空着，harness 会话
   与 legacy 的 `ts_message` 历史是两套，来回切换会出现「对话历史里没有这一轮」（见 M2c）。
7. **harness 仍是单进程单写者**（M1 的既有约束）：`/agent-events`、`/state` 都是全进程视图，
   多应用并发时 `/state` 的 `tasks` 不按会话过滤（只读展示用，`waitForRunStart` 已改成看
   `view.live.busy`）。

## 5. 下一步

### M2b：真实工具 + 里程碑 + 记账

从 `src/server/durable-engine.ts` 与 `spike/pi-durable-m1/src/server.ts` 开始：

1. **构建工具**：把 `buildApp` 注册成 harness 工具（`defineTool`），构建输出走 `api.output()` 流出去
   （顺带解决构建静默期的保活，data-model §2 末段），失败把 `classifyBuildFailure` 的诊断作为
   工具结果交回模型；`ToolTask` 的 `durationMs` 进记账。
2. **里程碑预览**：工具成功时刷新预览并写一条 `data-progress` 的 `preview` 事件，让前端的
   预览版本号照旧工作；对应 legacy 的 `buildStageWatch` 保活可以删掉。
3. **最终验证与修复轮**：服务端的验证权（架构 #16）现在只在 legacy 里。迁移时用扩展的
   `GenerationHooks`（`onYield` 返回 `{continue}` / `afterTools`）把「构建失败 → 把诊断交回模型」
   做成一轮，`BUILD_REPAIR_ROUNDS` 继续生效。
4. **记账**：按 data-model §5 保留 `generation` / `generation_step`，由 `GenerationHooks` 与
   `ToolHooks` 写（`beforeRequest` / `afterResponse` / `afterTool`）；用量块改读条目自带 usage +
   `pi.usage`，`ts_generation.messageId` 的链接变成天然存在。
5. **插话**：`app/chat/steer` 改成 `submit({whenBusy:"steer"})`，前端把 `pi.inbox` 的排队项与
   `ts_message` 对齐（避免同一条文字显示两次，见 §4.2）。
6. **图片输入**：附件字节 → 模型 file part（`pi-ai` 的 file part 已支持），工作区副本沿用
   `agents.ts` 的 `uploadDirectory` 规则。
7. **联网工具**：`src/server/web-access/tools.ts` 的工具注册成 harness 工具（`api.output()` 流式返回）。

### M2c：删自研上下文层，切换默认引擎

1. 把 `DURABLE_ENGINE` 默认值改成 `harness`，删掉 `agent.ts` 的 `chatResponse` 与 `memory-*`、
   `tool-transcript.ts`、`generation-store.ts` 的窗口/游标/租约部分（清单见 data-model §2）。
2. 历史数据：`ts_message` 不再写；前端历史改读 `pi` 条目（`src/app/app/chat/[id]/page.tsx` 的
   `app/messages` 换成会话视图），`app/generation/accounts` 换成条目自带 usage。
3. `req.signal` 接进 AbortController 的老代码（`agent.ts:224`）随 legacy 一起删；把
   `tests/integration/durable-m1/disconnect.test.ts` 的 D1–D5 断言挪到产品路径的集成用例上守住回归。
4. 部署形态：harness 与 Next 分进程的编排（`scripts/dev.ts`）、重启策略、Postgres 迁移
   （data-model §3/§6）。

## 6. 复现

```bash
cd paimeng-ai-code-agent
npm run dev:durable-m1          # Postgres（复用/启动）+ harness + Next（3100，DURABLE_ENGINE=harness）
# 浏览器用创建者身份登录后打开 /app/chat/<应用 ID>，新应用会自动把初始需求发出去（产品的既有行为）

cd ../spike/pi-durable-m1
npm run verify:m2a              # ①+②（真实模型 + 真实 Postgres + Chromium）
npm run verify:m2a-reconnect    # ③
```

桩模型回归（不需要真实模型与 Docker，需要 Postgres）：

```bash
cd spike/pi-durable-pg && ./pg.sh start
cd ../../paimeng-ai-code-agent && npx vitest run tests/integration/durable-m1
```
