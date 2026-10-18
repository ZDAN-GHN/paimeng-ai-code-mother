# Pi Durable 部署形态与收尾设计

状态：**设计稿 + 同日的收尾记录**（2026-10-18）。分支 `feat/pi-durable-migration`，
基线 `0f10f70`（M4 之后，产品库已是 Postgres）。前面四步的记录见
[data-model](./pi-durable-data-model.md)、[m1](./pi-durable-m1.md)、[m2](./pi-durable-m2.md)、
[m3](./pi-durable-m3.md)、[m4](./pi-durable-m4.md)。

本机的收尾项（§4 第 1/3/4/5/6/7/9 条）已在同日实现并有真实证据（§7）；**生产编排与剩余待办**逐条写在 §8。

本文回答五件事：进程拓扑与配置、启动与健康、数据（迁移 / 备份 / 旧库归档）、收尾清单、
风险与取舍。**所有「现状」都指到代码或本机实测；所有「方案」都不是既成事实。**

## 0. 一句话结论

产品稳态是**两个业务进程、一个 Postgres 实例**：常驻 harness 进程独占 pi-durable 存储的写权（`pg_advisory_lock`
强制），Next 进程只做 attach 客户端与 SSE 转发。数据形态**统一为「同实例两库」**（用户已拍板）：
`paimeng_app` 放产品业务表，`paimeng_agent` 放 pi-durable 存储表；测试库是 `paimeng_app_test` 与 `paimeng_agent_test`。
`DURABLE_PG_URL` **不再回退到 `DATABASE_URL`**（否则会把存储表混进业务库，见 §1.5）。

本机形态已收尾：Postgres 升为固定服务 `zslm-pg-paimeng`（compose 的 `postgres`，127.0.0.1:55432），
harness 启动前清扫 `kill -9` 残留的 `paimeng-ts-build-*` 容器，提交入口有全局并发上限
（`GENERATION_MAX_CONCURRENT`，默认 4，超限 429 拒绝），Next 重启后的状态分裂由接管对账修复（§5.2）。
**要「上线」仍缺的是编排**（systemd 单元 / 命名卷 / 启动前置顺序、非零 `GENERATION_TIMEOUT_MS`、
可选的 Next 健康检查路由），逐条见 §8。

## 1. 进程拓扑

### 1.1 三个组件，各自的独占资源

| 组件 | 入口 | 独占的东西 | 依据 |
| --- | --- | --- | --- |
| harness（常驻） | `npm run durable:harness` → `src/server/durable/harness-server.ts` | pi-durable 存储的**唯一写者**（`pg_advisory_lock`）；`runtime/durable/workspace` 与 `runtime/durable/tools.jsonl`；harness 端自己起的构建容器 | `storage-pg.ts:312-334`（open + `pg_try_advisory_lock`，失败抛 `Postgres storage is already open by another process`）、`harness-server.ts:64-68`（runDir / port） |
| Next（可多份） | `npm run dev` / `next start`，`src/app/api/[...path]/route.ts` | 无独占：产品业务表走行锁与 `generation_lease`，对话存储只经 `DURABLE_HARNESS_URL` 访问 | `config.ts:39-40`（`DURABLE_HARNESS_URL` 默认 `http://127.0.0.1:5599`）、`durable-engine.ts:118-136` |
| Postgres 16 | 固定服务 `zslm-pg-paimeng`（compose 的 `postgres`，`npm run durable:pg -- start`） | 一个**实例**装两个 database：`paimeng_app` 放产品业务表（`migrations/001_initial.sql`，`app`、`app_user`、`generation*`、`model_*`…），`paimeng_agent` 放 pi-durable 存储表（`durable_*`、`conversations`、`entries`、`tasks`、`submissions`、`documents`、`document_revisions`、`record_ids`，由 storage 自己建）。测试库 `paimeng_app_test` / `paimeng_agent_test` 同实例 | `migrations/001_initial.sql`、`storage-pg.ts:177-189`、实测 `psql -d paimeng_app -c '\dt'` 13 张业务表 / `psql -d paimeng_agent -c '\dt'` 9 张存储表 |
| Redis | `compose.yaml` 的 `redis` 服务 | 无（当前只做基础设施就绪验证） | `scripts/verify-infra.ts` |

两条容易漏掉的**共享文件系统**约束：

