# Pi Durable 迁移 · M4：产品库从 MySQL 换到 Postgres，表名按业务域重建

状态：**代码与迁移已完成；受影响范围验收通过，全量单测已补跑两次全绿**（2026-10-18）。分支 `feat/pi-durable-migration`，
基线 `main@d0c9797`（本步之前的提交是 `878f3c2`，备份分支 `backup/pre-m4-postgres`）。
旧 MySQL 容器与库**保留作归档**，本步没有删除任何旧数据。

> **库名已在同日的收尾提交中改过（以本节为准）**：业务库 `paimeng_ts` → **`paimeng_app`**，存储库 `durable` →
> **`paimeng_agent`**，测试库 `paimeng_ts_test` → `paimeng_app_test`（另建 `paimeng_agent_test`）；
> Postgres 从一次性容器 `zslm-pg-durable` 升为固定服务 **`zslm-pg-paimeng`**（端口仍 `127.0.0.1:55432`）。
> **再改一次（2026-10-18，同日稍后）**：四个库已从 `zslm-pg-paimeng`（55432）整体搬到**本机自己的**容器
> `zslm-postgres`（`127.0.0.1:5432`），`zslm-pg-paimeng` 已删除，连接串统一为 5432；搬迁步骤、行数对照与配置改动
> 见 [pi-durable-deployment.md](./pi-durable-deployment.md) §3.5。下面的命令已相应更新。
> 本文其余部分写的是改名前的现场记录（当时叫 `paimeng_ts` / `durable` / `zslm-pg-durable`），命令与 checklist
> 已按新名更新；现状、并发上限、孤儿容器清扫与状态分裂修法见 [pi-durable-deployment.md](./pi-durable-deployment.md)。

## 0. 一句话结论

产品库现在是 Postgres（`DATABASE_URL=postgres://…/paimeng_ts`，收尾后为 `…/paimeng_app`），表名按业务域命名（去掉 `ts_` 前缀，
`user` → `app_user`），`mysql2` 与 `drizzle-orm/mysql2` 全部换成 `pg` 与 `drizzle-orm/node-postgres`。
对话转录不再有产品自己的表：用户与助手气泡作为 pi-durable 条目（`app.user` / `app.assistant`）存在
harness 存储里，`GET app/messages` 经 harness 的 `/messages` 读回。`ts_message`、`ts_chat_history`、
`ts_app_summary` 与围绕它们的自研代码一并删除；业务行（用户 / 应用 / 登录会话 / 附件 / 模型配置 /
限流 / 发号下界）用一次性脚本从旧 MySQL 搬进新库，**对话数据按既定决策放弃**。

## 1. 旧表 → 新表映射

| 旧（MySQL） | 新（Postgres） | 说明 |
| --- | --- | --- |
| `user` | `app_user` | Postgres 无引号不允许 `user` 作表名，加域前缀；`userAccount`→`user_account` 等 |
| `app` | `app` | 语义名保留；`conversationId`→`conversation_id`（harness 会话映射） |
| `ts_session` | `user_session` | 登录会话 |
| `ts_snowflake_state` | `id_sequence` | 应用雪花 ID 发号（与 pi-durable 自己的 `mintId` 是两个命名空间） |
| `ts_rate_limit` | `rate_limit` | 限流窗口 |
| `ts_attachment` | `attachment` | 图片附件 |
| `ts_model_provider` | `model_provider` | 模型提供商 |
| `ts_model_alias` | `model_alias` | 别名 |
| `ts_model_config_state` | `model_config_state` | 配置 revision / refreshEpoch |
| `ts_generation` | `generation` | 任务级审计行（状态 / stopReason / messageId） |
| `ts_generation_step` | `generation_step` | 逐步记账（D2）；`id` 仍是自增序列（唯一保留的 serial） |
| `ts_generation_lease` | `generation_lease` | 单应用单活跃生成（30 秒租约 + 5 秒心跳） |
| `ts_schema_migration` | `schema_migration` | 迁移记录表 |
| `ts_message` | **删除** | 转录改由 pi-durable `entries` 承载（`app.user` / `app.assistant`） |
| `chat_history` | **删除** | 旧 Java 历史，放弃 |
| `ts_app_summary` | **删除** | 滚动摘要由 pi-durable 的 compaction 取代 |

