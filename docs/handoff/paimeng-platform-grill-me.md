# 非技术用户应用生成与托管平台：设计审查交接

## 任务状态

正在通过 `/grill-me` 方式审查“面向非技术用户的应用生成与托管平台”的 MVP 系统设计。用户要求：一次只问一个最重要的问题；每题先给推荐答案和理由；动态追问而非机械问卷；持续区分 Product / Agent / Platform 三层；优先利用 Pi SDK 已有能力，避免提前建立通用多 Agent Framework。

当前尚未完成审查或形成最终架构文档。下一轮应等待用户回答 **Q13：Agent Runtime 是否只作为单次 Agent Run 的受控执行协调器**，再继续沿设计树追问。

## 已调查的事实

- Pi SDK 文档：`/home/zdan/.nvm/versions/node/v24.20.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/sdk.md`
  - `AgentSession` 管理单会话模型交互、消息历史、工具循环、事件流、压缩、会话中断与 Session Manager。
  - 可设置受限工具集和自定义工具；可绑定指定 `cwd`。
  - `AgentSessionRuntime` 支持会话替换，但不拥有产品领域对象。
  - Pi 不提供 Application、Task、Profile、发布、部署、生产运维或内建 subagent/plan framework。
- Pi README：`/home/zdan/.nvm/versions/node/v24.20.0/lib/node_modules/@earendil-works/pi-coding-agent/README.md`
- 只读仓库探索（结果不完整但有用）：`paimeng-ai-code-agent/` 已有 SSE 事件协议、工作区/文件工具和 Agent 基础；前端有 `paimeng-ai-code-frontend/src/utils/agentSse.ts`；依赖声明中可见 XState 和 AI SDK。不得把这些现有实现误认为完整的 Application/Task/Release/Deployment 领域模型；需要后续按需验证。

## 已确认的产品范围

- 用户：非技术人员。
- MVP 目标：验证从自然语言需求到可运行、可部署、可后续修改的完整闭环，而不是代码补全。
- 仅支持：单组织内部业务 Web 应用。
- 固定技术形态：TypeScript 全栈模板 + 平台托管关系数据库。
- 支持的业务能力：核心实体/字段、表单、列表/筛选、详情、基础仪表盘、简单状态流转。
- MVP 不支持：支付、第三方集成、复杂多人协作权限、异步业务工作流、自定义后台任务、原生移动端、用户自带基础设施、多语言、多部署环境、复杂企业或大规模生产能力。

## 已确认的领域边界与对象

### 三层

- Product Layer：非技术用户可见的应用生成、修改、发布、运行状态；不暴露代码、容器、Git、构建命令、集群、密钥等。
- Agent Layer：需求理解、澄清、计划、代码修改、验证方案、Candidate Profile Diff、失败修复。
- Platform Layer：权威持久状态、隔离、构建、验证环境、发布、部署、数据库、日志、健康、资源、回滚、状态门禁。

### Application

Application 是平台拥有的长期产品实体，不等同于代码仓库：

```text
Application = 产品事实 + Agent 可用的长期产品上下文 + 源码/版本 + 发布/运行事实
```

事实分层：

- Product：应用身份、用户可见状态、当前线上版本、用户需求、验收标准。
- Agent：可信产品事实、候选业务事实、当前 Task 的计划/结果。
- Source：TypeScript 源码、锁定依赖、数据库迁移；唯一可执行事实。
- Release：构建产物、源码版本、配置引用、验证结果、部署记录。
- Runtime：实例、运行状态、日志等。

### Application Profile

- `Application Profile` 是附属于 Application 的、长期存在、可版本化的可信产品事实基线。
- 它不是 DSL，不参与应用运行；源代码是唯一可执行事实。
- 生命周期：`Candidate -> Trusted -> Superseded`。
- Candidate 失败、拒绝或放弃，不成为 Trusted；保留必要任务记录即可。
- Agent 不可直接写 Trusted；业务事实变化的 Candidate 需关联 Requirement、Task、源码版本、验证证据。
- 当源码和 Trusted Profile 出现未解释的业务语义冲突时，不允许静默覆盖，进入同步/澄清。
- MVP 实现：版本化 JSON 文档；不建复杂 DSL 或 Profile <-> Code 双向同步引擎。

固定、封闭的 MVP Profile 骨架：

```json
{
  "purpose": {
    "users": [],
    "problem": "",
    "inScope": [],
    "outOfScope": []
  },
  "actors": [],
  "domain": { "entities": [] },
  "workflows": [],
  "acceptance": [],
  "constraints": []
}
```

Profile 仅保存当前稳定、有效、值得后续 Agent 长期显式记住的产品事实。准入条件：当前有效的业务含义/约束/长期目标；缺失会导致错误理解或修改；属于产品层语义（即使可从源码部分推断也值得显式保留）；有用户明确意图或其经过验证的直接展开；能写成当前事实而非推理/计划/过程。

应保存：应用目的及边界、业务角色和核心能力、核心实体及业务含义、关键业务流程/状态/不可违反规则、长期有效的用户可观察验收目标、长期业务约束。

不得保存：用户原话与历史讨论、任务计划/重试、路由/API/SQL/依赖/目录等实现细节、日志/截图/测试报告、Release/部署事实、Agent 推理与猜测。

### Conversation / Requirement / Task / Agent Run

它们不一一对应：

