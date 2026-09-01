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

## 2026-08-31 — 阶段 2（T6-T7）完成

- **T6（文件类 Tools）✅**：`app/tools/file_tools.py` 定义 `FileTools`（绑定工作区并在构造时二次校验沙箱）；`_resolve` 路径穿越守卫；`write_file/read_file/modify_file/delete_file/read_dir/exit_tool`；`IGNORED_NAMES/IGNORED_EXTENSIONS/IMPORTANT_FILES` 对齐 Java `ai/tools` 与 `core/saver` 清单（`index.html/style.css/script.js/package.json` 等不可删除）。命令证据：`uv run pytest tests/test_tools.py` → **11 passed**。
- **T7（codegen 服务）✅**：
  - `app/services/llm.py`：`create_chat_model(reasoning=False, temperature=0.7)` → ChatOpenAI（`MODEL_BASE_URL/MODEL_API_KEY/MODEL_NAME/REASONING_MODEL_NAME` 从 config 读取）；`load_prompt(name)` 读 `app/prompts/`。
  - `app/prompts/`：迁移自 `src/main/resources/prompt/*.txt` 的 7 份提示词（含 `codegen-vue-project-system-prompt.txt`）。
  - `app/services/codegen/parsing.py`：`parse_html_code`（```` ```html ```` 块抽取，回退全文）、`parse_multi_file_code`（html/css/js 三段）、`to_files`（去空行）→ `HtmlCodeResult`/`MultiFileCodeResult`，正则对齐 Java `core/parser`。
  - `app/services/codegen/html.py`/`multi_file.py`：ChatOpenAI 文本流式生成（系统提示词 + `stream()` 逐块产出文本事件），`__init__.py` 中 `CodeGenServiceFactory` 与 `CodeGenServiceExecutor.stream(...)` 按类型分派。
  - `app/services/codegen/vue.py`：`VueCodeGenService(FileTools)`，6 个 langchain 工具绑定（write/read/modify/delete/read_dir/exit），reasoning 模型 `bind_tools` 循环（`MAX_TOOL_CALLS=50`）产出 `tool_request`/`tool_executed`/`ai_thinking`/`ai_response` 事件字典；`_execute()` 按名分派；`stream()` 抛 `NotImplementedError`（由 executor 走 `run()`）。
  - `app/services/codegen/routing.py`：`route_code_gen_type` 关键词路由（vue_project/multi_file/html，兜底 html），对齐 Java `RouterNode` 与 `PaimengAiService#getAiGenerateMode`。
  - 命令证据：`uv run pytest tests/test_codegen.py` → **14 passed**；`uv run pytest` 全量 → **43 passed**。
- 提交：`d482a60 feat: Python Agent 阶段 2（T6-T7）文件工具与 CodeGen 服务`（`DSH Web/ZDAN <zdan60661@gmail.com>`）。

## 2026-08-31 — 阶段 2（T8）完成

- **T8（图片采集与质量检查服务）✅**：
  - `app/services/images.py`：`ImageCategory/ImageResource/ImageCollectionPlan` 数据模型（camelCase alias 对齐提示词 JSON）；`plan_image_collection`（规划提示词驱动模型 → 结构化计划，解析失败回退空计划）；`collect_images`（模型自主调用 4 个图片工具，汇总 `ImageResource`）；`ImageTools` 四个工具绑定（`searchContentImages` Pexels / `searchIllustrations` Undraw / `generateArchitectureDiagram` mmdc→SVG / `generateLogos` DashScope 文生图），工具名对齐 Java `@Tool`。对齐 Java `langgraph4j/ai/ImageCollectionPlanService`、`ImageCollectionService` 与 `langgraph4j/tools/*`。注意：`MermaidDiagramTool` 的 COS 上传属 Java 云端基建，未迁移（Python 侧以 `file://` 本地路径回填）。
  - `app/services/quality.py`：`QualityResult` 模型 + `check_code_quality`（质检提示词驱动模型 → 结构化结果，异常按通过处理）+ `read_and_concatenate_code_files`（只拼代码扩展名文件，跳过隐藏与 node_modules/dist/target/.git，对齐 Java `CodeQualityCheckNode`）。
  - `config.py`/`.env.example`：新增 `PEXELS_API_KEY`（对齐 Java `pexels.api-key`）。
  - 命令证据：`uv run pytest tests/test_images.py tests/test_quality.py` → **12 passed**；`uv run pytest` 全量 → **55 passed**。
