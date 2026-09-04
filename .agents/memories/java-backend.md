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

## 2026-09-04 generation_run 内部 API（Issue #4 已落地）

- **表**：`sql/create_table.sql` 新增 `generation_run`（run_id varchar PK 复用 runId 语义、appId/userId、phase 显式 MySQL ENUM 九值、context/milestones/tokenUsage JSON、creditLedgerRef 预留、startedTime/finishedTime）；索引 idx_appId_phase / idx_userId。**列名按项目既有约定用 camelCase**（user/app/chat_history 均为 camelCase；架构文档 §3.2 的 snake_case 为设计层命名，实现落 camelCase 并在此记录）。
- **端点**（`GenerationRunController`，`/api/internal/*`，Bearer 服务令牌，配置 `internal-api.token`/`INTERNAL_API_TOKEN`）：
  - `POST /internal/runs` 创建（同 runId 幂等返回既有；同 app 非终态并发 → **409**「当前有进行中的任务」）
  - `PATCH /internal/runs/{runId}` 推进 phase/context/milestones/tokenUsage（无变化不落库；进终态自动补 finished_time）
  - `GET /internal/runs/{runId}`、`GET /internal/apps/{appId}/runs/latest-nonterminal?userId=`（断点续传查询）
- **错误码 → HTTP**：控制器内 `@ExceptionHandler` 覆盖全局 advice 的 200 返回：无/错 Bearer→401、并发→409、参数→400、不存在→404（TS 客户端依赖真实状态码）。
- **服务**：`GenerationRunServiceImpl` 每 app 一把锁（`ConcurrentHashMap`）串行化幂等检查+并发检查+落库（单实例成立）；JSON 字段校验（hutool JSONUtil）。
- **测试**：service 12 例（mock mapper，`ReflectionTestUtils.setField(mapper)`）+ controller 7 例（standalone MockMvc，**不用 @WebMvcTest**——其会扫描 mapper 需 sqlSessionFactory 导致上下文加载失败）。

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
- MyBatis Flex 代码生成：`com.zdan.paimengaicodemother.generator` 包生成器，产出 mapper XML 在 `src/main/resources/mapper/`。
- 提交遵循 `AGENTS.md` 的「Git 提交」约定（Agent 代理提交时携带 `<Agent IDE>/<用户信息>`）；注释遵循 `project-comment-style` skill。
