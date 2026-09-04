# TS Agent 目标架构定稿

> **状态**：设计定稿，经用户四轮设计审讯逐项确认（2026-09-03），实施已启动（P0 完成；P1 进行中，顺序见 §11）。
> **权威地位**：本文取代 `docs/py_agent/task_plan.md` 的架构权威地位；`docs/py_agent/` 全目录转为历史参考（含提示词、契约、验证记录，是 TS 移植的参考源）。
> 配套跨会话记忆见 `.agents/memories/`（总入口 `MEMORY.md`）。

## 0. 决策背景与代价记录

架构演化路径：Java LangChain4j/LangGraph4j → Python Agent（T0-T20 完成并实机验证，**未上生产**）→ **TS Agent（本文，2026-09-03 定稿）**。

- **迁移 TS 的真实理由**（经事实核查后确认有效的部分）：编码型 Agent 的前沿参考实现生态以 TS 为主（Claude Code、Gemini CLI 等）；Agent/前端/生成物同语言统一技术栈；开发者个人偏好（知情决策，非技术必然）。
- **已核查并排除的论据**：①"LangChain Python SDK 企业使用率不高"——不成立，LangChain/LangGraph Python 恰是企业采用最广的 Agent 框架族；②"Python 开发 Agent 有并发性能问题"——对 I/O 密集的 Agent 负载不成立（瓶颈是 LLM 网络等待；Node 事件循环同为单线程，无相对优势）。
- **知情代价**（用户已确认接受）：已验证的 Python Agent 资产（图编排、PG checkpoint、11 个契约测试、工具沙箱、四类事件）全部重写，估计 4-8 周纯迁移期零新功能；运行时从 2 个变 3 个（JVM/Node/Python）；HITL 与 checkpoint 机制自建（LangGraph.js 成熟度不足的前提下已按自建设计）。
- **Cordis 判决**：`@deepseek-ai/cordis` 是 DSH 的插件组合元框架（DI/生命周期/服务注入），**不是 Agent 框架**（不提供模型调用、工具循环、流式、编排），作为候选属类目错误，排除。仅当未来开放第三方工具插件生态时重新评估。
- **红线**：混合双 Agent 长期共存（Python 管旧功能 + TS 管新功能）是最差解，已明确排除。

## 1. 总体架构：三服务

| 服务 | 技术栈 | 职责 |
|---|---|---|
| **Java**（`src/`） | Spring Boot | 业务 REST、鉴权（登录态 + **签发短时 JWT**）、充值/积分/会员、`chat_history` 落库、构建与部署（`BuilderExecutor`）、可视化编辑器数据 |
| **TS Agent**（`paimeng-ai-code-agent/`，Node） | Fastify + Vercel AI SDK + XState v5 | 需求访谈、线框生成、planner→coder→reviewer 工作流、工具执行、Guardrail、代码解析、工作区落盘、SSE 直连浏览器 |
| **Python RAG**（`paimeng-ai-code-rag/`，2026-09-03 由旧 Python Agent 目录重命名而来） | FastAPI（复用旧 agent 骨架模式） | 检索服务：day-1 结构化 few-shot 检索；v2 语义检索（pgvector）+ ingest 管道 |

### 1.1 服务间拓扑与鉴权

```
浏览器 ──(cookie session)──> Java :8123/api/*      （业务/登录/积分/历史）
浏览器 ──(fetch-SSE + JWT)──> TS Agent /agent/*      （生成流，EventSource 不可用：无自定义 header）
TS Agent ──(内部回调, Bearer 服务令牌 + runId 幂等)──> Java   （结算积分/写历史/触发构建）
TS Agent ──(Bearer)──> Python RAG :8091              （POST /v1/retrieval/context）
生产 nginx 单域名路由：/api/*→Java(8123)，/agent/*→Node；RAG 仅内网（不对浏览器暴露）
```

- **JWT**：Java 登录时签发短时 JWT，前端以 fetch 流式读取 SSE 并携带 Authorization header；Agent 用共享密钥**离线验签**（不回查 Java，保证字面上的"Java 不中转生成流量"）。
- **Agent→Java 内部回调**复用现有 callback 模式（Bearer + runId 幂等，`RunIdSinkRegistry` 机制沿用）：结算积分、写聊天历史、触发构建。
- **"Java 不再对接 Agent"的准确语义**：Java 不再**中转**生成流量（不再代理长连接 SSE）；结算/历史/构建的内部回调保留——历史由 Java 写（MySQL 资产）、构建由 Java 触发（`BuilderExecutor`）、费用由 Java 结算（积分台账），四笔账均有主。
- **TS Agent 永不直连 MySQL**：业务数据只经 Java 回调；few-shot 经 RAG 检索。

### 1.2 明确不引入的东西

