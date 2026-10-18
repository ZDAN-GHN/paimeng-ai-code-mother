# Pi Durable 迁移 · M3：整合进产品（提拔 + 切默认引擎 + 删临时物）

状态：**整合第一步已完成**（2026-10-18）。分支 `feat/pi-durable-migration`，基线 `main@d0c9797`
（M1 `4edbdd0`/`1554dcc`/`345d60a`，M2a `d8acf2d`，M2b `3b9279f`，整合前状态提交 `9c7ee52`，
备份分支 `backup/pre-integration-20261018`）。

本步做的三件事：把 Postgres storage 与 harness 进程从 `spike/` 提拔进产品；把默认生成引擎切成
`harness`；删掉只服务临时验证页的页面。**数据库整体换 Postgres 不在本步**（下一步单独做）。
本步只在这个 worktree 操作，主仓库保持 `d0c9797` 不变。

## 0. 一句话结论

产品的生成入口现在默认走常驻 harness：产品路径上的真实生成经 harness 跑通（流式、工具条目、构建
进度、预览刷新、落库读回都走既有前端协议）。harness 的实现文件全部在产品路径下，
`@earendil-works/pi-durable` 与其依赖是产品依赖；`spike/` 只剩手工验收脚本与实验记录。

实测：`npx tsc --noEmit` 干净、`tests/integration/durable-m1` 11/11 过、产品对话页一次真实
React 生成 8/8（真实模型 + 真实容器构建 11.7s + 浏览器流式与构建进度 + 刷新读回），见 §3.1。
**未做**：删自研上下文层（等价性不够，理由见 §4.1）与数据库换 Postgres（下一步）。

## 1. 搬迁单（文件级）

### 1.1 移动 + 改名

| 原位置 | 新位置 | 说明 |
| --- | --- | --- |
| `spike/pi-durable-pg/src/pg-storage.ts` | `src/server/durable/storage-pg.ts` | Postgres `Storage` 后端，内容原样（只改了文件头注释） |
| `spike/pi-durable-pg/src/harness.ts` | `src/server/durable/harness.ts` | `openPgHarness` / registry / 模型注册。符号改名 `spikeModels→durableModels`、`spikeRegistry→createHarnessRegistry`、`spikeConfig→modelConfig`；provider id `spike→durable` |
| `spike/pi-durable-pg/src/faux-model.ts` | `src/server/durable/faux-model.ts` | 桩模型（回归用例用）。环境变量 `SPIKE_FAUX_*→DURABLE_FAUX_*` |
| `spike/pi-durable-m1/src/server.ts` | `src/server/durable/harness-server.ts` | 常驻进程 + attach HTTP API。改为静态 import 产品的 `artifacts`/`build-feedback`（原来是按需动态 import），环境变量 `M1_*→DURABLE_HARNESS_*`、`SPIKE_*→DURABLE_MODEL_*`；`/submit` 遇到不存在的 `conversationId` 现在返回 404（原来静默回退 root 会话） |
| `spike/pi-durable-pg/pg.sh` | `scripts/durable-pg.sh` | 一次性 Postgres 16。容器名 `zslm-pg-durable`，数据目录 `runtime/durable-pg/pgdata`（gitignore），端口仍 55432；`npm run durable:pg -- start|stop|purge|status|psql` |
| `scripts/durable-m1-dev.ts` | `scripts/durable-dev.ts` | 一条命令起 Postgres + harness + Next（3100）。改为起产品 harness（产品 tsx+产品根 cwd），从 `~/.pi/agent/models.json` 派生 `DURABLE_MODEL_*` 只注入子进程；`npm run dev:durable` |
| `src/app/api/durable-m1/[...path]/route.ts` | `src/app/api/durable/[...path]/route.ts` | attach 代理保留（鉴权、`req.signal` 只到 `/events` 的限界都在）。手工脚本改走 `/api/durable/*` |

### 1.2 删除

| 删除 | 原因 |
| --- | --- |
| `src/app/durable-m1/page.tsx` | 临时验证页，产品对话页已取代它 |
| `spike/pi-durable-m1/src/server.ts`（由 1.1 移动） | 进程实现进产品，spike 不留第二份 |

**没有删的（与「能删什么」清单的差异，理由见 §4）**：`src/server/memory-*.ts`、`tool-transcript.ts`、
`generation-store.ts` 的窗口/摘要/游标/租约、`agent.ts` 的 legacy 循环、`ts_*` 表与迁移。
它们仍被 legacy 引擎依赖，而 harness 还没做到功能等价（见 §4.1）。

