# Pi Durable 部署形态与收尾设计

状态：**设计稿，本文件只写方案，不改产品代码、不执行清理**（2026-10-18）。分支 `feat/pi-durable-migration`，
基线 `0f10f70`（M4 之后，产品库已是 Postgres）。前面四步的记录见
[data-model](./pi-durable-data-model.md)、[m1](./pi-durable-m1.md)、[m2](./pi-durable-m2.md)、
[m3](./pi-durable-m3.md)、[m4](./pi-durable-m4.md)。

本文回答五件事：进程拓扑与配置、启动与健康、数据（迁移 / 备份 / 旧库归档）、收尾清单、
风险与取舍。**所有「现状」都指到代码或本机实测；所有「方案」都不是既成事实。**

## 0. 一句话结论

产品稳态是**两个业务进程、一个 Postgres 实例**：常驻 harness 进程独占 pi-durable 存储的写权（`pg_advisory_lock`
强制），Next 进程只做 attach 客户端与 SSE 转发。**存储与产品表现在落在同一个实例的两个 database 里**
（`paimeng_ts` 放业务表，`durable` 放 pi-durable 存储表）——这与 `.env.example` / README 里「同库」的说法
不一致，是本次勘察新发现的现场事实，见 §1.1 的「存储落点」。本机开发已经这么跑
（`npm run dev:durable`）；要「上线」还缺三样**配置与编排**（不涉及新的业务代码）：把一次性 Postgres 容器
提升为固定服务、把 harness 变成有重启策略的常驻服务并加一个启动前置（迁移 + 单写者互斥）、
以及旧 MySQL 归档的清理决定。真正需要新代码才能解决的只有两件事：**全局并发上限**（现在没有，
只有「单应用一个活跃生成」）与 **`kill -9` 后残留构建容器的清扫**（另有一个可选的 Next 健康检查路由，见 §2.2）。

## 1. 进程拓扑

### 1.1 三个组件，各自的独占资源

| 组件 | 入口 | 独占的东西 | 依据 |
| --- | --- | --- | --- |
| harness（常驻） | `npm run durable:harness` → `src/server/durable/harness-server.ts` | pi-durable 存储的**唯一写者**（`pg_advisory_lock`）；`runtime/durable/workspace` 与 `runtime/durable/tools.jsonl`；harness 端自己起的构建容器 | `storage-pg.ts:312-334`（open + `pg_try_advisory_lock`，失败抛 `Postgres storage is already open by another process`）、`harness-server.ts:64-68`（runDir / port） |
| Next（可多份） | `npm run dev` / `next start`，`src/app/api/[...path]/route.ts` | 无独占：产品业务表走行锁与 `generation_lease`，对话存储只经 `DURABLE_HARNESS_URL` 访问 | `config.ts:39-40`（`DURABLE_HARNESS_URL` 默认 `http://127.0.0.1:5599`）、`durable-engine.ts:118-136` |
| Postgres 16 | `scripts/durable-pg.sh`（现状）/ 固定服务（目标） | 一个**实例**装两个 database：`paimeng_ts` 放产品业务表（`migrations/001_initial.sql`，`app`、`app_user`、`generation*`、`model_*`…），`durable` 放 pi-durable 存储表（`durable_*`、`conversations`、`entries`、`tasks`、`submissions`、`documents`、`document_revisions`、`record_ids`，由 storage 自己建） | `migrations/001_initial.sql`、`storage-pg.ts:177-189`、实测 `psql -d paimeng_ts -c '\dt'` 13 张业务表 / `psql -d durable -c '\dt'` 9 张存储表 |
| Redis | `compose.yaml` 的 `redis` 服务 | 无（当前只做基础设施就绪验证） | `scripts/verify-infra.ts` |

两条容易漏掉的**共享文件系统**约束：

1. harness 与 Next **都要读写同一个 `runtime/`**：Next 的最终验证（`durable-engine.ts:444` 调 `buildApp`）、
   附件的 workspace 副本、下载 ZIP、预览服务都基于它；harness 的 `buildPreview` 工具也调同一个 `buildApp`
   （`harness-server.ts:272`）。两边必须看到同一份 `runtime/code_output/<app>`，否则会出现「构建成功但预览空」。
2. harness 的 `DURABLE_HARNESS_RUN_DIR`（默认 `<cwd>/runtime/durable`）是它自己的状态目录，只有它能用；
   多份 harness 不允许（本来也被 advisory lock 挡住）。

