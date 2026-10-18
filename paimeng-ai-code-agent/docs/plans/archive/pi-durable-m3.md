# Pi Durable 迁移 · M3：整合进产品（提拔 + 切默认引擎 + 删临时物）

> 归档：记录当时的设计、迁移与验收。当前行为见[部署说明](../pi-durable-deployment.md)与[模型配置](../provider-convergence.md)。

状态：**整合第一步、第二步、第三步均已完成**（2026-10-18）。第三步删掉 legacy 引擎与自研上下文层，见 §7。分支 `feat/pi-durable-migration`，基线 `main@d0c9797`
（M1 `4edbdd0`/`1554dcc`/`345d60a`，M2a `d8acf2d`，M2b `3b9279f`，整合前状态提交 `9c7ee52`，
备份分支 `backup/pre-integration-20261018`）。

整合第一步做三件事：把 Postgres storage 与 harness 进程从 `spike/` 提拔进产品；默认生成引擎切成
`harness`；删掉只服务临时验证页的页面。**数据库整体换 Postgres 不在本步**。

整合第二步（同日）补齐 harness 路径缺的四项已上线能力（图片输入 / 中途插话 / 构建修复轮与最终验证 /
联网工具），见 §5；`legacy` 的删除判据见 §6。本步仍只在这个 worktree 操作，主仓库保持 `d0c9797` 不变。

## 0. 一句话结论

产品的生成入口现在默认走常驻 harness：产品路径上的真实生成经 harness 跑通（流式、工具条目、构建
进度、预览刷新、落库读回都走既有前端协议）。harness 的实现文件全部在产品路径下，
`@earendil-works/pi-durable` 与其依赖是产品依赖；`spike/` 只剩手工验收脚本与实验记录。

实测：`npx tsc --noEmit` 干净、`tests/integration/durable-m1` 11/11 过、产品对话页一次真实
React 生成 8/8（真实模型 + 真实容器构建 11.7s + 浏览器流式与构建进度 + 刷新读回），见 §3.1。
整合第二步之后：`tests/integration/durable-m1` 9 文件 16/16，`verify:m3` 13/13（四项能力各自的真实
证据），见 §5。
**未做**：删自研上下文层（等价性不够，判据见 §6）与数据库换 Postgres（下一步）。

整合第二步已把 harness 缺的四项已上线能力补齐（中途插话 / 图片输入 / 构建修复轮与最终验证 / 联网工具），
每项一条真实验收，细节与剩余项见 §5。

## 1. 搬迁单（文件级）

### 1.1 移动 + 改名

| 原位置 | 新位置 | 说明 |
| --- | --- | --- |
| `spike/pi-durable-pg/src/pg-storage.ts` | `src/server/durable/storage-pg.ts` | Postgres `Storage` 后端，内容原样（只改了文件头注释） |
| `spike/pi-durable-pg/src/harness.ts` | `src/server/durable/harness.ts` | `openPgHarness` / registry / 模型注册。符号改名 `spikeModels→durableModels`、`spikeRegistry→createHarnessRegistry`、`spikeConfig→modelConfig`；provider id `spike→durable` |
| `spike/pi-durable-pg/src/faux-model.ts` | `src/server/durable/faux-model.ts` | 桩模型（回归用例用）。环境变量 `SPIKE_FAUX_*→DURABLE_FAUX_*` |
| `spike/pi-durable-m1/src/server.ts` | `src/server/durable/harness-server.ts` | 常驻进程 + attach HTTP API。改为静态 import 产品的 `artifacts`/`build-feedback`（原来是按需动态 import），环境变量 `M1_*→DURABLE_HARNESS_*`、`SPIKE_*→DURABLE_MODEL_*`；`/submit` 遇到不存在的 `conversationId` 现在返回 404（原来静默回退 root 会话） |
| `spike/pi-durable-pg/pg.sh` | `scripts/durable-pg.sh` | 一次性 Postgres 16。容器名 `zslm-pg-durable`，数据目录 `runtime/durable-pg/pgdata`（gitignore），端口仍 55432；`npm run durable:pg -- start|stop|purge|status|psql` |
| `scripts/durable-m1-dev.ts` | `scripts/durable-dev.ts` | 一条命令起 Postgres + harness + Next（3100）。改为起产品 harness（产品 tsx+产品根 cwd），从 `~/.pi/agent/models.json` 派生 `DURABLE_MODEL_*` 只注入子进程；`npm run dev` |
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

新增脚本：`dev`、`durable:harness`（`node --import tsx --conditions=react-server
src/server/durable/harness-server.ts`）、`durable:pg`。删掉了 `dev:durable-m1`（该名后来并入 `npm run dev`）。

### 1.4 配置与产品代码改动