### 1.3 依赖（package.json）

提升为产品依赖：`@earendil-works/pi-durable@1.3.0`、`@earendil-works/pi-ai@1.3.0`、
`@earendil-works/chord@1.3.0`、`pg@8.23.1`；devDep 加 `@types/pg@8.23.1`。
spike 的 `package.json` 仍是实验/手工脚本的依赖，不再承担产品职责。

新增脚本：`dev:durable`、`durable:harness`（`node --import tsx --conditions=react-server
src/server/durable/harness-server.ts`）、`durable:pg`。删掉了 `dev:durable-m1`。

### 1.4 配置与产品代码改动

| 文件 | 改动 |
| --- | --- |
| `src/server/config.ts` | `DURABLE_ENGINE` 默认值 `legacy→harness`（仍可用 `legacy` 回退） |
| `.env.example` | 生成引擎一节重写：默认 harness、`DURABLE_PG_URL`、`DURABLE_HARNESS_PORT`、`DURABLE_MODEL_*` |
| `src/server/durable/harness-server.ts`（原 spike 进程） | 构建进度的 `api.details` 提交改为串行链（`note` 里的 `progress` 队列）：并发提交会乱序落地，晚到的 `source: started` 会把时间线卡在「源码校验 运行中」——观察者每秒补的保活事件会一直重发那个阶段。真实 React 构建第一次跑出过这个现象，第二次（修后）8/8 |
| `src/server/durable-engine.ts` | 抽出 `submitHarness`；提交遇到 harness 404（映射指向不存在的会话，例如换过 Postgres）时清掉 `app.conversationId` 重建一次；`harnessFetch` 抛带状态码的 `HarnessRequestError` |
| `src/app/api/[...path]/route.ts` | 不改（仍按 `getConfig().durable.engine` 分流） |

## 2. 运行形态

```bash
cd paimeng-ai-code-agent
npm run dev:durable     # Postgres（在跑就复用）+ harness（5599）+ Next dev（3100，DURABLE_ENGINE=harness）
# 浏览器登录后打开 http://localhost:3100/app/chat/<应用 ID>

npm run durable:pg -- stop   # 用完停回原状（只停自己起的那个容器）
```

分进程形态没变：harness 是 storage 的唯一写者，Next 只做 attach 客户端；单写者由 `pg_advisory_lock`
强制。产品入口是 `app/chat/gen/code`，浏览器断连只影响转发流（`ChunkChannel`），任务继续跑。

## 3. 验收怎么跑

### 3.1 本步实测结果（2026-10-18）

| 验收 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npx tsc --noEmit` | 干净（exit 0） |
| harness 冒烟（桩模型） | `DURABLE_FAUX_MODEL=1 … node --import tsx --conditions=react-server src/server/durable/harness-server.ts` | 启动、监听 5599、SIGTERM 干净退出 |
| durable 回归 | `npx vitest run tests/integration/durable-m1` | 6 文件 11 用例全过（21s，含真实 Postgres） |
| 静态检查 | `npm run check:ui` / `npm run check:e2e` | 通过 |
| **真实生成（产品主流程）** | `npm run dev:durable` + `spike/pi-durable-m1` 的 `npm run verify:m2b-build` | **8/8 PASS**：真实模型 `oc-go/deepseek-v4.1-flash`、真实容器构建（安装依赖/类型检查/打包 11.7s）、浏览器看到流式增量（13 个不同长度）、工具条目、四个构建阶段全部 `ok`、预览刷新（`pv=1`）、刷新后读回文本与工具条目 |

原始输出与截图：`spike/pi-durable-m1/evidence-m3/timeline-m3.txt`（最后一次 8/8）、`m3-streaming.png`、`m3-final.png`、`m3-reloaded.png`。

第一次真实运行是 7/8，唯一失败是上面的进度乱序（时间线卡在「源码校验 运行中」）；修 `note` 串行化后重跑 8/8，说明这条修复是必要的，也说明断言真的能拦住它。

### 3.2 命令

```bash
# 类型检查（产品树）
cd paimeng-ai-code-agent && npx tsc --noEmit

# durable 回归（不需要真实模型；需要 Postgres）
npm run durable:pg -- start
npx vitest run tests/integration/durable-m1

