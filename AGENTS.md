# Agents Instructions

## Project Overview
派蒙 AI 应用工坊：基于 AI 的零代码应用生成平台。用户通过自然语言描述需求，AI 自动生成前端代码并可视化预览、部署。

**三服务架构（2026-09-03 定稿，实施已启动：P0 完成，P1 待启动）**，权威设计见 `docs/ts_agent/architecture.md`：
- **Java Spring Boot**（`src/`，业务后端）：业务 REST、鉴权（签发短时 JWT）、充值/积分/会员、聊天历史、构建与部署（`BuilderExecutor`）。
- **TS Agent**（新建，Node + Fastify + Vercel AI SDK + XState v5）：需求访谈、线框、planner→coder→reviewer 工作流、工具执行、Guardrail、SSE 直连浏览器（JWT 鉴权），通过内部回调让 Java 结算/写历史/触发构建。
- **Python RAG**（新建 `paimeng-ai-code-rag/`，FastAPI）：检索服务，day-1 只读直查 MySQL 做 few-shot，v2 上 pgvector。

**过渡态**：Python Agent（`paimeng-ai-code-agent/`）已定稿**全面退役**（用户决策 2026-09-03）：回切旧 Java AI 链路兜底（`python-agent.enabled=false`，**P0 已执行 2026-09-03**，本地配置已回切并 e2e 验证）、T21 门禁重定向为"TS Agent 契约对等 + 回归全绿"、PG 即刻停用、目录待 RAG 骨架复用后删除。`docs/py_agent/` 全目录转为历史参考（提示词/契约/验证记录是 TS 移植参考源）。

项目详细上下文: [CONTEXT.md](CONTEXT.md)
跨会话工作记忆: [MEMORY.md](MEMORY.md)

## Local Setup
1. 启动依赖服务：MySQL (localhost:3306) 和 Redis (localhost:6379)
2. 创建数据库：运行 `sql/create_table.sql`
3. 配置 `src/main/resources/application-local.yml`（参考 `application.yml`，需填入 API keys）
4. ~~Python Agent~~（**退役中**，历史参考）：`cd paimeng-ai-code-agent && UV_PROJECT_ENVIRONMENT=.venv-wsl uv sync && cp .env.example .env`；PostgreSQL 不再需要（已决策停用，RAG v2 时重启）
5. 前端配置已包含在 `paimeng-ai-code-mother-frontend/.env.development`
6. TS Agent 与 Python RAG 服务尚未创建（见 `docs/ts_agent/architecture.md` §11 P1/P4）

## Package Manager
- **Maven Wrapper**：`./mvnw clean install`（Windows 使用 `mvnw.cmd`）
- **前端 (npm)**：在 `paimeng-ai-code-mother-frontend/` 目录使用 `npm install`
- **TS Agent (npm，待创建)**：目标技术栈 Node + Fastify + Vercel AI SDK + XState v5
- **Python RAG (uv，待创建)**：`paimeng-ai-code-rag/`；沿用 uv 锁定依赖约定
- **Python Agent (uv，退役中)**：在 `paimeng-ai-code-agent/` 目录使用 `UV_PROJECT_ENVIRONMENT=.venv-wsl uv sync`；目录删除前仅供迁移参考

## Commands
| Task | Command |
|------|---------|
| 运行 Java 后端 | `./mvnw spring-boot:run` |
| 运行全部 Java 测试 | `./mvnw test` |
| 运行单个 Java 测试 | `./mvnw test -Dtest=类名` |
| API 文档 | 启动后访问 `http://localhost:8123/api/doc.html` |
| 运行 Python Agent（退役参考） | `cd paimeng-ai-code-agent && UV_PROJECT_ENVIRONMENT=.venv-wsl uv run uvicorn app.main:app --port 8090` |
| 运行全部 Python 测试（退役参考） | `cd paimeng-ai-code-agent && UV_PROJECT_ENVIRONMENT=.venv-wsl uv run pytest` |
| 前端开发服务器 | `cd paimeng-ai-code-mother-frontend && npm run dev` |
| 前端构建 | `cd paimeng-ai-code-mother-frontend && npm run build` |
| 前端类型检查 | `cd paimeng-ai-code-mother-frontend && npm run type-check` |
| 前端代码检查 | `cd paimeng-ai-code-mother-frontend && npm run lint` |
| 生成 API 类型 | `cd paimeng-ai-code-mother-frontend && npm run openapi2ts`（需先启动后端） |

