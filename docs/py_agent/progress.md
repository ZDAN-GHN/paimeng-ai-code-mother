# 进度日志

> 本文件区分「架构决策记录」与「实现状态」。实现状态以 2026-08-31 仓库核对为准，与 `task_plan.md` 的「当前仓库基线」保持一致。

## 2026-08-28 — 架构决策记录

以下为架构澄清结论（决策事实，不代表已实现）：

- 确定以根目录 Java 单体（根 `src`）为主线；`paimeng-ai-code-mother-microservice` 属于未完成重构，不作为本次前提。
- 确定 Python Agent 子目录 `paimeng-ai-code-agent`、FastAPI + LangGraph + LangChain 技术基线。
- 确定 Java 对外接口、Python 内部 HTTP 调用、SSE 传输层/Agent 语义分离。
- 确定 PostgreSQL 仅保存 LangGraph checkpoint，MySQL 保留业务与聊天历史。
- 确定 Python 负责可复用 AI 能力、代码解析和工作区写入，Java 负责构建部署与浏览器侧传输。

## 2026-08-31 — 实现状态核对与方案修订

- **核对结论（重要）**：`paimeng-ai-code-agent` 目前**尚未创建**（仓库中无 `.py`/`pyproject.toml`/`uv.lock`）。Java 侧存在未提交的迁移残留：`application.yml` 已含 `python-agent` 配置段，`AppServiceImpl` 已引用 `PythonAgentClient`/`PythonAgentRequest`/`PythonAgentProperties`，但三个类均缺失（`ai/python` 为空目录）→ **当前 `./mvnw compile` 不通过**，须先按 `task_plan.md` 阶段 1 的 T0 恢复编译基线。
- 已按审查报告逐条修订 `task_plan.md`：补齐 Java↔Python 内部契约（§1）、如实标注阶段状态（§4）、补可执行验收与基线脚本（§5）、拆原子任务（§4）、枚举迁移组件（§3）、依赖锁定（§8）、运行与部署（§9）、参考清单（§7）。
- 已知环境问题：全局 FastAPI 0.115 与 Starlette 1.0 不兼容、pytest 收集被阻断 → 方案要求子项目 `uv` 独立虚拟环境并在 `pyproject.toml` 锁定兼容版本（见 `task_plan.md` §8）。
- 第 2 轮审查修订（2026-08-31）：补回调等待超时 `callback-timeout-ms`（§1.5，默认 60s，T0 绑定、T16 落地）、离线端到端改固定夹具快照（§5 阶段 2）、基线录制提前至 T14a（§4 阶段 3）、落实 A3-A9 建议（§1.3/§1.4/§4/§5）。
- 待办起点：从 `task_plan.md` 阶段 1 的 T0（恢复 Java 编译）与 T1-T5（Python 骨架）开始。

## 2026-08-31 — 阶段 1（T0-T5）完成

- **T0（恢复编译基线）✅**：新建 `config/PythonAgentProperties.java`（绑定 `python-agent` 段，含新增键 `callback-timeout-ms`，默认 60000）、`ai/python/PythonAgentRequest.java`（§1.2 字段 + `HistoryItem`）、`ai/python/PythonAgentClient.java`（WebClient，`health()` 可用，`stream()` 阶段 3 前抛明确 BusinessException）；`application.yml` 补 `callback-timeout-ms: ${PYTHON_AGENT_CALLBACK_TIMEOUT_MS:60000}`。命令证据：`JAVA_HOME=/home/zdan/.sdkman/candidates/java/current ./mvnw compile` → BUILD SUCCESS（注：`<java.version>21</java.version>` 需 JDK 21，sdkman 已装 `21.0.12+1.1-tem`）。
- **T1-T5（Python 骨架）✅**：`uv init` 建 `paimeng-ai-code-agent/`（`pyproject.toml` + `uv.lock` + `.python-version`=3.13.15）；`app/config.py`（pydantic-settings，§9 键）+ `.env.example`；`app/main.py`（`/healthz`）+ `app/api.py`（`POST /v1/agent/stream` SSE）+ `app/auth.py`（Bearer 校验）；`app/models.py`（§1.2 请求 / §1.3 四类事件 / §1.4 回调）；`app/state.py`（PostgresSaver 装配 + `thread_id=app:{appId}` + `has_checkpoint` 首次判定）。命令证据：`cd paimeng-ai-code-agent && uv run pytest` → **18 passed**（`-m contract` 11 passed）；实测 `curl http://localhost:8090/healthz` → 200 `{"status":"ok"}`、无 Bearer 调 `/v1/agent/stream` → 401、越界 `workspacePath` → 400。
- 依赖锁定（§8）：fastapi 0.141.1 / starlette 1.6.0 / langgraph 1.2.11 / langgraph-checkpoint-postgres 3.1.2 / pydantic 2.13.5，`uv.lock` 固定，`pip check` 全绿。
- 环境说明：本机无 PostgreSQL 实例，T19 checkpoint 恢复测试待 Postgres 就绪后执行；`PythonAgentClient.stream()` 尚未被业务调用（阶段 3 接入）。

## 下一步

- 阶段 2：T6-T13（文件类 Tools、codegen 服务、图片/质检/Guardrail、代码解析+工作区写入、graph、streaming、callback），每完成一个任务在此追加一行（含日期与命令证据）。