- **服务发现中间件**：2-3 个服务、星型一对一调用、单机部署，静态配置 + `/healthz` + 超时快速失败即正确形态（`onErrorResume` 快速失败先例：~1s 返回 business-error）。
- **LLM 网关**：MVP 不上；**后续迭代必做**（多用户配额/计费/故障转移任一条件出现时），自托管方向（NewAPI / LiteLLM 类）。
- **消息队列 / 注册中心 / 微服务拆分**：`paimeng-ai-code-mother-microservice/` 为废弃尝试，不作为前提。

## 2. 浏览器 wire 协议（新契约）

- **重设而非复刻**：前端鉴权方式必改（cookie→JWT fetch 流），复刻旧格式的唯一收益不存在；这是唯一一次无成本重设协议的机会。
- **保留**：四类事件语义与字段名（`ai_response` / `ai_thinking` / `tool_request` / `tool_executed`）——验证过的领域模型。
- **新增**：`milestone` 一等事件（工作流节点跳变聚合成人话里程碑）；`done` / `error` 终态事件。
- **扔掉**：Java 中转时代的 `data:{"d":...}` 包装。
- **落点**：`docs/ts_agent/contract.md`（P1 产出，取代 `docs/py_agent/task_plan.md` §1）；契约测试移植按**语义比对、不比对字节**。

## 3. TS Agent 服务设计

### 3.1 技术栈与编排

- **Vercel AI SDK（模型层）**：多 provider 接入、流式、工具循环（`maxSteps`）、Zod 工具 schema。
- **XState v5（编排层）**：形式化状态图、非法转移在类型层消灭、快照可序列化、可视化与纯函数可测。选型动机：用户自评非框架开发者、自研状态机信心不足，XState 是"消灭状态机写错"这一工程风险类别的最小依赖。诚实边界：XState 不解决"流程该是什么"的领域问题（拓扑已钉死为线性+有界重试）。
- **收敛三纪律**（框架只是让违反更难，不能替代纪律）：① phase 枚举有限且进 run 表 DDL，新增 phase = 显式契约变更；② 跨请求等待只有显式持久化状态（`wireframe_pending` / `aborted`），禁止内存隐式等待；③ 重试有界（旧实现 `MAX_QUALITY_RETRIES=2`、`MAX_TOOL_CALLS=50` 先例）。
- **复杂度边界**：拓扑为线性 + 有界重试；唯一预期的复杂化是并行 fan-out（多页并行生成）——那是新决策点，不是必然演化，届时重新设计。

### 3.2 `generation_run` 表（checkpoint 等价物，MySQL）

| 字段 | 说明 |
|---|---|
| `run_id` | 主键，复用现有 runId 语义 |
| `app_id` / `user_id` | 归属 |
| `phase` | `interview → wireframe_pending → wireframe_confirmed → coding → review → building → done / failed / aborted` |
| `context` JSON | 访谈结论、已确认线框路径、plan；XState 快照序列化于此 |
| `milestones` JSON | 已过里程碑列表——**退款粒度的锚** |
| `token_usage` | prompt/completion 计量（定价校准 + 对账） |
| 积分台账引用 / 时间戳 | 冻结-结算-退款关联 |

- **断点续传**：新请求查同 app 最新非终态 run → 从 phase 续跑；线框闸门的"等待用户确认"即 `wireframe_pending` 跨请求存活（HITL 本就横跨多个 HTTP 请求，必须自建持久化，有无框架同理）。
- **并发**：同 app 并发 run 拒绝（409 + "当前有进行中的任务"），沿用 `@RateLimit` 风格。
- **一张表四个杠杆**：计费、退款、续传、计量。

### 3.3 token 五层护栏（按次计费的成本上界）

1. **输出硬上限**（每 run，档位差异化）：`max_turns` / `max_output_tokens` / `max_tool_calls`（50 先例）/ 图片配额（4 张）。
2. **超限 = 优雅收尾**：注入收尾指令，用户拿到完整交代，绝不硬杀。
3. **输入侧有界**：历史滑窗（最近 N 轮全文 + 更早摘要）+ 工作区文件即状态。
4. **计量**：每 run token 用量按 runId 落库（挂 `generation_run.token_usage`）。
5. **熔断**：用户日配额（积分体系）+ 平台级单 run 熔断。

> 结论：按次定价 + 硬上限 ⇒ 单次成本有上界，**亏损在数学上不可能**，剩余问题是定价校准（靠第 4 层数据）。

### 3.4 推理强度三档

快速（非推理模型）/ 标准（默认模型，**默认档**）/ 深度（推理模型）；每条消息可选，选择器在输入框旁；价格 ×N 档位系数；上限随档位放大（快速低上限、深度高上限）。映射旧 `MODEL_NAME` / `REASONING_MODEL_NAME` 二分为三档配置。

### 3.5 对话中断