1. harness 与 Next **都要读写同一个 `runtime/`**：Next 的最终验证（`durable-engine.ts:444` 调 `buildApp`）、
   附件的 workspace 副本、下载 ZIP、预览服务都基于它；harness 的 `buildPreview` 工具也调同一个 `buildApp`
   （`harness-server.ts:272`）。两边必须看到同一份 `runtime/code_output/<app>`，否则会出现「构建成功但预览空」。
2. harness 的 `DURABLE_HARNESS_RUN_DIR`（默认 `<cwd>/runtime/durable`）是它自己的状态目录，只有它能用；
   多份 harness 不允许（本来也被 advisory lock 挡住）。

**存储落点（已拍板：同实例两库；下表是勘察到的旧说法，保留作对比）**

三个数据源当时对「存储放哪个 database」的说法不同：

| 来源 | 说法 |
| --- | --- |
| `.env.example:79` 注释 | 「harness 与产品共用 `DATABASE_URL`；只有在把会话存储指到别的库时才需要 `DURABLE_PG_URL`」 |
| `scripts/durable-dev.ts:34`（实际 dev 行为） | `process.env.DURABLE_PG_URL ?? 'postgres://spike:spike@127.0.0.1:55432/durable'`，并且**总是**把它作为 `DURABLE_PG_URL` 注入 harness |
| `src/server/durable/storage-pg.ts:58`（storage 自身的回退链） | `DURABLE_PG_URL ?? DATABASE_URL ?? '…/paimeng_ts'` |
| `tests/integration/durable-m1/support.ts:18` | 默认 `…/paimeng_ts_test`（与产品测试表同库），允许 `DURABLE_PG_URL` 覆盖 |

实测（worktree 的 `.env` 只有 `DATABASE_URL=…/paimeng_ts`，没有 `DURABLE_PG_URL`）：`paimeng_ts` 有 13 张业务表
（无 `entries` 等）与 116 行 `app`；`durable` 有 9 张存储表与 9 行 `conversations`。也就是说 **dev 的真实形态是「同实例、两库」**，
而 M4 的一次性搬迁与 `db:migrate` 只作用在 `paimeng_ts`。

**已选定：同实例两库**（`paimeng_app` + `paimeng_agent`），按两库形态落地：

- `storage-pg.ts` 的 `defaultPgUrl()` 去掉了 `DATABASE_URL` 回退，只认 `DURABLE_PG_URL`（默认 `…/paimeng_agent`）；
  `.env` / `.env.example` 把 `DURABLE_PG_URL` 写成独立条目；
- 备份/迁移/建库都是两处：`npm run db:migrate` 只作用在业务库（迁移白名单 `paimeng_app(_test)`），
  存储库的表由 harness 的 `open()` 自建；
- 测试库同样两个：`paimeng_app_test`（业务）与 `paimeng_agent_test`（`tests/integration/durable-m1/support.ts`）。

被否决的另一条是「同库」（`DURABLE_PG_URL` 显式等于 `DATABASE_URL`）：备份只一条路径，但
`DURABLE_HARNESS_RESET=1` 与存储 schema 版本表会与业务表混在一起，权限也分不开。

### 1.2 形态 A：本机开发（现状，已实测）