- 提交：`T8 图片采集与质量检查服务`（`DSH Web/ZDAN <zdan60661@gmail.com>`）。

## 2026-08-31 — 阶段 2（T9）完成

- **T9（Guardrail）✅**：`app/guardrails.py` 定义 `PromptSafetyInputGuardrail`（`validate(input_text)` 返回 `GuardrailResult{is_allowed,reason}`）+ 模块级 `validate_prompt`；四类校验与 Java `ai/guardrail/PromptSafetyInputGuardrail` 逐条对齐：长度>1000 字、空输入、敏感词（忽略之前的指令/ignore previous instructions/破解/hack/绕过/bypass/越狱/jailbreak）、注入模式（ignore\s+previous.../pretend as if/system: you are/new instructions: 等 5 条正则）。命令证据：`uv run pytest tests/test_guardrails.py` → **6 passed**；全量 → **61 passed**。
- 提交：`T9 提示词安全输入护轨`（`DSH Web/ZDAN <zdan60661@gmail.com>`）。

## 2026-08-31 — 阶段 2（T10）完成

- **T10（代码解析与工作区写入集成）✅**：`app/workspace.py` 新增 `write_generated_code(workspace_path, code_gen_type, output_text)`——沙箱校验 → html/multi_file 解析（复用 `parsing.to_files`）→ `atomic_write_files` 原子落盘（临时子目录 → 原子 move，§1.5）；不支持的生成类型抛 `ValueError`（vue_project 由文件工具直接建项目，不适用）。命令证据：`uv run pytest tests/test_workspace.py` → **7 passed**；全量 → **64 passed**。
- 提交：`T10 代码解析与工作区写入集成`（`DSH Web/ZDAN <zdan60661@gmail.com>`）。

## 2026-08-31 — 阶段 2（T11）完成

- **T11（LangGraph 工作流编排）✅**：`app/graph.py` 定义 `CodeGenWorkflow`（`CodeGenState` TypedDict 状态 + 六个节点 + 条件边）：`guardrail → image_collector → prompt_enhancer → router → code_generator → code_quality_check`；guardrail 拒绝→END（带 error）；质检失败且有界重试（`MAX_QUALITY_RETRIES`=2，即初始 1 次 + 重试 2 次）→ 回 `code_generator`，通过或超限→END。对齐 Java `langgraph4j/CodeGenWorkflow`：图片收集为「规划→顺序执行四类工具」简化版（并发 fan-out 非必要）；不含 `project_builder`（构建留 Java）；依赖全部可注入（executor/guardrail/image_tools/image_plan/quality_check/router）便于离线测试。命令证据：`uv run pytest tests/test_graph.py` → **6 passed**；全量 → **70 passed**。
- 提交：`T11 LangGraph 工作流编排`（`DSH Web/ZDAN <zdan60661@gmail.com>`）。

## 2026-08-31 — 阶段 2（T12）完成

