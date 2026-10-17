# pi-durable M1：单写进程 + attach 骨架

M1 的最小可跑链路：一个常驻 harness 进程独占 Postgres 会话存储，Next.js 服务端只作为客户端
attach（提交任务 + 订阅事件流），浏览器经 Next.js 看到真实模型的流式输出。设计结论见
`paimeng-ai-code-agent/docs/plans/pi-durable-m1.md`，数据模型见 `docs/plans/pi-durable-data-model.md`。

```
spike/pi-durable-m1/
  src/server.ts            常驻进程：Postgres storage + 最小工具集 + HTTP attach API
  src/client.ts            验证脚本共用的 HTTP/SSE 客户端
  src/verify-disconnect.ts 断开连接 ≠ 取消（5 条断言）
  src/verify-restart.ts    kill -9 → 重启 → 续跑（4 条断言，自己管理进程生命周期）
  src/verify-browser.ts    Chromium 打开 Next 页面，真流式 + 刷新读回（4 条断言）
  evidence/                三条验收的运行输出、时间线、截图
node_modules/              指向 ../pi-durable-pg/node_modules 的软链（tsc 等在本地用）
```

复用 `../pi-durable-pg` 的 `src/pg-storage.ts`、`src/harness.ts`、`pg.sh`、`run.sh`。
`run.sh` 从 `~/.pi/agent/models.json` 派生 `SPIKE_*` 只注入子进程，密钥不落盘。

## 跑起来

一条命令（推荐，从 app 目录）：

```bash
cd ../../paimeng-ai-code-agent
npm run dev:durable-m1     # Postgres（已在跑就复用）+ harness + Next dev（3100），Ctrl-C 一起收尾
# 浏览器用创建者身份登录，打开 http://localhost:3100/durable-m1?appId=<应用 ID>
```

手工分步：

```bash
cd spike/pi-durable-pg && ./pg.sh start          # 127.0.0.1:55432 的一次性 Postgres

cd ../pi-durable-m1
./setup.sh                                       # 建 node_modules 软链（tsc / playwright），不入库
npm start                                        # 常驻 harness，127.0.0.1:5599
# 另一个终端：Next.js 服务端（attach 客户端）
cd ../../paimeng-ai-code-agent
ln -sfn <主仓库>/paimeng-ai-code-agent/node_modules node_modules   # 本机 worktree 复用依赖
./node_modules/.bin/next dev --webpack -H 127.0.0.1 -p 3100        # 软链 node_modules 时不能用 Turbopack
# 浏览器访问 http://localhost:3100/durable-m1（用 localhost，127.0.0.1 会被 next.config 重定向到 APP_ORIGIN）
```

验收脚本（各自通过 Next.js 的 attach 通道，不再直连 harness）。attach 路由与 `app/chat/gen/code`
同级鉴权，所以先要拿到**应用创建者**的登录态：浏览器登录后用 `M1_APP_ID`（该用户名下的一个应用）和
`M1_COOKIE`（`paimeng_ts_session=...` 这一对）：

```bash
M1_APP_ID=<应用 ID> M1_COOKIE='paimeng_ts_session=...' npm run verify:disconnect    # 需要 harness + Next 都在跑
M1_APP_ID=... M1_COOKIE=... M1_RESET=1 npm run verify:restart   # 脚本自己 spawn/kill/spawn harness，要求 5599 空闲
M1_APP_ID=... M1_COOKIE=... npm run verify:browser       # 需要 harness + Next 都在跑
```

不需要真实模型的回归测试在 app 目录的 `npm test` 里（用例位于 `paimeng-ai-code-agent/tests/integration/durable-m1/`）：
没有 Postgres 时会打印原因并 skip。

环境变量：`M1_PORT`（默认 5599）、`M1_BASE_URL`（默认 http://localhost:3100）、`M1_HARNESS_URL`（默认 http://127.0.0.1:5599）、
`M1_APP_ID` / `M1_COOKIE`（attach 路由鉴权）、`DURABLE_PG_URL`、`M1_RESET=1`（只在第一次
启动时清空 spike 库）、`M1_RUN_DIR` / `M1_WORKSPACE`。Next 侧：`DURABLE_HARNESS_URL`。

## HTTP attach API（harness 进程）

| 方法 | 路径 | 语义 |
| --- | --- | --- |
| POST | `/submit` | `{content, requestId}`，durable admission，202 即返回；不接任何请求 socket |
| GET | `/events` | SSE：`snapshot` + `revision`，每秒一个 `: ping` 保活 |
| GET | `/state` | 只读投影（进程、任务、提交、转录、live），验证脚本用 |
| GET | `/health` | 存活 |

**限界**：客户端断连只允许中止这一条 `watch`（`server.ts` 的 `viewer.abort()`）。提交路径与
durable 任务 context 从不持有请求连接；`paimeng-ai-code-agent/src/app/api/durable-m1/[...path]/route.ts`
里的 `request.signal` 也只传给 `/events`。这条限界是 M1 的主要产物之一。