```
Postgres（zslm-pg-paimeng，127.0.0.1:55432，paimeng_app + paimeng_agent，数据目录 runtime/durable-pg/pgdata）
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
| `postgres` | 数据库 | 固定容器/服务，**已经落地**为 compose 的 `postgres`（容器名 `zslm-pg-paimeng`，127.0.0.1:55432，健康检查 `pg_isready -U spike -d paimeng_agent`）；本机仍用宿主目录绑定挂载 `runtime/durable-pg/pgdata`，**生产要换命名卷**（理由见 §4 第 1 条）；四个 database：`paimeng_app`、`paimeng_app_test`、`paimeng_agent`、`paimeng_agent_test` |
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
  依据 Postgres 语义 + `storage-pg.ts` 的 `pg_try_advisory_lock`）。部署时必须断言所有 harness 的
  `DURABLE_PG_URL` 指向同一条连接串——两库形态下这条串是**存储库**（`paimeng_agent`），不是产品库。
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
| `DURABLE_PG_URL` | `…/paimeng_agent` | 存储连接串。**没有 `DATABASE_URL` 回退**（`storage-pg.ts` 的 `defaultPgUrl()` 只认它，否则会把存储表混进业务库）；`dev:durable` 也会把自己解析到的串注入子进程（`durable-dev.ts`）。部署时必须显式写死，并且所有 harness 指向同一条串（单写者互斥是库级锁） |
| `DURABLE_MODEL_BASE_URL` / `_API_KEY` / `_ID` | 无 | harness 直连模型（OpenAI 兼容）。`durable-dev.ts` 从 `~/.pi/agent/models.json` 派生，只在子进程注入 |
| `DURABLE_FAUX_MODEL` | 未设 | `=1` 用确定性桩模型 |
| 产品 env | — | harness 启动时 `webToolsForConfig()` → `getConfig()`（`harness-server.ts:338`），所以 **`DATABASE_URL`、`APP_ORIGIN`、`PREVIEW_ORIGIN`、`BUILD_*`、`WEB_ACCESS_*` 也必须在 harness 的环境里合法** |

**给定 Next 的**

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | 无（必填） | 必须 `postgres:`，库名白名单只允许 `paimeng_app` / `paimeng_app_test`（`config.ts`） |
| `DURABLE_HARNESS_URL` | `http://127.0.0.1:5599` | attach 地址；**启动时不校验可达性**，harness 不在时生成/读历史返回 500 `服务处理失败`（`http.ts` 的 `failure`） |
| `APP_ORIGIN` / `PREVIEW_ORIGIN` | — | 必须都是无凭据 HTTP(S) 且**不同主机名**（Cookie 隔离，`config.ts:46,48-49`） |
| `REDIS_URL` | — | |
| `MODEL_SECRET_KEY` 或 `runtime/model-secret.key` | 自动生成 0600 文件 | 解密 `model_provider.api_key_ciphertext`；多实例要共享同一个密钥 |
| `BUILD_IMAGE` / `BUILD_NPM_REGISTRY` / `BUILD_TIMEOUT_MS` / `BUILD_REPAIR_ROUNDS` | 见 `.env.example` | 构建与修复轮 |
| `CHAT_RATE_LIMIT_*` | USER 1/60s | |
| `WEB_ACCESS_*` | 默认关 | harness 侧注册联网工具，读的是**harness 进程**的 env |
| `GENERATION_TIMEOUT_MS` | `0`（不限） | 见 §5.4；**生产建议设非零** |
| `GENERATION_MAX_CONCURRENT` | `4` | 全局（跨应用）同时在跑的生成数上限，1-64；超限在提交入口直接 429 拒绝，不排队。见 §5.4 |
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
  里 `docker rm -f`（`artifacts.ts`）。harness/Next 被 SIGKILL 时 `finally` 不执行，容器会残留运行
  （`--rm` 只在容器自己退出时生效）。**已实现清扫**（`harness-server.ts` 的 `sweepOrphanBuildContainers()`）：
  在 `resume()` **之前**执行，`docker ps -a --filter name=paimeng-ts-build-` 列出后只删
  **创建时间早于本次进程启动**的容器（另一个进程正在跑的构建时间戳更新，不会被误删），结果写进启动日志。
  证据见 §7。

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
| 产品库 `migrations/*.sql` | `npm run db:migrate`（`scripts/migrate.ts`） | 逐文件事务；`schema_migration(name, checksum sha256, applied_at)`；已执行的文件**改动即报错**「已执行的迁移被修改」；库名白名单 `paimeng_app(_test)` |
| 测试库建库 + 迁移 | `npm run db:test:setup`（`scripts/test-database.ts`） | 同上，目标 `paimeng_app_test`；并确保存储测试库 `paimeng_agent_test` 存在（由 storage 自己建表） |
| pi-durable durable 表 | harness `open()` 自己按 `durable_schema.version` 递增执行 | 版本表自管；`DURABLE_HARNESS_RESET=1` 是唯一会 DROP 的路径 |
| 模型配置初始化 | 一次 `npm run db:init-models` | 只在表空且版本为 0 时写 |

部署时把 `db:migrate` 放在 harness 的 `ExecStartPre`（或一个一次性 job），**不要**放在 Next 的启动里。

### 3.2 备份

