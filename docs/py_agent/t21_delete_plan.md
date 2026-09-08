# T21 删除旧 Java AI 实现 —— 就绪方案（准备期产物）

> 状态：**已执行完毕（2026-09-08，Issue #14）**。门禁为「TS Agent 契约对等 + 回归全绿」（架构 §10.2 重定向）。
> 实际执行与本计划的差异（用户 2026-09-08 决策「根因清除」）：
> 1. **中转链遗物一并删除**：计划写作时 `ai/agent/*`（原 PythonAgentClient 三件）与 `core/handler`、`ai/tools` 的保留理由是「Python 中转链复用」；#12 直连架构（浏览器 fetch-SSE + JWT）落地后中转链成为指向已退役端点 `/v1/agent/stream` 的死路径，故 `AgentClient`/`AgentSseAdapter`/`AgentRequest`/`AgentCallbackRequest`/`RunIdSinkRegistry`、端点 `/app/chat/gen/code` 与 `/app/chat/gen/code/callback`、级联死代码（`core/handler`、`ai/tools`、`ChatStreamingChatModelConfig`、`ReasoningStreamingChatModelConfig`、`RedisChatMemoryStoreConfig`、`AgentLegacyAliasPostProcessor`）全部删除——§3 保留清单中这几项以本注记为准作废，其余保留项（route 链、RoutingAiModelConfig、SpringContextUtil、BuilderExecutor、`ai/agent` 中 Jwt 三件、`ai/enums/CodeGenTypeEnum`）完好落地。
> 2. **langchain4j 依赖按 §4.4 授权收敛**：保留 `langchain4j` + `langchain4j-open-ai-spring-boot-starter`（路由链）；删除 `langchain4j-reactor`、`langchain4j-community-redis-spring-boot-starter`（仅服务已删 ChatMemory/embedding 路径）；连带删除 `langgraph4j-core` 与 `spring-boot-starter-webflux`（仅中转链 WebClient 使用）。Redis 连接改显式声明 `spring-boot-starter-data-redis`（此前靠 community-redis starter 传递引入）。
> 3. **配置段**：`python-agent.*`/`agent.*` 合并更名为 `ts-agent.*`（灰度开关 `ts-agent.enabled` 默认 true，门禁 `/app/agent/token`，关闭→40410）；§7 的 `langchain4j.open-ai.routing-chat-model` 段在仓库 `application.yml` 本就不存在，现以 `src/main/resources/application-local.yml.example` 模板落档。
> 4. **开关语义**：删除后「关→旧链路」不再存在（回退手段 = git 回滚）；AC1 按两段式验收（删除前双链路 e2e + 删除后 40410）。
>
> 以下为原计划正文（保留作历史依据，与上述注记冲突处以注记为准）：

> 历史状态：准备完成，待门禁放行。原门禁按 §5「稳定」定义：开发环境灰度 ≥7 天 + T19/T20 回归全绿 + 无 P0/P1 缺陷（已被 2026-09-03 门禁重定向取代）。
> 本文档在门禁期内完成依赖分析与删除清单（2026-09-01），使门禁放行后 T21 为**机械性执行**。
> 契约与任务定义见 `docs/py_agent/task_plan.md` §3 / §4-T21；进度见 `progress.md`。
>
> **⚠ 2026-09-01 用户决策（已确认）**：`createApp` **保留 Java 侧 AI 路由**（`AiCodeGenTypeRoutingService`），
> 不改为默认 html / 前端字段 / Python 路由。T21 删除范围相应缩小（见 §2/§3/§4）。

## 1. 目标与保留边界（§3 / §4-T21）

- **删除**：`ai/codegen`（**除 `route/`**）、`langgraph4j` 等旧 AI 实现（功能已迁移至 Python Agent）。
- **保留**：`ai/codegen/route/*`（**用户决策**：`createApp` 的 codeGenType 仍由 Java AI 路由判断）、
  `ai/tools` 的**展示格式**（`generateToolRequestResponse` / `generateToolExecutedResult`，供 `JsonMessageStreamHandler` 复用）、
  `core/handler/*`（展示重组）、`Controller/Service` 业务层、`BuilderExecutor`（构建）。

