# 工程规格：面向非技术用户的应用生成与托管平台 MVP

- 文档状态：`已审查，已发布`
- 规格版本：`0.1`
- 规格来源：本次 Grill Me 已确认的产品、架构和生命周期决策，以及 `docs/specs/mvp-contract.md`。
- 发布状态：已发布为 [GitHub Issue #65](https://github.com/ZDAN-GHN/paimeng-ai-code-mother/issues/65)，标签为 `ready-for-agent`。

## 项目概述

- 项目 / 系统名称：面向非技术用户的应用生成与托管平台 MVP
- 一句话定义：Owner 用自然语言获得经验证、可公开运行、可持续修改且由平台托管的 TypeScript Web 应用。
- 项目目的：验证“自然语言需求 -> 可运行、可验证、可部署、可持续修改的应用”闭环，而不是建设通用 Agent Framework 或低代码运行时。
- 当前阶段：新建 MVP
- 核心目标：
  - 将自然语言 Requirement 归一化为受控 Task，并在必要时进行最小业务澄清。
  - 在隔离环境中使用 Pi SDK 驱动 Agent 完成代码修改与验证准备,注意项目中各类 Agent SDK,如 Pi SDK, 目前严格要求只允许使用 Agent Engine, 不使用其他额外能力。
  - 以不可变 Snapshot、Validation、SourceRevision、Release 与 Deployment 建立可信证据链。
  - 首次生成后自动公开部署；后续更新由 Owner 确认上线。
  - 按订阅状态管理公开运行、停服保留与恢复。
- 非目标：
  - 多技术栈、多服务拓扑、多部署环境、用户自带基础设施。
  - Subagent、Multi-Agent Framework、Agent DAG、并发写入、外部 Git 直接写入。
  - Platform 统一定义生成应用内部的认证、角色、RBAC、记录可见性或业务权限。
  - 破坏性 Production Migration、大规模 backfill、自动反向 migration、复杂发布治理或复杂计费治理。
- 核心能力：
  1. 持久化 Application、Requirement、Task、Run、Profile、版本和运行事实。
  2. 使用受控 Runtime 和 Engine Adapter 在 Sandbox 中执行单个 Run。
  3. 将 Workspace 冻结为 CandidateSourceSnapshot，并由 Platform 权威验证。
  4. 将验证通过的 Snapshot 晋升为 SourceRevision，必要时同步晋升 Trusted Profile。
  5. 创建 Release、执行 Deployment、健康检查、回滚和订阅运行控制。
- 关键架构摘要：

```text
Product Layer
  Owner / System Administrator
  -> Application 管理、需求、状态、预览、发布确认、订阅状态

Agent Layer
  Requirement 归一化、业务澄清、代码修改、Candidate Profile Diff、验证计划、失败修复

Platform Layer
  Application、Profile、Requirement、Task、Run、Snapshot、Validation、SourceRevision、Release、Deployment
  + 写入 Lease、Sandbox、构建、生产迁移、健康检查、日志、回滚、订阅生命周期
```

- 关键已锁定决策：`AD-001` 至 `AD-012`。
- 关键未决问题：`OQ-001` 至 `OQ-005`；均不阻塞当前工程规格审查，但在对应实现开始前必须决定。

## 需求

### R-001：Application 生命周期与平台管理

- 状态：`Confirmed`
- 来源：维护者在需求确认阶段明确 Owner/System Administrator 的 Platform 管理权；MVP Contract“Application Creation and Management”。
- 目标：让 Owner 以 Platform 为唯一受控入口创建、管理、发布和删除 Application。
- 行为：系统创建 Application 并关联 Owner；仅 Owner 与 System Administrator 可以管理、发布或删除；健康 Deployment 后提供公共运行入口。
- 前置条件：管理主体已通过 Platform 身份识别。
- 输入：创建、管理、发布或删除 Application 的 Platform 操作。
- 输出：Application 生命周期状态、管理操作结果、公开运行入口。
- 成功条件：Owner 能管理其 Application；其他平台用户不能修改或删除；公众不能因访问运行入口获得管理权限。
- 失败 / 异常条件：非授权管理操作被拒绝；未健康 Deployment 不被表述为已上线。
- 关联约束：`CST-001`、`CST-008`
- 关联决策：`AD-001`、`AD-010`
- 关联契约：`CT-001`、`CT-005`

验收标准：

- `AC-001`：Owner 创建 Application 后，可以提交需求并查看其生命周期状态。
- `AC-002`：非 Owner、非 System Administrator 的平台用户请求修改或删除同一 Application 时，系统拒绝该操作。
- `AC-003`：健康 Deployment 后，未注册 Platform 账号的访问者可以访问该 Application 的公开运行入口，但不能执行 Platform 管理操作。

### R-002：Requirement 归一化与受控 Task

- 状态：`Confirmed`
- 来源：Grill Me 关于 Requirement、Task、澄清义务和 Candidate Profile Diff 的确认。
- 目标：将 Owner 的原始自然语言意图转化为可追踪、可执行、可验收的 Application 变更单元。
- 行为：系统不可变保存 Requirement 原文；Agent 结合 Trusted Profile 和相关上下文形成一个或多个 Task。Task 在进入实施时固定 `baseProfileVersion`、`baseSourceRevision`、`requestedOutcome` 和 `acceptanceTarget`。
- 前置条件：目标 Application 存在；后续变更具有当前稳定基线。
- 输入：Owner 的自然语言需求和必要澄清回答。
- 输出：Requirement、Task、阻断问题或 Candidate Profile Diff。
- 成功条件：Task 仅在业务目标与完成结果足够明确时进入 `ready`；决定性歧义进入 `blocked`。
- 失败 / 异常条件：Agent 无法确定会改变业务结果的含义时不得自行发明业务规则。
- 关联约束：`CST-002`、`CST-003`
- 关联决策：`AD-002`、`AD-003`、`AD-004`
- 关联契约：`CT-001`、`CT-002`

验收标准：

- `AC-004`：Requirement 原文被保存且不会被 Agent 的归一化文本覆盖。
- `AC-005`：需求存在决定性业务歧义时，Task 为 `blocked`，并只包含一个待回答的关键问题。
- `AC-006`：明确需求可形成一个或多个 Task；每个进入实施的 Task 具有固定的 Profile、Source、结果和验收基线。

### R-003：单 Run 的隔离 Agent 执行

- 状态：`Confirmed`
- 来源：Grill Me 关于 Run、Runtime、Pi Session、Sandbox、Tool Boundary 和无 Subagent 的确认。
- 目标：在不暴露宿主机、Production 或其他 Workspace 的前提下执行 Agent 代码生成和调试。
- 行为：每个写入型 Task 同一时刻仅允许一个拥有 Application 写权的 Run。Runtime 为 Run 创建隔离 Sandbox/Workspace，调用 Agent Engine Adapter；Adapter 使用 Pi SDK 管理 Engine Session、工具循环和上下文。
- 前置条件：Task 为 `ready`；Runtime 已获得有效 Run Lease 和 Application 写入权。
- 输入：Run Context、固定 Source 基线、Trusted Profile、相关 Requirement、工具边界和执行策略。
- 输出：统一 Run Event、Workspace 变更、阻断问题、Platform Request 或 Run 结果。
- 成功条件：Agent 可在 Sandbox 内自由运行正常开发命令；不能越过 Sandbox 访问宿主机、其他 Workspace、Production 或生产凭据。
- 失败 / 异常条件：Runtime 或 Engine Session 崩溃不必终止 Run；只有执行契约不能安全继续时才终止 Run。
- 关联约束：`CST-004`、`CST-005`、`CST-006`
- 关联决策：`AD-005`、`AD-006`、`AD-007`
- 关联契约：`CT-002`、`CT-003`

验收标准：

- `AC-007`：同一 Application 已有活跃写入 Run 时，第二个写入型 Run 无法获得写入权。
- `AC-008`：Agent 的文件和命令操作发生在当前 Run Sandbox/Workspace 内，且无法读取生产凭据或其他 Workspace。
- `AC-009`：Runtime 重启后，在 Lease、Workspace、Sandbox 和外部请求状态可确认时，可以接管同一 Run 并重建 Engine Session。
- `AC-010`：Owner 取消 Run 后，Runtime 停止执行、释放 Lease，且不会在后台自动恢复该 Run。

### R-004：不可变源码、Profile 与版本晋升

- 状态：`Confirmed`
- 来源：Grill Me 关于 Application Profile、Snapshot、SourceRevision、封闭源码入口和 `profileDisposition` 的确认。
- 目标：使每次验证、版本晋升、后续修改和回滚均可定位到明确的源码与产品事实。
- 行为：Workspace 只能通过冻结形成 CandidateSourceSnapshot；Validation 必须绑定 Snapshot。验证通过后，Snapshot 晋升为 SourceRevision。拟晋升 Snapshot 必须声明 `profileDisposition`：`changed`、`unchanged` 或 `uncertain`。
- 前置条件：Run 仍有效；Workspace 可安全冻结。
- 输入：Workspace 内容、Task 基线、Candidate Profile Diff（如适用）、Requirement 引用和处置理由。
- 输出：CandidateSourceSnapshot、SourceRevision、Trusted Profile Version 或阻断状态。
- 成功条件：所有稳定 SourceRevision 均能追溯到 Snapshot、Task、Run 和 Validation；Profile 变化能追溯到 Requirement 和理由。
- 失败 / 异常条件：`uncertain` 处置、缺少候选 Diff 或缺少引用时不得晋升；外部 Git、外部 CI 或管理员脚本不得直接写稳定 SourceRevision。
- 关联约束：`CST-002`、`CST-007`
- 关联决策：`AD-001`、`AD-003`、`AD-008`
- 关联契约：`CT-003`、`CT-004`

验收标准：

- `AC-011`：可写 Workspace 不得直接作为 Validation 或 Release 输入；Validation 引用一个不可变 CandidateSourceSnapshot。
- `AC-012`：验证失败的 Snapshot 不得形成 SourceRevision。
- `AC-013`：`profileDisposition = changed` 时，系统要求 Candidate Profile Diff、Requirement 引用和简洁理由；`uncertain` 时阻止晋升。
- `AC-014`：纯工程变更可声明 `unchanged` 并晋升 SourceRevision，同时保持原 Trusted Profile Version。

### R-005：平台权威验证与兼容 Migration

- 状态：`Confirmed`
- 来源：Grill Me 关于 Validation、完成定义、Database Gate 和 Migration Safety 的确认。
- 目标：使 `validated` 表示 Platform 已在确定源码对象上证明本次变更满足完成条件。
- 行为：Platform 对 CandidateSourceSnapshot 执行模板定义的 Engineering Gate、隔离数据库 Migration Gate、Runtime Gate 和 Task Acceptance。Agent 可以提出和触发验证，但不能自行宣布完成。
- 前置条件：存在冻结 Snapshot 和当前 Task 的 `acceptanceTarget`。
- 输入：Snapshot、模板验证定义、Task 验收目标和隔离验证环境。
- 输出：结构化 Validation、Evidence 引用和 Task 状态裁决。
- 成功条件：只有全部必要验证通过，Task 才成为 `validated`，Snapshot 才能晋升为 SourceRevision。
- 失败 / 异常条件：不可自动验证且未明确处理的业务结果不得默认通过；Production Migration 只允许兼容、确定性的演进。
- 关联约束：`CST-007`、`CST-009`
- 关联决策：`AD-009`
- 关联契约：`CT-003`

验收标准：

- `AC-015`：Engineering、Database、Runtime 和 Task Acceptance 的结果均绑定同一 CandidateSourceSnapshot。
- `AC-016`：任一必需验证失败时，Task 不得成为 `validated`，且不得创建可发布 Release。
- `AC-017`：隔离数据库中可以应用允许的 Migration 并完成 Task 涉及的关键数据库操作。
- `AC-018`：删除表/列、破坏性重命名、收紧既有约束、无界 backfill 或不可逆数据重写被 Migration Gate 拒绝。

### R-006：Release、Deployment 与发布确认

- 状态：`Confirmed`
- 来源：Grill Me 关于 Release/Deployment 分离、首次自动发布、后续确认发布和目标/Production 解耦的确认。
- 目标：将已验证的目标版本安全地变成 Production 公开服务，同时允许 Owner 控制后续更新上线时机。
- 行为：首次 Application 的 validated 版本自动创建 Release 并部署。已上线 Application 的后续 validated 版本形成新的目标基线，待 Owner 以业务语言确认“发布更新”后创建 Release 和 Deployment。
- 前置条件：存在已验证 SourceRevision；后续发布还要求存在健康 Deployment 和 Owner 确认。
- 输入：SourceRevision、Profile Version、构建产物、配置引用、Validation/Evidence 引用和发布确认。
- 输出：Release、Deployment、部署后健康状态、回滚状态和公开运行入口。
- 成功条件：Release 与 Deployment 可独立追溯；健康 Deployment 精确指向运行中的 Release；后续更新未确认前不改变 Production。
- 失败 / 异常条件：平台暂态故障可以重试或保持上一健康版本；应用缺陷形成新的 Run 和新版本，不能自动连续推送。
- 关联约束：`CST-008`、`CST-010`
- 关联决策：`AD-010`、`AD-011`
- 关联契约：`CT-004`、`CT-005`

验收标准：

- `AC-019`：首次版本验证通过后，Platform 自动创建 Release、完成健康部署并提供公开 URL。
- `AC-020`：已上线 Application 的新 validated 版本在 Owner 确认发布前，不改变当前健康 Deployment。
- `AC-021`：Owner 确认发布后，Platform 部署固定的 Release；部署后健康检查通过时才表述为已上线。
- `AC-022`：Deployment 失败或回滚只改变健康 Deployment，不撤销 Trusted Profile、SourceRevision 或自动反向迁移数据库。

### R-007：订阅驱动的运行生命周期

- 状态：`Confirmed`
- 来源：维护者确认“宽限期 -> 停止公开运行 -> 保留全部应用事实与数据 -> 续费恢复上一健康版本”。
- 目标：以周期订阅提供公开运行和基础运维服务，并在停服时保留可恢复的应用事实。
- 行为：有效订阅下健康 Deployment 持续公开运行。支付失败或订阅到期后进入宽限期；结束后停止公开 Deployment，但保留 Application、Profile、源码版本、Release、数据库、日志和记录。续费后恢复上一健康 Release。
- 前置条件：Application 已创建；恢复时存在上一健康 Release。
- 输入：订阅状态、支付/到期事件、续费事件。
- 输出：公开运行、宽限、停服或恢复状态。
- 成功条件：停服只改变公开运行可用性；应用事实和数据不因订阅状态被改写或删除。
- 失败 / 异常条件：最终数据删除、退款、账单争议和复杂保留期限不在 MVP 定义。
- 关联约束：`CST-011`
- 关联决策：`AD-012`
- 关联契约：`CT-005`

验收标准：

- `AC-023`：有效订阅且健康部署存在时，Application 公开运行。
- `AC-024`：订阅到期且宽限期结束后，Platform 停止公开运行，但保留 Application、版本和数据库。
- `AC-025`：Owner 续费后，Platform 恢复上一健康 Release，且不重新生成应用源码。

## 功能行为

### 首次应用生成与公开上线

```text
Owner 创建 Application
  -> 提交 Requirement
  -> Task ready 或 blocked
  -> Run 在隔离 Sandbox 执行
  -> CandidateSourceSnapshot
  -> Platform Validation
  -> SourceRevision / Trusted Profile
  -> Release
  -> Deployment 健康
  -> 公开 URL
```

- 触发条件：Owner 创建 Application 并提交业务需求。
- 正常路径：需求明确后形成 Task；Agent 在 Sandbox 中修改固定模板；Platform 冻结并验证 Snapshot；首次 validated 版本自动部署；健康后公开提供服务。
- 状态变化：`created -> ready -> executing -> validated -> released`；验证或澄清问题可转为 `failed` 或 `blocked`。
- 异常路径：决定性业务歧义阻断并提问；验证失败不晋升；首次部署失败保持未上线。
- 边界条件：不可兼容 Migration 不进入 Production；非管理主体不能操作 Application。
- 参与方及其行为关系：Owner 提交需求和管理发布；Agent 提出和执行变更；Platform 负责状态、验证、发布、Production 操作；公众只使用健康 Deployment 的运行入口。
- 关联需求：`R-001`、`R-002`、`R-003`、`R-004`、`R-005`、`R-006`

### D-06：Task 与 Run 状态转换矩阵

- 状态：`Locked Decision`；维护者已批准，实施不得自行扩展状态或改变边的语义。
- 权威性：Platform Domain 是 Task/Run 状态的唯一裁决方。Runtime 只能申请或报告 Lease、Sandbox 和规范化 Run Event；Agent 只能提出阻断或 Platform Request，不能自行完成状态转换。

#### Task 状态与允许转换

| 来源 | 目标 | 触发者 / 前置条件 | 不可达或拒绝条件 |
| --- | --- | --- | --- |
| `created` | `ready` | Platform 接受无决定性歧义的归一化结果并冻结 `TaskExecutionBaseline` | 基线缺失、字段未知或存在阻断问题 |
| `created` | `blocked` | Platform 持久化 Agent 提出的唯一决定性业务问题 | 多个问题、Agent 自行补全业务规则 |
| `blocked`（尚未冻结基线） | `created` | Owner 提交答复；Platform 保留不可变答复记录并重新归一化 | 未授权主体、未答复当前唯一问题 |
| `blocked`（已有冻结基线） | 原 Task 保持 `blocked`；新 Task 为 `created` | Owner 答复执行中发现的业务歧义；Platform 保留原 Task/基线，并为重新归一化结果创建新 Task | 试图修改原 Task 的 `TaskExecutionBaseline`、由 Agent 直接恢复执行 |
| `ready` | `executing` | Platform 创建 Run 并授予 fenced Lease；Runtime 已获得受控执行上下文 | 另一个写入型 Run 持有 Application Lease、基线或能力不兼容 |
| `executing` | `blocked` | Platform 接受 Agent 的阻断请求，Run 已停止且不再持有 Lease | Agent 文本直接改写 Task、存在可继续执行的未解决副作用 |
| `executing` | `failed` | Platform 记录不可恢复的 Run、Validation 或安全失败；不得晋升 | Agent 自述失败但证据或 Run 终态未确认 |
| `failed` | `ready` | Owner 显式请求重试；Platform 创建新 Run，Requirement 与冻结基线不变 | 改变业务目标、基线或验收目标时，必须创建新 Requirement/Task |
| `executing` | `validated` | 同一 CandidateSourceSnapshot 的全部必需 Validation/Evidence 通过 | Agent 自检、可写 Workspace、失败或缺失的验证 |
| `validated` | `released` | Platform 创建固定 Release；首次版本自动触发，后续版本要求 Owner/System Administrator 确认发布 | Release 输入未固定，或后续版本缺少确认 |
| `created`、`ready`、`blocked`、`executing` | `cancelled` | Owner 请求取消；`executing` 需先让 Runtime 停止、清理 Sandbox 并确认 Run 终态 | 非 Owner/System Administrator；`validated` 或 `released` 的稳定事实不得通过取消撤销 |

`released` 表示固定 Release 已创建；Deployment 是否健康、是否公开运行和回滚均由独立 Deployment 状态表达，不得等同于 Task `released`。

#### Run、Lease 与恢复

| 来源 | 目标 | 触发者 / 前置条件 |
| --- | --- | --- |
| `created` | `failed` | Platform 拒绝 Lease 请求或拒绝不兼容的执行能力；未获得 Sandbox 写入权 |
| `created` | `leased` | Platform 授予 fenced Lease；同一 Application 没有其他活跃写入 Lease |
| `leased` | `executing` | Runtime 已建立可信 Sandbox、Workspace 和完整 Run Context |
| `executing` | `succeeded` | Runtime 已停止写入并提交受控 Snapshot/Validation 请求；这本身不裁决 Task `validated` |
| `leased`、`executing` | `failed` | Platform 确认 Runtime、Sandbox、安全或不可恢复的执行失败 |
| `leased`、`executing` | `cancelled` | Owner 取消已被 Platform 接受，Runtime 已停止 |

- Run 终态、Sandbox 清理、Lease 释放及相应 Task 迁移由 Platform 以可恢复的顺序协调；取消后不得自动恢复。
- Runtime 崩溃时，只有 Lease fencing、Workspace 归属与完整性、Sandbox 边界和外部副作用状态都可确认，新的 Runtime 才能接管同一活跃 Run；否则 Run 进入 `failed`。
- 所有未列转换、错误触发者、缺失前置条件和过期 Lease 均被拒绝，并留下可审计原因。

### 后续修改、发布与恢复

```text
Owner 提交更新
  -> 新 Task / Run
  -> 新 Snapshot 通过验证
  -> 新目标 SourceRevision / Profile
  -> Owner 确认发布
  -> 新 Release / Deployment
  -> 健康或回滚
```

- 触发条件：Owner 为已上线 Application 提交新 Requirement。
- 正常路径：更新版本经验证后保留为目标基线；Owner 查看业务摘要或预览后确认发布；Platform 部署固定 Release。
- 状态变化：Task `validated` 不等同于线上更新；健康 Deployment 指向实际 Production Release。
- 异常路径：部署暂态故障由 Platform 重试或保持上一健康版本；应用缺陷通过新的 Run 形成新版本。
- 边界条件：回滚不回退 Trusted Profile、SourceRevision 或数据库。
- 参与方及其行为关系：Owner 决定后续版本上线时机；Platform 独占 Deployment 与回滚；Agent 仅在应用缺陷需要修复时处理受控诊断。
- 关联需求：`R-003`、`R-004`、`R-005`、`R-006`、`R-007`

## 系统架构

### 系统上下文

```text
Owner / System Administrator
  -> Product Layer
  -> Platform Domain
  -> Agent Runtime
  -> Agent Engine Adapter
  -> Pi SDK
  -> Sandbox / Workspace
  -> Platform Validation
  -> Release / Deployment
  -> Public Runtime Users
```

Platform 管理 Application 生命周期和生产运行环境。生成应用自身的最终用户认证、角色、业务权限和数据权限由该 Application 的 Requirement、Profile 与 Source Code 决定，不是 Platform 的统一领域模型。

### 架构总览

```text
Requirement + Trusted Profile + Task Baseline
  -> Run Context
  -> Agent Runtime
  -> Agent Engine Adapter / Pi SDK
  -> Sandbox Workspace
  -> CandidateSourceSnapshot
  -> Platform Validation
  -> SourceRevision + Trusted Profile
  -> Release
  -> Deployment / Health Check
```

控制权由 Platform Domain 持有。Runtime 只能申请状态或平台操作，不能裁决 Task 已完成、发布成功或业务语义正确。

### 核心组件

#### Platform Domain

- 职责：持久化 Application、Profile、Requirement、Task、Run、Snapshot、Validation、SourceRevision、Release、Deployment 和订阅事实。
- 负责：权威状态转换、写入 Lease、引用完整性、发布门禁和公开运行生命周期。
- 不负责：Pi Session、Tool Loop、应用内部业务权限的统一判断。
- 依赖：持久化存储、Runtime、Validation、Deployment 执行能力。
- 输入：Owner 操作、Runtime 请求、验证和部署结果、订阅事件。
- 输出：权威领域状态和可查询结果。
- 关联需求：`R-001` 至 `R-007`
- 关联边界：`AD-001`、`AD-005`、`CST-001`

#### Agent Runtime

- 职责：执行单个 Run 的临时协调生命周期。
- 负责：获取/续租/释放 Lease，物化 Workspace，启动 Sandbox，组装 Run Context，调用 Adapter，转发统一 Run Event，管理超时、取消和清理。
- 不负责：Application/Task/Release 的权威状态、业务语义裁决或 Production 部署。
- 依赖：Platform Domain、Sandbox、Agent Engine Adapter。
- 输入：Run、Task 基线、当前执行策略。
- 输出：Run Event、Workspace 结果和受控 Platform Request。
- 关联需求：`R-003`、`R-004`
- 关联边界：`AD-005`、`AD-006`、`CST-004`

#### Agent Engine Adapter

- 职责：将 Run Context 映射到当前 Agent Engine，并将 Engine 事件转换为统一 Run Event。
- 负责：Pi Session、上下文、Tool Loop 和 Engine 特有事件适配。
- 不负责：Task 领域建模、状态裁决、生产权限或 Deployment。
- 依赖：Pi SDK、Runtime 提供的 Sandbox Tool Contract。
- 输入：Run Context 和受控工具。
- 输出：统一 Run Event、工具请求和 Agent 文本结果。
- 关联需求：`R-003`
- 关联边界：`AD-006`、`CT-002`

#### Validation Service

- 职责：对指定 CandidateSourceSnapshot 执行模板化工程、数据库、运行和任务验收验证。
- 负责：结构化 Validation/Evidence、结果绑定和结果报告。
- 不负责：授予业务语义授权、执行 Production Migration 或依据 Agent 自述判定完成。
- 依赖：隔离验证环境、模板验证定义、平台状态转换。
- 输入：Snapshot、Task acceptanceTarget、验证策略。
- 输出：Validation 结果、Evidence 引用和状态裁决请求。
- 关联需求：`R-004`、`R-005`
- 关联边界：`AD-009`、`CT-003`

#### Release and Deployment Controller

- 职责：将固定 Release 安全部署到 Production，并维护健康运行、回滚和订阅停服/恢复。
- 负责：生产构建、配置与密钥注入、兼容 Migration、流量切换、部署后健康检查、回滚和公开运行状态。
- 不负责：生成代码、读取生产密钥给 Agent、改变 Trusted Profile 或通用数据库反向迁移。
- 依赖：SourceRevision、Release、Production 执行后端、订阅状态。
- 输入：发布确认、Release、订阅事件。
- 输出：Deployment 状态、健康状态、受控诊断和公开运行入口。
- 关联需求：`R-006`、`R-007`
- 关联边界：`AD-010`、`AD-011`、`AD-012`

## 架构决策

### AD-001：Application 是平台长期实体，而非代码仓库

- 状态：`Locked Decision`，维护者已明确决定，后续 Agent 不得擅自改变。
- 来源：Grill Me 关于 Application 定义的确认。
- 背景：代码仓库不能保存长期产品含义、发布事实和运行生命周期。
- 决定：Application 聚合产品事实、Agent 长期上下文、Source/Version、Release 和 Runtime 事实；Source Code 是唯一可执行事实。
- 原因：支持后续修改、审计、回滚和运行追溯，而不引入运行时 DSL。
- 影响：Profile、SourceRevision、Release 和 Deployment 必须与 Application 关联。
- 后果：Application 不能被简化为单个 Git 仓库或 Pi Session。
- 关联需求：`R-001`、`R-004`、`R-006`
- 关联约束：`CST-001`、`CST-002`
- 关联未决问题：无

### AD-002：Profile 是可信产品基线，不是 DSL

- 状态：`Locked Decision`
- 来源：Grill Me 关于 Trusted Profile 的确认。
- 背景：后续 Agent 需要稳定业务语义，代码无法可靠表达全部用户意图；但平台不应构建第二运行时。
- 决定：Profile 采用小而封闭、版本化 JSON，保存长期目的、业务角色、核心实体、关键流程、长期验收与约束；不参与应用运行。
- 原因：为后续修改提供长期产品事实，同时避免 DSL 与代码双向同步。
- 影响：Profile 变化通过 Candidate Profile Diff 和 `profileDisposition` 显式处理。
- 后果：Platform 不自动裁决自然语言业务语义正确性。
- 关联需求：`R-002`、`R-004`
- 关联约束：`CST-002`、`CST-003`
- 关联未决问题：无

### AD-003：Requirement、Task、Run、Runtime 与 Engine Session 分层

- 状态：`Locked Decision`
- 来源：Grill Me 关于 Conversation、Requirement、Task 和 Run 的确认。
- 背景：对话、执行实例和模型会话都可能失败或替换，不能承载 Application 变更真相。
- 决定：Conversation 是交互容器；Requirement 是不可变意图；Task 是交付单元；Run 是持久执行契约；Runtime 是临时执行实例；Pi Session 是 Engine 内部状态。
- 原因：支持澄清、重试、恢复和未来 Engine 替换。
- 影响：Task 不依赖 Pi Session；Runtime 崩溃不必创建新 Run。
- 后果：需要 Lease、幂等请求和可查询外部副作用状态。
- 关联需求：`R-002`、`R-003`
- 关联约束：`CST-004`、`CST-006`
- 关联未决问题：无

### AD-004：不引入独立授权对象或语义裁判

- 状态：`Locked Decision`
- 来源：Grill Me 关于取消 `authorizedScope` / `authorizedChange` 的确认。
- 背景：Platform 不应被要求自动证明自然语言理解没有越界。
- 决定：Requirement 原文、Trusted Profile、Agent 澄清义务、Candidate Profile Diff 的引用和简洁理由共同形成可追溯依据；Platform 只检查确定性完整性。
- 原因：保持 MVP 简单并避免虚假的语义证明。
- 影响：业务语义冲突或不确定时 Agent 必须阻断并向 Owner 澄清。
- 后果：残余语义风险通过摘要、预览、验证和持续修改缓解。
- 关联需求：`R-002`、`R-004`
- 关联约束：`CST-003`
- 关联未决问题：无

### AD-005：Runtime 是单 Run 协调器，Platform 保有领域真相

- 状态：`Locked Decision`
- 来源：Grill Me Q13。
- 背景：将领域状态放入 Runtime 或 Pi 会使恢复、替换和审计不可靠。
- 决定：Runtime 仅协调 Sandbox、Workspace、Lease、Run Context、Adapter、事件和资源生命周期；Platform Domain 裁决状态转换。
- 原因：避免形成第二个 Agent Framework 或让 Pi 承担产品领域职责。
- 影响：Runtime 只能请求 Snapshot、Validation 和状态操作。
- 后果：Runtime Event 不自动成为领域 Event Store。
- 关联需求：`R-003`、`R-005`
- 关联约束：`CST-001`、`CST-004`
- 关联未决问题：无

### AD-006：Pi SDK 通过 Agent Engine Adapter 接入

- 状态：`Locked Decision`
- 来源：维护者已确定 Pi SDK 为当前 Agent Engine；Grill Me Q13/Q14。
- 背景：Task/Run 需要独立于具体 Engine，Pi 的 Session 和 Tool Loop 不应泄漏到领域模型。
- 决定：Adapter 将 Run Context 和 Sandbox Tool Contract 映射到 Pi SDK，并将 Pi 事件归一化为 Run Event。
- 原因：隔离 Engine 特有行为并保留未来替换空间。
- 影响：Pi Session 通常服务于一个 Run，但不是 Run 的领域身份。
- 后果：Adapter 必须不授予宿主机或 Production 权限。
- 关联需求：`R-003`
- 关联约束：`CST-004`、`CST-005`
- 关联未决问题：无

### AD-007：MVP 不实现 Subagent 或 Multi-Agent Framework

- 状态：`Locked Decision`
- 来源：Grill Me Q15。
- 背景：MVP 最大风险是单 Agent 端到端闭环不可靠，而非并行效率。
- 决定：一个写入型 Task 同时只有一个可写 Run 与 Workspace；不创建 Subagent、委派协议、Agent DAG 或 Result Merge Framework。
- 原因：避免并发冲突、基线竞争和额外生命周期复杂度。
- 影响：测试、构建、Validation 和 Deployment 均是平台或 Sandbox 作业，不是 Subagent。
- 后果：未来只在可隔离、可审计、无共享写状态的实际需求下，以派生 Run 表达 Research/Review。
- 关联需求：`R-003`
- 关联约束：`CST-004`
- 关联未决问题：无

### AD-008：封闭源码入口并显式处置 Profile

- 状态：`Locked Decision`
- 来源：Grill Me Q19。
- 背景：外部写入会破坏 Source/Profile/Validation 的证据链；缺少 Profile Diff 不能默认等于无语义变化。
- 决定：稳定源码只能经 `Task -> Run -> Workspace -> CandidateSourceSnapshot -> Validation -> SourceRevision` 晋升；每个拟晋升 Snapshot 必须声明 `changed`、`unchanged` 或 `uncertain`。
- 原因：防止外部静默漂移和内部静默 Profile 分叉。
- 影响：外部 Git、CI 和管理员脚本不能直接写稳定 SourceRevision。
- 后果：Future 外部源码能力必须走 Controlled Import。
- 关联需求：`R-004`
- 关联约束：`CST-002`
- 关联未决问题：无

### AD-009：Platform 权威验证决定开发完成

- 状态：`Locked Decision`
- 来源：Grill Me Q9。
- 背景：Agent 自述或可写 Workspace 无法证明将发布内容已经完成。
- 决定：Validation 绑定 CandidateSourceSnapshot，并对工程、数据库、运行与 Task Acceptance 进行必要验证；Platform 根据结果裁决 `validated`。
- 原因：建立可重复、可追溯的完成标准。
- 影响：不能可靠自动验证的业务结果必须在发布前明确处理，不得由 Agent 默认成功。
- 后果：模板需要提供适用的验证命令和验证环境。
- 关联需求：`R-005`
- 关联约束：`CST-007`、`CST-009`
- 关联未决问题：无

### AD-010：Release 与 Deployment 分离，目标基线可领先 Production

- 状态：`Locked Decision`
- 来源：Grill Me Q10、Q16、Q18。
- 背景：已验证、可发布和已上线是不同事实；部署失败不能抹去已经认可的开发基线。
- 决定：Trusted Profile 与 SourceRevision 表示目标开发基线；Production 实际状态由当前健康 Deployment 所引 Release/Profile 表达。
- 原因：支持失败修复、回滚和后续开发，不重新猜测已确定需求。
- 影响：目标 v2/SR2 与线上 v1/R1 并存是合法状态。
- 后果：Deployment rollback 不撤销 Profile/SourceRevision 或反向迁移数据库。
- 关联需求：`R-004`、`R-006`
- 关联约束：`CST-008`、`CST-010`
- 关联未决问题：无

### AD-011：首次自动发布，后续更新需 Owner 确认

- 状态：`Locked Decision`
- 来源：Grill Me Q18。
- 背景：首次创建需要验证完整闭环；已在用应用的更新不应因 Agent 自动完成而直接改变 Production。
- 决定：首次 validated 版本自动 Release/Deployment；后续版本以目标基线与健康 Deployment 的差异表达待发布，由 Owner 确认发布。
- 原因：降低首次价值摩擦并保留后续变更控制权。
- 影响：待发布不是新的 Task 状态。
- 后果：已上线应用的应用缺陷修复版本也必须再次确认发布。
- 关联需求：`R-006`
- 关联约束：`CST-008`
- 关联未决问题：无

### AD-012：兼容 Migration 与订阅停服保留

- 状态：`Locked Decision`
- 来源：维护者确认 Migration Safety 与订阅生命周期。
- 背景：MVP 不提供通用数据库回滚、复杂恢复或数据保留治理。
- 决定：Production 只允许向前/向后兼容且确定性的 Schema Evolution；订阅停服只停止公开 Deployment，保留应用事实与数据，续费恢复上一健康 Release。
- 原因：降低不可逆数据风险，并实现周期付费托管的最小生命周期。
- 影响：删除列、破坏性重命名、无界 backfill 等 Task 必须被阻断。
- 后果：最终删除和复杂计费治理延期。
- 关联需求：`R-005`、`R-007`
- 关联约束：`CST-009`、`CST-011`
- 关联未决问题：`OQ-005`

### AD-013：TS Agent 负责 Agent 交互与用量计量

- 状态：`Locked Decision`，维护者已明确决定。
- 决定：Pi SDK、模型与工具调用、调用前后 Hook、Token/调用次数采集、用量聚合和未来价格计算均在 TS Agent 内实现。每次调用产生幂等 Usage Evidence，至少关联 `runId`、`invocationId`、`requestId`、模型标识、开始/结束时间、结果及引擎可用 usage 字段。
- 当前 MVP：Usage Evidence 只用于调试、诊断和未来计量；不冻结、扣减、退款、展示积分余额，不因余额阻断生成，也不包含货币、价格或余额裁决。
- Java 边界：Java Platform 仍权威保存 Application/Task/Run/Validation/Release/Deployment 状态；未来独立账务可消费经受控边界提交的 Evidence，但新链路不得调用旧 `CreditService`、`/credit` 或旧 `credit/freeze`。
- 迁移：旧积分实现与历史台账在新 Platform MVP 中隔离，不能作为新链路依赖；物理删除或数据迁移必须通过独立退役任务和数据影响评估。
- 关联需求：`R-003`、`CT-002`、`CST-001`、`CST-006`。

## 系统边界

### Product Layer Boundary

- 负责：Owner 的 Application 管理、需求输入、进度状态、发布确认、订阅状态和公开 URL 展示。
- 不负责：代码、Git、容器、密钥、迁移命令或集群概念的暴露。
- 允许：Owner 以业务语言提交需求、回答澄清、确认更新发布。
- 禁止：普通平台用户管理他人 Application；公众访问运行入口后执行 Platform 管理操作。
- 权威方：Platform Domain。
- 关联需求 / 决策 / 约束：`R-001`、`R-002`、`R-006`、`R-007`；`AD-001`、`AD-011`；`CST-008`

### Agent Boundary

- 负责：需求理解、决定性业务澄清、代码修改、Candidate Profile Diff、验证计划、失败诊断和修复。
- 不负责：业务语义最终裁决、Task 完成裁决、Release/Deployment 执行或 Production 管理。
- 允许：在 Sandbox 内自由使用正常开发工具；提出 Platform Request。
- 禁止：将推断伪装为 Requirement、直接写 Trusted Profile、访问生产密钥/数据库、直接切流或宣布上线成功。
- 权威方：Platform 对领域状态和生产操作拥有最终权威。
- 关联需求 / 决策 / 约束：`R-002`、`R-003`、`R-004`、`R-005`；`AD-004`、`AD-006`、`AD-009`；`CST-003`、`CST-005`

### Runtime and Tool Boundary

- 负责：单个 Run 的 Lease、Sandbox、Workspace、Run Context、Adapter 调用、事件转换和资源生命周期。
- 不负责：持久 Application 业务真相、通用工作流引擎或 Multi-Agent 调度。
- 允许：绑定当前 Run 身份执行 Sandbox 工具；在当前上下文中发起可校验 Platform Request。
- 禁止：向 Pi 暴露宿主机 Shell、其他 Workspace、Production 网络、生产凭据或 Platform 管理员能力。
- 权威方：Runtime 协调执行；Platform 持有 Lease 和领域状态。
- 关联需求 / 决策 / 约束：`R-003`；`AD-003`、`AD-005`、`AD-006`、`AD-007`；`CST-004`、`CST-005`、`CST-006`

### Validation Boundary

- 负责：在固定 Snapshot 上执行工程、数据库、运行和任务验收验证，输出结构化结果和 Evidence。
- 不负责：接受 Agent 自我报告作为完成结论，或判断业务语义是否合理。
- 允许：使用隔离验证环境和数据库执行模板定义的验证。
- 禁止：访问 Production Database 或将不可自动验证目标默认为通过。
- 权威方：Platform Validation。
- 关联需求 / 决策 / 约束：`R-005`；`AD-009`；`CST-007`、`CST-009`

### Production Boundary

- 负责：固定 Release 的生产构建、配置/密钥注入、兼容 Migration、流量、健康检查、日志、回滚和订阅运行控制。
- 不负责：生成代码、解释自然语言 Requirement 或定义应用内部业务权限。
- 允许：Platform 在确认发布后部署 validated Release；对暂态故障重试或保持上一健康版本。
- 禁止：Agent 直接操作实例、读取生产密钥、直接连接生产数据库、执行生产迁移或切换流量；自动反向迁移数据库。
- 权威方：Platform Deployment Controller。
- 关联需求 / 决策 / 约束：`R-006`、`R-007`；`AD-010`、`AD-011`、`AD-012`；`CST-008`、`CST-009`、`CST-010`、`CST-011`

## 接口与契约

### CT-001：Application 管理与 Requirement 输入契约

- 状态：`Confirmed`
- 来源：维护者关于 Owner/System Administrator 管理权和 Requirement 不可变性的确认。
- 调用方：Product Layer。
- 被调用方：Platform Domain。
- 职责：创建/管理 Application；保存 Requirement 原文；创建或阻断 Task。
- 输入：已识别的管理主体、Application 标识、自然语言 Requirement、必要澄清回答。
- 输出：Application 状态、Requirement 标识、Task 标识或 `blockingReason`。
- 约束：仅 Owner/System Administrator 管理；Requirement 原文不可由 Agent 改写；阻断时仅一个决定性问题。
- 错误条件：无管理权、Application 不存在或 Requirement 无法形成明确 Task。
- 关联需求：`R-001`、`R-002`
- 关联决策：`AD-001`、`AD-003`、`AD-004`

### CT-002：Run Context 与 Agent Engine Adapter 契约

- 状态：`Confirmed`
- 来源：Grill Me 关于 Runtime、Adapter、Pi Session 和 Tool Boundary 的确认。
- 调用方：Agent Runtime。
- 被调用方：Agent Engine Adapter。
- 职责：将 Task 固定基线和受控能力传递给当前 Agent Engine，并归一化 Engine Event。
- 输入：Task 基线、Trusted Profile、相关 Requirement/澄清、Workspace、必要失败摘要、Candidate Profile Diff、Tool Contract、Execution Policy。
- 输出：统一 Run Event、Sandbox Tool 调用、阻断问题、Platform Request。
- 约束：不注入完整历史 Session、生产日志或生产密钥；Agent 身份由 Runtime 上下文绑定，不由 Agent 参数自报。
- 错误条件：Run Lease 无效、Sandbox 不可信、Engine Session 失败或工具请求越界。
- 关联需求：`R-003`
- 关联决策：`AD-005`、`AD-006`、`AD-007`

### CT-003：Snapshot 与 Validation 契约

- 状态：`Confirmed`
- 来源：Grill Me 关于 CandidateSourceSnapshot、Validation 和 `validated` 的确认。
- 调用方：Agent Runtime / Platform Domain。
- 被调用方：Validation Service。
- 职责：冻结 Workspace、创建不可变 Snapshot，并对指定 Snapshot 执行必要验证。
- 输入：Run、Workspace、Task acceptanceTarget、模板验证定义、隔离验证环境。
- 输出：CandidateSourceSnapshot、结构化 Validation、Evidence 引用、通过/失败结果。
- 约束：每个 Validation 精确引用一个 Snapshot；Agent 不能凭自我判断标记 Task `validated`；外部副作用请求必须可查询且幂等。
- 错误条件：Workspace 不可冻结、Snapshot 不可恢复、验证环境不可用、必需验证失败、迁移不兼容。
- 关联需求：`R-004`、`R-005`
- 关联决策：`AD-008`、`AD-009`

### CT-004：版本晋升与 Release 创建契约

- 状态：`Confirmed`
- 来源：Grill Me 关于 Profile 处置、SourceRevision、Release 和目标/Production 解耦的确认。
- 调用方：Platform Domain。
- 被调用方：Version / Release Service。
- 职责：在验证通过后晋升 Snapshot、处置 Profile，并创建固定 Release。
- 输入：通过 Validation 的 Snapshot、`profileDisposition`、Candidate Profile Diff（如适用）、Requirement 引用、SourceRevision、Profile Version、构建产物、配置与 Evidence 引用。
- 输出：SourceRevision、Trusted Profile Version（如适用）和 Release。
- 约束：`changed` 必须有 Diff/Requirement/理由；`unchanged` 必须有理由；`uncertain` 禁止晋升；Release 固定绑定 SourceRevision 和 Profile Version。
- 错误条件：引用缺失、Profile 处置不完整、Snapshot 未验证、发布前置条件未满足。
- 关联需求：`R-004`、`R-006`
- 关联决策：`AD-002`、`AD-008`、`AD-010`

### CT-005：Deployment 与订阅生命周期契约

- 状态：`Confirmed`
- 来源：Grill Me 关于首次自动发布、后续确认、回滚和订阅生命周期的确认。
- 调用方：Platform Domain。
- 被调用方：Release and Deployment Controller。
- 职责：部署 Release、执行生产控制操作、报告健康状态，并依据订阅状态公开运行、停服或恢复。
- 输入：Release、发布确认（仅后续更新）、订阅事件、上一健康 Deployment 引用。
- 输出：Deployment、健康状态、公开运行入口、回滚/停服/恢复结果和受控诊断。
- 约束：首次 validated 版本自动部署；后续更新需 Owner 确认；Deployment rollback 不回退 Profile/SourceRevision/数据库；停服不删除应用事实或数据。
- 错误条件：Release 不可部署、健康检查失败、Migration 失败、订阅无效且宽限期结束。
- 关联需求：`R-001`、`R-006`、`R-007`
- 关联决策：`AD-010`、`AD-011`、`AD-012`

## 约束

### CST-001：Platform 领域状态权威性

- 状态：`Confirmed`
- 来源：Grill Me 关于 Runtime/Platform 边界的确认。
- 分类：Architecture
- 约束：Application、Profile、Requirement、Task、Run、Snapshot、Validation、SourceRevision、Release 和 Deployment 的持久状态仅由 Platform Domain 权威保存和裁决。
- 适用范围：所有 Application 生命周期操作。
- 不满足时的影响：Pi Session 或 Runtime 暂态状态会错误成为产品真相，导致恢复和审计不可靠。
- 关联需求：`R-001`、`R-003`、`R-006`
- 关联决策：`AD-001`、`AD-005`

### CST-002：封闭源码晋升路径

- 状态：`Confirmed`
- 来源：Grill Me Q19。
- 分类：Compatibility
- 约束：所有稳定 SourceRevision 必须经 `Task -> Run -> Workspace -> CandidateSourceSnapshot -> Validation -> SourceRevision` 形成；外部 Git、CI 和管理员脚本不得直接写稳定源码。
- 适用范围：Application Source 的全部写入和版本晋升。
- 不满足时的影响：版本、验证、Profile 和 Release 之间失去可追溯性。
- 关联需求：`R-004`
- 关联决策：`AD-008`

### CST-003：Profile 语义处置与澄清

- 状态：`Confirmed`
- 来源：Grill Me 关于 Profile 准入、Candidate Diff 和语义风险模型的确认。
- 分类：Architecture
- 约束：每个拟晋升 Snapshot 必须声明 `changed`、`unchanged` 或 `uncertain`；Platform 检查结构完整性，不裁决自然语言语义；Agent 遇决定性歧义必须阻断并澄清。
- 适用范围：业务变更、纯工程变更和源码/Profile 疑似冲突。
- 不满足时的影响：系统会静默假定 Profile 未变或让 Agent 以猜测改变业务行为。
- 关联需求：`R-002`、`R-004`
- 关联决策：`AD-002`、`AD-004`

### CST-004：单写入 Run 与隔离 Workspace

- 状态：`Confirmed`
- 来源：Grill Me 关于并发、Workspace 和无 Subagent 的确认。
- 分类：Runtime
- 约束：同一 Application 同一时刻最多一个写入型 Run；每个 Run 使用独立可写 Workspace。
- 适用范围：Agent 代码修改和 Sandbox 执行。
- 不满足时的影响：出现基线竞争、未定义合并和验证归属不清。
- 关联需求：`R-003`
- 关联决策：`AD-003`、`AD-007`

### CST-005：Sandbox 信任边界

- 状态：`Confirmed`
- 来源：Grill Me Q14。
- 分类：Security
- 约束：Sandbox 内允许正常开发自由度，但不得访问宿主机、其他 Workspace、Production、生产凭据、Platform 管理 API 或非预期私有网络。
- 适用范围：Agent 工具、命令、进程、网络和凭据。
- 不满足时的影响：Agent 可绕过 Platform 生产权限边界。
- 关联需求：`R-003`
- 关联决策：`AD-006`

### CST-006：Run 恢复与幂等外部副作用

- 状态：`Confirmed`
- 来源：Grill Me Q17。
- 分类：Operational
- 约束：同一 Run 同时最多一个活跃 Runtime；有副作用的 Platform Request 必须有 `requestId`、幂等键和状态查询。Owner 取消终止当前 Run，禁止后台自动恢复。
- 适用范围：Runtime 重启、Engine Session 重建、Snapshot、Validation、Release 和 Deployment 请求。
- 不满足时的影响：重复外部操作、双重写入或用户取消后继续执行。
- 关联需求：`R-003`、`R-004`、`R-006`
- 关联决策：`AD-003`

### CST-007：不可变 Snapshot 与权威 Validation

- 状态：`Confirmed`
- 来源：Grill Me Q8/Q9。
- 分类：Runtime
- 约束：Validation 必须绑定不可变 CandidateSourceSnapshot；Agent 自我检查不等同于 Task 完成；只有全部必需验证通过才能晋升。
- 适用范围：所有 SourceRevision 和 Release 输入。
- 不满足时的影响：验证可能不对应待发布代码，或未验证代码进入稳定版本。
- 关联需求：`R-004`、`R-005`
- 关联决策：`AD-009`

### CST-008：发布确认与公共运行分离

- 状态：`Confirmed`
- 来源：Grill Me Q18 和部署后公开运行确认。
- 分类：Permission
- 约束：首次 validated 版本自动部署；已上线 Application 的后续版本仅在 Owner 确认后部署。未部署版本只供 Owner 受控预览/验证；健康 Deployment 提供公共运行入口。
- 适用范围：Release、Deployment 和 Product Layer。
- 不满足时的影响：后续变更会未经 Owner 确认影响公众，或非技术用户无法获得公开服务。
- 关联需求：`R-001`、`R-006`
- 关联决策：`AD-011`

### CST-009：兼容 Production Migration

- 状态：`Confirmed`
- 来源：维护者对 Migration Safety 的确认。
- 分类：Compatibility
- 约束：Production Migration 只允许新增表/关联表、nullable 字段、安全默认值字段、索引和不破坏现有数据的状态/配置结构；禁止删除、破坏性重命名、收紧约束、不可逆重写、无界 backfill 和停机迁移。
- 适用范围：已上线 Application 的数据库演进。
- 不满足时的影响：源码回滚无法恢复数据库状态，导致 Production 数据风险。
- 关联需求：`R-005`
- 关联决策：`AD-012`

### CST-010：Production 操作独占权

- 状态：`Confirmed`
- 来源：Grill Me Q10。
- 分类：Permission
- 约束：Platform 独占生产构建、配置/密钥注入、生产 Migration、流量切换、健康检查、日志和回滚；Agent 只能请求并读取受控结果。
- 适用范围：Release、Deployment 和 Production Runtime。
- 不满足时的影响：Agent 可直接越过生产安全和运维边界。
- 关联需求：`R-006`
- 关联决策：`AD-010`

### CST-011：订阅停服保留

- 状态：`Confirmed`
- 来源：维护者关于订阅生命周期的确认。
- 分类：Operational
- 约束：宽限期结束后停止公开 Deployment，但保留 Application、Profile、版本、数据库、日志和记录；续费恢复上一健康 Release。
- 适用范围：订阅、Deployment 和数据保留。
- 不满足时的影响：订阅状态可能意外破坏应用事实或数据，无法可靠恢复。
- 关联需求：`R-007`
- 关联决策：`AD-012`

## 验证

- 验证策略：以固定 CandidateSourceSnapshot 为唯一验证对象，区分 Agent Self-Check 与 Platform / Authoritative Validation。
- 功能验证：验证 Owner 创建/管理 Application、Requirement 到 Task、首次公开部署、后续确认发布和订阅停服/恢复。
- 架构验证：验证领域状态不依赖 Pi Session，写入 Lease 排他，稳定源码只经受控晋升路径形成。
- Runtime 验证：验证 Sandbox 隔离、资源限制、Engine Session 重建、取消与幂等 Platform Request。
- 安全 / 权限验证：验证非 Owner/非 System Administrator 的管理请求被拒绝；Agent/Sandbox 不可访问 Production 凭据、数据库、宿主机或其他 Workspace；公众不能获得 Platform 管理能力。
- 验收验证：Platform 在隔离环境对 Snapshot 执行模板化 Engineering、Database、Runtime 与 Task Acceptance 验证。
- Agent Self-Check 的适用范围：Agent 可在 Sandbox 中运行测试、构建、调试和诊断，结果仅作为诊断输入。
- Platform / Authoritative Validation 的最终判定范围：Task `validated`、Snapshot -> SourceRevision、Release 创建、Deployment 健康和 Production Migration 门禁。

### 系统级验收标准

- `SAC-001`：Owner 从创建 Application、提交明确 Requirement 到获得公开健康 URL 的首轮闭环中，所有稳定 SourceRevision、Release 和 Deployment 均可追溯到同一受控 Snapshot/Validation 证据链。
- `SAC-002`：已上线 Application 的后续版本在 Owner 未确认发布时不改变公众访问的健康 Deployment；确认后部署失败时，Production 保持或回到上一健康版本。
- `SAC-003`：支付失败或订阅到期在宽限期结束后只停止公开运行，不删除应用、版本或数据；续费后恢复上一健康 Release。

## 范围与非范围

- 当前范围：单组织内部业务 Web 应用；固定 TypeScript 全栈模板；单 HTTP 服务；平台托管关系数据库；核心实体/字段、表单、列表/筛选、详情、基础仪表盘和简单状态流转；首次自动公开部署与后续确认发布。
- 非范围：支付和第三方业务集成、复杂多人协作业务工作流、自定义后台任务、原生移动端、多技术栈、多拓扑、多环境、用户自带基础设施、Subagent、外部源码直接写入、复杂发布与复杂 Migration。
- 未来考虑事项：派生 Run、只读 Research/Review、多 Agent、受控 Git Import、发布策略、Backup/PITR、复杂 Schema Evolution、细粒度 Sandbox 后端和订阅治理。

## 现有状态与变更边界

- 现有行为：当前系统为新建系统，不存在需要兼容的既有实现。当前仓库含 `paimeng-ai-code-agent` 的旧 Agent SSE 协议、Workspace 路径校验和文件工具，可作为迁移评估输入，但不构成本规格需要兼容的 Application 生命周期实现；`paimeng-ai-code-agent/package.json` 当前使用 AI SDK 和 XState。
- 当前架构：当前 Agent 实现尚未接入 Pi SDK；当前 Workspace/FileTools 不是容器级 Sandbox；尚未发现本规格定义的 Application/Task/Run/Snapshot/Release/Deployment 权威领域模型。
- 当前接口：现有 SSE 事件和旧代码生成接口可作为迁移评估输入，但不能被假定为满足本规格的 Run Event 或 Platform Contract。
- 需要改变的部分：新增 Platform Domain、Agent Runtime、Pi Adapter、隔离 Sandbox、Snapshot/Validation、版本晋升、Release/Deployment、订阅生命周期和对应 Product Layer。
- 必须保持不变的部分：不修改 `runtime/tmp/` 或归档微服务作为开发基线；不得将生产凭据写入源码、日志或 Agent 上下文；不得让旧 Session 成为 Application 权威状态。

## 未决问题

### OQ-001：固定 TypeScript 全栈模板与 Migration 工具

- 状态：`Open Question`
- 问题：首个固定模板采用何种前端、服务端、ORM 和 Migration 工具组合？
- 为什么尚未解决：维护者只确定 TypeScript 全栈形态，未选择具体工具。
- 影响：影响模板验证命令、兼容 Migration Gate 的实现方式和生成约束；不改变 MVP 产品边界。
- 需要的决策方：维护者。
- 阻塞的需求 / 决策 / 契约：实现 `R-003`、`R-005`、`CST-009` 前必须决定。

### OQ-002：Snapshot 与 SourceRevision 的物理存储

- 状态：`Open Question`
- 问题：使用内部 Git commit、内容哈希对象存储或其他不可变快照实现？
- 为什么尚未解决：仅确定语义和可恢复性，未锁定物理实现。
- 影响：影响 `CT-003`、`CT-004` 的存储实现，不改变 Snapshot 不可变和可追溯规则。
- 需要的决策方：维护者或实现阶段在约束内选择。
- 阻塞的需求 / 决策 / 契约：实现 Snapshot 存储前必须解决。

### OQ-003：Sandbox 与 Deployment 执行后端

- 状态：`Open Question`
- 问题：MVP 使用何种容器/执行后端实现一 Run 一 Sandbox、验证环境和 Production Deployment？
- 为什么尚未解决：只确定隔离、资源和网络边界，未锁定 Docker、Podman 或其他后端。
- 影响：影响 `CST-005`、`CT-005` 的实施方式，不改变 Runtime/Production 权限边界。
- 需要的决策方：维护者。
- 阻塞的需求 / 决策 / 契约：实施 `R-003`、`R-005`、`R-006` 前必须决定。

### OQ-004：公共 URL、域名与 TLS 最小策略

- 状态：`Open Question`
- 问题：MVP 公共运行入口如何分配域名、绑定 TLS 和表示 URL 生命周期？
- 为什么尚未解决：已确定公开运行入口，未确定具体地址策略。
- 影响：影响 `R-001`、`R-006` 的公开入口实现，不改变公众可访问健康 Deployment 的行为。
- 需要的决策方：维护者。
- 阻塞的需求 / 决策 / 契约：实现 Production 公开入口前必须决定。

### OQ-005：订阅宽限期、通知和最终保留期限

- 状态：`Open Question`
- 问题：宽限期长度、通知渠道、最终数据保留期限和计费接入细节是什么？
- 为什么尚未解决：仅确定宽限、停服保留和续费恢复的状态语义。
- 影响：影响 `R-007` 的具体运营参数，不改变 MVP 的停服不删除和续费恢复规则。
- 需要的决策方：维护者。
- 阻塞的需求 / 决策 / 契约：首次真实订阅接入和最终删除策略前必须决定。

## 决策追溯

| 项目 ID | 类型 | 当前状态 | 来源 | 关联 Requirement | 说明 |
| --- | --- | --- | --- | --- | --- |
| `R-001` | Requirement | `Confirmed` | 维护者在需求确认阶段 | `R-001` | Application 管理与公共运行入口。 |
| `R-002` | Requirement | `Confirmed` | Grill Me 关于 Requirement/Task | `R-002` | 不可变需求、归一化、澄清和 Task 基线。 |
| `R-003` | Requirement | `Confirmed` | Grill Me 关于 Runtime/Sandbox | `R-003` | 单 Run 隔离 Agent 执行。 |
| `R-004` | Requirement | `Confirmed` | Grill Me 关于 Snapshot/Profile | `R-004` | 不可变源码和 Profile 处置。 |
| `R-005` | Requirement | `Confirmed` | Grill Me 关于 Validation/Migration | `R-005` | 权威验证与兼容 Migration。 |
| `R-006` | Requirement | `Confirmed` | Grill Me 关于 Release/Deployment | `R-006` | 发布、部署、回滚和确认上线。 |
| `R-007` | Requirement | `Confirmed` | 维护者确认订阅策略 | `R-007` | 宽限、停服保留和续费恢复。 |
| `D-06` | Delivery Decision | `Locked Decision` | 维护者批准 Issue #71 | `R-002`、`R-003`、`R-005`、`R-006` | Task/Run 状态、取消、重试、Lease 与 Release 边界。 |
| `AD-005` | Architecture Decision | `Locked Decision` | Grill Me Q13 | `R-003` | Runtime 只协调 Run，Platform 持有真相。 |
| `AD-006` | Architecture Decision | `Locked Decision` | Grill Me Q14 | `R-003` | Pi 通过 Adapter 和 Sandbox Tool Contract 接入。 |
| `AD-007` | Architecture Decision | `Locked Decision` | Grill Me Q15 | `R-003` | MVP 不做 Subagent/Multi-Agent Framework。 |
| `AD-008` | Architecture Decision | `Locked Decision` | Grill Me Q19 | `R-004` | 源码入口封闭并显式 Profile 处置。 |
| `AD-009` | Architecture Decision | `Locked Decision` | Grill Me Q9 | `R-005` | Platform Validation 决定完成。 |
| `AD-010` | Architecture Decision | `Locked Decision` | Grill Me Q16 | `R-006` | 目标基线与 Production 实际状态解耦。 |
| `AD-011` | Architecture Decision | `Locked Decision` | Grill Me Q18 | `R-006` | 首次自动发布，后续确认发布。 |
| `AD-012` | Architecture Decision | `Locked Decision` | 维护者确认 Migration/订阅策略 | `R-005`、`R-007` | 兼容 Migration 与停服保留。 |
| `AD-013` | Architecture Decision | `Locked Decision` | 维护者批准 TS Agent 用量计量边界 | `R-003` | TS Agent 负责 Agent 调用与 Usage Evidence；MVP 不接入旧积分链路。 |
| `CST-005` | Constraint | `Confirmed` | Grill Me Q14 | `R-003` | Sandbox 真实隔离边界。 |
| `CST-009` | Constraint | `Confirmed` | 维护者确认 Migration Safety | `R-005` | 仅兼容的 Production Schema Evolution。 |
| `OQ-001` | Open Question | `Open Question` | 当前未确认 | `R-003`、`R-005` | 固定技术栈和 Migration 工具。 |
| `OQ-003` | Open Question | `Open Question` | 当前未确认 | `R-003`、`R-006` | Sandbox 与 Deployment 执行后端。 |
| `OQ-005` | Open Question | `Open Question` | 当前未确认 | `R-007` | 订阅运营参数与最终保留策略。 |
