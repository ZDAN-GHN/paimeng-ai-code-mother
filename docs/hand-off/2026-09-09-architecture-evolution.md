# Handoff

## Context

用户质疑当前 XState 工作流是否是产品未来（Skill 化、AI Native 愿景）的正确基础。经过 6 轮架构讨论，结合 DSH 设计、市场证据（bolt.new、Replit）、Anthropic 官方指南，达成演进方向共识：**loop-first（循环为干、工具为枝）是正确终态**，但需重建三样东西（退款锚从工具事实推导、闸门变 approval 工具、真实模型评估体系先行）。

核心问题链：
1. planner→coder→reviewer 算 Agent Loop 吗？→ 两层拆分：内层有界工具循环是真 Agent Loop，外层 XState 是工作流
2. 对比 DSH 的 agent-loop / goal / round-driver / ralph 设计 → 发现 paimeng 是"goal 模式的特化收敛版"
3. 自审结论 → 修正会话层现状描述错误（当前连跨消息重跑都不存在，每旅程一次性）
4. Skill 化方案 → 三层粒度（旅程层粗、生成层细、质检层中）
5. 工具粒度讨论 → 质量来自 ground truth 反馈，不是步骤数
6. 根本问题：不用工作流是否有更好选择？→ 市场赢家（bolt 单提示词、Replit rails & signals）验证 loop-first

## Completed State

### 架构分析完成
- **两层拆分**：内层 coder 工位（streamText + stopWhen 双护栏 + 10 工具）是真 Agent Loop；外层 XState 状态机（interview→coding→review→done/failed）是工作流，转移由驱动代码决定
- **DSH 对照**：四件套正交分解（agent-loop=机制、goal=状态、round-driver=调度、ralph=新鲜 agent 迭代）；paimeng 的 generation_run ≈ goal 状态，wireframe_pending ≈ armed/disarmed，review 三重门禁 = DSH 缺的评估器
- **会话层现状修正**：当前会话层 = 每旅程一次生成、终态即闸门锁死、跨消息零生成记忆；续传按架构 §3.5 (b) 推迟未实施
- **Skill 化方案**：interview/wireframe/confirm/codegen 从 HTTP 端点降级为 Agent 工具；工作流边界收缩（XState 从旅程骨架降为 generate_code 内部实现）；事件协议零扩展（tool_request/tool_executed 承载交互卡）；闸门下沉（phase 白名单暴露工具 + 工具内服务端校验双保险）
- **工具粒度分析**：Anthropic 官方证据（合并高频链路、offload computation into tools reduces mistakes）+ Antigravity Lab 实测（细工具三失败模式：上下文膨胀 40%、中途迷失、半成品残留）；质量杠杆 = 可验证反馈（Anthropic），不是步骤数
- **市场证据**：bolt.new（$40M ARR，15 工程师）= 单一精心构造提示词 + 运行时（WebContainer）；Replit Agent = 自由循环 + 决策时引导（"rails and signals — not a locked track"）；两者生成核心均无预编排工作流
- **终态架构共识**：Agent Loop 主干（旅程决策权归模型）+ 细工具面（文件六 + 图片四 + 三门禁工具 + 旅程工具）+ Skill 资产（六模板、访谈方法论、质检标准）+ 硬岛（计费状态机、approval 权限、五层护栏）+ 决策时引导（Replit 模式，可选）；XState 降级为 fallback 与强制地板

### 迁移路径确定
- **阶段 0**（信息流修复，先行）：服务端注入访谈结论 + 线框进 codegen system；blocker 稳定代码枚举
- **阶段 1**（服务端收口旅程）：新增统一对话端点，服务端按 run.phase 决定本轮动作（规则引擎，零模型决策）；前端 journeyPhase 状态机退役，卡片渲染改事件驱动；行为等价迁移（可 e2e 对比）
- **阶段 2**（模型接管决策）：统一入口每轮变为模型驱动（system 给 run 状态 + 结论 + 线框，暴露白名单工具面）；规则引擎降级为 fallback；**切换门槛 = 真实渠道评估体系就位**（Replit 教训）

