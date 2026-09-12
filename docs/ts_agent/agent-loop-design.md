# Agent Loop 改造方案设计（事件溯源状态层 + 模型接管旅程决策）

> **状态**：方案设计，2026-09-10 经 17 轮设计审讯 + J 系列裁决后定稿（J1/J3 由用户修正）。
> **性质**：这是「交付给 Agent 落地实现」的方案设计，不是讨论纪要。依据见 §0，结论冲突时以本文为准；`docs/ts_agent/architecture.md` 仍为**当前实现**的架构权威，本文描述**目标态**。
> **审查**：已按 `agent-design-review` 八要素做独立审查，结论 **PASS-WITH-FIXES（阻塞 0 / 高 7 / 中 10 / 建议 5）**，22 项问题已就地修订；J1/J3 裁决后的第二轮修订记录见 §10，审查报告见 issue #25 评论。

## 0. 决策依据（本设计的来源，勿重新论证）

### 0.1 审讯已决项（Q1–Q17）

| 编号 | 决策 | 内容 |
|---|---|---|
| Q1 | 移植范围 | 移植 DSH 的 **(b) 事件溯源状态层**（append-only 事件日志即唯一持久真相、序号连续、未知事件类型必须显式 `ignorable` 否则拒绝解释）与 **(a) loop 纪律**（数据驱动终止、无硬编码阶段序列）。**不引入 Cordis 事件总线**；**不整抄对外事件流**（DSH 用 WebSocket/JSON-RPC，本系统继续 SSE） |
| Q2 | 交付形态 | 出正式方案设计交用户裁决，**不直接改代码** |
| Q3 | 痛点优先级 | ① 跨消息零生成记忆（先做）→ ② 模型无旅程决策权（主目标）→ ③ Skill 化（自然结果）→ ④ 退款锚（只在真拆工作流时付账） |
| Q4 | XState 终局 | **降级**：loop 为主干，保留极小确定性状态机作 fallback 与「确定性门禁必须过才能 done」的强制地板。**非全退** |
| Q5 | 计费锚 | 先把 `phase+milestones` 定位为「计费上报接口」（规则不动）并补 `milestoneCount` 缺失告警；再离线验证工具事实能否复现同判定。**拆工作流与动钱在时间上切开** |
| Q6/Q9 | source 标记 | 引入「人类 / 模型 / 系统」来源标记；**花钱与不可逆动作的审批必须由代码强制来自人类**（见 J3） |
| Q7 | 落点 | 本文档 + 子 issue（挂父 issue #1） |
| Q8 | 阶段 0 | 与方案设计**并行推进**，立 issue 后即可开工（#23 / #24） |
| Q10 | 旅程可见面 | 访谈与线框确认**从「必经步骤」降级为「模型按需发起的澄清」**；固定五维题库退役 |
| Q11/Q12 | 不可逆动作 | 花钱、对外发布（部署上线）、**应用级删除/已部署产物**算不可逆；工作区内文件删除**不算**（模型可自由重构产物） |
| Q13 | 分期 | 原「阶段 1（规则引擎过渡）+ 阶段 2（模型接管）」**合并为一次改造**；原「等价性对比脚本」降级为**基线回归快照** |
| Q14 | 预算 | 成本预算为主 + 高步数上限作死循环兜底；步数不再对外当产品语义 |
| Q15 | 地板判定 | 分级：**确定性门禁**必须过；**启发式门禁**不阻断 done，只回流意见 |
| Q16 | 会话模型 | **app 级会话/记忆宿主 + run 级计费/门禁/审计单元**；改需求＝开新 run＝再计费 |
| Q17 | 稳定代码载体 | 只走 Java 内部回调（`AgentCompleteRequest` 加字段），SSE 事件本轮不动（阶段 0 范围内） |

### 0.2 裁决项（J 系列，2026-09-10 用户裁决）

| 编号 | 裁决结果 | 说明 |
|---|---|---|
| **J1** | ✅ **事件载体 = PG（用户修正原方案）** | 原稿把事件日志放在 MySQL 新表，**偏离了 `architecture.md:139` 的存储分工原则**。裁决改为 PG 存事件载体，与本项目既有原则「**交易归 MySQL**（业务 + chat_history + generation_run + 积分台账，同库同事务）；**记忆归 PG**（pgvector + JSONB 优势）」一致 |
| **J2** | ✅ **已裁决（2026-09-10）** | 澄清以「回合结束 + `awaiting_user` + 下次请求续跑」表达（否决长连接内暂停等人） |
| **J3** | ✅ **花钱动作做成模型工具 + 必须请求用户确认（用户修正原方案）** | 模型可调 `request_generation`；但**批准只能来自人类**（代码强制、fail-closed）。这意味着原文的 R1「source 强制在阶段 C 才需要」**提前到本设计生效** |
| **J4** | ✅ **已裁决（2026-09-10）** | run 生命周期保留极小 XState 状态机（否决删除 xstate 依赖） |
| **J5** | ✅ **已裁决（2026-09-10）** | 新端点 `POST /agent/turn`，旧三端点一次性退役 |
| **J6** | ✅ **已裁决（2026-09-10）** | 预算以 `maxTokenBudget` 为主控、`maxTurns` 仅兜底 |
| **J7** | ✅ **已裁决（2026-09-10）** | `codeGenType` 非法值改预检 400（取消静默回退 `html`），`AgentTokenVO` 回传权威 `codeGenType` |

### 0.3 由 J1/J3 打开并已定的四个派生决策（2026-09-10，用户确认「符合想法」）

| 编号 | 决策 | 内容 |
|---|---|---|
| **D1** | 谁写 PG | **TS Agent 直连 PG**（写事件 + 重放读）。纪律原文禁止的是「TS 直连 **MySQL**（业务数据经 Java 回调）」——防的是业务账被旁路，而事件日志是**记忆不是账**；RAG 侧亦有直连 DB 先例（day-1 直查 MySQL 业务表视图） |
| **D2** | PG 怎么起 | **`docker-compose.yml` 新增 postgres + pgvector 服务**（镜像 `pgvector/pgvector:pg16`，与 MySQL/Redis 同栈，`127.0.0.1:5432`），RAG v2 复用同一实例、**分库**。取代停用中的用户态 PG16 |
| **D3** | 是否投影 | **不投影**：`generation_run` 用途与内容**零变化**（计费锚/并发/续传），仍由既有 `PATCH /internal/runs/{runId}` 通道维护；会话上下文一律由 TS 重放 PG 事件获得。MySQL 的 `context` 退化为陈旧副本（保留兼容读，不再作为真相） |
| **D4** | 审批原语 | 做成**通用 approval seam**（阶段 C 的部署/删除/充值复用），并采用 **fail-closed**：没有人类审批记录就拒绝花钱/不可逆动作（对齐 DSH「missing approval support turns `ask` into denial」） |

### 0.4 派生推论

- **R1（已提前生效）**：花钱动作被工具化（J3）⇒ 其审批必须由**代码**保证来自人类。对照 DSH：`dsh-tool-goal` 的 `requireDirectHuman()` 是代码强制，「非人类生产方必须自报 source、不能继承人类权限」；而 `dsh-tool-ralph` 只靠提示词措辞，DSH 自己把它标为「worker 报告，不是独立认证」——**本设计取前者**。
- **R2**：线框必须继续落盘且可被再次注入——跨消息续传时模型看不到上一 run 的规划；视觉 diff 门禁以线框为基准。故阶段 0 缺口① 保留，但语义从「注入用户确认的线框」改为「注入模型规划产物 + 地板基准」。
- **R3**：eval 体系必须进设计范围并先于切换就位（无评估的 loop-first 是信仰切换，不是工程切换）。
- **R4**：**里程碑语义必须与现状等价**（详见 §3.2 约束 6）。
- **R5（J1 的替代保证）**：事件在 PG、计费锚在 MySQL ⇒ **跨库无同事务**。替代保证是「**事件是真相、读模型可重放重建**」：投影/读模型可丢弃重建，因此不需要跨库事务；而**记账原子性仍在 MySQL 内部**（`credit_ledger` + `user.credits` 同库同事务），事件日志**不参与记账**，故跨库不原子不影响钱。

---

## 1. 目标与背景

**目标**：把「XState 刚性工作流 + 内层工具循环」改造成「单一 Agent Loop + 事件溯源状态 + 模型按需澄清」，交付物是**可运行的 TS Agent 统一回合端点 + PG 会话事件地基 + 前端事件驱动渲染**，使同一 app 的跨消息生成记忆成立、旅程决策权归模型。

**可验证的达成判据**（三条，全部由 §6 的命令或 eval 报告判定）：

1. 同一 app 连续两轮对话后发起生成，第二轮生成请求的 system 上下文**包含上一轮的用户消息与模型结论**（基线口径见下）；
2. 旅程步骤不再由服务端硬编码：访谈不再固定 5 维必经、线框不再必经确认（由 20 条黄金旅程的 eval 报告判定）；
3. 确定性门禁（build + 产物存在）在**所有**路径上都必须通过才可能 `done`，含超限截断路径（现有实现有一条跳过门禁的旁路）。

**判据 1 的基线口径**：基线以**阶段 0（#23）合并后的 HEAD** 为准。那一刻服务端已能注入本旅程内的会话结论，但**跨消息记忆仍为 0**（每旅程一次性、终态锁死，见 §3.3），故判据 1 的零点仍是 0，判据不变。

