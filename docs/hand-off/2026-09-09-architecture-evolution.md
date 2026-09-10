# Handoff

> 主题：TS Agent 工作流架构 vs Agent Loop 的路线抉择（Skill 化 / AI Native 演进地基）
> 状态：架构讨论完成；下方方向结论是**我方建议、用户尚未表态**（勿当既成决策使用）；**尚无任何代码变更**。下一会话按「Recommended Next Work」接续。
> 版本注记：本文件首版由提交 `ba0bb19`（2026-09-10 10:53）写入，随后在工作树中被删除（未提交）；本次恢复并更新（补齐代码锚点、最新事实与证据边界）。

## Context

用户质疑当前 XState 工作流是否是产品未来（Skill 化、AI Native 愿景——「Skill 就是接口，所有可视化操作都能用自然语言 + Skill 完成，允许不用鼠标」）的正确地基。经 7 轮架构讨论，结合 DSH 设计、市场一手证据（bolt.new、Replit Agent）、Anthropic 官方指南，形成以下**建议结论（用户尚未表态；属待评估假设，不是既成决策）**：

**loop-first（循环为干、工具为枝）可能是正确终态；但拆工作流不是免费动作，需签三份重建承诺（退款锚改为从工具事实推导、闸门改造为 approval 工具、真实模型评估体系先行）。工作流不是承重墙，它是假 LLM 时代（P0–P3）的正确脚手架，终态角色可降级为 fallback + 强制地板。**

讨论问题链：
1. planner→coder→reviewer 算 Agent Loop 吗 → 两层拆分：内层有界工具循环是真 Agent Loop，外层 XState 是工作流
2. 对比 DSH `agent-loop` / `goal` / `round-driver` / `ralph` → paimeng 实为「goal 模式的特化收敛版」
3. 自审结论 → 修正会话层现状的事实性错误（当前连跨消息重跑都不存在，每旅程一次性）
4. 工作流会不会成为坑 → 刚性不在 XState，在「编排内联」与「旅程决策权错位在前端+路由」
5. Skill 化方案 → 三层粒度（旅程层粗、生成层细、质检层中）+ 工作流边界收缩
6. 工具粒度质疑（「步骤越细质量越好？」）→ 证伪：质量来自 ground truth 反馈，不是步骤数
7. 根本问题（不用工作流是否有更好选择）→ 市场赢家支持 loop-first；补三份重建承诺与迁移门槛

## Completed State

### 1. 两层拆分（事实，带代码锚点）
- **内层 = 真 Agent Loop**：coder 工位 `streamText` + `stopWhen: [isStepCount(maxTurns), stopWhenToolCalls(maxToolCalls)]` + 10 工具（文件六 + 图片四）
- **外层 = 工作流**：XState 线性机 `interview → coding → review → done/failed`，转移由驱动代码依门禁判决发出，模型无「下一步去哪」的发言权
- 结论：paimeng 是「内嵌一个有界 Agent Loop 的刚性工作流」，coding↔review 对应 Anthropic 定义中的 **evaluator-optimizer workflow**（该模式的适用条件 = 有清晰评估标准）——**但适用性仅部分成立**：§4 记录的评估强度打折（非 html 类型实际约「一道半门禁」）使「评估标准清晰」这一前提本身待补强。两处结论不可分开引用

### 2. DSH 四件套对照（事实）
| DSH 包 | 角色 | paimeng 对应 |
|---|---|---|
| `dsh-agent-loop` | 机制（无内置轮次预算） | AI SDK streamText 工具循环 |
| `dsh-goal` | 状态（非调度，事件溯源+修订栅栏） | `generation_run` 表 |
| `dsh-goal-round-driver` | 调度（先预留后准入、人类消息让行） | 无（续传推迟） |
| `dsh-tool-ralph` | 新鲜 agent 迭代（工作区=长期记忆） | 工作区 + run.context |

