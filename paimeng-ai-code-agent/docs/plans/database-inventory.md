# 数据库表职责清单（两个库 + 归档库）

状态：**现状说明**（2026-10-18，基线 `076f022`）。只描述「哪张表解决什么问题、谁在读写、删掉要在别处补什么」，
不是迁移计划。表名/列名的搬迁历史见 [pi-durable-m4.md](./pi-durable-m4.md)，部署形态见
[pi-durable-deployment.md](./pi-durable-deployment.md)。模型配置三张表的现状与收敛方向见
[provider-convergence.md](./provider-convergence.md)。

## 0. 一句话结论

1. 产品库 13 张表**没有一张是废表**：它们是「身份 / 生成状态机 / 逐轮账目 / 配置 / 基础设施」五件事各占若干行。
2. 真正该删的表在**归档 MySQL 库**里：`ts_message` / `chat_history` / `ts_app_summary` 已被 pi-durable 取代，整库只剩备份价值。
3. 容易误判成冗余的地方有四处（§3），每处都有产品侧的唯一职责，删掉要在别处重新造一个机制。

## 1. 三个存储的分工

| 存储 | 位置 | 表数 | 谁写 | 内容 |
| --- | --- | --- | --- | --- |
| 产品库 `paimeng_app` | `zslm-postgres` `127.0.0.1:5432`（本机自己的容器，不归本仓库管） | 13 | 只有 Next 进程（`src/server/db.ts` 的池 + `src/server/schema.ts` 的映射） | 账号、应用、登录态、附件元数据、生成状态与账目、模型配置、限流、发号下界、迁移台账 |
| harness 存储库 `paimeng_agent` | 同一 Postgres 实例 | 9 | 只有 harness 进程（`src/server/durable/storage-pg.ts`，单写者互斥是库级锁） | 会话、转录条目、任务、输入提交、文档与文档版本、记录号、元数据、schema 版本 |
| 归档库 `paimeng_ai_code_mother_ts` | `zslm-mysql` `127.0.0.1:3306`（旧 MySQL 容器，只作归档保留） | 16 | 无（运行期不连接；`scripts/import-mysql-rows.ts` 一次性读） | 搬迁前的旧业务行；`ts_message` / `chat_history` / `ts_app_summary` 已无去向 |

**对话不存在产品库里**：用户与助手气泡是 harness 的 `entries`（种类 `app.user` / `app.assistant`），
`GET app/messages` 经 harness `/messages` 读回（m4 §2）。这是最容易被误判成「消息表不见了/重复了」的地方。

复现命令（本机没有 `psql` 客户端，用容器里的）：

```bash
docker exec -i zslm-postgres psql -U postgres -d paimeng_app   -c "select relname, n_live_tup from pg_stat_user_tables order by relname"
docker exec -i zslm-postgres psql -U postgres -d paimeng_agent -c "select relname, n_live_tup from pg_stat_user_tables order by relname"
```

## 2. 产品库 13 张表

行数为 2026-10-18 开发库实测值，只作「这张表在不在用」的证据。

### 2.1 身份与业务

| 表 | 作用 | 谁读写 | 行数 | 删除代价 |
| --- | --- | --- | --- | --- |
| `app_user` | 账号、密码哈希、昵称头像、角色、软删除 | `auth.ts`（登录注册）、`business.ts`、管理端 | 122 | 不能删：一切归属与鉴权的根 |
| `app` | 应用：初始需求、`code_gen_type`、封面、部署键与部署时间、`priority`、**`conversation_id`（→ harness 会话的映射）** | `business.ts`、`artifacts.ts`、`project-shape.ts` | 123 | 不能删：`conversation_id` 是产品与 harness 唯一的连接点 |
| `user_session` | 登录态：token 哈希 + 过期时间 | `auth.ts:17`（每次请求联表校验）、`:30`（登录写入） | 162 | 不能删：改签名 Cookie/JWT 才能省，代价是取消会话要另造黑名单 |
| `attachment` | 图片附件**元数据**（字节在 `runtime/attachments/`）：原图 `object_key`、派生图 `preview_key`、`hash`、宽高、归属 | `attachment-store.ts`、`image-upload.ts`、`image-files.ts`、`GET app/asset` | 7 | 不能删：`GET app/asset` 只服务这张表登记过的路径与归属，否则就是任意文件读 |

