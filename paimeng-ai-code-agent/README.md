# paimeng-ai-code-agent

派蒙 AI 应用工坊的 Python Agent 子项目（FastAPI + LangGraph + LangChain + Pydantic 2）。

承载 AI 能力：模型调用、LangGraph 工作流、工具执行、Guardrail、代码解析、工作区落盘；
向 Java 后端发出四类语义事件（`ai_response` / `ai_thinking` / `tool_request` / `tool_executed`）。

契约以 `docs/py_agent/task_plan.md` §1 为准，字段名、事件名、顺序不得自行改动。

## 快速开始

```bash
export UV_PROJECT_ENVIRONMENT=.venv-wsl
uv sync
cp .env.example .env   # 按需填写密钥
uv run uvicorn app.main:app --port 8090
```

## 测试

```bash
export UV_PROJECT_ENVIRONMENT=.venv-wsl
uv run pytest                 # 全部
uv run pytest -m contract     # Java↔Python 契约
```
