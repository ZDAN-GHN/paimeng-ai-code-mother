# 记忆：Java 后端

> Java Spring Boot 侧的工作记忆。目标架构中 Java 的职责与边界见 `docs/ts_agent/architecture.md`；历史契约细节见 `docs/py_agent/task_plan.md` §1.6/§7 与 `AGENTS.md`。

## 当前状态（2026-09-03 退役决策后核对）

| 项 | 状态 |
|---|---|
| `./mvnw compile` | **通过**（需 JDK 21；本机 sdkman 已装 `21.0.12+1.1-tem`，当前 JDK 17 会报 `release version 21 not supported`） |
| `ai/agent/`（原 `ai/python/`，**#6 已泛化**） | `AgentProperties`/`AgentClient`/`AgentSseAdapter`/`AgentRequest`/`AgentCallbackRequest`/`RunIdSinkRegistry`（`agent.*` 配置段，`python-agent.*` 为别名） |
| `AppServiceImpl` | T18 已含 `agent.enabled` 分支（开关变量由 `pythonAgentProperties` 改名 `agentProperties`，语义等价）；本地 `application-local.yml` 已回切 `enabled: false`（**P0 已执行 2026-09-03**，旧 Java AI 为过渡主链路） |
| `application.yml` `python-agent` 段 | 保留作旧别名（expand-contract）：`enabled/base-url/token/connect-timeout-ms/read-timeout-ms/callback-timeout-ms`；`AgentLegacyAliasPostProcessor` 自动复制到 `agent.*`（新键显式设置时不覆盖） |
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

## 2026-09-04 Agent 完成回调（Issue #6 已落地）

- **`POST /internal/agent/runs/{runId}/complete`**（`GenerationRunController`，Bearer 服务令牌 `internal-api.token`，无/错→401）：`GenerationRunService.completeRun(runId, AgentCompleteRequest)`——写本次对话历史（messages user/ai 按序落 `chat_history`）+ success 触发构建。
- **请求体** `AgentCompleteRequest`：`appId`/`userId`（**字符串传输，防 JS 精度丢失**）/`status`(success|failed)/`messages[{messageType,content}]`/`workspacePath`/`errorMessage`。`codeGenType` 由 Java 按 appId 查 app 表（TS Agent 不传，避免契约冗余）。
- **幂等**：`GenerationRunServiceImpl` 内存 `completedRunIds`（ConcurrentHashMap.newKeySet），同 runId 只处理一次，重复回调返回 200 丢弃（单机部署成立；重启丢失由「先 createRun 后回调」时序兜底）。
- **行为**：success → 写 messages + `BuilderExecutor.doBuild(codeGenType, workspacePath)`（构建管线不变，产物落工作区）；failed → 写一条错误历史「生成失败：{errorMessage}」，不构建。
- **配置别名**：`agent.*` 为新标准，`python-agent.*` 经 `AgentLegacyAliasPostProcessor`（EnvironmentPostProcessor，注册于 `META-INF/spring.factories`）复制为别名；`application.yml` 保留 `python-agent` 段作旧别名。
- **测试**：`GenerationRunServiceImplTest` 18 例（+completeRun 幂等/成功/失败/校验 6 例）、`GenerationRunControllerTest` 11 例（+401/200/400 4 例）、`AgentLegacyAliasPostProcessorTest` 3 例、`AgentClientTest` 5、`AgentSseAdapterTest` 3、`RunIdSinkRegistryTest` 6。

## 2026-09-07 双源图片搜索（素材库 + 全网热词）

- **决策（用户拍板）**：双源并存且工具切分——`ImageSearchTool.searchContentImages`（Pexels，素材库语料，版权清晰）与 `WebImageSearchTool.searchWebImages`（SearXNG 自建聚合，覆盖游戏/动漫/品牌等素材库永远没有的热词，**版权不确定仅预览用途**）。根因认知：Pexels 相关度差是语料基因问题（热词内容不存在），非提示词可修。
- **实现**：`WebImageSearchTool` 调 `GET {searxng.base-url:http://127.0.0.1:8888}/search?categories=images&format=json`（端口 8888，避开 Tomcat/Spring Boot 默认的 8080），取 `results[].img_src`/`title` 映射 `ImageResource(CONTENT)`，软失败返回空列表；`ImageCollectionPlan` 新增 `webImageTasks`（复用 `ImageSearchTask` record）；串行流 `ImageCollectorNode`、并发流 `WebImageCollectorNode`（`WorkflowContext.webImages` → `ImageAggregatorNode` 聚合）、`ImageCollectionServiceFactory.tools(...)` 注册；两份图片收集提示词已加双源路由规则（通用内容→contentImageTasks，热词→webImageTasks）。SearXNG 服务见 `deployment.md`。
- **测试**：`WebImageSearchToolTest` 为独立单测（`ReflectionTestUtils` 注入 base-url，SearXNG 未启动自动跳过）——**不用 @SpringBootTest**：上下文启动被待恢复配置阻塞（见踩坑）。原神实测 8 张全链路通过（含米哈游官网图/角色立绘）。

