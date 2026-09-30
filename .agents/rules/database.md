# 数据库

## 当前状态

**MySQL**：权威存储

- 业务数据
- 聊天历史
- 平台需求、任务与运行记录

**PostgreSQL**：停用（RAG v2 启用 pgvector 时重新评估）

## 访问规则

- TS Agent 不直连 MySQL
- 业务数据通过 Java 回调
- 本地开发：`docker compose up -d`

## 结构变更

必须：

- 明确授权
- SQL/迁移记录
- 新表和新增字段使用小驼峰命名；既有存量字段保持原名，不为形式统一重命名
- 新表显式声明 `DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`，不依赖服务端默认值

禁止：

- 自动导入 `infra/sql/create_table.sql`
- 重置密码
- 删库/清表
- 清空 Redis
- 修改本地敏感配置

先检查表和连接事实，再执行。

## 约束设计

目标是把真实不变量交给数据库，不是让表看起来约束多。按此顺序取舍：

```
NOT NULL / PRIMARY KEY > UNIQUE > CHECK > 必要的 FOREIGN KEY
    > 事务边界 > 应用层显式逻辑 > Trigger
```

- 不因字段名像 `xxx_id` 就建物理外键；先判断该不变量是否真需要数据库强制
- 历史快照、审计记录、外部资源标识、跨服务与异步关系默认不建外键
- 状态值域、数值范围、哈希格式优先用 `CHECK`，不要堆进触发器
- 触发器只用于 `CHECK`/`UNIQUE`/外键都表达不了的场景（需要比较新旧值、append-only）
- 不用触发器代写业务数据：自动插入、同步字段、模拟级联删除都应改回显式 Service 逻辑
- 删除外键或触发器后，必须在应用层补上等价校验，不留一致性缺口
- 每个外键、触发器、唯一键、检查约束、索引都要能说清保护的是哪个真实不变量

## 事务边界

实测：`@Transactional` 方法内经 MyBatis Mapper 的写入随回滚消失，经 `JdbcTemplate` 的写入不会。

- 同一业务操作内的写入必须走同一数据访问路径，不混用 Mapper 与 `JdbcTemplate`
- 需要与调用方共进退的写入用 `@Transactional(propagation = MANDATORY)`，并显式校验事务已激活
- 子表插入对父行加锁：队列、事件这类「父行正是本次操作刚写入」的表不要加父表外键

## 字符集与排序规则

- 全库统一 `utf8mb4_unicode_ci`；MySQL 8 服务端默认是 `utf8mb4_0900_ai_ci`，混用会触发 `Illegal mix of collations`
- 哈希/指纹列用 `CHECK` 固定为小写十六进制；大小写不敏感的唯一去重键不要改成 `utf8mb4_bin`
- 依赖大小写不敏感比较的地方，写法要与列的排序规则一致

## 删除策略

- 每个父子关系显式选择 RESTRICT / CASCADE / SET NULL / 应用层处理，并写明理由
- 不因为已有外键就默认 `ON DELETE CASCADE`
- 审计、留痕、追溯类数据不得物理级联删除
- 逻辑删除的表不建 `BEFORE DELETE` 触发器，物理删除本就不可达
- `app` / `user` / `chat_history` 的 `isDelete` 是 MyBatis-Flex 逻辑删除列，`deleteById` 会被改写成 `UPDATE`

## 迁移

- 每个迁移必须可执行、可回滚；破坏性变更单独出一个迁移
- Flyway 没有 down 迁移，需要回退时提供 `infra/sql/mysql/rollback_V*.sql`，并在一次性库上实测
- MySQL DDL 隐式提交，迁移不是原子的；中途失败会留下部分结构与失败记录
- 上线前先用带真实存量数据的副本跑一遍，并逐条验证新约束确实生效

## 一致性

涉及历史、run 状态：

- 保持 runId 幂等
- 保持事务边界
- 不用前端重复请求弥补一致性问题
