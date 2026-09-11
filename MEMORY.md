# 项目记忆（MEMORY）

> 跨会话工作记忆总入口。详细且可更新的领域记忆在 [.agents/memories/README.md](.agents/memories/README.md)；设计、契约和实施证据以 `docs/` 中的权威文档为准。

## 当前状态

TS Agent（`paimeng-ai-code-agent/`）是唯一代码生成主链路，P3 已收官；Java 负责业务、鉴权、积分、历史、构建与部署；Python RAG（`paimeng-ai-code-rag/`）尚待 P4 实施。旧 Java AI 与 Python Agent 中转链已退役，`ts-agent.enabled` 默认开启且只门禁 JWT 签发，回退方式为 Git 回滚。

## 领域记忆

| 领域 | 文档 |
| --- | --- |
| 架构决策与退役状态 | [.agents/memories/architecture.md](.agents/memories/architecture.md) |
| Java 后端 | [.agents/memories/java-backend.md](.agents/memories/java-backend.md) |
| TS Agent | [.agents/memories/ts-agent.md](.agents/memories/ts-agent.md) |
| Python RAG | [.agents/memories/python-rag.md](.agents/memories/python-rag.md) |
| Vue 前端 | [.agents/memories/vue-frontend.md](.agents/memories/vue-frontend.md) |
| 运行与部署 | [.agents/memories/deployment.md](.agents/memories/deployment.md) |

## 当前工作入口

- Agent Loop 改造： [docs/ts_agent/agent-loop-design.md](docs/ts_agent/agent-loop-design.md)
- 多类型代码生成迁移： [docs/ts_agent/codegen-multi-type-design.md](docs/ts_agent/codegen-multi-type-design.md)
- TS Agent 实施进度与验证证据： [docs/ts_agent/progress.md](docs/ts_agent/progress.md)