**存储落点（本次勘察新发现的现状与文档不一致，需决定）**

三个数据源对「存储放哪个 database」的说法不同：

| 来源 | 说法 |
| --- | --- |
| `.env.example:79` 注释 | 「harness 与产品共用 `DATABASE_URL`；只有在把会话存储指到别的库时才需要 `DURABLE_PG_URL`」 |
| `scripts/durable-dev.ts:34`（实际 dev 行为） | `process.env.DURABLE_PG_URL ?? 'postgres://spike:spike@127.0.0.1:55432/durable'`，并且**总是**把它作为 `DURABLE_PG_URL` 注入 harness |
| `src/server/durable/storage-pg.ts:58`（storage 自身的回退链） | `DURABLE_PG_URL ?? DATABASE_URL ?? '…/paimeng_ts'` |
| `tests/integration/durable-m1/support.ts:18` | 默认 `…/paimeng_ts_test`（与产品测试表同库），允许 `DURABLE_PG_URL` 覆盖 |

实测（worktree 的 `.env` 只有 `DATABASE_URL=…/paimeng_ts`，没有 `DURABLE_PG_URL`）：`paimeng_ts` 有 13 张业务表
（无 `entries` 等）与 116 行 `app`；`durable` 有 9 张存储表与 9 行 `conversations`。也就是说 **dev 的真实形态是「同实例、两库」**，
而 M4 的一次性搬迁与 `db:migrate` 只作用在 `paimeng_ts`。

两种形态都成立，取决于 `DURABLE_PG_URL` 是否显式等于 `DATABASE_URL`：

- **同库**：存储表与业务表挤在 `paimeng_ts`。好处是备份/迁移/权限只有一份，`pg_dump` 一次拿全；
  代价是 `DURABLE_HARNESS_RESET=1`、durable 自己的 schema 版本表与业务表混在一起（各自有版本表，不冲突）。
- **两库**：当前 dev 形态。好处是权限与误操作面分开（harness 账号可以只授权 `durable`）；
  代价是**备份要备两个库**、迁移要跑两处、部署时容易只连错一个。

建议：**固定为同库**（把 `.env.example` 的 `DURABLE_PG_URL` 显式写成 `$DATABASE_URL` 的值，并让 `durable-dev.ts`
的默认值与 `storage-pg.ts` 一致），因为备份与回滚只有一条路径；如果选两库，`.env.example` 必须把
`DURABLE_PG_URL` 写成独立条目并在部署文档里当作两个数据库对待。这是**需要用户拍板的一条**（见 §4 第 8 条）。

### 1.2 形态 A：本机开发（现状，已实测）

```
Postgres（zslm-pg-durable，127.0.0.1:55432，库 paimeng_ts + durable，数据目录 runtime/durable-pg/pgdata）
  ↑                                    ↑
harness（127.0.0.1:5599）  ← attach ←  Next dev（127.0.0.1:3100, DURABLE_APP_PORT）
```
`npm run dev:durable`（`scripts/durable-dev.ts`）= 端口探测 → 需要就 `durable-pg.sh start` → 起 harness
（从 `~/.pi/agent/models.json` 的 `oc-go` 派生 `DURABLE_MODEL_*`，并固定注入 `DURABLE_PG_URL=…/durable`，
都只进子进程）→ 轮询 `/health` 最多 30 s → 起 `next dev --webpack --port 3100`（`APP_ORIGIN=http://localhost:3100`）。
Ctrl-C 对整个子进程组先 SIGTERM、5 s 后 SIGKILL；**只停自己起的** Postgres（`startedPostgres` 标志）。生产/预览/Redis 的常规命令见 README。

### 1.3 形态 B：单机部署（推荐的第一目标）

同一台主机上三个 systemd（或 compose）单元，顺序由依赖决定：

| 单元 | 角色 | 关键配置 |
| --- | --- | --- |
| `postgres` | 数据库 | 固定容器/服务，命名卷（**不要用 host bind mount**，理由见 §4 第 1 条），只绑 `127.0.0.1` 或私网，健康检查 `pg_isready`；若采用「两库」形态，要建 `paimeng_ts`（+ `paimeng_ts_test`）与存储库两个 database |
| `paimeng-harness` | 唯一写者 | `Restart=always`、`WorkingDirectory=<repo>/paimeng-ai-code-agent`（runDir/runtime 是 cwd 相对）、`ExecStartPre=/usr/bin/npm run db:migrate`、完整产品 env + `DURABLE_*`、只绑 `127.0.0.1` |
| `paimeng-app` | Next | `next build` + `next start`，`DURABLE_HARNESS_URL=http://127.0.0.1:5599`，`APP_ORIGIN`/`PREVIEW_ORIGIN` 由反代决定，`After=paimeng-harness.service` |
| `paimeng-preview` | 预览静态服务 | 与 Next 同机（要读同一个 `runtime/`），端口取 `PREVIEW_ORIGIN` |