关键纪律（可照抄）：续行权限 armed/disarmed 进程本地、重启后绝不自动复活；create/edit goal 须人类直接消息；blocked 自报需连续 ≥3 轮；**DSH 自身无独立评估器**（自我申报完成）——而 paimeng 有门禁，这是它比 DSH 多的部分（但强度见 §4）。

### 3. 会话层现状修正（review 发现的高严重度事实错误）
上一轮曾断言「每条消息重跑 workflow 模拟 goal round」——**不成立**，实态更刚性：
- `agentRoutes.ts:256`：`run.phase !== 'wireframe_confirmed'` → **409**；done/aborted 均终态 → 同一 run 无法二次开流
- 前端 `AppChatPage.vue:604-613`：idle 发消息 = 开始**新旅程**（重新五维访谈）；`:914` 生成后回 idle
- 前端 `history` 实际只传 2 条（`AppChatPage.vue:889-897`：旅程原始需求 + 前端拼的访谈结论伪 assistant 消息）；服务端 `HISTORY_WINDOW=10` 只是容量上限，**不是当前多轮记忆实态**
- 续传按架构 §3.5 (b) 明确推迟未实施
- ⇒ 当前会话层 = 每旅程一次生成、终态即闸门锁死、**跨消息零生成记忆**

### 4. 信息流与评估器强度（实施阶段要修的缺口）
- **coder 看不到线框**：`wireframePath` 只传给 review 门禁（`agentRoutes.ts:259-273`），`codegenSystem` 无 wireframe——架构 §4 称线框「即 codegen 布局契约」，实现只做了「review 基准」半边
- **访谈结论不入服务端**：由前端伪 assistant 消息注入 ⇒ 模型契约依赖前端序列化，前端改版即静默丢失需求上下文（服务端该收口）
- **planner 工位空转**：`workflow/index.ts:264-273` interview 节点仅做 Guardrail + 一条 thinking，**无 LLM**；访谈/线框当前为脚本化实现
- **评估器强度打折**：build 门禁对 `multi_file`/`vue_project` 是占位（「L1 构建管线未接入」）；视觉 diff 是 page-N 区段覆盖启发式；质检分是 LLM 结构化输出 ⇒ 对非 html 类型实际约「一道半门禁」

### 5. 粒度判据（网络证据结论，用于后续设计）
- **Anthropic 官方**（Writing effective tools for agents）：合并高频多步链路为单工具（`schedule_event` 例）；「offload agentic computation into tool calls reduces risk of mistakes」；工具过多会分散策略；判据是**自然任务边界**
- **Anthropic 官方**（Building effective agents）：质量杠杆 = **可验证反馈**（coding agent 有效因测试可验、可迭代）；agent 步骤越多复合错误与成本越高
- **独立实测**（Antigravity Lab，n=1）：细工具三失败模式（上下文膨胀约 40% / 中途迷失 / 半成品残留）；规则 = **bundle by intent + split by reversibility**（不可逆操作必须拆出确认点）
- ⇒ 「步骤越细质量越好」被证伪；正解：**在有 ground truth 反馈的决策点上调细**
- ⇒ 修正后三层粒度：旅程层粗（4 工具）、生成层细（文件六+图片四）、**质检层中（三门禁变可调工具，确定性强制保留）**

### 6. 市场证据（loop-first 的外部验证）
- **bolt.new**（$40M ARR / 15 工程师，PostHog 对 CTO 一手访谈）：「整个应用源自**一个精心构造的单一提示词**」——无 LLM 链、无编排；护城河是运行时（WebContainer 浏览器内 VM）+ 立即可运行反馈
- **Replit Agent**（官方工程博客）：「把它想成 **rails and signals——不是锁死的轨道**」；结构性靠**决策时引导**（分类器注入微指令，比放系统提示词多 15% 工具执行）、死循环时换模型从干净上下文给方案、注入 ephemeral 且核心提示词不动（保缓存、成本降 90%）
- **Anthropic 官方立场**：最简可行方案优先；workflow 用于可预测性、agent 用于灵活性
- ⇒ 市场赢家的生成核心无预编排工作流；其结构长在「运行时反馈 / 决策时干预 / 权限与预算硬闸」
- **注意证据的边界**：上述案例均为「免费/即时预览 + 无强制 HITL 闸门」场景，只反证「工作流非生成核心的必要条件」，**不等于**对本产品（按次付费 + 线框闸门 + 非技术受众）的 loop-first 更优已获证明

