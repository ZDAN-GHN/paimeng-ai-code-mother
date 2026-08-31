# Python Agent 迁移计划（修订版）

> 本版按《agent-design-review》审查报告逐条修订（2026-08-31）：
> 新增「Java↔Python 内部契约」章节（B1/B2）、如实标注阶段状态（H1）、
> 补可执行验收与基线脚本（H2）、拆原子任务（H3）、枚举迁移组件（M1）、
> 依赖锁定（M2）、首次判定（M3）、运行与部署（M4）、参考清单（M5）。
>
> 第 2 轮修订（2026-08-31）：补回调等待超时 `callback-timeout-ms`（H4）、
> 离线端到端改固定夹具快照（M6）、落实 A3-A9 建议。

## 目标

在当前仓库新增独立的 Python Agent 子项目 `paimeng-ai-code-agent`，完整承载根目录 `src` 中可复用的 AI 能力（迁移组件清单见 §4）；Java Spring Boot 继续对外提供业务 REST/SSE 接口，只负责鉴权、业务状态、浏览器侧传输、构建与部署。

**完成态（可判定）**：
1. `./mvnw compile` 与 `cd paimeng-ai-code-agent && uv run pytest` 全绿；
2. `python-agent.enabled=true` 时，浏览器端 `GET /api/app/chat/gen/code` 的事件序列与旧 Java 链路逐事件一致（对照 `docs/py_agent/sse_baseline.py` 基线，见 §5/§4-T20）；
3. `python-agent.enabled=false` 时旧 Java 链路行为完全不变（灰度回滚路径）；
4. 灰度稳定期满后删除旧 AI 实现，全量回归通过。

## 当前仓库基线（2026-08-31 核对）

| 项 | 状态 | 说明 |
|---|---|---|
| `paimeng-ai-code-agent/` 子项目 | **不存在** | 仓库无 `.py`/`pyproject.toml`/`uv.lock`，须新建 |
| `application.yml` 的 `python-agent` 配置段 | 已存在（未提交） | `enabled/base-url/token/connect-timeout-ms/read-timeout-ms` 五个键 |
| `AppServiceImpl` 的 Python 分支 | **残留且编译不通过** | 引用了不存在的 `PythonAgentClient`/`PythonAgentRequest`/`PythonAgentProperties`，`ai/python` 为空目录，`config/PythonAgentProperties` 缺失 |
| 旧 Java AI 链路（`ai/`、`langgraph4j/`、handler） | 完整存在 | 见 §1.6、§4 |
| 共享工作区常量 | 存在 | `AppConstant.CODE_OUTPUT_ROOT_DIR = user.dir + "/tmp/code_output"` |

> **约束**：任何阶段的第一个任务都必须保证 `./mvnw compile` 通过（先补齐 §4 阶段 1 的 T0 恢复编译，再继续）。

## 已确认架构

- Python 3.13，`uv` 管理依赖；框架：FastAPI、LangGraph、LangChain、Pydantic 2。
- 依赖版本策略见 §8「依赖锁定」——不使用「最新稳定版」这种不可复现表述。
- Java 使用 WebClient 直接 HTTP 调用 FastAPI（不引入 gRPC/Dubbo）。
- Java 对外 SSE 连接负责浏览器侧传输封装；Python 负责全部 Agent 语义（模型、工作流、工具执行、Guardrail、代码解析、工作区落盘），并发出四类语义事件（见 §3）。
- PostgreSQL 仅保存 LangGraph checkpoint；MySQL 继续保存业务数据和 `chat_history`。
- `thread_id = app:{appId}`；首次调用（thread_id 无 checkpoint）用 MySQL 历史 bootstrap，后续从 PostgreSQL 恢复。**「首次」由 Python 侧判定**（见 §1.5）。
- 共享工作区：`tmp/code_output/{codeGenType}_{appId}`（Java 计算绝对路径传入，Python 做沙箱校验，见 §1.2）。
- 迁移通过 Java 配置开关 `python-agent.enabled` 切换；旧 Java AI 实现只保留过渡周期。
- 密钥使用 `pydantic-settings` + `.env`（本地）与环境变量/Secret Manager（生产）；键名见 §9。
- 可观测性第一阶段仅结构化日志、`runId` 和基础耗时；OpenTelemetry/LangSmith 可选。

