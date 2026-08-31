# 记忆：Java 后端

> Java Spring Boot 侧的工作记忆。权威细节见 `docs/py_agent/task_plan.md` §1.6/§7 与 `AGENTS.md`。

## 当前状态（2026-08-31 T0 完成核对）

| 项 | 状态 |
|---|---|
| `./mvnw compile` | **通过**（需 JDK 21；本机 sdkman 已装 `21.0.12+1.1-tem`，当前 JDK 17 会报 `release version 21 not supported`） |
| `ai/python/` | `PythonAgentProperties`/`PythonAgentClient`/`PythonAgentRequest` 已创建（T0 完成） |
| `AppServiceImpl` | **无** Python 分支引用（此前迁移残留已随提交清除，当前走旧 Java AI 链路） |
| `application.yml` `python-agent` 段 | `enabled/base-url/token/connect-timeout-ms/read-timeout-ms` + **新增 `callback-timeout-ms`**（默认 60000） |
| 旧 AI 链路 `ai/` + `langgraph4j/` | 完整存在（迁移对象，`task_plan.md` §3 清单） |

## 编译红线

- **JDK 21 是硬要求**（`<java.version>21</java.version>`）：用 `JAVA_HOME=/home/zdan/.sdkman/candidates/java/current`（sdkman 默认已切到 21）执行 `./mvnw compile`。
- T0 已落地：`config/PythonAgentProperties.java`（含 `callback-timeout-ms`）、`ai/python/PythonAgentRequest.java`（§1.2 字段 + `HistoryItem`）、`ai/python/PythonAgentClient.java`（WebClient，`health()` 可用；`stream()` 阶段 3 前抛明确 BusinessException）。
- `PythonAgentClient.stream()` 尚未被任何业务代码调用（`AppServiceImpl` 无 Python 分支），阶段 3（T14-T18）再接。

## 关键事实（实现时直接依赖）

- `AppConstant.CODE_OUTPUT_ROOT_DIR = System.getProperty("user.dir") + "/tmp/code_output"`。
- `CodeGenTypeEnum`：`html` / `multi_file` / `vue_project`；`StreamMessageTypeEnum`：四类事件。
- 浏览器 SSE wire（Java 独占）：`data: {"d":"<文本>"}`（默认 message 事件）、`event: done`（构建后）、`event: business-error`。
- `AppController` 无类级 `@AuthCheck`；回调 endpoint `/api/app/chat/gen/code/callback` 只校验 Bearer token。
- 工具展示重组：复用 `ToolManager.generateToolRequestResponse` / `generateToolExecutedResult`（在 Java 侧，不迁移）。

## 约定

- 包结构 `com.zdan.paimengaicodemother.*`（`ai`/`controller`/`service`/`mapper`/`config`）；遵循阿里巴巴 Java 开发手册。
- 提交遵循 `AGENTS.md` 的「Git 提交」约定（Agent 代理提交时携带 `<Agent IDE>/<用户信息>`）；注释遵循 `project-comment-style` skill。
