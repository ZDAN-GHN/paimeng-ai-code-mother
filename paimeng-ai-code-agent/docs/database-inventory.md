# 存储分工

现状说明，不维护表清单：表与列以 `migrations/*.sql` 和 `src/server/schema.ts` 为准，搬迁历史见 [pi-durable-m4](plans/archive/pi-durable-m4.md)，部署形态见 [pi-durable-deployment](pi-durable-deployment.md)。

## 四个存储

- **产品库 `paimeng_app`**（`zslm-postgres` 127.0.0.1:5432）：Next 写业务数据——账号、应用、登录态、附件元数据、生成状态与账目、版本台账、模型配置、发号下界、迁移台账。harness 只读模型域。
- **Redis `zslm-redis`**（开发 DB0 / 测试 DB15）：只放限流窗口的计数与窗口 id，TTL 到期即重置。不存任务、登录态或对话。
- **harness 存储库 `paimeng_agent`**（同一 Postgres 实例）：只有 harness 进程写（`src/server/durable/storage-pg.ts`，库级锁保证单写者）——会话、转录条目、任务、输入提交、文档与文档版本、schema 版本。
- **归档库 `paimeng_ai_code_mother_ts`**（旧 MySQL 容器 `zslm-mysql`，127.0.0.1:3306）：只作归档保留，运行期不连接。

## 三处容易误判的地方

- **对话不在产品库**：用户、助手和工具结果是 harness 的 `entries`（`app.user` / `pi.assistant` / `pi.tool-result`），`GET app/messages` 经 harness `/messages` 读回。产品库没有消息表，也不该再建一张。
- **`rate_limit` 表已删**：频率窗口在 Redis，PG 只负责权限、任务/租约与全局并发。PG 拒绝后只退还原 Redis 窗口；Redis 不可用时放行并记录结构化 warn。
- **同实例不等于同一份事实**：`paimeng_app` 是业务事实，`paimeng_agent` 是转录事实；别假设同一条数据在两个库里各有一份可以对照。

## 现状核对

```bash
docker exec -i zslm-postgres psql -U postgres -d paimeng_app   -c "select relname, n_live_tup from pg_stat_user_tables order by relname"
docker exec -i zslm-postgres psql -U postgres -d paimeng_agent -c "select relname, n_live_tup from pg_stat_user_tables order by relname"
```
