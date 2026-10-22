---
name: verify-paimeng-agent
description: 驱动 paimeng-ai-code-agent（Next 16 生成式应用平台）的真实 Web 界面做验证——启动隔离实例、点通用户路径、验证副作用并归档证据。当你需要证明某次改动在真实界面里成立（生成对话、版本回退、模型配置、管理端）时用它，而不是只看单元测试或类型检查。
---

# 验证 paimeng-ai-code-agent

这是一个「用户描述应用 → AI 生成源码 → 预览/部署」的平台。主界面是 Next 16 App Router 的 Web UI；另外两个可编程面是产品 HTTP API（`/api/...`）和常驻 harness（`127.0.0.1:5599`）。验证默认走浏览器，因为大多数改动最终都表现为界面行为。

**先读这一条**：`npm run dev` 起的 3000/3001/5599 是用户自己的服务，**不要驱动、不要重启、不要当测试目标**。本技能的所有驱动都用隔离实例（独立端口 + 强制测试库）。

## 启动（Launch）

产品目录：`paimeng-ai-code-agent/`（仓库根目录下的子目录；下列命令都在这里跑）。

隔离实例由仓库自带的启动器拉起，它一次性做四件事：强制 `DATABASE_URL`→`paimeng_app_test`、`DURABLE_PG_URL`→`paimeng_agent_test`、Redis 用 db 15、给 harness 独立 run 目录 `runtime/e2e-harness-<appPort>`；然后按需生产构建、起 harness、起预览、起应用；最后跑指定的 Playwright spec 并收尾。

```bash
cd paimeng-ai-code-mother
node .agents/skills/verify-paimeng-agent/helpers/verify.mjs tests/e2e/version-panel.spec.ts
```

- 默认端口：应用 3020、预览 3021、harness 随机空闲端口。想并行跑第二个实例就换端口：`E2E_APP_PORT=3030 E2E_PREVIEW_PORT=3031 node …/verify.mjs …`。
- 生产构建整体约 4 分钟；改完 UI 想快速过一遍加 `--dev`（跳过 `npm run build`，用独立 `distDir=.next/dev-check` 起 `next dev --webpack`，一次约 1–2 分钟）。
- 就绪判据（启动器自己会等）：harness `/health` 返回 `{ok:true, protocol:N}`；应用 `/api/health` 返回 `code:0`；预览端口可连。日志第一行会打印三个端口的用途。
- 收尾：启动器只停自己拉起的进程组；`verify.mjs` 在退出后立刻把报告与截图复制到证据目录，所以清理不会吃掉证据。

单独起栈（需要在栈运行期间用 ad-hoc 脚本逐步驱动时才用）：

```bash
cd paimeng-ai-code-mother/paimeng-ai-code-agent
npm run dev            # 3000 应用 + 3001 预览 + 5599 harness，用你自己的库
npx tsx scripts/test-e2e.ts --help   # 不支持 --help；它只接受 spec 路径
```

## 体检（Doctor）

任何时候觉得「跑不起来/结果可疑」，先跑这条只读检查：

```bash
cd /home/zdan/github/zdan/paimeng-ai-code-mother
node .agents/skills/verify-paimeng-agent/helpers/doctor.mjs
```

它检查：Node ≥ 20、`node_modules`、Playwright chromium、`.env` 必需项（隐藏密钥）、Postgres/Redis 可连、3020/3021/harness 端口空闲、以及**有没有孤儿 harness 进程**。最后一项是本仓库最贵的坑：被中断的测试会留下 harness，它一直持有测试库的 advisory lock，之后所有 durable 用例都在 30 秒处超时，报错只说 “harness did not become healthy”。

任何 `FAIL` 都不要开始驱动。`WARN`（如 Redis 不通）可以继续，但要知道哪些用例会红。

## 驱动（Drive）

### 写一条 spec（推荐）

驱动单元是 `paimeng-ai-code-agent/tests/e2e/*.spec.ts`。项目已有 14 个 spec；先用现成的跑通，再按需新增。

```ts
import { test, expect } from '@playwright/test';
import { appOrigin } from './support/app-origin';

const origin = appOrigin();               // 必须从这里取，禁止写死 localhost:3000（check:e2e 会拦）
test('…', async ({ page }) => {
  const credentials = { userAccount: `verify_${Date.now()}`, userPassword: 'pass12345', checkPassword: 'pass12345' };
  await page.request.post('/api/user/register', { headers: { origin }, data: credentials });
  await page.request.post('/api/user/login', { headers: { origin }, data: credentials });
  const app = await page.request.post('/api/app/add', { headers: { origin }, data: { initPrompt: '验证用应用', codeGenType: 'html' } });
  await page.goto(`/app/chat/${(await app.json()).data}`);
});
```

要点（每条都对应仓库里已经踩过的坑）：