---

## §1 Java↔Python 内部契约（B1/B2）

> 本节是本方案的**接口契约**，Java 与 Python 两侧都必须按此实现；字段名、事件名、顺序不得自行改动。

### 1.1 通道与鉴权

| 通道 | 方向 | 定义 |
|---|---|---|
| 主通道 | Java → Python（请求）+ Python → Java（SSE 流） | `POST {PYTHON_AGENT_BASE_URL}/v1/agent/stream`，头 `Accept: text/event-stream`，请求体见 §1.2 |
| 完成回调 | Python → Java | `POST {JAVA_BASE_URL}/api/app/chat/gen/code/callback`（Java 内部接口，不走用户鉴权），body 见 §1.4 |
| 健康检查 | Java → Python | `GET {PYTHON_AGENT_BASE_URL}/healthz` → 200 `{"status":"ok"}` |

- 鉴权：所有请求携带 `Authorization: Bearer {python-agent.token}`（Java 从 `python-agent.token` 配置读取；Python 从环境变量 `PYTHON_AGENT_TOKEN` 读取，两端共享同一 token）。
- 令牌缺失/错误 → 401；令牌正确但访问无权限的内部接口 → 403。
- `PYTHON_AGENT_BASE_URL` 默认 `http://localhost:8090`；`JAVA_BASE_URL` 由 Java 侧以环境变量 `JAVA_BASE_URL` 提供给 Python（默认 `http://localhost:8123`，注意 Java context-path 为 `/api`）。

### 1.2 主通道请求 JSON（Java → Python）

```json
{
  "appId": 1,
  "userId": 10001,
  "message": "做一个红包雨页面",
  "codeGenType": "html",
  "runId": "7f2c8f9e-4d3a-4b2c-9e1f-0a1b2c3d4e5f",
  "threadId": "app:1",
  "workspacePath": "/abs/path/tmp/code_output/html_1",
  "history": [
    {"role": "user", "content": "帮我做一个抽奖页面"},
    {"role": "assistant", "content": "好的，开始生成"}
  ]
}
```

字段约束：
- `codeGenType` ∈ `{html, multi_file, vue_project}`，与 `CodeGenTypeEnum.value` 一致。
- `runId`：Java 生成的 UUID，用于日志追踪与回调幂等。
- `threadId`：固定 `app:{appId}`。
- `workspacePath`：Java 计算的绝对路径 `{CODE_OUTPUT_ROOT_DIR}/{codeGenType}_{appId}`。**Python 必须校验其位于配置的 `WORKSPACE_ROOT` 目录之下**，否则返回 400（防路径穿越）。
- `history`：MySQL 最近 20 条对话（`role` ∈ user/assistant）。每次请求都携带；Python 仅在 `thread_id` 无 checkpoint 时用作 bootstrap（「首次」判定见 §1.5）。

### 1.3 主通道流式事件（Python → Java）

按 `codeGenType` 分两类 `data`：
- `vue_project`：`data` 为四类 **StreamMessage JSON**（与旧 Java 模型逐字段一致，见下表）。
- `html` / `multi_file`：`data` 为**纯文本增量块**（不套 JSON）。

事件 schema（`data` 单行 JSON；`type` 取值与 `StreamMessageTypeEnum.value` 一致）：

| type | 字段 |
|---|---|
| `ai_response` | `type`, `data` |
| `ai_thinking` | `type`, `text` |
| `tool_request` | `type`, `id`, `name`, `arguments` |
| `tool_executed` | `type`, `id`, `name`, `arguments`, `result` |