```bash
cd paimeng-ai-code-agent
# 业务库（产品表）。同实例两库，存储库必须单独再备一次（见 §1.1「存储落点」）
docker exec zslm-pg-paimeng sh -c 'PGPASSWORD=spike pg_dump -U spike -d paimeng_app' \
  > runtime/backup/postgres-paimeng_app-$(date +%Y%m%d-%H%M%S).sql
# 存储库（pi-durable 会话 / 任务 / 条目）
docker exec zslm-pg-paimeng sh -c 'PGPASSWORD=spike pg_dump -U spike -d paimeng_agent' \
  > runtime/backup/postgres-paimeng_agent-$(date +%Y%m%d-%H%M%S).sql
# 旧 MySQL 归档（收尾时已做，见 §3.4）
docker exec zslm-mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysqldump -uroot \
  --single-transaction --routines --triggers --databases paimeng_ai_code_mother_ts' \
  | gzip > runtime/archive/mysql-paimeng_ai_code_mother_ts-$(date +%Y%m%d).sql.gz   # 实测 4.3 MB
```

注意 `runtime/` 是 gitignored（`.gitignore`），**备份文件不在版本控制里**，也不在 worktree 的提交范围。
清理 worktree 前把 `runtime/backup/*.sql` 移到仓库外的持久位置。

### 3.3 回滚

- 代码：分支 `backup/pre-m4-postgres`（指向 `878f3c2`）就是换库前的最后一个提交。
- 数据：产品库回 MySQL 只需改回 `DATABASE_URL` 并起旧容器——旧库在搬迁期间只被读过，内容仍是迁移前的
  （m4 §4 的结论）。Postgres 侧的快照只用于「误删后想看一眼」，回滚不需要它。
  **注意**：`app.conversation_id` 是业务表里的映射，指向的会话在存储库里（两库形态下在 `paimeng_agent`）；
  只回滚业务库会让映射指向不存在的会话，靠 `durable-engine.ts` 的 404 自愈重建（会话历史随之丢失）。
- **生产环境不要照抄这条**：生产没有第二个可回退的库，回滚点只能是备份 + 迁移前的 schema 版本。
  本文件的回滚只覆盖「这台开发机」。

### 3.4 旧 MySQL 归档与清理方案

现状（2026-10-18 实测）：容器 `zslm-mysql` 在跑（healthy，`127.0.0.1:3306`）；数据目录在**主仓库**
`/home/zdan/github/zdan/paimeng-ai-code-mother/paimeng-ai-code-agent/runtime/mysql`（730 MB，
属主 `dnsmasq:root`——容器用户）；`compose.yaml` 仍有 `mysql` 服务；`.env.example` 与 `.env` 仍有
`MYSQL_LEGACY_URL`；`scripts/import-mysql-rows.ts` 与依赖 `mysql2` 只为这次一次性搬迁存在；
`runtime/backup/mysql-*.sql`（16.8 MB）是本 worktree 里的归档产物。

**归档已完成（2026-10-18 收尾）**：`runtime/archive/mysql-paimeng_ai_code_mother_ts-20261018.sql.gz`
（4.3 MB，`gzip -t` 通过，含 16 张表；容器与数据目录**未动**）。**恢复方式**：

```bash
# 看一眼旧数据（不恢复）：直接连还在跑的容器
docker exec -it zslm-mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot paimeng_ai_code_mother_ts'
# 真正恢复（会 DROP 同名库再重建）：zcat …sql.gz | docker exec -i zslm-mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot'
# 另一份未压缩的归档在 runtime/backup/mysql-paimeng_ai_code_mother_ts-20261018-161344.sql（16.8 MB，m4 那次）
```

两个路径都在 `runtime/`（gitignored），清理 worktree 前要移到仓库外的持久位置。

保留到何时：**直到真实端到端验收（§4 第 2 条）与全量 E2E 都在 Postgres 上跑过一遍**。在那之前旧库
是唯一能回退的路径。

清理顺序（每步都可单独停，**本步只做了第 0 步的归档，删数据那步等用户点头**）：

0. ✅ **已完成：导出归档**（`runtime/archive/mysql-paimeng_ai_code_mother_ts-20261018.sql.gz` + 上面的恢复命令）。
1. `docker compose stop mysql`（不删数据），观察一周没有回退需求。
2. 保留 `runtime/archive/mysql-*.sql.gz` 与 `runtime/backup/mysql-*.sql`（移出 worktree）后 `docker compose rm -f mysql`，删 `compose.yaml`
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

