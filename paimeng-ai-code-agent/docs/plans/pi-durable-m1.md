# Pi Durable 迁移 · M1：单写进程 + attach 骨架

> 历史文档：本文记录当时的状态。其中提到的 `src/server/memory-*.ts`、自研滚动摘要与 `spike/` 实验目录已随整合第三步删除，去向与判据见 [pi-durable-m3.md](./pi-durable-m3.md) §7。

状态：**已跑通**（2026-10-18）。

> 整合后文件位置与命令见 `docs/plans/pi-durable-m3.md`；本文件保留当时的原始记录（harness 进程与
> storage 现在在 `src/server/durable/`，临时页面 `/durable-m1` 已删）。分支 `feat/pi-durable-migration`，基线 `main@d0c9797`。
设计输入是 `docs/plans/pi-durable-data-model.md`（数据模型与删除清单），本文件只讲 M1 的链路与证据。

## 0. 一句话结论

一条最小可跑链路已经通了：浏览器 → Next.js（attach 客户端）→ 常驻 harness 进程（唯一 storage writer）→
Postgres。真实模型的一次生成（模型 + 工具 + 结果落库）端到端跑通；**断开浏览器连接**后任务继续跑完、
重连读到完整结果（5/5）；**`kill -9` harness** 后重启同一 storage 继续跑完（4/4）。M1 把「请求的
AbortSignal 只能作用于 SSE 视图」这条限界固化进了代码与文档。

## 1. 链路结构

```
浏览器（Chromium，Next 页面 /durable-m1）
  │  GET  /durable-m1
  │  POST /api/durable-m1/submit            GET /api/durable-m1/events  (SSE)
  ▼
Next.js 服务端（127.0.0.1:3100，attach 客户端；自己不打开 storage）
  │  proxy → POST /submit                   proxy → GET /events（request.signal 只传给这一个）
  ▼
常驻 harness 进程（127.0.0.1:5599）
  │  Harness.open(postgres) → harness.resume() → root.submit() / root.watch() / root.viewState()
  ▼
Postgres（127.0.0.1:55432，pg_advisory_lock 保证单写者）
```

物理文件：

| 文件 | 作用 |
| --- | --- |
| `spike/pi-durable-m1/src/server.ts` | 常驻进程：Postgres storage、最小工具集（read / write / edit / m1_wait）、HTTP attach API |
| `spike/pi-durable-m1/src/verify-{disconnect,restart,browser}.ts` | 三条验收脚本，全部经 Next.js 的 attach 通道 |
| `paimeng-ai-code-agent/src/app/api/durable/[...path]/route.ts` | Next 侧的 attach 代理；`request.signal` 只作用 `/events` |
| `paimeng-ai-code-agent/src/app/durable-m1/page.tsx` | 最小前端：提交、订阅 SSE、渲染转录与 live partial、刷新从存储读回 |

复用了 spike 的 `pg-storage.ts`（Postgres backend，25/25 一致性套件）、`harness.ts`、`pg.sh`、`run.sh`，
没有新写 storage 或模型层。

### 接口

| 方法 | 路径 | 语义 |
| --- | --- | --- |
| POST | `/submit` | `{content, requestId}` → 202 `{submissionId}`。durable admission，立即返回；调用方不持有任务生命周期 |
| GET | `/events` | SSE：一个 `snapshot` + 每次视图提交一个 `revision`；每秒一个 `: ping` 保活（约束 #40/#41） |
| GET | `/state` | 只读：pid、scheduling、tasks（kind/state/abortRequested）、submissions、转录投影 + live |
| GET | `/health` | 存活与 pid |

**必须保留的限界**：客户端断连只允许中止 `GET /events` 的那一个 `watch`（`server.ts` 里
`clientGone → viewer.abort()`）。提交路径和 durable 任务 context 不接触任何请求 socket，所以「浏览器
掉线 = 取消生成」在结构上不可能发生。旧实现是反例：`paimeng-ai-code-agent/src/server/agent.ts:224`
把 `req.signal` 接进生成 AbortController。