| 文件 | 改动 |
| --- | --- |
| `src/server/config.ts` | `DURABLE_ENGINE` 默认值 `legacy→harness`（仍可用 `legacy` 回退） |
| `.env.example` | 生成引擎一节重写：默认 harness、`DURABLE_PG_URL`、`DURABLE_HARNESS_PORT`、`DURABLE_MODEL_*` |
| `src/server/durable/harness-server.ts`（原 spike 进程） | 构建进度的 `api.details` 提交改为串行链（`note` 里的 `progress` 队列）：并发提交会乱序落地，晚到的 `source: started` 会把时间线卡在「源码校验 运行中」——观察者每秒补的保活事件会一直重发那个阶段。真实 React 构建第一次跑出过这个现象，第二次（修后）8/8 |
| `src/server/durable-engine.ts` | 抽出 `submitHarness`；提交遇到 harness 404（映射指向不存在的会话，例如换过 Postgres）时清掉 `app.conversationId` 重建一次；`harnessFetch` 抛带状态码的 `HarnessRequestError` |
| `src/server/durable/harness-server.ts`（整合第二步） | 新增 `POST /configure`（按轮次对齐常驻指令）；`POST /submit` 接受 content 数组（text/image 块）与 `whenBusy`；body 上限 100 KB → 24 MB；`/context` 增加 `images` 计数；`/tools` 列出联网工具的 `replay`。见 §5 |
| `src/app/api/[...path]/route.ts` | 不改（仍按 `getConfig().durable.engine` 分流） |

## 2. 运行形态

```bash
cd paimeng-ai-code-agent
npm run dev     # Postgres（在跑就复用）+ harness（5599）+ Next dev（3100，DURABLE_ENGINE=harness）
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
| durable 回归 | `npx vitest run tests/integration/durable-m1` | 6 文件 11 用例全过（21s，含真实 Postgres）；第二步之后 9 文件 16 用例 |
| 静态检查 | `npm run check:ui` / `npm run check:e2e` | 通过 |
| **四项能力真实验收** | `npm run dev` + `spike/pi-durable-m1` 的 `npm run verify:m3` | **13/13 PASS**（真实模型、真实上传、真实容器构建），见 §5 |
| **真实生成（产品主流程）** | `npm run dev` + `spike/pi-durable-m1` 的 `npm run verify:m2b-build` | **8/8 PASS**：真实模型 `oc-go/deepseek-v4.1-flash`、真实容器构建（安装依赖/类型检查/打包 11.7s）、浏览器看到流式增量（13 个不同长度）、工具条目、四个构建阶段全部 `ok`、预览刷新（`pv=1`）、刷新后读回文本与工具条目 |

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
npm run dev
cd ../spike/pi-durable-m1
npm run verify:m3                # 四项能力（插话 / 图片 / 修复轮 / 联网工具注册），13 项断言
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

### 4.1 四项缺口已补（整合第二步，见 §5），自研上下文层仍未删

原计划的第 ③ 步（删 `memory-*.ts`、窗口/摘要/游标、流式重试包装、`agent.ts` 的旧循环）**已在整合第三步完成**（§7）；
`tool-transcript.ts` 与 `generation-store.ts` 的租约/心跳/终态保留，理由见 §7.2。当时的阻塞原因与最终处置记录如下。当时的原因是「删它们等于删整个 legacy 引擎，而 harness 还缺四项已上线能力」，
这四项已在整合第二步补齐并有真实证据（§5）；删除动作仍未开始，剩余卡点改为 §6 的判据清单。

删除时应一次性做：删 `agent.ts` 的 `chatResponse`、`memory-window/context/consolidate/serialize/types/model`
（`memory-model` 里的别名解析被 `model.ts`/`speech.ts` 复用，要先拆）、`tool-transcript.ts`、
`generation-store.ts` 的窗口/租约部分，以及对应测试（`tests/memory-*.test.ts`、
`tests/integration/memory-generation.test.ts`、`tests/e2e/memory-summary.spec.ts`、
`tests/integration/agent-*` 里直接调 `chatResponse` 的用例）。

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
3. **进程编排/部署**：`dev` 只覆盖本机开发；生产形态、重启策略、`kill -9` 后残留构建容器的清理
   （容器是 `--rm`，但 harness 被 kill 时来不及回收）还没定。
4. **手工脚本**：`spike/pi-durable-m1` 的 M1/M2a 脚本已指向产品 harness；M2b 的产品路径真实构建
   验收脚本 `verify:m2b-build` 见 §3；四项能力验收脚本 `verify:m3` 见 §5。
5. **遗留清理**：旧 spike 容器 `zslm-pg-durable-spike` 与 `spike/pi-durable-pg/pgdata/` 已不被使用，
   确认无用后手工 `docker rm -f` + 删目录。
6. **模型步骤的工具耗时**：harness 路径的 `ts_generation_step.toolMs` 恒为 NULL（legacy 会累加），
   用量块里「工具耗时」这一项在 harness 下缺。补法：`RunTranslator` 已经从事件流里拿到工具结果，
   用 `tool_execution_start/end` 的时间差填 `#toolOutcomes.ms` 即可。
7. **历史整理提示**：legacy 在压缩历史时发 `data-memory`，前端 `setMemoryBusy` 显示「正在整理历史」；
   harness 用 pi-durable 自己的 compaction，不发这个事件，所以这个提示在 harness 下永远不出现。
   不是功能回退，但用户可见行为有差异，删 legacy 前要确认可接受。
8. **`app/chat/steer` 的前端提示**：前端 `generating-hint` 的「已插话，模型会在当前步骤结束后处理」
   文案与 legacy 共用，harness 下同样会出现（本步未改前端）；但没有浏览器层截图证据。