### 4.1 收尾结果（2026-10-18，本机；证据见 §7）

| # | 事项 | 结果 | 说明 |
| --- | --- | --- | --- |
| 1 | Postgres 变固定服务 | ✅ 完成 | `compose.yaml` 的 `postgres`（`zslm-pg-paimeng`，55432）+ `scripts/durable-pg.sh` 改走 compose；`npm run durable:pg -- start/stop/status/psql` 照旧 |
| 2 | 旧 MySQL 清理 | ⚠️ 只做了归档 | dump 到 `runtime/archive/mysql-…-20261018.sql.gz`（4.3 MB，gzip 校验通过）；**容器与 `runtime/mysql/` 未动**，删数据等用户点头（§3.4） |
| 3 | `spike/` 残留 | ⛔ 未做 | 需 `sudo`（pgdata 属主是容器用户）且属用户数据，见 §8 |
| 4 | `noProgress` 结束路径验证 | ✅ 完成 | 真实栈 + 桩模型 + 种入类型错误：`failed/verification-failed`，2 条 build 行（round 1/2），流里 1 次 `repairing`（§7.1） |
| 5 | `BUILD_REPAIR_ROUNDS=0` 关闭路径验证 | ✅ 完成 | 重启两个进程后同一场景：`failed/verification-failed`，1 条 build 行，**无** `repairing`（§7.2） |
| 6 | `data-seal` 名字核实 | ✅ 已闭合 | 全 worktree 搜 `data-seal` 只命中 m3 自述，无对象 |
| 7 | 存储库落点拍板 | ✅ 已拍板：同实例两库 | 库名同时改为 `paimeng_app` / `paimeng_agent`（§1.1） |
| 8 | 合并 / 开 PR 到 main | ⛔ 未做 | 需用户确认；全量 `npm test` / `test:e2e:isolated` 未跑，见 §8 |
| 9 | **新增**：全局并发上限 | ✅ 完成 | `GENERATION_MAX_CONCURRENT`（默认 4）在 `beginGeneration` 的事务里用 advisory lock 串行计数，超限 429（§5.4） |
| 10 | **新增**：孤儿构建容器清扫 | ✅ 完成 | harness 启动、`resume()` 之前清扫（§2.3） |
| 11 | **新增**：重启后状态分裂修复 | ✅ 完成 | `generationStatus` / 启动时接管对账，续租 + 重新 attach（§5.2，证据 §7.3） |

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
- 崩溃时的语义缺口（**已修复，2026-10-18**）：Next 侧的 `observeHarnessRun` 负责「模型轮次结束 → 最终验证 →
  修复轮」和租约心跳（每 5 s）。Next 在生成中途重启，harness 里的那次运行会继续跑完，但观察线程没了：
  过期租约会被 `sweepStaleLeases` 回收成 `failed` / `stopReason='interrupted'` / `生成进程中断，请重新提交`，
  而 harness 里的运行还在跑。（`generation-store.ts` 的 `recoverLease`。）
  **修法（接管对账）**：`durable-engine.ts` 的 `adoptOrphanedGenerations()` 找出「状态仍活跃、租约已过期
  （或已无租约）」的生成，如果 harness 里该会话仍有活跃运行，就用 `adoptLease()` 续上租约并重新 attach
  观察线程（心跳 + 最终验证 + 收尾）；没有活跃运行的不管，交给正常的 sweep 回收。触发点是**每次状态读取**
  （`app/generation` 走 `generationStatus()`，在 `generationFor` 之前先对账），所以页面轮询就能自愈；
  `adoptLease` 只对已过期租约生效，多个 Next 实例同时读到只有一个接管成功。
  （曾试过用 Next 的 `instrumentation.ts` 在启动时对账：它会被一并编译进 edge bundle，而模块图里的
  `archiver` 等只有 Node 实现，`next dev` 直接编译失败，所以没用。）
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
| 全局并发 | **有上限**（`GENERATION_MAX_CONCURRENT`，默认 4）：在 `beginGeneration` 的事务里取 `pg_advisory_xact_lock` 后数未过期租约，达到上限就 429。harness 自身仍不管并发，配额完全在提交入口 | `generation-store.ts` 的 `admitGeneration`；`tests/integration/backend-invariants.test.ts` 的并发上限用例 |
| 会话内待处理输入 | 忙碌会话默认**排队**（`pi.inbox`），只有显式 `whenBusy:"reject"` 才拒绝 | 上游 `submissions.d.ts` 的 admit 语义；`:submit` 默认不传 `whenBusy` |
| 单次生成墙钟 | `GENERATION_TIMEOUT_MS` 默认 `0`（不限）；单次模型回复 `MODEL_REPLY_TIMEOUT_MS` 15 min；harness 的流超时 300 s | `.env.example`、`harness-server.ts:475` |
| 用户速率 | 默认每用户 60 s 1 次（跨应用共享） | `CHAT_RATE_LIMIT_*` |