- **T12（SSE 流式输出适配）✅**：`app/streaming.py` 定义 `stream_events(request, *, executor, guardrail)` 异步生成器——vue_project 发四类 StreamMessage JSON（`_normalize_vue_event` 逐字段归一化）；html/multi_file 发纯文本增量块（换行拆分 data: 行）；guardrail 拒绝或生成异常发 `event: error` + `data:{"message":...}`（§1.3，Java 映射 business-error），且 error 后不再发业务事件。html/multi_file 文本收集完整后调用 `write_generated_code` 原子落盘（§1.5）。`app/api.py` 主通道 `/v1/agent/stream` 已替换占位流为真实 `stream_events`。命令证据：`uv run pytest tests/test_streaming.py` → **5 passed**；`tests/test_contract.py`（含合法令牌流式用例，mock 生成器避免在线调用）→ **11 passed**；全量 → **75 passed**。
- 提交：`T12 SSE 流式输出适配`（`DSH Web/ZDAN <zdan60661@gmail.com>`）。

## 2026-08-31 — 阶段 2（T13）完成 · 阶段 2 全部落地

- **T13（完成回调客户端）✅**：`app/callback.py` 定义 `send_callback`（§1.4 字段 + Bearer 头，POST `{JAVA_BASE_URL}/api/app/chat/gen/code/callback`，`runId` 透传，幂等由 Java 侧保证；非 2xx 返回 False 不抛出）+ `send_request_callback`（按 AgentRequest 便捷发送）。`app/streaming.py` 的 `stream_events` 接入回调：工作区落盘成功后发 `success`；guardrail 拒绝/生成异常发 `failed` + message（§1.4 唯一完成信号，回调注入可测试）。
- 命令证据：`uv run pytest tests/test_callback.py tests/test_streaming.py` → **12 passed**；全量 → **82 passed**；`JAVA_HOME=.../java/current ./mvnw compile` → **BUILD SUCCESS**（MVN_EXIT=0，基线保持）。
- 提交：`T13 完成回调客户端`（`DSH Web/ZDAN <zdan60661@gmail.com>`）。
- **阶段 2（T6-T13）全部完成**：文件工具、codegen 服务、图片/质检、Guardrail、代码解析+落盘、LangGraph 工作流、SSE 适配、完成回调均已落地并单测覆盖。
- **阶段 2 离线 e2e（§5）✅**：`tests/fixtures/golden_html.json`/`golden_multi_file.json` 固定夹具快照（文件清单 + 关键片段）+ `tests/test_e2e.py`（mock 生成器，不依赖在线模型）断言产出工作区文件；`uv run pytest` → **84 passed**；`uv pip check` 64 包全兼容。

## 2026-08-31 — 阶段 3（T14a-T18）Java 接入落地（实现 + 编译 + 纯逻辑单测）