## 5. 整合第二步：补齐四项缺口（2026-10-18）

四项都在 harness 路径上补齐，每项一条真实验收（`verify:m3`，13/13 PASS）加一条桩模型回归
（`tests/integration/durable-m1`）。改动文件：`src/server/durable-engine.ts`、
`src/server/durable/harness-server.ts`、`src/server/web-access/tools.ts`、`src/server/agent.ts`
（两处导出）、`src/app/api/[...path]/route.ts`、`tests/integration/durable-m1/support.ts`。

### 5.1 中途插话（`whenBusy: "steer"`）

- **做法**：`durable-engine.ts` 新增 `harnessSteerGeneration`，与 legacy 同一套产品语义（仅创建者、
  只在任务 `generating`/`building` 且有会话映射时受理，否则 409），落地改成
  `submit({whenBusy:"steer"})`：排队进 `pi.inbox`，在**当前步骤跑完后**的下一个边界落入 transcript。
  `harness-server.ts` 的 `POST /submit` 透传 `whenBusy`；`app/chat/steer` 按 `DURABLE_ENGINE` 分流。
- **证据**（`verify:m3` ①，应用 `469314331792637952`，会话 89）：
  - S1 运行中插话被受理（真实模型生成期间 POST 成功）；
  - S3 插话进入模型上下文（`/context` 的 user 消息里逐字包含插话文本）；
  - S4 **位置正确**：transcript 里插话条目下标 8，第一次助手回复下标 2、最终回复在最后
    —— 旧问题「两条插话挤在回复前」在 harness 路径不复现；
  - S5 插话作为 user 消息落 `ts_message`（刷新读回正常）。
- **用例**：`tests/integration/durable-m1/steer.test.ts`（桩模型，1 例；断言 run 中被受理 + 位置 +
  进入 `/context`）。
- **剩余**：前端分块（任务里提到的 `data-seal`）在本仓库与 `pi-durable` 的 dist 里都搜不到这个名字
  （`grep -rn 'data-seal' src tests spike` 无结果），所以没有可查对象；插话在界面上的位置由
  `app/messages` 顺序与前端本地插入决定，S4/S5 覆盖的是同一件事。

### 5.2 图片输入

- **做法**：`harnessChatResponse` 走与 legacy 同一套图片链路——能力校验（`imageInput` 为假 → 400）→
  `readAttachmentBytes` 取派生图 → base64 作为模型 content 的 `image` 块；工作区副本
  `uploadAttachmentImages` 写 `assets/uploads/`（静态）或 `public/uploads/`（工程）。
  `agent.ts` 的 `uploadFileName`/`uploadDirectory` 改为导出，两个引擎共用同一命名与目录规则。
  `harness-server.ts` 的 `/submit` 接受 content 数组（text/image 块），body 上限从 100 KB 提到 24 MB
  （12 MiB 图片的 base64 膨胀），`/context` 增加 `images` 计数；带图轮次用新的 `POST /configure` 对齐
  常驻指令（补一句「图片已随消息提供」）。
- **证据**（`verify:m3` ②，应用 `469314722521415680`，会话 128）：
  - I1 真实上传（`app/attachment/upload`）+ 真实模型生成结束 `ready/completed`；
  - I2 模型上下文里那条 user 消息 `images: 1`；
  - I3 工作区副本存在：`runtime/code_output/html_469314722521415680/assets/uploads/edd09285-m3-red.png`。
- **用例**：`tests/integration/durable-m1/attachments.test.ts`（2 例：image 块进 `/context`；非法 content
  被信任边界 400 拒绝）。
- **剩余**：工程模式 `public/uploads/` 副本未在真实 Vite 构建下重跑（与 web-access U4 同类待办）；
  一次生成只支持当前消息的图片（与 legacy 相同）。

### 5.3 构建修复轮 + 最终验证

- **做法**：`durable-engine.ts` 的 `observeHarnessRun` 从「只观察一条运行」改成
  「一轮运行 → 服务端最终验证 → 失败且可修复则注入诊断重开一轮」：
  - 每轮 `run.finalize()` 后 `setGeneration('building')` 并 `buildApp()`；构建阶段进度用
    `buildProgressWatch`（每 1 s 补一个 `started` 保活，间隔同约束 #43），成功刷新预览版本；
  - 记账：`recordBuildStep`（round / stepNumber / 阶段 / 可修复性 / cancelled），阶段构建与最终验证
    共用同一个 `buildSteps` 序号；`RunTranslator` 带 round，模型步骤的 `round` 不再写死 1；
  - 失败用 `classifyBuildFailure` 分类；可修复且 `repairs < BUILD_REPAIR_ROUNDS` 时
    `restoreGeneration` → 推 `data-build repairing` → 用 `formatBuildFeedback` 的诊断作为新一次
    `submit` 继续同一会话（上一轮消息与工具结果都还在上下文里）；
  - `sourceDigest` 未变时用 `noProgressMessage` 结束（`stopReason=verification-failed`），不做空转；
  - **replay 语义的边界**：pi-durable 的 `replay` 管的是进程崩溃/重启后被中断的工具调用是否重跑，
    与修复轮无关——修复轮是一次新的顺序提交，工具会照常执行。
