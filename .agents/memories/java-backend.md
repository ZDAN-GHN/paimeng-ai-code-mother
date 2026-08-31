# 记忆：Java 后端

> Java Spring Boot 侧的工作记忆。权威细节见 `docs/py_agent/task_plan.md` §1.6/§7 与 `AGENTS.md`。

## 当前状态（2026-08-31 核对）

| 项 | 状态 |
|---|---|
| `./mvnw compile` | **不通过**（T0 待办） |
| `ai/python/` | 空目录，`PythonAgentProperties`/`PythonAgentClient`/`PythonAgentRequest` 缺失 |
| `AppServiceImpl` | 已引用上述缺失类（迁移残留） |
| `application.yml` `python-agent` 段 | 已存在（未提交）：`enabled/base-url/token/connect-timeout-ms/read-timeout-ms`；`callback-timeout-ms` 待 T0 新增 |
| 旧 AI 链路 `ai/` + `langgraph4j/` | 完整存在（迁移对象，`task_plan.md` §3 清单） |

## 编译红线

- 任何阶段的第一个任务都必须保证 `./mvnw compile` 通过；当前第一步是 **T0**：补 `config/PythonAgentProperties.java`（含 `callback-timeout-ms`）、`ai/python/PythonAgentRequest.java`、`ai/python/PythonAgentClient.java`。

## 关键事实（实现时直接依赖）

- `AppConstant.CODE_OUTPUT_ROOT_DIR = System.getProperty("user.dir") + "/tmp/code_output"`。
- `CodeGenTypeEnum`：`html` / `multi_file` / `vue_project`；`StreamMessageTypeEnum`：四类事件。
- 浏览器 SSE wire（Java 独占）：`data: {"d":"<文本>"}`（默认 message 事件）、`event: done`（构建后）、`event: business-error`。
- `AppController` 无类级 `@AuthCheck`；回调 endpoint `/api/app/chat/gen/code/callback` 只校验 Bearer token。
- 工具展示重组：复用 `ToolManager.generateToolRequestResponse` / `generateToolExecutedResult`（在 Java 侧，不迁移）。

## 约定

- 包结构 `com.zdan.paimengaicodemother.*`（`ai`/`controller`/`service`/`mapper`/`config`）；遵循阿里巴巴 Java 开发手册。
- 提交遵循 `AGENTS.md` 的「Git 提交」约定（Agent 代理提交时携带 `<Agent IDE>/<用户信息>`）；注释遵循 `project-comment-style` skill。