- `ai_response.data` / `ai_thinking.text` 为逐块增量文本，Java 端按序拼接。
- `tool_request` 按 `id` **首次去重展示**，`tool_executed` 按 `name`+`arguments` 生成结果文本——这两步由 Java 复用现有 `ToolManager.generateToolRequestResponse` / `generateToolExecutedResult` 完成（见 §1.6）。
- 错误事件：`event: error` + `data: {"message":"..."}`；Java 收到后映射为浏览器 `business-error`。
- **顺序约束**：`tool_request` 必须先于其对应 `tool_executed`；`ai_response`/`ai_thinking` 可穿插；发出 `error` 后不得再发业务事件。
- **SSE 序列化约定（A5）**：事件以空行分隔；`data:` 多行内容以 `\n` 拼接；HTML/MULTI_FILE 文本块内换行须逐行拆分为独立 `data:` 行，避免与事件分隔冲突；统一 UTF-8。
- Java 侧约定：`vue_project`（buildType=NPM）事件喂给现有 `JsonMessageStreamHandler`；`html`/`multi_file`（buildType=NONE）文本块喂给现有 `SimpleTextStreamHandler`（见 §1.6）。

### 1.4 完成回调（Python → Java）

```json
{
  "runId": "7f2c8f9e-4d3a-4b2c-9e1f-0a1b2c3d4e5f",
  "appId": 1,
  "codeGenType": "html",
  "status": "success",
  "message": "",
  "workspacePath": "/abs/path/tmp/code_output/html_1"
}
```

- **回调是唯一完成信号**：Python 写完工作区全部文件后调用（`status: "success"`）；中途失败也调用（`status: "failed"` + `message`）。回调仅接受 `status ∈ {success, failed}`，非法值返回 400（A9）。
- **幂等**：Java 按 `runId` 只处理一次——首次处理时按序执行：写 `chat_history`（success 时）→ `BuilderExecutor.doBuild` → 向该 `runId` 关联的浏览器 SSE 发送 `done` 并关闭；重复 `runId` 直接返回 200 丢弃（防重试/超时兜底重复处理）。
- **runId ↔ 浏览器连接关联（A3）**：Java 侧以 `runId` 为 key 维护 Sink/注册表，把浏览器 SSE 连接与「回调到达 / 回调超时」信号关联；T16 据此实现，不得靠猜测。
- 失败回调：Java 写错误历史并发送浏览器 `business-error`。
- 回调 handler 不得调用 `userService.getLoginUser`（Python 无 session Cookie），仅校验 Bearer token；`AppController` 无类级 `@AuthCheck`，可直接挂载（A4）。

### 1.5 错误 / 超时 / 断连 / 首次判定

- **首次判定（M3）**：Python 侧以「`thread_id` 在 PostgreSQL 是否存在 checkpoint」判定是否用请求 `history` 做 bootstrap——存在则从 checkpoint 恢复并忽略 `history`，不存在则用 `history` 初始化。Java 每次请求都传 `history`，不做「首次」判断。
- 主通道在 `read-timeout-ms`（默认 300000）内既无事件也无回调 → Java 判定失败：浏览器 `business-error` + 按 `runId` 写一条错误历史（幂等）。
- **回调等待超时（H4）**：主通道 SSE 流结束后进入「等待回调」阶段，独立配置 `callback-timeout-ms`（默认 60000，新增键，T0 在 `PythonAgentProperties` 绑定）。回调到达与超时取先：超时未收到回调 → Java 判定失败：浏览器 `business-error` + 按 `runId` 写一条错误历史（幂等）；即使工作区已有部分产物也不自动构建（无法确认完整性），提示用户重试；迟到的成功回调因幂等被丢弃。
- 浏览器连接断开：Java 停止转发，但回调仍会触发构建与历史写入（后台完成），避免「文件已落盘但未构建」。
- Java 在发起新生成前**清空 `workspacePath`**，避免旧构建产物残留；Python 侧工作区写入采用「临时子目录 → 全部完成后原子 move 到 `workspacePath` 根」，失败则清理临时目录并发 `error` 事件。
- **工作区清理语义核对（A7）**：T21 前核对旧 Java 路径（`CodeGeneratorNode`/`BaseCodeFileSaver`）现有工作区清理行为；若与「发起新生成前清空」不一致，在切换验收中说明差异或统一，防止两路径重复生成行为漂移。