### 三份重建承诺（拆工作流的代价）
1. **退款锚**：从 phase/里程碑改为从工具事实推导（文件写入数、门禁通过记录）；或保留极小"计费状态机"（冻结→结算→退款）与旅程解耦
2. **闸门变工具**：线框确认从 HTTP 端点变对话内 approval 工具（DSH ask_user_question 模式），确认动作必须绑人类消息（模型不可代答）
3. **评估先行**：现有 144 测试全在"假 LLM + 行为等价"范式下；切到模型驾驶前必须先有真实渠道的 eval（哪怕 20 条黄金旅程脚本）；没有评估的 loop-first 是信仰切换，不是工程切换

## Verification

本轮为架构讨论，无代码变更。结论基于：
- 代码阅读（四轮）：workflow/machine/agentRoutes/前端旅程/DSH 五包
- 网络一手来源：Replit 官方工程博客、PostHog 对 bolt.new CTO 访谈、Anthropic 双文
- 独立实践者来源：Antigravity Lab（n=1，弱于官方但方向一致）
- 需求约束：架构文档（按次计费 + 退款、非技术受众、HITL 闸门）

## Authoritative References

### 项目内
- 当前权威架构：`docs/ts_agent/architecture.md`
- 实施进度：`docs/ts_agent/progress.md`
- 跨会话记忆：`MEMORY.md`、`.agents/memories/ts-agent.md`

### 外部证据
- [Anthropic: Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)（2024-12）：workflows vs agents；evaluator-optimizer workflow；最简可行方案原则
- [Anthropic: Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)（2025-09）：合并高频链路；offload computation into tools reduces mistakes；工具粒度判据
- [Replit: Decision-Time Guidance](https://replit.com/blog/decision-time-guidance)（2026-01）：rails and signals；决策时引导层；分类器注入微指令
- [PostHog: How bolt.new works](https://newsletter.posthog.com/p/from-0-to-40m-arr-inside-the-tech)（2025-09）：单一提示词 + 运行时（WebContainer）；$40M ARR、15 工程师
- [Antigravity Lab: Bundle or Split](https://antigravitylab.net/en/articles/agents/antigravity-agent-tool-granularity-design)（2026-06）：细工具三失败模式；bundle by intent, split by reversibility；实测数字

### DSH 参考（本地）
- `dsh-agent-loop`：机制（call model → run tools → repeat）；无内置轮次预算
- `dsh-goal`：状态（非调度）；事件溯源进会话日志；CAS 修订栅栏；round 上限
- `dsh-goal-round-driver`：调度；先预留后准入；人类消息让行自动轮
- `dsh-tool-ralph`：新鲜 agent 迭代；不可变目标；共享工作区 = 长期记忆
- `dsh-tool-goal`：模型侧 goal 工具；权限规则（create/edit 需人类直接消息）

## Recommended Next Work

1. **阶段 0 立 issue**：服务端注入访谈结论 + 线框进 codegen system；blocker 稳定代码枚举（独立于 Skill 化，可立即做）
2. **沉淀决策记录**：把本轮结论（市场对照 + 终态架构 + 评估先行的切换判据）写成 `docs/ts_agent/architecture-evolution.md`，供后续 P4 后的设计轮引用
3. **P4 后启动阶段 1**：服务端收口旅程（规则引擎版统一入口，行为等价迁移）
4. **阶段 2 前置条件**：真实渠道评估体系（至少 20 条黄金旅程脚本）；评估通过后再切模型驾驶
5. **产品决策复核**：线框闸门（架构 §4）相对市场是加摩擦的选择，值得在真实模型联调时 A/B 验证其价值（bolt/Replit 选择立即生成 + 快速预览 + 迭代）

## Suggested Skills

- `agent-design-review`: 阶段 1/2 落地前审查正式方案设计（按八要素）
- `memory-management`: 本轮产生可复用架构决策（终态架构、迁移路径、三份重建承诺），需更新项目记忆
- `memory-quality-audit`: 修改记忆后审查索引、事实和安全边界
- `codebase-design`: 后续细化模块接口（如门禁工具化、计费状态机解耦）时调用
- `agents-md`: 若终态架构定型后需更新 AGENTS.md 的架构描述
- `code-review`: 阶段 0/1 实施完成后审查改动

## Safety

- 本轮为架构讨论，无代码变更，无敏感信息泄露风险
- 后续实施阶段 0/1 时，遵守 `AGENTS.md` 硬约定：敏感文件不提交、测试分包对称、Issue 验收硬门槛
- 不擅自切换 `ts-agent.enabled`（会改变代码生成可用链路）
- 阶段 2 切换前必须真实渠道评估体系就位，避免信仰切换