- **证据**（`verify:m3` ③，应用 `469314945205403648`，生成 `5a2e5333-efcd-43fa-8643-01276bd565e4`）：
  给 React 工程 `src/App.tsx` 种入 `const m3Broken: number = "M3_SEED_BROKEN";`，第一轮让模型不改文件：
  - R1 生成流里出现 `"status":"repairing"`；
  - R2 `ts_generation_step` 落账 `build attempts=2, rounds=2`（round 1 build 8.4 s、round 2 build 11.8 s，
    都是真实容器构建）；
  - R3 最终 `ready` / `completed`，且 `src/App.tsx` 里的种子错误已被模型修掉。
- **剩余**：`noProgress`（模型连续不改文件→以原始构建错误结束）与 `BUILD_REPAIR_ROUNDS=0`（关闭）
  两条路径没有真实证据，只由代码与 legacy 同口径保证；修复轮的 UI 提示复用了前端已有的 `data-build`
  处理，未做浏览器截图。

### 5.4 联网工具

- **做法**：`web-access/tools.ts` 把四个工具的行为体抽成 `createWebAccessOperations`（会话状态与
  单次调用的运行时分离），`createWebAccessTools` 变成 AI SDK 的薄包装，行为只定义一次；
  `harness-server.ts` 的 `webToolsForConfig()` 按 `WEB_ACCESS_ENABLED`（含 `_IMAGES`）注册
  pi-durable 工具，`replay` 策略：三个读工具 `safe`，`importImage` `unsafe`（候选只在本进程内存，
  重启后的重放拿不到它）；非插话提交时重置每轮预算与候选；`/tools` 列出注册结果与 replay。
  `harnessInstructions` 在开关打开时拼入 `webAccessInstructions`。
- **证据**（`verify:m3` ④；本机 `.env` `WEB_ACCESS_ENABLED=true`，所以是真开形态）：
  - W1 harness `/tools` 列出 `webSearch / readWebPage / searchImages / importImage`；
  - W2 ① 那次真实生成里模型真的调了 `webSearch`（transcript 里两条 `provider:tavily` 工具结果）；
  - 关闭形态由 `tests/integration/durable-m1/web-tools.test.ts` 钉住（显式 `WEB_ACCESS_ENABLED=0`
    启动 harness → 一个联网工具都不注册）。
- **用例**：`tests/integration/durable-m1/web-tools.test.ts`（2 例）+ 既有
  `tests/web-access-*.test.ts` 41 例仍全过（行为体抽取未改变行为）。
- **已确认的等价性缺口**：harness 的联网工具运行时把 `ensureWritable` 做成 no-op、`write` 做成直通
  （`harness-server.ts` 的 `webRuntime`）。legacy 里这两个是把写入阻塞在租约检查上；harness 侧的取消
  由 pi-durable 自己的 abort 语义承担，但**不是等价实现**，删 legacy 前应回看。
- **剩余**：四个工具的联网返回未逐一真实验证（本机 TUN fake-IP 需要
  `WEB_ACCESS_ALLOW_NETWORKS=198.18.0.0/15,2001:2::/48`）；`searchImages`/`importImage` 在 harness
  路径下没有真实跑过一次；`importImage` 落盘用的是 harness 自己的写入路径，与 legacy 的租约检查不同源。

## 6. legacy 何时可删：判据清单

逐条判据（全部满足才动删除；删除动作仍是一次性大提交，清单见 §4.1）：

| # | 判据 | 现状 |
| --- | --- | --- |
| 1 | 四项能力在 harness 路径上有真实证据 | **已满足**（§5） |
| 2 | `tests/integration/durable-m1` + `verify:m3` 全过，`tsc`/`check:ui`/`check:e2e` 干净 | **已满足** |
| 3 | 模型选择接到产品模型配置（现在 harness 走 `DURABLE_MODEL_*` 环境变量，模型管理里改别名对 harness 不生效） | **未满足**（§4.3-1） |
| 4 | 生成用量里的「工具耗时」（`toolMs`）在 harness 路径有值 | **未满足**（§4.3-6） |
| 5 | 历史整理的用户可见提示有对等物（`data-memory` 在 harness 下不出现） | **未满足**（§4.3-7，或明确接受差异） |
| 6 | 联网工具的租约检查等价（`ensureWritable`/`write` 现在是 no-op/直通） | **未满足**（§5.4） |
| 7 | 图片副本在工程模式（`public/uploads/`）真实构建路径下验证过 | **未满足**（§5.2） |
| 8 | 构建修复轮的 `noProgress` 结束与 `BUILD_REPAIR_ROUNDS=0` 关闭路径真实跑过 | **未满足**（§5.3） |
| 9 | 一次产品主流程端到端验收（生成 → 插话 → 构建 → 预览 → 刷新读回，浏览器层） | 第一步的 `verify:m2b-build` 8/8 覆盖了生成/构建/预览/刷新，插话与图片在本步只到接口层 |
| 10 | 数据库换 Postgres（§4.2）完成，或确认对话数据仍双写 `ts_message` 可接受 | **未满足**（§4.2） |

要点：第 3 条是删 legacy 的硬门槛（不接产品模型配置，删掉 legacy 后用户在模型管理里的改动就完全
不生效）；第 5、6 条可以先判定为「可接受的差异」再删，但必须写成显式决定而不是默认忽略。