反代（唯一对外的入口）把用户流量给 Next，把预览主机名给 preview 进程；**harness 不对外**。

### 1.4 形态 C：多实例

| 能水平扩的 | 只有一份的 |
| --- | --- |
| Next 进程（attach 客户端 + 产品表 CRUD）。`generation_lease`、`rate_limit`、`id_sequence` 都已经是 DB 协调，多进程安全 | harness 进程：第二个进程在 `PostgresStorage.open()` 的 advisory lock 上直接失败退出 |
| 无状态的东西（静态资源、SSE 转发） | `runtime/` 目录：多机部署要么共享卷，要么把 harness 与预览固定在同一台 |

注意两点：

- advisory lock 是**库级**的（`pg_try_advisory_lock` 的锁在 `pg_locks` 里带 `database` 列）。所以「单写者」
  只在**指向同一个存储 database**时成立：两个 harness 指到不同库会各自成功，然后两份存储各铸各的 ID（推断，
  依据 Postgres 语义 + `storage-pg.ts:321` 的 `pg_try_advisory_lock`）。部署时必须断言所有 harness 的
  `DURABLE_PG_URL`（或它回退到的 `DATABASE_URL`）指向同一条连接串——两库形态下这条串是**存储库**，
  不是产品库。
- 多 Next 实例全部 attach 到**同一个** `DURABLE_HARNESS_URL`；不能各起一个 harness。

### 1.5 环境变量清单

**给定 harness 的（缺一个就起不来或起错库）**

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DURABLE_HARNESS_HOST` | `127.0.0.1` | 只绑回环；跨机才改，改动即等于把单写者暴露在网络上 |
| `DURABLE_HARNESS_PORT` | `5599` | |
| `DURABLE_HARNESS_RUN_DIR` | `<cwd>/runtime/durable` | 工具日志 `tools.jsonl` 与默认 workspace 的父目录 |
| `DURABLE_HARNESS_WORKSPACE` | `${runDir}/workspace` | 根会话工作区 |
| `DURABLE_HARNESS_RESET` | 未设 | `=1` 时启动前 DROP 全部 durable 表。**只给测试/一次性环境**，生产设了就是清空所有对话 |
| `DURABLE_PG_URL` | 见下 | 存储连接串。回退链是 `DURABLE_PG_URL` → `DATABASE_URL` → `…/paimeng_ts`（`storage-pg.ts:58`），但 **`dev:durable` 会先给一个 `…/durable` 的默认值并注入子进程**（`durable-dev.ts:34`），所以 dev 现状是两库。部署时必须显式写死，不要依赖默认 |
| `DURABLE_MODEL_BASE_URL` / `_API_KEY` / `_ID` | 无 | harness 直连模型（OpenAI 兼容）。`durable-dev.ts` 从 `~/.pi/agent/models.json` 派生，只在子进程注入 |
| `DURABLE_FAUX_MODEL` | 未设 | `=1` 用确定性桩模型 |
| 产品 env | — | harness 启动时 `webToolsForConfig()` → `getConfig()`（`harness-server.ts:338`），所以 **`DATABASE_URL`、`APP_ORIGIN`、`PREVIEW_ORIGIN`、`BUILD_*`、`WEB_ACCESS_*` 也必须在 harness 的环境里合法** |

**给定 Next 的**

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | 无（必填） | 必须 `postgres:`，库名白名单只允许 `paimeng_ts` / `paimeng_ts_test`（`config.ts:45,47`） |
| `DURABLE_HARNESS_URL` | `http://127.0.0.1:5599` | attach 地址；**启动时不校验可达性**，harness 不在时生成/读历史返回 500 `服务处理失败`（`http.ts` 的 `failure`） |
| `APP_ORIGIN` / `PREVIEW_ORIGIN` | — | 必须都是无凭据 HTTP(S) 且**不同主机名**（Cookie 隔离，`config.ts:46,48-49`） |
| `REDIS_URL` | — | |
| `MODEL_SECRET_KEY` 或 `runtime/model-secret.key` | 自动生成 0600 文件 | 解密 `model_provider.api_key_ciphertext`；多实例要共享同一个密钥 |
| `BUILD_IMAGE` / `BUILD_NPM_REGISTRY` / `BUILD_TIMEOUT_MS` / `BUILD_REPAIR_ROUNDS` | 见 `.env.example` | 构建与修复轮 |
| `CHAT_RATE_LIMIT_*` | USER 1/60s | |
| `WEB_ACCESS_*` | 默认关 | harness 侧注册联网工具，读的是**harness 进程**的 env |
| `GENERATION_TIMEOUT_MS` | `0`（不限） | 见 §5.4 |
| `MODEL_REPLY_TIMEOUT_MS` / `MODEL_RETRY_LIMIT` | `900000` / `5` | |

