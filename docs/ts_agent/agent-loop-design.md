# Agent Loop 改造方案设计（事件溯源状态层 + 模型接管旅程决策）

> **状态**：方案设计，待用户裁决（2026-09-10 经 17 轮设计审讯逐项确认方向后产出）。
> **性质**：这是「交付给 Agent 落地实现」的方案设计，不是讨论纪要。依据见 §0，结论冲突时以本文为准；`docs/ts_agent/architecture.md` 仍为**当前实现**的架构权威，本文描述**目标态**。
> **审查**：已按 `agent-design-review` 八要素做独立审查，结论 **PASS-WITH-FIXES（阻塞 0 / 高 7 / 中 10 / 建议 5）**，全部问题已就地修订；审查报告与修订清单见 issue #25 评论与 §10。

## 0. 决策依据（本设计的来源，勿重新论证）

本方案的每一条设计选择都对应一次已确认的决策。落地时**不要重新讨论**，有异议走 §9 的待裁决项。

| 编号 | 决策 | 内容 |
|---|---|---|
| Q1 | 移植范围 | 移植 DSH 的 **(b) 事件溯源状态层**（append-only 事件日志即唯一持久真相、序号连续、未知事件类型必须显式 `ignorable` 否则拒绝解释）与 **(a) loop 纪律**（数据驱动终止、无硬编码阶段序列）。**不引入 Cordis 事件总线**；**不整抄对外事件流**（DSH 用 WebSocket/JSON-RPC，本系统继续 SSE） |
| Q2 | 交付形态 | 出正式方案设计交用户裁决，**不直接改代码** |
| Q3 | 痛点优先级 | ① 跨消息零生成记忆（先做）→ ② 模型无旅程决策权（主目标）→ ③ Skill 化（自然结果）→ ④ 退款锚（只在真拆工作流时付账） |
| Q4 | XState 终局 | **降级**：loop 为主干，保留极小确定性状态机作 fallback 与「确定性门禁必须过才能 done」的强制地板。**非全退** |
| Q5 | 计费锚 | 先把 `phase+milestones` 定位为「计费上报接口」（规则不动）并补 `milestoneCount` 缺失告警；再离线验证工具事实能否复现同判定。**拆工作流与动钱在时间上切开** |
| Q6/Q9 | source 标记 | 引入「人类 / 模型 / 系统」来源标记，**不启用任何强制确认**；同源收益是堵住前端伪 assistant 消息冒充需求上下文 |
| Q7 | 落点 | 本文档 + 子 issue（挂父 issue #1） |
| Q8 | 阶段 0 | 与方案设计**并行推进**，立 issue 后即可开工（#23 / #24） |
| Q10 | 旅程可见面 | 访谈与线框确认**从「必经步骤」降级为「模型按需发起的澄清」**；固定五维题库退役 |
| Q11/Q12 | 不可逆动作 | 花钱、对外发布（部署上线）、**应用级删除/已部署产物**算不可逆；工作区内文件删除**不算**（模型可自由重构产物） |
| Q13 | 分期 | 原「阶段 1（规则引擎过渡）+ 阶段 2（模型接管）」**合并为一次改造**；原「等价性对比脚本」降级为**基线回归快照** |
| Q14 | 预算 | 成本预算为主 + 高步数上限作死循环兜底；步数不再对外当产品语义 |
| Q15 | 地板判定 | 分级：**确定性门禁**必须过；**启发式门禁**不阻断 done，只回流意见 |
| Q16 | 会话模型 | **app 级会话/记忆宿主 + run 级计费/门禁/审计单元**；改需求＝开新 run＝再计费 |
| Q17 | 稳定代码载体 | 只走 Java 内部回调（`AgentCompleteRequest` 加字段），SSE 事件本轮不动（阶段 0 范围内） |

**派生推论**（未单独审问，由上表推出，落地时按此执行）：

- **R1**：source 强制的启用时点 = 不可逆动作被工具化之时。现在冻结积分由 JWT + HTTP 端点结构性保证「人类发起」，模型够不到钱；阶段 C 把部署/删除/充值工具化时，source 强制必须由**代码**保证（对照 DSH `requireDirectHuman()`），不得只靠提示词措辞。
- **R2**：线框必须继续落盘且可被再次注入——跨消息续传时模型看不到上一 run 的规划；视觉 diff 门禁（Q15 地板）以线框为基准。故阶段 0 缺口① 保留，但语义从「注入用户确认的线框」改为「注入模型规划产物 + 地板基准」。
- **R3**：eval 体系必须进设计范围并先于切换就位（无评估的 loop-first 是信仰切换，不是工程切换）。
- **R4**：**里程碑语义必须与现状等价**（详见 §3.2 约束 9）。

---

## 1. 目标与背景

**目标**：把「XState 刚性工作流 + 内层工具循环」改造成「单一 Agent Loop + 事件溯源状态 + 模型按需澄清」，交付物是**可运行的 TS Agent 统一回合端点 + Java 事件日志地基 + 前端事件驱动渲染**，使同一 app 的跨消息生成记忆成立、旅程决策权归模型。

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
| 数据地基 | 新增 append-only 事件日志表 `generation_event`；`generation_run` 转为**投影/读模型** |
| 内部 API | Java 新增事件 append + 会话读取端点（Batch 写 + 与投影同事务） |
| TS Agent | 统一回合端点 `POST /agent/turn`；会话状态机（app 级）；模型决策的工具面；两级地板；预算改造 |
| 前端 | `AppChatPage.vue` 的 `journeyPhase` 本地状态机退役，改事件驱动渲染；卡片组件改造复用 |
| 计费 | `PATCH /internal/runs/{runId}` 保持为计费上报接口（规则不变）+ `milestoneCount` 缺失告警 + 退款锚离线验证脚本 |
| 评估 | 基线快照采集器 + ≥20 条黄金旅程脚本 + eval 报告（切换门槛） |

> **不在本次交付范围**：阶段 0 的缺口①（#23）与缺口②（#24）由**独立子 issue** 负责，本设计只把它们列为前置依赖（§2.3），不在 §5 任务清单内，也不在本节 §3.1 的「要修改的文件」清单中实施。

### 2.2 Out（明确不做）

- ❌ **不引入 Cordis / 不依赖 `@deepseek-ai/*` 包**（技术上不可行：peer 依赖整套运行时图、只发 `lib/` 不发 `src/`、`latest` tag 陈旧）
- ❌ **不改动扣费规则与退款比例**（`CreditServiceImpl` 的 70%/50% 折算不动）；不在 eval 就位前改扣费路径
- ❌ **不动 `ts-agent.enabled`**；回退手段 = git 回滚（架构 §10.0 既定纪律）
- ❌ **不放松工作区沙箱、不给生成物真 shell**（付费多用户产品红线）
- ❌ **不做 Java 业务端点工具化**（部署/应用管理/充值工具化属阶段 C，远期；本设计只为其预留 source 强制的位置）
- ❌ **不做跨 app / 跨用户记忆**（会话宿主 = 单个 app）
- ❌ **不删 XState 依赖**（Q4 保留极小状态机）
- ❌ 不修改 `docs/hand-off/2026-09-09-architecture-evolution.md`、不创建 `docs/ts_agent/architecture-evolution.md`