所以会发生的堆积：

1. **跨应用**：多个用户/应用同时生成 → 跑多个 harness 运行，每个都可能 `docker run` 一个构建容器
   （`npm ci` 15–25 s + `vite build`）。瓶颈是宿主机 CPU/内存/docker，不是队列。本机已经因为并发重负载
   出过问题（项目规则 #26/#27），生产同理需要上限。
2. **同应用**：被 409 挡住，不会堆积，但**断连的生成仍占住租约 30 s**，用户重进页面时看到的是「正在生成」，
   要等它自己结束或去取消。
3. **租约与运行不一致**：Next 崩溃后租约 30 s 过期，过期租约在下一次状态读取时会被回收为 `failed`/`interrupted`，
   但 harness 里的运行还在跑；此时同一应用可以被再次提交，新输入会在同一会话里排队，表现为
   「任务已显示失败，但提交后一直不动，直到上一个运行结束」。**已由接管对账消除**（§5.2）：
   只要 harness 里还在跑，状态读取会先把租约续上，不会写成 `failed`。

已做与未做：

- ✅ **全局并发上限**：`GENERATION_MAX_CONCURRENT`（默认 4）在提交入口执行；**选的是拒绝（429）而不是排队**——
  排队要额外的队列进程、用户可见的等待态与取消语义，而单应用已经有「应用正在生成」的 409 等待语义，
  两者混在一起反而难以解释。文案：`生成并发已达上限（N 个），请稍后重试`。
- ⛔ 给生产设一个非零 `GENERATION_TIMEOUT_MS`（本机仍为 0）：见 §8 剩余待办。
- ⛔ 在任务页显示「排队中/等待上一个运行结束」：拒绝式上限不需要排队文案，但 429 的错误提示目前直接是接口文案，
  没有专门的界面提示（见 §8）。
- ✅ Next 崩溃后的对账：见 §5.2 与 §7.3。

## 6. 本文件用到的复现命令

```bash
cd paimeng-ai-code-agent
npm run durable:pg -- status                       # 现状：zslm-pg-paimeng，127.0.0.1:55432
docker exec zslm-pg-paimeng psql -U spike -d postgres -tAc "select datname from pg_database order by 1"
docker ps -a --format '{{.Names}}\t{{.Status}}'    # 现场：zslm-mysql / zslm-pg-paimeng / paimeng-ts-build-*
npm run db:migrate && npm run verify:infra         # 迁移幂等 + 基础设施就绪
npm run durable:harness                            # 手工起 harness（需自己给 DURABLE_MODEL_*）
npm run dev:durable                                # 一条命令起 Postgres + harness + Next(3100)
```

## 7. 收尾证据（2026-10-18，本机、真实进程与真实容器）

三条都跑在改名后的库上（`paimeng_app` + `paimeng_agent`，Postgres 固定服务 `zslm-pg-paimeng`），
用 `DURABLE_FAUX_MODEL=1` 的确定性桩模型 + 真实容器构建。脚本是 `/tmp` 下的一次性验收脚本（未入仓）。

### 7.1 `noProgress` 结束路径（收尾清单第 4 条）

做法：建一个 `react_project` 应用（模板已初始化），把 `src/App.tsx` 种上类型错误，提交一次生成；
桩模型不碰文件，所以修复轮之后源码指纹不变。

| 项 | 实测值 |
| --- | --- |
| `app/generation` | `status=failed`、`stopReason=verification-failed` |
| `error` | `构建失败：src/App.tsx(64,7): error TS2322: Type 'string' is not assignable to type 'number'.；本轮模型未修改任何文件，已停止继续修复` |
| `generation_step` 的 build 行 | 2 条（`totals.build.attempts=2`，`totals.rounds=2`） |
| 流里的 `repairing` | 1 次（进修复轮一次后停止，不是 2 次） |