## 7. 整合第三步：删掉 legacy 引擎与自研上下文层（2026-10-18）

本步把 `agent.ts` 的旧 AI SDK 循环与只为它存在的自研上下文层整块删掉。生成入口现在只有一条路径：
`app/chat/gen/code` → `harnessChatResponse`（`src/server/durable-engine.ts`）→ 常驻 pi-durable harness。
判据清单（§6）的第 1–2 条已满足；第 3–10 条没有在删除前补完，处置与本步的差异显式记在 §7.6。

### 7.1 删除清单（文件级）

**整文件删除 —— 源码（自研上下文层）**

| 文件 | 原来干什么 |
| --- | --- |
| `src/server/memory-window.ts` | 摘要窗口规划（预算、最小新回合、冷却） |
| `src/server/memory-context.ts` | 回合装载（`groupTurns`/`turnsAfter`/`recentWithinBudget`） |
| `src/server/memory-consolidate.ts` | 摘要模型调用与提交 |
| `src/server/memory-serialize.ts` | 回合序列化、token 估算、摘要提示词 |
| `src/server/memory-store.ts` | `ts_app_summary` 读写与版本 CAS |
| `src/server/memory-types.ts` | 摘要游标与回合类型 |
| `src/server/memory-model.ts` | 可选摘要别名 `memory.summarize` 解析与 `summarizeHistory` |

**整文件删除 —— 测试**

| 文件 | 原因 |
| --- | --- |
| `tests/memory-window.test.ts`、`tests/memory-context.test.ts`、`tests/memory-serialize.test.ts`、`tests/memory-model.test.ts`、`tests/memory-config.test.ts`、`tests/memory-fixtures.ts` | 只测上面这些模块 |
| `tests/integration/memory-generation.test.ts` | 走 legacy 循环的摘要端到端 |
| `tests/e2e/memory-summary.spec.ts` | 前端「正在整理历史上下文」提示的浏览器用例；harness 用 pi-durable 自己的 compaction，不发 `data-memory` |
| `tests/integration/agent-persistence.test.ts`、`agent-image-input.test.ts`、`agent-unbounded-steps.test.ts`、`agent-vue-build.test.ts`、`build-progress.test.ts`、`build-repair-loop.test.ts`、`chat-steering.test.ts`、`generation-accounting.test.ts`、`generation-disconnect-build.test.ts`、`milestone-preview.test.ts`、`model-stream-retry.test.ts`、`rate-limit-http.test.ts` | 全部直接调 `chatResponse` / `steerGeneration` 或经 HTTP 路由驱动 legacy 循环（后者的引擎分流在整合第二步就已把它们变成 500，属既有红） |
| `tests/manual/build-repair.eval.ts` + `vitest.eval.config.ts` + `package.json` 的 `eval:repair` | 手工评估工具包在 legacy 循环的边界上（包 `taskModelsFor`、包 `chatResponse`），无法移植；需要时按 harness 重写 |

**改写（保留产品行为，去掉 legacy 依赖）**

| 文件 | 改法 |
| --- | --- |
| `tests/integration/http.test.ts` | 删 3 例 legacy 生成用例（工具循环持久化 / 多文件两轮 / 取消+重复运行），把「图片素材按应用权限读取」的历史文本断言去掉，把租约用例改成只测「过期租约恢复为失败 + 伪造系统消息被拒」，`chatHistory` 计数改 0。保留其余 10 例（鉴权、跨来源、注册登录、分页、管理员编辑、下载 ZIP、逻辑删除） |
| `tests/integration/feature-parity.test.ts` | F18（敏感词/注入/超长输入在创建任务前被拒）改调 `harnessChatResponse`：`validatePrompt` 与请求体校验在提交 harness 之前，语义不变 |
| `tests/integration/template-generation.test.ts` | 删 2 例 legacy 生成用例，保留「显式模板覆盖自动路由 + 类型/模板冲突拒绝」 |
| `tests/model-task-binding.test.ts` | 删 4 例 `taskModelsFor` 用例（摘要模型绑定），保留「任务进行中的模型绑定冻结」 |
| `tests/integration/durable-m1/*` | 契约级回归；`verify:m3` 的四项能力证据保留为手工脚本 |

**源码内的删除**

