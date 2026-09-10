# Handoff（启动包）：TS Agent 阶段 0 开工指引

> **读者**：接手本任务的下一棒 Agent。本文件是**行动入口**，不是论证材料。
> **配套文档**：`docs/hand-off/2026-09-09-architecture-evolution.md`（纪要版，记录一场 7 轮架构讨论的完整论证）。两份**并存、分工不同**：本文件说「做什么 / 别做什么」，纪要版说「为什么这么想」。两者冲突时——**行动与边界以本文件为准，论证与证据细节以纪要版为准**。
> **关键状态**：纪要版里的方向结论（loop-first、三阶段迁移、三份重建承诺）是**我方建议，用户尚未表态**。不要当既成决策，不要据此启动重构。
> 生成于 2026-09-10，对应 HEAD `e9ea6ab`（工作树干净）。

## 0. 三十秒

| 项 | 位置 |
|---|---|
| **现在就能做**：阶段 0 两个缺口（与所有架构争论无关） | §1 |
| **不能碰**：`ts-agent.enabled`、阶段 1/2 重构、计费路径、沙箱、纪要版文档 | §2 |
| **开工前必须自己验证**的假设 | §4 |
| **尚未裁决**的分歧（勿代为决策） | §5 |

## 1. 现在要做什么：阶段 0 两个缺口

立 issue 走 `docs/agents/issue-tracker.md`（gh CLI，父 issue #1）。有验收项的 issue，交付时须逐条勾选 Acceptance criteria（本仓库硬门槛）。

### 1.1 缺口 ①：服务端注入访谈结论 + 线框进 codegen system

**为什么**：架构 §4 规定「用户确认的线框即 codegen 布局契约」，但实现只在 review 阶段把它当视觉 diff 基准，**coder 的 system 里没有线框**；访谈结论则靠前端拼一条伪 assistant 消息注入（`AppChatPage.vue:889-897`），前端一改版就静默丢失需求上下文。

**落点**：
- system 组装处：`paimeng-ai-code-agent/src/generation/workflow/index.ts` 的 `codegenSystem`（当前仅 codegen 提示词 + 质检意见 + 档位 + 更早摘要）
- 数据来源：`run.context.interview`（`interview/context.ts` 的 `parseContext` 解析；摘要形态见 `interview/index.ts` 的 `buildSummary`）、`run.context.wireframe.relativeUrl`
- 传参接缝：路由 `agentRoutes.ts:259-273` 已解析出 `wireframePath` 但只传给 review，需把「访谈结论 + 线框」一并传进 workflow（涉及 `StreamRequest` / `WorkflowOptions` 接口加字段）
- **待定决策**：线框是单文件 HTML，注入方式是全文 vs 摘要/页面清单——注意架构 §3.3 输入侧有界（token 成本）

**验收**：
- 断言 system 文本含五维结论与线框内容（假 LLM 剧本可断言）
- 真实渠道抽查一次完整生成
- 解除对前端伪消息的隐式契约（可删 `AppChatPage.vue:889-897` 的 summary 拼接，或保留但不再依赖）

### 1.2 缺口 ②：blocker 稳定代码枚举

**现状**：失败路径是自由文本拼接（`workflow/index.ts` 的 `fail()` 调用点，如「重试次数已用尽…」+ 门禁 errors join），调用方与埋点无法按类型分流。

**变更**：稳定代码（`quality-gate-exhausted` / `limit-reached` / `guardrail-rejected`）+ 人话说明，双字段。

**先决策再动手（易踩坑）**——稳定代码放哪里：
- SSE `error` 事件当前只有 `message` 单字段（`protocol/events.ts`）；加字段 = **wire 契约变更**，须同步 `docs/ts_agent/contract.md` + 前端解析
- 或先只走 Java 内部回调（`notifyComplete` 的 `errorMessage`），不动 wire

建议在 issue 里先定这一项，再实施。

**验收**：三条失败路径各一条断言稳定代码的测试。

### 1.3 门禁与提交

- 测试/类型：`cd paimeng-ai-code-agent && npm run test && npm run type-check`（原生 Linux / Windows）；**WSL 宿主**改走 `bash scripts/run-wsl.sh test`
- 基线：144/144（`docs/ts_agent/progress.md` 记录，本会话未复跑）
- 测试文件须与被测源码路径**对称分包**（含子目录）；helpers/fixtures 放测试树顶层
- 每笔改动必须 commit，标注 `[DSH Web/ZDAN]`