- **(a) 中止（day-1，随直连拓扑落地）**：Agent 感知连接断开 → 取消 LLM 调用 → **保留已写文件**（半成品可"继续补完"）→ 历史标记 `[用户中断]` → 按已完成里程碑折算退款（**首个文件落盘前 = 全额退**）。
- **(b) 续传**：挂 run 表稳定性之后启用。

## 4. 需求工程（简单需求 → 中型工程的收敛机制）

- **模板锚定**：6 个锚定模板（个人主页 / 店铺展示 / 作品集 / 预约服务 / 博客 / 活动页），day-1 **提示词内置**（每模板一段结构描述），不做 DB 实体；RAG few-shot 语料成型后自然演进为数据。
- **访谈**：固定 5 维（受众 / 风格 / 页面清单 / 数据需求 / 交互），每维模型生成**选择题**（2-4 选项），**最多 2 轮**；信息齐直接出线框，不硬凑轮数。
- **线框**：单文件 HTML（灰块 + 占位图 + 可点击页面跳转），快速档模型生成，存 `{workspace}/wireframe/`，iframe 预览；必须含**站点地图**（页面清单 + 导航关系）；**MVP 页面数上限 5 页**。
- **闸门纪律（核心）**：**未确认线框不进入 codegen**——同时解决需求偏差与 token 浪费。用户确认的线框即 codegen 布局契约、review 阶段视觉 diff 的基准。
- **线框计费（闸门经济学）**：线框阶段**免费 + 独立限频**（每用户每日 N 次，`@RateLimit` 模式）；积分冻结发生在"确认线框进入 codegen"时刻。若线框收费，用户会跳过确认，闸门形同虚设。
- **技术栈强制选择**：createApp 表单显式选择**直接生效（跳过 AI 路由）**，未选择才走"智能推荐"路由；枚举只暴露有构建管线支持的三类（html / multi_file / vue_project），新栈入枚举前提是 `BuilderExecutor` 先支持；Agent 只提示不擅自降级（选择权归用户）。

## 5. 生成物运行时阶梯

| 层级 | 形态 | 时机 |
|---|---|---|
| **L0** | 纯静态 + 数据内嵌 JSON | **MVP**（复用 `tmp/code_deploy` 静态部署管线） |
| **L1** | 预览态 mock 后端（MSW 风格拦截层注入预览 iframe，表单/列表全可演示） | **MVP** |
| L2 | BaaS 集成（平台引导开通，Agent 生成对接代码） | 下一里程碑 |
| L3 | 生成 **TS 全栈**（Next.js / API 路由类），单运行时通吃 | 真实付费需求出现后 |

- 生成物后端**只能是 TS**；Java→JS 编译（TeaVM/CheerpJ 类）与"浏览器内置 Java 虚拟后端"**永久删除出路线图**。平台的 Java 与生成物的后端是两回事。

## 6. 质量门禁（验收不靠角色签字，靠机器）

- 工作流 = **planner → coder → reviewer** 三工位循环（由现有单图演进而来；reviewer 复用质检节点）；**不做产品/前端/后端/测试的角色团队**（角色分工不产生智能，只付协调税）；后端代码生成真实出现再加后端工位。
- 验收门禁：**结构化质检分 + `npm run build` 通过 + 视觉 diff 线框**；重试有界。
- 父子图（subgraph）：等某个子流程需要独立重试/恢复时再拆，当前不拆。
- Playwright 脚本进平台内部验收管线（远期），兼出演示 GIF。

## 7. 盈利与计费

- **计费单位**：按次 + 档位系数（生成类型 × 推理强度档）；不做裸 token 计费（受众算不懂，价格不可预期）。
- **扣费协议**：预冻结 → 完成结算 → 中断/失败退款，全部挂 runId 幂等机制（天然对账单）。
- **会员**：二期（月配额 / 折扣 / 优先队列），MVP 不做。
- **支付**：MVP **后台手动充值**（管理员录账）；微信支付/支付宝商户号需营业执照（个体工商户可办）——**用户当前无执照，确认商业价值后办理**（短期不办）；不使用灰色聚合支付通道。
- 深度档 = 按次计价 + 固定 token 额度，超限优雅收尾（§3.3）。

## 8. 知识沉淀与 RAG 服务

