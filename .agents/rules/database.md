# 数据库

## 当前状态

**MySQL**：权威存储

- 业务数据
- 聊天历史
- generation run
- 积分台账

**PostgreSQL**：停用（RAG v2 启用 pgvector 时重新评估）

## 访问规则

- TS Agent 不直连 MySQL
- 业务数据通过 Java 回调
- 本地开发：`docker compose up -d`

## 结构变更

必须：

- 明确授权
- SQL/迁移记录

禁止：

- 自动导入 `infra/sql/create_table.sql`
- 重置密码
- 删库/清表
- 清空 Redis
- 修改本地敏感配置

先检查表和连接事实，再执行。

## 一致性

涉及扣费、退款、历史、run 状态：

- 保持 runId 幂等
- 保持事务边界
- 不用前端重复请求弥补一致性问题