**鉴权**（与 `app/chat/gen/code`、`app/chat/steer` 同级）：attach 路由先 `requireUser`（未登录 401），
再用 `getApp(appId, user, true)` 校验所有权（非创建者 403，**管理员不例外**；缺 appId 400，应用不存在 404）。
appId 来自 `GET ?appId=` 与 `POST body.appId`。M1 里 appId 只作授权主体，harness 仍是单会话
（`app → conversation` 映射属 M2，见 data-model §4）。鉴权在 proxy 之前执行，不改动
「`req.signal` 只传给 `/events`」这条限界：POST 路径拿不到任何 signal。

## 2. 验收证据（真实运行，未跑本项目 E2E / 全量测试）

Postgres 用 spike 的 `pg.sh`（一次性容器，验证后已 `stop`）；模型是 `oc-go/deepseek-v4.1-flash`
（真实 HTTP 调用）；工具是真实文件系统写入。原始输出在 `spike/pi-durable-m1/evidence/`。

### 2.1 一次真实生成端到端（浏览器）

`evidence/browser.log`、`browser-streaming.png`、`browser-final.png`

```
W1 the browser saw streamed model output: PASS
   distinct live lengths=[107,193,222] series=[34ms:0, 12116ms:107, 12465ms:193, 12766ms:222, 13068ms:0]
W2 the browser saw the tool call and the final answer: PASS
W3 a reload reads the same result back from storage: PASS
W4 the run is recorded server-side: PASS
   entries=[7:pi.user, 10:pi.system, 11:pi.assistant, 13:pi.tool-result, 15:pi.assistant, 17:pi.tool-result, 19:pi.assistant]
VERDICT: 4/4 assertions passed — PASS
```

模型先 `write` 再 `read`（entry 13 / 17 两条 tool-result），最后给出中文长答并落在
`pi.assistant` 条目里；刷新页面后转录仍完整（W3）。live 长度 107 → 193 → 222 是流式 partial 的
真实增量，不是一次到位的最后答案。

### 2.2 断开浏览器连接 → 任务继续跑完 → 重连读到完整结果

`evidence/disconnect.log`（原始 TCP 直接 destroy 掉 SSE 连接）

```
submitted (http 202) {"submissionId":8}
m1_wait running                       t+4.7s   （live tools=[{m1_wait, running}]）
socket destroyed 7615ms after submit  t+7.7s   （SSE 已收 3468 字节）
D1 the run is still live after the client died: PASS
   tasks=[pi.generation:waiting:abortRequested=false, pi.tool:running:abortRequested=false]
run settled 30780ms after submit, 23165ms after the disconnect
D2 the run completed with no client attached: PASS   answers=["","M1_DISCONNECT_DONE"]
D3 no cancellation side effect: PASS   entries=[7:pi.user,10:pi.system,11:pi.assistant,13:pi.tool-result,15:pi.assistant]
D4 a reconnect reads the complete result: PASS   snapshot bytes=519
D5 the tool ran exactly once: PASS
VERDICT: 5/5 assertions passed — PASS
```

断连之后 23.2 秒任务自己跑完；断连瞬间 `abortRequested=false`；转录里没有取消痕迹；重连的
snapshot 直接带回完整结果。

### 2.3 `kill -9` harness → 重启 → 同 storage 继续跑完

`evidence/restart.log`（脚本自己 spawn / SIGKILL / spawn，要求 5599 空闲）

```
harness phase 1 up pid=2278614
submitted (http 202) {"submissionId":8}
m1_wait running
SIGKILL harness pid=2278614 8220ms after submit
harness phase 2 up pid=2278947            （同一 Postgres，advisory lock 已随进程退出释放）
resumed run settled 4929ms after the kill
R1 the interrupted tool never ran a second time: PASS   tools=[start(m1_wait,ms=120000)]（无 end）
R2 the run settled after the process death: PASS        tasks=[] submissions=[] pid=2278947
R3 the resumed transcript carries the interrupted tool and the final answer: PASS
   toolResults=["Tool m1_wait was interrupted and may have partially run"] answers=["","M1_RESTART_DONE"]
R4 a reconnect reads the same complete result: PASS     snapshot bytes=608
VERDICT: 4/4 assertions passed — PASS
```