`attachment` 的两个可讨论点：① `preview_key` 是「缩到 ≤ maxEdge 再送模型」的派生副本，用存储换 token；
② 元数据为什么不全塞文件名：归属（`owner_user_id`/`app_id`）、去重与校验（`hash`）、限额与前端展示（`bytes`/宽高）。

### 2.2 生成状态机与账目（红框里最像「多余」的三张）

| 表 | 作用 | 谁读写 | 行数 | 删除代价 |
| --- | --- | --- | --- | --- |
| `generation` | 产品侧任务行：`status`（generating/building/ready/failed/cancelled）、`stop_reason`（业务词表）、`error`、`message_id`（把用量块挂到具体助手气泡） | `generation-store.ts`、`durable-engine.ts` | 16（7 ready / 5 initialization-failed / 2 cancelled / 2 verification-failed） | 不建议删：应用状态、取消、崩溃接管、用量块挂载点全靠它 |
| `generation_lease` | `app_id` 主键 = 单应用单活跃生成；30s 租约 + 5s 心跳 | `generation-store.ts`（`beginGeneration`/`heartbeat`/`sweepStaleLeases`/`adoptLease`）、`durable-engine.ts`（接管）、`business.ts:84`（拒绝并发点击） | 0（空闲态） | 不建议删：并发上限（`generation-store.ts:98` 数活跃租约）、取消、超时、重启接管都要另找机制 |
| `generation_step` | D2 逐轮账目：`round`/`step_number`/`kind`(model/summary/build)、五类 token、三类耗时、`finish_reason`、`status`、`stage`、`repairable`、`tool_calls` | `generation-accounting.ts`（写入尽力而为，失败只告警）、`GET app/generation/accounts` | 53（42 model / 11 build） | 不建议删：回复气泡的用量块与 `eval:repair` 的修复成功率统计都读它 |

为什么这三张与 harness 的 `tasks`（71 条 `pi.generation`）不是重复：那张表在**另一个库、另一个进程**，
且不携带 `appId`/`userId` 业务身份；产品要在 harness 不在/重启中也能报状态，并要按应用查历史。

为什么逐轮账目不能靠 pi 的 `pi.usage`：它只有按 `provider/modelId` 的**累计桶**，compaction 的摘要调用也并进同一个桶，
给不出「第 N 轮这一轮多少 token」；`stage` / `repairable` 更是我们自己的构建分类逻辑（`build-feedback.ts`）。

### 2.3 模型配置（绿框三张）

| 表 | 作用 | 谁读写 | 行数 | 删除代价 |
| --- | --- | --- | --- | --- |
| `model_provider` | **连接与凭据**：`api_format`、`base_url`、`api_key_env` 或 `api_key_ciphertext`（AES）、`options`、`headers`、`enabled` | `models/store.ts`、`models/adapters.ts`、`models/probe.ts`、管理端 | 4（env-default / gdai / zen-gate / zen-go） | 不能合并，见下 |
| `model_alias` | **产品里的稳定角色名**：`codegen.default` / `route.classify`（代码写死，`shared/model-config.ts:4`）→ provider + `model_name`，携带 `capabilities`（图片输入、工具调用、结构化输出）与 `settings`（如 `reasoning: max`） | 同上 + `model.ts:42,57`、`speech.ts:147` | 2 | 不能合并，见下 |
| `model_config_state` | **并发控制元数据**（单行）：`revision` 做乐观并发（`expectedRevision`，冲突 409）、`refresh_epoch` 做跨进程热更新广播 | `models/store.ts`（`SELECT … FOR UPDATE`）、`models/registry.ts`（5s TTL 快照 / 60s 降级 / epoch 轮询） | 1（revision=33, epoch=29） | 不能合并：它不是配置内容，是「整份配置一个原子版本」的载体 |