**背景**（3 句）：当前 TS Agent 的旅程是 XState 线性机（`interview→coding→review→done/failed`），转移由驱动代码依门禁判决发出，模型只在内层 `streamText` 工具循环里有决策权；该形态在「假 LLM + 固定剧本」的 P0–P3 阶段是正确的脚手架，但使跨消息记忆为零、访谈/线框内容也由脚本产生（`interview/index.ts:60-118` 固定题库、`workflow/index.ts:263-277` 无 LLM 调用）。改造的形态参照 DeepSeek Harness（DSH）的**事件溯源状态层**：append-only 事件日志是唯一持久真相，读模型由它派生。

## 2. 范围界定

### 2.1 In（本次交付）

| 项 | 内容 |
|---|---|
| 记忆地基 | PG 新增 append-only 会话事件日志（表 `session_event`）+ TS 侧读写实现（`src/session/`）；`docker-compose.yml` 新增 postgres+pgvector 服务 |
| TS Agent | 统一回合端点 `POST /agent/turn`；会话上下文重放；模型决策的工具面；**通用审批原语（fail-closed）**；两级地板；预算改造 |
| 前端 | `AppChatPage.vue` 的 `journeyPhase` 本地状态机退役，改事件驱动渲染；卡片组件改造；新增生成审批卡 |
| 计费 | `PATCH /internal/runs/{runId}` 保持为计费上报接口（规则不变）+ `milestoneCount` 缺失告警 + 退款锚离线验证脚本 |
| 评估 | 基线快照采集器 + ≥20 条黄金旅程脚本 + eval 报告（切换门槛） |
| 运维 | PG 服务的 compose 定义、初始化 SQL 挂载、`.env`/模板、部署与探活口径更新 |

> **不在本次交付范围**：阶段 0 的缺口①（#23）与缺口②（#24）由**独立子 issue** 负责，本设计只把它们列为前置依赖（§2.3），不在 §5 任务清单内，也不在本节 §3.1 的「要修改的文件」清单中实施。

### 2.2 Out（明确不做）

- ❌ **不引入 Cordis / 不依赖 `@deepseek-ai/*` 包**（技术上不可行：peer 依赖整套运行时图、只发 `lib/` 不发 `src/`、`latest` tag 陈旧）
- ❌ **不改动扣费规则与退款比例**（`CreditServiceImpl` 的 70%/50% 折算不动）；不在 eval 就位前改扣费路径
- ❌ **不给 `generation_run` 加新列、不改其用途**（D3：它是计费锚/并发/续传，不是事件日志的投影表）
- ❌ **不动 `ts-agent.enabled`**；回退手段 = git 回滚（架构 §10.0 既定纪律）
- ❌ **不放松工作区沙箱、不给生成物真 shell**（付费多用户产品红线）
- ❌ **不做 Java 业务端点工具化**（部署/应用管理/充值工具化属阶段 C；本设计只建**通用审批原语**供其复用，不注册那些动作）
- ❌ **不做跨 app / 跨用户记忆**（会话宿主 = 单个 app）
- ❌ **不删 XState 依赖**（Q4 保留极小状态机）；**不删 P0 的用户态 PG16 安装**（仅不再使用，保留待清理）
- ❌ 不修改 `docs/hand-off/2026-09-09-architecture-evolution.md`、不创建 `docs/ts_agent/architecture-evolution.md`

### 2.3 前置依赖

| 依赖 | 说明 |
|---|---|
| **阶段 0 已合并** | #23（服务端注入会话结论/规划产物）与 #24（blocker 稳定代码）是**前置**。**A0 采集基线用阶段 0 合并后的 HEAD；A3 开工前必须确认两者已合并** |
| **PG 服务可用（A1 产出）** | 事件日志是运行时强依赖：PG 不可用时会话无法记录，按 §3.2 约束 7 fail-closed（预检 503）。A2 起所有任务依赖 A1 |
| Java 内部 API 鉴权可用 | 复用 `internal-api.token`（Bearer），见 `application.yml:62-63`；run 创建与积分冻结沿用既有端点 |
| 基线快照已采集 | §5 的 A0 任务先于任何代码改动执行；无基线则 §1 判据 2 无法判定 |
| PG schema 变更约定 | 仓库无迁移框架（MySQL 侧靠 `sql/create_table.sql` + 手工 ALTER）。PG 侧定为 `sql/pg/init/*.sql`（compose 初始化挂载）+ 变更时手工 `ALTER` 并同步该目录，与 MySQL 惯例一致 |

## 3. 现状与约束

### 3.1 要修改的确切文件

**TS Agent**（`paimeng-ai-code-agent/`）

| 文件 | 处置 |
|---|---|
| `src/server/agentRoutes.ts` | 新增 `POST /agent/turn`；`/agent/interview`、`/agent/wireframe`、`/agent/wireframe/confirm`、`/agent/stream` 退役 |
| `src/generation/workflow/index.ts` | 拆分：生成回合逻辑移入 `src/turn/generationTurn.ts`；`sync()`/phase 上报保留为计费上报 |
| `src/generation/workflow/machine.ts` | 重写为 run 生命周期极小状态机（`awaiting_approval → generating → gated → done/failed/aborted`），删除 5 状态旅程拓扑；状态→phase 映射见 §4.6 |
| `src/protocol/events.ts` | 事件联合扩展：**全部事件（含 `done`/`error`）加 `seq`**；新增 `questions`、`wireframe`、`awaiting_user` |
| `src/interview/*` | `index.ts` 固定 5 维题库与 `conduct.ts` 脚本化访谈退役；`guardrails.ts` 保留并复用到统一回合入口；`context.ts` 的 `RunContext` 保留（迁至会话上下文） |
| `src/generation/review/index.ts` | 门禁分级：确定性/启发式两类在 `runReviewCycle` 分流（`review/types.ts` 的 `GATE_NAMES` 加类别字段） |
| `src/generation/intensity.ts` | `INTENSITY_TIERS` 增 `maxTokenBudget` 与调高的 `maxTurns`（§4.6） |
| 新建 `src/session/` | `pg.ts`（PG 连接池）、`events.ts`（事件类型与 `seq`/`source` 语义）、`store.ts`（追加 + 批次幂等 + 重放读 + 未知 kind 拒绝）、`context.ts`（会话上下文重建，供 system 组装） |
| 新建 `src/approval/` | `index.ts`（通用审批原语：`request()` / `decide()` / `assertHumanApproved()`，fail-closed） |
| 新建 `src/turn/` | `index.ts`（统一回合驱动）、`generationTurn.ts`（生成回合，自 `workflow/index.ts` 迁出）、`tools.ts`（会话回合工具面，含 `request_generation`）、`floor.ts`（两级地板装配） |
| 新建 `sql/pg/init/001_session_event.sql` | PG 建表 DDL（§4.2），compose 初始化挂载 |
| `package.json` / `.env.example` | 新增 `pg` 依赖与 `PG_*` 连接配置 |

**Java**（`src/main/java/com/zdan/paimengaicodemother/`）

| 文件 | 处置 |
|---|---|
| `model/vo/AgentTokenVO.java` | 增 `codeGenType`（由 Java 按 app 记录回传权威值，前端原样回传回合端点；见 §4.5 与 §4.9） |
| `service/impl/GenerationRunServiceImpl.java` | `milestoneCount` 缺失时也告警（现仅解析失败告警，`:363-374`）+ aborted 分支记录折算依据 |
| ~~事件表 / 事件服务 / 事件端点~~ | **J1 裁决后全部取消**（不再需要 MySQL 事件表、`GenerationEvent*`、事件内部端点） |
| ~~`model/dto/run/AgentCompleteRequest.java`~~ | **由阶段 0 子 issue #24 负责**（增 `errorCode`），本设计不实施 |

**前端**（`paimeng-ai-code-mother-frontend/`）

| 文件 | 处置 |
|---|---|
| `src/pages/app/AppChatPage.vue` | `journeyPhase` 四态机退役（`:402,:408,:410-412,:691,:701,:727,:741,:814,:818,:914,:956`）；`handleAgentEvent` 扩展新事件；删除 `:889-897` 伪 assistant history 拼接；线框预览沿用现有 `buildWireframeUrl`（`:776`） |
| `src/utils/agentSse.ts` | 事件类型扩展（`AgentStreamEvent` 加 `questions`/`wireframe`/`awaiting_user` 与 `seq`）；请求体改为 `{ appId, message, action?, approvalId?, intensity?, codeGenType?, workspacePath }`（`runId`/`history` 移除） |
| `src/components/InterviewQuestionsCard.vue` | 保留，**props 与字段名不变**（`questions: InterviewQuestion[]`、`round`）——事件载荷按现有字段命名（§4.5） |
| `src/components/WireframeReviewCard.vue` | 需**扩展 props**：现仅 `{ pageCount, disabled?, loading? }`，需增 `relativeUrl`/`version`（或由父组件承接预览）；三按钮新去向见 §4.5 |
| 新建 `src/components/GenerationApprovalCard.vue` | 生成审批卡（展示模型提议的生成摘要 + 预估积分 + 「开始生成 / 再改改」） |

**运维**

| 文件 | 处置 |
|---|---|
| `docker-compose.yml` | 新增 `postgres` 服务（`pgvector/pgvector:pg16`，`127.0.0.1:5432`，数据卷 `pg-data`，初始化挂载 `./sql/pg/init:/docker-entrypoint-initdb.d:ro`） |
| 仓库根 `.env` / 模板 | 增 `POSTGRES_*` 与 `PG_*`；敏感值只留 `*.example` 模板 |
| `.agents/memories/deployment.md` | 更新 PG 段（由「已停用，5432 不应监听」改为容器化启用 + runbook）与全栈探活口径（`:35`、`:97`） |