# 一次真实生成（真实模型 + 真实 Postgres + 真实容器构建 + 浏览器）
npm run dev:durable
cd ../spike/pi-durable-m1
npm run verify:m2b-build         # React 应用：构建阶段进度 + 真实容器构建 + 预览刷新 + 刷新读回
npm run verify:m2a               # 产品路径两轮生成：流式 + 工具条目 + 第二次看得到第一次
```

环境注意（本机实际踩到）：

- **模型密钥**：产品侧模型配置（`model_provider.apiKeyCiphertext`）用 `runtime/model-secret.key` 解密，
  而 worktree 有自己的 `runtime/`。dev 库里保存的密文是用主仓库的密钥文件加密的，worktree 里直接跑会
  报 `503 密钥无法解密，请重新保存密钥`。本步的做法是把主仓库的 `runtime/model-secret.key` 复制到
  worktree（本机开发态，gitignored），或从管理端重新保存密钥。
- **Postgres 库是共享的**：`durable:pg` 起的实例端口 55432，回归用例会 `M1_RESET`/`DURABLE_HARNESS_RESET`
  清空会话存储。清空后 `app.conversationId` 指向不存在的会话，靠 `durable-engine.ts` 的 404 自愈重建
  （这也是那条代码存在的理由）。用完 `npm run durable:pg -- stop` 停回原状。

## 4. 剩余待办

### 4.1 为什么没删自研上下文层（本步没做的那一件，转成待办）

原计划的第 ③ 步（删 `memory-*.ts`、窗口/摘要/游标/租约、流式重试包装、`tool-transcript.ts`，
data-model §2）**没有做**。原因不是时间，而是删它们等于删整个 legacy 引擎，而 harness 目前还缺
四项已上线能力（删了就是功能回退，是未获授权的产品决定）：

1. **图片输入**：`durable-engine.ts` 对 attachment part 直接返回 400；legacy 有完整链路（附件字节 →
   工作区副本 → 模型 file part）。
2. **中途插话**：`app/chat/steer` 仍是 legacy 实现，harness 生成期间返回 409；目标形态是
   `submit({whenBusy:"steer"})`。
3. **最终验证与构建修复轮**：架构 #16 的验证权只在 legacy；harness 路径模型只能自己调 `buildPreview`，
   构建失败不会自动进入修复轮，也不以构建错误结束任务。
4. **联网工具**：`web-access/tools.ts` 还没注册成 harness 工具。

这四项都是已上线能力，删 legacy 会直接造成功能回退，属于未获批的产品决定，所以留到等价后再删
（M2c 的删除动作顺延到 M4）。删除时应一次性做：删 `agent.ts` 的 `chatResponse`、
`memory-window/context/consolidate/serialize/types/model`（`memory-model` 里的别名解析被
`model.ts`/`speech.ts` 复用，要先拆）、`tool-transcript.ts`、`generation-store.ts` 的窗口/租约部分，
以及对应测试（`tests/memory-*.test.ts`、`tests/integration/memory-generation.test.ts`、
`tests/e2e/memory-summary.spec.ts`、`tests/integration/agent-*` 里直接调 `chatResponse` 的用例）。

### 4.2 数据库换 Postgres（下一步）

- Drizzle `mysql-core → pg-core`，列名改 snake_case（data-model §3），业务表按域重建。
- 业务行搬过去（user / app / model_* / attachment / rate_limit / 登录会话），对话数据放弃。
- `app.conversation_id` 指向的会话不会随旧库迁移；`durable-engine.ts` 已在 404 时清映射重建，
  但换库时最好一次性把 dev/test 库的该列清空。
- 旧 `ts_*` 表与迁移在换库同一步删。

### 4.3 其它

1. **模型解析**：harness 用 `DURABLE_MODEL_*` 的环境变量（dev 脚本从 `models.json` 派生），
   没有读产品的模型注册表/别名；UI 选的别名只进记账行。要按应用走产品模型配置需要下一步改
   `durableModels()`。
2. **前端历史**：`app/messages` 仍读 `ts_message`（harness 引擎也写它，所以刷新读回正常）；
   data-model 计划是改读 pi 条目。
3. **进程编排/部署**：`dev:durable` 只覆盖本机开发；生产形态、重启策略、`kill -9` 后残留构建容器的清理
   （容器是 `--rm`，但 harness 被 kill 时来不及回收）还没定。
4. **手工脚本**：`spike/pi-durable-m1` 的 M1/M2a 脚本已指向产品 harness；M2b 的产品路径真实构建
   验收脚本 `verify:m2b-build` 见 §3（本轮新增）。
5. **遗留清理**：旧 spike 容器 `zslm-pg-durable-spike` 与 `spike/pi-durable-pg/pgdata/` 已不被使用，
   确认无用后手工 `docker rm -f` + 删目录。
