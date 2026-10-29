# 本地进程、存储与运行恢复

现行启动方式是 `npm run dev`。它代管常驻 harness、独立预览服务和 Next，Ctrl-C 一起停止。旧迁移过程保存在 [archive](plans/archive/README.md)，模型连接行为见[模型配置](provider-convergence.md)。

## 进程与存储

| 组件 | 默认地址 | 职责 |
| --- | --- | --- |
| Next | localhost:3000 | 登录鉴权、模型管理、业务任务准入与 attach |
| harness | 127.0.0.1:5599 | pi-durable 会话、模型请求、工具执行与恢复 |
| 预览 | 127.0.0.1:3001 | 生成产物、部署副本与封面 |
| Postgres | 127.0.0.1:5432 | 同实例的两个业务/执行数据库 |
| Redis | 127.0.0.1:6379/0 | 生成频率限流，故障时可降级 |

`paimeng_app` 保存业务、任务、控制面（authority / 持久输入 / 执行绑定 / 源码快照 / 交付 / 预览指针）、逐步账目、模型配置与迁移台账；`generation_lease` 只保留给旧数据与旧接口，新生成不再使用。`paimeng_agent` 只保存 harness 的会话、转录、任务和文档。产品连接池保持雪花 int8 精度，harness 存储连接使用自己的 int8 解析器。

同一存储库只允许一个 harness 写进程，由 Postgres advisory lock 互斥。Next 可重启或断开 attach，不拥有 harness 的生成生命周期。旧 MySQL 容器与旧 Java/Vue 源码仅作归档保留。

## pi-durable 1.4.0

三个直接依赖固定为 `@earendil-works/pi-durable@1.4.0`、`@earendil-works/pi-ai@1.4.0`、`@earendil-works/chord@1.4.0`，锁文件里的 `pi-codemode` / `pi-telemetry` 也解析为 1.4.0；不采用浮动版本。

`storage-pg.ts` 的迁移序列新增 version 2，只扩充 `tasks.status` 的 CHECK 以接受 `sleeping`，不重建执行库、不改 version 1。打开时会明确拒绝比当前支持版本更新的库。**升级后不能用降 npm 版本继续打开同一执行库**；回滚必须恢复升级前的数据库备份和运行目录。

`sleeping` 任务不持有调用，重启后等 Harness 时钟到点再从 checkpoint 续跑；`/inspection` 与 `/state` 暴露 sleeping 的唤醒时间、`restarts` 和 blocked reason。由 `restartLimit` 停住的任务只在启动日志里报告，不自动 `retryTask`，需要人工检查后处理。模型运行描述（`app.run-model`）每次变更都写完整 base，重启不需要重放 delta。

产品 harness 显式使用 `afterFailedRun: "withdraw"`：一轮失败后，排队在后面的输入标记为 unanswered 并保留文本，不再自动进入下一轮。

## 生成控制面

每次生成先在产品库取得 `app_authority` 的 epoch，再在 `runtime/executions/<generationId>/<epoch>/` 建独立目录；每个 generation 使用独立 conversation，工具 cwd、读路径与 git `--work-tree` 都绑定这次执行。基线顺序固定为：当前封存草稿 → 当前版本源码 → 当前工作区（legacy）→ 新应用模板。

输入在提交时先落 `generation_input`（requestId 幂等、seq 单调），再交付 SDK；`placed` 只表示 SDK 已受理，条目进入转录后才变 `resolved`，完成水位只认连续前缀。发布要求所有输入已结算。

失败/取消时先关写门、等 harness run 退出，再把执行目录封存为草稿，下一轮复制该草稿；封存失败保持 draining 并拒绝新轮，不静默回退旧版本。成功发布先封存源码快照，再从快照构造 Git 提交、从构建产物创建不可变交付目录，最后在同一事务写 `version_record`、`generation_delivery`、`app_preview_pointer`、`generation` 终态与 authority 释放；文件指针随后补写，失败由恢复扫描对账。

预览按指针解析不可变交付；没有指针的旧应用才回退 `code_output`（legacy）。历史恢复优先切已有交付，legacy 版本才重新构建并独立物化；恢复全程占一条 running 部署记录作为维护锁，阻止 generation/其他业务写并跨 Git/构建/交付物化；下载优先读当前交付引用的源码快照（legacy 应用才回退工作区），部署从交付复制，封面按部署地址截图。部署记录按 `requestId` 幂等，失败不会改动应用当前的 `deployKey`/预览。自动回收只处理终态拒绝候选、孤儿临时目录和过期草稿。

旧预览和未发布草稿由 `npm run legacy:import` 导入为 legacy 交付/草稿，不创建版本或 generation，详见 `legacy-import.md`。

业务写路径与应用写权限共用一把事实：生成中的 authority/未收束 execution，以及运行中的 `app_deployment`，都会挡住部署、下载、删除、预览重建和版本切换；`withAppWriter` 在 app 行锁后再核对一次。手动部署用客户端 `requestId` 幂等：同一请求只执行一次，失败保留错误，新请求才能重试；每 app 同时最多一条 running，超过 15 分钟未收尾的记录记为中断，避免崩溃后永久占锁。

产品库迁移 006 新增控制面表与 generation 的 phase/deadline/watermark/parent 列，007 只扩 `generation_attempt.kind` 允许 `tool`；两者都是追加迁移，不改旧迁移。Next 与 harness 协议为 12；两边必须一起升级并重启，旧 harness 会绕过执行绑定和写门禁。

