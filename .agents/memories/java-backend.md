# 记忆：Java 后端

> Java Spring Boot 侧的工作记忆。目标架构中 Java 的职责与边界见 `docs/ts_agent/architecture.md`；历史契约细节见 `docs/py_agent/task_plan.md` §1.6/§7 与 `AGENTS.md`。

## 当前状态（2026-09-03 退役决策后核对）

| 项 | 状态 |
|---|---|
| `./mvnw compile` | **通过**（需 JDK 21；本机 sdkman 已装 `21.0.12+1.1-tem`，当前 JDK 17 会报 `release version 21 not supported`） |
| `ai/python/` | `PythonAgentProperties`/`PythonAgentClient`/`PythonAgentRequest` 存在；**将泛化为通用 Agent 客户端**（`python-agent.*` → `agent.*` 配置段，指向 TS Agent） |
| `AppServiceImpl` | T18 已含 `python-agent.enabled` 分支；本地 `application-local.yml` 已回切 `enabled: false`（**P0 已执行 2026-09-03**，旧 Java AI 为过渡主链路） |
| `application.yml` `python-agent` 段 | `enabled/base-url/token/connect-timeout-ms/read-timeout-ms` + `callback-timeout-ms`（默认 60000） |
| 旧 AI 链路 `ai/` + `langgraph4j/` | 完整存在（**过渡期主链路**；TS Agent 契约对等后按 `docs/py_agent/t21_delete_plan.md` 删除，门禁已重定向） |

## 2026-09-03 架构定稿中对 Java 的新增职责

- **签发短时 JWT**（前端 fetch-SSE 直连 TS Agent 用，Agent 离线验签，不回查 Java）。
- **积分体系**：预冻结 → 结算 → 退款，挂 runId 幂等（复用 `RunIdSinkRegistry` 机制）；按次 + 档位系数计费；MVP 后台手动充值。
- **Agent→Java 内部回调**沿用 `/api/app/chat/gen/code/callback`（Bearer + runId 幂等）：结算积分 / 写历史 / 触发构建。

## 编译红线

- **JDK 21 是硬要求**（`<java.version>21</java.version>`）：用 `JAVA_HOME=/home/zdan/.sdkman/candidates/java/current`（sdkman 默认已切到 21）执行 `./mvnw compile`。
- T0 已落地：`config/PythonAgentProperties.java`（含 `callback-timeout-ms`）、`ai/python/PythonAgentRequest.java`（§1.2 字段 + `HistoryItem`）、`ai/python/PythonAgentClient.java`（WebClient，`health()` 可用；`stream()` 阶段 3 前抛明确 BusinessException）。
- T18 起 `AppServiceImpl` 的 `pythonChatToGenCode` 分支已调用 `PythonAgentClient.stream()`；P0（2026-09-03）回切后该分支关闭（enabled=false），代码保留待 T21 泛化处置。

## 关键事实（实现时直接依赖）

- `AppConstant.CODE_OUTPUT_ROOT_DIR = System.getProperty("user.dir") + "/tmp/code_output"`。
- `CodeGenTypeEnum`：`html` / `multi_file` / `vue_project`；`StreamMessageTypeEnum`：四类事件。
- 浏览器 SSE wire（Java 独占）：`data: {"d":"<文本>"}`（默认 message 事件）、`event: done`（构建后）、`event: business-error`。
- `AppController` 无类级 `@AuthCheck`；回调 endpoint `/api/app/chat/gen/code/callback` 只校验 Bearer token。
- 工具展示重组：复用 `ToolManager.generateToolRequestResponse` / `generateToolExecutedResult`（在 Java 侧，不迁移）。

## 约定

- 包结构 `com.zdan.paimengaicodemother.*`（`ai`/`controller`/`service`/`mapper`/`config`）；遵循阿里巴巴 Java 开发手册。
- 提交遵循 `AGENTS.md` 的「Git 提交」约定（Agent 代理提交时携带 `<Agent IDE>/<用户信息>`）；注释遵循 `project-comment-style` skill。