## External References
| Need | File |
|------|------|
| 项目概览 | `README.md` |
| **目标架构权威设计（三服务/协议/计费/RAG/退役方案/实施顺序）** | `docs/ts_agent/architecture.md` |
| 数据库表结构 | `sql/create_table.sql` |
| Agent 工作记忆（领域化多文档） | `.agents/memories/README.md` |
| Agent 记忆总入口（一句话现状） | `MEMORY.md` |
| Python Agent 设计 / 契约 / 验收（**历史参考**，TS 移植参考源） | `docs/py_agent/task_plan.md` |
| Python Agent 进度与决策记录（历史） | `docs/py_agent/progress.md` |

## Key Conventions
- **Java 包结构**：`com.zdan.paimengaicodemother.*`，主要模块包括 `ai`（AI 相关）、`controller`（接口）、`service`（业务逻辑）、`mapper`（数据访问）
- **Java 后端代码风格**：遵循阿里巴巴 Java 开发手册
- **Vue3 前端代码风格**：Prettier 配置为无分号、单引号、100 字符宽度
- **前端路径**：主应用前端在 `paimeng-ai-code-mother-frontend/`
- **微服务重构**：`paimeng-ai-code-mother-microservice/` 为废弃尝试，不作为任何迁移前提
- **MyBatis Flex 代码生成**：使用 `com.zdan.paimengaicodemother.generator` 包中的生成器，生成的 mapper 文件位于 `src/main/resources/mapper/`
- **AI 链路（过渡态）**：旧 Java AI 实现（LangChain4j，`ai/` + `langgraph4j/` 包）为**回退主链路**，将在 TS Agent 契约对等后按 `docs/py_agent/t21_delete_plan.md` 删除（保留 `ai/codegen/route/*` 路由链、`ai/tools` 展示格式、`core/handler`、`BuilderExecutor`；`ai/python/*` 泛化为通用 Agent 客户端）
- **TS Agent 约定（待创建）**：编排收敛三纪律——phase 枚举进 `generation_run` DDL、跨请求等待仅显式持久化状态、重试有界；浏览器 wire 用新 SSE 协议（四类事件语义保留 + `milestone` 一等事件），契约落 `docs/ts_agent/contract.md`
- **数据分工**：**交易归 MySQL**（业务 + `chat_history` + `generation_run` + 积分台账）；**记忆归 PG**（已停用，RAG v2 pgvector 时重启）
- **服务间鉴权**：前端↔Java cookie session（现状）；前端↔TS Agent 短时 JWT（Java 签发，Agent 离线验签）；Agent→Java 内部回调 Bearer 服务令牌 + runId 幂等（沿用现 callback 机制）
- **共享工作区**：`tmp/code_output/{codeGenType}_{appId}`；Java 计算绝对路径传入，Agent 侧做沙箱校验
- **灰度开关**：`python-agent.enabled`（过渡期回切用，最终随 T21 清理）；TS Agent 接入后新增 `ts-agent.enabled`
- **配置文件**：`application-local.yml` 包含敏感信息，已 gitignore，不要提交到版本控制；Python 侧 `.env` 同样不提交（用 `cp .env.example .env`）
- **Git 提交**：如果是 Agent 代理提交,需要携带 `<Agent IDE>/<用户信息>` 信息

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues (github.com/ZDAN-GHN/paimeng-ai-code-mother), managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.