### 1.6 职责归属（B2 决策）

- **Python 负责**：模型调用、LangGraph 工作流、工具**执行**（文件写读改删等）、Guardrail、代码解析、工作区落盘、发出四类语义事件与文本块。
- **Java 负责**：浏览器侧展示文本重组、工具 `tool_request` 去重、聊天记录聚合、`{"d":…}` 封装与 `done`/`business-error` 收发、构建/部署。
- **决策理由**：工具展示文本格式（`BaseTool.generateToolRequestResponse`/`generateToolExecutedResult`）与去重/聚合逻辑已在 Java 侧生产验证；复用现有 handler 可把本方案最高风险（浏览器 SSE 行为兼容）压到最低。Python 只需保证 §1.3 的事件 JSON 与旧 `StreamMessage` schema 逐字段对齐（可逐字段断言验收）。
- 浏览器侧 wire（Java 原样负责，Python 不直接接触）：`data: {"d":"<显示文本>"}`（默认 message 事件）、`event: done`（构建完成后发出）、`event: business-error` + `data: {"error":true,"code":<code>,"message":"..."}`。

---

## §2 暂不做

- 不引入消息队列、任务中心、网关直连、mTLS、LiteLLM、跨地域高可用。
- 不把 Java 业务表迁移到 PostgreSQL。
- 不让 Python 直接访问 MySQL。
- 不把本地 demo launcher 当作生产 RPC 能力。
- 本阶段不改浏览器端 `AppChatPage.vue` 的事件消费逻辑（保持逐事件兼容）。

---

## §3 迁移范围组件清单（M1）

Python 侧需迁移并复刻以下根 `src` 组件（迁移后 Java 侧删除对应实现，但 **`ai/tools` 的展示格式与 `core/handler` 保留**）：

| 领域 | Java 源（迁移对象） |
|---|---|
| 代码生成服务 | `ai/codegen/HtmlCodeGenService`、`MultiFileCodeGenService`、`VueCodeGenService`、`AiCodeGenServiceExecutor`、`AiCodeGenServiceFactory`、`route/AiCodeGenTypeRoutingService(+Factory)`、`CodeGenType` |
| Guardrail | `ai/guardrail/PromptSafetyInputGuardrail` |
| 工作流 | `langgraph4j/CodeGenWorkflow`、`CodeGenConcurrentWorkflow`、`SimpleStatefulWorkflowApp` |
| 工作流节点 | `langgraph4j/node/RouterNode`、`PromptEnhancerNode`、`CodeGeneratorNode`、`CodeQualityCheckNode`、`ImageCollectorNode`、`ProjectBuilderNode`、`concurrent/*`（6 个图片节点） |
| 图片采集 / 质量检查 | `langgraph4j/ai/CodeQualityCheckService`、`ImageCollectionService`、`ImageCollectionPlanService`（各含 Factory） |
| 图片类工具 | `langgraph4j/tools/ImageSearchTool`、`LogoGeneratorTool`、`MermaidDiagramTool`、`UndrawIllustrationTool` |
| 文件类工具（执行） | `ai/tools/ProjectFileWriteTool`、`ProjectFileReadTool`、`ProjectFileModifyTool`、`ProjectFileDeleteTool`、`ProjectFileDirReadTool`、`ExitTool`、`ToolManager` |
| 事件/枚举/常量 | `ai/model/message/StreamMessage` 及 4 个子类（事件 schema 源）、`StreamMessageTypeEnum`、`CodeGenTypeEnum`、`AppConstant.CODE_OUTPUT_ROOT_DIR` |

> 明确不迁移：`core/handler/*`（展示重组留在 Java）、`ai/tools` 的 `generateToolRequestResponse`/`generateToolExecutedResult` 展示格式（留在 Java）、`Controller/Service 业务层`、`BuilderExecutor`（留在 Java）。

---

## §4 阶段与原子任务（H3）