- **T14a（基线快照）✅（结构性）**：`docs/py_agent/sse_baseline.snapshot` 由现有 handler/controller 代码推导冻结浏览器 SSE 契约（`data: {"d":...}` 文本事件、`event: done`、`event: business-error`、vue 工具展示模板表、html/multi 透传）。**实机 curl -N 录制被环境阻断**：本机无 MySQL/Redis（无 root 无法安装、Docker WSL 集成未激活），无法启动旧 Java AI 链路；文件内已附待环境就绪后的补录命令，T20 用 `sse_baseline.py` 逐事件比较。
- **T14（PythonAgentClient）✅**：`stream()` 用 WebClient POST `/v1/agent/stream`，`ParameterizedTypeReference<ServerSentEvent<String>>` 解码 SSE（event 名 + data 载荷），连接/读超时取自配置；未启用时抛明确 `BusinessException`（早暴露误配置）。命令证据：`./mvnw test -Dtest=PythonAgentClientTest` → **5 passed**（JDK HttpServer 模拟 Python SSE，不依赖 Spring/DB）。
- **T15（PythonAgentSseAdapter）✅**：`adapt()` 按 `buildType` 分流——NPM(vue)→`JsonMessageStreamHandler`（工具 id 去重 + `ToolManager` 展示重组）、NONE(html/multi)→`SimpleTextStreamHandler`（透传）；`error` 事件过滤不进展示流。
- **T16（回调 endpoint + runId 注册表）✅**：`RunIdSinkRegistry`（runId→浏览器终端信号 Sinks.One + appId/codeGenType/workspacePath/loginUser + `AtomicBoolean` 幂等）；`AppController` 新增 `POST /app/chat/gen/code/callback`（对外全路径 `/api/app/chat/gen/code/callback`）——Bearer-only（不取 session，A4）、status 仅 success/failed（A9，非法 400）、runId 幂等（重复/迟到回调 200 丢弃）、success→`BuilderExecutor.doBuild`+done、failed→错误历史+business-error。
- **T17（错误/超时映射）✅**：Python `error` 事件 → `businessErrorSse` + 幂等失败历史；主通道结束后 `awaitTerminal` 等待回调，`callback-timeout-ms` 超时 → 幂等错误历史 + `business-error`（§1.5 H4）。命令证据：`./mvnw test -Dtest=RunIdSinkRegistryTest` → **6 passed**（幂等/终端/超时兜底）。
- **T18（灰度开关）✅（代码）**：`AppServiceImpl.chatToGenCode` 按 `python-agent.enabled` 分支——false 走旧链路（浏览器字节与迁移前一致），true 走 Python 链路（主通道事件分流 + 回调终端）。**实机校验待 MySQL/Redis + 登录态 + Python Agent 联调**（见下）。
- **历史写入选型澄清（记录）**：Python 链路成功时 AI 历史由 handler 在流结束写入（与旧链路一致），回调 success 不再重复写；失败/超时由回调/超时兜底幂等写错误历史。避免与「复用现有 handler」冲突导致重复写。此澄清待 T20 实机核对。
- 编译：`JAVA_HOME=.../java/current ./mvnw compile` → **BUILD SUCCESS**；`./mvnw test -Dtest=PythonAgentClientTest,RunIdSinkRegistryTest` → **11 passed**（其余 `@SpringBootTest` 用例需 DB 环境，跳过）。

## 2026-08-31 — 阶段 4（T19）完成 · PostgreSQL 环境解锁

- **环境突破**：本机无 root、无 MySQL/Redis/PostgreSQL、Docker WSL 集成未激活；改用**用户态部署 PostgreSQL 16**（从清华 Ubuntu 镜像下载 `postgresql-16` + `libpq5` deb，`dpkg-deb -x` 解包，`LD_LIBRARY_PATH` 指到 libpq5，`initdb` + `pg_ctl` 以非 root 运行于 127.0.0.1:5432，trust 认证）。命令证据见下文。
- **T19（checkpoint 恢复测试）✅**：`app/state.py` 的 `_pool()` 修正为 `ConnectionPool(conninfo, kwargs={"autocommit": True}, open=True)`——`PostgresSaver.setup()` 含 `CREATE INDEX CONCURRENTLY`，必须无事务块（锁定 langgraph-checkpoint-postgres 3.1.2 用法）。`tests/test_checkpoint.py`（checkpoint marker）：首次判定 `has_checkpoint=False` → 生成后 `True`（第二次请求不重复 bootstrap）；同 thread_id 从 checkpoint 恢复继续累加；不同 thread_id 隔离。命令证据：`DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/paimeng_test uv run pytest` → **87 passed**，两次运行幂等。
- 提交：`T19 PostgreSQL checkpoint 恢复测试`（`DSH Web/ZDAN <zdan60661@gmail.com>`）。

## 下一步（环境就绪项）

- **需 MySQL/Redis 实机**：T14a 实机补录基线（三类各录一次）→ T18 灰度开关 live 校验 → T20 逐事件比较（`sse_baseline.py`）。若可按 PostgreSQL 同样方式用户态部署 MySQL/Redis + 运行 Java 后端（需 DeepSeek 在线），则可完成。
- **T21（删除旧 AI 实现）**：按「稳定」定义（开发环境灰度 ≥7 天 + T19/T20 回归全绿 + 无 P0/P1）后执行，属部署期门禁，单会话无法完成。