## 2026-09-07 上下文启动潜伏 bug（实测发现）

- **AiCodeGenServiceFactory 弃用注入链路（0f3cdba 引入）**：构造器注入单例 `StreamingChatModel` 但存在 chat/reasoning 两个 prototype bean → `NoUniqueBeanDefinitionException`，上下文起不来。该字段自注释标弃用后仅喂给零调用方的 `@Deprecated createAiCodeGenService(clazz)`；已删字段/构造参数，弃用方法改为仅 chatModel（活路径按名 `SpringContextUtil.getBean("chat|reasoningStreamingChatModelPrototype")` 取 prototype，不受影响）。
- **`application-local.yml` 曾含 `spring.profiles.active: local`**：profile 专属文件禁止声明该键，`InvalidConfigDataPropertyException`；已删（该文件 gitignore 不入提交，注意旧环境文件可能同病）。
- **`ImageSearchTool` 的 `pexels.api-key` 改为空默认 `${pexels.api-key:}`**（与 `siliconflow.api-key` 一致）：key 未恢复不再阻塞启动，工具本就软失败。
- **仍未修（属配置恢复任务）**：`CosClientConfig` 是 `@ConditionalOnProperty`（cos.client.* 缺失即无 bean）而 `ScreenshotServiceImpl` 硬依赖 `CosManager` → **key 恢复前所有 @SpringBootTest 无法启动**；langchain4j 模型 key 同样待恢复。



## 编译红线

- **JDK 21 是硬要求**（`<java.version>21</java.version>`）：原生 Linux 宿主经 SDKMAN 管理（2026-09-07 起与旧 WSL 一致），`JAVA_HOME=~/.sdkman/candidates/java/current` 执行 `./mvnw compile`；当前版本 `21.0.12+1.1-tem`（Temurin LTS）。
- **构建产物目录（2026-09-04）**：`pom.xml` 暴露 `maven.build.directory` 属性（默认 `${project.basedir}/target`），`<build><directory>` 引用它。WSL 运行时环境统一放 `wsl-rt-env/`（不建软链），命令带 `-Dmaven.build.directory=$PWD/wsl-rt-env/java/target`；Windows/IDE 不传该属性则用默认 `target/`。⚠️ **不要用 `-Dproject.build.directory` 覆盖**——那是模型派生属性，部分插件（surefire 等）不认，会重建根 `target/`（实测 2026-09-04）。
- T0 已落地：`config/PythonAgentProperties.java`（含 `callback-timeout-ms`）、`ai/python/PythonAgentRequest.java`（§1.2 字段 + `HistoryItem`）、`ai/python/PythonAgentClient.java`（WebClient，`health()` 可用；`stream()` 阶段 3 前抛明确 BusinessException）。
- T18 起 `AppServiceImpl` 的 `pythonChatToGenCode` 分支已调用 `PythonAgentClient.stream()`；P0（2026-09-03）回切后该分支关闭（enabled=false），代码保留待 T21 泛化处置。

## 关键事实（实现时直接依赖）

- `AppConstant.CODE_OUTPUT_ROOT_DIR = System.getProperty("user.dir") + "/tmp/code_output"`。
- `CodeGenTypeEnum`：`html` / `multi_file` / `vue_project`；`StreamMessageTypeEnum`：四类事件。
- 浏览器 SSE wire（Java 独占）：`data: {"d":"<文本>"}`（默认 message 事件）、`event: done`（构建后）、`event: business-error`。
- `AppController` 无类级 `@AuthCheck`；回调 endpoint `/api/app/chat/gen/code/callback` 只校验 Bearer token。
- 工具展示重组：复用 `ToolManager.generateToolRequestResponse` / `generateToolExecutedResult`（在 Java 侧，不迁移）。
- **Logo 图片生成后端（2026-09-07 切换）**：`LogoGeneratorTool` 走硅基流动 REST（`POST https://api.siliconflow.cn/v1/images/generations`，模型 `Kwai-Kolors/Kolors`，官方定价页标注免费），`dashscope-sdk-java` 已从 pom 移除；配置键 `siliconflow.api-key` / `siliconflow.image-model`（本地配置未填 key 时接口调用失败、工具返回空列表不阻塞主流程）。⚠️ 官方返回图片 url 有效期仅一小时，下游需及时消费。接口文档：https://api-docs.siliconflow.cn/docs/api/images-generations-post

## 约定

- 包结构 `com.zdan.paimengaicodemother.*`（`ai`/`controller`/`service`/`mapper`/`config`）；遵循阿里巴巴 Java 开发手册。
- MyBatis Flex 代码生成：`com.zdan.paimengaicodemother.generator` 包生成器，产出 mapper XML 在 `src/main/resources/mapper/`。
- 提交遵循 `AGENTS.md` 的「Git 提交」约定（Agent 代理提交时携带 `<Agent IDE>/<用户信息>`）；注释遵循 `project-comment-style` skill。