**只有 `dev:durable` 读的**：`DURABLE_APP_PORT`（3100）、`DURABLE_APP_ORIGIN`。

**需要显式决定的重复来源**：模型凭据现在有两份。产品库里的 `model_provider` 给 Next 的路由分类/语音用，
harness 只认 `DURABLE_MODEL_*` 环境变量（m3 §7.6 第 3 条的已知缺口）。部署时这是**两处独立的密钥管理**，
管理端改密钥不会影响生成链路。

## 2. 启动与健康

### 2.1 启动顺序（硬依赖）

```
Postgres 就绪 (pg_isready)
  → 迁移产品库 (npm run db:migrate，幂等) + 一次性的 db:init-models
  → harness 起（自己建/迁移 durable 表 → resume() 恢复被杀进程留下的任务 → listen）
  → 探 harness /health 通过
  → Next 起（next start）
  → 预览进程起
```

顺序理由：harness 的 `open()` 会自己建 durable 表，但产品库的表必须由 `db:migrate` 建（`migrations/001_initial.sql`）；
`harness.resume()`（`harness-server.ts:478`，注释「Schedule work left behind by a killed process before serving traffic」）
在 listen 之前跑，所以重启后残留任务会先被恢复/标记，再接受新请求。

### 2.2 健康检查

| 检查 | 现状 | 建议 |
| --- | --- | --- |
| harness 存活 | `GET /health` → `{ok:true,pid,conversationId}`（`harness-server.ts:605-608`） | 直接用作 liveness + readiness（resume 完成后才 listen，所以 listen 成功即就绪） |
| Postgres | `npm run verify:infra` 探临时表读写，但**硬编码 `127.0.0.1:55432` 与账号 `spike`**（`scripts/verify-infra.ts:9-13`） | 部署版要么改脚本按 env 解析，要么只用 `pg_isready` + `/health` |
| Redis | `verify:infra` 硬编码 `127.0.0.1:6379` 无密码 | 同上 |
| Next | **没有** `/health` 或 `/healthz` 路由（`src/app/api/` 下只有 `durable` 与 `[...path]`） | 需要的话新增一个只读路由（**这是新代码，属待决策项**）；临时替代：探一个只读接口（如 `GET app/get/vo`）的非 5xx |

### 2.3 崩溃重启

- harness：`Restart=always`（或 compose `restart: unless-stopped`）。重启后 `harness.resume()` 接管被杀
  进程留下的任务；工具是否重跑由每个工具的 `replay` 声明决定（读/整文件写安全，就地改/删不安全，
  `harness-server.ts` 的 `productTools`）。M1 已实测 `kill -9` 后同库续跑 4/4。
- Next：无状态，随时重启；在途生成的观测循环（`observeHarnessRun`）会随进程消失，但任务行权威、
  harness 里的运行继续，页面重连后读任务态。**注意**：新 Next 进程不会重建那个观测循环，所以
  「最终验证 + 修复轮」这一步会丢——`buildApp` 是 Next 侧的职责，harness 只跑模型与 `buildPreview` 工具。
  这是当前拓扑的真实缺口，见 §5.2。
- `kill -9` 的残留：构建容器由 `docker run --rm --name paimeng-ts-build-<uuid>` 起，正常路径在 `finally`
  里 `docker rm -f`（`artifacts.ts:72-83`）。harness/Next 被 SIGKILL 时 `finally` 不执行，容器会残留运行
  （`--rm` 只在容器自己退出时生效）。**实测**：本次勘察时 `docker ps` 里就有一个 `paimeng-ts-build-…`
  在跑（另一个验证单元的构建，说明这类容器确实存在）。建议在 harness **`resume()` 之前**做一次清扫，
  只删创建时间早于本次启动的 `paimeng-ts-build-*`（避免删掉正在跑的；resume 之后可能有重放的构建）。
  这是新代码，属待决策项。

