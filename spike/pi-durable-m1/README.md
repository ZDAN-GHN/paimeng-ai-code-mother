# pi-durable 手工验收脚本

这里的脚本用来手工复现「断开 ≠ 取消」「kill -9 后从 checkpoint 续跑」「浏览器看到真实流式」这几条
不变量。**常驻 harness 进程本身已经搬进产品**：`paimeng-ai-code-agent/src/server/durable/harness-server.ts`
（storage 在 `src/server/durable/storage-pg.ts`，模型与 registry 在 `src/server/durable/harness.ts`）。
本目录只留脚本与证据，不再有进程实现。

设计结论见 `paimeng-ai-code-agent/docs/plans/pi-durable-m1.md` / `pi-durable-m2.md`，
搬迁与当前拓扑见 `paimeng-ai-code-agent/docs/plans/pi-durable-m3.md`。

```
spike/pi-durable-m1/
  src/client.ts            验证脚本共用的 HTTP/SSE 客户端（走 /api/durable attach 路由）
  src/product.ts           产品接口客户端：登录、建应用、读任务与 harness 调试口
  src/verify-disconnect.ts 断开连接 ≠ 取消（5 条断言）
  src/verify-restart.ts    kill -9 → 重启 → 续跑（4 条断言，自己 spawn 产品 harness 进程）
  src/verify-browser.ts    Chromium 打开产品页面，真流式 + 刷新读回（4 条断言）
  src/verify-m2a.ts        产品路径两轮生成：流式/工具条目 + 第二次看得到第一次
  src/verify-m2a-reconnect.ts 产品路径断连重连
  evidence*/                各次验收的运行输出、时间线、截图
node_modules/              指向 ../pi-durable-pg/node_modules 的软链（verify 脚本自己用 playwright）
```

## 跑起来

一条命令（推荐，从产品目录）：

```bash
cd paimeng-ai-code-agent
npm run dev:durable        # Postgres（已在跑就复用）+ harness + Next dev（3100），Ctrl-C 一起收尾
# 浏览器登录后打开 http://localhost:3100/app/chat/<应用 ID>
```

手工分步：

```bash
cd paimeng-ai-code-agent
npm run durable:pg -- start      # 127.0.0.1:55432 的一次性 Postgres（数据在 runtime/durable-pg）
npm run durable:harness          # 常驻 harness，127.0.0.1:5599（直连模型，需要 DURABLE_MODEL_*）
# 另一个终端：Next.js（attach 客户端）
./node_modules/.bin/next dev --webpack -H 127.0.0.1 -p 3100
```

## 验收脚本

attach 路由 `/api/durable/*`（`src/app/api/durable/[...path]/route.ts`）与 `app/chat/gen/code` 同级
鉴权，所以先要拿到**应用创建者**的登录态：浏览器登录后用 `M1_APP_ID`（该用户名下的一个应用）和
`M1_COOKIE`（`paimeng_ts_session=...` 这一对）：

```bash
cd spike/pi-durable-m1
M1_APP_ID=<应用 ID> M1_COOKIE='paimeng_ts_session=...' npm run verify:disconnect   # 需要 harness + Next 都在跑
M1_APP_ID=... M1_COOKIE=... DURABLE_HARNESS_RESET=1 npm run verify:restart   # 脚本自己 spawn/kill/spawn harness，要求 5599 空闲
M1_APP_ID=... M1_COOKIE=... npm run verify:browser      # 需要 harness + Next 都在跑
```

M2a/M2b 的产品路径验收不需要 cookie（脚本自己登录建应用）：

```bash
npm run verify:m2a             # 真实模型 + Postgres + Chromium
npm run verify:m2a-reconnect
```

不需要真实模型的回归用例在产品目录的 `npm test` 里（`tests/integration/durable-m1/`），
没有 Postgres 时会打印原因并 skip。

环境变量：`M1_BASE_URL`（默认 http://localhost:3100）、`M1_HARNESS_URL`（默认 http://127.0.0.1:5599）、
`M1_APP_ID` / `M1_COOKIE`、`DURABLE_PG_URL`、`DURABLE_HARNESS_PORT` / `DURABLE_HARNESS_RESET`
（spawn harness 时用）。