```text
Conversation -> 多个 Requirement -> 多个 Task -> 多个 Agent Run
```

- Conversation：交互上下文，不承担 Application 变更状态。
- Requirement：用户原始意图与上下文引用，不被 Agent 改写。
- Task：Application 上持久、可追踪、可恢复的受控交付变更单元，独立于具体 Agent Engine。
- Agent Run：对一个 Task 的一次执行尝试；一个 Run 只属于一个 Task；Task 可有多个按时间顺序的 Run。
- Agent Engine Adapter：屏蔽 Pi 与未来 Engine 的内部 Session、工具循环、Context 等实现。

Task 在实施开始时固定：

```text
baseProfileVersion
baseSourceRevision
requestedOutcome
acceptanceTarget
```

MVP Task 状态：

```text
created -> ready -> executing -> { blocked | failed | validated } -> released
```

`clarifying` 不作为 MVP Task 状态。需要澄清时可尚不创建 Task，或使用 `blocked` 并保存 `blockingReason.reason` 和唯一 `blockingReason.question`。

Task 不等于 Release；纯工程变更通常不产生 Profile 版本，业务变更可能产生 Candidate/Trusted Profile。

### 需求归一化与澄清

MVP 不将每条用户输入直接交给代码 Agent，也不建立独立 Interview Engine、授权系统或 Requirement Management System。

流程：

```text
Conversation input -> immutable Requirement -> Agent normalization
  -> 识别目标、与 Trusted Profile 的关系、requestedOutcome、acceptanceTarget、可独立 Task、决定性业务歧义
  -> ready 或 blocked
```

Task `ready` 表示：业务目标和验收结果足够明确，Agent 能在不凭空创造业务规则的情况下开始实施；不要求技术细节已确定。

Agent 可自行展开用户明确意图所必需的实现和自然业务展开。例如“主管可批准/拒绝预约”可以自然形成主管角色、待审核状态、审核动作、审核页面和申请人查看结果。

若不同答案会导致不同产品行为，Agent 必须 `blocked`，一次只问一个最高信息增益的业务问题；不能自行发明规则。技术选择默认由 Agent/模板决定，除非确实改变业务行为。

用户明确拒绝在 MVP 引入：`authorizedScope`、`authorizedChange`、独立授权语义对象、用户授权范围编辑器、通用需求 DSL。

### 语义越界风险模型

这是明确接受的 MVP 风险：Platform 不理解自然语言业务语义，不能自动证明 Agent 理解没有越界。不要保留或承诺 `Actual Semantic Changes subset of Authorized Candidate Changes` 这类需要授权对象/语义裁判的硬门禁。

替代机制：

```text
Requirement 原文 + Trusted Profile + Agent 澄清义务
 -> Task
 -> Candidate Profile Diff（只有业务事实发生变化时）
 -> Validation
 -> Trusted Profile
```

Candidate Profile Diff 不是授权对象，只记录 Agent 所认为的业务事实变化及其解释依据，最小信息：

```json
{
  "requirementRefs": ["requirement-id"],
  "changes": [{ "kind": "workflow", "summary": "..." }],
  "conciseRationale": "这是对某段用户需求的直接实现展开。"
}
```

Platform 只检查确定性完整性：引用完整、无未解决阻断、Snapshot/Validation/Profile/Task 关联完备；不裁决自然语言语义。残余风险依赖封闭 Profile、用户可见业务摘要、一次一问、预览/验证、Profile 版本化和持续修改来缓解。

## 源码、工作区和验证证据链

### 并发与隔离

- 同一 Application 在 MVP 同时只允许一个可写 Task；其他 Task 可创建并排队，但无源码写入权。
- 每个 Agent Run 从 Task 的 `baseSourceRevision` 创建独立可写 Workspace。
- Agent 不得直接修改已发布版本、其他 Run 的 Workspace 或 Production。
- 失败 Run 不覆盖历史；新 Run 不依赖旧 Engine Session 完整存在。
- 数据库迁移随源码版本管理；Agent 可在隔离 DB 验证，绝不可直连/修改生产 DB。

### 四个源码相关对象

```text
Workspace (writable)
  -> CandidateSourceSnapshot (immutable candidate)
  -> Validation
  -> SourceRevision (validated stable baseline)
  -> Release
  -> Deployment
```

- `Workspace`：Run 内唯一可写目录，临时，可清理。
- `CandidateSourceSnapshot`：冻结的、不可变的验证对象；最小字段：`id`, `taskId`, `agentRunId`, `contentRef`, `baseSourceRevision`, `createdAt`。
- `Validation` 必须直接绑定 CandidateSourceSnapshot；同一个 Snapshot 可有多个 Validation。
- `SourceRevision`：已通过必要验证，成为 Application 后续 Task 基线的不可变版本。
- Snapshot 成功晋升为 SourceRevision 时可以只改变生命周期语义：`SourceRevision.contentRef -> Snapshot.contentRef`，无需复制物理源码。
- MVP 可用 Git commit、内容哈希或不可变对象存储；无需另建版本控制系统。

## Validation 与完成定义

Agent 可提出并触发验证，但不能自行宣布完成。平台只对同一个 CandidateSourceSnapshot 判定结果。

技术栈/项目模板定义 Engineering Gates，不是全平台硬编码：锁定依赖安装、类型检查、可选 lint、生产构建等。

最小验证层：

