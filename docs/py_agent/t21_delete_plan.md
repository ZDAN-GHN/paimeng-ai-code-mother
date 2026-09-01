# T21 删除旧 Java AI 实现 —— 就绪方案（准备期产物）

> 状态：**准备完成，待门禁放行**。T21 按 §5「稳定」定义执行：开发环境灰度 ≥7 天 + T19/T20 回归全绿 + 无 P0/P1 缺陷。
> 本文档在门禁期内完成依赖分析与删除清单（2026-09-01），使门禁放行后 T21 为**机械性执行**。
> 契约与任务定义见 `docs/py_agent/task_plan.md` §3 / §4-T21；进度见 `progress.md`。

## 1. 目标与保留边界（§3 / §4-T21）

- **删除**：`ai/codegen`、`langgraph4j` 等旧 AI 实现（功能已迁移至 Python Agent）。
- **保留**：`ai/tools` 的**展示格式**（`generateToolRequestResponse` / `generateToolExecutedResult`，供 `JsonMessageStreamHandler` 复用）与 `core/handler/*`（展示重组）、`Controller/Service` 业务层、`BuilderExecutor`（构建）。

## 2. 依赖分析结论（2026-09-01 代码核对）

| 包/类 | 被谁引用（外部） | 处理 |
|---|---|---|
| `ai/codegen/*`（Html/MultiFile/VueCodeGenService、`AiCodeGenServiceExecutor/Factory`、`CodeGenType`、`route/*`） | `core/AiCodeGeneratorFacade`、`langgraph4j/node/RouterNode`、`service/impl/AppServiceImpl`、`utils/ClazzScanner` | **删除**（引用方同步删除/改代码） |
| `langgraph4j/*`（workflow/nodes/ai/tools/concurrent/state） | **无任何外部引用**（完全自包含） | **直接删除** |
| `ai/guardrail/*` | 仅 `ai/codegen/AiCodeGenServiceFactory`（已删） | 删除后变为死代码，**一并删除** |
| `core/AiCodeGeneratorFacade` | `langgraph4j/node/CodeGeneratorNode`（已删）、`service/impl/AppServiceImpl`（改代码） | **删除** |
| `core/parser/*`、`core/saver/*` | 仅 `core/AiCodeGeneratorFacade`（已删） | 删除后变为死代码，**一并删除**（§3 未明列，属连带） |
| `utils/ClazzScanner` | 仅 `ai/codegen/AiCodeGenServiceExecutor`（已删） | **一并删除** |

> 关键结论：`langgraph4j` 无外部引用 → 删除零风险；`ai/codegen` 的引用方全部在删除/改动清单内 → 删除后不影响保留代码。

## 3. 保留清单（不删）

- `ai/tools/`：`BaseTool`、`ToolManager`、`ProjectFile{Write,Read,Modify,Delete,DirRead}Tool`、`ExitTool`（`generateToolRequestResponse`/`generateToolExecutedResult` 展示格式；`@Tool` 执行方法保留但旧链路不再调用）
- `core/handler/`：`JsonMessageStreamHandler`、`SimpleTextStreamHandler`、`StreamHandlerExecutor`（Python 路径经 `PythonAgentSseAdapter` 复用前两者；`StreamHandlerExecutor` 的旧路径 `doHandle` 移除后若无调用方，标注为废弃候选——§3 要求保留目录，先留）
- `core/builder/BuilderExecutor`（回调 success 构建）
- `ai/python/*`（新链路：`PythonAgentClient/SseAdapter/RunIdSinkRegistry/Request/CallbackRequest/Properties`）
- `core/AiCodeGeneratorFacade` 之外的 `core/` 其余（按需核对）
- `ai/enums/CodeGenTypeEnum`（Python 链路请求仍引用）

## 4. 需同步的代码改动（删除本身不足以编译通过）

1. **`service/impl/AppServiceImpl.java`**：
   - 移除字段/构造参数 `aiCodeGeneratorFacade`、`streamHandlerExecutor`、`aiCodeGenTypeRoutingServiceFactory`。
   - `chatToGenCode`：移除旧链路分支（`generateAndSaveCodeStream` + `streamHandlerExecutor.doHandle`），`pythonAgentProperties.isEnabled()` 不再需要分支（恒走 Python 链路；开关可保留为运维兜底或移除）。
   - `createApp`：移除 `AiCodeGenTypeRoutingService` 路由——**未决决策**（见 §6）。
2. `core/handler/StreamHandlerExecutor`：若旧链路移除后无调用方，标注废弃；`core/parser`/`core/saver` 随 `AiCodeGeneratorFacade` 删除。
3. 删除对应旧测试：`AiCodeGenTypeRoutingServiceTest`、`AiCodeGeneratorFacadeTest`、`langgraph4j/*`（6 个）、`WebScreenshotUtilsTest` 若依赖旧类则核对。

## 5. 回归命令（门禁放行后执行）

```bash
# Java：编译 + 全量测试（@SpringBootTest 会真实调用 DeepSeek，需网络与 application-local.yml key）
JAVA_HOME=.../java/current ./mvnw compile
JAVA_HOME=.../java/current ./mvnw test
# 单测快速回归（不依赖 Spring 上下文）
./mvnw test -Dtest=PythonAgentClientTest,RunIdSinkRegistryTest,PythonAgentSseAdapterTest
# Python（契约 + 全量）
cd paimeng-ai-code-agent && DATABASE_URL=postgresql://.../paimeng_test uv run pytest -m contract
cd paimeng-ai-code-agent && DATABASE_URL=postgresql://.../paimeng_test uv run pytest
# 浏览器事件逐事件比较（旧基线 vs Python 链路，三类 DIFF 为空）
python3 docs/py_agent/sse_baseline.py --type html    --baseline <T14a html>    --actual <py html>
python3 docs/py_agent/sse_baseline.py --type multi_file --baseline <T14a multi> --actual <py multi>
python3 docs/py_agent/sse_baseline.py --type vue_project --baseline <T14a vue>  --actual <py vue>
```

## 6. 未决决策（门禁放行前需确认）

- **`createApp` 的 codeGenType 来源**：删除 `AiCodeGenTypeRoutingService`（AI 路由）后，创建应用时如何确定 `html/multi_file/vue_project`？候选：
  1. 默认固定 `html`（最简，业务回归最小）；
  2. `AppAddRequest` 增加 `codeGenType` 字段（前端显式选择，需前端配合）；
  3. 由 Python 侧 `app/services/codegen/routing.py` 路由（Java 建应用时同步调 Python，改动最大）。
  建议 **1 或 2**；本方案默认按 **1（默认 html）** 预判，放行时以产品/前端确认为准。
- `StreamHandlerExecutor` 与 `core/parser`/`core/saver` 是否允许一并移除：§3 明列保留 `core/handler`，建议保留目录、仅移除无调用方的旧路径方法。

## 7. 风险

- 删除后全量测试中 `@SpringBootTest` 上下文需重新核对 Bean 装配（无旧 AI Bean 后应更轻）。
- `application.yml` 中旧 AI 相关配置段（`langchain4j`、`ai` 等）若无 Bean 消费可一并清理（放行时核对）。
