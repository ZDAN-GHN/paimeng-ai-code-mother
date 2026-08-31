# 记忆：Python Agent(Python 后端)

> Python Agent（FastAPI + LangGraph + LangChain）侧的工作记忆。权威契约见 `docs/py_agent/task_plan.md` §1；任务分解见 §4。

## 当前状态（2026-08-31 核对）

| 项 | 状态 |
|---|---|
| `paimeng-ai-code-agent/` | **不存在**（无 `.py`/`pyproject.toml`/`uv.lock`） |
| 技术基线 | Python 3.13 + FastAPI + LangGraph + LangChain + Pydantic 2，`uv` 管理 |
| 依赖坑 | 全局 FastAPI 0.115 与 Starlette 1.0 不兼容（pytest 收集被阻断） |

## 踩坑与规避

- **FastAPI ↔ Starlette 版本**：必须 `pip check` 全绿。规避：锁 `starlette<1.0`，或升级 `fastapi` 至支持 Starlette 1.0 的版本；以 `uv.lock` 固定。
- 用 `uv venv` 独立虚拟环境，不用全局 pip，不受全局环境破坏影响。
- 禁止写「最新稳定版」，每个直接依赖给下限/兼容约束。

## 目录结构（目标）

`paimeng-ai-code-agent/`：`pyproject.toml`、`uv.lock`、`app/{main,api,auth,models,state,config,graph,streaming,callback,workspace,guardrails}.py`、`app/tools/`、`app/services/`、`tests/`（含 `tests/fixtures/` 固定夹具快照）。

## 下一步任务

从 `task_plan.md` 阶段 1 开工：
- **T1**：`uv` 初始化子项目（`pyproject.toml` + `uv.lock` + `app/` 骨架）
- **T2**：配置层 `app/config.py`（`PYTHON_AGENT_TOKEN`/`WORKSPACE_ROOT`/`DATABASE_URL`/`JAVA_BASE_URL` + `.env.example`）
- **T3**：FastAPI 应用（`/v1/agent/stream` SSE、`/healthz`、Bearer 鉴权）
- **T4**：Pydantic 请求/事件模型（§1.2/§1.3/§1.4）
- **T5**：PostgresSaver checkpointer（`langgraph.checkpoint.postgres`，`thread_id = app:{appId}`）

## 鉴权与工作区

- Bearer token：Python 从环境变量 `PYTHON_AGENT_TOKEN` 读取（与 Java `python-agent.token` 同一 token）。
- `workspacePath` 须校验位于 `WORKSPACE_ROOT` 之下（防路径穿越），否则 400。
- 工作区写入「临时子目录 → 原子 move」，失败清理并发 `error` 事件。