### 2.3 前置依赖

| 依赖 | 说明 |
|---|---|
| **阶段 0 已合并** | #23（服务端注入会话结论/规划产物）与 #24（blocker 稳定代码）是**前置**：`workspacePath`/上下文注入与 `errorCode` 字段由它们完成。**A0 采集基线用阶段 0 合并后的 HEAD；A3 开工前必须确认两者已合并** |
| Java 内部 API 鉴权可用 | 复用 `internal-api.token`（Bearer），见 `application.yml:62-63` |
| 基线快照已采集 | §5 的 A0 任务先于任何代码改动执行；无基线则 §1 判据 2 无法判定 |
| 数据库可手工变更 | 仓库无 Flyway/Liquibase，增量走手工 `ALTER TABLE` + 同步 `sql/create_table.sql`（约定见 `.agents/memories/deployment.md`） |

## 3. 现状与约束

### 3.1 要修改的确切文件

**TS Agent**（`paimeng-ai-code-agent/`）

| 文件 | 处置 |
|---|---|
| `src/server/agentRoutes.ts` | 新增 `POST /agent/turn`；`/agent/interview`、`/agent/wireframe`、`/agent/wireframe/confirm`、`/agent/stream` 退役 |
| `src/generation/workflow/index.ts` | 拆分：生成回合逻辑移入 `src/turn/generationTurn.ts`；`sync()`/phase 上报保留为计费上报 |
| `src/generation/workflow/machine.ts` | 重写为 run 生命周期极小状态机（`generating → gated → done/failed/aborted`），删除 5 状态旅程拓扑；状态→phase 映射见 §4.6 |
| `src/protocol/events.ts` | 事件联合扩展：**全部事件（含 `done`/`error`）加 `seq`**；新增 `questions`、`wireframe`、`awaiting_user` |
| `src/interview/*` | `index.ts` 固定 5 维题库与 `conduct.ts` 脚本化访谈退役；`guardrails.ts` 保留并复用到统一回合入口；`context.ts` 的 `RunContext` 保留（迁至会话上下文） |
| `src/generation/review/index.ts` | 门禁分级：确定性/启发式两类在 `runReviewCycle` 分流（`review/types.ts` 的 `GATE_NAMES` 加类别字段） |
| `src/generation/intensity.ts` | `INTENSITY_TIERS` 增 `maxTokenBudget` 与调高的 `maxTurns`（§4.6） |
| 新建 `src/session/` | `events.ts`（事件类型 + `seq` 语义）、`sessionClient.ts`（Java 内部事件 API 客户端，含重放读取） |
| 新建 `src/turn/` | `index.ts`（统一回合驱动）、`generationTurn.ts`（生成回合，自 `workflow/index.ts` 迁出）、`tools.ts`（会话回合工具面）、`floor.ts`（两级地板装配） |

**Java**（`src/main/java/com/zdan/paimengaicodemother/`）

| 文件 | 处置 |
|---|---|
| `model/entity/GenerationEvent.java` | 新建（对应 `generation_event` 表） |
| `mapper/GenerationEventMapper.java` | 新建（MyBatis，追加 + 按 `appId`+`seq` 范围读 + `seq` 分配） |
| `service/GenerationEventService.java` + `service/impl/GenerationEventServiceImpl.java` | 新建（append batch + 同事务投影到 `generation_run`） |
| `model/dto/run/EventAppendRequest.java`、`model/vo/GenerationEventVO.java` | 新建 |
| `controller/GenerationRunController.java` | 增 `POST /internal/agent/apps/{appId}/events`、`GET /internal/agent/apps/{appId}/events` |
| `model/vo/AgentTokenVO.java` | 增 `codeGenType`（由 Java 按 app 记录回传权威值，前端原样回传回合端点；见 §4.5 与 §4.9） |
| `service/impl/GenerationRunServiceImpl.java` | 投影应用逻辑（事件→`phase`/`milestones`/`context`/`tokenUsage`）+ `milestoneCount` 缺失告警 |
| `sql/create_table.sql` | 追加 `generation_event` DDL（§4.2） |
| ~~`model/dto/run/AgentCompleteRequest.java`~~ | **由阶段 0 子 issue #24 负责**（增 `errorCode`），本设计不实施 |

**前端**（`paimeng-ai-code-mother-frontend/`）

| 文件 | 处置 |
|---|---|
| `src/pages/app/AppChatPage.vue` | `journeyPhase` 四态机退役（`:402,:408,:410-412,:691,:701,:727,:741,:814,:818,:914,:956`）；`handleAgentEvent` 扩展新事件；删除 `:889-897` 伪 assistant history 拼接；线框预览沿用现有 `buildWireframeUrl`（`:776`） |
| `src/utils/agentSse.ts` | 事件类型扩展（`AgentStreamEvent` 加 `questions`/`wireframe`/`awaiting_user` 与 `seq`）；请求体改为 `{ appId, message, action?, intensity?, codeGenType?, workspacePath }`（`runId`/`history` 移除，`workspacePath`/`codeGenType` 原样回传自 `GET /app/agent/token`） |
| `src/components/InterviewQuestionsCard.vue` | 保留，**props 与字段名不变**（`questions: InterviewQuestion[]`、`round`）——事件载荷按现有字段命名（§4.5） |
| `src/components/WireframeReviewCard.vue` | 需**扩展 props**：现仅 `{ pageCount, disabled?, loading? }`，需增 `relativeUrl`/`version`（或由父组件承接预览）；三按钮新去向见 §4.5 |

### 3.2 硬约束（不可协商）

1. **TS Agent 永不直连 MySQL**（架构 §1.1 红线）：事件读写一律经 Java 内部 API。
2. 内部 API 鉴权 = Bearer `internal-api.token`，无/错 → 401（见 `GenerationRunController.java:174-179`）。
3. `phase` 枚举**九值不变**且新增 phase = 显式契约变更（架构 §3.1 纪律①）；新链路的状态必须映射到既有九值（§4.6）。
4. `workspacePath` 的权威来源是 **Java**（`AgentTokenVO` 按 `CODE_OUTPUT_ROOT_DIR` 计算）：TS 只做沙箱校验，**不得自行推导**。
5. **里程碑语义等价（R4）**：新链路每次生成产生的里程碑数**不得低于现状的 4 条**（现状：`开始生成`/`规划页面结构`/`检查生成结果`/`生成完成`，`machine.ts:43,52-56,64-67,80`）。原因：aborted 折算阈值是 `milestoneCount >= 3 → 70%`（`CreditServiceImpl.java:42,299-305`），里程碑变少会让中断退款**静默**从 70% 掉到 50%。
6. 敏感文件不提交：根 `.env`、各服务 `.env`、`src/main/resources/application-local.yml`（只留 `*.example`）。
7. 测试分包与被测代码路径对称（含子目录）；helpers/fixtures 放测试树顶层（`test/helpers.ts`）。
8. 注释遵循 `project-comment-style`；Java 遵循阿里巴巴开发手册。
9. 运行时环境按宿主分流：原生 Linux/Windows 用默认目录与标准命令；**仅 WSL** 用 `wsl-rt-env/` + `*-wsl.sh`（`.agents/skills/project-startup-guardrail/SKILL.md`）。
10. 每笔改动必须 commit，标注 `[DSH Web/ZDAN]`。
11. 数据库无迁移框架：DDL 改动必须同步 `sql/create_table.sql`，并在验收记录中给出实库 `SHOW CREATE TABLE` 证据。