### 3.2 硬约束（不可协商）

1. **TS Agent 永不直连 MySQL**（架构 §1.1 红线）：业务数据只经 Java 回调。**PG 例外**（J1/D1）：事件日志是记忆不是账，TS 直连读写。
2. **计费链路不依赖 PG**：`generation_run`、`credit_ledger`、`user.credits` 的读写与事务完全在 MySQL 内，任何 PG 故障都不得影响记账正确性（R5/D3）。
3. run 创建与积分冻结沿用**既有内部端点与既有校验**（含「`phase == wireframe_confirmed` 才可冻结」，`GenerationRunServiceImpl.java:287-290`）；**不新增、不修改**计费规则。
4. `workspacePath` 的权威来源是 **Java**（`AgentTokenVO` 按 `CODE_OUTPUT_ROOT_DIR` 计算）：TS 只做沙箱校验，**不得自行推导**。
5. `phase` 枚举**九值不变**且新增 phase = 显式契约变更（架构 §3.1 纪律①）；新链路的状态必须映射到既有九值（§4.6）。
6. **里程碑语义等价（R4）**：新链路每次生成产生的里程碑数**不得低于现状的 4 条**（现状：`开始生成`/`规划页面结构`/`检查生成结果`/`生成完成`，`machine.ts:43,52-56,64-67,80`）。原因：aborted 折算阈值是 `milestoneCount >= 3 → 70%`（`CreditServiceImpl.java:42,299-305`），里程碑变少会让中断退款**静默**从 70% 掉到 50%。
7. **事件溯源纪律「模型可见即已记录」**：任何进入模型请求的内容必须先落 PG 事件（append 成功后才调模型）。因此 **PG 不可用 = 回合不可服务**：预检 **503**（与既有「Java 内部 API 未配置 → 503」同口径），**不得**降级为「不记录继续跑」。
8. **审批 fail-closed（J3/D4）**：没有**人类来源**的审批事件，就拒绝任何花钱/不可逆动作。审批记录一次性消费；无审批通道可用时按拒绝处理，不得放行。
9. 敏感文件不提交：根 `.env`、各服务 `.env`、`src/main/resources/application-local.yml`（只留 `*.example`）。
10. 测试分包与被测代码路径对称（含子目录）；helpers/fixtures 放测试树顶层（`test/helpers.ts`）。
11. 注释遵循 `project-comment-style`；Java 遵循阿里巴巴开发手册。
12. 运行时环境按宿主分流：原生 Linux/Windows 用默认目录与标准命令；**仅 WSL** 用 `wsl-rt-env/` + `*-wsl.sh`（`.agents/skills/project-startup-guardrail/SKILL.md`）。
13. 每笔改动必须 commit，标注 `[DSH Web/ZDAN]`。

### 3.3 现状关键事实（实现时必须知道，均已核实）

- XState 快照**从未持久化**（`getSnapshot()` 只用于比对，无序列化落库）；`architecture.md:70` 与 `sql/create_table.sql:69` 声称 `context` 存快照，实际只存 `RunContext{interview, wireframe}`。
- `run.milestones` 是 XState entry action 的副产品，与 `phase` 在 `workflow/index.ts:172-176` **同一次 PATCH 上报**；Java 只取 `JSONUtil.parseArray(...).size()`（`GenerationRunServiceImpl.java:369`）。
- 超限截断（`finishReason ∈ {tool-calls, length}`，判定在 `workflow/index.ts:364`）**跳过全部门禁直接 done**（`:389-400`，`contract.md:92` 记为取舍）——本设计要修掉。
- SSE 事件**无 `seq`、无事件 id、无版本号**（`protocol/events.ts:47-54`）；唯一 id 是 `toolCallId` 配对。
- 前端 `journeyPhase` 与 `generation_run.phase` **无数据通道**（前端零处读取 run 状态）；里程碑条来自 SSE `milestone` 事件。
- 测试：TS `test/` 共 **21 个 `.ts`**（20 个测试文件 + `test/helpers.ts`）+ 2 个 JSON 夹具，**基线 160/160**（`docs/ts_agent/progress.md` 最新条目，2026-09-08；144/144 是更早的 #11 时代数据）；**无任何测试 import `machine.ts` 或 xstate**；假 LLM 经**替换 AI SDK provider** 注入（`src/llm/index.ts`）；前端**零测试文件**；TS Agent **当前无任何 `pg`/DB 依赖**。
- PG 现状：**用户态 PG16 @127.0.0.1:5432 已停用**（无服务、无容器自启，5432 无监听；安装保留，runbook 见 `.agents/memories/deployment.md:35`）；`docker-compose.yml` **无 postgres 服务**（仅 mysql/redis/searxng/nginx）；既有验收口径写着「5432 停用后不应出现」（`deployment.md:97`）——**A1 必须同步改掉**。

## 4. 技术方案

### 4.1 总体形态

```
浏览器 ──fetch-SSE + JWT──> POST /agent/turn（唯一回合端点）
                                │
                                ├─ 回合 = 一次 HTTP 请求；服务端按会话上下文（PG 重放）+ 请求 action 决定回合类型
                                │    · 会话回合（免费）：模型可用 ask_user / write_wireframe / request_generation
                                │      终态 awaiting_user（reason=answered|asked|wireframe|approval）
                                │    · 生成回合（花钱）：仅当存在人类审批 → 冻结积分 → 生成循环 → 门禁 → done/failed
                                │
                                ├─ 事件与审批 ──> PG  session_event（append-only，真相；TS 直连）
                                └─ 计费上报 ──> Java PATCH /internal/runs/{runId}（phase + milestones，规则不变）
                                                 Java POST /internal/runs + credit/freeze（既有端点）

PG  session_event（真相，记忆）        ← 重放 →  TS 会话上下文（system 组装、审批校验）
MySQL generation_run / credit_ledger   ← 原地不动 →  计费锚 / 并发 / 续传（与 PG 无耦合）
```

**为什么是「回合」而不是「长连接内暂停等人」**：DSH 的 `ask_user_question` 在有持久连接（WebSocket）的宿主里可以原地暂停；本系统是 fetch-SSE + 反向代理，长挂连接会引入代理超时与断连语义。故澄清与审批都以「回合结束 + 事件留痕」表达：模型问完/提议完即结束回合（`awaiting_user`），用户回答或批准即下一次请求，服务端从 PG 重放上下文继续（这正是 Q1 选 (b) 才能支撑的形态）。

**J3 的审批时序**（花钱动作必须人类批准）：

```
会话回合：用户「做个宠物店官网」→ 模型调用 request_generation（提议）
          → 事件：generation/proposed(model) + approval/asked(system)
          → SSE：awaiting_user(reason=approval)     ← 回合结束，不扣费
用户点确认 → 前端发 POST /agent/turn { action: confirm_generation, approvalId }
          → 服务端 assertHumanApproved()：查 approval/decided，必须是 source=human 且未消费
          → 通过：事件 approval/decided(human) + run/start(human) → 调 Java 建 run（phase=wireframe_confirmed）
                  → 冻结积分 → 生成循环 → 门禁 → done
          → 不通过：预检 403（fail-closed，不冻结、不开跑）
```

### 4.2 数据结构（PG，完整 DDL）

**文件**：`sql/pg/init/001_session_event.sql`（compose 初始化挂载；变更时手工 `ALTER` 并同步本文件）

列名用 **snake_case**（PG 惯例；与 MySQL 侧的 camelCase 差异是有意的，跨库字段映射由 TS 的 `src/session/events.ts` 承担）。

```sql
-- session_event：会话事件日志（append-only，唯一持久真相）
-- 见 docs/ts_agent/agent-loop-design.md §4.2；属「记忆归 PG」（architecture.md:139），不参与记账
-- 有意取舍：append-only，无 is_delete / update_time；纠正走追加新事件，不做就地更新或软删
CREATE TABLE IF NOT EXISTS session_event
(
    id         BIGSERIAL   PRIMARY KEY,
    app_id     BIGINT      NOT NULL,                                   -- 会话宿主（一个 app 一条长期会话）
    user_id    BIGINT      NOT NULL,
    run_id     VARCHAR(64),                                            -- 所属 run；会话级事件为 NULL
    seq        BIGINT      NOT NULL,                                   -- 会话内单调序号，从 1 开始，连续无空洞
    turn_id    VARCHAR(64) NOT NULL,                                   -- 所属回合
    batch_seq  INTEGER     NOT NULL,                                   -- 回合内批次号，从 1 开始；同批事件共享
    event_index INTEGER     NOT NULL,                                   -- 批内事件序号，从 0 开始
    kind       VARCHAR(64) NOT NULL,                                   -- 事件类型（白名单见 §4.3）
    version    INTEGER     NOT NULL DEFAULT 1,                         -- 载荷版本；未知 kind 且 ignorable=false 时拒绝解释
    ignorable  BOOLEAN     NOT NULL DEFAULT FALSE,                     -- true=读路径可跳过该未知事件
    source     VARCHAR(16) NOT NULL,                                   -- human | model | system
    payload    JSONB       NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uk_app_seq UNIQUE (app_id, seq),
    CONSTRAINT uk_app_turn_batch_event UNIQUE (app_id, turn_id, batch_seq, event_index), -- 批内事件幂等键
    CONSTRAINT ck_batch_event_index CHECK (event_index >= 0),
    CONSTRAINT ck_source CHECK (source IN ('human', 'model', 'system'))
);

CREATE INDEX IF NOT EXISTS idx_run_id ON session_event (run_id);
CREATE INDEX IF NOT EXISTS idx_app_created ON session_event (app_id, created_at);
```