迁移文件也从 13 个 MySQL 增量脚本换成 **1 个 Postgres 初始脚本** `migrations/001_initial.sql`
（空库一次建好全部表与索引）。

> 现状补充（2026-10-18）：每张表解决什么问题、哪几张容易被误判成冗余、删表要在别处补什么机制，
> 见 [database-inventory.md](./database-inventory.md)；生成链路两套 provider 的现状与收敛方案见
> [provider-convergence.md](./provider-convergence.md)。列名统一 snake_case：Postgres 会把无引号标识符折叠成小写，
camelCase 列必须处处加双引号，一次改净比每个查询记得加引号更省心。

## 2. 转录搬到 harness：产品不再有消息表

- **写入**：生成入口提交用户输入时带 `entry: {kind:"app.user", data:<UIMessage>}`（pi-durable 的
  input 提交允许指定自己的条目种类与 `data`）；助手气泡在收尾时经 harness 新增的 `POST /entries`
  追加为 `app.assistant`（只带 `kind` + `data` 的写入是展示型条目，不改模型上下文，运行中也立即落地）。
- **读取**：`GET /api/app/messages?appId=` → `harnessChatResponse` 同模块的 `loadMessages` →
  harness `GET /messages?conversationId=`（按从旧到新扫 `app.*` 且带 `data` 的条目）。
  还没有会话映射（应用没聊过）时返回空数组。
- **删除**：`ts_message` / `chat_history` 的读写、`tool-transcript.ts`（把工具调用渲染成旧 Java
  约定的可读文本，只为 `chat_history` 存在）、`app/messages` 的 DB 查询、管理端「对话管理」页面
  （它读 `chat_history`；页面、路由、E2E 与对照脚本里的入口一起删）。管理员要查对话，进具体应用的对话页。
- **保留**：`generation.message_id` 指向写出的助手消息 id，前端按它把用量块挂在对应回复上。

## 3. 数据层改动（`mysql2` → `pg`）

| 位置 | 改动 |
| --- | --- |
| `src/server/db.ts` | `pg.Pool` + `drizzle-orm/node-postgres`；`int8` 全局解析器保持字符串（雪花 ID 超过 2^53），`timestamp` 由 drizzle 保持字符串（与原 `dateStrings` 口径一致）。原先的 `pg.types.setTypeParser(20, Number)` **从全局挪到 pi-durable 存储自己的连接**：产品池与 harness 存储同进程，全局改会让产品 ID 丢精度 |
| `src/server/schema.ts` | `mysql-core` → `pg-core`，按业务域重命名（§1），列名 snake_case |
| `src/server/config.ts` | `DATABASE_URL` 必须 `postgres:`，库名白名单改成 `paimeng_ts` / `paimeng_ts_test`（收尾后为 `paimeng_app` / `paimeng_app_test`） |
| `src/server/generation-store.ts` | 只留任务态：`beginGeneration`（限流 + 行锁 + 任务与租约）/ `setGeneration` / `restoreGeneration` / `heartbeat` / `sweepStaleLeases` / `generationFor` / `finishGeneration` / `withAppWriter`。消息读写整段删除 |
| 查询口径 | `onDuplicateKeyUpdate` → `onConflictDoUpdate`（模型配置），`affectedRows` → `rowCount`（租约/任务更新），重复键 `ER_DUP_ENTRY` → `23505`（注册、任务 UUID 冲突），限流的 `insert … on duplicate key update … if()` → `insert … on conflict do update set … case when` |
| 租约 | 语义未变：仍是 `SELECT … FOR UPDATE`（drizzle 的 `.for('update')` 在 pg 上生成 `FOR UPDATE`），应用行 → 租约行 → 任务行的加锁顺序照旧；`withAppWriter` 的 `lockTask` 开关（默认一致性读，避免长构建把心跳 UPDATE 卡死）原样保留 |
| `scripts/` | `migrate.ts`（pg，逐文件事务，`schema_migration` 记校验和）、`test-database.ts`（建测试库并迁移）、`admin.ts`、`verify-infra.ts`、`import-legacy.ts`（快照导入改写入 Postgres）、`durable-pg.ts`（连接 + 建四个 database + 健康检查；原名 `durable-pg.sh`，2026-10-18 后容器不归本仓库管） |
| 删除 | `scripts/verify-id-migration.ts`（对照旧 MySQL 的快照校验，换库后无对象）、`002..013` 的 MySQL 增量迁移、`package.json` 的 `verify:id-migration` |
| 依赖 | `mysql2` **只留给一次性搬迁脚本** `scripts/import-mysql-rows.ts`（产品运行期不再连接 MySQL）；运行期依赖是 `pg` |
| E2E | `tests/e2e/model-manage.spec.ts` / `platform.spec.ts` / `dev-warnings.spec.ts` 改 `pg.Client`，SQL 改 snake_case 与 `$1` 占位，公共夹具抽到 `tests/e2e/support/model-config-fixtures.ts` |