## 2. 边界（不要做什么）

- ❌ **不擅自切换 `ts-agent.enabled`**（会改变代码生成可用链路；回退手段为 git 回滚）
- ❌ **不创建 `docs/ts_agent/architecture-evolution.md`**——用户 2026-09-10 已决策「先不用」
- ❌ **不启动阶段 1/2 重构**（loop-first 用户未表态；阶段 2 另有硬门槛，见 §4）
- ❌ **不修改** `docs/hand-off/2026-09-09-architecture-evolution.md`（用户明确要求保持不动）
- ❌ **不给生成物真 shell、不放松工作区沙箱**（付费多用户产品；沙箱先例见 `generation/workspace.ts`）
- ❌ **不在评估体系就位前改动计费/退款路径**（退款锚迁移属未验证假设，见 §4）
- ❌ 敏感文件不提交（各服务 `.env`、`application-local.yml`）

## 3. 背景（读这些就够，不必通读全仓）

产品 = 自然语言生成、预览、部署零代码应用，受众为非技术用户（「一句话一个软件」）。
三服务：Java（业务 / 鉴权 / 积分 / 构建）、TS Agent（生成主链路）、Python RAG（P4，未接主链路）。
生成链路：登录换短时 JWT → 浏览器 fetch-SSE 直连 `POST /agent/stream` → XState 线性工作流（`interview→coding→review→done/failed`）→ 内层 AI SDK 工具循环（文件六 + 图片四）→ 回调 Java 结算积分 / 写历史 / 触发构建。

权威资料（唯一真源，勿依赖二手转述）：`docs/ts_agent/architecture.md`（§3.1 收敛纪律、§3.3 护栏、§3.5 中止/续传、§4 闸门纪律、§6 三工位、§7 计费、§11 实施顺序）、`docs/ts_agent/progress.md`、`docs/ts_agent/contract.md`。

本目录纪要版记录了一场「工作流 vs Agent Loop 该走哪条路」的讨论；**其结论尚待用户裁决，与本文件 §1 的工作无关**。

## 4. 开工前必验的假设（别把上一棒的推断当地基）

| 假设 | 为什么重要 | 验证方式 |
|---|---|---|
| 「新旧通道能产出等价 phase 序列」 | 阶段 1（服务端收口旅程）的「行为等价」前提 | 写对比脚本：同一旅程脚本分别跑旧三端点与新统一入口，比对 `run.phase` 序列——**阶段 1 开工第一件事** |
| 「退款锚可从工具事实推导」 | 决定能否去掉 phase 作为退款依据 | 用现规则反推（aborted 折算：里程碑 ≥3 计 70%，否则 50%），看工具事实能否复现同一判定 |
| 「真实渠道评估体系可在 P4 后建成」 | 阶段 2 的硬门槛；无评估就切模型驾驶 = 信仰切换 | 先做最小 eval：≥20 条黄金旅程脚本（现有 144 测试全在假 LLM 范式下） |
| 「bolt / Replit 证据可外推到本产品」 | 两者是免费 / 即时预览、无强制 HITL 闸门场景 | 标为**未证**；若要对齐需真实模型 A/B |
| 线框闸门是否值得保留 | 相对市场是「加摩擦」的选择 | 真实模型联调时 A/B 验证价值 |

**已核实的前提（可直接用，无需重验）**：
- coder 看不到线框（`agentRoutes.ts:259-273` 只传给 review；`workflow/index.ts` 的 `codegenSystem` 无 wireframe）
- 访谈结论经前端伪 assistant 消息注入（`AppChatPage.vue:889-897`），服务端不注入
- 同一 run 生成后不可再开流（`agentRoutes.ts:256`：非 `wireframe_confirmed` → 409；done/aborted 均为终态）⇒ 跨消息零生成记忆
- stream 内 planner 工位无 LLM（`workflow/index.ts:264-273` 仅 Guardrail + 一条 thinking）
- build 门禁对 `multi_file`/`vue_project` 为占位、视觉 diff 为启发式 ⇒ 非 html 类型实际约「一道半门禁」

## 5. 尚未裁决的分歧（用户未表态，勿代为决策）

1. **loop-first 是否为正确终态**（纪要版 §7 是**建议**，非结论）
2. **三份重建承诺是否接受**（退款锚迁移 / 闸门变 approval 工具 / 评估先行）
3. **迁移阶段 1、2 的排期**（建议排在 P4 之后，走独立设计轮）
4. **线框闸门的产品去留**（§4 末行）