### 3.3 现状关键事实（实现时必须知道，均已核实）

- XState 快照**从未持久化**（`getSnapshot()` 只用于比对，无序列化落库）；`architecture.md:70` 与 `sql/create_table.sql:69` 声称 `context` 存快照，实际只存 `RunContext{interview, wireframe}`。
- `run.milestones` 是 XState entry action 的副产品，与 `phase` 在 `workflow/index.ts:172-176` **同一次 PATCH 上报**；Java 只取 `JSONUtil.parseArray(...).size()`（`GenerationRunServiceImpl.java:369`），阈值 3 决定退款 70%/50%（`CreditServiceImpl.java:299-305`，配置项非硬编码）。
- 超限截断（`finishReason ∈ {tool-calls, length}`，判定在 `workflow/index.ts:364`）**跳过全部门禁直接 done**（`:389-400`，`contract.md:92` 记为取舍）——本设计要修掉。
- SSE 事件**无 `seq`、无事件 id、无版本号**（`protocol/events.ts:47-54`）；唯一 id 是 `toolCallId` 配对。
- 前端 `journeyPhase` 与 `generation_run.phase` **无数据通道**（前端零处读取 run 状态）；里程碑条来自 SSE `milestone` 事件。
- 测试：TS `test/` 共 **21 个 `.ts`**（20 个测试文件 + `test/helpers.ts`）+ 2 个 JSON 夹具，**基线 160/160**（`docs/ts_agent/progress.md` 最新条目，2026-09-08；144/144 是更早的 #11 时代数据）；**无任何测试 import `machine.ts` 或 xstate**，断言对象是 SSE 事件序列 / milestone 标题序列 / run phase 序列 / 回调载荷 / 重试上界；假 LLM 经**替换 AI SDK provider** 注入（`src/llm/index.ts`，源码内非 test 目录）；前端**零测试文件**。

## 4. 技术方案

### 4.1 总体形态

```
浏览器 ──fetch-SSE + JWT──> POST /agent/turn（唯一回合端点）
                                │
                                ├─ 回合 = 一次 HTTP 请求；服务端按会话状态与请求 action 决定回合类型
                                │    · 会话回合（免费）：模型可用「澄清/线框/提议生成」工具，终态 awaiting_user
                                │    · 生成回合（花钱）：由人类 action 触发 → 冻结积分 → 生成循环 → 门禁 → done/failed
                                │
                                ├─ 事件追加 ──> Java POST /internal/agent/apps/{appId}/events（同事务投影）
                                └─ 计费上报 ──> Java PATCH /internal/runs/{runId}（phase + milestones，规则不变）

generation_event（append-only，真相）  ──投影──>  generation_run（读模型：phase/milestones/context/tokenUsage）
```

**为什么是「回合」而不是「长连接内暂停等人」**：DSH 的 `ask_user_question` 在有持久连接（WebSocket）的宿主里可以原地暂停；本系统是 fetch-SSE + 反向代理，长挂连接会引入代理超时与断连语义。故澄清以「回合结束 + 事件留痕」表达：模型问完即结束回合（`awaiting_user`），用户回答即下一次请求，服务端从事件日志重建上下文继续（这正是 Q1 选 (b) 才能支撑的形态）。

### 4.2 数据结构（完整 DDL）

`sql/create_table.sql` 追加（列名 camelCase，与 `generation_run` 的 `appId`/`createTime` 风格一致）：

```sql
-- generation_event 表：会话事件日志（append-only，唯一持久真相；docs/ts_agent/agent-loop-design.md §4.2）
-- 读模型 generation_run 由本表投影得出；TS Agent 不直连 MySQL，读写均经 Java 内部 API
-- 有意取舍：本表为 append-only，无 isDelete / updateTime（与其余五表的逻辑删除约定不同），
--           纠正走追加新事件（tombstone 语义），不做就地更新或软删
create table if not exists generation_event
(
    id         bigint auto_increment comment 'id' primary key,
    appId      bigint                    not null comment '应用 id（会话宿主，一个 app 一条长期会话）',
    userId     bigint                    not null comment '用户 id',
    runId      varchar(64)               null comment '所属 run；会话级事件为 null',
    seq        bigint                    not null comment '会话内单调序号，从 1 开始，连续无空洞',
    kind       varchar(64)               not null comment '事件类型（白名单，见方案 §4.3）',
    version    int      default 1        not null comment '事件载荷版本；未知 kind 且 ignorable=0 时读路径拒绝解释',
    ignorable  tinyint  default 0        not null comment '1=读路径可跳过该未知事件；0=必须理解',
    source     varchar(16)               not null comment '来源：human/model/system（Q9 地基，当前不做强制）',
    payload    json                      not null comment '事件载荷',
    createTime datetime default CURRENT_TIMESTAMP not null comment '创建时间',
    UNIQUE KEY uk_appId_seq (appId, seq),
    INDEX idx_runId (runId),
    INDEX idx_appId_createTime (appId, createTime)
) comment '会话事件日志（generation_event）' collate = utf8mb4_unicode_ci;
```

**`generation_run` 不变更 DDL**（Q5：计费锚与 reader 全部不动）。它从「事实来源」变为「本表的投影」——写路径由 `GenerationEventServiceImpl` 在同一事务内维护。

### 4.3 事件类型白名单（`kind` 取值与语义）

对照 DSH 的 `known-event-types` 纪律：**读路径遇到白名单外的 `kind` 且 `ignorable=0` 时拒绝解释**（返回 5xx 而非静默跳过），避免「静默重建出错误会话」；**写路径遇到白名单外的 `kind` 直接 400 拒绝写入**（§4.4）。

| kind | source | payload 关键字段 | 语义 |
|---|---|---|---|
| `session/turn-start` | human | `{ turnId, action }` | 回合开始；`action ∈ chat\|confirm_generation` |
| `user/message` | human | `{ text }` | 人类消息（唯一能作为「人类意图」证据的事件） |
| `model/message` | model | `{ text }` | 模型面向用户的文本 |
| `model/thinking` | model | `{ text }` | 思考增量（可合并多条） |
| `tool/call` | model | `{ callId, name, arguments }` | 工具调用请求 |
| `tool/result` | system | `{ callId, ok, result }` | 工具执行结果 |
| `clarify/asked` | model | `{ itemKeys: string[] }` | 澄清问题已发出（配合 wire 事件 `questions`） |
| `clarify/answered` | human | `{ answers: [{ key, optionId }] }` | 人类已回答（取代 `context.interview` 的直接写入） |
| `wireframe/produced` | model | `{ relativeUrl, pageCount, version }` | 线框产物落盘（取代 `/agent/wireframe` 端点） |
| `wireframe/confirmed` | human | `{ version }` | 人类确认线框（**不强制**；`confirm_generation` 亦可直接开始生成） |
| `generation/proposed` | model | `{ reason }` | 模型建议开始生成（不扣费、不产生 run） |
| `run/start` | human | `{ runId, intensity, codeGenType }` | run 创建 + 冻结积分的挂点 |
| `run/phase` | system | `{ phase }` | 计费上报（投影写 `generation_run.phase`，**取值限九值枚举**，语义与现状一致） |
| `run/milestone` | system | `{ title, detail? }` | 里程碑（投影追加 `generation_run.milestones`，**退款锚不变**；语义等价约束见 §3.2 约束 5） |
| `run/token-usage` | system | `{ inputTokens, outputTokens, totalTokens }` | 计量（投影写 `tokenUsage`） |
| `gate/verdict` | system | `{ gate, category, passed, detail }` | 门禁判决（`category ∈ deterministic\|heuristic`） |
| `run/end` | system | `{ status, filesWritten, errorCode? }` | run 终态（见下方词表与 phase 派生规则） |

