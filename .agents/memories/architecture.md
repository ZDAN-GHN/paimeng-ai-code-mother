# 记忆：架构决策（双后端）

> 本文件记录双后端重构的**架构级决策**。权威论证见 `docs/py_agent/task_plan.md` §1 与「已确认架构」；此处为工作记忆摘要，不得与本目录其他文档冲突。

## 双后端职责边界（B2）

- **Java Spring Boot**（`src/`，主后端）：业务 REST/SSE 接口、鉴权、业务状态、浏览器侧传输封装、构建与部署。
- **Python Agent**（`paimeng-ai-code-agent/`，FastAPI）：模型调用、LangGraph 工作流、工具**执行**、Guardrail、代码解析、工作区落盘，发出四类语义事件（`ai_response`/`ai_thinking`/`tool_request`/`tool_executed`）。
- **Java 复用现有 `JsonMessageStreamHandler`/`SimpleTextStreamHandler`** 做工具去重、展示重组、聊天记录聚合；浏览器 wire（`data: {"d":…}`、`event: done`、`event: business-error`）由 Java 独占，Python 不直接接触。
- **红线**：Python 事件 JSON 须与旧 `StreamMessage` schema 逐字段对齐，禁止自创事件格式（浏览器 SSE 兼容是最高风险）。

## 回调与完成信号（H4）

- **回调是唯一完成信号**：Python 工作流完成后 POST 回 Java；Java 按 `runId` 幂等（首次：写历史→构建→浏览器 `done`；重复直接丢弃）。
- **独立等待超时** `callback-timeout-ms`（默认 60000），与 `read-timeout-ms`（300000）解耦；超时 → 浏览器 `business-error` + 幂等错误历史，不自动构建。
- 回调仅接受 `status ∈ {success, failed}`；handler 只校验 Bearer token，不取 session。

## 数据分工

- **PostgreSQL**：仅保存 LangGraph checkpoint（`thread_id = app:{appId}`）。
- **MySQL**：业务数据 + `chat_history`（产品事实来源）。
- **首次判定（M3）**：Python 以「`thread_id` 在 PostgreSQL 是否有 checkpoint」判定是否用请求 `history` bootstrap；Java 每次都传 `history`，不做判断。

## 灰度与切换

- `python-agent.enabled` 切换两套链路；`false` 走旧 Java AI 实现（行为不变），`true` 走 Python Agent。
- 任何阶段的第一个任务都必须保证 `./mvnw compile` 通过（编译红线，见 `java.md`）。

## 依赖与运行策略（M2/M4）

- Python 用 `uv`（`pyproject.toml` + `uv.lock`）锁定依赖，禁止写「最新稳定版」。
- 共享工作区：`tmp/code_output/{codeGenType}_{appId}`，Java 算绝对路径、Python 做沙箱校验。
- 详细运行/部署见 `deployment.md` 与 `docs/py_agent/task_plan.md` §9。