`provider` 与 `alias` 是 **N:1 且生命周期不同**（换模型不该动密钥，加角色不该复制密钥）。合并的具体代价：
① 同一提供商下的多个模型要复制密钥密文与自定义头；② `capabilities`/`settings` 没有自然归属，只能塞 JSONB 一坨
或每角色复制一行 provider（后者就是把 alias 改名成 provider）。`config_state` 只有一行、被锁来串行化整集写入，
并进任何服务表都会丢掉「一次写完、一个版本」的语义。

### 2.4 基础设施

| 表 | 作用 | 谁读写 | 行数 | 删除代价 |
| --- | --- | --- | --- | --- |
| `rate_limit` | 生成限流窗口计数（`USER` / `IP` / `API` 三种键） | `rate-limit.ts` | 16 | 可搬到已经在跑的 Redis；收益是一张表，代价是限流变成两个存储的一致性问题 |
| `id_sequence` | 产品雪花 ID 的发号下界（`node_id` 主键 + `last_id`） | `snowflake.ts:29`（`SELECT … FOR UPDATE` 预留号段） | 1（`last_id=469396143160164352`） | 可换 Postgres 序列；代价是丢掉与旧库 MyBatis Flex 一致的位布局/起始时间，且要重新保证「已提交下界」跨进程共享 |
| `schema_migration` | 迁移台账 `name` + `checksum` + `applied_at` | `scripts/migrate.ts:9` | 1（`001_initial.sql`） | 不能删：没有它就无法判断库执行到哪一步、也无法禁止改已执行迁移的内容 |

`id_sequence` 与 harness 的 `mintId` 是**两个独立命名空间**：产品不读 harness 的号段，harness 只给会话/记录发号。

## 3. 四处「看起来重复」的真相

| 看似重复 | 实际关系 | 结论 |
| --- | --- | --- |
| `generation` + `generation_lease` vs harness `tasks` + 会话 busy | 前者是**产品语义**（应用状态、取消、超时、重启接管、全局并发上限），后者是**harness 自己的运行状态**；跨库跨进程，字段也不等价 | 各自保留；把产品状态外租给另一个进程的内部表是净损失 |
| `generation_step` vs `pi.usage` | 逐轮明细 vs 累计桶（且摘要调用混在一起） | 各自保留 |
| `id_sequence` vs `mintId` | 两个发号命名空间 | 各自保留 |
| `rate_limit` vs Redis（已在跑） | 功能重叠，DB 是当前实现 | 可选优化，非缺陷 |

## 4. 归档库：16 张旧表

| 旧表 | 现状 |
| --- | --- |
| `app_user` / `app` / `ts_session` / `ts_snowflake_state` / `ts_rate_limit` / `ts_attachment` / `ts_model_provider` / `ts_model_alias` / `ts_model_config_state` / `ts_generation` / `ts_generation_step` / `ts_generation_lease` / `ts_schema_migration` | 已搬迁到 Postgres 的对应表（映射见 m4 §1），旧行只作对照 |
| `ts_message` / `chat_history` | **放弃**：转录由 harness `entries` 承载 |
| `ts_app_summary` | **放弃**：滚动摘要由 pi-durable 的 compaction 取代 |

删库前先确认 `runtime/archive/mysql-paimeng_ai_code_mother_ts-20261018.sql.gz` 可用（m4 §7 第 6 条）。

## 5. 若把「减表」当需求

| 目标 | 可行做法 | 代价 |
| --- | --- | --- |
| 少一个库 | 删归档 MySQL（保留 dump） | 失去回看旧数据的能力 |
| 少一张表 | `rate_limit` → Redis | 限流跨两个存储，收益小 |
| 少一张表 | `id_sequence` → Postgres 序列 | 丢掉旧库位布局兼容与已提交下界语义 |
| 少一张表 | 删 `generation` / `generation_step` / `generation_lease` | 应用状态机、取消与接管、用量块、修复率统计全部要重建 |
| 少一张表 | 合 `model_*` 三张 | 见 §2.3，会丢掉 N:1 角色映射与「整份配置一个版本」 |

生成链路现在横跨两个库、两套 provider（见 [provider-convergence.md](./provider-convergence.md)），
这才是「同一件事两边各留一份记录」的真正来源；整理方向是收敛 provider，而不是删表。