### 7. 终态架构建议（我方建议，用户未表态）
```
对话（唯一输入界面；预览/编辑器退化为输出面 + Agent 工具的调用对象）
  └─ Agent Loop 主干（旅程决策权归模型：何时访谈、何时出线框、何时生成）
       ├─ 细工具面：文件六 + 图片四 + 三门禁工具 + 旅程工具（访谈/线框/确认）
       ├─ Skill 资产：六模板、访谈方法论、质检标准（提示词侧）
       ├─ 决策时引导：Replit 模式（可选，后期）
       └─ 硬岛（非谈判区）：计费状态机（冻结/结算/退款）· approval 权限 · 五层护栏
反馈闭环：L0 静态部署 + L1 mock 预览（相当于廉价版 WebContainer 角色）
XState 去向：降级为 fallback 与强制地板（门禁必须过才能 done），最终可被工具事实推导取代
```
辨析结论（回应「CLI + Loop 是否更利于 Skill 化」）：**Skill 化与工作流正交**。Skill 化的三要素是工具注册、权限模型、提示词资产——DSH 的结构证明它们与循环策略分家。真正被工作流挡住的是**模型的旅程决策权**，由迁移阶段 1→2 解决。另注：不要给真 shell（付费多用户产品的沙箱纪律不可破）；要取的是「细粒度、可组合、带可读输出的效果工具」这一本质。

### 8. 三份重建承诺（拆工作流的真实代价）
1. **退款锚**：由 phase/里程碑改为从**工具事实**推导（文件写入数、门禁通过记录）；或保留极小「计费状态机」（冻结→结算→退款）与旅程解耦。（**未验证假设**：工具事实是否足以覆盖现退款粒度——未做技术验证，开工前先验证）
2. **闸门变工具**：线框确认从 HTTP 端点变对话内 approval 工具（DSH `ask_user_question` 模式），确认动作必须绑人类消息（模型不可代答）
3. **评估先行**（Replit 教训）：现有 144 测试全在「假 LLM + 行为等价」范式下；切到模型驾驶前必须先有**真实渠道 eval**（至少 20 条黄金旅程脚本）。**没有评估的 loop-first 是信仰切换，不是工程切换**

### 9. 迁移路径
- **阶段 0**（信息流修复，可立即做，与 Skill 化解耦）：① 服务端注入访谈结论 + 线框进 codegen system；② blocker 稳定代码枚举（现为自由文本拼接）
- **阶段 1**（服务端收口旅程）：新增统一对话端点，服务端按 `run.phase` 决定本轮动作（**规则引擎，零模型决策**）；前端 `journeyPhase` 状态机退役、卡片渲染改事件驱动（复用现有卡片组件）；旧三端点保留作灰度兼容。（**未验证假设**：「新旧通道产出等价 phase 序列」未做技术验证——阶段 1 开工第一件事是先写这个对比脚本，否则「行为等价」只是说法）
- **阶段 2**（模型接管决策）：统一入口每轮变为模型驱动（system 给 run 状态 + 结论 + 线框，暴露 phase 白名单工具面）；规则引擎降级为 fallback；**切换门槛 = 真实渠道评估体系就位**
- **阶段 3**（远期）：Java 业务端点逐个工具化（历史/应用管理/部署/充值——Java API 表面即工具清单）；跨 run 会话记忆；提示词资产 Skill 化
- 与 P4（RAG + 盈利 MVP）的关系：阶段 0 随时可插；阶段 1 可独立排期；**阶段 2 建议 P4 之后独立设计轮**

## Verification