**`run/end.status` 词表**：`success` / `failed` / `aborted`（对齐 Java `AgentCompleteStatusEnum` 的 `value`，**不用 done/failed/aborted**，避免同一事件混用两套词表）。**phase 派生规则**（与 Java `GenerationRunServiceImpl` 的 `terminalPhaseOf` 映射一致）：`success → done`、`failed → failed`、`aborted → aborted`。

### 4.4 内部 API 契约（Java）

**追加事件（批量，与投影同事务）**

```http
POST /api/internal/agent/apps/{appId}/events
Authorization: Bearer <internal-api.token>
Content-Type: application/json
Idempotency-Key: <turnId>:<batchSeq>
```

```json
{
  "userId": "453132478241230848",
  "runId": "run-7f3c1e8a",
  "events": [
    { "kind": "model/message", "version": 1, "ignorable": 0, "source": "model",
      "payload": { "text": "我先确认两件事再动手。" } },
    { "kind": "run/phase", "version": 1, "ignorable": 0, "source": "system",
      "payload": { "phase": "coding" } },
    { "kind": "run/milestone", "version": 1, "ignorable": 0, "source": "system",
      "payload": { "title": "规划页面结构" } }
  ]
}
```

响应 `200`：

```json
{ "appId": "1001", "appended": 3, "seqFrom": 41, "seqTo": 43, "firstSeqNext": 44 }
```

- **幂等键语义 = 「同一批次重放幂等」**，取值为 `{turnId}:{batchSeq}`（`batchSeq` 在同一回合内从 1 单调递增）。**禁止**用裸 `turnId` 作键：一个回合必然产生 N 次 append，裸 `turnId` 会让第 2 批起被判定为重复而丢弃，导致事件日志残缺、`seq` 断号（破坏 Q1 的根基）。同 key 重复提交返回首次结果，不重复追加。
- `seq` 由 Java 分配（服务端权威，禁止客户端指定），同一 `appId` 内连续：分配机制 = **同一 app 的应用级互斥锁**（沿用 `GenerationRunServiceImpl` 既有的 `appLocks` 思路）内 `SELECT COALESCE(MAX(seq),0) FROM generation_event WHERE appId = ?`，与插入在同一事务内；`uk_appId_seq` 作最后兜底（冲突则重试一次）。
- 同一批次内出现 `run/phase` / `run/milestone` / `run/token-usage` / `run/end` 时，**在同一事务内**更新 `generation_run` 投影（`run/end` 按 §4.3 的 phase 派生规则写 `phase` + `finishedTime`）。
- **投影的 `context` 来源**（补齐，H6）：`clarify/answered` → 投影写 `context.interview`（答案摘要，沿用 `interview/index.ts` 的 `buildSummary` 形态）；`wireframe/produced` → 投影写 `context.wireframe = { relativeUrl, pageCount, version }`。**`context` 不被废弃**——视觉 diff 门禁与阶段 0 缺口① 的注入都从它取数（R2）。
- **写路径校验**：白名单外 `kind` → **400 + 明确 message（拒绝写入）**；`payload` 非对象 / `source` 非 `human|model|system` → 400。

**读取会话事件（重放）**

```http
GET /api/internal/agent/apps/{appId}/events?afterSeq=0&limit=500
```

```json
{
  "appId": "1001",
  "events": [
    { "seq": 41, "runId": null, "kind": "user/message", "version": 1, "ignorable": 0,
      "source": "human", "payload": { "text": "做一个宠物店官网" },
      "createTime": "2026-09-10T14:02:11" }
  ],
  "lastSeq": 41,
  "hasMore": false
}
```

两者错误口径与既有内部 API 一致：无/错 Bearer → **401**；`appId` 非数字 → **400**；白名单外 `kind` 且 `ignorable=0`（读路径）→ **500** + 明确 message（**不静默跳过**）。

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

- `appId`、`action` 必填；`action ∈ chat | confirm_generation`。非法 `action` → 预检 **400**。
- `message` 在 `action=chat` 时必填且非空（空/纯空白 → 预检 **400**）；`action=confirm_generation` 时可选（可作补充说明）。
- **`confirm_generation` 是唯一会花钱的动作，且只能由人类消息触发**（R1：当前由 JWT + 端点结构性保证；不做成模型可调用工具）。
- `codeGenType` 与 `workspacePath` **均由 `GET /app/agent/token` 的响应提供、前端原样回传**（Java 为权威来源，`AgentTokenVO` 按 app 记录计算；本轮为该 VO 增 `codeGenType`）。`codeGenType` 白名单 `html|multi_file|vue_project`，**非法或缺失 → 预检 400（取消现状的静默回退 html）**，理由见 §4.9。`workspacePath` 必须位于 `WORKSPACE_ROOT` 内（沿用现有沙箱校验），越界 → 预检 400。
- `intensity` 白名单 `fast|standard|deep`；非法或缺失 → 按 `standard` 回落（保持现状语义，档位是用户偏好而非安全边界）。
- **请求体不含 `runId`／`history`**：runId 由服务端在 `run/start` 时生成；历史由事件日志重建。

**响应**：`text/event-stream; charset=utf-8`，帧格式不变（`event: <type>` + 单行 `data:` + 空行）。

**事件表（新增/变更部分）**

| event | 必填字段 | 变化 |
|---|---|---|
| 既有五类（`ai_thinking`/`ai_response`/`tool_request`/`tool_executed`/`milestone`） | 原字段 | **新增 `seq`**（源自事件日志序号） |
| `questions` | `type`, `seq`, `items` | **新增**。`items: [{ key, dimension, question, options: [{ id, text }] }]` —— **字段名与现有 `InterviewQuestion` 完全一致**（`agentSse.ts:56-61`），前端可直接透传给 `InterviewQuestionsCard` 的 `questions` prop，无需映射层 |
| `wireframe` | `type`, `seq`, `relativeUrl`, `pageCount`, `version` | **新增**。前端用现有 `buildWireframeUrl(relativeUrl)`（`AppChatPage.vue:776`）拼预览 URL；`version` 用于确认动作的版本校验 |
| `awaiting_user` | `type`, `seq`, `reason` | **新增终态**。`reason ∈ answered\|asked\|wireframe\|proposed`；**回合正常结束、等用户输入**，非 run 终态 |
| `done` | `type`, `seq` | **字段集与语义不变**（生成成功终态，最后一个事件），仅新增 `seq` |
| `error` | `type`, `seq`, `message` | **字段集与语义不变**（唯一失败终态），仅新增 `seq` |