## 2. 依赖分析结论（2026-09-01 代码核对）

| 包/类 | 被谁引用（外部） | 处理 |
|---|---|---|
| `ai/codegen/{AiCodeGenService,AiCodeGenServiceExecutor,AiCodeGenServiceFactory,CodeGenType,HtmlCodeGenService,MultiFileCodeGenService,VueCodeGenService}` | `core/AiCodeGeneratorFacade`、`langgraph4j/node/RouterNode`、`service/impl/AppServiceImpl`、`utils/ClazzScanner` | **删除**（引用方同步删除/改代码） |
| `ai/codegen/route/*`（`AiCodeGenTypeRoutingService` + `Factory`） | `service/impl/AppServiceImpl`（createApp）、`langgraph4j/node/RouterNode`（随 langgraph4j 删除） | **保留**（用户决策）；RouterNode 引用随 langgraph4j 消失 |
| `langgraph4j/*`（workflow/nodes/ai/tools/concurrent/state） | **无任何外部引用**（完全自包含） | **直接删除** |
| `ai/guardrail/*` | 仅 `ai/codegen/AiCodeGenServiceFactory`（已删） | 删除后变为死代码，**一并删除** |
| `core/AiCodeGeneratorFacade` | `langgraph4j/node/CodeGeneratorNode`（已删）、`service/impl/AppServiceImpl`（改代码） | **删除** |
| `core/parser/*`、`core/saver/*` | 仅 `core/AiCodeGeneratorFacade`（已删） | 删除后变为死代码，**一并删除**（§3 未明列，属连带） |
| `utils/ClazzScanner` | 仅 `ai/codegen/AiCodeGenServiceExecutor`（已删） | **一并删除** |
| `utils/SpringContextUtil` | 路由 Factory + 多个已删 langgraph4j node + 已删 AiCodeGenServiceFactory | **保留**（路由 Factory 需要） |
| `config/RoutingAiModelConfig`（`routingChatModelPrototype` bean） | 路由 Factory（`SpringContextUtil.getBean("routingChatModelPrototype")`） | **保留** |
| `prompt/codegen-routing-system-prompt.txt` | 路由接口 `@SystemMessage(fromResource=...)` | **保留** |
| langchain4j 框架依赖（`dev.langchain4j`） | 路由接口 `@SystemMessage`/`AiServices`/`ChatModel`/`OpenAiChatModel` | **保留**（与 `langgraph4j` 图框架无关，勿误删） |

