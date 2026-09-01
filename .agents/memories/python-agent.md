# 记忆：Python Agent(Python 后端)

> Python Agent（FastAPI + LangGraph + LangChain）侧的工作记忆。权威契约见 `docs/py_agent/task_plan.md` §1；任务分解见 §4。

## 当前状态（2026-09-01 T14a/T18/T20 实机验证完成）

| 项 | 状态 |
|---|---|
| `paimeng-ai-code-agent/` | **已创建**（`pyproject.toml`/`uv.lock`/`.python-version`/`app/`/`tests/`） |
| 技术基线 | Python 3.13.15（`.python-version` 锁定）+ FastAPI 0.141.1 + LangGraph 1.2.11 + Pydantic 2.13.5，`uv` 管理 |
| 依赖坑 | 已规避：fastapi 0.141.1 与 starlette 1.6.0 `pip check` 全绿（不再存在 0.115/1.0 不兼容） |
| T1-T20 | **全部完成**，`uv run pytest` **87 passed**（`-m contract` 11 passed）；T14a/T18/T20 **实机验证通过**（Python 链路三类型灰度实测 + `sse_baseline.py` `DIFF 为空`） |
| langgraph-checkpoint-postgres | 3.1.2，`PostgresSaver(pool)` 接受 psycopg `ConnectionPool`；`setup()`/`get_tuple()` 已确认 |
| PostgreSQL 实例 | 用户态 PG16 于 127.0.0.1:5432（清华镜像 deb 解包 + `LD_LIBRARY_PATH`）；`_pool()` 需 `kwargs={"autocommit": True}, open=True` |
| MySQL/Redis 实例 | 用户态 MySQL 8.0.36（127.0.0.1:3306，root/root，DB `paimeng_ai_code_mother`）+ Redis 7.2.5（6379）就绪 |

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

阶段 4 验证（T19/T20）已实机完成；阶段 5（T21 就绪准备）已完成：删除方案 `docs/py_agent/t21_delete_plan.md`（含用户决策）+ 新链路回归 `PythonAgentSseAdapterTest`（3 passed，全量 Java 30 用例中 Python 新链路 14 全绿）。剩余为**部署期门禁 T21**：

- **T21（待稳定期，范围已按用户决策收敛）**：按「稳定」定义（开发环境灰度 ≥7 天 + T19/T20 回归全绿 + 无 P0/P1）后删除旧 Java AI 实现。**`createApp` 保留 Java 侧 AI 路由**（用户已确认，不改为默认 html/前端字段/Python 路由）→ 保留 `ai/codegen/route/*` + `config/RoutingAiModelConfig` + `utils/SpringContextUtil` + `prompt/codegen-routing-system-prompt.txt` + langchain4j 依赖（路由链自成闭环）；删除 `ai/codegen` 执行类（7 个）、`langgraph4j/*`、`ai/guardrail/*`、`core/AiCodeGeneratorFacade`+`core/parser`+`core/saver`、`utils/ClazzScanner`；保留 `ai/tools` 展示格式、`core/handler`、`BuilderExecutor`、`ai/python/*`、`ai/enums/CodeGenTypeEnum`、`AiCodeGenTypeRoutingServiceTest`；`AppServiceImpl` 只移除 `aiCodeGeneratorFacade`/`streamHandlerExecutor` 与 `chatToGenCode` 旧分支，路由保留。pom：`langgraph4j-*` 可删，`langchain4j-*` 保留。回归口径：Java 新链路 14 + 路由 1 + Python 87（含契约 11）+ `sse_baseline.py` 三类 DIFF 为空。

历史写入选型澄清：Python 链路成功 AI 历史由 handler 在流结束写（与旧链路一致），回调 success 不重复写；失败/超时由回调/超时兜底幂等写错误历史。实测：Python 进程停掉 → 浏览器 ~1s 内 business-error + 恰好 1 条错误历史（Java 侧 `onErrorResume` 立即 `complete(runId, businessErrorSse)`，错误继续下传给 handler 写历史）。

## 实机验证发现的契约要点（2026-09-01）

- **vue 工具名/参数必须驼峰**：`@langchain_tool` 需显式命名 `writeFile/readFile/modifyFile/deleteFile/readDir/exit`（§1.3 与 Java `ToolManager` 一致），否则 Java `getTool` 返回 null NPE；参数键同样驼峰（`relativeFilePath`/`relativeDirPath`/`oldContent`/`newContent`），否则浏览器 `[工具调用] 写入文件 null`。
- **exit 工具确定性**：模型是否调用 exit 不确定，`VueCodeGenService.run()` 在模型直接给最终答案时补发 exit 工具事件（`exit-{uuid}`），保证与基线 `[执行结束]` 序列一致。
- **Reactor SSE 空事件**：Java `bodyToFlux(ServerSentEvent<String>)` 解码本流会产生 `data=null` 空事件（实测单流 12 个），Java 侧 `PythonAgentClient.stream()` 与 `PythonAgentSseAdapter.adapt()` 均需 `filter(event -> event.data() != null)`。
- `.env` 的 `MODEL_API_KEY`/`DASHSCOPE_API_KEY`/`PEXELS_API_KEY` 原为空占位，实机联调时从 `application-local.yml` 补齐（同值）。

## 鉴权与工作区

- Bearer token：Python 从环境变量 `PYTHON_AGENT_TOKEN` 读取（与 Java `python-agent.token` 同一 token）。
- `workspacePath` 须校验位于 `WORKSPACE_ROOT` 之下（防路径穿越），否则 400。
- 工作区写入「临时子目录 → 原子 move」，失败清理并发 `error` 事件。