1. Engineering Gates：可重复构建。
2. Database Gates：隔离测试 DB 应用迁移、必要 seed/关键 DB 操作。
3. Runtime Gates：受限 preview/validation 环境启动、健康检查、关键 API/页面可访问、服务未立即崩溃。
4. Task Acceptance：基于 `acceptanceTarget` 的用户可观察行为，优先转为可执行 Given/When/Then 场景并由 Platform 执行。

```text
Task = validated
= 所有该 Task 必需验证已在同一 CandidateSourceSnapshot 通过
```

不可可靠自动验证的业务目标不能由 Agent 默认成功。发布前必须明确处理：用户确认或阻断/澄清。MVP 可以保持 Validation/Evidence 轻量：结构化结果、日志/报告/截图等必要引用。

Platform 安全隔离（生产凭据不可见、验证环境与生产隔离、日志不可泄密）是持续 Trust Boundary，不属于每个 Task 的普通验收条件。

`validated`、`Release eligible`、`Deployment succeeded` 是不同事实：

```text
validated Task -> SourceRevision -> build/artifact/config refs/evidence -> Release -> Deployment -> post-deploy health
```

## 发布、部署与运维边界

Agent 可：生成源码/migration、声明需要的配置名、在验证环境验证、请求创建 Release/部署、读取受控的部署诊断、在确认是应用缺陷时再创建/继续 Agent Run 修复。

Agent 不可：操作生产实例、读取生产密钥、直连生产 DB、决定生产资源、执行生产 migration、切流、删除生产实例、自行宣布部署成功。

Platform 独占：生产构建、配置/密钥注入、生产 migration、流量切换、部署后健康检查、资源、日志、回滚。

MVP 固定运行契约：

```text
一个 TypeScript 全栈 HTTP 服务
一个托管关系数据库
固定 health check
固定构建流程
固定资源规格
固定日志/监控入口
```

Agent 只能声明配置名、migration 和应用运行需求；不可随意要求多服务、Redis 集群、VPC、公网 DB 或任意 CPU/内存。

- `Release created != Deployment succeeded`。
- Deployment 平台暂态故障：Platform 重试或回滚，不必叫 Agent。
- 应用缺陷：Platform 保存脱敏诊断；Agent 形成新 Run 修复，产生新 Snapshot/Revision/Release。
- 数据库安全原则：前向迁移；破坏性 migration 额外门禁；不自动执行通用反向 migration；源码回滚不等于数据库回滚。
- 用户只看“正在发布 / 已上线 / 发布未成功且已保持上一稳定版本”，不看容器、镜像、端口、迁移命令或密钥。

## 尚未决定：当前 Q13

下一位 Agent 应以以下**单个问题**继续，而不是跳到最终方案：

> **Q13 - Agent Runtime 是否只作为“单次 Agent Run 的受控执行协调器”，而不拥有 Application / Task 的业务真相？**

推荐答案：是。

拟议边界：

```text
Platform Domain State
  - Application / Profile / Requirement / Task / Run / Snapshot
  - 写入锁、状态转换、Validation、Release、Deployment
  - 权威持久状态
       ↓
Agent Runtime（一个 Run 的执行协调器）
  - Run 租约和 Application 写锁
  - 从 baseSourceRevision 物化隔离 Workspace
  - 组装受控 Run Context
  - 调用 Agent Engine Adapter
  - 流式转发并持久化规范化事件
  - 管理超时、取消、资源限额、清理
  - 请求 Platform 执行 Snapshot / Validation / 状态转换
       ↓
Agent Engine Adapter
  - Run Context -> Pi 或未来 Engine 的输入
  - 提供受控工具
  - Engine Session、模型调用、工具循环、内部上下文
  - Engine 事件 -> 统一 Agent Run 事件
       ↓
Pi SDK
  - AgentSession、消息历史、工具循环、压缩、事件流
  - 不拥有 Task/Profile/Release/Deployment
```

建议的最小 Run Context：Task 基线与 outcome/acceptance、Trusted Profile、相关 Requirement 原文与澄清、base source 说明与 Workspace、必要的失败摘要/Evidence 引用、Candidate Profile Diff（若有）、受控 Tool Contract、执行政策（不得访问生产/越过 Workspace，何时 blocked）。不要盲目注入完整 Conversation、历史 Session、生产日志或密钥。

待用户确认后，优先继续审查：

1. Tool Contract 的最小工具与权限边界（重点：Agent 是否只能通过平台工具操作 Workspace、Snapshot、验证、发布请求；如何避免任意宿主机 shell）。
2. `Context / State` 的持久化与恢复语义（Task/Run/Engine 各自状态和重启后恢复）。
3. MVP 是否需要 Subagent（推荐默认不需要；只在被证明有价值的独立、只读、可验证工作上按需创建，不先建多 Agent Framework）。
4. 回答完设计树后，汇总最终用户要求的八项：MVP 必需能力、MVP 不做、已确定决策、急需决策、最大风险、最小闭环、实现顺序、第一阶段代码。

## 建议技能

- `grilling`：继续单问题、动态设计树式审查；用户明确要求该方式。
- `codebase-design`：当对话转为正式模块接口、所有权和深模块边界设计时调用。
- `agent-design-review`：在形成可交给工程 Agent 实现的正式设计文档后，做分级设计审查；不要替代当前 grill-me 过程。
- `code-review`：仅在实际代码或变更出现、用户要求审查时调用。