工具不是 replay-safe，所以恢复时被记为 interrupted 而不是重跑；模型拿到 interrupted 结果后继续，
4.9 秒内收尾。

### 2.4 回归测试（进 `npm test`，不需要真实模型与 Docker）

上面三条脚本需要真实模型、手动起服务，不适合放进 CI。把两条关键不变量做成可重复的集成用例，
用 pi-ai 自带的 faux provider 替换真实模型（`spike/pi-durable-pg/src/faux-model.ts`，`SPIKE_FAUX_MODEL=1`），
用例自己 spawn harness 进程、走真实 HTTP 与真实 Postgres：

```bash
npm run durable:pg -- start                # 需要 Postgres（55432）
cd ../../paimeng-ai-code-agent
npx vitest run tests/integration/durable-m1
```

| 文件 | 覆盖 | 需要 |
| --- | --- | --- |
| `tests/integration/durable-m1/disconnect.test.ts` | D1–D5：断连后任务继续、无取消痕迹、重连读到完整结果、工具只跑一次 | Postgres（无则打印原因并 skip） |
| `tests/integration/durable-m1/restart.test.ts` | R1/R3/R4：`kill -9` 后同 storage 续跑、被中断的工具不重跑 | Postgres（无则打印原因并 skip） |
| `tests/integration/durable-m1/route-auth.test.ts` | 鉴权 401/400/403/404/创建者放行 + 限界（`request.signal` 只到 `/events`） | MySQL 测试库（同其它 integration 用例） |

没有 Postgres 时前两条打印 `[durable-m1] 跳过：…` 并 skip，不强行起容器；真实模型 + 真实 Postgres 的
完整版仍是 §2 的手工脚本。**变异检查**（临时改 `spike/pi-durable-m1/src/server.ts` 后跑用例，验证用例确实
能拦住回归）：

| 变异 | 期望 | 实测 |
| --- | --- | --- |
| `clientGone` 里改成 `void root.abort(context)`（断连即取消） | disconnect 失败 | D1 `abortRequested=false` 断言失败 |
| 去掉 `harness.resume()` | restart 超时失败 | 续跑不 settle（`scheduling: paused`），60s 超时 |


## 3. 遇到的坑
1. **`pkill -f "src/server.ts"` 会杀掉自己的 shell**（exit 143）。项目 AGENTS.md 已写过这条；
   这次改用 `/health` 返回的 pid 或 `ss -ltnp` 取端口占用者。
2. **软链 node_modules 下 Turbopack dev 拒绝启动**（约束 #24）；Next 16 的 `next dev --webpack`
   可以跑，这也是本 worktree 的使用方式。
3. **`node_modules` 软链不被 `.gitignore` 的 `node_modules/` 目录规则忽略**（git 把软链当文件），
   `git status` 一直显示未跟踪。写进 `.git/info/exclude` 解决；不要把它提交。
4. **`next.config` 的 redirect**：`APP_ORIGIN` 是 `http://localhost:3000` 时，用 `127.0.0.1:3100`
   访问页面会被 302 到 3000。脚本和浏览器统一用 `localhost:3100`。
5. **Playwright 选择器把「登录」按钮当成发送按钮**：`button[type="button"]` 先命中 header 里的登录
   按钮，页面被导航到 `/user/login`，于是「页面加载成功」但什么都不发生。改成专用 `data-testid`。
6. **判据假阳性**：prompt 里含 marker（"reply exactly: X"），用户条目的回显也含 X，一开始
   `transcript.includes(X)` 在提交后立刻为真。改成「marker 必须出现在工具结果之后」。
