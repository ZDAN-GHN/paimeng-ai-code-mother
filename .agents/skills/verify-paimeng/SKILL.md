---
name: verify-paimeng
description: 用仓库自带的隔离 E2E 启动器驱动 paimeng-ai-code-agent 这个真实应用（Next.js 用户端/管理端 + pi-durable 生成 harness + 3001 预览），按功能地图写 Playwright 用例、留证据、清理进程。要证明某个用户可见行为真的能做成时用它，不要只跑单测。
---

# 验证 paimeng-ai-code-agent

用户真正碰到的只有浏览器：`/user/register`、`/user/login`、首页 `/`、对话页 `/app/chat/<id>`、编辑页 `/app/edit/<id>`、`/user/me`，管理员再加 `/admin/userManage`、`/admin/appManage`、`/admin/modelManage`。生成不由 Next 执行，而是提交给常驻 pi-durable harness，Next 只做鉴权和 SSE 转发。所以「单测绿了」不等于「用户能做这件事」。

证明一律走仓库自己的隔离启动器 `scripts/test-e2e.ts`，不要另造一套。

## Launch

一条命令完成构建、起三个进程、跑用例、收进程：

```bash
E2E_APP_PORT=3020 E2E_PREVIEW_PORT=3021 npm run test:e2e:isolated -- tests/e2e/platform.spec.ts
```

它按顺序做这些事：

1. `npm run build`（`E2E_APP_MODE=dev` 时跳过，改用独立 distDir 起 dev server）
2. 起 harness（未设 `E2E_HARNESS_PORT` 时自选空闲端口）、预览（`E2E_PREVIEW_PORT`）、应用（`E2E_APP_PORT`）
3. 强制测试库：`DATABASE_URL` → `paimeng_app_test`，`DURABLE_PG_URL` → `paimeng_agent_test`，Redis → DB15；模型走夹具（`AI_MODE=fixture`、`ALLOW_TEST_FIXTURE=1`、`DURABLE_FAUX_FIXTURE=1`），不碰真实模型和开发库
4. 等应用 `/api/health` 返回 `code:0`、harness `/health` 返回 `ok:true` 之后，跑 `npx playwright test --workers=1`
5. 退出时 SIGTERM 再 SIGKILL 自己起的进程组

端口默认 3000/3001，常被你自己开着的 `npm run dev` 占着，所以固定用 3020/3021。启动器发现端口被占会直接报错，不会复用别人的服务。

就绪判定由启动器完成，不要自己 sleep 或轮询。

前置条件（缺一项启动器直接报错，不会静默降级）：

- `.env` 存在，`DATABASE_URL` 指向 `/paimeng_app` 或 `/paimeng_app_test`
- Postgres 容器 `zslm-postgres`（127.0.0.1:5432）在跑，四个库都在：`npm run durable:pg`（幂等，只补建）
- Redis 容器 `zslm-redis`（127.0.0.1:6379）在跑：`npm run infra:up`
- Chromium 已装：`npx playwright install chromium`

Teardown：启动器自己收进程，正常结束不需要额外操作。异常退出后先看端口归属 `ss -ltnp | grep -E ':(3000|3001|3020|3021|5599)'`，只杀自己起的 PID。**不要用 `pkill -f`**：AGENTS.md 记录过模式串会匹配到当前 shell 并把它杀掉。

## Doctor

```bash
bash .agents/skills/verify-paimeng/doctor.sh
```

只读：Node 版本、`.env` 连接串、两个容器、四个库可连接、3020/3021 是否空闲、Chromium 是否已装。任何一项 FAIL 先修环境再跑证明。

手动细看时：

- `curl -s -H 'origin: http://localhost:3020' http://localhost:3020/api/health` → `{"code":0,...}`
- `curl -s http://127.0.0.1:<harness 端口>/health` → `{"ok":true}`（端口看启动器日志）
- `npm run verify:infra`：真读写 Postgres 与 Redis，用完删自己的测试键

## Drive

用例写在 `tests/e2e/`，一个功能一个 spec。这个仓库有三条硬约定（都有静态检查兜底，违反会让整批用例一起假失败）：

- 地址一律从 `tests/e2e/support/app-origin.ts` 取 `appOrigin()` / `previewOrigin()`，不要写死 `localhost:3000`、`127.0.0.1:3001`，也不要用自造的环境变量。`npm run check:e2e` 会拦。
- 账号用唯一后缀（`'verify_' + randomUUID().slice(0, 8)`），注册走 API：`page.request.post('/api/user/register', { headers: { origin }, data: { userAccount, userPassword, checkPassword } })`；登录走 UI 标签。
- antd 的隐藏元素不要用 `getByRole('option')` / `getByRole('alert')`：会命中外层隐藏节点并卡到超时。用 `.ant-select-dropdown:not(.ant-select-dropdown-hidden)` + `getByText`，错误提示用 `.ant-alert-error[role="alert"]`。

生成是夹具驱动的：提交后几秒内写出固定文件，页面出现「文件已生成」「可预览」即完成，不要等真实模型。

写完后跑一次 `npm run check:e2e` 再跑证明。

功能地图在 [features/README.md](features/README.md)：每个文件给出该功能的用户路径、可直接复制的用例骨架、断言点和坑。

## Evidence

证据写进 `runtime/evidence/<功能>/`（`runtime/` 已 gitignore，清理不会删它）：

- 每一步关键状态一张截图：`page.screenshot({ path: 'runtime/evidence/<功能>/<步骤>.png', fullPage: true })`
- 要证明的是「动作 + 结果」，不是最后一屏：填表后的值、点击后的 URL、生成后的 iframe 内容
- 副作用要和界面一起验：数据库行（连 `paimeng_app_test` 查）、接口响应（`page.waitForResponse`）、下载得到的 zip 文件名
- 页面错误收集成数组并 `expect(errors).toEqual([])`（仓库现有用例的写法）
- 夹具/桩只允许出现在生产边界本来就有隔离的地方（生成模型、预览构建），不要用内部 setter 或测试专用接口冒充用户路径

`run-proof.sh` 会把整轮日志和 Playwright 报告归档到 `runtime/evidence/runs/<spec>-<时间戳>/`，截图本身留在功能目录。

## Cleanup

- 启动器正常结束会收掉自己起的应用、预览、harness；不要额外操作
- 中断（Ctrl-C、超时、崩溃）后：`ss -ltnp` 确认 3020/3021/harness 端口归属，只杀自己起的 PID 组
- 证据目录和 `test-results/`、`playwright-report/` 都不删；`test-results/` 会在下一轮开始时被 Playwright 清空，所以要留档就用 `run-proof.sh`
- 不要清理 `zslm-postgres`、`zslm-redis` 容器，也不要删库：它们不归这次验证管

## Helpers

```bash
bash .agents/skills/verify-paimeng/doctor.sh                     # 只读体检
bash .agents/skills/verify-paimeng/run-proof.sh tests/e2e/x.spec.ts        # 完整证明（生产构建）
bash .agents/skills/verify-paimeng/run-proof.sh tests/e2e/x.spec.ts --dev  # 快速迭代（跳过构建）
```

两个脚本都用自身位置定位仓库根，再进 `paimeng-ai-code-agent/`，在哪个目录调用都行。`run-proof.sh` 保留 npm 的退出码。

skill 内容放在仓库根 `.agents/skills/`，`.claude/skills` 和 `.pi/skills` 都是指向它的软链接；`.agents/` 已 gitignore。从 `paimeng-ai-code-agent/` 里调用时用 `../.agents/skills/verify-paimeng/...`。
