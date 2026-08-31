# 记忆：Python Agent(Python 后端)

> Python Agent（FastAPI + LangGraph + LangChain）侧的工作记忆。权威契约见 `docs/py_agent/task_plan.md` §1；任务分解见 §4。

## 当前状态（2026-08-31 阶段 2 T6-T7 完成核对）

| 项 | 状态 |
|---|---|
| `paimeng-ai-code-agent/` | **已创建**（`pyproject.toml`/`uv.lock`/`.python-version`/`app/`/`tests/`） |
| 技术基线 | Python 3.13.15（`.python-version` 锁定）+ FastAPI 0.141.1 + LangGraph 1.2.11 + Pydantic 2.13.5，`uv` 管理 |
| 依赖坑 | 已规避：fastapi 0.141.1 与 starlette 1.6.0 `pip check` 全绿（不再存在 0.115/1.0 不兼容） |
| T1-T8 | **全部完成**，`uv run pytest` **55 passed**（`-m contract` 11 passed） |
| langgraph-checkpoint-postgres | 3.1.2，`PostgresSaver(pool)` 接受 psycopg `ConnectionPool`；`setup()`/`get_tuple()` 已确认 |
| PostgreSQL 实例 | 本机未安装/未启动（T19 checkpoint 恢复测试待环境就绪后跑） |

## 已落地模块

- `app/config.py`：pydantic-settings，`.env` 键 `PYTHON_AGENT_TOKEN`/`WORKSPACE_ROOT`/`DATABASE_URL`/`JAVA_BASE_URL`/`MODEL_*`/`DASHSCOPE_*`（§9）
- `app/main.py`：`/healthz`；`app/api.py`：`POST /v1/agent/stream`（SSE，占位流待 T11 替换）；`app/auth.py`：Bearer 校验（缺失/错误→401）
- `app/models.py`：§1.2 请求、§1.3 四类事件、§1.4 回调（字段与 Java `StreamMessage` 逐字段对齐）
- `app/sse.py`：SSE 序列化（§1.3 A5：空行分隔、data 逐行拆分）
- `app/workspace.py`：`validate_workspace_path`（沙箱，防路径穿越→400）+ `atomic_write_files`（临时子目录→原子 move，失败回滚旧目录）
- `app/state.py`：`PostgresSaver` 装配 + `thread_config`（`thread_id=app:{appId}`）+ `has_checkpoint`（首次判定，§1.5）
- `app/tools/file_tools.py`（T6）：`FileTools` 绑定工作区 + 构造二次沙箱校验；`_resolve` 路径穿越守卫；`write/read/modify/delete_file/read_dir/exit_tool`；`IGNORED_NAMES/IGNORED_EXTENSIONS/IMPORTANT_FILES` 对齐 Java（`index.html/style.css/script.js/package.json` 等不可删）
- `app/services/llm.py`（T7）：`create_chat_model(reasoning=False, temperature=0.7)` → ChatOpenAI（config `MODEL_*`）；`load_prompt(name)` 读 `app/prompts/`
- `app/prompts/`（T7）：7 份提示词，源 `src/main/resources/prompt/*.txt`
- `app/services/images.py`（T8）：图片模型 + `plan_image_collection`（规划）+ `collect_images`（工具调用采集）+ `ImageTools` 四工具（Pexels/Undraw/DashScope/Mermaid，名称对齐 Java `@Tool`；COS 上传未迁移，file:// 回填）
- `app/services/quality.py`（T8）：`check_code_quality`（异常按通过处理）+ `read_and_concatenate_code_files`（扩展名过滤 + 跳过 node_modules/dist/target/.git）
- `app/services/codegen/`（T7）：`parsing.py`（HTML/MultiFile 解析正则对齐 Java `core/parser`）、`html.py`/`multi_file.py`（ChatOpenAI 文本流）、`vue.py`（reasoning 模型 + 6 工具 `bind_tools` 循环，`MAX_TOOL_CALLS=50`）、`routing.py`（关键词路由兜底 html）、`__init__.py`（`CodeGenServiceFactory` + `CodeGenServiceExecutor.stream`：vue→`run()`，其余→`stream()`）
- `tests/`：`conftest.py`（预置 `PYTHON_AGENT_TOKEN=test-token`、`WORKSPACE_ROOT=/tmp/paimeng-test-workspace`）+ 契约/SSE/工作区/工具/代码生成测试

## 踩坑与规避

- **FastAPI ↔ Starlette 版本**：fastapi 0.141.1 ↔ starlette 1.6.0 组合可复现（`uv.lock` 固定）。
- **Python 版本**：`uv init` 默认解析到 3.14，必须写 `.python-version`=3.13 锁定 3.13.15。
- `uv run pip check` 不可用（uv 虚拟环境无 pip），用 `uv pip check` 等价检查。
- 工作区原子写入的临时目录必须建在目标**父目录**（sibling），不能建在目标目录内部（否则 rename 目标时 stage 随之移动导致路径失效）。

## 目录结构（已落地 / 目标）

`paimeng-ai-code-agent/`：`pyproject.toml`、`uv.lock`、`.python-version`、`.env.example`、`app/{main,api,auth,models,state,config,sse,workspace,graph,streaming,callback,guardrails}.py`、`app/tools/`、`app/services/`、`tests/`（含 `tests/fixtures/` 固定夹具快照）。

## 下一步任务

阶段 2（T9-T13）：
- **T9**：Guardrail 迁移（`PromptSafetyInputGuardrail`）
- **T10**：代码解析与工作区写入（`workspace.py` 已具备原子写基础，`parsing.py` 的 `to_files` 就绪）
- **T11-T13**：LangGraph 工作流编排、SSE 流式输出适配、完成回调客户端（`app/callback.py`）

## 鉴权与工作区

- Bearer token：Python 从环境变量 `PYTHON_AGENT_TOKEN` 读取（与 Java `python-agent.token` 同一 token）。
- `workspacePath` 须校验位于 `WORKSPACE_ROOT` 之下（防路径穿越），否则 400。
- 工作区写入「临时子目录 → 原子 move」，失败清理并发 `error` 事件。