## 4. 迁移与回滚

```bash
# 0) 备份（在 worktree 内，runtime/ 已 gitignore）
#    MySQL 旧库：docker exec zslm-mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysqldump -uroot \
#      --single-transaction --routines --triggers --databases paimeng_ai_code_mother_ts' \
#      > runtime/backup/mysql-paimeng_ai_code_mother_ts-<时间戳>.sql
#    Postgres 新库（同名两库各自备）：
#      docker exec zslm-postgres pg_dump -U postgres -d paimeng_app \
#        > runtime/backup/postgres-paimeng_app-<时间戳>.sql
#      docker exec zslm-postgres pg_dump -U postgres -d paimeng_agent \
#        > runtime/backup/postgres-paimeng_agent-<时间戳>.sql
#    本步实际产物（改名前的名字）：runtime/backup/mysql-paimeng_ai_code_mother_ts-20261018-161344.sql（16.8 MB）
#                                 runtime/backup/postgres-paimeng_ts-20261018-161344.sql（98 KB）
#    MySQL 归档（收尾时补）：runtime/archive/mysql-paimeng_ai_code_mother_ts-20261018.sql.gz（4.3 MB）
#    备份分支：backup/pre-m4-postgres（指向 878f3c2）

npm run durable:pg                 # 确保本机 Postgres 容器（zslm-postgres，127.0.0.1:5432）里有
                                   # paimeng_app / paimeng_app_test / paimeng_agent / paimeng_agent_test 四个库
npm run db:migrate                 # 开发库建表（幂等，重复执行只核对校验和）
npm run db:test:setup              # 测试库建库 + 建表（幂等）
npm run db:import-mysql           # 一次性业务行搬迁（幂等，按主键 upsert；对话数据不搬）
# 迁移后把 app.conversation_id 留空，harness 下次生成时按应用重建会话（durable-engine 的 404 自愈仍保留）
```

**回滚**（未提交任何东西前的完整回退路径）：

1. `git switch backup/pre-m4-postgres`（或 `git reset --hard backup/pre-m4-postgres` 到旧状态）；
2. 数据库回到 MySQL：`.env` 的 `DATABASE_URL` 改回 `mysql://…`（旧库没被写过，仍是迁移前的内容）；
3. `npm run infra:up` 起旧 MySQL（本步一直在跑，无需重建）；本机 Postgres 容器不属于本仓库，不需要也不应该停它；
4. `runtime/backup/postgres-paimeng_ts-*.sql` 只是新库的快照，回滚不需要它；
   若新库被误删而想再看一眼迁移结果，用 `docker exec -i zslm-postgres psql -U postgres -d paimeng_app < 快照`。

