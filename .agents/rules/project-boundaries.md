# 项目边界

| 模块 | 负责 | 不负责 |
| --- | --- | --- |
| `paimeng-ai-code-backend/` | Java REST 业务、鉴权、积分、历史、构建部署 | Agent 编排、生成流中转、直接暴露数据库给 Node |
| `paimeng-ai-code-agent/` | Fastify、JWT 校验、生成工作流、工具、工作区、SSE | 直连 MySQL；业务账务通过 Java 回调 |
| `paimeng-ai-code-frontend/` | Vue 页面、路由、Pinia、API 调用和 SSE 展示 | 自行推断后端响应字段 |
| `paimeng-ai-code-rag/` | P4 检索服务 | 当前开发阶段的主生成链路 |

生产拓扑、端口、鉴权和工作区约束以 `docs/ts_agent/architecture.md` 为准。废弃的 `archive/paimeng-ai-code-microservice/` 不作为实现或迁移前提。

跨模块改动要先确认协议和调用方向，再分别在受影响模块验证；不要通过复制 DTO、绕过 Java 或新增隐式回退来“修复”接口不一致。