> 状态列如实反映 2026-08-31 仓库现状；产出物为「文件路径 + 行为」。

### 阶段 1：契约与骨架（状态：**进行中**）

| # | 任务 | 产出物 | 依赖 |
|---|---|---|---|
| T0 | **恢复编译基线**：按 §1.1-§1.5 补 `config/PythonAgentProperties.java`（绑定 `python-agent` 段，含新增键 `callback-timeout-ms`）、`ai/python/PythonAgentRequest.java`（§1.2 字段）、`ai/python/PythonAgentClient.java`（WebClient，阶段 3 前可最小实现：`enabled` 时抛 `NotImplemented` 之外的明确错误）；保证 `./mvnw compile` 通过 | `…/config/PythonAgentProperties.java`、`…/ai/python/PythonAgentRequest.java`、`…/ai/python/PythonAgentClient.java` | 无 |
| T1 | `uv` 初始化子项目：`pyproject.toml`、`uv.lock`、目录骨架 `app/` | `paimeng-ai-code-agent/pyproject.toml`、`uv.lock` | 无 |
| T2 | 配置层（pydantic-settings）：读 `PYTHON_AGENT_TOKEN`、`WORKSPACE_ROOT`、`DATABASE_URL`、`JAVA_BASE_URL` 等；附 `.env.example` | `paimeng-ai-code-agent/app/config.py`、`.env.example` | T1 |
| T3 | FastAPI 应用：`/v1/agent/stream`（SSE）、`/healthz`、Bearer 令牌校验依赖 | `paimeng-ai-code-agent/app/main.py`、`app/api.py`、`app/auth.py` | T2 |
| T4 | Pydantic 请求/事件模型：§1.2 请求、§1.3 四类事件、§1.4 回调 | `paimeng-ai-code-agent/app/models.py` | T3 |
| T5 | PostgreSQL checkpointer：LangGraph `PostgresSaver` 装配 + `thread_id` 键约定（1.x 包路径 `langgraph.checkpoint.postgres`，具体 API 以官方文档为准，用 T19 的 checkpoint 恢复测试锁定用法，A8） | `paimeng-ai-code-agent/app/state.py` | T4 |

### 阶段 2：Agent 迁移（状态：**待办**）

| # | 任务 | 产出物 | 依赖 |
|---|---|---|---|
| T6 | 文件类 Tools 迁移（读/写/改/删/列目录/退出），**含工作区沙箱校验** | `paimeng-ai-code-agent/app/tools/file_tools.py` + 单测 | T4 |
| T7 | 代码生成服务迁移（html/multi_file/vue 三种 codeGenService + 路由） | `paimeng-ai-code-agent/app/services/codegen/…` + 单测 | T6 |
| T8 | 图片采集与质量检查服务迁移（对照 §3 清单） | `paimeng-ai-code-agent/app/services/images.py`、`app/services/quality.py` + 单测 | T7 |
| T9 | Guardrail 迁移 | `paimeng-ai-code-agent/app/guardrails.py` + 单测 | T7 |
| T10 | 代码解析与工作区写入（临时目录→原子 move，见 §1.5） | `paimeng-ai-code-agent/app/workspace.py` + 单测 | T6 |
| T11 | LangGraph 工作流编排（Router/PromptEnhancer/CodeGenerator/Quality/Image 节点接线） | `paimeng-ai-code-agent/app/graph.py` | T5、T7-T10 |
| T12 | SSE 流式输出适配：把工作流输出映射为 §1.3 事件 JSON（逐字段对齐旧 `StreamMessage`） | `paimeng-ai-code-agent/app/streaming.py` | T4、T11 |
| T13 | 完成回调客户端：工作流完成后按 §1.4 调用 Java 回调（`runId` 透传） | `paimeng-ai-code-agent/app/callback.py` | T4、T12 |

> 并行：T6-T7、T8、T9 相互独立（依赖 T4）；T10 依赖 T6；T11 等待 T5/T7-T10；T12/T13 串行在 T11 后。

### 阶段 3：Java 接入（状态：**待办**）

