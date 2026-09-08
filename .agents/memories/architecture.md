# 记忆：架构决策（三服务目标架构）

> 2026-09-03 重构定稿（经四轮设计审讯、用户逐项确认）。权威设计见 `docs/ts_agent/architecture.md`；本文件为工作记忆摘要。
> **取代旧「双后端架构决策（B2/H4）」**：`docs/py_agent/task_plan.md` §1 契约转历史参考；B2 的职责边界被三服务分工取代，H4 的"回调 + runId 幂等"机制**沿用**（改由 TS Agent 发起）。

## 目标架构（三服务）

- **Java**（`src/`）：业务 REST、鉴权（签发短时 JWT）、充值/积分/会员、`chat_history` 落库、构建部署（`BuilderExecutor`）。
- **TS Agent**（`paimeng-ai-code-agent/`，Node + Fastify + Vercel AI SDK + XState v5）：访谈/线框/codegen 工作流、工具执行、Guardrail、工作区落盘；**SSE 直连浏览器**。
- **Python RAG**（`paimeng-ai-code-rag/`，FastAPI；2026-09-03 由旧 Python Agent 目录重命名而来）：检索服务；day-1 只读直查 MySQL few-shot，v2 pgvector + ingest。

## 拓扑与鉴权

- 前端 → Java：cookie session（现状不变）。
- 前端 → TS Agent：**fetch 流式 SSE + 短时 JWT**（EventSource 不支持自定义 header，故必须 fetch）；Agent 共享密钥**离线验签**，不回查 Java。
- TS Agent → Java：内部回调（Bearer 服务令牌 + **runId 幂等**，沿用现有 callback 机制）：结算积分 / 写历史 / 触发构建。
- TS Agent → RAG：`POST /v1/retrieval/context`（Bearer），返回 `{few_shots[], preferences}`。
- 生产 nginx 单域名：`/api/*`→Java(8123)，`/agent/*`→Node；RAG 仅内网。
- **"Java 不再对接 Agent"的准确语义**：不再**中转**生成流量；结算/历史/构建回调保留（四笔账有主：历史 Java 写、构建 Java 触发、费用 Java 结算、TS Agent 永不直连 MySQL）。
- **不引入**：服务发现（2-3 服务静态配置 + healthz + 快速失败）、LLM 网关（MVP；**后续必做**，自托管 NewAPI/LiteLLM 类）、消息队列、微服务拆分（`paimeng-ai-code-mother-microservice/` 废弃）。

## 数据分工

- **交易归 MySQL**：业务 + `chat_history` + `generation_run` + 积分台账（退款/结算需同库同事务）。
- **记忆归 PG**：PG **即刻停用**（原 LangGraph checkpoint 职责随 Python Agent 退役消失），RAG v2 pgvector 时重启。

## 关键机制摘要（详见权威文档 §2-§4）

- **浏览器 wire 重设**：四类事件（`ai_response`/`ai_thinking`/`tool_request`/`tool_executed`）语义与字段名保留；扔掉 `data:{"d":...}` 包装；`milestone` 升一等事件；契约落 `docs/ts_agent/contract.md`（P1 产出），契约测试语义比对不比对字节。
- **checkpoint = `generation_run` 表**（MySQL）：run_id/phase/context JSON（含 XState 快照）/milestones JSON（退款粒度锚）/token_usage/积分台账引用。phase：`interview → wireframe_pending → wireframe_confirmed → coding → review → building → done/failed/aborted`；同 app 并发 run 拒绝。
- **收敛三纪律**：phase 枚举进 DDL；跨请求等待仅显式状态；重试有界。
- **token 五层护栏**：输出硬上限（max_turns/max_output_tokens/max_tool_calls=50/图片 4 张，档位差异化）+ 优雅收尾（不硬杀）+ 输入滑窗摘要 + runId 计量 + 日配额熔断。按次计费 ⇒ 单次成本有界。
- **三档推理强度**：快速/标准（默认）/深度，每消息可选，深度 ×N 价格。
- **线框闸门**：未确认线框不 codegen；线框**免费 + 独立限频**，积分冻结发生在确认进入 codegen 时刻。
- **对话中断**：(a) 中止 day-1（保留半成品 + 里程碑退款，首文件前全额退）；(b) 续传挂 run 表稳定后。

## 过渡态（当前）

- 旧 Java AI 链路为回退主链路（**P0 已执行（2026-09-03）**：`application-local.yml` 已回切 `python-agent.enabled=false`，WSL 全栈 e2e 验证通过，Issue #2）。
- T21 门禁重定向："TS Agent 契约对等 + 回归全绿"（删除范围仍按 `docs/py_agent/t21_delete_plan.md`，`createApp` 保留 Java 侧 AI 路由）。
- **目录方案（2026-09-03 用户决策：重命名取代删除）**：旧 Python Agent 目录整体 `git mv` 为 `paimeng-ai-code-rag/`（RAG 骨架复用起点，P4 精简退役代码）；**TS Agent 落位 `paimeng-ai-code-agent/`（目录名复用）**；TS 移植参考 = `docs/py_agent/` 文档 + `paimeng-ai-code-rag/` 代码与 git 历史。
- Java 侧 `ai/python/*` 已泛化为 `ai/agent/*`（#6 落地：`agent.*` 配置段，`python-agent.*` 别名保留）。

## 踩坑与规避（架构级）

- 混合双 Agent 长期共存（Python 管旧 + TS 管新）是**最差解**，已明确排除。
- Cordis（`@deepseek-ai/cordis`）是 DSH 插件组合元框架（DI/生命周期），**非 Agent 框架**，选型属类目错误已排除；仅当未来开放第三方工具生态时再评估。

## 下一步 / 指针

- 权威设计：`docs/ts_agent/architecture.md`（含实施顺序 P0-P4、明确推迟项清单）。
- 历史参考：`docs/py_agent/task_plan.md`（契约细节）、`docs/py_agent/progress.md`（决策与验证记录）。