**幂等与 `seq` 分配（PG 原生，替代原 MySQL 方案的应用级锁）**：单事务内

```sql
-- 1) 取每 app 事务级互斥锁，保证 seq 连续无空洞
SELECT pg_advisory_xact_lock(hashtext($1));            -- $1 = app_id
-- 2) 分配 seq（同事务）
INSERT INTO session_event (app_id, user_id, run_id, seq, turn_id, batch_seq, event_index, kind, version, ignorable, source, payload)
SELECT $1, $2, $3,
       (SELECT COALESCE(MAX(seq), 0) FROM session_event WHERE app_id = $1) + 1,
       $4, $5, $6, $7, $8, $9, $10, $11::jsonb
ON CONFLICT (app_id, turn_id, batch_seq, event_index) DO NOTHING   -- 批内事件重放幂等
RETURNING seq;
```

- **幂等粒度 = 批内事件级**，批次身份仍是 `(app_id, turn_id, batch_seq)`，事件键为 `(app_id, turn_id, batch_seq, event_index)`。**禁止**用回合级键：一个回合必然产生 N 次 append，回合级键会让第 2 批起被丢弃，导致日志残缺。
- 同一批次的多个事件在同一事务内一次性插入（`batch_seq` 相同、`event_index` 从 0 连续递增、`seq` 连续递增）；重复同一批次的同一事件由唯一键幂等丢弃。

**`generation_run` 不变更 DDL、不改用途**（D3）：它仍是计费锚/并发/续传，由既有 `PATCH /internal/runs/{runId}` 通道维护；会话上下文一律重放 PG 得到，`generation_run.context` 退化为陈旧副本（保留兼容读）。

### 4.3 事件类型白名单（`kind` 取值与语义）

对照 DSH 的 `known-event-types` 纪律：**读路径遇到白名单外的 `kind` 且 `ignorable=false` 时拒绝解释**（抛错而非静默跳过），避免「静默重建出错误会话」；**写路径遇到白名单外的 `kind` 直接拒绝写入**（§4.4）。

| kind | source | payload 关键字段 | 语义 |
|---|---|---|---|
| `session/turn-start` | human | `{ turnId, action }` | 回合开始；`action ∈ chat\|confirm_generation` |
| `user/message` | human | `{ text }` | 人类消息（唯一能作为「人类意图」证据的事件） |
| `model/message` | model | `{ text }` | 模型面向用户的文本 |
| `model/thinking` | model | `{ text }` | 思考增量（可合并多条） |
| `tool/call` | model | `{ callId, name, arguments }` | 工具调用请求 |
| `tool/result` | system | `{ callId, ok, result }` | 工具执行结果 |
| `clarify/asked` | model | `{ itemKeys: string[] }` | 澄清问题已发出（配合 wire 事件 `questions`） |
| `clarify/answered` | human | `{ answers: [{ key, optionId }] }` | 人类已回答 |
| `wireframe/produced` | model | `{ relativeUrl, pageCount, version }` | 线框产物落盘（取代 `/agent/wireframe` 端点） |
| `wireframe/confirmed` | human | `{ version }` | 人类确认线框（**不强制**；`confirm_generation` 亦可直接开始生成） |
| `generation/proposed` | model | `{ reason, estimatedCredits }` | 模型**提议**开始生成（`request_generation` 工具产生；不扣费、不建 run） |
| `approval/asked` | system | `{ approvalId, action: 'start_generation', turnId }` | 审批请求已发出（配合 SSE `awaiting_user(reason=approval)`） |
| `approval/decided` | human | `{ approvalId, decision: 'allowed'\|'rejected' }` | **人类**裁决；`assertHumanApproved()` 只认 `source=human` 且未被消费的记录 |
| `run/start` | human | `{ runId, intensity, codeGenType, approvalId }` | run 创建 + 冻结积分的挂点（必须携带人类审批 id） |
| `run/phase` | system | `{ phase }` | 计费上报（**取值限九值枚举**，语义与现状一致） |
| `run/milestone` | system | `{ title, detail? }` | 里程碑（退款锚；语义等价约束见 §3.2 约束 6） |
| `run/token-usage` | system | `{ inputTokens, outputTokens, totalTokens }` | 计量 |
| `gate/verdict` | system | `{ gate, category, passed, detail }` | 门禁判决（`category ∈ deterministic\|heuristic`） |
| `run/end` | system | `{ status, filesWritten, errorCode? }` | run 终态；`status ∈ success\|failed\|aborted`（对齐 Java `AgentCompleteStatusEnum`），phase 派生：`success→done`、`failed→failed`、`aborted→aborted` |

### 4.4 PG 会话存储契约（TS 侧，非 HTTP）

接口落在 `paimeng-ai-code-agent/src/session/store.ts`（PG 连接池在 `pg.ts`，事件类型与 `seq`/`source` 语义在 `events.ts`）：

```ts
export interface SessionEventInput {
  kind: SessionEventKind;          // 白名单，见 §4.3；白名单外直接抛错（拒绝写入）
  version?: number;                // 默认 1
  ignorable?: boolean;             // 默认 false
  source: 'human' | 'model' | 'system';
  runId?: string | null;
  payload: Record<string, unknown>;
}

export interface SessionStore {
  /** 追加一批事件；返回本批 seq 区间。同 (appId, turnId, batchSeq) 重放返回首次结果，不重复追加；存储层为 events 分配 0 起连续 event_index */
  appendBatch(input: {
    appId: string; userId: string; turnId: string; batchSeq: number;
    events: SessionEventInput[];
  }): Promise<{ seqFrom: number; seqTo: number; firstSeqNext: number; appended: number }>;

  /** 按 seq 区间重放（升序）；遇到白名单外 kind 且 ignorable=false 时抛 UnknownEventKindError，不静默跳过 */
  replay(input: { appId: string; afterSeq?: number; limit?: number }):
    Promise<{ events: SessionEventRecord[]; lastSeq: number; hasMore: boolean }>;

  /** 审批校验（fail-closed）：该 approvalId 是否由 source=human 的 approval/decided 记录批准且未被消费 */
  assertHumanApproved(input: { appId: string; approvalId: string }):
    Promise<{ ok: true } | { ok: false; reason: string }>;
}
```

**四条实现约束**

1. **写入顺序**：`appendBatch` 成功**之后**才把同样内容送进模型请求（§3.2 约束 7）。
2. **失败语义**：连接失败 / `appendBatch` 抛错 → 回合以预检 **503**（尚未开流）或 SSE `error`（已开流）收尾，**不降级继续**。
3. **未知事件**：写路径白名单外 → 抛错（拒绝写入）；读路径白名单外且 `ignorable=false` → 抛 `UnknownEventKindError`，调用方必须处置（通常是 5xx / error 收尾），**不得**跳过该条继续重建上下文。
4. **不新增 PG 表以外的状态**：会话上下文 = `replay()` 的纯函数结果（`src/session/context.ts`），不缓存到 MySQL。

### 4.5 统一回合端点（TS Agent）

**请求** `POST /agent/turn`（`Authorization: Bearer <JWT>`）

```json
{
  "appId": "1001",
  "message": "做个宠物店官网，风格清爽一点",
  "action": "chat",
  "intensity": "standard",
  "codeGenType": "html",
  "workspacePath": "/repo/tmp/code_output/html_1001"
}
```

生成回合（人类批准后）的请求：

```json
{
  "appId": "1001",
  "action": "confirm_generation",
  "approvalId": "ap-3f9c21",
  "intensity": "standard",
  "codeGenType": "html",
  "workspacePath": "/repo/tmp/code_output/html_1001"
}
```

- `appId`、`action` 必填；`action ∈ chat | confirm_generation`。非法 `action` → 预检 **400**。
- `message` 在 `action=chat` 时必填且非空（空/纯空白 → 预检 **400**）；`action=confirm_generation` 时可选（可作补充说明）。
- `action=confirm_generation` 时 `approvalId` 必填；服务端调 `assertHumanApproved()`（fail-closed，§4.4）。**审批只能来自人类**：模型无法产生 `source=human` 的事件，故结构上不可代答；未通过 → 预检 **403**，不冻结、不建 run。
- `codeGenType` 与 `workspacePath` **均由 `GET /app/agent/token` 的响应提供、前端原样回传**（Java 为权威来源；本轮为 `AgentTokenVO` 增 `codeGenType`）。`codeGenType` 白名单 `html|multi_file|vue_project`，**非法或缺失 → 预检 400（取消现状的静默回退 html）**，理由见 §4.9。`workspacePath` 必须在 `WORKSPACE_ROOT` 内，越界 → 预检 400。
- `intensity` 白名单 `fast|standard|deep`；非法或缺失 → 回落 `standard`（保持现状语义，档位是用户偏好而非安全边界）。
- **请求体不含 `runId`／`history`**：runId 由服务端在 `run/start` 时生成；历史由 PG 重放重建。

**响应**：`text/event-stream; charset=utf-8`，帧格式不变（`event: <type>` + 单行 `data:` + 空行）。

**事件表（新增/变更部分）**