> 关键结论：`langgraph4j` 无外部引用 → 删除零风险；`ai/codegen` 的执行类引用方全部在删除/改动清单内；
> **路由链（route/* + RoutingAiModelConfig + SpringContextUtil + prompt + langchain4j）自成闭环**，删除执行类不影响路由。

## 3. 保留清单（不删）

- `ai/codegen/route/`：`AiCodeGenTypeRoutingService`、`AiCodeGenTypeRoutingServiceFactory`（**用户决策**，createApp 继续用）
- `config/RoutingAiModelConfig.java` + `prompt/codegen-routing-system-prompt.txt`（路由 ChatModel 与系统提示词）
- `utils/SpringContextUtil.java`（路由 Factory 依赖；通用工具）
- langchain4j 框架依赖（pom：`dev.langchain4j:langchain4j`、`langchain4j-open-ai` 等，供 AiServices/ChatModel/OpenAiChatModel/SystemMessage；**保留与否按最终编译与 Spring 上下文核对**）
- `ai/tools/`：`BaseTool`、`ToolManager`、`ProjectFile{Write,Read,Modify,Delete,DirRead}Tool`、`ExitTool`（展示格式；`@Tool` 执行方法保留但旧链路不再调用）
- `core/handler/`：`JsonMessageStreamHandler`、`SimpleTextStreamHandler`、`StreamHandlerExecutor`（Python 路径经 `PythonAgentSseAdapter` 复用前两者；`StreamHandlerExecutor` 的旧路径 `doHandle` 移除后若无调用方，标注为废弃候选——§3 要求保留目录，先留）
- `core/builder/BuilderExecutor`（回调 success 构建）
- `ai/python/*`（新链路：`PythonAgentClient/SseAdapter/RunIdSinkRegistry/Request/CallbackRequest/Properties`）
- `ai/enums/CodeGenTypeEnum`（Python 链路请求与路由均引用）

## 4. 需同步的代码改动（删除本身不足以编译通过）

1. **`service/impl/AppServiceImpl.java`**：
   - **保留** `aiCodeGenTypeRoutingServiceFactory` 字段/构造参数与 `createApp` 的路由调用（L108-109，`routeCodeGenType(initPrompt)`）。
   - **移除** 字段/构造参数 `aiCodeGeneratorFacade`、`streamHandlerExecutor`（L62-63、L73-74、L83-84）。
   - `chatToGenCode`：移除旧链路分支（L235-236 `generateAndSaveCodeStream` + `streamHandlerExecutor.doHandle`），`pythonAgentProperties.isEnabled()` 不再需要分支（恒走 Python 链路；开关可保留为运维兜底或移除）。
2. `core/handler/StreamHandlerExecutor`：若旧链路移除后无调用方，标注废弃；`core/parser`/`core/saver` 随 `AiCodeGeneratorFacade` 删除。
3. 删除旧测试：`AiCodeGeneratorFacadeTest`、`langgraph4j/*`（6 个）。**保留 `AiCodeGenTypeRoutingServiceTest`**（路由仍在，测试仍有效）。
4. pom.xml：若 langchain4j 相关依赖（`langchain4j-*`、`langgraph4j-*`）仅服务于已删代码，按编译结果收敛；**`langgraph4j-*` 依赖可删，`langchain4j-*` 保留**（路由需要）。放行时逐条核对，不盲删。

## 5. 回归命令（门禁放行后执行）

```bash
# Java：编译 + 全量测试（@SpringBootTest 会真实调用 DeepSeek，需网络与 application-local.yml key）
JAVA_HOME=.../java/current ./mvnw compile
JAVA_HOME=.../java/current ./mvnw test
# 单测快速回归（不依赖 Spring 上下文）
./mvnw test -Dtest=PythonAgentClientTest,RunIdSinkRegistryTest,PythonAgentSseAdapterTest,AiCodeGenTypeRoutingServiceTest
# Python（契约 + 全量）
cd paimeng-ai-code-agent && DATABASE_URL=postgresql://.../paimeng_test uv run pytest -m contract
cd paimeng-ai-code-agent && DATABASE_URL=postgresql://.../paimeng_test uv run pytest
# 浏览器事件逐事件比较（旧基线 vs Python 链路，三类 DIFF 为空）
python3 docs/py_agent/sse_baseline.py --type html    --baseline <T14a html>    --actual <py html>
python3 docs/py_agent/sse_baseline.py --type multi_file --baseline <T14a multi> --actual <py multi>
python3 docs/py_agent/sse_baseline.py --type vue_project --baseline <T14a vue>  --actual <py vue>
# 建应用仍能正确路由 codeGenType（新增应用 → app.codeGenType ∈ {html,multi_file,vue_project}）
```

## 6. 未决决策 → 已确认（2026-09-01）

- ~~`createApp` 的 codeGenType 来源~~ → **已确认：保留 Java 侧 AI 路由**（`AiCodeGenTypeRoutingService`）。`AppAddRequest` 不加字段、Python 侧不路由、不默认 html。路由链（route/* + `RoutingAiModelConfig` + `SpringContextUtil` + prompt + langchain4j）作为最小旧 AI 残片保留。
- `StreamHandlerExecutor` 与 `core/parser`/`core/saver` 是否允许一并移除：§3 明列保留 `core/handler`，建议保留目录、仅移除无调用方的旧路径方法（`parser`/`saver` 随 Facade 删除）。

## 7. 风险

- 删除后全量测试中 `@SpringBootTest` 上下文需重新核对 Bean 装配（路由 ChatModel 与 langchain4j 自动配置需仍在）。
- `application.yml` 中旧 AI 相关配置段（`langchain4j`、`ai` 等）：**保留 `langchain4j.open-ai.routing-chat-model` 段**（`RoutingAiModelConfig` 绑定），其余无 Bean 消费的段可清理（放行时核对）。