### 2.4 优雅停机

- harness 的 `shutdown()`（SIGINT/SIGTERM）：`server.close()` → `harness.close(context)` → 释放 advisory lock
  与连接。在途运行的收尾语义由 pi-durable 决定（中断的任务在下一次 `resume()` 按 replay 策略处理）。
- `durable-dev.ts` 的做法可以照搬到部署脚本：对子进程组 SIGTERM，最多等 5 s，再 SIGKILL（`stop()`）。
- 停机顺序与启动相反：先 Next/预览（停止接新请求），再 harness，最后 Postgres。**harness 必须比 Postgres 先停**，
  否则它会重连并留下半写状态（存储是单连接 + 串行队列，重连是安全的自愈路径，但没必要实测它）。

### 2.5 单写者约束下的多实例

- 谁能写：**恰好一个** harness，通过 `pg_try_advisory_lock(0x64757261626c65)` 在 open 时互斥（`storage-pg.ts:66,321-326`）。
  第二个进程拿到 `false` 就抛错退出——不要用「重试直到拿到锁」的启动脚本，那会让两个进程都以为自己是写者。
- 其余如何只 attach：`DURABLE_HARNESS_URL` 指向那一个进程。多个 Next 实例共享同一 URL 即可，无需粘性会话
  （SSE 与 `/agent-events` 都是无状态转发，客户端断连只中止自己的那一个 watch）。
- 唯一「写」的例外：Next 会写**产品**表（`app.conversation_id` 映射、`generation*`、限流、附件），
  这些由行锁 + 租约保护，与 pi-durable 存储的单写者不是一回事。

## 3. 数据

### 3.1 迁移执行

| 迁移 | 执行者 | 幂等与校验 |
| --- | --- | --- |
| 产品库 `migrations/*.sql` | `npm run db:migrate`（`scripts/migrate.ts`） | 逐文件事务；`schema_migration(name, checksum sha256, applied_at)`；已执行的文件**改动即报错**「已执行的迁移被修改」；库名白名单 `paimeng_ts(_test)` |
| 测试库建库 + 迁移 | `npm run db:test:setup`（`scripts/test-database.ts`） | 同上，目标 `paimeng_ts_test` |
| pi-durable durable 表 | harness `open()` 自己按 `durable_schema.version` 递增执行 | 版本表自管；`DURABLE_HARNESS_RESET=1` 是唯一会 DROP 的路径 |
| 模型配置初始化 | 一次 `npm run db:init-models` | 只在表空且版本为 0 时写 |

部署时把 `db:migrate` 放在 harness 的 `ExecStartPre`（或一个一次性 job），**不要**放在 Next 的启动里。

### 3.2 备份

```bash
cd paimeng-ai-code-agent
# 产品库（业务表）。两库形态下存储库要单独再备一次（见 §1.1「存储落点」）
docker exec zslm-pg-durable sh -c 'PGPASSWORD=spike pg_dump -U spike -d paimeng_ts' \
  > runtime/backup/postgres-paimeng_ts-$(date +%Y%m%d-%H%M%S).sql      # 实测产物 98 KB
# 存储库（pi-durable 会话 / 任务 / 条目）。同库形态下这一条不需要
docker exec zslm-pg-durable sh -c 'PGPASSWORD=spike pg_dump -U spike -d durable' \
  > runtime/backup/postgres-durable-$(date +%Y%m%d-%H%M%S).sql
# 旧 MySQL 归档（只在删容器前的一次性备份，见 §4）
docker exec zslm-mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysqldump -uroot \
  --single-transaction --routines --triggers --databases paimeng_ai_code_mother_ts' \
  > runtime/backup/mysql-paimeng_ai_code_mother_ts-<时间戳>.sql        # 实测产物 16.8 MB
```

注意 `runtime/` 是 gitignored（`.gitignore`），**备份文件不在版本控制里**，也不在 worktree 的提交范围。
清理 worktree 前把 `runtime/backup/*.sql` 移到仓库外的持久位置。

### 3.3 回滚