| # | 任务 | 产出物 | 依赖 |
|---|---|---|---|
| T14a | **录制浏览器事件基线快照（A6）**：**必须在 T15/T17 改动 `AppServiceImpl` 之前**完成；用 §5 阶段 3 的 `curl -N` 命令对 `html/multi_file/vue_project` 三类各录一次浏览器事件序列 | `docs/py_agent/sse_baseline.snapshot` | T0 |
| T14 | 完善 `PythonAgentClient`：WebClient POST `/v1/agent/stream` + SSE 解码 + Bearer 头 | `…/ai/python/PythonAgentClient.java` | T0 |
| T15 | 事件适配：把 Python SSE 事件分流到现有 `JsonMessageStreamHandler`（vue_project）/`SimpleTextStreamHandler`（html/multi_file），复用 §1.6 决策 | `…/ai/python/PythonAgentSseAdapter.java` | T14 |
| T16 | 完成回调 endpoint + `runId` 幂等 + `callback-timeout-ms` 超时兜底（首次：写历史→构建→浏览器 done；超时→business-error） | `…/controller/AppController.java`（新增 `/app/chat/gen/code/callback`，对外全路径 `/api/app/chat/gen/code/callback`） | T14 |
| T17 | 错误/超时映射：`read-timeout-ms` 超时、`error` 事件、失败回调 → 浏览器 `business-error` + 幂等历史 | `…/service/impl/AppServiceImpl.java` | T15、T16 |
| T18 | 灰度开关校验：`python-agent.enabled=false` 走旧链路（行为不变）；`true` 走 Python 链路 | `…/service/impl/AppServiceImpl.java` | T17 |

### 阶段 4：验证切换（状态：**待办**）

| # | 任务 | 产出物 | 依赖 |
|---|---|---|---|
| T19 | Python 侧 pytest：契约、SSE wire、工具行为、checkpoint 恢复、工作区、端到端（命令见 §5） | `paimeng-ai-code-agent/tests/…` | T5-T13 |
| T20 | 逐事件比较：用 T14a 已录快照 vs Python 链路事件序列，diff 为空（命令见 §5） | `docs/py_agent/sse_baseline.py`（比较脚本） | T18 |
| T21 | 开发环境切 Python 灰度；稳定期满（定义见 §5）删除旧 AI 实现并全量回归 | 删除 `ai/codegen`、`langgraph4j` 等（保留 `ai/tools` 展示格式与 `core/handler`） | T19、T20 |

---

## §5 验收标准（H2）

可执行命令与断言（按阶段）：

- **阶段 1**
  - `./mvnw compile` 通过（T0）。
  - `cd paimeng-ai-code-agent && uv sync && uv run pytest -m contract` 全绿（T3-T5）。
  - `curl -s http://localhost:8090/healthz` 返回 200 且含 `"status":"ok"`；不带 `Authorization` 调 `/v1/agent/stream` 返回 401。
- **阶段 2**
  - `cd paimeng-ai-code-agent && uv run pytest` 全绿（T6-T13 单测）。
  - 离线工作流端到端：给定 `message` + 空 `history`，用**固定夹具快照**（`paimeng-ai-code-agent/tests/fixtures/` 下的 golden 文件清单/关键内容片段）断言产出工作区文件，不依赖在线模型（LLM 非确定性导致「与旧实现 tree 一致」不可复现，M6）。
- **阶段 3**
  - `./mvnw compile` 与 `./mvnw test -Dtest=AppServiceImplTest`（若存在）全绿。
  - `python-agent.enabled=false`：`curl -N -b <cookie> "http://localhost:8123/api/app/chat/gen/code?appId=1&message=test"` 事件序列与迁移前基线完全一致。
  - `python-agent.enabled=true`：同命令事件序列与基线逐事件一致（T20 脚本自动比较，diff 为空；基线快照由 T14a 录制）。
  - 边界用例：空 `message` → 400（`PARAMS_ERROR`）；超长 `message`（>5000 字）→ 400/413 按现有 `ErrorCode` 约定；Python 进程停掉时 → 浏览器 `business-error` 且历史记录一条错误；同 `runId` 重复回调 → 不重复写历史/构建；**mock Python 发完文本后不发回调 → 浏览器在 `callback-timeout-ms` 内收到 `business-error` 而非挂起，且迟到成功回调被幂等丢弃（H4）**。