## 交接文档记录

## Start Record

- Status: `active`
- Task type: `change delivery`
- Source: 用户要求将临时交接文档置于 `docs/handoff/`
- Target: 仓库内存在可供下一位 Agent 使用的当前设计审查交接文档
- Input / evidence: 本次 `/grill-me` 对话与临时交接文件 `/tmp/paimeng-platform-grill-me-handoff-2026-09-18.md`
- Non-goals: 不修改产品代码、架构设计结论或既有文档
- Affected scope: `docs/handoff/paimeng-platform-grill-me-2026-09-18.md`
- Acceptance criteria:
  - 文档在目标路径存在且可读取
  - 文档包含当前已决策、当前问题与建议技能
  - 不覆盖既有文件，不包含敏感信息
- Planned validation:
  - `test -f docs/handoff/paimeng-platform-grill-me-2026-09-18.md` - 文件存在
  - 人工回读关键章节 - 当前交接结论与路径正确
  - `rg -n -i '(api[_ -]?key|secret|password|private[_ -]?key|token)\\s*[:=]' docs/handoff/paimeng-platform-grill-me-2026-09-18.md` - 无意外敏感赋值
- Risks: 交接文件的错误路径说明会误导下一位 Agent；文档可能意外包含敏感信息
- Rollback: 删除本次新增的 `docs/handoff/paimeng-platform-grill-me-2026-09-18.md`
- Escalation decision: None

## Delivery Record

- Final status: `delivered`
- Change summary: 已将临时交接文档复制到仓库内目标路径，并修正闭环协议来源与路径说明。
- 闭环协议来源：[`~/.agent-plugins/prompts/AGENTS.md`](/home/zdan/.agent-plugins/prompts/AGENTS.md:274) 引用了 `../assets/closed-loop/`；相对其目录 `~/.agent-plugins/prompts/` 解析，实际目录为 `~/.agent-plugins/assets/closed-loop/`。已读取 `task-loops.md`、`protocols/task-record-template.md` 与 `protocols/validation-execution.md`。
- Actual validation:

  | Command | Existing entry point | Status | Exit status | Sanitized result / blocker |
  | --- | --- | --- | --- | --- |
  | `test -f docs/handoff/paimeng-platform-grill-me-2026-09-18.md && test -s docs/handoff/paimeng-platform-grill-me-2026-09-18.md` | 本任务验收步骤 | `passed` | `0` | 文件存在且非空 |
  | `git diff --check -- docs/handoff/paimeng-platform-grill-me-2026-09-18.md` | Git 空白错误检查 | `passed` | `0` | 未发现空白错误 |
  | `rg -n -i '(api[_ -]?key|secret|password|private[_ -]?key|token)\\s*[:=]' docs/handoff/paimeng-platform-grill-me-2026-09-18.md` | 本任务敏感信息检查 | `passed` | `0` | 未命中敏感信息赋值模式 |
  | 人工回读文档开头、当前 Q13 与交付记录 | 本任务验收步骤 | `passed` | `not applicable` | 已确认设计结论、下一问、建议技能和闭环协议路径正确 |
- Review evidence:

  | Required input | Record |
  | --- | --- |
  | Task goal / acceptance source | 用户要求将临时交接文件置于 `docs/handoff/` |
  | Scoped diff / baseline | 新增文件；`git status --short -- docs/handoff/paimeng-platform-grill-me-2026-09-18.md` 显示 `??` |
  | Actual validation evidence | 上述 4 项验证均通过 |
  | Review method | bounded main-Agent 文档回读与路径核查 |
- Review findings:

  | Severity | Location | Evidence / test gap | Disposition |
  | --- | --- | --- | --- |
  | `P0` | `none` | 无 | not applicable |
  | `P1` | `none` | 无 | not applicable |
  | `P2` / `P3` | `none` | 无 | not applicable |
- Review conclusion: `Clear`; 所有文档验收项通过。
- Unresolved risks / blockers: None.
- Rollback: 删除本次新增文件；不影响临时源文件或其他仓库文件。
- Maintainer decisions / waivers: 用户明确要求将交接文件放入 `docs/handoff/`。

## Design State Update

### Start Record

- Status: `active`
- Task type: `change delivery`
- Source: 用户在本次 `/grill-me` 中确认 Q13-Q19，并要求重新加载更新后的 `grilling` 与 `grill-me` 技能。
- Target: 将当前有效的 MVP 设计决策、适用范围和未解决风险补充到既有交接记录，取代其中过时的“下一问 Q13”指引。
- Input / evidence: 本会话中用户对 Q13-Q19 的明确确认；Pi SDK 官方本地文档；当前仓库的 `paimeng-ai-code-agent` 只读实现核查。
- Non-goals: 不修改产品代码、不创建运行时对象或数据库模式、不将完整会话推理写入文档、不改变既有已确认产品边界。
- Affected scope: `docs/handoff/paimeng-platform-grill-me-2026-09-18.md`
- Acceptance criteria:
  - 文档准确记录 Q13-Q19 的当前有效结论。
  - 文档不再把 Q13 表述为待回答问题。
  - 记录明确区分已确认决策、项目事实和残余风险。
  - 文档不含敏感信息。