| 位置 | 删了什么 | 保留了什么 |
| --- | --- | --- |
| `src/server/agent.ts` | 旧 AI SDK 循环整体：`chatResponse`、`steerGeneration`、`retryableStreamErrors`、`buildModelMessages`、`attachModelImages`、工具集与描述、构建看门狗、修复轮循环、SSE 响应包装（约 570 行） | `generationRequestSchema`（两个入口共用的请求体校验）、`uploadFileName` / `uploadDirectory`（harness 路径复用）、`cancelGeneration`（任务态是权威，两个引擎共用） |
| `src/server/generation-store.ts` | 回合/终态装配（`groupTurns`+`statuses`）、`BeginGenerationContext.turns/summary`、`messagesFrom`、`readSummaryInTx` 调用 | 租约/心跳/终态/`withAppWriter`、用户消息历史文本镜像、旧 `ts_chat_history` 补迁（`legacyMessage`/`pendingLegacyRows`/`orderRows`）、`loadMessages` 的区块排序 |
| `src/server/generation-accounting.ts` | `recordModelStep`+`toolCallsOf`（SDK `StepResult` 口径）、`recordSummaryStep`、对 `StepResult`/`SummaryCallResult` 的依赖 | `recordAssistantStep`（harness 条目口径）、`recordBuildStep`、读取端与 `stopReasonOf`/`stopReasonFrom` |
| `src/server/model.ts` | `taskModelsFor`、`TaskModels`、对 `memory-model` 的依赖 | `modelBindingFor`（含 `imageInput` 能力）、`modelFor`、`routeCodeGenType`；`aliasNotConfiguredMessage`/`isAliasNotConfigured`/`ModelBindingSource` 移到这里定义 |
| `src/server/speech.ts` | — | `isAliasNotConfigured` 改从 `./model` 导入（别名解析的共用判断，`speech.transcribe` 仍用它区分「未配置」与其它错误） |
| `src/server/config.ts` | `DURABLE_ENGINE`、9 个 `MEMORY_*` 变量与 3 条互斥校验 | 其余配置不变 |
| `src/app/api/[...path]/route.ts` | 引擎分流（`getConfig().durable.engine`），生成/取消/插话直接走 harness 入口 | — |
| `scripts/durable-dev.ts`、`.env.example` | `DURABLE_ENGINE` 与 `MEMORY_*` 段落 | 新增 `DURABLE_*` 说明与「一条命令起全套」的注释 |
| `package.json` | `eval:repair` 脚本 | — |

### 7.2 保留 `tool-transcript.ts` 与租约/终态的理由

这两块**不是**只为 legacy 存在，删掉会造成真实回退，所以留在产品路径：

- `src/server/tool-transcript.ts`：`generation-store.storeAssistant` 用它把助手消息的工具条目渲染成
  `ts_chat_history` 里给人读的文本（列表、管理员查询、下载历史）。harness 路径也走同一条
  `finishGeneration`，所以这个渲染仍然生效。
- `generation-store` 的租约、心跳、`restoreGeneration`、终态与 `withAppWriter`：任务行是权威，
  harness 路径的取消/超时/「失去租约」判断（`observeHarnessRun` 的 5 秒心跳）与阶段构建的写锁都靠它。
  `ts_generation_step` 记账同理（harness 写 `recordAssistantStep`/`recordBuildStep`）。

### 7.3 `spike/` 的去向

| 位置 | 处置 |
| --- | --- |
| `spike/pi-durable-pg/src/*`、`pg.sh` | 整合第一步已移进产品（`src/server/durable/storage-pg.ts`、`harness.ts`、`faux-model.ts`、`scripts/durable-pg.sh`），spike 不留第二份 |
| `spike/pi-durable-pg/experiments/`、`test/`、`evidence/`、`vitest.config.ts` | **删除**（一次性可行性实验与一致性套件；storage 的回归现在由 `tests/integration/durable-m1` 的 restart/replay/conversation 覆盖） |
| `spike/pi-durable-pg/run.sh`、`package.json`、`README.md`、`tsconfig.json`、`pgdata/` | **保留**：`run.sh` 是 `spike/pi-durable-m1` 手工脚本的入口（模型环境派生 + `node --experimental-strip-types`）。`package.json` 只剩依赖清单 |
| `spike/pi-durable-pg/node_modules` | 我误删过一次，已重建为 `→ paimeng-ai-code-agent/node_modules` 的软链（gitignored）；缺了在 `spike/pi-durable-pg` 里 `npm install` |
| `spike/pi-durable-m1/src/verify-*.ts`、`client.ts`、`product.ts`、`run.sh`、`setup.sh` | **保留**：唯一还值得跑的是真实模型 + 浏览器的验收脚本（`verify:m3`、`verify:m2b-build`、`verify:m2a`） |
| `spike/pi-durable-m1/evidence/`、`evidence-m2a/`、`evidence-m2b/`、`runtime-out/` | **删除**（同一套脚本的旧证据，已被 `evidence-m3/` 取代） |
| `spike/pi-durable-m1/evidence-m3/` | **保留**：§5 四项能力与产品主流程那次验收的原始输出与截图 |
| `spike/pi-durable-pg/pgdata/` | 删除**失败**（目录属主是容器用的 `dnsmasq` 用户，当前账号无权限）。无容器在用它（`docker ps` 没有 `zslm-pg-durable-spike`），需要时手工 `sudo rm -rf spike/pi-durable-pg/pgdata` |

`spike/` 现在的定位写在 `spike/pi-durable-m1/README.md`：**已停止维护的手工验收脚本**，契约级回归在产品目录的
`tests/integration/durable-m1/`。

### 7.4 残留检查

命令与输出（产品树，`src` / `tests` / `scripts`）：