- 代码：分支 `backup/pre-m4-postgres`（指向 `878f3c2`）就是换库前的最后一个提交。
- 数据：产品库回 MySQL 只需改回 `DATABASE_URL` 并起旧容器——旧库在搬迁期间只被读过，内容仍是迁移前的
  （m4 §4 的结论）。Postgres 侧的快照只用于「误删后想看一眼」，回滚不需要它。
  **注意**：`app.conversation_id` 是业务表里的映射，指向的会话在存储库里（两库形态下在 `durable`）；
  只回滚业务库会让映射指向不存在的会话，靠 `durable-engine.ts` 的 404 自愈重建（会话历史随之丢失）。
- **生产环境不要照抄这条**：生产没有第二个可回退的库，回滚点只能是备份 + 迁移前的 schema 版本。
  本文件的回滚只覆盖「这台开发机」。

### 3.4 旧 MySQL 归档与清理方案

现状（2026-10-18 实测）：容器 `zslm-mysql` 在跑（healthy，`127.0.0.1:3306`）；数据目录在**主仓库**
`/home/zdan/github/zdan/paimeng-ai-code-mother/paimeng-ai-code-agent/runtime/mysql`（730 MB，
属主 `dnsmasq:root`——容器用户）；`compose.yaml` 仍有 `mysql` 服务；`.env.example` 与 `.env` 仍有
`MYSQL_LEGACY_URL`；`scripts/import-mysql-rows.ts` 与依赖 `mysql2` 只为这次一次性搬迁存在；
`runtime/backup/mysql-*.sql`（16.8 MB）是本 worktree 里的归档产物。

保留到何时：**直到真实端到端验收（§4 第 2 条）与全量 E2E 都在 Postgres 上跑过一遍**。在那之前旧库
是唯一能回退的路径。

清理顺序（每步都可单独停）：

1. `docker compose stop mysql`（不删数据），观察一周没有回退需求。
2. 保留 `runtime/backup/mysql-*.sql`（移出 worktree）后 `docker compose rm -f mysql`，删 `compose.yaml`
   的 `mysql` 服务与 `MYSQL_*` 变量、`.env.example`/`.env` 的 `MYSQL_LEGACY_URL`、
   `scripts/import-mysql-rows.ts` 与 `package.json` 的 `db:import-mysql`、`mysql2` 依赖。
3. 最后 `sudo rm -rf <main-repo>/paimeng-ai-code-agent/runtime/mysql`（普通账号删不掉，属主是容器用户）。

## 4. 收尾清单

逐条写「做什么 / 怎么验 / 谁决定」。

