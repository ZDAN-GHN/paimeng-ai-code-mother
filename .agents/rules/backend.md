# Java 后端

Java `src/` 使用 Spring Boot，负责业务 REST、登录鉴权、积分/充值、聊天历史、构建和部署。遵循现有包结构、Controller/Service/Mapper 分层及项目既有异常和响应包装，不把 Agent 编排重新放回 Java。

Java 侧签发短时 JWT；Agent 侧离线验签。内部回调保留 Bearer 服务令牌和 runId 幂等语义。不要擅自修改 `ts-agent.enabled`、端口、SSE 事件名或回调字段。

构建要求 JDK 21。Java 改动至少执行与模块相关的 Maven 编译和测试；启动、数据库、端口和敏感配置操作遵循 `.agents/skills/project-startup-guardrail/SKILL.md`。
