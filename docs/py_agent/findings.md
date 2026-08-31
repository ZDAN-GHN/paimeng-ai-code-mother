# 迁移发现

- 当前生产主线是根目录 `src` 单体 Spring Boot；`paimeng-ai-code-mother-microservice` 属于未完成重构，不作为本次前提。
- 对外 AI 接口是 `GET /app/chat/gen/code`，前端使用带 Cookie 的 EventSource。
- Java 当前 AI 代码位于 `ai/` 和 `langgraph4j/`；代码生成类型包括 HTML、MULTI_FILE、VUE_PROJECT。
- Vue 流由 `AiCodeGeneratorFacade` 产生四类结构化消息；`JsonMessageStreamHandler` 负责工具去重、展示文本重组和聊天记录聚合。
- HTML/MULTI_FILE 当前为文本流，完成后解析并写入代码目录。
- `StreamHandlerExecutor` 完成后触发 Java 构建；部署、下载和截图属于传统业务能力。
- 当前上下文记忆使用 Redis `MessageWindowChatMemory`，迁移后改为 Python LangGraph PostgreSQL checkpoint；MySQL `chat_history` 保留为产品事实来源。
- 当前工作区协议由 `AppConstant.CODE_OUTPUT_ROOT_DIR` 定义，Python 与 Java 需要共享同一目录或容器卷。
- 官方资料确认 LangGraph 1.x 定位为有状态 Agent 编排、持久化和流式；LangChain 1.x Agent 架构建立在 LangGraph 之上；FastAPI 提供 OpenAPI 和流式 API 能力。