7. **Next 页面会请求 `/api/user/get/login`**，被 `guardRequest` 的 origin 门禁挡成 403（本页不依赖它）。
   M1 的 attach 路由刻意没有接鉴权，只监听本地；M2 接产品时必须补上。
8. **模型很快**：`deepseek-v4.1-flash` 一次回复 4–12 秒，采样间隔必须 ≤300ms 才看得到 partial；
   想稳定观察流式，prompt 要要求长文本输出。
9. **单写者契约**：第二个 harness 进程会被 `pg_advisory_lock` 直接拒掉，所以 `verify-restart`
   自己负责 spawn/kill，且要求 5599 空闲。

## 4. 与产品代码的关系

- 产品代码只新增了两个文件（`src/app/api/durable/[...path]/route.ts`、`src/app/durable-m1/page.tsx`），
  **没有改动现有生成链路**：`agent.ts` 仍是老的（含 `req.signal` 接进 AbortController、`prepareStep`
  插话、memory-*、`generation-store` 租约）。M1 是并列的一条链路，不是替换。
- attach 路由没有鉴权、只绑本地；页面是验证页，不进导航。
- 提交、事件流、转录读回都走 pi-durable 的公开接口（`submit` / `watch` / `viewState` / `inspect`），
  没有自己造 storage 语义。

## 5. 未完成 / 待办

M1 的四项目标（常驻进程、attach 通道、前端最小链路、三条验收）都已跑通，下面是不在 M1 范围内或
没做到位的部分，按「下一步该做什么 → 从哪个文件开始」列出。

### 5.1 M1 内部没做干净的

1. ~~**attach 路由没有鉴权**~~ **已做**（2026-10-18）：`requireUser` + `getApp(appId, user, true)`，路由与
   页面都改好；页面需要 `?appId=<应用 ID>`。见 §1「鉴权」。
2. ~~**不是集成测试**~~ **已做**：D1–D5 与 R1/R3/R4 进了 `npm test`（§2.4），无 Postgres 时明确 skip。
3. **只验证了 root 会话（conversation 1）**：「一个应用一条 conversation」的映射仍未做（appId 现在只作
   授权主体），也没测多会话。→ 从 `app.conversation_id` 开始（data-model §4）。
4. **工具集最小**：只有 `read` / `write` / `edit` / `m1_wait`，`buildApp`、联网、附件都没接。
   → 从 `spike/pi-durable-m1/src/server.ts` 的 `defineExtension` 处接真实工具。
5. **保活只在 SSE 里**：`/events` 每秒一个 `: ping`，但没有复现「构建容器的链路状态变化掐断连接」
   那个真实场景（旧实现对应 `agent.ts` 的 `buildKeepAliveMs`、`http.ts` 的 `withHeartbeat`）。
   → 给 `verify-disconnect.ts` 加一次 `docker run` 触发链路变化，断言连接仍在。
6. **传输层断裂的重试没验证**：data-model §7.2 的未验证项（`settings.retry` / `settings.stream` 是否覆盖
   「进程活着但连接被掐」）在 M1 里依然未验证；M1 证明的是「断连不影响任务」，不是「断连后仍拿得到模型回复」。
   → **验证方式**：在 `verify-disconnect.ts` 的基础上，把断连时机从工具执行中改到**模型请求进行中**
   （prompt 要求长输出，断在流中段），断言续跑的生成拿到完整的助手回复而不是 `stopReason=error`，
   并把 harness 发出的 provider 请求记录成日志以确认是否发生了重试；需要一个能稳定触发流中途断开的
   上游（真实模型 + 本地代理，或 faux provider 在输出几段后断开）。
7. **单写者排他只在 pg spike 验证过**：M1 没写「第二个 harness 进程被拒」的用例，只靠 advisory lock 的既有行为。
   → 在 `verify-restart.ts` 里加一条：phase 2 启动时第一个进程还活着，期望启动失败。
