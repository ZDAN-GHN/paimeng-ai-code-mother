# 项目边界

| 服务 | 职责 | 禁区 |
|---|---|---|
| **Java 后端**<br>`paimeng-ai-code-backend/` | REST API、登录鉴权、积分/充值、聊天历史、构建部署 | 不实现 Agent 编排、不中转生成流、不暴露数据库给 Node |
| **TS Agent**<br>`paimeng-ai-code-agent/` | Fastify、JWT 验签、生成工作流、工具调用、工作区、SSE 推送 | 不直连 MySQL；业务数据通过 Java 回调 |
| **Vue 前端**<br>`paimeng-ai-code-frontend/` | 页面、路由、Pinia 状态、API/SSE 调用 | 不手写后端类型 |
| **Python RAG**<br>`paimeng-ai-code-rag/` | P4 检索服务（未启用） | 不参与当前主生成链路 |

## 约束

- 拓扑、端口、鉴权见 `docs/ts_agent/architecture.md`
- `archive/paimeng-ai-code-microservice/` 已废弃，不作为参考
- 跨服务改动需在各模块独立验证
- 不通过复制 DTO、绕过 Java、隐式回退来"修复"接口不一致