| event | 必填字段 | 变化 |
|---|---|---|
| 既有五类（`ai_thinking`/`ai_response`/`tool_request`/`tool_executed`/`milestone`） | 原字段 | **新增 `seq`**（源自事件日志序号） |
| `questions` | `type`, `seq`, `items` | **新增**。`items: [{ key, dimension, question, options: [{ id, text }] }]` —— **字段名与现有 `InterviewQuestion` 完全一致**（`agentSse.ts:56-61`），前端可直接透传给 `InterviewQuestionsCard`，无需映射层 |
| `wireframe` | `type`, `seq`, `relativeUrl`, `pageCount`, `version` | **新增**。前端用现有 `buildWireframeUrl(relativeUrl)`（`AppChatPage.vue:776`）拼预览 URL；`version` 用于确认动作的版本校验 |
| `awaiting_user` | `type`, `seq`, `reason` | **新增终态**。`reason ∈ answered\|asked\|wireframe\|approval`；**回合正常结束、等用户输入**，非 run 终态 |
| `done` | `type`, `seq` | **字段集与语义不变**（生成成功终态，最后一个事件），仅新增 `seq` |
| `error` | `type`, `seq`, `message` | **字段集与语义不变**（唯一失败终态），仅新增 `seq` |

**终态帧示例**

```text
event: awaiting_user
data: {"type":"awaiting_user","seq":47,"reason":"asked"}

event: awaiting_user
data: {"type":"awaiting_user","seq":52,"reason":"approval"}

event: done
data: {"type":"done","seq":88}

event: error
data: {"type":"error","seq":64,"message":"重试次数已用尽：构建未通过（index.html 缺少 <html> 根）"}
```

**回合终态唯一性**：任一回合必须以 `awaiting_user`、`done`、`error` 三者之一收尾，且其后不再有任何业务事件。`done`/`error` 仅出现在 `action=confirm_generation` 的生成回合。

**会话回合的工具面**（`src/turn/tools.ts`，模型可调）：`ask_user`（结构化澄清）→ 发 `questions` + `clarify/asked`；`write_wireframe`（产线框文件）→ 发 `wireframe` + `wireframe/produced`；`request_generation`（**提议**生成）→ 发 `generation/proposed` + `approval/asked` + `awaiting_user(reason=approval)`；工作区只读工具（`readFile`/`readDir`/`searchContentImages` 等）。**该工具面不含任何会花钱的动作**——真正的冻结只在人类批准后的 `confirm_generation` 回合发生（§4.1 时序）。

**前端卡片的三按钮新去向**（原三端点已退役）

| 按钮 | 新语义 |
|---|---|
| 「确认线框，开始生成」 | 发 `action=confirm_generation` + 回传 `approvalId`（若线框后有审批请求）与 `wireframe.version` |
| 「重新生成线框」 | 发一条普通 `action=chat` 消息（如「重新生成线框，页面再少一页」），由模型决定是否再次调用 `write_wireframe`；按钮保留但降级为**消息快捷方式** |
| 「重新访谈」 | **退役**：访谈已不是固定流程，用户直接说话即可（模型按需澄清）。组件删除该按钮与对应 emit |

### 4.6 预算、状态机与地板

**预算（Q14=C / J6）**：`src/generation/intensity.ts` 的 `INTENSITY_TIERS` 增 `maxTokenBudget`，并调高 `maxTurns`：

| 档位 | maxTurns（兜底，调高） | maxToolCalls | maxOutputTokens | maxTokenBudget（主控） | maxImages |
|---|---|---|---|---|---|
| fast | 8 | 20 | 3000 | 60_000 | 2 |
| standard | 16 | 50 | 8000 | 200_000 | 4 |
| deep | 32 | 100 | 16000 | 600_000 | 8 |

- 主控 = `maxTokenBudget`（累计 `usage.totalTokens` 超限即优雅收尾）；`maxTurns`/`maxToolCalls` 仅作死循环兜底，**不再作为对外产品语义**。
- 超限收尾语义不变（注入收尾指令，绝不硬杀），但**收尾后必须仍跑确定性门禁**。

**run 生命周期状态机 → phase 映射（必须实现为一张显式表）**

| 新链路状态/动作 | 写入的 `phase` | 说明 |
|---|---|---|
| `run/start`（人类批准后、`action=confirm_generation` 回合内，创建 run） | `wireframe_confirmed` | 该 phase 在新链路的语义 = 「**人类已确认进入生成**」。Java 的冻结闸门要求 `phase == wireframe_confirmed`（`GenerationRunServiceImpl.java:287-290`），故 run 必须以此 phase 创建，冻结逻辑与规则**零改动** |
| `generating` | `coding` | 生成循环进行中 |
| `gated` | `review` | 门禁执行中 |
| `done` / `failed` / `aborted` | 同名 | 终态（`run/end` 经 §4.3 派生规则映射） |
| **不产生 phase** | — | `awaiting_approval` 是**回合态不是 run 态**：审批期间 run 尚未创建（因此也不可能有冻结） |
| **不再产生** | `interview`、`wireframe_pending` | 会话回合**不建 run**，故这两个 phase 在新链路无写入方 |
| **仍无写入方** | `building` | 现状即如此（构建由 Java `BuilderExecutor` 触发，不写 phase）；本设计不改变 |
| 历史数据兼容 | 枚举九值不变 | 旧 run 的 `interview`/`wireframe_pending`/`building` 仍可被正常读取；续传/并发查询只筛非终态，逻辑不变 |

**两级地板（Q15=C）**

| 级别 | 门禁 | 判定 | 不过时 |
|---|---|---|---|
| 确定性 | `build`（按 `codeGenType`）、产物存在性 | 服务端硬校验，模型不可跳过 | **退回模型修复**，有界（沿用 `MAX_QUALITY_ATTEMPTS=3`）；耗尽 → run `failed` → 全额退款 |
| 启发式 | 质检分（LLM）、视觉 diff（线框基准） | 只产生意见 | **不阻断 done**；意见经 `gate/verdict` 事件 + `ai_thinking` 回流给模型，也回传给前端提示 |

- **修复既有旁路**：`workflow/index.ts:389-400` 的超限截断路径改为「收尾 → 跑确定性门禁 → 通过则 done，不通过则退回一次修复（不再有第二次收尾）→ 仍不过则 failed」。
- XState 保留为上述 run 生命周期极小状态机，非法转移仍由类型层消灭（Q4 的「降级」，非删除）。

### 4.7 计费解耦与一致性（Q5=B→A / D3 / R5）

1. **上报接口冻结**：`PATCH /internal/runs/{runId}`（`phase` + `milestones`）语义与调用时机不变；**`generation_run` 不再是任何事件日志的投影**（D3）。
2. **无跨库事务**：事件在 PG、计费在 MySQL，二者通过「同一回合内先写事件、再调计费端点」的顺序耦合；计费端点失败时**不回滚事件**（事件已发生的事实不可撤销），由重试 + 台账幂等（`uk_runId`）收敛。
3. **消除静默退化**：`GenerationRunServiceImpl.resolveMilestoneCount` 在「字段为空」时也 `log.warn`（现仅「解析失败」告警，见 `:363-374`），并在 `completeRun` 的 aborted 分支写明确日志（含 `runId`、`milestones` 原始值、采用的折算比例）。
4. **里程碑等价（R4 / §3.2 约束 6）**：新链路里程碑由「run 阶段推进 + 确定性门禁结果」产生，至少覆盖现状 4 条；A2/A3 必须断言 aborted 场景 `milestoneCount >= 3`。
5. **退款锚验证脚本（离线，不改扣费）**：`paimeng-ai-code-agent/scripts/verify-refund-anchor.mjs`，输入为一批 run 的事件日志导出（`eval/fixtures/refund-samples.json`），输出为「按现有折算规则判定的结果」与「按工具事实（写入文件清单、确定性门禁通过记录、重试次数的**事件派生值**）判定的结果」的逐条对比表。**该脚本只读、只输出报告**；结论出来前不动 `CreditServiceImpl`。

### 4.8 eval 体系（切换门槛，R3）

**路径基准统一为 `paimeng-ai-code-agent/` 下**：`eval/journeys/`（旅程）、`eval/fixtures/baseline/`（A0 基线快照）、`eval/fixtures/refund-samples.json`（A6 输入）、`eval/run.mjs`（运行器）、`eval/README.md`（说明）。

- **基线快照**（A0，先于代码改动）：用阶段 0 合并后的 HEAD、旧三端点 + `/agent/stream` 链路跑 20 条黄金旅程，录制「请求序列 → SSE 事件序列 → run phase 序列 → 回调载荷」为 `eval/fixtures/baseline/*.json`，作为回归护栏（承担原「等价性对比脚本」的角色，Q13）。
- **黄金旅程 schema**（`eval/journeys/*.yaml`，≥20 条，覆盖 5 类需求）：

```yaml
id: pet-shop-multipage          # 唯一标识
title: 宠物店多页站点
expect: [memory_retention]      # 该旅程用于判定哪些指标
turns:
  - action: chat
    message: 做一个宠物店官网，三页
    expectEvents: [questions, awaiting_user]        # 期望出现的事件类型（子集断言）
  - action: chat
    message: 受众是本地养宠家庭，风格清爽
    expectEvents: [wireframe, awaiting_user]
  - action: confirm_generation
    expectEvents: [milestone, tool_request, done]   # 需先完成审批（旅程脚本内含审批步骤）
```