## 启动

```bash
npm ci
npm run durable:pg
npm run db:migrate
npm run db:init-models  # 仅首次从 AI_* 初始化，已有配置不覆盖
npm run dev
```

Postgres 与 Redis 已在本机运行时直接复用。`durable:pg` 只连库、补建四个 database 并打印状态，不管理容器的起停。迁移按顺序应用新 SQL，已执行迁移校验 checksum；不能修改 `001_initial.sql`。

也可分别启动 `npm run durable:harness`、`npm run preview`、`npm run dev:web`。三者应使用同一产品配置和运行目录。

## 模型与凭据

harness 默认每轮解析产品库 `codegen.default`。`DURABLE_MODEL_BASE_URL` / `_API_KEY` / `_ID` 只有完整显式设置时覆盖产品模型；不从其他工具的配置文件派生凭据。`route.classify` 的短类型分类仍在 Next 中执行。

Next 的管理端负责加密 inline 密钥，harness 按需解密。两进程必须使用相同 `MODEL_SECRET_KEY`，或同一 `runtime/model-secret.key`；换主密钥后旧密文不能解密。环境变量来源受 `MODEL_API_KEY_ENV_ALLOWLIST` 约束，不能通过别名读取任意进程环境。

每轮非敏感模型描述存入会话文档 `app.run-model`，只有原提供商身份、端点/格式、请求头、模型、设置、能力和凭据引用；无明文或密文。重启恢复不跟随当前别名改指。原凭据来源缺失时明确失败，不改投其他上游。

## attach 与模型准入

模型预检先于产品任务落库：harness `POST /model` 返回公开身份、能力及 token，Next 校验后提交。token 将预检结果与运行绑定，避免两次操作之间的配置更新影响已准入请求。忙碌会话不能切换到另一 token。

`GET /model?conversationId=` 从内存或持久描述返回原身份，包括模型循环已结束、产品仍在最终构建的会话。客户端断连只结束观察流；取消由显式业务操作与控制面的 authority/终态驱动。

harness 默认仅监听回环地址，Next 是创建者权限入口。不要把本地控制面当作公网 API。文件工具是原生 read/write/edit，保留工作区相对路径准入；不提供 bash，因为工具运行在宿主账号下。交给模型的工具就是这些：read / write / edit、listFiles、buildPreview、ask，加上管理端打开联网后的 webSearch / readWebPage / searchImages / importImage；`m1_wait` 只随 `DURABLE_FAUX_*` 脚本桩注册，真实生成里没有它。ask 只在绑定 execution 且本轮尚未修改源码时可用；提问后本轮结束、写门禁关闭，回答开启新 generation 并从草稿继续。

## 频率与全局并发

Redis Lua 在事务外原子预留固定窗口额度，键沿用 `user:<id>` / `ip:<ip>` / `api:app.chat.gen.code`。频率超额返回原有 429/42900，不创建 generation 或 lease。后续 PG 权限、重复或全局并发拒绝时，只退还相同窗口 token 的额度。

Postgres 仍负责应用单写权限及全局并发准入。每个 app 一行永久 `app_authority`，owner_epoch 单调递增，holder 带 30 秒到期与 5 秒心跳；释放只清 holder，不删 epoch。过期所有者不能推进状态，新持有者接管时旧 execution 被围栏。频率限流不承担任务状态或并发额度。

Redis 不可用时失败放行，并记录脱敏结构化 warn。建连、握手、命令响应和关闭均有有限期限；不保留离线命令队列。关闭入口与测试显式释放客户端，退出回调仅作兜底。

## 构建与恢复

工程依赖版本与模板锁文件在 source 阶段检查，随后依次执行隔离安装、模板类型检查与 Vite 构建。成功才替换 dist；失败诊断作为工具结果交回模型，旧预览保留。`BUILD_TIMEOUT_MS` 控制容器命令预算；`GENERATION_TIMEOUT_MS` 在生成开始时写成持久 deadline，观察者按数据库剩余时间计时，重挂、followUp 和 repair 不延长。模型 24 次（生成与压缩共享）、工具 400 次、自检构建 2 次、平台构建 3 次和 repair 2 轮都记在 `generation_attempt` 账本里，harness 重启后按会话文档恢复执行绑定继续计数；后台压缩关闭（`backgroundTokens: 0`），只保留阻塞压缩；checking/publishing 期间的新输入会作废旧发布候选、清理候选快照与交付，并把 draining 执行恢复为 editing。

harness 失联或重启后从持久任务恢复。Next 启动时先做一次恢复扫描：过期 authority 的 editing generation 收束为 failed/interrupted 并封存草稿；checking/publishing 只上报待对账，不擅自发布。读状态不再触发接管；观察者丢失时只对仍持有 authority 的活跃 generation 重新挂接，已提交版本则直接收敛为 ready。运行描述使接管记账保持原 providerId 与模型名。

## 测试与备份

测试使用 `paimeng_app_test`、`paimeng_agent_test` 与 Redis DB15。隔离 E2E 启动器自行起夹具 harness、Next 与预览，检查健康状态并统一清理进程；不复用开发 harness。会重置存储的测试必须保持串行，E2E、system 与容器构建也不能并发压机器。

备份用 `pg_dump` 保存两个数据库，连同运行目录与主密钥保管。不要删除旧 MySQL 容器或归档卷。一次性导入/旧 UI 对照脚本的适用条件见 [scripts/README.md](../scripts/README.md)。