要推进这些：先按 `agent-design-review` 出正式方案设计（八要素）再送用户裁决——**不要先改代码**。

## 6. 参考

### 项目内
- 架构 / 进度 / 契约 / 对等报告：`docs/ts_agent/{architecture,progress,contract,contract-parity}.md`
- 跨会话记忆：`MEMORY.md`、`.agents/memories/ts-agent.md`
- 前端旅程实现：`paimeng-ai-code-mother-frontend/src/pages/app/AppChatPage.vue`
- Issue 流程：`docs/agents/issue-tracker.md`（gh CLI；父 issue #1）
- 启动 / 运行时环境分流：`.agents/skills/project-startup-guardrail/SKILL.md`
- 纪要版 handoff：`docs/hand-off/2026-09-09-architecture-evolution.md`

### 外部证据（按强度分级，勿混用）

**A 级（官方文档 / 一手访谈）**
- Anthropic《Building effective agents》—— workflows vs agents、evaluator-optimizer、最简可行方案：https://www.anthropic.com/engineering/building-effective-agents
- Anthropic《Writing effective tools for agents》—— 合并高频链路、offload 降低出错、工具粒度判据：https://www.anthropic.com/engineering/writing-tools-for-agents
- Replit《Decision-Time Guidance》—— 「rails and signals, not a locked track」、决策时引导：https://replit.com/blog/decision-time-guidance
- PostHog《How bolt.new works》（含 CTO、创始工程师一手访谈）—— 单一提示词 + WebContainer 运行时：https://newsletter.posthog.com/p/from-0-to-40m-arr-inside-the-tech

**B 级（独立实践者，n=1 自报数据，仅作方向参考）**
- Antigravity Lab《Bundle or Split?》—— bundle by intent / split by reversibility：https://antigravitylab.net/en/articles/agents/antigravity-agent-tool-granularity-design

**证据缺口（勿当已证）**：v0 / Lovable 无一手架构来源；学术文献未触达；本环境搜索通道退化（firecrawl 403 / DuckDuckGo 限流，Bing 结果泛化）。
**抓取注意**：`www.anthropic.com` 走 `web_fetch` 会因 DNS 受限失败，须用 `read_page`。

### DSH 参考（本地绝对路径，便于直接重读）
`/home/zdan/.nvm/versions/node/v24.20.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`
- `dsh-agent-loop/README.zh.md`：机制（调模型 → 跑工具 → 重复）；无内置轮次预算
- `dsh-goal/README.zh.md`：状态（非调度）；事件溯源 + CAS 修订栅栏；round 上限默认 256
- `dsh-goal-round-driver/README.zh.md`：调度；先预留后准入；人类消息让行；`round-limit` blocker
- `dsh-tool-goal/README.zh.md`：权限规则（create/edit/pause/resume 须人类直接消息；blocked 连续 ≥3 轮）
- `dsh-tool-ralph/README.zh.md`：固定脚本；全新子 agent 零对话种子；工作区即长期记忆

## 7. Suggested skills

| 技能 | 何时调用 |
|---|---|
| `codebase-design` | 缺口 ① 改 `StreamRequest`/`WorkflowOptions` 接缝、缺口 ② 定稳定代码承载位置时——先定接口再动手 |
| `code-review` | 阶段 0 改动完成后、提交前自查（本仓库硬约定） |
| `project-comment-style` | 写或补注释时 |
| `agent-design-review` | 要推进阶段 1/2 时：先出正式方案设计（八要素）再送审，**不要直接改代码** |
| `memory-management` | 阶段 0 完成后，把新事实 / 约束 / 踩坑写入项目记忆 |
| `memory-quality-audit` | 改动 `.agents/memories/` 或 `MEMORY.md` 之后 |
| `agents-md` | 终态架构被用户正式采纳、需更新 `AGENTS.md` 描述时 |

## 8. 安全

- 本文件不含任何密钥 / 令牌 / 口令；未读取各服务 `.env`、`application-local.yml`
- 遵守 `AGENTS.md` 硬约定：敏感文件不提交、测试分包对称、Issue 验收逐条勾选、改动必提交（`[DSH Web/ZDAN]`）、运行时环境按宿主分流（原生 Linux/Windows 用默认目录，仅 WSL 用 `wsl-rt-env/` + `*-wsl.sh`）
- 不在未获用户批准前触碰代码生成可用链路与计费路径
