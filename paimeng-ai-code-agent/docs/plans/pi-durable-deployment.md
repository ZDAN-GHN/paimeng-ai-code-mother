# 本地进程、存储与运行恢复

现行启动方式是 `npm run dev`。它代管常驻 harness、独立预览服务和 Next，Ctrl-C 一起停止。旧迁移过程保存在 [archive](./archive/README.md)，模型连接行为见[模型配置](./provider-convergence.md)。

## 进程与存储

| 组件 | 默认地址 | 职责 |
| --- | --- | --- |
| Next | localhost:3000 | 登录鉴权、模型管理、业务任务准入与 attach |
| harness | 127.0.0.1:5599 | pi-durable 会话、模型请求、工具执行与恢复 |
| 预览 | 127.0.0.1:3001 | 生成产物、部署副本与封面 |
| Postgres | 127.0.0.1:5432 | 同实例的两个业务/执行数据库 |
| Redis | 127.0.0.1:6379/0 | 生成频率限流，故障时可降级 |

`paimeng_app` 保存业务、任务/租约、逐步账目、模型配置与迁移台账；`paimeng_agent` 只保存 harness 的会话、转录、任务和文档。产品连接池保持雪花 int8 精度，harness 存储连接使用自己的 int8 解析器。

同一存储库只允许一个 harness 写进程，由 Postgres advisory lock 互斥。Next 可重启或断开 attach，不拥有 harness 的生成生命周期。旧 MySQL 容器与旧 Java/Vue 源码仅作归档保留。

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

`GET /model?conversationId=` 从内存或持久描述返回原身份，包括模型循环已结束、产品仍在最终构建的会话。客户端断连只结束观察流；取消由显式业务操作与租约状态驱动。

harness 默认仅监听回环地址，Next 是创建者权限入口。不要把本地控制面当作公网 API。文件工具是原生 read/write/edit，保留工作区相对路径准入；不提供 bash，因为工具运行在宿主账号下。

## 频率与全局并发

Redis Lua 在事务外原子预留固定窗口额度，键沿用 `user:<id>` / `ip:<ip>` / `api:app.chat.gen.code`。频率超额返回原有 429/42900，不创建 generation 或 lease。后续 PG 权限、重复或全局并发拒绝时，只退还相同窗口 token 的额度。

Postgres 仍负责应用单写租约及全局并发准入。租约 30 秒，心跳 5 秒；过期执行者不能继续提交应用写入。频率限流不承担任务状态或并发额度。

Redis 不可用时失败放行，并记录脱敏结构化 warn。建连、握手、命令响应和关闭均有有限期限；不保留离线命令队列。关闭入口与测试显式释放客户端，退出回调仅作兜底。

## 构建与恢复

工程依赖版本与模板锁文件在 source 阶段检查，随后依次执行隔离安装、模板类型检查与 Vite 构建。成功才替换 dist；失败诊断作为工具结果交回模型，旧预览保留。`BUILD_TIMEOUT_MS` 控制容器命令预算，`GENERATION_TIMEOUT_MS` 控制产品任务墙钟预算。

harness 失联或重启后从持久任务恢复；Next 读取状态时对账过期租约，仍有活跃运行则重新 attach，已无活跃运行则回收。运行描述使接管记账保持原 providerId 与模型名。

## 测试与备份

测试使用 `paimeng_app_test`、`paimeng_agent_test` 与 Redis DB15。隔离 E2E 启动器自行起夹具 harness、Next 与预览，检查健康状态并统一清理进程；不复用开发 harness。会重置存储的测试必须保持串行，E2E、system 与容器构建也不能并发压机器。

备份用 `pg_dump` 保存两个数据库，连同运行目录与主密钥保管。不要删除旧 MySQL 容器或归档卷。一次性导入/旧 UI 对照脚本的适用条件见 [scripts/README.md](../../scripts/README.md)。