- **运行命令**：`cd paimeng-ai-code-agent && node eval/run.mjs --journeys eval/journeys --base eval/fixtures/baseline --out ../docs/ts_agent/agent-loop-eval-report.md`
- **指标口径**（报告必须按此定义计算）：
  - `memory_retention`：同一 journey 的第 N 轮请求中，system 文本包含第 1..N-1 轮 `user/message` 文本的比率；
  - `deterministic_gate_pass_rate`：`run/end.status=success` 且存在 `gate/verdict(category=deterministic, passed=true)` 的 run 占比；
  - `clarify_rounds`：每 journey 的 `clarify/asked` 事件数；
  - `run_tokens`：每 run 的 `run/token-usage.totalTokens`；
  - `done_ratio`：`run/end.status=success` 占全部 run 的比率。
- **切换门槛**：20 条黄金旅程在**真实模型渠道**上跑通，且 ① 确定性门禁通过率 ≥ 基线；② 跨消息记忆保留率 = 100%（基线为 0）；③ 每 run 积分成本 ≤ 档位预算。**未达门槛不得切换**。

### 4.9 取舍记录（选 A 不选 B 的原因）

| 决策点 | 选择 | 备选与否决原因 |
|---|---|---|
| 事件载体 | **PG `session_event`（J1 裁决）** | 否决 MySQL 新表（原稿）：那会把「会话记忆」塞进交易库，偏离 `architecture.md:139`「交易归 MySQL、记忆归 PG」。PG 另有 JSONB 与 pgvector（RAG v2）同源之利 |
| 跨库一致性 | **事件为真相 + 读模型可重放**（R5） | 否决「跨库事务」：PG/MySQL 无同事务，且**记账原子性仍在 MySQL 内部**（`credit_ledger`+`user.credits`），事件日志不参与记账，故无需跨库原子 |
| 谁写 PG | **TS 直连（D1）** | 否决 Java 中转：纪律原文禁的是 TS 直连 **MySQL**（防业务账被旁路），事件日志是记忆不是账；中转只会让 Java 代理一份它并不拥有的记忆，且多一跳 |
| PG 怎么起 | **compose 增 postgres+pgvector 服务（D2）** | 否决沿用停用中的用户态 PG16：那是单人本机方案（deb 解包 + `LD_LIBRARY_PATH`），无自启/健康检查/备份，而事件日志已是运行时强依赖 |
| 是否投影 `generation_run` | **不投影（D3）** | 否决「Java 从 PG 拉事件投影」：会把计费读模型耦合到 PG，且 `generation_run` 现状已满足计费/并发/续传，改它是纯粹的风险 |
| 花钱动作 | **模型工具 + 人类审批（J3）**：`request_generation` 只**提议**，冻结只发生在人类批准的 `confirm_generation` 回合 | 否决「模型可自决开跑」：DSH 的对照证明非人类生产方必须自报 source、不能继承人类权限（R1） |
| 审批原语 | **通用 seam + fail-closed（D4）** | 否决「只服务生成」：Q11 已认定花钱/部署发布/应用级删除都不可逆，逐个现造会重复三遍；否决 fail-open：等于没有强制 |
| 工作区路径 | **Java 为权威**：`AgentTokenVO` 计算并由前端原样回传 | 否决「TS 按 `codeGenType + appId` 自行推导」：Java 侧用的是数据库 app 记录的 `codeGenType` 且根目录来自 `AppConstant.CODE_OUTPUT_ROOT_DIR`，TS 侧默认 `workspaceRoot` 与之不等价，推导会导致产物写错目录、构建目录不匹配 |
| `codeGenType` 非法值 | **预检 400**（取消静默回退 `html`；J7 已裁决） | 静默回退会让工作区类型、构建分派与计费类型系数三者不一致（按次付费下是真金白银的错配）。此改动同时了结 `contract-parity.md` 的 P3 修正项「codeGenType 回退 vs 422」 |
| 澄清形态 | 回合结束 + `awaiting_user` + 下次请求续跑（J2 已裁决） | 否决长连接内暂停等人（fetch-SSE 经反向代理，超时/断连语义不可控） |
| 线框闸门 | 由模型按需产出、可确认但非必经 | 否决全退（Q10=B 已定）；否决照旧必经（与「一句话跑完」矛盾） |
| XState | 保留极小 run 生命周期机（J4 已裁决） | 否决全删：Q4=B；且它是「非法转移类型层消灭」的现成保障，删除属额外风险 |
| 计费锚 | 保持 `phase+milestones` 上报 | 否决立即改工具事实推导：数据源（门禁记录/文件清单）当前**零结构化落库**，需先建载体，且 handoff §2 禁止无评估改扣费 |
| 幂等粒度 | 批次级（PG 唯一键 `(app_id, turn_id, batch_seq)`） | 否决回合级：与流式多次 append 结构性冲突（§4.2/§4.4） |

## 5. 任务分解

**依赖顺序**：`A0 → A1 → A2 → A3 → (A4 ∥ A5 ∥ A6) → A7 → A8`；`E1` 可与 A2–A6 并行，但必须早于 `A7`。

**基线约定**：A0 用**阶段 0（#23/#24）合并后的 HEAD**；A3 开工前必须确认 #23/#24 已合并（否则 §2.3 前置不满足）。

| # | 任务 | 产出物（文件 + 行为） | 依赖 |
|---|---|---|---|
| A0 | 基线快照采集 | `eval/fixtures/baseline/*.json`（20 条旅程的旧链路录制）+ `eval/README.md`（采集方法） | 阶段 0 合并 |
| A1 | PG 地基 | `docker-compose.yml` 增 `postgres` 服务（`pgvector/pgvector:pg16` + 数据卷 + init 挂载）；`sql/pg/init/001_session_event.sql`；根 `.env`/`*.example` 增 `POSTGRES_*`/`PG_*`；`.agents/memories/deployment.md` 的 PG 段与探活口径更新；实库 `\d session_event` 证据 | — |
| A2 | TS 会话存储 | `src/session/{pg,events,store,context}.ts`：连接池、追加（advisory lock + `seq` 分配 + 批次幂等）、重放、未知 kind 拒绝、上下文重建；逻辑单测走内存实现 + 集成测试打真实 PG（PG 不可用则 skip） | A1 |
| A3 | 审批原语 + 统一回合端点 | `src/approval/index.ts`（`request`/`decide`/`assertHumanApproved`，fail-closed）、`src/server/agentRoutes.ts` 新端点、`src/turn/{index,generationTurn}.ts`、`AgentTokenVO` 增 `codeGenType`（Java）；会话回合可澄清/出线框/提议生成，审批通过后可跑通生成回合 | A2、阶段 0 合并 |
| A4 | 工具面与地板分级 | `src/turn/tools.ts`（`ask_user`/`write_wireframe`/`request_generation` + 只读工具）、`src/turn/floor.ts`、`review/types.ts` 门禁类别；**修掉超限跳过确定门禁的旁路** | A3 |
| A5 | 预算改造 | `src/generation/intensity.ts` 增 `maxTokenBudget` 并调高 `maxTurns`；核实前端**本就无步数展示**（`grep 步数/maxTurns` 零命中），无需前端改动，仅在 issue 记录该核实结果 | A3 |
| A6 | 计费告警与退款锚验证脚本 | `GenerationRunServiceImpl` 告警；`scripts/verify-refund-anchor.mjs`；`eval/fixtures/refund-samples.json`（导出方式：`psql "$PG_DSN" -c "COPY (SELECT app_id, run_id, kind, payload FROM session_event WHERE run_id IS NOT NULL ORDER BY app_id, seq) TO STDOUT WITH CSV HEADER" > eval/fixtures/refund-samples.json`，附一次脚本整理为输入格式）；一份对比报告 | A1 |
| A7 | 前端改造 | `AppChatPage.vue` `journeyPhase` 退役 + 新事件渲染 + 伪 assistant 拼接删除；`agentSse.ts` 契约更新；`WireframeReviewCard.vue` props 扩展与三按钮新语义；新增 `GenerationApprovalCard.vue` | A3、E1 |
| A8 | 回归与切换 | 旧三端点与 `/agent/stream` 删除；TS `npm test`/`type-check` 全绿、Java 相关测试全绿、前端 `type-check`/`lint` 全绿；eval 报告 | A4–A7、E1 |
| E1 | eval 体系 | `eval/journeys/*.yaml`（≥20 条）+ `eval/run.mjs` + `eval/README.md` + `docs/ts_agent/agent-loop-eval-report.md` | A0 |

**每个任务的完成标准 = §6 对应验收项全过 + 该任务产生的测试全绿 + 一笔 commit。**

**实施票索引（2026-09-10 立票，全部 `ready-for-agent`）**：`A1+A2 → #26`；`A0+E1 → #27`；`A3 → #28`；`A4+A5 → #29`；`A6 → #30`；`A7+A8 → #31`（父 spec #1；本设计的裁决记录见 #25）。A0 与 A3 之间是**时序约束而非阻塞边**（A0 须在任何行为改动前采集），两票正文均已写明；`A6 → #30` 额外以 A3 为前置，因为退款样本要求已存在带 run 标识的事件。

## 6. 验收标准

**A1（PG 地基）**
- `docker compose up -d && docker compose ps` → `postgres` 容器 **healthy**，`ss -tlnp | grep 5432` 见 127.0.0.1:5432 监听（**注意**：这修改了 `.agents/memories/deployment.md:97` 原有的「5432 停用后不应出现」验收口径，须同步）；
- `psql "$PG_DSN" -c '\d session_event'` 输出含 `uk_app_seq`、`uk_app_turn_batch_event`、`ck_batch_event_index`、`ck_source` 与 `payload jsonb`（贴实测输出到 issue）；同批两条事件必须共享 `batch_seq`、使用不同 `event_index` 并可同时落库；重复同一事件键必须 no-op。
- 重复执行初始化脚本不报错（`CREATE TABLE IF NOT EXISTS` 幂等）。本地旧表按 #57 的重建说明处理；生产迁移不在本票范围内。