8. **前端只做最小展示**：每次 revision 用全量快照覆盖状态（EventSource 自动重连会重发 snapshot，所以安全），
   没有 lastEventId / 增量合并；没有断线提示之外的错误处理。
   → 从 `src/app/durable-m1/page.tsx` 起步，接口换成产品聊天页需要的形态。
9. ~~**进程编排没做**~~ **已做**：`npm run dev:durable`（`scripts/durable-dev.ts`）一条命令起
   Postgres（已在跑就复用）+ harness + Next dev，退出时收掉自己起的进程，只停自己启动的 Postgres。见 §6。
10. **`127.0.0.1` 访问会被 next.config 重定向到 `APP_ORIGIN`**（本机是 `http://localhost:3000`），
    这次靠脚本改用 `localhost:3100` 绕开，没有改配置。
11. **手工脚本现在需要会话**：attach 路由鉴权后，`spike/pi-durable-m1` 的三条 verify 需要 `M1_APP_ID`
    与 `M1_COOKIE`（用应用创建者的登录态）。已接线，但还没有「自动登录建应用」的脚本化前置。
    → 若要无人值守重跑真实模型验收，补一个登录 + 建应用的小助手（`spike/pi-durable-m1/src/client.ts`）。

### 5.2 M2：生成循环替换要改的清单

1. **替换生成循环**：`src/server/agent.ts` 的 `chatResponse` 换成 pi-durable 的 `GenerationTask`
   驱动；删掉 `req.signal → controller.abort`（`agent.ts:224`）、`prepareStep` 插话注入、
   `POST app/chat/steer` 的 409 分支，改用 `submit({whenBusy:"steer"})` + `pi.inbox`。
2. **删自研上下文层**：`memory-window/context/consolidate/serialize/types/step`、
   `tool-transcript.ts`、`generation-store.ts` 的窗口/游标/租约部分（清单见 data-model §2）。
3. **工具层**：把 `buildApp`、文件、web 访问注册成 pi-durable 工具；构建输出改走工具的
   `api.output()` 流出去（顺带解决构建静默期的保活，见 data-model §2 末段）。
4. **会话映射**：给 `app` 加 `conversation_id`，把「一个应用一条对话」落成真实外键；
   ownership 用 `ownerless`（外部请求驱动的会话）。
5. **鉴权**：attach 路由接 `requireUser` + app 归属校验；harness 仍只监听 127.0.0.1，Next 是唯一入口。
6. **前端**：从 `data-progress` 事件改成订阅视图快照（`src/app/durable-m1/page.tsx` 可作起点），
   `generation-feedback.ts` 的时间线归约大部分作废。
7. **记账**：按 data-model §5 保留 `generation`（任务级）与 `generation_step`（逐轮）两张业务表，
   由 hook 写入；用量块改读条目自带 usage + `pi.usage`。
8. **限界回归测试**：把 D1–D5 三条断言搬进集成测试（提交后断开 SSE，断言任务继续、无取消痕迹、
   重连拿到完整转录），防止 `req.signal` 进任务 context 的老 bug 复发。
9. **部署形态**：harness 与 Next 分进程，「单写进程 + N 个 attach 客户端」；需要决定进程编排
   （`scripts/dev.ts` 里拉起 harness？）与重启策略。
10. **数据库迁移**：MySQL → Postgres（Drizzle `pg-core`、`?` 占位符、`ON DUPLICATE KEY`、
    camelCase 列名），对话数据放弃、业务表重建，见 data-model §3/§6。

## 6. 复现

```bash
npm run dev:durable        # Postgres（复用/启动）+ harness + Next dev（3100），Ctrl-C 一起收尾
# 浏览器用创建者身份登录，打开 http://localhost:3100/durable-m1?appId=<应用 ID>
```

手动跑真实模型验收见 `spike/pi-durable-m1/README.md`（需要 `M1_APP_ID` 与 `M1_COOKIE`）。回归测试见 §2.4：
`npm run durable:pg -- start` → `npx vitest run tests/integration/durable-m1`。原始输出、时间线、
截图在 `spike/pi-durable-m1/evidence/`。
