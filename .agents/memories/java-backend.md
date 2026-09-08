# 记忆：Java 后端

> Java Spring Boot 侧的工作记忆。目标架构职责与边界见 `docs/ts_agent/architecture.md`；历史契约见 `docs/py_agent/task_plan.md` §1.6/§7；逐票实现细节与测试证据见 `docs/ts_agent/progress.md`。

## 当前状态

| 项 | 状态 |
|---|---|
| `./mvnw compile` | **通过**（需 JDK 21；本机 sdkman `21.0.12+1-1-tem`，JDK 17 报 `release version 21 not supported`） |
| `ai/agent/`（原 `ai/python/`，#6 泛化，旧类已删） | `AgentProperties`/`AgentClient`/`AgentSseAdapter`/`AgentRequest`/`AgentCallbackRequest`/`RunIdSinkRegistry`（`agent.*` 配置段；`python-agent.*` 经 `AgentLegacyAliasPostProcessor`（EnvironmentPostProcessor，注册于 `META-INF/spring.factories`）保留别名，新键显式设置时不覆盖） |
| `AppServiceImpl` | 含 `agent.enabled` 分支；本地 `application-local.yml` 已回切 `enabled: false`（P0，2026-09-03，旧 Java AI 为过渡主链路） |
| 旧 AI 链路 `ai/` + `langgraph4j/` | 完整存在（过渡期回退主链路；T21 按删除范围 `docs/py_agent/t21_delete_plan.md` 处置，门禁已重定向为「契约对等 + 回归全绿」） |

## 核心机制（均已落地并测试全绿，细节与例数见 progress.md 对应票）

- **generation_run 内部 API（#4）**：表 DDL 在 `sql/create_table.sql`（run_id varchar PK、phase 显式 MySQL ENUM 九值、context/milestones/tokenUsage JSON；**列名按项目既有约定 camelCase**，架构文档 §3.2 的 snake_case 为设计层命名）。`GenerationRunController`（`/api/internal/*`，Bearer `internal-api.token`/`INTERNAL_API_TOKEN`）：createRun（同 runId 幂等返回既有；同 app 非终态并发→**409**「当前有进行中的任务」）、updateRun（无变化不落库，进终态补 finished_time）、getRun、latest-nonterminal（断点续传查询）。错误码→HTTP 由控制器内 `@ExceptionHandler` 覆盖全局 advice（无/错 Bearer→401、并发→409、参数→400、不存在→404，TS 客户端依赖真实状态码）；service 每 app 一把 `ConcurrentHashMap` 锁串行化幂等+并发+落库（单实例成立）。
- **完成回调（#6）**：`POST /internal/agent/runs/{runId}/complete`——写本次对话历史（messages user/ai 按序落 `chat_history`）+ success 触发 `BuilderExecutor.doBuild`（构建管线不变）；failed 写一条错误历史不构建。请求体 appId/userId **字符串传输防 JS 精度丢失**，codeGenType 由 Java 按 appId 查 app 表；runId 内存幂等（重复回调 200 丢弃，重启丢失由「先 createRun 后回调」时序兜底）。
- **Agent JWT 签发（#12）**：`GET /app/agent/token?appId=`（登录校验 + 应用归属校验「无权限生成代码」+ codeGenType 校验；**workspacePath 由 Java 计算** `CODE_OUTPUT_ROOT_DIR/{codeGenType}_{appId}`，浏览器不感知服务器布局）。`AgentJwtService`（hutool JWT HS256，`sub`=字符串 userId、`iat`/`exp` 整秒同一时基，空密钥拒签）配置 `agent.jwt.*`（secret/ttl-minutes 默认 10），密钥与 TS Agent `JWT_SECRET` 同值（均不提交）。⚠️ 响应 Long/expiresAt 全字符串序列化（前端解析按字符串）；hutool `JWTValidator.validateDate` 过期抛 `cn.hutool.core.exceptions.ValidateException`（非 JWTException）。
- **积分协议（#10）**：credit_ledger 三态台账（冻结→结算/部分退款/全额退款，uk_runId 幂等，同库同事务）+ user.credits 余额 + 管理员充值；冻结时点 = 确认线框进入 codegen（余额不足 402 拒绝）；冻结额 = 基础价 100 × 类型系数 × 档位系数（`calcFrozenAmount` 四舍五入落整数）；**定价（2026-09-08 用户反馈驱动）：fast=0.5 / standard=1 / deep=2**（快速半价折扣，系数改 double）。