本轮为架构讨论，**无产品代码变更**；本文件自身的恢复/更新已提交（`85de375`、`e817719`）。结论依据：
- **代码阅读**（多轮）：`workflow/index.ts`、`workflow/machine.ts`、`server/agentRoutes.ts`、`interview/conduct.ts`、`protocol/events.ts`、前端 `AppChatPage.vue`、`docs/ts_agent/architecture.md`、`progress.md`
- **DSH 本地包文档**：`dsh-agent-loop` / `dsh-goal` / `dsh-goal-round-driver` / `dsh-tool-goal` / `dsh-tool-ralph` 的 `README.zh.md`
- **网络一手来源**：Replit 官方工程博客、PostHog 对 bolt.new CTO 访谈、Anthropic 官方双文
- **独立来源**：Antigravity Lab（n=1 自报数据，弱于官方但方向一致）
- **证据边界（诚实声明）**：本环境搜索通道退化（firecrawl 403 / DuckDuckGo 限流，Bing 结果泛化）；**v0 / Lovable 未取得一手架构来源，故未纳入论据**；学术文献未触达

## Authoritative References

### 项目内
- 当前权威架构：`docs/ts_agent/architecture.md`（§3.1 收敛纪律、§3.5 中止/续传、§4 闸门纪律、§6 三工位、§11 实施顺序）
- 实施进度与证据：`docs/ts_agent/progress.md`；契约：`docs/ts_agent/contract.md`；对等报告：`docs/ts_agent/contract-parity.md`
- 跨会话记忆：`MEMORY.md`、`.agents/memories/ts-agent.md`
- 前端旅程实现：`paimeng-ai-code-mother-frontend/src/pages/app/AppChatPage.vue`
- Issue 流程：`docs/agents/issue-tracker.md`（gh CLI；父 issue #1）
- 测试与运行：原生 Linux/Windows 用 `cd paimeng-ai-code-agent && npm run <test|type-check>`；WSL 宿主用 `bash scripts/run-wsl.sh <test|type-check>`（见 `.agents/skills/project-startup-guardrail/SKILL.md`）