```bash
$ grep -rn "memory-window\|memory-context\|memory-consolidate\|memory-serialize\|memory-types\|memory-store\|memory-model\
\|taskModelsFor\|TaskModels\|SummaryModelSource\|SummaryCallResult\|recordModelStep\|recordSummaryStep\
\|MEMORY_\|DURABLE_ENGINE\|chatResponse\|steerGeneration\|retryableStreamErrors\|buildModelMessages" \
  src tests scripts --include=*.ts --include=*.tsx
(无输出，exit 1)

$ grep -rln "memory-window\|memory-context\|memory-consolidate\|memory-serialize\|memory-model\|tool-transcript" src tests scripts
src/server/generation-store.ts      # tool-transcript（保留，见 §7.2）
tests/tool-transcript.test.ts       # 同上
```

历史计划文档仍有指向已删模块的叙述（`pi-durable-m1.md`、`pi-durable-m2.md`、`pi-durable-data-model.md`、
`agent-design-review.md`）；它们是有日期的设计记录，改成现状会抹掉当时的判断，所以在每篇开头加了一行
「历史文档，见 §7」的提示，不逐句改写。

### 7.5 本步验收结果（2026-10-18）

| 验收 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npx tsc --noEmit` | 干净（exit 0） |
| **全量测试（串行单跑）** | `npm test`（= `vitest run`） | **58 文件 / 444 用例全过**，749.57s；Postgres 已起，所以 `tests/integration/durable-m1` 9 文件 16 用例也在内 |
| durable 回归 | `npx vitest run tests/integration/durable-m1` | 9 文件 16/16（需 `npm run durable:pg -- start`） |
| 静态门禁 | `npm run check:ui` / `npm run check:e2e` | 通过（24 个 tsx / 13 个 spec） |
| 残留检查 | 见 §7.4 的两条 grep | 无源码引用残留 |
| **真实端到端**（真实模型 + 真实 Postgres + 真实容器构建 + 浏览器） | `npm run dev` + `spike/pi-durable-m1` 的 `verify:m3` / `verify:m2b-build` | **13/13 + 8/8 PASS**（删除之后重跑，见下） |

删除前先确认过「红的是该删的，不是删错了」：在 HEAD（`878f3c2`，未删除任何东西）上单跑
`tests/integration/http.test.ts` 与 `tests/integration/rate-limit-http.test.ts`，它们是**既有红**
（整合第二步把默认引擎切成 harness 后，这两组用例驱动的还是 legacy 循环，路由分流让 HTTP 路径返回 500）。
所以删除后重跑全量是「58 文件 444 用例全过」，没有把真回归掩盖掉；其中能保住产品行为的断言已按 §7.1 改写。

**真实端到端已在删除之后重跑**（2026-10-18 15:33–15:37，`npm run dev` 起的真实链路）：

- `verify:m3`（`spike/pi-durable-m1`）**13/13 PASS**：真实模型 `oc-go/deepseek-v4.1-flash`、真实 Postgres、
  真实上传（`app/attachment/upload`）。四项能力各自的断言全过——插话 S1–S5（运行中受理、进入模型上下文、
  位置在第一次回复之后、落 `ts_message`）、图片 I1–I3（生成 `ready/completed`、模型上下文 `images:1`、
  工作区副本写到 `assets/uploads/`）、修复轮 R1–R3（流里出现 `repairing`、`ts_generation_step` 记
  `build attempts=2 rounds=2`、最终 `ready/completed`）、联网 W1–W2（四个工具都注册、真实生成里模型调到了 `webSearch`）。
- `verify:m2b-build`（浏览器层）**8/8 PASS**：气泡长度序列 12 个不同值（真流式）、工具条目
  （列出/读取/修改文件 + 阶段构建）、构建时间线四个阶段全部 `ok`、**真实容器构建 13545ms**、
  预览刷新（`pv=1`）、刷新后读回文本与工具条目。

原始输出与截图在 `spike/pi-durable-m1/evidence-m3/`（`timeline-m3-features.txt`、`timeline-m3.txt`、
`m3-streaming.png`、`m3-final.png`、`m3-reloaded.png`、`results-m3-features.json`，都是本步这次运行的）。

```bash
cd paimeng-ai-code-agent && npm run dev      # Postgres + harness + Next dev(3100)
cd ../spike/pi-durable-m1 && npm run verify:m3       # 四项能力 13 项断言
npm run verify:m2b-build                             # 产品主流程 8 项断言（真实容器构建 + 预览刷新）
```

### 7.6 判据清单的最终处置（§6 → 现状）

判据是为「敢不敢删」写的；删除已经执行，所以下表改成**产品能力缺口清单**：第 3–8 条是**已知差异/待办**，
不是回归（legacy 的行为在删除前就没被 harness 完全覆盖，删掉它不会让现状变差，只是少了一条回退路径）。

| # | 判据 | 处置 |
| --- | --- | --- |
| 1 | 四项能力有真实证据 | 满足（§5） |
| 2 | durable 回归 + `tsc`/`check:ui`/`check:e2e` | 满足（§7.5，含全量） |
| 3 | 模型选择接到产品模型配置 | **待办**：harness 仍走 `DURABLE_MODEL_*`，管理端改别名对生成不生效（模型管理页面上的别名只进记账行） |
| 4 | `toolMs` 在 harness 路径有值 | **待办**：`RunTranslator` 已有 `#toolOutcomes`，用 `tool_execution_start/end` 时间差填 `ms` 即可 |
| 5 | 历史整理提示的对等物 | **接受差异**：harness 用 pi-durable 的 compaction，不发 `data-memory`，前端不再出现「正在整理历史上下文」提示。已删除对应的浏览器用例与前端文案依赖 |
| 6 | 联网工具租约检查等价 | **接受差异**：`harness-server.ts` 的 `webRuntime` 仍是 `ensureWritable` no-op + `write` 直通；取消由 pi-durable 自己的 abort 语义承担 |
| 7 | 工程模式 `public/uploads/` 真实构建 | **待办**：接口层已验证，真实 Vite 构建下的素材路径未跑（与 web-access U4 同类） |
| 8 | 修复轮 `noProgress` / `BUILD_REPAIR_ROUNDS=0` | **待办**：只有代码与 legacy 同口径，没有真实证据 |
| 9 | 一次产品主流程端到端（浏览器层） | **待办**（§7.5 末段；脚本现成） |
| 10 | 数据库换 Postgres | **下一步**（§7.7） |

