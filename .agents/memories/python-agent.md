# 记忆：Python Agent(Python 后端)

> Python Agent（FastAPI + LangGraph + LangChain）侧的工作记忆。权威契约见 `docs/py_agent/task_plan.md` §1；任务分解见 §4。

## 当前状态（2026-08-31 阶段 2 T6-T7 完成核对）

| 项 | 状态 |
|---|---|
| `paimeng-ai-code-agent/` | **已创建**（`pyproject.toml`/`uv.lock`/`.python-version`/`app/`/`tests/`） |
| 技术基线 | Python 3.13.15（`.python-version` 锁定）+ FastAPI 0.141.1 + LangGraph 1.2.11 + Pydantic 2.13.5，`uv` 管理 |
| 依赖坑 | 已规避：fastapi 0.141.1 与 starlette 1.6.0 `pip check` 全绿（不再存在 0.115/1.0 不兼容） |
| T1-T13 | **全部完成**，`uv run pytest` **84 passed**（`-m contract` 11 passed）；阶段 2（T6-T13）全部落地，含离线 e2e（golden 夹具） |
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
- `app/callback.py`（T13）：`send_callback`/`send_request_callback`（§1.4，POST `{JAVA_BASE_URL}/api/app/chat/gen/code/callback`，Bearer + runId 幂等由 Java 保证）；`stream_events` 成功发 success / 失败发 failed 回调
- `app/streaming.py`（T12）：`stream_events` 主通道 SSE（vue→StreamMessage JSON / html/multi→文本块 / error 事件），html/multi 完成后原子落盘
- `app/graph.py`（T11）：`CodeGenWorkflow`（guardrail→image_collector→prompt_enhancer→router→code_generator→code_quality_check，质检失败有界重试；无 project_builder——构建留 Java）
- `app/workspace.py`（T10）：`write_generated_code` 集成入口（沙箱校验→html/multi_file 解析→原子落盘）
- `app/guardrails.py`（T9）：`PromptSafetyInputGuardrail.validate` + `validate_prompt`（长度/空输入/敏感词/注入模式，对齐 Java `PromptSafetyInputGuardrail`）
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

阶段 1-3（T0-T18）代码已全部落地（Python 84 passed；Java compile + 纯逻辑单测 11 passed）。剩余为**环境就绪项**：

- **PostgreSQL ✅（T19 已完成）**：用户态部署 PG16（清华镜像 deb 解包 + LD_LIBRARY_PATH + initdb/pg_ctl 非 root 于 5432，trust）；`_pool()` 需 `kwargs={"autocommit": True}, open=True`（`setup()` 的 `CREATE INDEX CONCURRENTLY` 要无事务块）；checkpoint 测试 87 passed
- **MySQL/Redis 实机（待办）**：T14a 补录浏览器事件基线（`sse_baseline.snapshot` 当前为代码推导的结构性基线）→ T18 灰度开关 live 校验 → T20 逐事件比较（`sse_baseline.py`）
- **T21**：按「稳定」定义（灰度 ≥7 天 + T19/T20 全绿 + 无 P0/P1）后删除旧 Java AI 实现

历史写入选型澄清：Python 链路成功 AI 历史由 handler 在流结束写（与旧链路一致），回调 success 不重复写；失败/超时由回调/超时兜底幂等写错误历史。

## 鉴权与工作区

- Bearer token：Python 从环境变量 `PYTHON_AGENT_TOKEN` 读取（与 Java `python-agent.token` 同一 token）。
- `workspacePath` 须校验位于 `WORKSPACE_ROOT` 之下（防路径穿越），否则 400。
- 工作区写入「临时子目录 → 原子 move」，失败清理并发 `error` 事件。