### 外部证据（含抓取时间与局限）
- [Anthropic: Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)（2024-12）：workflows vs agents；evaluator-optimizer；最简可行方案
- [Anthropic: Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)（2025-09）：工具合并；粒度判据；工具返回值设计
- [Replit: Decision-Time Guidance](https://replit.com/blog/decision-time-guidance)（2026-01）：rails and signals；决策时引导
- [PostHog: How bolt.new works](https://newsletter.posthog.com/p/from-0-to-40m-arr-inside-the-tech)（2025-09）：单提示词 + WebContainer 运行时
- [Antigravity Lab: Bundle or Split](https://antigravitylab.net/en/articles/agents/antigravity-agent-tool-granularity-design)（2026-06）：bundle by intent / split by reversibility
- 注：以上页面均经 `read_page` 直抓成功；`www.anthropic.com` 经 `web_fetch` 因 DNS 受限失败，需走 `read_page`

### DSH 参考（本地绝对路径，便于下一会话直接重读）
`/home/zdan/.nvm/versions/node/v24.20.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`
- `dsh-agent-loop/README.zh.md`：唯一具象循环；无内置轮次预算；步骤/工具流水线
- `dsh-goal/README.zh.md`：状态非调度；事件溯源 + CAS 修订栅栏；round 上限默认 256
- `dsh-goal-round-driver/README.zh.md`：调度；先预留后准入；人类消息让行；`round-limit` blocker
- `dsh-tool-goal/README.zh.md`：权限规则（create/edit/pause/resume 须人类直接消息；blocked 连续 ≥3 轮）
- `dsh-tool-ralph/README.zh.md`：固定脚本；全新子 agent 零种子；工作区即长期记忆；有界报告

## Recommended Next Work

1. **阶段 0 立 issue（可立即做，独立于 Skill 化）**——流程见 `docs/agents/issue-tracker.md`（gh CLI；父 issue #1）；有验收项的 issue 交付时须逐条勾选 Acceptance criteria：
   - **① 服务端注入访谈结论 + 线框进 codegen system**
     - 落点：`paimeng-ai-code-agent/src/generation/workflow/index.ts` 的 `codegenSystem` 组装处（当前仅 codegen 提示词 + 质检意见 + 档位 + 更早摘要）
     - 数据来源：`run.context.interview`（经 `interview/context.ts` 的 `parseContext` 解析；摘要形态见 `interview/index.ts` 的 `buildSummary`）与 `run.context.wireframe.relativeUrl`；路由 `agentRoutes.ts:259-273` 已解析出 `wireframePath`，可一并传入 workflow 而非只给 review
     - 验收：断言 system 文本含访谈五维结论与线框内容（假 LLM 剧本可断言）；真实渠道抽查一次生成，确认不再依赖前端伪 assistant 消息（对应删除 `AppChatPage.vue:889-897` 的隐式契约）
   - **② blocker 稳定代码枚举**
     - 落点：`workflow/index.ts` 的 `fail()` 调用点（现为自由文本拼接）
     - 变更：稳定代码（`quality-gate-exhausted` / `limit-reached` / `guardrail-rejected`）+ 人话说明，双字段
     - 验收：三条失败路径各一条断言稳定代码的测试
   - 门禁：`npm run test` + `npm run type-check` 全绿（WSL 走 `bash scripts/run-wsl.sh test`）
2. **沉淀决策记录——已决：本轮不做**（用户 2026-09-10 决策「先不用」）：不写 `docs/ts_agent/architecture-evolution.md`；本轮结论**以本 handoff 为唯一载体**，后续如 P4 后设计轮确有需要，再评估是否沉淀——下一会话请勿自行创建该文档
3. **P4 后启动阶段 1**：服务端收口旅程（规则引擎版统一入口 + 前端 `journeyPhase` 退役 + 先写等价性对比脚本）
4. **阶段 2 前置条件**：真实渠道评估体系（≥20 条黄金旅程脚本）；评估通过后再切模型驾驶
5. **待用户决策的产品问题**：线框闸门（架构 §4）相对市场是「加摩擦」的选择（bolt/Replit 选立即生成 + 快速预览 + 迭代），值得在真实模型联调时 A/B 验证价值
6. **本文件待办（体裁层面的已知缺陷，用户已决定暂不处理）**：① 证据强度在 §5/§6 中仍与官方来源平铺，引用时请自行降级 n=1 来源；② §7/§9 是未来计划而非已完成状态，与 `Completed State` 小节标题不符；③ §1–§2 复述了 `docs/ts_agent/architecture.md` 与代码中的既有事实，存在漂移风险，冲突时以后者为准

## Suggested Skills

- `agent-design-review`：阶段 1/2 落地前审查正式方案设计（按八要素；本文件 §7/§9 是骨架）
- `memory-management`：本轮产出可复用架构决策（终态架构、迁移路径、三份重建承诺、粒度判据），需写入项目记忆
- `memory-quality-audit`：改动 `.agents/memories/` 或 `MEMORY.md` 后审查索引、事实与安全边界
- `codebase-design`：细化接缝时调用（门禁工具化、计费状态机与旅程解耦、`runGenerationWorkflow` 的「轮次策略 vs 循环机制」拆分）
- `code-review`：阶段 0/1 实施完成后审查改动
- `project-comment-style`：实施阶段写/补注释时
- `agents-md`：终态架构定型后若需更新 `AGENTS.md` 架构描述时

## Safety

- 本会话无产品代码变更、无敏感信息（未读取 `.env` / `application-local.yml`，讨论中未出现任何密钥、令牌、口令值）
- 后续实施遵守 `AGENTS.md` 硬约定：敏感文件不提交、测试分包与被测代码对称、Issue 验收须逐条勾选、改动必须提交（`[DSH Web/ZDAN]` 标注）
- **不擅自切换 `ts-agent.enabled`**（会改变代码生成可用链路；回退手段为 git 回滚）
- 阶段 2 切换前必须真实渠道评估体系就位，避免「信仰切换」
- 拆工作流涉及计费（退款锚）时，先落「计费状态机与旅程解耦」中间态，禁止在无评估条件下直接改扣费路径