- 地址只从 `tests/e2e/support/app-origin.ts` 取；写死端口会让隔离运行整批 ECONNREFUSED。
- 登录/注册用 `page.request.post('/api/user/register' | '/api/user/login', { headers: { origin } })`，cookie 自动进 context。
- 下拉项用 `.ant-select-dropdown:not(.ant-select-dropdown-hidden)` + `getByText`，不要 `getByRole('option')`；提示用 `.ant-alert-error[role="alert"]`，不要裸 `getByRole('alert')`。`npm run check:e2e` 会检查前两条。
- 新增 spec 后必须过 `npm run check:e2e`（静态）与 `npm run check:ui`（改了 tsx 时）。

### 交互式驱动（不写 spec）

需要「边看边点」时，用 Playwright 脚本对**已启动的隔离栈**操作：先按上面的方式起栈（或直接在 spec 里 `page.pause()` 配合 `--headed` 跑），脚本从 `APP_ORIGIN` 读地址。不要对着用户的 3000 端口操作。

### 直接打 API（界面之外的证据）

```bash
curl -s "http://127.0.0.1:3020/api/health" -H "origin: http://127.0.0.1:3020"
curl -s "http://<harness 端口>/health"          # {"ok":true,"protocol":N}
cd paimeng-ai-code-agent && npm run durable:inspect -- --conversations
```

harness 的 `/state?conversationId=` 能读转录与运行状态，`/messages` 能读完整 pi 消息——验证「消息真的进了模型上下文」时用它，而不是只看界面。

## 证据（Evidence）

每次驱动都会在 `.agents/skills/verify-paimeng-agent/evidence/<时间戳>/` 留下（该目录在 `.git/info/exclude` 里，不进版本库）：

| 文件 | 内容 |
| --- | --- |
| `run.log` | 完整启动与测试输出（含端口、构建、失败堆栈） |
| `playwright-report/index.html` | Playwright 报告（失败带 trace，`trace: retain-on-failure`） |
| `test-results/` | 失败用例的 trace/screenshot/video |
| `runtime-evidence/` | 本次运行**新增或改动**的 spec 自写产物（部分 spec 会写 `runtime/evidence/`）。该目录是多次运行累积的，所以只搬这一次的文件 |

证明标准：

1. **走真实用户路径**：点按钮、输入、拖拽，而不是调内部 setter 或只测专用端点。
2. **动作和结果都留证**：先截操作后的界面，再断言状态；只截最终屏无法证明是谁引发的。
3. **同时验证副作用**：数据库行（`select` 查 `app`/`app_version`/`model_alias`）、磁盘文件（`runtime/code_output/<type>_<id>/`）、Git 状态（`git -C <workspace> status/log/for-each-ref`）。界面说成功而 Git 没动，是真实缺陷。
4. **mock 只放在已有的生产边界**：模型提供商用 `AI_MODE=fixture`（启动器已经设好），`page.route('**/api/app/chat/runtime?*')` 只用于隔离「输入框行为」这类与模型无关的断言。不要 mock 你要证明的那一层。
5. **dry-run 也要看它真跳过了什么**：`--dev` 跳的是 `npm run build`，`versions:migrate` 预演不写 refs。验证时去观察产物，而不是相信名字。

## 清理（Cleanup）

- `verify.mjs` 退出即完成清理：启动器向自己拉起的进程组发 SIGTERM，5 秒后 SIGKILL，并且早于证据复制完成，所以证据目录不受影响。
- 手动起过进程的话，按 PID 收：`ss -ltnp | grep ':3020'` 拿 PID 后 `kill <pid>`。**不要 `pkill -f`/`pgrep -f`**：模式串会匹配到你自己的命令行，把当前 shell 一起杀掉（exit 143，仓库已记录过一次）。
- 收尾后确认端口释放：`ss -ltnp | grep -E ':(3020|3021)\b'` 应无输出；`doctor.mjs` 会顺带报告孤儿 harness。
- 清理只删实例与临时状态，**不删 `evidence/`**。

## 已知陷阱

- **协议号门禁**：harness 不热加载，产品侧 `harnessProtocol`（当前 10）与 harness 进程不一致时会明确拒绝而不是静默按旧逻辑跑。改了服务端代码后，隔离实例每次都是新进程，天然对齐；你自己起的 `npm run dev` 需要重启。
- **Turbopack reload loop**：本地 3000 用 Webpack、Turbopack 起的页面会反复重载导致输入框初始化不了。隔离实例用 `next dev --webpack`（dev 模式）或生产构建，不要混。
- **开发库不等于测试库**：集成/E2E 跑在 `paimeng_app_test`，自动迁移；你自己的 `paimeng_app` 需要 `npm run db:migrate`。测试绿不代表你的库有表。
- **`npm run build` 很慢**，且会与用户正在跑的 dev server 抢 CPU；用 `--dev` 快速迭代，最后一次用 production 复核。
- **dev 告警只在 dev 构建出现**：`antd`/React 的告警在生产构建里被剥掉。改了 `src/**/*.tsx` 要用 `--dev` 跑 `tests/e2e/dev-warnings.spec.ts`。
- **端口被占用不要硬抢**：启动器会拒绝复用已有服务（防止你驱动到用户的真实库），换 `E2E_APP_PORT`。