- Planned validation:
  - `git diff --check -- docs/handoff/paimeng-platform-grill-me-2026-09-18.md` - 无空白错误。
  - `rg -n -i '(api[_ -]?key|secret|password|private[_ -]?key|token)\\s*[:=]' docs/handoff/paimeng-platform-grill-me-2026-09-18.md` - 无敏感赋值。
  - 人工回读本节 - Q13-Q19 与会话确认一致。
- Risks: 交接记录可能再次落后于后续设计决策；当前仓库尚未接入 Pi SDK 或 Sandbox，文档不能被理解为实现已存在。
- Rollback: 通过版本控制还原本次新增的“Design State Update”章节。
- Escalation decision: None.

### Current Effective Design

#### Agent Runtime, Engine, Tools

- `Agent Runtime` 仅协调一个 `Run` 的受控执行生命周期：获取/续租/释放 Run Lease 与 Application 写锁，创建和清理隔离 Workspace/Sandbox，组装 Run Context，调用 Engine Adapter，映射统一 Run Event，并向 Platform 请求状态、Snapshot 和 Validation 操作。
- Application、Profile、Requirement、Task、Run、Snapshot、Validation、Release、Deployment 及其持久状态属于 Platform Domain；Runtime 不能裁决 `validated` 或其他领域状态转换。
- `Agent Engine Adapter` 屏蔽具体 Engine。Pi SDK 当前只负责 AgentSession、消息历史、Tool Loop、上下文压缩与 Engine 事件；Task/Run 领域模型不依赖 Pi Session。
- Pi 的开发工具必须运行在当前 Run 的隔离 Sandbox 中。Sandbox 内允许正常工程自由度，包括 Bash、Git、Node、包管理器、项目脚本和调试命令；不得访问宿主机、其他 Workspace、Production、生产凭据或 Platform 管理权限。
- Snapshot、Validation、Release、Deployment 等跨越 Platform Domain 的能力只能由 Agent 请求、由 Platform 校验和执行。Agent 不提交可信的 Task/Run/Lease 身份；Runtime 从当前执行上下文绑定这些身份。
- Sandbox 是 Runtime 基础设施，不是 MVP 长期领域对象。MVP 可采用“一 Run 一个临时隔离容器”，并至少限制文件系统、凭据、网络、CPU、内存、磁盘、超时和进程数。Validation Environment 与 Agent Sandbox 可共享底层实现，但领域语义不同。

#### Run / Runtime / Engine Session Recovery

```text
Task -> Run (persistent execution contract) -> Runtime (temporary execution instance) -> Engine Session
```

- `Run` 是 Task 下的持久执行契约，不等同于一次 Runtime 或一次 Pi Session。一个 Task 可有多个 Run；一个 Run 同一时刻仅允许一个活跃 Runtime。
- Runtime 或 Engine Session 崩溃不自动使 Run 失败。只要 Run 契约仍有效、fenced Lease 可安全接管、Workspace 归属与完整性可确认、Sandbox 边界可信且跨 Platform Request 的状态可查询，新 Runtime 可接管同一 Run 并重建 Engine Session。
- 用户取消终止当前 Run，不允许后台自动恢复。Run 输入失效、Workspace 不可信、Sandbox 隔离失效、请求结果无法确定或 Run 已终态时，终止 Run；同一 Task 通过新的 Run 继续。
- 有副作用的 Platform Request 必须具备 `requestId`、幂等键和状态查询。Runtime 恢复时先查询而非盲目重放。
- MVP 不实现 Runtime Pool、Sandbox checkpoint、自动重试编排、派生 Run 或多 Runtime 容灾；Future 可把 `retryOf`、`derivedFrom`、`parentRunId` 表达为 Run 之间关系。

#### No Subagent in MVP

- MVP 不引入 Subagent 对象、委派协议、多 Agent 消息机制、Agent DAG、Result Merge Framework 或并发写入。
- 一个写入型 Task 同一时刻仅有一个拥有 Application 写权的 Run 和一个可写 Workspace。`npm test`、构建、迁移、Preview、Validation、Platform Build 与 Deployment 均不是 Subagent。
- Future 仅在出现可隔离、可审计、可归并且无共享写状态的实际需求时，优先以派生 Run 建模只读 Research/Review 等工作；不得绕过 Snapshot -> Validation -> SourceRevision 证据链。

#### Target Baseline versus Production

- `Application.currentTrustedProfileVersion` 与 `Application.currentSourceRevision` 表示已经验证并认可、供后续 Agent 使用的目标开发基线；不等同于线上实际状态。
- Production 实际运行的版本由 `Application.currentHealthyDeployment -> Release -> SourceRevision + profileVersionRef` 表达。Release 必须固定绑定 SourceRevision、ProfileVersion、构建产物、配置引用和验证证据。
- 因此“目标 Profile v2 / SourceRevision SR2 已确定，但 Production 仍运行 v1 / R1”是合法状态。
- Deployment rollback 只切换当前健康 Deployment；不自动撤销 Trusted Profile 或 SourceRevision，不自动执行数据库反向 migration。用户真正撤销业务语义时，必须经新的 Requirement -> Task -> Candidate Profile -> Validation 形成新版本。

#### Publishing Policy