**终态帧示例**

```text
event: awaiting_user
data: {"type":"awaiting_user","seq":47,"reason":"asked"}

event: done
data: {"type":"done","seq":88}

event: error
data: {"type":"error","seq":64,"message":"重试次数已用尽：构建未通过（index.html 缺少 <html> 根）"}
```

**回合终态唯一性**：任一回合必须以 `awaiting_user`、`done`、`error` 三者之一收尾，且其后不再有任何业务事件。`done`/`error` 仅出现在 `action=confirm_generation` 的生成回合。

**前端卡片的三按钮新去向**（原三端点已退役）

| 按钮 | 新语义 |
|---|---|
| 「确认线框，开始生成」 | 发 `action=confirm_generation` + 回传 `wireframe.version`；服务端校验版本后进入生成回合 |
| 「重新生成线框」 | 发一条普通 `action=chat` 消息（如「重新生成线框，页面再少一页」），由模型决定是否再次调用 `write_wireframe`；按钮保留但降级为**消息快捷方式** |
| 「重新访谈」 | **退役**：访谈已不是固定流程，用户直接说话即可（模型按需澄清）。组件删除该按钮与对应 emit |

### 4.6 预算、状态机与地板

**预算（Q14=C）**：`src/generation/intensity.ts` 的 `INTENSITY_TIERS` 增 `maxTokenBudget`，并调高 `maxTurns`：

| 档位 | maxTurns（兜底，调高） | maxToolCalls | maxOutputTokens | maxTokenBudget（主控） | maxImages |
|---|---|---|---|---|---|
| fast | 8 | 20 | 3000 | 60_000 | 2 |
| standard | 16 | 50 | 8000 | 200_000 | 4 |
| deep | 32 | 100 | 16000 | 600_000 | 8 |

- 主控 = `maxTokenBudget`（累计 `usage.totalTokens` 超限即优雅收尾）；`maxTurns`/`maxToolCalls` 仅作死循环兜底，**不再作为对外产品语义**。
- 超限收尾语义不变（注入收尾指令，绝不硬杀），但**收尾后必须仍跑确定性门禁**（见下）。

**run 生命周期状态机 → phase 映射（H2，必须实现为一张显式表）**

| 新链路状态/动作 | 写入的 `phase` | 说明 |
|---|---|---|
| `run/start`（`action=confirm_generation` 回合开始，创建 run） | `wireframe_confirmed` | 该 phase 在新链路的语义 = 「**人类已确认进入生成**」。Java 的冻结闸门要求 `phase == wireframe_confirmed`（`GenerationRunServiceImpl.java:287-290`），故 run 必须以此 phase 创建，冻结逻辑与规则**零改动** |
| `generating` | `coding` | 生成循环进行中 |
| `gated` | `review` | 门禁执行中 |
| `done` / `failed` / `aborted` | 同名 | 终态（`run/end` 经 §4.3 派生规则映射） |
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

### 4.7 计费解耦（Q5=B→A）

1. **上报接口冻结**：`PATCH /internal/runs/{runId}`（`phase` + `milestones`）语义与调用时机不变；投影由事件日志驱动，但 **`phase` 取值集合与九值枚举不变**。
2. **消除静默退化**：`GenerationRunServiceImpl.resolveMilestoneCount` 在「字段为空」时也 `log.warn`（现仅「解析失败」告警，见 `:363-374`），并在 `completeRun` 的 aborted 分支写明确日志（含 `runId`、`milestones` 原始值、采用的折算比例）。
3. **里程碑等价（R4 / §3.2 约束 5）**：新链路的里程碑由「run 阶段推进 + 确定性门禁结果」产生，至少覆盖现状 4 条（进入 coding、规划页面结构、进入 review、生成完成）；A2/A3 必须断言 aborted 场景 `milestoneCount >= 3`（否则 70% 折算静默降级）。
4. **验证脚本（离线，不改扣费）**：`paimeng-ai-code-agent/scripts/verify-refund-anchor.mjs`，输入为一批 run 的事件日志导出（由 A6 产出 `eval/fixtures/refund-samples.json`），输出为「按现有折算规则判定的结果」与「按工具事实（写入文件清单、确定性门禁通过记录、重试次数的**事件派生值**）判定的结果」的逐条对比表。**该脚本只读、只输出报告**；结论出来前不动 `CreditServiceImpl`。

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
    expectEvents: [questions, awaiting_user]     # 期望出现的事件类型（子集断言）
  - action: chat
    message: 受众是本地养宠家庭，风格清爽
    expectEvents: [wireframe, awaiting_user]
  - action: confirm_generation
    expectEvents: [milestone, tool_request, done]
