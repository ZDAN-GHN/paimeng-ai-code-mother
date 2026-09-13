# 数据库规则

MySQL 是当前交易数据的权威存储，包含业务数据、聊天历史、generation run 和积分台账；TS Agent 永不直连 MySQL，业务数据通过 Java 回调。PostgreSQL 当前停用，仅 RAG v2 启用 pgvector 时重新评估。

数据库结构变更必须有明确授权和对应 SQL/迁移记录。不要自动导入 `infra/sql/create_table.sql`、重置密码、删库、清空 Redis 或修改本地敏感配置。先检查表和连接事实，再执行经过授权的操作。

涉及扣费、退款、历史或 run 状态时，保持 runId 幂等和事务边界；不要用前端重复请求或内存状态弥补数据库一致性问题。