- 首次创建 Application：在 Validation 通过且满足发布条件后自动创建 Release 并部署。
- 已上线 Application 的后续变更：Task 保持 `validated`；Application 通过目标基线与当前健康 Deployment 的差异表达“存在已验证但尚未上线的更新”。用户以业务语言查看摘要/预览并执行“发布更新”后，Platform 才创建 Release 和 Deployment。
- “待发布”不是 Task 新状态；发布确认不重新授权业务语义，只确认已验证版本的上线时机。
- 已上线应用的所有新版本，包括纯工程修复与 Deployment 缺陷修复后的版本，MVP 均需要一次新的用户发布确认。Platform 暂态部署故障可重试或保持上一健康版本，无需重复确认。

#### Closed Source Path and Profile Disposition

```text
Requirement -> Task -> Run -> Workspace -> CandidateSourceSnapshot -> Validation -> SourceRevision -> Release -> Deployment
```

- MVP 封闭 Application 可执行源码写入路径。稳定 SourceRevision 仅可由通过 Platform Validation 的 CandidateSourceSnapshot 晋升。
- Git 可以作为 Platform 内部的 Snapshot/Revision/Diff 实现，但不是外部协作入口。MVP 不支持用户直接编辑、外部 Git push/webhook、外部 CI 写回、管理员绕过闭环修改 SourceRevision，或 Agent 绕过 Snapshot/Validation 修改 Production。
- 每个拟晋升 Snapshot 必须声明 `profileDisposition`：
  - `changed`：必须关联 Candidate Profile Diff、Requirement 引用、简洁理由和必要验证证据；成功时产生 SourceRevision 与新的 Trusted Profile。
  - `unchanged`：必须说明为何未改变长期产品事实；允许只晋升 SourceRevision，保持现有 ProfileVersion。
  - `uncertain`：禁止 SourceRevision/Release 晋升，Run/Task 进入 `blocked`，Agent 只提出一个决定性业务问题。
- Platform 只检查上述处置及引用完整性，不裁决自然语言业务语义是否正确。封闭源码路径避免外部静默漂移；`profileDisposition` 避免系统因缺少 Diff 而静默假定 Profile 未变。
- Future 若支持 Git、CI 或紧急特权变更，必须通过 `Controlled Import -> Candidate -> Validation -> SourceRevision` 的受控入口，而不是直接写稳定版本。

### Project Facts and Implementation Gap

- Pi SDK 官方文档表明：SDK 提供单会话 AgentSession、工具调用、事件流、压缩、持久化 Session 和自定义 Tool；不提供 Application、Task、Run、Sandbox、Release、Deployment 或内建 Subagent Framework。
- 当前 `paimeng-ai-code-agent/package.json` 使用 AI SDK 与 XState，未声明 Pi SDK 依赖；现有 `workspace.ts` 和 `FileTools` 仅提供路径约束与文件操作，并非容器级 Sandbox 或当前设计的领域模型。这是实现差距，不是设计冲突。

### Current Risks and Temporary Decisions

| Item | Current decision / risk | Re-evaluation trigger |
| --- | --- | --- |
| 自然语言语义正确性 | Platform 不自动裁决 Agent 的业务理解；依赖 Requirement 原文、Trusted Profile、澄清义务、用户可见摘要和 Profile 版本化缓解。 | 实测出现重复的语义越界或用户误解。 |
| 单写入 Run | 同一 Application 同时最多一个写入型 Run。 | 单 Run 已形成可靠闭环且有明确并发需求。 |
| 单容器 Sandbox | MVP 可按一 Run 一个临时容器实现。 | 容器隔离、启动成本或多租户需求成为实测瓶颈。 |
| 统一发布确认 | 已上线应用的所有新版本均需用户确认发布。 | 有可靠、确定性的低风险发布分类证据。 |
| 封闭源码入口 | MVP 不接外部 Git/CI 作为写入路径。 | 真实用户需要导入或外部协作，且可实现受控 Import。 |

### Snapshot Storage Decision

- **当前决定：** MVP 使用每个 Application 一个 Platform 私有 Git 仓库作为 Snapshot/SourceRevision 的物理存储；仓库位于 Platform 控制的持久卷中，由 Platform Executor 独占写入。
- **冻结语义：** Workspace 或 Git worktree 是临时可变工作载体；Platform 在冻结时审计文件树并创建 Candidate commit。Candidate commit 记录完整 `commitHash`、`baseSourceRevision` 和 `treeHash/contentDigest`，通过 Validation 后直接晋升为 SourceRevision。
- **可信边界：** Agent 自己创建的 commit、branch 或 tag 不构成可信版本；外部 Git、CI、管理员 API、Workspace 和 Deployment 不得直接写入稳定 SourceRevision。读取和恢复时校验 Git 对象与内容摘要。
- **并发边界：** MVP 同一 Application 只允许一个写入型 Run。Candidate 基线过期时标记 stale，要求基于最新 SourceRevision 创建新 Run；不自动 merge、rebase 或解决冲突。
- **依据与范围：** 该决定解决 `OQ-002` / D-05，解除 T-06 的物理存储选择阻塞；不实现 Git 仓库、Worktree、Snapshot 或 Validation 持久化本身。

### Superseded Guidance

本文件前文的“尚未决定：当前 Q13”与“下一位 Agent 应等待回答 Q13”已失效。Q13-Q19 均已由用户确认；后续审查应以本节为当前有效设计状态。

### Delivery Record