**A2（TS 会话存储）**
- `cd paimeng-ai-code-agent && npm run test && npm run type-check` 全绿，覆盖：
  - `appendBatch` 返回 `seqFrom/seqTo/firstSeqNext` 且 `seq` 连号；
  - **同一 turn 的多个批次（`batchSeq` 1、2…）全部落库**，仅**同批次重复**幂等丢弃（`ON CONFLICT DO NOTHING`）；
  - 并发 `appendBatch`（同 app 两并发）→ `seq` 无重复、无空洞（advisory lock 生效）；
  - 写路径白名单外 `kind` → 抛错（拒绝写入）；
  - 读路径白名单外 `kind` 且 `ignorable=false` → 抛 `UnknownEventKindError`，**不静默跳过**；
  - `assertHumanApproved`：`source=human` 的 `allowed` 记录 → ok；`source=model` 的同名记录 → **拒绝**；已被消费 → 拒绝；
  - PG 不可达 → `appendBatch` 抛错且调用方按 503/error 收尾（不降级继续）。

**A3（审批与统一回合端点）**
- `npm run test` 全绿；新增用例：
  - `action=confirm_generation` 但**无** `approvalId` / 审批未通过 → 预检 **403**，且断言**未调用** `createRun` 与 `freezeCredit`（fail-closed）；
  - **模型不能代答**：构造仅存在 `source=model` 的 `approval/decided` → 断言 403；
  - 审批通过 → 事件序列 `approval/decided(human)` → `run/start` → 冻结 → `milestone`/`tool_*` → 末帧 `done`；断言**全部事件（含 `done`）带递增 `seq`**；
  - `action=chat` + 模糊需求 → 含 `questions` + `awaiting_user`，**不含** `done`；`questions` 载荷字段与 `InterviewQuestion`（`key/dimension/question/options[{id,text}]`）逐字段相等；
  - `action=chat` + 清晰需求 → `ai_response` + `awaiting_user`，且**不扣费**（断言未调用 `freezeCredit`）；
  - `request_generation` 工具调用 → `generation/proposed` + `approval/asked` + `awaiting_user(reason=approval)`，**且未创建 run、未冻结**；
  - **跨消息记忆**：同一 `appId` 连续两次请求，第二次的 system 文本断言含第一次的 `user/message` 与 `model/message` 文本；
  - **里程碑等价**：aborted 场景断言 `milestoneCount >= 3`；
  - **确定性门禁不可跳过**：`limit-length` 剧本（截断）→ 断言仍执行 build 门禁；门禁失败 → run `failed` + 全额退款回调，**不得**出现 `done`；
  - 启发式门禁失败（质检分不通过且已是最后一次尝试）→ 仍可 `done`，且 `gate/verdict(category=heuristic)` 在流内；
  - 会话回合工具面**不含花钱动作**（断言工具清单）；
  - **边界**：非法 `action` → 400；`action=chat` 空/纯空白 `message` → 400；非法 `codeGenType`（如 `react`）→ 400（**不得**静默回退 html）；非法 `intensity` → 回落 `standard` 且成功；`workspacePath` 越界 → 400；
  - **同 app 并发回合**：第二个并发回合 → 409（应用级互斥），或串行化后断言 `seq` 仍连续。
- WSL 宿主改走 `bash scripts/run-wsl.sh test`。

**A5（预算）**
- `npm test` 中 `test/generation/intensity.test.ts` 三档 `maxTokenBudget` 断言通过；
- 超限剧本：累计 token 达预算 → 断言注入收尾指令 + `ai_thinking` 收尾文案；
- issue 记录「前端无步数展示」的 grep 核实结果。

**A6（计费）**
- `./mvnw -o test -Dtest='CreditServiceImplTest,GenerationRunServiceImplTest'` 全绿；
- `milestones` 为空/非法 JSON 时日志含明确 warn；
- `node paimeng-ai-code-agent/scripts/verify-refund-anchor.mjs eval/fixtures/refund-samples.json` → 输出逐条对比表，且脚本对**只读输入**不做任何写操作。