## 双源图片搜索（2026-09-07）

- **决策（用户拍板）**：`ImageSearchTool.searchContentImages`（Pexels 素材库，版权清晰）与 `WebImageSearchTool.searchWebImages`（SearXNG 自建聚合，覆盖热词，**版权不确定仅预览用途**）双源并存、提示词路由切分。根因：Pexels 相关度差是语料基因问题（热词内容不存在），非提示词可修。
- `WebImageSearchTool` 调 `GET {searxng.base-url:http://127.0.0.1:8888}/search?categories=images&format=json`（端口 8888 避开 Tomcat 默认 8080），取 `results[].img_src` 映射 `ImageResource(CONTENT)`，软失败返回空列表；`ImageCollectionPlan.webImageTasks` 复用 `ImageSearchTask` record；串/并发流与提示词双源路由规则已落地。SearXNG 服务见 `deployment.md`。测试为独立单测（`ReflectionTestUtils` 注入 base-url，SearXNG 未启动自动跳过，**不用 @SpringBootTest**，原因见下节）。

## 上下文启动潜伏 bug（2026-09-07 实测发现）

- **仍未修（属配置恢复任务）**：`CosClientConfig` 是 `@ConditionalOnProperty`（cos.client.* 缺失即无 bean）而 `ScreenshotServiceImpl` 硬依赖 `CosManager` → **key 恢复前所有 @SpringBootTest 无法启动**；langchain4j 模型 key 同样待恢复。
- 已修：0f3cdba 引入的弃用注入链路（两个 prototype `StreamingChatModel` 致 `NoUniqueBeanDefinitionException`，弃用字段/构造参数已删）；profile 专属文件禁止声明 `spring.profiles.active`（`InvalidConfigDataPropertyException`，旧环境文件可能同病）；`pexels.api-key` 改空默认 `${pexels.api-key:}` 不再阻塞启动。

## 编译红线

- **JDK 21 硬要求**：原生 Linux 经 SDKMAN，`JAVA_HOME=~/.sdkman/candidates/java/current` 执行 `./mvnw compile`。
- **构建产物目录**：pom 暴露 `maven.build.directory` 属性（默认 `${project.basedir}/target`）；WSL 命令带 `-Dmaven.build.directory=$PWD/wsl-rt-env/java/target`；原生 Linux/Windows 不传即默认 `target/`。⚠️ **不要用 `-Dproject.build.directory` 覆盖**——模型派生属性，部分插件（surefire 等）不认，会重建根 `target/`（实测 2026-09-04）。

## 关键事实（实现时直接依赖）

- `AppConstant.CODE_OUTPUT_ROOT_DIR = System.getProperty("user.dir") + "/tmp/code_output"`；`CodeGenTypeEnum`：`html`/`multi_file`/`vue_project`；`StreamMessageTypeEnum`：四类事件。
- 浏览器 SSE wire（Java 独占旧链路）：`data: {"d":"<文本>"}`（默认 message 事件）、`event: done`（构建后）、`event: business-error`。
- `AppController` 无类级 `@AuthCheck`；回调 endpoint `/api/app/chat/gen/code/callback` 只校验 Bearer token。
- 工具展示复用 `ToolManager.generateToolRequestResponse`/`generateToolExecutedResult`（Java 侧，不迁移）。
- **Logo 生成（2026-09-07 切硅基流动）**：`POST https://api.siliconflow.cn/v1/images/generations`，模型 `Kwai-Kolors/Kolors`（免费）；配置 `siliconflow.api-key`/`siliconflow.image-model`（key 未填时工具软失败返回空列表不阻塞主流程）；`dashscope-sdk-java` 已从 pom 移除。⚠️ 返回图片 url 有效期仅 1 小时，下游需及时消费。文档：https://api-docs.siliconflow.cn/docs/api/images-generations-post

## 约定

- 包结构 `com.zdan.paimengaicodemother.*`（`ai`/`controller`/`service`/`mapper`/`config`）；遵循阿里巴巴 Java 开发手册；注释遵循 `project-comment-style` skill。
- MyBatis Flex 代码生成：`com.zdan.paimengaicodemother.generator` 包生成器，mapper XML 在 `src/main/resources/mapper/`。
- 提交遵循 `AGENTS.md` 约定（Agent 代理提交携带 `<Agent IDE>/<用户信息>` 标注）。