**为什么不需要 `pg_dump` 旧库**：旧库是 MySQL，用 `mysqldump`（上面第一条）；`pg_dump` 只对新 Postgres
库有意义，两个都留了产物。

## 5. 验收证据（2026-10-18）

| 验收 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npx tsc --noEmit` | 干净（exit 0） |
| 迁移幂等 | `npm run db:migrate` ×2、`npm run db:test:setup` | 第一次 `已执行 001_initial.sql`，第二次只打印「完成」不做改动 |
| **业务行搬迁幂等** | `npm run db:import-mysql` ×2 | 两次输出一致：`app_user 120，app 112，user_session 152，attachment 6，model_provider 4，model_alias 2，model_config_state 1，rate_limit 14，id_sequence 1` |
| 搬迁结果抽查 | `docker exec zslm-pg-paimeng psql -U spike -d paimeng_app -c "select …"`（当时容器叫 `zslm-pg-durable`、库叫 `paimeng_ts`） | `app_user 120 / app 112 / model_alias 2 / attachment 6 / 有会话映射的 app 0 / id_sequence.last_id 469331532352323584`；`\dt` 13 张表（12 业务 + `schema_migration`），无 `ts_*` |
| 集成测试（**受影响范围**） | `npx vitest run tests/integration` | **25 文件 124 用例全过**（67.7s，含 `durable-m1` 10 文件 18 用例、`route-auth`、`http`、`backend-invariants`、`snowflake-ids`、模型注册与多进程用例） |
| 新增转录契约用例 | `npx vitest run tests/integration/durable-m1/messages.test.ts` | **2/2 过**：用户条目随 `/submit` 落地、`/entries` 追加 `app.assistant`、`/messages` 从旧到新读回、展示条目不进模型上下文、保留种类/非对象数据 400、未知会话 404 |
| 模型与记账单元测试 | `npx vitest run tests/models tests/generation-accounting.test.ts tests/model-task-binding.test.ts tests/snowflake.test.ts tests/image-attachments.test.ts tests/heartbeat.test.ts tests/model-config.test.ts tests/model-routing.test.ts` | **21 文件 144 用例全过**（两者与上一条有重叠文件，合起来覆盖所有碰库的用例） |
| 静态门禁 | `npm run check:ui` / `npm run check:e2e` | 23 个 tsx / 13 个 spec 通过 |
| **真实端到端（产品主流程）** | `npm run dev:durable` + `spike/pi-durable-m1` 的 `npm run verify:m2b-build` | **8/8 PASS**：真实模型 `deepseek-v4.1-flash`、新产品库 Postgres、真实容器构建 **13623ms**（`预览已更新（初版），用时 13623ms`）、浏览器 18 个不同长度的流式气泡、15 条工具条目、四个构建阶段全 `ok`（源码校验/安装依赖/类型检查/打包构建）、预览刷新 `pv=1`、**刷新后文本与工具条目读回成功**（走新的 `/messages` 路径） |
| **真实端到端（四项能力）** | 同上的 `npm run verify:m3` | **13/13 PASS**：插话 S1–S5（运行中受理、进模型上下文、位置在第一次回复之后、`app.user` 条目 + 刷新读回 3 条消息）、图片 I1–I3（`ready/completed`、模型上下文 `images:1`、工作区副本 `assets/uploads/20232269-m3-red.png`）、修复轮 R1–R3、联网 W1–W2 |
| **记账可查** | `GET /api/app/generation/accounts?appId=469340641873100800&limit=1`（产品接口，读新库 `generation` / `generation_step`） | 返回 `generationId=2800c810…`、`messageId=2800c810…-assistant`、`status=ready`、`stopReason=completed`、`model={alias:codegen.default,providerId:durable,modelName:deepseek-v4.1-flash}`、`totals.model={steps:13,inputTokens:9669,outputTokens:2744,cacheReadTokens:62592,reasoningTokens:276}`、逐步骤明细（13 行，含 `toolCalls`） |
| 浏览器层用量块 | m2b 脚本的 B1/B2 断言（页面 `.generation-usage`） | 通过：`messageId` 能挂到对应助手回复，刷新后仍在 |
| 旧数据完好 | `docker exec zslm-mysql …` | 旧 MySQL 容器与库未做任何写操作（只读 `SELECT` 用于搬迁），`mysqldump` 归档见 §4 |

两次真实端到端都在**换库之后**跑（时间 16:13–16:2x），用的是新产品库 Postgres 与新的转录路径；
`verify:m2b-build` 的「刷新读回」正是对 `ts_message` → harness `entries` 这次搬迁的验收。

**全量 `npm test` 已在换库与删除之后补跑**（2026-10-18 16:26 与 16:41，两次全绿，见 §5.1）。
Playwright E2E 套件（`npm run test:e2e:isolated`）仍未跑：它要独占测试库与端口、只能串行，留给集成后统一跑一次。
`.env.example` / README / 本文件的描述与代码一致，剩下的缺口就是 E2E 与 `scripts/verify-restart.ts`（见 §6.4）。

### 5.1 全量单测补跑（2026-10-18，换库与删除之后）

| 项 | 结果 |
| --- | --- |
| 前置 | `npm run durable:pg`（本机 Postgres 容器在跑、四个库就绪，`durable-m1` 组不会 skip）＋ `npm run db:test:setup` |
| 第一次 | `npm test` → **58 文件 / 432 用例全过**，480.29s（16:26:25 起） |
| 第二次（查 flaky） | `npm test` → **58 文件 / 432 用例全过**，613.78s（16:40:46 起） |
| 失败归因 | **零失败**：没有需要改代码的真回归，也没有「随 legacy 删除该改而未改」的残留——该改的测试已在 `4ab6777` 同一步处理（删 19 个 legacy 循环与自研上下文层的测试文件，改写 `http` / `feature-parity` / `backend-invariants` / `snowflake-ids` / `model-task-binding` / `test-database-url`） |
| flaky | 两次全绿，未观察到；样本只有两次，不构成「稳定」的结论 |
| 日志 | `/tmp/full-test-after-migration.log`、`/tmp/full-test-after-migration-run2.log` |
| 确认测试真的打在新库上 | 跑完后 `paimeng_ts_test` 的 `pg_stat_user_tables.n_tup_ins`：`model_alias 231 / app 229 / model_provider 123 / app_user 87 / rate_limit 72 / generation 63`（`n_live_tup` 近 0，用例自己清理）；开发库 `paimeng_ts` 两次运行期间没有任何新行（`app` 最新 `create_time` 仍是真实端到端那次 08:16 UTC） |

**基线口径的变化**：`pi-durable-m3.md` §7.5 记的「58 文件 / 444 用例」是 `4ab6777` 提交**前**的一次未提交工作区运行；
该提交随后又就地改了 6 个测试文件（净减 11 条用例）并新增 `messages.test.ts`（+2 条），按此推算当时应约 441 条，
与 444 差 3 条未追平（可能是某文件的循环生成用例数）。**本次实测的 58 文件 / 432 用例才是实现基线**；
`m3.md` 那行不改，它是当时的记录。

## 6. 剩余待办

1. **旧 MySQL 归档清理**（**收尾时已补归档，未删任何东西**）：容器 `zslm-mysql`、`runtime/mysql/` 数据目录、
   `compose.yaml` 的 `mysql` 服务与 `MYSQL_*` 变量都保留；归档产物 `runtime/archive/mysql-paimeng_ai_code_mother_ts-20261018.sql.gz`
   （4.3 MB，gzip 已校验，16 张表）。恢复方式见 [pi-durable-deployment.md](./pi-durable-deployment.md) §3.4。
   用户确认后：`docker compose stop mysql`（先不动数据），再决定是否删；`scripts/verify-infra.ts` 已经只查 Postgres 与 Redis。
2. **部署形态**（**收尾时已完成本机形态**）：Postgres 现在就在本机自己的容器 `zslm-postgres`
   （`127.0.0.1:5432`，不归本仓库管；2026-10-18 从当时的 `zslm-pg-paimeng`（55432）搬过去，见 deployment.md §3.5）；
   `kill -9` 后残留的 `paimeng-ts-build-*` 容器
   在 harness `resume()` 之前清扫；全局并发上限 `GENERATION_MAX_CONCURRENT`（默认 4）在提交入口执行；
   Next 重启后的状态分裂由启动/状态读取时的接管对账修复。细节、证据与**仍未做的生产编排**（systemd 单元、
   命名卷、非零 `GENERATION_TIMEOUT_MS`、Next 健康检查路由）见 [pi-durable-deployment.md](./pi-durable-deployment.md) §4/§7。
   注意「同实例两库」：`DURABLE_PG_URL`（存储库）与 `DATABASE_URL`（业务库）**不再回退到同一条串**。
3. **`spike/` 残留**：`spike/pi-durable-pg/pgdata/` 属主是容器用户，当前账号删不掉（需要 `sudo rm -rf`）；
   `spike/pi-durable-m1` 的手工验收脚本仍指向 3100 与 5599，未随本步改动（它们只走产品 HTTP 接口）。
4. **全量测试重跑**：`npm test` 已补跑两次全绿（**58 文件 / 432 用例**，见 §5.1，取代 `m3.md` 里的 444 口径）；
   `npm run test:e2e:isolated` 仍未跑（E2E 三个 spec 已按 Postgres 改好，但没在隔离生产构建里跑过）；
   `scripts/verify-restart.ts` 的快照流程（`prepare` / `verify`）也没在新库上跑过。
5. **冒烟脚本**：`scripts/verify-parity.mjs` 的对话管理入口与 `chatHistory` mock 已删，但它本身是手工对照脚本，
   未在本步运行。
6. **旧数据保留期**：`ts_message` / `chat_history` / `ts_app_summary` 的行仍在 MySQL 里（**没删**）。
   确认不再需要后，删容器前先保留 §4 的 `mysqldump` 产物（已有一份 gzip 归档在 `runtime/archive/`）。

7. **收尾（2026-10-18）已完成与未完成**：已完成库名改名（`paimeng_app` / `paimeng_agent`）、Postgres 上收到本机实例、
   孤儿构建容器清扫、全局并发上限、状态分裂接管、MySQL 归档，并补了 `noProgress` 与 `BUILD_REPAIR_ROUNDS=0`
   两条路径的真实证据（见 deployment.md §7）；未完成的是 `spike/` 残留清理（§6.3，需 `sudo`）、
   删旧的 `runtime/durable-pg/pgdata`（需用户点头）与生产编排，
   以及本步未跑的全量 `npm test` 与 `npm run test:e2e:isolated`。

## 7. 复现

```bash
cd paimeng-ai-code-agent
npm run durable:pg              # 确保本机 Postgres 容器里有四个 database（不启停容器）
npm run db:migrate && npm run db:test:setup
npm run db:import-mysql         # 需要旧 MySQL 在跑 + MYSQL_LEGACY_URL

npx tsc --noEmit
npx vitest run tests/integration     # 需要 Postgres；durable-m1 组没有 Postgres 时会打印原因并 skip

npm run dev:durable                  # harness + Next(3100)，要求本机 Postgres 已在跑
cd ../spike/pi-durable-m1 && npm run verify:m2b-build   # 真实模型 + 真实容器构建 + 浏览器
npm run verify:m3                                       # 四项能力（插话 / 图片 / 修复轮 / 联网）

npm run durable:pg -- status         # 看四个库是否就绪（容器不由本仓库管）
```