- **先采集后检索**：MVP 先建 MySQL 结构化反馈表（4 类数据：采纳/拒绝+原因、编辑器 diff、用户偏好、需求→方案对），从可视化编辑器和对话流埋采集点；代码生成时 few-shot 注入最近 N 条同类目成功案例。
- **数据量到千级**再启用语义检索（pgvector），接口不变。
- **RAG 服务 day-1**：`POST /v1/retrieval/context`（入参 app_id/user_id/code_gen_type/需求文本 → `{few_shots[], preferences}`）；**只读 MySQL 账号直查业务表/视图**（务实耦合两张表）；鉴权服务间 Bearer。
- **RAG v2**：ingest 推送管道（Java→RAG）+ 自有 schema + pgvector 语义检索（调用方无感）；届时 RAG 才真正"拥有"知识库。
- **存储分工原则**：**交易归 MySQL**（业务 + `chat_history` + `generation_run` + 积分台账，同库同事务保证退款/结算原子性）；**记忆归 PG**（pgvector + JSONB 优势；PG 于 P0 停用、RAG v2 时重启）。

## 9. 通知与用户体验

- **等待焦虑**：SSE 流本身即过程可见性；`milestone` 一等事件（节点跳变→人话："正在规划页面结构"→…→"完成"）；首屏 ≤30s 出可点线框（Q4 闸门前置消化焦虑）。
- **完成通知**：浏览器 Notification API +（可选）邮件；**webhook 降级为远期开放平台特性**（受众是开小卖部的，没有接收 webhook 的系统）。
- **微信公众号通知**（用户订阅平台公众号收回调/活动消息）：v1.x（依赖认证服务号，同执照依赖线）。
- **亮点可见性**：onboarding 导览**生成进应用本身**（提示词强制产出导览组件），不做独立操作文档。

## 10. 过渡与退役（2026-09-03 决策）

1. **回退主链路**：`python-agent.enabled=false` 回切旧 Java AI 兜底（验证过的回退路径，零成本），TS Agent 建成前保持开发环境可用。
2. **T21 门禁重定向**：原"Python 灰度 ≥7 天"门禁作废，改为"**TS Agent 契约对等 + 回归全绿**"后删除旧 Java AI（删除范围仍按 `docs/py_agent/t21_delete_plan.md`，含用户已确认的 `createApp` 保留 Java 侧 AI 路由决策）。
3. **Python Agent 目录处置（2026-09-03 用户决策修订：重命名取代删除）**：`paimeng-ai-code-agent/` 整目录 `git mv` 为 `paimeng-ai-code-rag/`（旧 FastAPI 骨架 auth/config/healthz/Bearer/uv 锁定原位复用），退役代码在 P4 RAG 实施时精简；**TS Agent 落位 `paimeng-ai-code-agent/`（目录名复用）**；TS 移植参考 = `docs/py_agent/` 文档 + `paimeng-ai-code-rag/` 代码与 git 历史（提示词 7 份、解析正则、guardrail 规则）。
4. **PG 即刻停用**：runbook 留档（`.agents/memories/deployment.md`），RAG v2 时重启。
5. **Java 侧**：`ai/python/*` 三类泛化为通用 Agent 客户端（`python-agent.*` 配置段 → `agent.*`），callback endpoint 模式沿用改指向 TS Agent。（**#6 已落地 2026-09-04**：`ai/agent/*` 泛化完成、`agent.*` 配置 + `python-agent.*` 别名保留、新增完成回调 `POST /internal/agent/runs/{runId}/complete`。）

## 11. 实施顺序（依赖关系而非死顺序）

- **P0 止血回退**（1 天）：回切旧链路 → 停 PG → 记忆/文档更新（本文 + MEMORY/AGENTS/架构记忆）。
- **P1 骨架**（1-2 周）：TS Agent 服务骨架（Fastify + JWT 验签中间件 + 工作区沙箱移植）+ `generation_run`/积分/反馈表 DDL + `docs/ts_agent/contract.md` 新 SSE 协议 + Agent→Java 回调打通（泛化 `ai/python/*`）。
- **P2 核心能力**（2-3 周）：guardrail/图片四工具/解析/质检 TS 移植（参照 git 历史 Python 实现，提示词直接复用）；访谈+线框（免费+限频）；XState 工作流 + 五层护栏 + 三档强度；中止 (a)。计费可后挂（run 表字段预留）。
- **P3 联调切换**：契约测试移植（语义比对）→ `ts-agent.enabled` 灰度开关 → 执行 T21（删旧 Java AI + Python Agent 目录）→ 前端改造（fetch-SSE / JWT / 新事件 schema / 线框确认 UI / 档位选择器 / 中止按钮 / 积分显示）。
- **P4 RAG + 盈利 MVP**：`paimeng-ai-code-rag/`（目录已由旧 Python Agent 重命名就位）精简退役代码后 day-1 上线（few-shot 直查）+ 反馈埋点 + 后台手动充值台账。

## 12. 明确推迟项（非遗忘，是有意识的排队）

LLM 网关（后续必做）、会员体系、微信支付 + 公众号通知（v1.x，卡执照）、RAG v2（pgvector + ingest）、L2 BaaS、L3 TS 后端、Playwright 验收管线、并行 fan-out（新决策点）、Cordis（仅当开放第三方工具生态）。
