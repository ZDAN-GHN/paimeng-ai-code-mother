# 记忆：运行与部署

> 环境依赖、敏感文件、共享工作区、启动命令的工作记忆。权威细节见 `docs/py_agent/task_plan.md` §9。

## 依赖服务

- **MySQL**（localhost:3306）：业务数据 + `chat_history`；建库脚本 `sql/create_table.sql`。
- **Redis**（localhost:6379）：session 存储。
- **PostgreSQL**（本地）：仅存 LangGraph checkpoint（Python Agent 用）。

## 敏感文件（不提交）

- `src/main/resources/application-local.yml`（gitignore；参考 `application.yml`，填 API keys）。
- Python 侧 `.env`（用 `cp .env.example .env`，gitignore）。

## 共享工作区

- `tmp/code_output/{codeGenType}_{appId}`；Java `CODE_OUTPUT_ROOT_DIR = user.dir/tmp/code_output`，Python 侧 `WORKSPACE_ROOT` 须为同一绝对路径。
- 本地同机；生产同容器卷或共享卷挂载。

## 启动命令

| 后端 | 命令 |
|---|---|
| Java | `./mvnw spring-boot:run`（端口 8123，context-path `/api`；API 文档 `http://localhost:8123/api/doc.html`） |
| Python | `cd paimeng-ai-code-agent && uv sync && cp .env.example .env && uv run uvicorn app.main:app --port 8090` |
| 前端 | `cd paimeng-ai-code-mother-frontend && npm run dev` |

## 健康检查

- `GET http://localhost:8090/healthz` → 200 `{"status":"ok"}`（Java 侧探活用）。