```

- **运行命令**：`cd paimeng-ai-code-agent && node eval/run.mjs --journeys eval/journeys --base eval/fixtures/baseline --out ../docs/ts_agent/agent-loop-eval-report.md`
- **指标口径**（报告必须按此定义计算，避免各说各话）：
  - `memory_retention`：同一 journey 的第 N 轮请求中，system 文本包含第 1..N-1 轮 `user/message` 文本的比率；
  - `deterministic_gate_pass_rate`：`run/end.status=success` 且存在 `gate/verdict(category=deterministic, passed=true)` 的 run 占比；
  - `clarify_rounds`：每 journey 的 `clarify/asked` 事件数；
  - `run_tokens`：每 run 的 `run/token-usage.totalTokens`；
  - `done_ratio`：`run/end.status=success` 占全部 run 的比率。
- **切换门槛**：20 条黄金旅程在**真实模型渠道**上跑通，且 ① 确定性门禁通过率 ≥ 基线；② 跨消息记忆保留率 = 100%（基线为 0）；③ 每 run 积分成本 ≤ 档位预算。**未达门槛不得切换**。

### 4.9 取舍记录（选 A 不选 B 的原因）

| 决策点 | 选择 | 备选与否决原因 |
|---|---|---|
| 事件载体 | MySQL 新表 `generation_event` | 否决 DSH 式 JSONL 文件：本系统是多用户 MySQL 事务系统，退款/结算需**同库同事务**（架构 §8 存储分工原则），文件日志无法与 `credit_ledger` 原子 |
| 事件写路径 | TS → Java 内部 API（Java 分配 seq） | 否决 TS 直连 MySQL（架构红线）；否决「前端生成 runId」（Q16=B 后 run 身份归服务端） |
| 工作区路径 | **Java 为权威**：`AgentTokenVO` 计算并由前端原样回传 | 否决「TS 按 `codeGenType + appId` 自行推导」：Java 侧用的是数据库 app 记录的 `codeGenType`（`AppController` 取实体）且根目录来自 `AppConstant.CODE_OUTPUT_ROOT_DIR`，TS 侧默认 `workspaceRoot` 与之不等价，推导会导致产物写错目录、构建目录不匹配 |
| `codeGenType` 非法值 | **预检 400**（取消静默回退 `html`） | 静默回退会让工作区类型、构建分派与计费类型系数三者不一致（按次付费下是真金白银的错配）。此改动同时了结 `contract-parity.md` 的 P3 修正项「codeGenType 回退 vs 422」 |
| 澄清形态 | 回合结束 + `awaiting_user` + 下次请求续跑 | 否决长连接内暂停等人（fetch-SSE 经反向代理，超时/断连语义不可控） |
| 花钱动作 | `confirm_generation` 仅由人类 action 触发 | 否决「模型可调用 `start_generation` 工具」：R1 要求花钱动作的批准权由代码保证，而模型工具化会把批准权交给模型（提示词不可作为强制） |
| 线框闸门 | 由模型按需产出、可确认但非必经 | 否决全退（Q10=B 已定）；否决照旧必经（与「一句话跑完」矛盾） |
| XState | 保留极小 run 生命周期机 | 否决全删：Q4=B；且它是「非法转移类型层消灭」的现成保障，删除属额外风险 |
| 计费锚 | 保持 `phase+milestones` 上报 | 否决立即改工具事实推导：数据源（门禁记录/文件清单）当前**零结构化落库**，需先建载体（§4.2 已含），且 handoff §2 禁止无评估改扣费 |
| 幂等粒度 | 批次级（`turnId:batchSeq`） | 否决回合级（裸 `turnId`）：与流式多次 append 结构性冲突（§4.4） |

## 5. 任务分解

**依赖顺序**：`A0 → (A1 → A2 → A3) → (A4 ∥ A5 ∥ A6) → A7 → A8`；`E1` 可与 A1–A3 并行，但必须早于 `A7`。

**基线约定**：A0 用**阶段 0（#23/#24）合并后的 HEAD**；A3 开工前必须确认 #23/#24 已合并（否则 §2.3 前置不满足）。

| # | 任务 | 产出物（文件 + 行为） | 依赖 |
|---|---|---|---|
| A0 | 基线快照采集 | `eval/fixtures/baseline/*.json`（20 条旅程的旧链路录制）+ `eval/README.md`（采集方法） | 阶段 0 合并 |
| A1 | 事件日志 DDL | `sql/create_table.sql` 追加 `generation_event`；实库执行并记录 `SHOW CREATE TABLE` | — |
| A2 | Java 事件服务 | `GenerationEvent.java`、`GenerationEventMapper.java`、`GenerationEventService(+Impl).java`、`EventAppendRequest.java`、`GenerationEventVO.java`、`GenerationRunController` 两个端点；单测：append 连号、批量投影（含 `context` 两类来源）、批次幂等、写路径未知 kind 拒绝、读路径未知 kind 拒绝、401/400、并发 append 无重复无空洞 | A1 |
| A3 | TS 会话客户端 + 统一回合端点 | `src/session/{events,sessionClient}.ts`、`src/turn/{index,generationTurn,tools,floor}.ts`、`agentRoutes.ts` 新端点、`AgentTokenVO` 增 `codeGenType`（Java）；会话回合可澄清/出线框、生成回合可跑通 | A2、阶段 0 合并 |
| A4 | 工具面与地板分级 | `src/turn/tools.ts`（`ask_user`/`write_wireframe`/`propose_generation`）、`src/turn/floor.ts`、`review/types.ts` 门禁类别；**修掉超限跳过确定门禁的旁路** | A3 |
| A5 | 预算改造 | `src/generation/intensity.ts` 增 `maxTokenBudget` 并调高 `maxTurns`；核实前端**本就无步数展示**（`grep 步数/maxTurns` 零命中），无需前端改动，仅在 issue 记录该核实结果 | A3 |
| A6 | 计费告警与退款锚验证脚本 | `GenerationRunServiceImpl` 告警；`scripts/verify-refund-anchor.mjs`；`eval/fixtures/refund-samples.json`（导出方式：用 A2 的读端点 `curl "…/apps/{appId}/events?afterSeq=0&limit=500" -H "Authorization: Bearer $TOKEN" > eval/fixtures/refund-samples.json`，附一次 jq 整理为脚本输入格式）；一份对比报告 | A1 |
| A7 | 前端改造 | `AppChatPage.vue` `journeyPhase` 退役 + 新事件渲染 + 伪 assistant 拼接删除；`agentSse.ts` 契约更新；`WireframeReviewCard.vue` props 扩展与三按钮新语义 | A3、E1 |
| A8 | 回归与切换 | 旧三端点与 `/agent/stream` 删除；TS `npm test`/`type-check` 全绿、Java 相关测试全绿、前端 `type-check`/`lint` 全绿；eval 报告 | A4–A7、E1 |
| E1 | eval 体系 | `eval/journeys/*.yaml`（≥20 条）+ `eval/run.mjs` + `eval/README.md` + `docs/ts_agent/agent-loop-eval-report.md` | A0 |

**每个任务的完成标准 = §6 对应验收项全过 + 该任务产生的测试全绿 + 一笔 commit。**

## 6. 验收标准

**A1（DDL）**
- `mysql> SHOW CREATE TABLE generation_event;` 输出含 `UNIQUE KEY uk_appId_seq (appId, seq)` 与 `ignorable` 列（贴实测输出到 issue）；
- 同一 `appId` 重复插入相同 `seq` → 报唯一键冲突（手工 SQL 验证）。

**A2（Java 事件服务）**
- `./mvnw -o test -Dtest='GenerationEventServiceImplTest,GenerationRunControllerTest'` 全绿，覆盖：
  - 批量 append 返回 `seqFrom/seqTo/firstSeqNext` 且 `seq` 连号；
  - **同一 turn 的多个批次（`{turnId}:1`、`{turnId}:2`…）全部落库**，仅**同批次重复**才幂等丢弃；
  - 并发 append（两线程并发写同一 app）→ `seq` 无重复、无空洞（或以唯一键冲突重试后成功）；
  - 同批次含 `run/phase` + `run/milestone` + `run/end` 时 `generation_run` 投影同事务更新（失败注入时两者都不落库），且 `run/end.status=success → phase=done`；
  - `clarify/answered` → 投影写 `context.interview`；`wireframe/produced` → 投影写 `context.wireframe{relativeUrl,pageCount,version}`；
  - **写路径**白名单外 `kind` → **400 + 明确 message**（拒绝写入）；
  - **读路径**白名单外 `kind` 且 `ignorable=0` → **500 + 明确 message**（不静默跳过）；
  - 无/错 Bearer → **401**；`appId` 非数字 → **400**。
- `curl -X POST http://localhost:8123/api/internal/agent/apps/1001/events -H "Authorization: Bearer $INTERNAL_API_TOKEN" -H "Idempotency-Key: t-1:1" -d @events.json` → 200 且响应体 `appended` 与请求条数一致。

**A3（统一回合端点）**
- `cd paimeng-ai-code-agent && npm run test && npm run type-check` 全绿；新增用例：
  - `action=chat` + 模糊需求剧本 → 事件序列含 `questions` + `awaiting_user`，**不含** `done`；且 `questions` 载荷字段与 `InterviewQuestion`（`key/dimension/question/options[{id,text}]`）逐字段相等；
  - `action=chat` + 清晰需求 → 事件序列含 `ai_response` + `awaiting_user`（**不扣费**：断言未调用 `freezeCredit`）；
  - `action=confirm_generation` → 先 `freezeCredit`，再 `milestone`/`tool_*`，末帧 `done`；断言**全部事件（含 `done`）带递增 `seq`**；
  - **跨消息记忆**：同一 `appId` 连续两次请求，第二次的 system 文本断言含第一次的 `user/message` 与 `model/message` 文本；
  - **里程碑等价**：aborted 场景断言 `milestoneCount >= 3`（否则 70% 折算会静默降级为 50%）；
  - **确定性门禁不可跳过**：`limit-length` 剧本（截断）→ 断言仍执行 build 门禁；门禁失败 → run `failed` + 全额退款回调，**不得**出现 `done`；
  - 启发式门禁失败（质检分不通过且已是最后一次尝试）→ 断言仍可 `done`，且 `gate/verdict(category=heuristic)` 事件在流内；
  - `action=chat` 时模型工具面**不含**任何会花钱的工具（断言工具清单）；
  - **边界**：非法 `action` → 预检 400；`action=chat` 空/纯空白 `message` → 预检 400；非法 `codeGenType`（如 `react`）→ 预检 400（**不得**静默回退 html）；非法 `intensity` → 回落 `standard` 且请求成功；`workspacePath` 越界 → 预检 400；
  - **同 app 并发回合**：第二个并发回合 → 409（应用级互斥），或串行化后断言两回合事件 `seq` 仍连续。
- WSL 宿主改走 `bash scripts/run-wsl.sh test`。

**A5（预算）**
- `npm test` 中 `test/generation/intensity.test.ts` 三档 `maxTokenBudget` 断言通过；
- 超限剧本：累计 token 达预算 → 断言注入收尾指令 + `ai_thinking` 收尾文案（沿用现有断言口径）；
- issue 记录「前端无步数展示」的 grep 核实结果（无对象改动，不需验收断言）。

**A6（计费）**
- `./mvnw -o test -Dtest='CreditServiceImplTest,GenerationRunServiceImplTest'` 全绿；
- `milestones` 为空/非法 JSON 时日志含明确 warn（断言 logger 输出或改用可注入告警回调的单测）；
- `node paimeng-ai-code-agent/scripts/verify-refund-anchor.mjs eval/fixtures/refund-samples.json` → 输出逐条对比表，且脚本对**只读输入**不做任何写操作（断言输出文件路径可指定且在仓库外亦可）。

**A7 / E1 / A8（前端、评估与切换）**
- 前端 `npm run type-check` + `npm run lint` 全绿；`grep -n "journeyPhase" src/pages/app/AppChatPage.vue` 零命中；`grep -n "reinterview" src/` 零命中；
- HTTP 层 e2e（curl，原生 Linux + docker compose MySQL/Redis + Java 8123 + TS Agent 8092，真实登录态 JWT）：注册登录 → `GET /app/agent/token`（取 `workspacePath`/`codeGenType`）→ `POST /agent/turn`（chat，模糊需求）→ 收到 `questions` + `awaiting_user` 且**余额不变** → `POST /agent/turn`（chat，带答案）→ 收到 `wireframe` + `awaiting_user` → `POST /agent/turn`（`action=confirm_generation`）→ 冻结（余额减少）→ `done` → `run/phase=done` + `credit_ledger=SETTLED` + `generation_event` 中该 run 事件连号；
- 中断剧本：生成中断开连接 → `aborted` 终态 + 按现有规则折算退款（与改前同结果，含 `milestoneCount` 对账）；
- 余额不足 → 预检 **402**（不产生任何 token 消耗、不追加 `run/start` 事件）；
- eval 可复现：`cd paimeng-ai-code-agent && node eval/run.mjs --journeys eval/journeys --base eval/fixtures/baseline --out ../docs/ts_agent/agent-loop-eval-report.md` 成功产出报告，报告含 §4.8 五项指标的定义与数值、基线对比、切换门槛三条判据的逐条勾选。

## 7. 风险与陷阱

| 风险/陷阱 | 说明与对策 |
|---|---|
| **假 LLM 剧本范式局限** | 现有 160 个测试全在「假 LLM + 固定剧本」下；模型接管决策后，剧本必须能表达「先问再答」的两回合序列。对策：`src/llm/index.ts` 增多回合剧本（按 `turn` 序号推进），**不改** provider 注入接缝 |
| **`done`/`error` 断言会大面积失效** | `test/server/stream.test.ts:38-44,84-85,136` 断言事件序列与 phase 序列全等。对策：这些断言按新契约重写（属预期返工），且 A0 基线快照先固化为护栏 |
| **退款比例静默退化** | `milestoneCount` 缺失时静默走 50% 分支（`CreditServiceImpl.java:301`）。对策：§3.2 约束 5 的里程碑等价 + A6 告警 + 事件日志使 milestone 可重放核对 |
| **同 app 并发 409 依赖 run 终态** | Java 并发校验读非终态 run（`GenerationRunServiceImpl.java:116-121`，`TERMINAL_PHASES` 定义在 `:70-75`）；投影延迟会造成「同 app 双开 run」。对策：投影与事件**同事务**（A2 验收项），并在同一 app 的回合端点加应用级互斥（A3 验收项） |
| **SSE 经 nginx 被缓冲** | 生产模板 `deploy/nginx.conf.example` 的 `location /agent/` 内已 `proxy_buffering off`；新端点同前缀 `/agent/*`，无需改路由 |
| **`seq` 连续性与乱序** | 事件由 Java 分配 seq，TS 侧只读；同一 app 的并发 append 必须串行化（应用级互斥 + `uk_appId_seq` 兜底），A2 有并发断言 |
| **手工 DDL 漂移** | 无 Flyway；`sql/create_table.sql` 是唯一真源，必须同步并留实库证据（§3.2 约束 11） |
| **WSL 运行时陷阱** | 仅 WSL 宿主用 `wsl-rt-env/`；vitest 的 `--configLoader runner` **必须保留**（去掉会 EROFS 失败）；`node --watch` 在 DrvFs 上收不到事件，dev 走 esbuild watch |
| **前端零测试** | 前端无测试文件，A7 的验收只能靠 `type-check`/`lint` + curl e2e + 人工走查；不假装有单测 |
| **阶段 0 与 A 系列并行** | 两者都碰 `agentRoutes.ts` / `workflow/index.ts`，存在冲突风险。对策：阶段 0 先落地并合并；A0/A3 以合并后的 HEAD 为基线（§5 已写死） |
| **eval 用假 LLM 不算数** | 切换门槛必须在**真实模型渠道**跑（R3）；假 LLM 下 eval 只作回归 |

## 8. 参考资料

**项目内（开工前必读）**

- 当前架构权威：`docs/ts_agent/architecture.md`（§1.1 拓扑与红线、§3.1 收敛纪律、§3.2 run 表、§3.3 五层护栏、§4 闸门纪律、§6 门禁、§7 计费、§8 存储分工、§10 退役、§11 实施顺序）
- 现有 wire 契约：`docs/ts_agent/contract.md`（事件表、错误双轨、生命周期）
- 实施进度与测试基线（160/160）：`docs/ts_agent/progress.md`
- 契约对账（P3 修正项）：`docs/ts_agent/contract-parity.md`
- 阶段 0 行动入口：`docs/hand-off/2026-09-10-agent-loop-brief.md`（边界与必验假设）
- 架构讨论纪要：`docs/hand-off/2026-09-09-architecture-evolution.md`（**只读**，勿改）
- 跨会话记忆：`MEMORY.md`、`.agents/memories/ts-agent.md`、`.agents/memories/java-backend.md`、`.agents/memories/deployment.md`
- DDL 真源：`sql/create_table.sql`
- 键代码：`paimeng-ai-code-agent/src/generation/workflow/{index,machine}.ts`、`src/server/agentRoutes.ts`、`src/protocol/events.ts`、`src/interview/{index,conduct,context}.ts`、`src/generation/review/index.ts`、`src/runs/runClient.ts`
- Java：`src/main/java/com/zdan/paimengaicodemother/{controller/GenerationRunController.java,controller/AppController.java,constant/AppConstant.java,service/impl/{GenerationRunServiceImpl,CreditServiceImpl}.java,model/entity/GenerationRun.java,model/vo/AgentTokenVO.java}`
- 前端：`paimeng-ai-code-mother-frontend/src/pages/app/AppChatPage.vue`、`src/utils/agentSse.ts`、`src/components/{InterviewQuestionsCard,WireframeReviewCard}.vue`
- 启动与运行时分流：`.agents/skills/project-startup-guardrail/SKILL.md`
- Issue 流程：`docs/agents/issue-tracker.md`（父 issue #1；本设计的子 issue #25）
- 注释规范：`.agents/skills/project-comment-style`

**外部（设计参照，均为本地可读的安装产物）**

- DSH 事件溯源与 loop 设计：`/home/zdan/.nvm/versions/node/v24.20.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-{session,agent-loop,goal,goal-round-driver,tool-goal,tool-ralph}/README.zh.md`
  - 事件溯源纪律：`dsh-session/README.zh.md` 原文「提供**仅追加的会话日志**……每个模型可见事实都流经的**单一真源**。LLM 消息历史由日志*派生*（`deriveMessages()`），**从不另行存储**」
  - 未知事件类型拒绝解释：`dsh-session/lib/types/known-event-types.d.ts` 原文「The persistence read path **refuses to interpret** a log containing a type outside this set unless the event carries the envelope's `ignorable` marker…… **silently skipping a required event would reconstruct a wrong session.**」
  - 人类身份证明：`dsh-tool-goal/README.zh.md` 原文「`Agent.followup()` 与 `steer()` 会在调用方省略 source 时分配 `{ kind: 'user' }`，因此**插件、调度器与其他非人类生产方必须传入自己的 source，不能继承人类权限**」
  - 「无编排」的自我声明：`dsh-agent-loop/README.zh.md` 原文「它是 harness **唯一的具象循环**——超出「调用模型、运行工具、重复」的所有内容都属于**监听事件分类体系**的插件」
- 注意：DSH 包**不可作为依赖引入**（peer 依赖整套运行时图、tarball 不含 `src/`、npm `latest` tag 陈旧）。

## 9. 待用户裁决项（本设计已给出方案，用户可否决）

| # | 设计选择 | 备选 |
|---|---|---|
| J1 | 事件载体 = MySQL 新表 + `generation_run` 转投影（§4.2） | 独立事件库/PG；JSONL 文件 |
| J2 | 澄清以「回合结束 + `awaiting_user` + 下次请求续跑」表达（§4.9） | 长连接内暂停等人（DSH 式） |
| J3 | 花钱动作 `confirm_generation` **不**做成模型工具（§4.9，R1） | 做成工具 + 立即启用 source 强制 |
| J4 | run 生命周期保留极小 XState 状态机（§4.6） | 纯服务端函数式校验，删除 xstate 依赖 |
| J5 | 统一端点用新路径 `POST /agent/turn`，旧三端点 + `/agent/stream` 一次性退役 | 复用 `/agent/stream` 路径，减小前端与 nginx 改动 |
| J6 | 预算主控用 `maxTokenBudget`，`maxTurns` 仅兜底（§4.6） | 保留步数为主控（现状语义） |
| J7 | `codeGenType` 非法值改**预检 400**（取消静默回退 `html`），并让 `AgentTokenVO` 回传权威 `codeGenType` | 保留静默回退；或改 422（契约对账 P3 的另一个方向） |

## 10. 审查与修订记录

- **审查方式**：`agent-design-review` 八要素检查表（`references/review-criteria.md`），由独立子 agent 执行，含三项硬核验：引用真实性（逐路径实测）、代码事实抽样（行号与常量核对）、内部自洽性。
- **审查结论**：**PASS-WITH-FIXES**（阻塞 0 / 高 7 / 中 10 / 建议 5）。引用真实性专项：无「引用指向不存在文件」；行号类引用 17 处正确、1 处不准确（已订正为 `GenerationRunServiceImpl.java:116-121`）。
- **修订清单（全部就地落实）**：
  - 高：H1 `questions` 载荷改为与 `InterviewQuestion` 逐字段一致（`key/dimension/question/options[{id,text}]`）；H2 补 §4.6 状态→phase 映射表（`run/start → wireframe_confirmed`、`generating → coding`、`gated → review`）并写明四个 phase 的去向；H3 幂等键改 `turnId:batchSeq`（批次级）并补「同 turn 多批次全部落库」验收；H4 `workspacePath` 回归 Java 权威（`AgentTokenVO` 回传、前端原样回传），`codeGenType` 非法改 400；H5 阶段 0 从 §2.1 In 与 §3.1 文件清单摘出、标注 #23/#24 负责并写明 A0/A3 基线；H6 补 `context` 两类投影来源；H7 统一 `eval/` 路径基准、补 A6 fixture 产出物与导出命令、补 E1 运行命令与 yaml schema 与指标口径。
  - 中：M1 并发校验行号订正为 `:116-121`；M2 基线改为 160/160 并区分「测试条数」与「行为基线」；M3 三处对齐 `src/turn/{index,generationTurn,tools,floor}.ts`；M4 统一为「全部事件（含 done/error）带 seq」；M5 补写路径未知 kind → 400；M6 补四条边界验收（非法 action/空 message/非法枚举/同 app 并发）；M7 补 seq 分配机制与并发 append 验收；M8 `run/end.status` 改用 `success|failed|aborted` 并给 phase 派生规则；M9 依赖链与依赖列对齐、A5 的无对象产出物改为「核实并记录」；M10 补三按钮新去向与 `WireframeReviewCard` props 扩展要求。
  - 建议：S1 写明判据 1 的基线口径；S2 DDL 注释声明 append-only 取舍；S3 改引 DSH 原文；S4 本记录落仓；S5 补三类终态帧示例。
- 审查原文与核查证据同时贴在本 issue #25 的评论中，供落地 Agent 复核。