### 7.2 `BUILD_REPAIR_ROUNDS=0` 关闭路径（第 5 条）

在同一份 `.env` 里加 `BUILD_REPAIR_ROUNDS=0` 后**重启 harness 与 Next**（`.env` 只在启动时读），
同一个种子破坏场景重跑：

| 项 | 实测值 |
| --- | --- |
| `app/generation` | `status=failed`、`stopReason=verification-failed` |
| `error` | `构建失败：src/App.tsx(64,7): error TS2322: Type 'string' is not assignable to type 'number'.`（无「未修改文件」尾巴） |
| `generation_step` 的 build 行 | 1 条（`totals.build.attempts=1`、`totals.rounds=1`） |
| 流里的 `repairing` | **0 次** |

### 7.3 生成中重启 Next 后的接管（第 11 条 / §5.2）

做法：单独起 harness（桩模型单轮等 60 s）与 Next，提交一次 `html` 应用生成，8 s 后 `kill -9` Next，
等 35 s（> 30 s 租约），再起一个新 Next，然后轮询 `app/generation`。

| 时点 | 实测 |
| --- | --- |
| 重启前（任务行 + 租约） | `status=generating`，`generation_lease.expires_at=2026-10-18 09:27:02.738`，`now()=09:27:12.901`，`lease_expired=t` |
| harness 日志 | 09:26:35 `agent-events client gone — aborting the view only`（Option 1：断连不取消） |
| 重启后第一次轮询 | harness 日志 09:27:18 `agent-events attach conversation=398`（接管重新 attach） |
| 收尾 | 09:27:27 `entry appended … kind=app.assistant`；`app/generation` → `status=ready`、`stopReason=completed`、`messageId=…-assistant`；`generation_step` 有一条 `build`（round 1，`status=ok`） |

也就是说：租约已经过期（按旧代码会被 `sweepStaleLeases` 回收成 `failed/interrupted`），
但重启后的第一次状态读取把租约续上并重新 attach，任务跑完并写入正确的终态。

## 8. 剩余待办（逐条：做什么 / 从哪个文件开始）

1. **全量测试与 E2E**：`npm test`（需先 `npm run durable:pg -- start` 与 `npm run db:test:setup`）与
   `npm run test:e2e:isolated`。本步只跑了受影响范围（`tests/integration`、`tests/test-database-url.test.ts`）与两条静态门禁；
   从 `paimeng-ai-code-agent` 目录开始，串行跑（约束 #26/#27）。
2. **`spike/` 残留清理**（需 `sudo`，属用户数据）：`sudo rm -rf spike/pi-durable-pg/pgdata`、
   `docker rm -f zslm-pg-durable-spike`；`spike/pi-durable-m1` 的手工验收脚本仍写死 `3100`/`5599`，
   若要重跑先改 `spike/pi-durable-m1/src/product.ts` 的默认地址。
3. **旧 MySQL 删数据**（需用户点头）：按 §3.4 的第 1-3 步；归档已在 `runtime/archive/`。
4. **生产编排**（不涉及业务代码）：systemd/compose 单元与启动顺序（§1.3）、**命名卷替掉 host bind mount**（§4 第 1 条）、
   `ExecStartPre=npm run db:migrate`、非零 `GENERATION_TIMEOUT_MS`、可选 `app/health` 路由（§2.2），
   先从 `compose.yaml` 与 `scripts/durable-pg.sh` 开始。
5. **429 的界面提示**：`GENERATION_MAX_CONCURRENT` 超限时前端只拿到接口文案，没有专门的提示条；
   从 `src/components/chat/` 的错误展示开始。
6. **备份落到仓库外**：`runtime/` 是 gitignored，§3.2/§3.4 的两个归档（Postgres 与 MySQL）在清理 worktree 前
   要移到仓库外的持久位置。
7. **未入仓的验收脚本**：§7 用的两个一次性脚本在 `/tmp`（`evidence.mts`、`adopt-evidence.mts` + `adopt-run.sh`），
   没进仓库；要长期保留就照 `spike/pi-durable-m1/src/verify-*.ts` 的形式放进 `spike/pi-durable-m1/src/`。