| # | 事项 | 做什么 | 怎么验 | 谁决定 |
| --- | --- | --- | --- | --- |
| 1 | **Postgres 变固定服务** | 把 `durable-pg.sh` 的一次性容器提升为 compose 服务（与 `redis` 同级）：命名卷替掉 `./runtime/durable-pg/pgdata` 绑定挂载、保留 `pg_isready` 健康检查、端口按部署决定，并按 §4 第 7 条选定的形态建库 | `docker compose up -d --wait postgres`；`npm run db:migrate`；`npm run dev:durable` 能复用同实例（`durable-dev.ts` 只在端口关闭时才 `start`） | 用户（端口/命名冲突：本机 5432 已被**别的**单元的 `zslm-postgres`（user=postgres, db=paimeng）占用，不能拿它当产品库） |
| 2 | **旧 MySQL 清理** | §3.4 的三步 | 每步后 `docker ps -a \| grep zslm-mysql`、`grep -rn "MYSQL_LEGACY_URL\|mysql2\|zslm-mysql" src scripts tests package.json compose.yaml .env.example` 无残留、`npx tsc --noEmit` 干净、受影响用例（`tests/integration/*` 里碰库的那批）过一次 | **用户**（删数据，不可逆） |
| 3 | **`spike/` 残留** | ① `sudo rm -rf spike/pi-durable-pg/pgdata`（属主 uid 999，普通账号删不掉，m3 §7.3 已记录失败）；② `docker rm -f zslm-pg-durable-spike`（已 Exited 3 小时）；③ `spike/pi-durable-pg/node_modules` 是软链，随目录一起删 | `ls -ld spike/pi-durable-pg/pgdata` 不存在；`docker ps -a` 无 spike 容器；`npm run verify:m3` 仍能跑（它只走产品 HTTP 接口） | 用户（`sudo` 与删目录） |
| 4 | **`noProgress` 结束路径验证** | 用种子破坏 + 桩模型：把 React 工程 `src/App.tsx` 种上类型错误（同 m3 §5.3）→ `DURABLE_FAUX_MODEL=1 npm run dev:durable` → 提交一次生成。桩模型不改文件，于是：第 1 轮构建失败 → 进修复轮（`snapshot` 从 null 变成第一轮的指纹）→ 修复轮模型仍不改文件 → 第 2 轮构建失败且指纹未变 → 走 `durable-engine.ts:513-521` 的 `noProgressMessage` 结束 | 生成行 `generation.status='failed'`、`stop_reason='verification-failed'`，错误文案是 `noProgressMessage` 的前缀；`generation_step` 里有 2 条 build 行（round 1、2）而不是 3 条；流里出现一次 `data-build repairing` 后不再出现 | 用户（是否要现在补这条证据） |
| 5 | **`BUILD_REPAIR_ROUNDS=0` 关闭路径验证** | 同一个种子破坏工程，`.env` 设 `BUILD_REPAIR_ROUNDS=0` 后**重启 harness 与 Next**（`.env` 只在启动时读，约束 #9），再提交一次生成（桩模型即可） | 第一次构建失败即结束：`stop_reason='verification-failed'`、`generation_step` 只有 1 条 build 行、流里**没有** `data-build repairing` | 用户 |
| 6 | **`data-seal` 名字核实** | **已核实，无对象**：全 worktree（含 `archive/`、`spike/`、`docs/`）与 `node_modules/@earendil-works/**` 搜 `data-seal` 只在 `docs/plans/pi-durable-m3.md:196-197` 的自述里出现，没有第二处命中。插话在界面上的位置由 `GET app/messages` 的顺序 + 前端本地插入决定 | 复核命令：`grep -rn "data-seal" .`（排除自身文档）无输出 | 结论已闭合；若用户指的是别的机制，需给出新线索 |
| 7 | **存储库落点拍板** | 在 §1.1「存储落点」的「同库 / 两库」之间选一个：同库则把 `.env.example` 的 `DURABLE_PG_URL` 显式等于 `DATABASE_URL` 并让 `durable-dev.ts` 默认值与 `storage-pg.ts` 一致；两库则把 `DURABLE_PG_URL` 写成独立条目、备份脚本备两个库、`DURABLE_HARNESS_RESET` 只对存储库生效 | 选定后 `.env`/`.env.example` 一致；`psql -d <存储库> -c '\dt'` 只看到该形态应有的表；`npm run db:migrate` 与 harness `open()` 都成功 | **用户**（影响备份与权限面，且现状与文档不符） |
| 8 | **合并 / 开 PR 到 main** | ① 在主仓库确认没有别人在写（`git worktree list` + 各 worktree `git status`）；② 该分支上跑一次全量 `npm test`（含 `tests/integration/durable-m1`）与 `npm run test:e2e:isolated`（**串行**，约束 #26/#27）；③ 跑一次真实端到端（`verify:m2b-build` 或 `verify:m3`）；④ 分支 rebase 到 `main`，解决重叠后推分支、开 PR；⑤ 合并后删除 `backup/pre-m4-postgres` 之外的临时 worktree | ②③ 的输出贴进 PR；`git log --oneline main..HEAD` 是本步全部提交；`git status` 干净 | 用户（**main 上的提交与 PR 需要用户确认**；本次任务只允许在分支上提交） |

## 5. 风险与取舍

### 5.1 常驻进程的运维成本

- 多一个必须活着的进程，且它**不是无状态**的：有 `runtime/durable` 状态目录、有 advisory lock、
  有重建中的任务。重启策略必须是 always，不能用一次性 job。
- 它是唯一写者，所以「滚动升级 harness」没有零停机路径：升级窗口内生成不可用（页面读历史也走它）。
  可接受的做法是升级时先停 Next 的写入（或短暂 503），再重启 harness。
- 观测面比单进程差：任务在 harness 里跑，Next 只看到转发流；排查要看 harness 的 stdout 与
  `runtime/durable/tools.jsonl`。

### 5.2 单写者的可用性影响

- 单点：harness 挂了，生成、读历史、发布都停（Next 返回 500）。当前没有任何自动双活方案，也不建议做
  （契约要求单写者）。
- 崩溃时的语义缺口（**现在的真实缺口**）：Next 侧的 `observeHarnessRun` 负责「模型轮次结束 → 最终验证 →
  修复轮」和租约心跳（每 5 s，`durable-engine.ts:428`）。Next 在生成中途重启，harness 里的那次运行会继续
  跑完，但**没有人做最终验证**：过期租约在下一次状态读取时被 `sweepStaleLeases` 回收（读取有 10 s 冷却，
  租约本身 30 s），任务行被写成 `failed` / `stopReason='interrupted'` / `生成进程中断，请重新提交`
  （`generation-store.ts:19-25,108-131`），而 harness 里的运行仍在消耗模型与容器资源。
  缓解选项（需决定）：把最终验证挪进 harness（工具/扩展里做），
  或在 Next 启动时对「租约已过期但 harness 里仍有活跃运行」的应用做一次收尾对账。