- **阶段 4**
  - `uv run pytest` 全绿（含 checkpoint 恢复：同一 `thread_id` 第二次请求不重复 bootstrap）。
  - 「稳定」定义：**开发环境灰度 ≥7 天、T19/T20 回归全绿、无 P0/P1 缺陷**后，才执行删除旧 AI 实现（T21）。

---

## §6 风险与陷阱（M2/M3 + B2 落实）

- **[B2] 最高风险 = 浏览器 SSE 行为兼容**：由 §1.6 决策（Java 复用现有 handler + §1.3 事件 JSON 逐字段对齐 + T20 逐事件基线比较）闭环；禁止在 Python 侧自行发明事件格式。
- **[M3] checkpoint 首次判定**：Python 侧以「`thread_id` 在 PostgreSQL 是否存在 checkpoint」判定是否用请求 `history` bootstrap；Java 每次都传 `history`，不做「首次」判断。
- **[M2] 依赖环境坑**：已记录 FastAPI 0.115 与 Starlette 1.0 不兼容（pytest 收集被阻断）。规避：`pyproject.toml` 锁定 `fastapi` 与 `starlette` 为 `pip check` 全绿的组合（二选一：锁 `starlette<1.0`，或升级 `fastapi` 至支持 Starlette 1.0 的版本），以 `uv.lock` 固定，保证可复现。
- **工作区并发**：同一 `appId` 的并发请求会争抢 `tmp/code_output/{codeGenType}_{appId}`；Java 侧按 `appId` 串行化（复用现有限流/并发控制），Python 侧工作区写入必须原子（§1.5）。
- **runId 幂等**：回调、错误历史、构建三处均以 `runId` 去重（§1.4/§1.5）。

---

## §7 参考资料（M5）

**必读（开工前）**
- `AGENTS.md` / `CONTEXT.md`：项目约定与背景
- `sql/create_table.sql`：`chat_history` 表结构
- `src/main/java/com/zdan/paimengaicodemother/constant/AppConstant.java`、`ai/enums/CodeGenTypeEnum.java`、`ai/model/message/StreamMessage.java`（及 4 个子类）：§1 契约的字段源
- `src/main/java/com/zdan/paimengaicodemother/core/handler/JsonMessageStreamHandler.java`、`SimpleTextStreamHandler.java`、`StreamHandlerExecutor.java`：Java 侧复用逻辑
- `src/main/java/com/zdan/paimengaicodemother/controller/AppController.java`：浏览器 SSE 封装与 `/chat/gen/code`
- `src/main/java/com/zdan/paimengaicodemother/service/impl/AppServiceImpl.java`：Python 分支参考（bootstrap、runId、回调时序）
- `paimeng-ai-code-mother-frontend/src/pages/app/AppChatPage.vue`（L478-582）：浏览器端事件消费基线
- `docs/py_agent/findings.md`：现状事实（已逐条核对，全部真实）

**迁移对照**
- `src/main/java/com/zdan/paimengaicodemother/ai/`（codegen、guardrail、model、tools）
- `src/main/java/com/zdan/paimengaicodemother/langgraph4j/`（workflow、ai、node、tools、state）
- `src/main/resources/application.yml`：`python-agent` 配置段

**提交与注释约束（A1）**
- 提交信息遵循 `AGENTS.md` 的「Git 提交」约定：Agent 代理提交时携带 `<Agent IDE>/<用户信息>` 信息。
- 注释遵循项目 `project-comment-style` skill（类级/方法级 Javadoc，中文注释）。

---

## §8 依赖锁定（M2）

