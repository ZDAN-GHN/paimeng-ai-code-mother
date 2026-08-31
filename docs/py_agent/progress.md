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

## 下一步

- 阶段 2 续：T10（代码解析 + 工作区写入集成）、T11（graph.py 工作流编排）、T12（streaming.py SSE 事件流）、T13（callback.py 回调），每完成一个任务在此追加一行（含日期与命令证据）。