- 浏览器断连不再等于取消（设计目标），代价是**用户返回时可能看到一次他没在等的生成已经花掉了 token**。

### 5.3 Postgres 成为单点

- 一类是业务表（本来就在库里），一类是对话存储（换库前它没有这个问题）。Postgres 挂 = 全部不可用；
  pi-durable 的 `commit` 是串行单连接，加 pgbouncer 之类的连接池要在存储连接这一侧格外小心
  （存储自己已经是一条 pinned connection，多一层池不会提高它的吞吐）。
- 磁盘与备份是唯一有效的防线：`pg_dump`（§3.2）按天/按变更做，并且**备份要落到仓库外**。

### 5.4 「断连不再等于取消」之后，长任务会不会堆积

现状（代码口径，不是推断）：

| 机制 | 现状 | 依据 |
| --- | --- | --- |
| 单应用并发 | **有上限**：活跃租约存在时新提交返回 409「应用正在生成，请先取消或等待完成」（30 s 租约 + 5 s 心跳） | `generation-store.ts:29-30,65-66,75` |
| 全局并发 | **没有上限**：harness 与 Next 都没有并发配额/队列；同时生成的应用数 = 同时在跑的运行数 | `durable-engine.ts` 无信号量；`harness-server.ts` 无并发限制 |
| 会话内待处理输入 | 忙碌会话默认**排队**（`pi.inbox`），只有显式 `whenBusy:"reject"` 才拒绝 | 上游 `submissions.d.ts` 的 admit 语义；`:submit` 默认不传 `whenBusy` |
| 单次生成墙钟 | `GENERATION_TIMEOUT_MS` 默认 `0`（不限）；单次模型回复 `MODEL_REPLY_TIMEOUT_MS` 15 min；harness 的流超时 300 s | `.env.example`、`harness-server.ts:475` |
| 用户速率 | 默认每用户 60 s 1 次（跨应用共享） | `CHAT_RATE_LIMIT_*` |

所以会发生的堆积：

1. **跨应用**：多个用户/应用同时生成 → 跑多个 harness 运行，每个都可能 `docker run` 一个构建容器
   （`npm ci` 15–25 s + `vite build`）。瓶颈是宿主机 CPU/内存/docker，不是队列。本机已经因为并发重负载
   出过问题（项目规则 #26/#27），生产同理需要上限。
2. **同应用**：被 409 挡住，不会堆积，但**断连的生成仍占住租约 30 s**，用户重进页面时看到的是「正在生成」，
   要等它自己结束或去取消。
3. **租约与运行不一致**：Next 崩溃后租约 30 s 过期，过期租约在下一次状态读取时被回收为 `failed`/`interrupted`
   （`generation-store.ts:19-25,108-131`），但 harness 里的运行还在跑；此时同一应用可以被再次提交，
   新输入会在同一会话里排队，表现为「任务已显示失败，但提交后一直不动，直到上一个运行结束」。

建议决策（都属于新代码，本文不实现）：

- 加一个**全局并发上限**：最省事的是在 Next 侧提交前用一个 DB 协调的计数/信号量（或把
  `whenBusy` 改成 `"reject"` + 明确文案），上限值按宿主机资源定；
- 给生产设一个非零 `GENERATION_TIMEOUT_MS`，避免一次卡死的运行永久占用；
- 在任务页显示「排队中/等待上一个运行结束」，避免用户把排队误判为失败；
- 若要做 Next 崩溃后的对账，见 §5.2。

## 6. 本文件用到的复现命令

```bash
cd paimeng-ai-code-agent
npm run durable:pg -- status                       # 现状：zslm-pg-durable，127.0.0.1:55432
docker ps -a --format '{{.Names}}\t{{.Status}}'    # 现场：zslm-mysql / zslm-pg-durable-spike / paimeng-ts-build-*
npm run db:migrate && npm run verify:infra         # 迁移幂等 + 基础设施就绪
npm run durable:harness                            # 手工起 harness（需自己给 DURABLE_MODEL_*）
npm run dev:durable                                # 一条命令起 Postgres + harness + Next(3100)
```
