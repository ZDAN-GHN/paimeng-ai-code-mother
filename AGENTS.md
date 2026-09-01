# Agents Instructions

## Project Overview
派蒙 AI 应用工坊：基于 AI 的零代码应用生成平台。用户通过自然语言描述需求，AI 自动生成前端代码并可视化预览、部署。

**双后端架构（重构中）**：
- **Java Spring Boot**（`src/`，主后端）：对外提供业务 REST/SSE 接口、鉴权、业务状态、浏览器侧传输、构建与部署。
- **Python Agent**（`paimeng-ai-code-agent/`，FastAPI）：承载 AI 能力（模型调用、LangGraph 工作流、工具执行、Guardrail、代码解析、工作区落盘），向 Java 发出四类语义事件（`ai_response`/`ai_thinking`/`tool_request`/`tool_executed`）。
- **Java↔Python 内部契约**（通道、请求 JSON、事件 schema、回调、超时）以 `docs/py_agent/task_plan.md` §1 为准；字段名、事件名、顺序不得自行改动。

项目详细上下文: [CONTEXT.md](CONTEXT.md)
跨会话工作记忆: [MEMORY.md](MEMORY.md)

## Local Setup
1. 启动依赖服务：MySQL (localhost:3306) 和 Redis (localhost:6379)
2. 创建数据库：运行 `sql/create_table.sql`
3. 配置 `src/main/resources/application-local.yml`（参考 `application.yml`，需填入 API keys）
4. Python Agent：`cd paimeng-ai-code-agent && uv sync && cp .env.example .env`（需 PostgreSQL 用于 LangGraph checkpoint，配置见 `docs/py_agent/task_plan.md` §9）
5. 前端配置已包含在 `paimeng-ai-code-mother-frontend/.env.development`

## Package Manager
- **Maven Wrapper**：`./mvnw clean install`（Windows 使用 `mvnw.cmd`）
- **前端 (npm)**：在 `paimeng-ai-code-mother-frontend/` 目录使用 `npm install`
- **Python (uv)**：在 `paimeng-ai-code-agent/` 目录使用 `uv sync`（Python 3.13；依赖以 `pyproject.toml` + `uv.lock` 锁定，不使用全局 pip 环境）

## Commands
| Task | Command |
|------|---------|
| 运行 Java 后端 | `./mvnw spring-boot:run` |
| 运行全部 Java 测试 | `./mvnw test` |
| 运行单个 Java 测试 | `./mvnw test -Dtest=类名` |
| API 文档 | 启动后访问 `http://localhost:8123/api/doc.html` |
| 运行 Python Agent | `cd paimeng-ai-code-agent && uv run uvicorn app.main:app --port 8090` |
| 运行全部 Python 测试 | `cd paimeng-ai-code-agent && uv run pytest` |
| 运行 Python 契约测试 | `cd paimeng-ai-code-agent && uv run pytest -m contract` |
| 前端开发服务器 | `cd paimeng-ai-code-mother-frontend && npm run dev` |
| 前端构建 | `cd paimeng-ai-code-mother-frontend && npm run build` |
| 前端类型检查 | `cd paimeng-ai-code-mother-frontend && npm run type-check` |
| 前端代码检查 | `cd paimeng-ai-code-mother-frontend && npm run lint` |
| 生成 API 类型 | `cd paimeng-ai-code-mother-frontend && npm run openapi2ts`（需先启动后端） |

## External References
| Need | File |
|------|------|
| 项目概览 | `README.md` |
| 数据库表结构 | `sql/create_table.sql` |
| Agent 工作记忆（领域化多文档） | `.agents/memories/README.md` |
| Agent 记忆总入口（一句话现状） | `MEMORY.md` |
| Python Agent 设计 / Java↔Python 契约 / 验收 | `docs/py_agent/task_plan.md` |
| Python Agent 进度与决策记录 | `docs/py_agent/progress.md` |

## Key Conventions
- **Java 包结构**：`com.zdan.paimengaicodemother.*`，主要模块包括 `ai`（AI 相关）、`controller`（接口）、`service`（业务逻辑）、`mapper`（数据访问）
- **Java 后端代码风格**：遵循阿里巴巴 Java 开发手册
- **Vue3 前端代码风格**：Prettier 配置为无分号、单引号、100 字符宽度
- **前端路径**：主应用前端在 `paimeng-ai-code-mother-frontend/`
- **微服务重构**：新架构代码位于 `paimeng-ai-code-mother-microservice/` 目录，包含 7 个微服务模块（未完成重构，不作为 Python Agent 迁移前提）
- **MyBatis Flex 代码生成**：使用 `com.zdan.paimengaicodemother.generator` 包中的生成器，生成的 mapper 文件位于 `src/main/resources/mapper/`
- **AI 框架（Java 旧实现）**：LangChain4j 和 LangGraph4j 构建 AI 工作流，主要逻辑在 `ai` 和 `langgraph4j` 包中；这些能力将迁移到 Python Agent，迁移完成后删除（保留 `ai/tools` 展示格式与 `core/handler`）
- **Python Agent 技术栈**：Python 3.13 + FastAPI + LangGraph + LangChain + Pydantic 2；代码位于 `paimeng-ai-code-agent/app/`（顶层仅 `main.py` 入口，其余按子包 `api/`·`core/`·`models/`·`workspace/`·`tools/`·`services/`·`prompts/` 组织，结构见 `docs/py_agent/task_plan.md` §4）
- **Python 代码风格**：遵循 PEP 8，类型注解完整（Pydantic 2 模型），函数/类含 docstring；注释遵循项目注释风格
- **数据分工**：PostgreSQL 仅保存 LangGraph checkpoint（`thread_id = app:{appId}`）；MySQL 继续保存业务数据和 `chat_history`
- **Java↔Python 鉴权**：内部接口统一使用 `Authorization: Bearer {python-agent.token}`（Java 从 `python-agent.token` 配置读取，Python 从 `PYTHON_AGENT_TOKEN` 环境变量读取）
- **共享工作区**：`tmp/code_output/{codeGenType}_{appId}`；Java 计算绝对路径传入，Python 做沙箱校验（见 `docs/py_agent/task_plan.md` §1.2）
- **灰度开关**：`python-agent.enabled` 切换两套链路；`false` 走旧 Java AI 实现（行为不变），`true` 走 Python Agent
- **配置文件**：`application-local.yml` 包含敏感信息，已 gitignore，不要提交到版本控制；Python 侧 `.env` 同样不提交（用 `cp .env.example .env`）
- **Git 提交**：如果是 Agent 代理提交,需要携带 `<Agent IDE>/<用户信息>` 信息