- Final status: `delivered`
- Change summary: 追加 Q13-Q19 的有效 MVP 决策，覆盖 Agent Runtime/Adapter、Sandbox 工具边界、Run/Runtime 恢复、无 Subagent、目标基线与 Production 解耦、发布确认、封闭源码入口及 `profileDisposition`。
- Actual validation:

  | Command | Existing entry point | Status | Exit status | Sanitized result / blocker |
  | --- | --- | --- | --- | --- |
  | `git diff --check -- docs/handoff/paimeng-platform-grill-me-2026-09-18.md` | Git 空白错误检查 | `passed` | `0` | 未发现空白错误。 |
  | `rg -n -i '(api[_ -]?key|secret|password|private[_ -]?key|token)\\s*[:=]' docs/handoff/paimeng-platform-grill-me-2026-09-18.md` | 本任务敏感信息检查 | `passed` | `1` | 无匹配；`rg` 以 `1` 表示未发现匹配。 |
  | 人工回读“Design State Update” | 本任务验收步骤 | `passed` | `not applicable` | 已确认 Q13-Q19 与本会话用户决定一致，旧 Q13 指引已标注失效。 |
- Review evidence:

  | Required input | Record |
  | --- | --- |
  | Task goal / acceptance source | 用户要求重新加载 `grilling` / `grill-me` 后继续审查；更新后的 `grilling` 要求维护既有设计状态。 |
  | Scoped diff / baseline | 已存在但未追踪的交接文档；本次仅追加“Design State Update”章节。 |
  | Actual validation evidence | 上述 3 项结果。 |
  | Review method | bounded main-Agent 文档回读与差异检查。 |
- Review findings:

  | Severity | Location | Evidence / test gap | Disposition |
  | --- | --- | --- | --- |
  | `P0` | `none` | 无 | not applicable |
  | `P1` | `none` | 无 | not applicable |
  | `P2` / `P3` | `none` | 文档引用的是当前只读代码核查，未声称平台能力已实现。 | recorded |
- Review conclusion: `Clear`; 范围内记录、差异检查和敏感信息扫描均通过。
- Unresolved risks / blockers: 当前仓库未接入 Pi SDK、容器 Sandbox 或本设计的 Platform Domain；这些是后续实现工作，不影响设计状态更新的真实性。
- Rollback: 通过版本控制还原本次新增的“Design State Update”章节。
- Maintainer decisions / waivers: 用户明确确认 Q13-Q19；未创建 Git commit，因为用户未请求提交且该文件已有未提交基线。

## Migration Safety Decision

### Current Effective Decision

- MVP 不支持已上线 Application 的破坏性数据库迁移。Production Migration 只允许向前、向后兼容、可确定执行的 Schema Evolution。
- 允许：新建表/关联表、新增 nullable 字段、新增具有安全默认值的字段、新增索引，以及不破坏现有数据的状态或配置结构。
- 禁止：删除表/列、破坏性重命名、改变既有字段的业务含义、收紧 nullable/uniqueness 等既有约束、不可逆数据重写、无界或大批量 backfill、停机窗口、人工逐条数据判断，以及要求多个线上版本协调的 schema transition。
- 对超出范围的需求，Task/Run 必须 `blocked`；不因用户额外确认而执行。MVP 可采用新增兼容结构的 expand 原则，但不实现完整 Expand-Contract 编排、Backfill Worker、Backup/PITR、在线 Schema Change 或 Migration Orchestrator。
- Migration 仍是 Application Source 的一部分，必须随 CandidateSourceSnapshot 在隔离 DB 通过 migration、必要 seed 和关键数据库操作验证；Production Migration 只能由 Platform 在 Deployment 期间执行。
- Platform 的 MVP migration gate 只执行确定性规则检查，例如拒绝 `DROP`、`DROP TABLE`、破坏性 `ALTER` 与不安全的 constraint change；Platform 不充当 SQL/业务语义裁判。

### Rationale and Scope

- 来源：用户对 Q20 的明确决定。
- 依据：Source rollback 不等于 Database rollback，且 MVP 不提供通用反向 migration、复杂恢复或多版本协调。
- 适用范围：MVP 的所有已上线 Application；首次创建与验证环境同样必须通过隔离数据库验证，但此决定特别限制 Production 演进。
- 可逆性：临时 MVP 约束；当实际需要且具备 Migration Rehearsal、Backup/PITR、兼容性检查、Backfill 与恢复编排证据时重新评估。
- 影响：模板、Agent Execution Policy、Validation Gate 与 Platform Deployment Gate 必须拒绝超出范围的 migration；不得把这类风险留给 Agent 的自由判断。

### Evidence and Record Update

- 本决定更新了前一节“Production migration 破坏性变更额外门禁”的模糊表述：MVP 的门禁结论是直接拒绝，而非仅增加确认。
- 本次为设计状态更新；未修改产品代码或执行生产/数据库操作。
- Rollback: 通过版本控制还原本节；不影响 Application Source 或数据库。

## Application Management Access Decision

### Current Effective Decision

- 在 Platform Layer，只有 `Application Owner` 与 `System Administrator` 可以管理 Application，包括修改其管理信息、启动变更任务、发布、删除或执行其他应用管理动作；其他平台用户不能修改或删除该 Application。
- 此权限边界只管理 Platform 上的 Application 资产，不自动定义生成应用内部的最终用户、访问方式、认证、角色或数据权限。
- 因而此前“一个应用只由一个用户管理”的正确解释是：MVP 不在 Platform Domain 中引入生成应用内部的多用户身份/RBAC 模型；它不排除 Platform 层存在 Owner 与 System Administrator 两类受控管理主体，也不限制具体 Application 在自身源码中按需求实现其最终用户模型。
- Application 删除是高风险、不可逆的 Platform 管理操作，必须保留明确确认与审计记录；本轮只确认权限归属，不设计删除流程。

