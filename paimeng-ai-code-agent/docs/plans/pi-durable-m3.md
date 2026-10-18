# Pi Durable 迁移 · M3：整合进产品（提拔 + 切默认引擎 + 删临时物）

状态：**整合第一步已完成、第二步已完成**（2026-10-18）。分支 `feat/pi-durable-migration`，基线 `main@d0c9797`
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
| `src/server/durable/harness-server.ts`（整合第二步） | 新增 `POST /configure`（按轮次对齐常驻指令）；`POST /submit` 接受 content 数组（text/image 块）与 `whenBusy`；body 上限 100 KB → 24 MB；`/context` 增加 `images` 计数；`/tools` 列出联网工具的 `replay`。见 §5 |
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
| durable 回归 | `npx vitest run tests/integration/durable-m1` | 6 文件 11 用例全过（21s，含真实 Postgres）；第二步之后 9 文件 16 用例 |
| 静态检查 | `npm run check:ui` / `npm run check:e2e` | 通过 |
| **四项能力真实验收** | `npm run dev:durable` + `spike/pi-durable-m1` 的 `npm run verify:m3` | **13/13 PASS**（真实模型、真实上传、真实容器构建），见 §5 |
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

原计划的第 ③ 步（删 `memory-*.ts`、窗口/摘要/游标/租约、流式重试包装、`tool-transcript.ts`，
data-model §2）**仍未做**。当时的原因是「删它们等于删整个 legacy 引擎，而 harness 还缺四项已上线能力」，
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
3. **进程编排/部署**：`dev:durable` 只覆盖本机开发；生产形态、重启策略、`kill -9` 后残留构建容器的清理
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