**A7 / E1 / A8（前端、评估与切换）**
- 前端 `npm run type-check` + `npm run lint` 全绿；`grep -n "journeyPhase" src/pages/app/AppChatPage.vue` 零命中；`grep -n "reinterview" src/` 零命中；
- HTTP 层 e2e（curl，原生 Linux + docker compose MySQL/Redis/**Postgres** + Java 8123 + TS Agent 8092，真实登录态 JWT）：注册登录 → `GET /app/agent/token`（取 `workspacePath`/`codeGenType`）→ `POST /agent/turn`（chat，模糊需求）→ 收到 `questions` + `awaiting_user` 且**余额不变** → `POST /agent/turn`（chat，带答案）→ 收到 `wireframe` 或 `awaiting_user(reason=approval)` → `POST /agent/turn`（`action=confirm_generation` + `approvalId`）→ 冻结（余额减少）→ `done` → `run/phase=done` + `credit_ledger=SETTLED`，且 `psql` 查得该 run 事件连号；
- **无审批直连被拒**：跳过审批直接 `confirm_generation` → **403**，余额不变、无 `generation_run` 记录；
- 中断剧本：生成中断开连接 → `aborted` 终态 + 按现有规则折算退款（与改前同结果，含 `milestoneCount` 对账）；
- 余额不足 → 预检 **402**（不产生任何 token 消耗、不写 `run/start` 事件）；
- eval 可复现：`cd paimeng-ai-code-agent && node eval/run.mjs --journeys eval/journeys --base eval/fixtures/baseline --out ../docs/ts_agent/agent-loop-eval-report.md` 成功产出报告，含 §4.8 五项指标定义与数值、基线对比、切换门槛三条判据逐条勾选。

## 7. 风险与陷阱

| 风险/陷阱 | 说明与对策 |
|---|---|
| **PG 成为运行时强依赖** | 事件日志是会话记忆，PG 挂掉就不能服务（§3.2 约束 7）。对策：compose healthcheck + 回合入口预检 503 明确报错（不降级、不静默）；部署文档给排障入口 |
| **跨库不一致（D3/R5）** | 事件在 PG、计费在 MySQL，无同事务。对策：计费端点幂等（`uk_runId`）+ 事件不可回滚（先事件后计费）+ 台账为准对账；`generation_run.context` 是**陈旧副本**，任何新代码不得依赖它 |
| **PG 无迁移框架** | 与 MySQL 同状况：`sql/pg/init/*.sql` 是唯一真源，变更走手工 `ALTER` 并同步该目录；init 脚本只在数据卷为空时执行一次（改表须显式执行） |
| **既有验收口径冲突** | `.agents/memories/deployment.md` 有「5432 停用后不应出现」的探活断言；A1 必须同步改，否则验收自相矛盾 |
| **假 LLM 剧本范式局限** | 现有 160 个测试全在「假 LLM + 固定剧本」下；模型接管决策后剧本要能表达「先问再答」与「先提议再批准」的多回合序列。对策：`src/llm/index.ts` 增多回合剧本（按 `turn` 序号推进），**不改** provider 注入接缝 |
| **`done`/`error` 断言会大面积失效** | `test/server/stream.test.ts:38-44,84-85,136` 断言事件序列与 phase 序列全等。对策：按新契约重写（属预期返工），A0 基线快照先固化为护栏 |
| **退款比例静默退化** | `milestoneCount` 缺失时静默走 50% 分支（`CreditServiceImpl.java:301`）。对策：§3.2 约束 6 的里程碑等价 + A6 告警 + 事件日志使 milestone 可重放核对 |
| **同 app 并发 409 依赖 run 终态** | Java 并发校验读非终态 run（`GenerationRunServiceImpl.java:116-121`，`TERMINAL_PHASES` 定义在 `:70-75`）。对策：回合端点加应用级互斥（A3 验收项），避免同 app 双开回合 |
| **SSE 经 nginx 被缓冲** | 生产模板 `deploy/nginx.conf.example` 的 `location /agent/` 内已 `proxy_buffering off`；新端点同前缀 `/agent/*`，无需改路由 |
| **`seq` 连续性与乱序** | `pg_advisory_xact_lock` 保证同 app 串行；`uk_app_seq` 兜底。A2 有并发断言 |
| **WSL 运行时陷阱** | 仅 WSL 宿主用 `wsl-rt-env/`；vitest 的 `--configLoader runner` **必须保留**（去掉会 EROFS 失败）；`node --watch` 在 DrvFs 上收不到事件，dev 走 esbuild watch；PG 连接在 WSL 下同样走容器端口映射 |
| **前端零测试** | 前端无测试文件，A7 验收只能靠 `type-check`/`lint` + curl e2e + 人工走查；不假装有单测 |
| **阶段 0 与 A 系列并行** | 两者都碰 `agentRoutes.ts` / `workflow/index.ts`，存在冲突风险。对策：阶段 0 先落地并合并；A0/A3 以合并后的 HEAD 为基线（§5 已写死） |
| **eval 用假 LLM 不算数** | 切换门槛必须在**真实模型渠道**跑（R3）；假 LLM 下 eval 只作回归 |

## 8. 参考资料

**项目内（开工前必读）**

- 当前架构权威：`docs/ts_agent/architecture.md`（§1.1 拓扑与红线、§3.1 收敛纪律、§3.2 run 表、§3.3 五层护栏、§4 闸门纪律、§6 门禁、§7 计费、**§8 存储分工（交易归 MySQL / 记忆归 PG）**、§10 退役、§11 实施顺序）
- 现有 wire 契约：`docs/ts_agent/contract.md`（事件表、错误双轨、生命周期）
- 实施进度与测试基线（160/160）：`docs/ts_agent/progress.md`
- 契约对账（P3 修正项）：`docs/ts_agent/contract-parity.md`
- 阶段 0 行动入口：`docs/hand-off/2026-09-10-agent-loop-brief.md`
- 架构讨论纪要：`docs/hand-off/2026-09-09-architecture-evolution.md`（**只读**，勿改）
- 跨会话记忆与运行手册：`MEMORY.md`、`.agents/memories/ts-agent.md`、`.agents/memories/java-backend.md`、`.agents/memories/deployment.md`（**§PG 段与探活口径**）
- 基础设施定义：`docker-compose.yml`（MySQL 初始化挂载先例在 `:19`）
- DDL 真源：`sql/create_table.sql`（MySQL）、`sql/pg/init/*.sql`（PG，新建）
- 键代码：`paimeng-ai-code-agent/src/generation/workflow/{index,machine}.ts`、`src/server/agentRoutes.ts`、`src/protocol/events.ts`、`src/interview/{index,conduct,context}.ts`、`src/generation/review/index.ts`、`src/runs/runClient.ts`
- Java：`src/main/java/com/zdan/paimengaicodemother/{controller/GenerationRunController.java,controller/AppController.java,constant/AppConstant.java,service/impl/{GenerationRunServiceImpl,CreditServiceImpl}.java,model/entity/GenerationRun.java,model/vo/AgentTokenVO.java}`
- 前端：`paimeng-ai-code-mother-frontend/src/pages/app/AppChatPage.vue`、`src/utils/agentSse.ts`、`src/components/{InterviewQuestionsCard,WireframeReviewCard}.vue`
- RAG 侧 PG 使用先例：`paimeng-ai-code-rag/pyproject.toml`（`psycopg`）、`paimeng-ai-code-rag/README.md`
- 启动与运行时分流：`.agents/skills/project-startup-guardrail/SKILL.md`
- Issue 流程：`docs/agents/issue-tracker.md`（父 issue #1；本设计的子 issue #25）
- 注释规范：`.agents/skills/project-comment-style`

**外部（设计参照，均为本地可读的安装产物）**

- DSH 事件溯源与 loop 设计：`/home/zdan/.nvm/versions/node/v24.20.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-{session,agent-loop,goal,goal-round-driver,tool-goal,tool-ralph}/README.zh.md`
  - 事件溯源纪律：`dsh-session/README.zh.md` 原文「提供**仅追加的会话日志**……每个模型可见事实都流经的**单一真源**。LLM 消息历史由日志*派生*（`deriveMessages()`），**从不另行存储**」
  - 未知事件类型拒绝解释：`dsh-session/lib/types/known-event-types.d.ts` 原文「The persistence read path **refuses to interpret** a log containing a type outside this set unless the event carries the envelope's `ignorable` marker…… **silently skipping a required event would reconstruct a wrong session.**」
  - 人类身份证明与审批：`dsh-tool-goal/README.zh.md` 原文「`Agent.followup()` 与 `steer()` 会在调用方省略 source 时分配 `{ kind: 'user' }`，因此**插件、调度器与其他非人类生产方必须传入自己的 source，不能继承人类权限**」；`dsh-tools` 的 `tools/pre-execute` waterfall 语义「Allow, deny, or ask before dispatch. `next()` delegates to allow; **missing approval support turns `ask` into denial**」
  - 「无编排」的自我声明：`dsh-agent-loop/README.zh.md` 原文「它是 harness **唯一的具象循环**——超出「调用模型、运行工具、重复」的所有内容都属于**监听事件分类体系**的插件」
- 注意：DSH 包**不可作为依赖引入**（peer 依赖整套运行时图、tarball 不含 `src/`、npm `latest` tag 陈旧）。

## 9. 裁决状态（J 系列汇总）

| # | 设计选择 | 状态 |
|---|---|---|
| J1 | 事件载体 = **PG `session_event`**（用户修正原 MySQL 方案） | ✅ 已裁决 |
| J2 | 澄清以「回合结束 + `awaiting_user` + 下次请求续跑」表达 | ✅ 已裁决 |
| J3 | 花钱动作 = **模型工具 `request_generation` + 人类审批**（用户修正原「不做成工具」） | ✅ 已裁决 |
| J4 | run 生命周期保留极小 XState 状态机 | ✅ 已裁决 |
| J5 | 统一端点用新路径 `POST /agent/turn`，旧三端点一次性退役 | ✅ 已裁决 |
| J6 | 预算主控用 `maxTokenBudget`，`maxTurns` 仅兜底 | ✅ 已裁决 |
| J7 | `codeGenType` 非法值改**预检 400**（取消静默回退 `html`），`AgentTokenVO` 回传权威 `codeGenType` | ✅ 已裁决 |
| D1 | TS 直连 PG（写事件 + 重放读） | ✅ 已定（J1 派生，用户确认） |
| D2 | compose 增 postgres+pgvector 服务，RAG v2 复用同实例分库 | ✅ 已定（J1 派生，用户确认） |
| D3 | 不投影 `generation_run`，其用途与内容零变化 | ✅ 已定（J1 派生，用户确认） |
| D4 | 通用 approval seam + fail-closed | ✅ 已定（J3 派生，用户确认） |

## 10. 审查与修订记录

### 第一轮（八要素独立审查）

- **审查方式**：`agent-design-review` 八要素检查表（`references/review-criteria.md`），由独立子 agent 执行，含三项硬核验：引用真实性（逐路径实测）、代码事实抽样（行号与常量核对）、内部自洽性。
- **审查结论**：**PASS-WITH-FIXES**（阻塞 0 / 高 7 / 中 10 / 建议 5）。引用真实性专项：无「引用指向不存在文件」；行号类引用 17 处正确、1 处不准确（已订正为 `GenerationRunServiceImpl.java:116-121`）。
- **修订清单（全部就地落实）**：
  - 高：H1 `questions` 载荷改为与 `InterviewQuestion` 逐字段一致；H2 补状态→phase 映射表并写明各 phase 去向；H3 幂等键改批次级；H4 `workspacePath` 回归 Java 权威、`codeGenType` 非法改 400；H5 阶段 0 从 In 与文件清单摘出、标注 #23/#24 负责；H6（**已因 J1 消解**：`context` 不再需要投影来源，会话上下文由 PG 重放得到）；H7 统一 `eval/` 基准、补 A6 fixture 产出物与导出命令、补 E1 运行命令与 schema 与指标口径。
  - 中：M1 并发校验行号订正；M2 基线改 160/160 并区分「测试条数」与「行为基线」；M3 `src/turn/` 文件四处对齐；M4 统一为「全部事件（含 done/error）带 seq」；M5 补写路径未知 kind 拒绝；M6 补边界验收；M7 补 `seq` 分配机制与并发验收；M8 `run/end.status` 改用 `success|failed|aborted` 并给 phase 派生规则；M9 依赖链与依赖列对齐、A5 无对象产出物改为「核实并记录」；M10 补三按钮新去向与卡片 props 扩展要求。
  - 建议：S1 判据 1 基线口径；S2 DDL 注释声明 append-only 取舍；S3 改引 DSH 原文；S4 审查记录落仓；S5 补终态帧示例。
- 审查原文与核查证据同时贴在本 issue #25 的评论中。

### 第二轮（J1/J3 裁决引发的重写）

| 改动 | 影响章节 |
|---|---|
| **J1=PG**：数据地基由 MySQL 新表改为 PG `session_event`；TS 直连；compose 增 postgres 服务；Java 侧事件表/服务/端点**全部取消** | §0.2/§0.3/§0.4（R5）、§2.1/§2.2/§2.3、§3.1、§3.2（约束 1/2/7/8 新增与改写）、§3.3、§4.1、§4.2、§4.4（由 HTTP 契约改为 TS 存储契约）、§4.7、§5（A1/A2/A6 重写）、§6（A1/A2/A6 重写）、§7、§8（加 compose/deployment/RAG 引用） |
| **J3=模型工具 + 请求确认**：新增 `request_generation` 工具、`approval/asked`/`approval/decided` 事件、`src/approval/` 原语、`awaiting_user(reason=approval)`、`GenerationApprovalCard.vue`；R1 由「阶段 C 才需要」提前为**立即生效** | §0.1（Q6/Q9 改写）、§0.2、§0.4（R1）、§2.1、§3.1、§3.2（约束 8 新增）、§4.1（审批时序图）、§4.3（两个审批事件）、§4.5（请求体 `approvalId`、工具面、终态帧、卡片去向）、§4.6（`awaiting_approval` 不产生 phase）、§4.9、§5（A3/A4/A7）、§6（A3 审批验收、e2e 加审批步骤、无审批直连被拒）、§7 |
| **D1–D4**：TS 直连 PG、compose 起 PG、不投影 `generation_run`、通用 approval seam + fail-closed | 同上各处 |

### 第三轮（J2/J4/J5/J6/J7 授权）

2026-09-10 用户授权 J2/J4/J5/J6/J7：**接受方案原提议，无内容修改**，仅将 §0.2/§4.9/§9 的状态由「待裁决」改为「已裁决」。**设计自此全部定稿**，无遗留待裁决项；实施授权（按 A0–A8 立 issue）另行确认。