### Open Product Boundary

- 仍未决定生成应用是否允许 Owner/System Administrator 之外的用户访问、提交公开表单或使用业务功能。该问题必须与 Platform 管理权限分开决定。

## Lifecycle Platform Boundary Correction

### Current Effective Decision

- Platform 的管辖范围是 Application 生命周期：创建、Requirement/Task/Run、源码版本、Validation、Release、Deployment、运行状态、资源、日志、运维、Application 管理权限和删除。未部署 Application 仅供 Owner 在受控预览/验证中使用；健康 Deployment 后，Platform 提供对外可访问的运行入口，包括未注册 Platform 账号的访问者。
- 已部署 Application 的最终用户访问、认证、账户、角色、业务权限、记录可见性与数据操作规则，属于每个生成应用自身的业务行为和 Source Code；Platform 不为这些应用内规则建立统一模型、默认策略或治理系统。Platform 只负责公开运行入口的生命周期与隔离，而不裁决单次业务请求的最终用户权限。
- `Application Owner` 与 `System Administrator` 的 Platform 管理权限，不可被推导为生成应用内部的最终用户权限模型。公众可访问已部署运行面，也不代表 Platform 为其授予任何 Application 管理能力。
- 因此，不应将“匿名公开动作、私有管理数据”或任何类似应用内访问控制写成 Platform MVP 约束。Agent 生成何种应用内访问逻辑，必须以该 Application 的 Requirement、Trusted Profile、源码和当前业务范围为依据。

### Consequence

- Platform 的安全职责是隔离管理面、生产凭据、Sandbox、不同 Application 的资源与生命周期操作；它不替代应用自身的认证授权安全责任。
- 若某个 Requirement 需要应用内认证或权限，Agent 可以把它作为该 Application 的业务/源码能力实现；其安全验证属于该 Task 的 acceptance/validation 范围，而不是 Platform 领域模型。
- 来源：用户明确指出“应用内部业务权限不属于本系统管辖范围，本系统负责应用生命周期”。
- Rollback: 通过版本控制还原本节；不改变 Application Source 或运行时行为。

## Subscription Lifecycle Decision

### Current Effective Decision

- MVP 的订阅有效时，Application 可按当前健康 Deployment 对外运行。
- 支付失败或订阅到期后进入宽限期；宽限期内 Application 继续运行，并向 Application Owner 通知。
- 宽限期结束后，Platform 停止公开 Deployment，但保留 Application、Trusted Profile、SourceRevision、Release、数据库、日志和运行记录；不自动删除数据，不重新执行 Agent，不重新生成源码。
- Owner 续费后，Platform 恢复上一健康 Release。订阅状态只改变公开运行可用性，不改写 Trusted Profile、SourceRevision、历史 Release 或业务事实。
- MVP 暂不定义最终数据删除/保留期限、计费计量、套餐资源层级、退款、账单争议或复杂订阅编排；这些属于后续商业与合规能力。

### Rationale and Scope

- 来源：用户确认“宽限期 -> 停止公开运行 -> 保留全部应用事实与数据 -> 续费恢复上一健康版本”。
- 适用范围：Platform 的订阅和 Deployment 生命周期，不介入生成应用内部的业务权限或业务数据语义。
- 可逆性：当前 MVP 策略；当出现合规、成本或数据保留要求时重新评估最终删除与恢复策略。
- Rollback: 通过版本控制还原本节；不影响当前部署或订阅状态。

## Design Review Completion Record

### Delivery Record

- Final status: `delivered`
- Change summary: 在既有设计状态中补充并确认：兼容性优先的 Production Migration 边界、Platform Application 管理权与应用内部业务权限的分离、部署后的公开运行面、订阅宽限期/停服/恢复策略。
- Actual validation:

  | Command | Existing entry point | Status | Exit status | Sanitized result / blocker |
  | --- | --- | --- | --- | --- |
  | `git diff --check -- docs/handoff/paimeng-platform-grill-me-2026-09-18.md` | Git 空白错误检查 | `passed` | `0` | 未发现空白错误。 |
  | `rg -n -i '(api[_ -]?key|secret|password|private[_ -]?key|token)\\s*[:=]' docs/handoff/paimeng-platform-grill-me-2026-09-18.md` | 本任务敏感信息检查 | `passed` | `1` | 无匹配；`rg` 以 `1` 表示未发现匹配。 |
  | 人工回读当前有效决策章节 | 本任务验收步骤 | `passed` | `not applicable` | 已确认 Q13-Q20、管理权限边界、应用内部权限边界和订阅策略均有当前有效记录。 |
- Review conclusion: `Clear`; 文档检查与回读通过。
- Unresolved risks / blockers: 设计层无阻断项；业务代码与平台基础设施尚未实现，不能据此宣称可运行。
- Rollback: 通过版本控制还原本次设计记录更新；不影响产品代码、数据库或线上部署。
- Maintainer decisions / waivers: 用户明确确认 Q20、Application 管理权边界、Platform 与应用内部权限边界及订阅策略；未请求 Git commit。