### 7.7 剩余待办：数据库换 Postgres（下一步的清单）

1. **Drizzle 驱动**：`mysql-core` → `pg-core`；`src/server/schema.ts` 全部表按域重建，列名改 snake_case
   （data-model §3）。`src/server/db.ts` 的 pool、`now()`、`onDuplicateKeyUpdate`、`.for('update')` 与
   `affectedRows` 这些 MySQL 口径要逐个换（`onDuplicateKeyUpdate` → `onConflictDoUpdate`）。
2. **连接串校验**：`getConfig()` 现在硬性要求 `mysql:` 前缀与库名白名单（`paimeng_ai_code_mother_ts(_test)`），
   要改成 Postgres 的库名/账号策略；`DURABLE_PG_URL` 与 `DATABASE_URL` 合并成一条（harness 已经有 pg 实现）。
3. **业务行搬迁**：user / app / model_provider / model_alias / attachment / ts_rate_limit / 登录会话。
   对话数据放弃：`ts_message`、`ts_generation`、`ts_generation_step`、`ts_chat_history`、
   `ts_app_summary`、`ts_lease`、`ts_snowflake_state`（发号下界要么搬，要么确认不再需要）。
4. **`app.conversation_id` 清空**：harness 的会话在另一个库/实例里，换库时一次性清空该列
   （`durable-engine.ts` 的 404 自愈能兜住，但一次性清更干净）。
5. **删旧表与迁移**：`migrations/` 里建 `ts_*` 表的那些 SQL 与 drizzle 定义同步删除，只保留 Postgres 的新迁移；
   `scripts/migrate.ts` / `scripts/test-database.ts` / `scripts/import-legacy.ts` 一起改。
6. **一次性 Postgres 换成常驻服务**：`scripts/durable-pg.sh` 现在起 `zslm-pg-durable`（127.0.0.1:55432）；
   换库时改成 `compose.yaml` 里的固定服务（与 `zslm-mysql` 同级的 `zslm-postgres`，或复用已有的 5432 实例），
   并把 `runtime/durable-pg/pgdata` 的落点与权限写进 README。
7. **回归基线**：迁移后重跑 `npm test`（本轮基线：58 文件 / 444 用例）、`tests/integration/durable-m1`，
   再跑一次 §7.5 的真实端到端；`scripts/verify-restart.ts` 的快照流程也要按新库核对。
8. **顺带**：`tests/integration/http.test.ts` 的 `chatHistory` 计数、`scripts/admin.ts`、管理员历史分页都直接读
   `ts_chat_history`，换库时一起验。

### 7.8 删除的外溢：两个「暂时没有产品调用方」的记账助手

`src/server/generation-accounting.ts` 里有两个符号的唯一调用方是 legacy 循环与它的集成用例，删完后产品路径不再调它们，
但**保留**（它们是记账模块的读侧与停止原因策略，harness 路径正好该用）：

- `generationAccount(generationId)`（单次读取）：原本由 `agent-unbounded-steps.test.ts`、
  `generation-accounting.test.ts`、`milestone-preview.test.ts` 使用，这些用例已删；HTTP 侧只用 `generationAccounts`。
- `stopReasonOf(...)`：原来由 `agent.ts` 的 legacy 循环调用（`tests/generation-accounting.test.ts` 仍在测它）。
  **顺带发现的行为差异**：harness 路径的 `observeHarnessRun` 直接用状态机写 `stopReason`
  （`cancelled`/`model-error`/`verification-failed`/`completed`），不再走 `stopReasonOf`，所以
  `GENERATION_TIMEOUT_MS` 超时会被记成 `cancelled`、失去租约会被记成 `model-error`，而不是旧口径的
  `timeout` / `lease-lost`。默认不限时（`GENERATION_TIMEOUT_MS=0`）时很难触发，但这是一条真实的记账口径差异，
  属 §4.3-6 那一类，留作待办（接法：`observeHarnessRun` 的 catch 用 `stopReasonOf` 归一化 abort 原因）。

其它与本步相关、不属于换库的待办：§7.6 的第 3、4、7、8、9 条；`tests/e2e` 里 `chat-*` 用例当前只拦接口不调真实模型，
若要覆盖「浏览器里真实生成一次」需要 `dev` 常驻在 E2E 环境里；`spike/pi-durable-pg/pgdata` 的权限残留（§7.3）。