- 统一用 `uv`（`pyproject.toml` + `uv.lock` 提交入库），不使用全局 pip 环境。
- 禁止写「最新稳定版」；每个直接依赖给出下限/兼容约束，最终以 `uv.lock` 固定。
- 已知约束：FastAPI ↔ Starlette 必须 `pip check` 全绿（规避 FastAPI 0.115 / Starlette 1.0 不兼容）。
- Python 3.13；LangGraph 使用带 PostgreSQL checkpoint 的 1.x 稳定线；Pydantic 2.x。
- 本地被破坏的全局环境不影响子项目：`uv venv` 独立创建，`uv run` 进入。

## §9 运行与部署（M4）

- **开发**：`cd paimeng-ai-code-agent && uv sync && cp .env.example .env`；`.env` 键：`PYTHON_AGENT_TOKEN`、`WORKSPACE_ROOT`（默认 `{repo}/tmp/code_output`）、`DATABASE_URL`（PostgreSQL DSN）、`JAVA_BASE_URL`、`MODEL_API_KEY` 等；启动 `uv run uvicorn app.main:app --port 8090`。
- **生产**：容器镜像 + 环境变量/Secret Manager 注入（键名同上）；健康检查挂探针（`/healthz`）。
- **共享工作区**：Java 与 Python 同机或同容器卷，挂载点保证 Python 看到的 `WORKSPACE_ROOT` 与 Java `CODE_OUTPUT_ROOT_DIR`（`user.dir/tmp/code_output`）为同一绝对路径；异机部署必须将 `tmp/code_output` 挂到共享卷。

## §10 核心逻辑示意（A2）

Python 端 streaming 适配（伪代码）：

```python
# app/streaming.py —— 把工作流事件映射为 §1.3 事件 JSON
async def stream_events(graph, config, code_gen_type, emit):
    if code_gen_type == "vue_project":        # 四类结构化事件
        for chunk in graph.astream_events(...):
            for ev in normalize(chunk):        # -> ai_response/ai_thinking/tool_request/tool_executed
                yield f"data: {ev.model_dump_json()}\n\n"
    else:                                      # html / multi_file 纯文本
        for text in graph.astream(...):
            yield f"data: {text}\n\n"
```

Java 端事件分流（伪代码）：

```java
// PythonAgentSseAdapter：复用现有 handler，保持浏览器行为不变
Flux<String> display = codeGenType.getBuildType() == BuildTypeEnum.NPM
        ? jsonHandler.handle(pythonSse.map(ev -> ev.toStreamMessageJson()), historySvc, appId, user)
        : textHandler.handle(pythonSse.map(ev -> ev.text()), historySvc, appId, user);
```

---

## 修订自检

重跑八要素确认原阻塞/高问题已消除：
- B1（缺契约）→ §1 全量补齐（通道/请求/事件 schema/回调/超时/鉴权）。
- B2（两协议混同、重组归属未定）→ §1.6 明确决策：Python 发四类事件、Java 复用现有 handler 做展示重组与去重。
- H1（状态与仓库不符）→ §「当前仓库基线」如实标注 + §4 状态列如实 + `progress.md` 修订。
- H2（验收不可判定）→ §5 全部给可执行命令/断言 + 「稳定」量化。
- H3（任务非原子）→ §4 拆 T0-T21，含产出物与依赖。
- M1-M5/A1/A2 → §3 组件清单、§6/§8 依赖与风险、§1.5 首次判定、§9 运行部署、§7 参考、§10 示意。

第 2 轮审查新增项（全部落实）：
- H4（回调等待超时）→ §1.5 新增 `callback-timeout-ms`（默认 60000，T0 绑定、T16 落地）+ §5 阶段 3 验收用例。
- M6（离线端到端断言不可复现）→ §5 阶段 2 改固定夹具快照。
- A3 → §1.4 runId↔浏览器连接关联机制；A4 → §1.4 回调 handler 不取 session；A5 → §1.3 SSE 序列化约定；A6 → §4 新增 T14a 提前录制基线；A7 → §1.5 工作区清理语义核对；A8 → §4-T5 PostgresSaver 用法锁定；A9 → §1.4 回调 status 校验。
