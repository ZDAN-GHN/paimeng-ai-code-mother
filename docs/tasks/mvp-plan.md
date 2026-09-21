# 实施计划：应用生成与托管平台 MVP

- 计划状态：`D-01、D-06、D-07 与 T-01 已交付；T-02/T-03、T-04 已解除直接决策阻塞；其余受 OQ 影响的任务待对应决策完成`
- 规格基线：[GitHub Issue #65](https://github.com/ZDAN-GHN/paimeng-ai-code-mother/issues/65) 与 [MVP 工程规格](../specs/mvp-engineering-spec.md)
- 任务清单草案：[mvp-todo.md](mvp-todo.md)
- 任务追踪策略：本文件和 `mvp-todo.md` 是按维护者要求保存于 `docs/tasks/` 的审查草案。已使用 `to-tickets` 创建 GitHub Issue #66 至 #84、将其作为 Issue #65 的原生子 Issue，并以 GitHub 原生依赖关系表达 blocker；D-01/D-07 的已批准决定同步至工程规格和对应 Issue，其余任务尚未认领或实施。

## 概述

本计划将已发布规格中的 `R-001` 至 `R-007` 拆为可独立验收的实施任务。主线是先建立 Platform 的持久领域事实和 Owner 入口，再构建单 Run 的 Pi Agent 执行与隔离边界，然后将不可变版本、权威验证、发布和订阅生命周期接入同一证据链。

本计划不实施产品功能、不在未决问题上自行选择模板或执行后端、不将旧 `App` / `GenerationRun` 语义直接升级为新平台领域模型，也不创建额外的 Agent SDK 集成。D-01 已锁定固定模板，D-07 已锁定逻辑归档；Pi SDK 是唯一允许接入的 Agent Engine；RAG 不进入该主链路。

## 已核实现状

| 项目 | 事实 | 对计划的影响 |
| --- | --- | --- |
| Java 后端 | Spring Boot 3、Java 21、MyBatis Flex、MySQL 和 Redis；已有 `AppController`、`GenerationRunController`、认证和内部 API 基础。 | Platform Domain 应在 Java 后端建立权威持久状态与内部 API。旧模型只可作为迁移评估输入。 |
| TS Agent | `paimeng-ai-code-agent/` 当前为空目录。 | Pi Adapter、Runtime、Sandbox Tool Contract 和 Agent 测试需从受控基础重新建立；不得复用 Vercel AI SDK 或其他 Agent SDK。 |
| Vue 前端 | Vue 3、Ant Design Vue、OpenAPI 生成 API 类型；已有 Application 聊天/编辑页面和 SSE 客户端。 | Owner 入口在已有前端上演进，接口类型必须通过 `npm run openapi2ts` 生成，不能手写后端类型。 |
| 基础设施 | 有 Docker Compose、Nginx 和 MySQL 初始化资料，但未发现平台级 Sandbox/Release/Deployment 实现。 | Sandbox、验证与部署后端必须先经决策门选择，再实施。 |
| 既有生成链路 | README 记录旧 TS Agent/P3 生成主链路，规格明确其不构成新平台领域实现。 | 不承诺旧 SSE 或旧生成状态与新 `Run Event` 兼容；需要适配时在任务中显式测试。 |

## 决策与依赖图

```text
D-06 Task / Run 状态转换矩阵 ─> T-01 领域状态机 ─> T-02 Owner API ─> T-03 Owner 初始入口
D-07 Application 删除语义 ────────────────────────────────────────────────┘

D-01 固定模板与 Migration 工具 ────────────────> T-04 Pi Adapter 基线解析
D-02 Sandbox / Deployment 后端 ─┐                              ↓
D-06 Task / Run 状态转换矩阵 ────┼─> T-05 Runtime 能力 / Lease / Sandbox ─> T-06 Snapshot / Validation 契约
T-01 Task 执行基线 ───────────────┘                                      ↓
D-05 Snapshot 物理存储 ───────────────────────────────────────> T-07 权威 Validation 与版本晋升
                                                                      ↓
                                                              T-08 Requirement 到 Run 闭环
D-03 公共 URL / TLS 策略 ────────────────────────────────────────────────> T-09 首次 Release / Deployment
                                                                      ↓
                                                              T-10 后续发布确认与公开运行
D-04 订阅运营参数 ───────────────────────────────────────────────────────> T-11 订阅生命周期
                                                                      ↓
                                                              T-12 跨服务验收与运行加固
```

- `T-01` 必须在 D-06 状态矩阵写入工程规格后开始；`T-02`、`T-03` 还依赖 D-07 删除语义，并按其依赖顺序进行。
- `T-04` 在 D-01 与 `T-01` 的 Task 执行基线契约完成后进行，只实现基线解析与 Pi Adapter 受控基线；`T-05` 在 D-02 后组装完整 Run Context、实现 Runtime 能力、Lease 与 Sandbox。`T-06` 还依赖 D-05；`T-07` 在 `T-06` 的持久契约上执行验证并完成版本晋升。
- `T-08` 至 `T-11` 依赖上游稳定契约，必须顺序完成，避免在状态、Snapshot、Validation 或 Release 语义未冻结时并行实现。
- `T-12` 只在所有前序任务完成后执行，作为跨服务验收与安全边界检查。

## Phase 0：维护者决策门

下列问题会改变实现路径、生产边界或对外行为。它们不是 Agent 可自行选择的实现细节；未解决前不进入相关写入任务。

### D-01：固定模板与 Migration 工具

- 状态：`Approved`。唯一组合为 Node.js `24.20.0`、Vue `3.5.17`、Vite `7.0.4`、Fastify `5.12.3`、Prisma/`@prisma/client` `7.10.0` 和 MySQL `8`；提交锁文件和 SQL migration，命令及兼容 Migration 边界见 `AD-014`。
- 对应：`OQ-001`。
- 已解除：`T-04` 的模板选择阻塞；`T-05`、`T-07` 仍受 D-02 和既有任务依赖约束。

### D-02：Sandbox 与 Deployment 执行后端

- 对应：`OQ-003`。
- 需要决定：隔离容器/执行后端、网络隔离、资源上限、日志收集、验证环境和 Production Deployment 的最小实现。
- 影响：阻塞 `T-05`、`T-07`、`T-09`；不阻塞仅解析 Platform Task 执行基线的 `T-04`。
- 验收：决策记录定义宿主机隔离、其他 Workspace 隔离、Production/凭据隔离、清理策略和可复现的本地验证入口。

### D-03：公共 URL 与 TLS 最小策略

- 对应：`OQ-004`。
- 需要决定：Application URL 分配、DNS/TLS 所有权、URL 生命周期及健康检查失败时的行为。
- 影响：阻塞 `T-09`、`T-10`。
- 验收：决策记录给出 URL 格式、TLS 终止位置、健康路由和失败/回滚后的可观察行为。

### D-04：订阅运营参数与外部接入范围

- 对应：`OQ-005`。
- 需要决定：宽限期、通知渠道、订阅事件来源、续费恢复触发条件和最终数据保留策略。
- 影响：阻塞 `T-11`。
- 验收：决策记录给出状态转换时间规则、事件幂等要求、恢复条件和明确延期的计费/删除能力。

### D-05：Snapshot 物理存储选择

- 对应：`OQ-002`。
- 状态：受 `CST-002` 约束的实现选择；可由实现任务提出并经维护者记录确认。
- 需要决定：不可变 Snapshot/SourceRevision 使用内部 Git commit、内容寻址对象存储或其他方案。
- 影响：阻塞 `T-06`。
- 验收：选择能证明不可变性、来源可追溯、内容可恢复和不绕过 `Task -> Run -> Workspace -> CandidateSourceSnapshot -> Validation -> SourceRevision` 路径的方案。

### D-06：Task 与 Run 状态转换矩阵

- 状态：`Approved`。维护者已批准的矩阵写入工程规格与 Issue #65；实现和测试以该矩阵为唯一状态契约。

- 对应：审查发现 P1；补充工程规格的状态契约。
- 需要决定：Task/Run 的完整状态集、每条允许转换的触发者和前置条件、取消后的 Task/Run 终态、`blocked` 回答后的重新归一化、失败后的重试/新 Task 规则，以及 Run 终态与 Lease 释放的关系。
- 影响：阻塞 `T-01`、`T-02`、`T-03`、`T-05`、`T-08`，并决定其状态机测试基线。
- 验收：转换矩阵写入 `docs/specs/mvp-engineering-spec.md` 和 Issue #65，至少覆盖 `created`、`ready`、`executing`、`blocked`、`failed`、`validated`、`released`、取消与 Run 终态；每条边明确权限、触发者和不可达条件。

### D-07：Application 删除与数据保留语义

- 状态：`Approved`。删除是逻辑归档：仅 Owner/System Administrator 可发起；归档前无活跃写入型 Run；公开运行立即不可用，关联事实、证据、版本和数据库保留；MVP 不提供物理删除或恢复 API/UI。具体撤流机制仍待 D-03。
- 对应：审查发现 P4；解决 `R-001` 的删除能力与 MVP 排除最终数据删除治理之间的语义缺口。
- 已解除：`T-02`、`T-03` 的删除语义阻塞。

## 任务清单

### Phase 1：Platform 领域与 Owner 初始入口

#### 任务 1：Platform 核心领域持久化与状态机

**关联规格：** `R-001`、`R-002`、`R-003`、`AD-001`、`AD-003`、`CST-001`、`CST-006`、`CT-001`、`CT-002`。

**说明：** 在 D-06 已批准的状态转换矩阵基础上，在 Java 后端建立 Application、Requirement、Task、Run 与 Trusted Profile 的独立 Platform Domain 模型、迁移、Repository/Service 和受控状态转换。Task 在进入实施前由 Platform 冻结 `baseProfileVersion`、`baseSourceRevision`、`requestedOutcome`、`acceptanceTarget`，形成版本化 `TaskExecutionBaseline`；它是 `CT-002` 的 Platform 输入片段，而非包含 Workspace、Sandbox Tool Contract 或 Execution Policy 的完整 Run Context。旧 `App` 与 `GenerationRun` 只可作为现状评估输入，不得静默承接新对象的语义或成为权威基线。

**验收标准：**
- [ ] Platform Domain 持久化 Application、不可变 Requirement、Task、Run 和版本化 Trusted Profile，并保持完整 Application 归属关系。
- [ ] 进入实施的 Task 仅能由 Platform 冻结四项基线字段，并生成带 schema version 的 `TaskExecutionBaseline`；缺少字段、变更已冻结基线或使用未知 schema version 被拒绝。
- [ ] 所有 Task/Run 逻辑状态转换、取消请求和重新归一化入口均严格符合 D-06 矩阵；非法边、错误触发者和缺失前置条件被拒绝。Workspace、Tool Contract、Execution Policy、Lease 与 Sandbox 清理由任务 5 在 D-02 后实现与验证。

**验证：**
- [ ] 新增的 Java 领域服务/状态机测试按 D-06 覆盖每条允许边、每条关键非法边、取消请求和 Application 归属失败。
- [ ] Java `TaskExecutionBaseline` 契约测试覆盖基线冻结、版本序列化、未知/缺失字段拒绝，并输出可由任务 4 和任务 5 消费的固定测试夹具。
- [ ] `cd paimeng-ai-code-backend && ./mvnw test` 通过。
- [ ] `cd paimeng-ai-code-backend && ./mvnw verify` 通过。

**依赖：** D-06。实施前必须按项目流程调用 `task-evidence-analysis` 并审查当前工作树。

**可能涉及文件：** `paimeng-ai-code-backend/src/main/java/.../platform/**`（新建）、`model/**`、`mapper/**`、`service/**`、`controller/**`、`infra/sql/**`、对应 `src/test/**`。

**预计范围：** M。

#### 任务 2：Owner 管理、删除与 Requirement 接收 API 契约

**关联规格：** `R-001`、`R-002`、`AC-001` 至 `AC-004`、`AC-026`、`CT-001`、`CST-001`。

**说明：** 在 Java 后端实现 Owner/System Administrator 的 Application 创建、读取、按 D-07 的删除策略删除，以及不可变 Requirement 接收 API，并将鉴权和错误返回纳入现有 REST 模式。Phase 1 不创建 Task、不提出 `blocked` 问题、不启动 Agent Run；提交后的 Requirement 仅以“等待归一化”的可观察状态返回。

**验收标准：**
- [ ] Owner 可创建 Application、提交不可变 Requirement，并读取“等待归一化”的 Requirement 状态；此阶段不产生 Task、Sandbox 写入或 Agent 结论。
- [ ] Owner/System Administrator 可按 D-07 的已批准语义删除 Application；删除后的公开入口、关联事实和恢复/不可恢复边界可观察。
- [ ] 非 Owner、非 System Administrator 的创建、删除或读取同一 Application 管理事实请求被拒绝。

**验证：**
- [ ] Controller/Service 测试覆盖 Owner、管理员、普通用户和公众访问四种权限路径，以及 D-07 定义的授权删除成功/拒绝/后置行为。
- [ ] `cd paimeng-ai-code-backend && ./mvnw -Dtest=*Platform*Test test` 通过。
- [ ] `cd paimeng-ai-code-backend && ./mvnw verify` 通过。

**依赖：** D-07、任务 1。

**可能涉及文件：** `controller/**`、`model/dto/**`、`model/vo/**`、`service/**`、`aop/AuthInterceptor.java`（仅在现有鉴权不足时）、OpenAPI 配置与对应测试。

**预计范围：** M。

#### 任务 3：Owner 初始 Application、删除与 Requirement 接收界面

**关联规格：** `R-001`、`R-002`、`AC-001`、`AC-004`、`AC-026`、`CT-001`。

**说明：** 将任务 2 的 API 接入 Vue 前端，为 Owner 提供创建 Application、提交自然语言 Requirement、查看“等待归一化”状态和按 D-07 定义的删除操作。归一化、Task 状态和决定性业务问题属于任务 8，不能在本任务通过规则或伪造 Task 提前实现。

**验收标准：**
- [ ] Owner 可在浏览器创建 Application、提交 Requirement 并看到等待归一化状态，不会看到虚构的 Task、Agent 结论或业务澄清问题。
- [ ] Owner/System Administrator 可执行 D-07 定义的删除操作；非授权用户没有删除或其他管理操作入口。
- [ ] 前端不手写后端 DTO 类型，生成后的 API 类型覆盖新增接口。

**验证：**
- [ ] `cd paimeng-ai-code-frontend && npm run openapi2ts` 成功，随后检查生成差异。
- [ ] `cd paimeng-ai-code-frontend && npm run type-check && npm run build` 通过。
- [ ] 手动验证 Owner 创建/提交/等待归一化/删除，以及普通用户无管理入口。

**依赖：** D-07、任务 2。

**可能涉及文件：** `paimeng-ai-code-frontend/src/pages/**`、`components/**`、`router/index.ts`、生成的 `src/api/**`、后端 OpenAPI 注解与接口测试。

**预计范围：** M。

### 检查点 A：领域与 Owner 入口

- [ ] 任务 1 至 3 的 Java 与前端验证均通过。
- [ ] 人工走通“Owner 创建 Application -> 提交 Requirement -> 等待归一化 -> 按 D-07 删除或查看删除后状态”的链路。
- [ ] 复核旧 `App` / `GenerationRun` 没有成为新领域模型的隐式写入路径，也没有在 Pi Runtime 就绪前生成 Task 或业务澄清问题。
- [ ] 维护者审查 API 契约，再开始 Runtime 与 Sandbox 实施。

### Phase 2：单 Run 执行、隔离与不可变版本

#### 任务 4：TS Agent Runtime 与 Pi Adapter 受控基线

**关联规格：** `R-003`、`AD-005`、`AD-006`、`AD-007`、`CT-002`、`CST-005`。

**说明：** 在当前空的 `paimeng-ai-code-agent/` 中建立可复现 Node.js/TypeScript 服务基线，接入 Pi SDK 作为唯一 Agent Engine，并定义 Engine Adapter、统一 Run Event 与仅解析任务 1 版本化 `TaskExecutionBaseline` 的映射层。不得引入 Vercel AI SDK、LangChain 或第二个 Agent SDK；该任务不实现持久 Platform 状态、Workspace/Sandbox Tool Contract、Execution Policy、Lease/Sandbox 资源管理或 Production 操作。完整 Run Context 的组装与受控能力映射属于任务 5。

**验收标准：**
- [ ] 依赖锁文件、启动/类型检查/测试/构建脚本可复现，且只包含 Pi SDK 作为 Agent Engine。
- [ ] Adapter 仅接受任务 1 已声明版本的 `TaskExecutionBaseline`，完整映射冻结基线并输出不泄漏 Pi Session 细节的统一 Run Event；未知版本或缺失字段被拒绝。
- [ ] Adapter 没有 Production、宿主机、数据库、Workspace、Sandbox Tool、Execution Policy、Lease 或 Sandbox 清理能力，且不声明 Task/Release/Deployment 已完成。
- [ ] Adapter 在每次 Agent 调用前后产生版本化、幂等的 Usage Evidence；它不计算或执行业务扣费，不调用旧 Java `CreditService`、`/credit` 或旧 `credit/freeze`。

**验证：**
- [ ] `cd paimeng-ai-code-agent && npm run type-check && npm run test && npm run build` 通过。
- [ ] Java-to-TS 契约测试使用任务 1 固定夹具，覆盖当前 `TaskExecutionBaseline` schema version 的兼容解析、未知版本和缺失字段拒绝。
- [ ] 依赖清单人工检查确认没有其他 Agent SDK。

**依赖：** D-01、任务 1。

**可能涉及文件：** `paimeng-ai-code-agent/package.json`、`package-lock.json`、`src/adapter/**`、`src/protocol/**`、`test/**`、`.env.example`、`README.md`。

**预计范围：** M。

#### 任务 5：单写入 Run、Lease 与 Sandbox Tool Contract

**关联规格：** `R-003`、`AC-007` 至 `AC-010`、`AD-003`、`AD-005`、`CST-004` 至 `CST-006`。

**说明：** 按 D-02 选定的 Sandbox/Deployment 后端和 D-06 已批准的取消/终态规则，实现 Java Platform Domain 与 TS Runtime 之间的 Run Lease、取消和幂等 Platform Request 契约，并在已决定的执行后端上实现一 Run 一 Sandbox/Workspace 的物化、Lease 获取/续租/释放、资源清理和 Tool Contract。此任务定义并版本化 `ExecutionCapabilities`（Workspace 引用、Sandbox Tool Contract、Execution Policy），由 Runtime 将任务 1 的不可变 `TaskExecutionBaseline` 与该能力片段组装为复合 `Run Context`；新增能力只能通过 capability schema version 演进，不能改写 Task 基线 schema。该任务把隔离边界作为实际执行限制，而不是路径字符串校验。

**验收标准：**
- [ ] 同一 Application 的第二个写入型 Run 无法获取 Lease；取消后的 Run/Task 终态与 D-06 一致，且 Lease 释放、Sandbox 清理和后台不自动恢复均由本任务实际执行。
- [ ] `ExecutionCapabilities` 的 Workspace、Sandbox Tool Contract、Execution Policy 仅由 Runtime 在 D-02 隔离后端上生成；Runtime 以显式 baseline/capability schema version 组装完整 Run Context，未知版本、缺失能力或不兼容组合被拒绝。
- [ ] 每个 Run 的 Workspace 与进程隔离；工具无法读取宿主机、其他 Workspace、Production 网络或生产凭据。
- [ ] Runtime 重启后仅在 Lease、Sandbox、Workspace 和外部请求状态可确认时接管 Run；外部副作用使用 `requestId` 和幂等键。

**验证：**
- [ ] Java 测试按 D-06 覆盖 Lease 竞争、取消、终态和幂等请求状态查询；TS 测试覆盖 Runtime 接管决策。
- [ ] 跨服务契约测试将任务 1 的基线夹具与本任务 Capability 夹具组装为完整 Run Context，覆盖当前兼容组合及未知/不兼容版本拒绝，并验证任务 4 Adapter 的完整映射。
- [ ] Sandbox 集成测试尝试越界文件、网络与凭据访问，均被拒绝。
- [ ] `cd paimeng-ai-code-backend && ./mvnw verify` 与 `cd paimeng-ai-code-agent && npm run type-check && npm run test && npm run build` 通过。

**依赖：** D-02、D-06、任务 1、任务 4。

**可能涉及文件：** 后端 `platform/run/**`、内部 Controller/DTO、`paimeng-ai-code-agent/src/runtime/**`、`src/tools/**`、Sandbox 后端配置、测试夹具和 `docker-compose.yml`（仅在 D-02 已批准时）。

**预计范围：** M。

#### 任务 6：Snapshot、Profile 处置与 Validation/Evidence 持久契约

**关联规格：** `R-004`、`AC-011`、`AC-013`、`AD-002`、`AD-008`、`CT-003`、`CST-002`、`CST-003`、`CST-007`。

**说明：** 根据 D-05 选定的不可变存储方案，实现 Workspace 冻结、CandidateSourceSnapshot、Candidate Profile Diff、`profileDisposition`，以及绑定 Snapshot 的不可变 Validation/Evidence 持久契约和 Platform 独占写入边界。本任务不执行权威验证，不能创建 SourceRevision 或 Trusted Profile Version；这些晋升仅由任务 7 在验证成功后完成。

**验收标准：**
- [ ] 可写 Workspace 不能直接成为 Validation 或 Release 输入；冻结结果可恢复、不可变并引用其 Task/Run/基线。
- [ ] `changed` 必须有 Candidate Profile Diff、Requirement 引用和理由，`unchanged` 必须有理由，`uncertain` 不能进入验证成功或版本晋升。
- [ ] Validation/Evidence 持久记录精确绑定一个 Snapshot，且只有 Platform 内部的 Validation Write Contract 能写入结果；外部 API、Agent、Workspace、外部 Git/CI 和管理员路径均无法伪造通过状态或创建 SourceRevision。

**验证：**
- [ ] Java/TS 集成测试覆盖快照冻结、内容恢复、非法 `profileDisposition`、Snapshot/Validation 错配与非权威写入拒绝。
- [ ] `cd paimeng-ai-code-backend && ./mvnw verify` 与 `cd paimeng-ai-code-agent && npm run test` 通过。
- [ ] 人工检查 Snapshot、Task、Run、Validation 与 Evidence 引用链，确认此阶段不存在 SourceRevision 晋升入口。

**依赖：** D-05、任务 1、任务 5。

**可能涉及文件：** 后端 `platform/version/**`、`platform/validation/**`、数据库迁移、内部 API、TS Runtime Snapshot 调用端、测试。

**预计范围：** M。

### 检查点 B：执行与版本安全

- [ ] 任务 4 至 6 的 Java/TS 验证通过：任务 1 仅定义 `TaskExecutionBaseline`，任务 4 只解析该基线，任务 5 在 D-02 后定义版本化 `ExecutionCapabilities` 并组装复合 Run Context；基线/能力版本不兼容必须拒绝。任务 6 仅提供 Snapshot 与 Validation/Evidence 契约，不能创建 SourceRevision。
- [ ] 独立安全审查复核 Sandbox、Lease、幂等外部副作用、封闭源码路径和非权威方不能伪造 Validation 成功。
- [ ] 人工确认 Pi Session/Event 不成为 Platform 领域真相，且不存在第二 Agent SDK。
- [ ] 维护者审查 Snapshot 物理实现和可信 Profile 的 `changed` / `unchanged` / `uncertain` 行为。

### Phase 3：权威验证与首次发布闭环

#### 任务 7：权威 Validation、兼容 Migration Gate 与版本晋升

**关联规格：** `R-004`、`R-005`、`AC-012`、`AC-014` 至 `AC-018`、`AD-009`、`CT-003`、`CT-004`、`CST-007`、`CST-009`。

**说明：** 在任务 6 已提供的受限 Validation/Evidence 持久契约上，执行固定模板的 Engineering、Database、Runtime 和 Task Acceptance 验证，并实现 Production Migration 的静态/执行前兼容性 Gate。只有该权威执行器记录全部通过后，Platform 才能原子晋升 SourceRevision，并按 `profileDisposition` 晋升或保持 Trusted Profile Version。Agent 自检仅可记录为诊断信息。

**验收标准：**
- [ ] 所有必需验证及 Evidence 精确绑定一个 CandidateSourceSnapshot；任意必需项失败会阻止 `validated`、SourceRevision、Profile 晋升和 Release。
- [ ] 全部必需验证通过时，唯一的 Platform 晋升路径才能创建 SourceRevision；`changed`/`unchanged` 按已审计的 `profileDisposition` 处理，`uncertain` 永远不能晋升。
- [ ] 隔离数据库中允许的 Migration 可执行并覆盖 Task 涉及的关键操作；删除/破坏性重命名/收紧约束/不可逆改写/无界 backfill/停机迁移被 Gate 拒绝，且拒绝结果可供 Owner 读取。

**验证：**
- [ ] 验证测试覆盖四类 Gate、失败 Evidence、Snapshot 错配、非权威 Validation 写入拒绝、通过后晋升和失败后禁止晋升。
- [ ] Migration 测试覆盖允许和禁止的 Schema 演进样例。
- [ ] `cd paimeng-ai-code-backend && ./mvnw verify`、模板工程验证命令和 `cd paimeng-ai-code-agent && npm run test` 全部通过。

**依赖：** D-01、D-02、任务 5、任务 6。

**可能涉及文件：** 后端 `platform/validation/**`、`platform/version/**`、Migration Gate、模板验证配置、隔离验证编排、TS Runtime 验证请求端、测试。

**预计范围：** M。

#### 任务 8：Requirement 到受控 Run 的执行闭环

**关联规格：** `R-002`、`R-003`、`R-004`、`R-005`、`AC-004` 至 `AC-018`、`CT-002`、`CT-003`。

**说明：** 在 D-06 已批准的状态矩阵内，将 Requirement 归一化、单一业务澄清、Task 基线、Run 启动、Pi Adapter Event、Snapshot、Validation 和 Task 结果串为单一受控闭环，并交付 Owner 状态 API、OpenAPI 类型、Vue/SSE 状态投影和唯一阻断问题答复入口。Phase 1 接收的“等待归一化” Requirement 仅在此任务由 Pi Agent 处理；只有 Platform 依据任务 7 的 Validation 结果转换到 `validated`。此任务不执行 Production Deployment。

**验收标准：**
- [ ] 明确 Requirement 经 Pi 归一化后形成符合 D-06 的 `ready` Task，并在受控 Run 中产生可查询的 Run/Task 状态、Snapshot 与 Validation 结果。
- [ ] Owner 仅通过 Product Layer 可见其 Application 的 `ready`、`executing`、`blocked`、验证失败和验证成功状态；该投影不暴露 Pi Session、工具细节、Sandbox 或生产信息。
- [ ] 决定性业务歧义经 Pi 归一化后形成符合 D-06 的 `blocked` Task；Owner 可见唯一问题并提交答复，之后仅按矩阵允许的路径重新归一化，在答复前不启动 Sandbox 写入或版本晋升。
- [ ] 非 Owner、非 System Administrator 无法读取同一 Application 的管理状态或提交答复；Agent 的文本完成或自检成功不能替代 Platform Validation 的 `validated` 裁决。

**验证：**
- [ ] 跨服务集成测试覆盖“等待归一化 -> ready -> executing”、`blocked` 与答复后重新归一化、Validation 失败和成功，以及状态读取/答复的授权拒绝，并逐条断言 D-06 边。
- [ ] `cd paimeng-ai-code-backend && ./mvnw verify`、`cd paimeng-ai-code-agent && npm run type-check && npm run test && npm run build` 与 `cd paimeng-ai-code-frontend && npm run openapi2ts && npm run type-check && npm run build` 通过。
- [ ] 手动查看 Owner 状态和答复入口，确认事件可理解且不暴露 Pi Session、工具细节或生产信息。

**依赖：** D-06、任务 2、任务 3、任务 4、任务 5、任务 6、任务 7。

**可能涉及文件：** Java Platform Service/内部 API、`paimeng-ai-code-agent/src/runtime/**`、`src/adapter/**`、前端状态页/SSE 适配层、跨服务测试。

**预计范围：** M。

#### 任务 9：首次 Release、Deployment 与健康公开入口

**关联规格：** `R-006`、`AC-019`、`AC-022`、`AD-010`、`AD-011`、`CT-004`、`CT-005`、`CST-008`、`CST-010`。

**说明：** 在批准的 Deployment 后端与 URL/TLS 策略下，实现 validated 首次版本自动创建 Release、执行 Platform 独占的 Production 操作、健康检查和公开 URL。发布控制器只能接受固定 SourceRevision/Profile/Validation 证据，不能从 Workspace 或 Agent Session 部署。

**验收标准：**
- [ ] 首次 validated 版本自动创建固定 Release 并发起 Deployment；健康通过后才提供公开 URL。
- [ ] Agent 不能访问生产密钥、数据库、构建、迁移、流量或回滚操作；仅 Platform Controller 拥有这些能力。
- [ ] 首次部署失败时不存在健康公开 URL，Application 对 Owner 显示未上线，且受控诊断不泄露敏感配置。

**验证：**
- [ ] 使用隔离的非生产环境端到端验证首次 Release、健康检查、公开 URL，以及失败后的未上线状态和受控诊断。
- [ ] `docker compose config`（或 D-02 定义的等价配置验证）通过；后端 `./mvnw verify` 通过。
- [ ] 权限测试断言 Agent Token 不可调用 Deployment/Production 内部操作。

**依赖：** D-02、D-03、任务 6、任务 7、任务 8。

**可能涉及文件：** 后端 `platform/release/**`、`platform/deployment/**`、`ops/**`、`infra/docker/**`、`docker-compose.yml`、部署集成测试。

**预计范围：** M。

#### 任务 10：后续发布确认、生产状态与 Owner 可见性

**关联规格：** `R-001`、`R-006`、`AC-020` 至 `AC-022`、`AD-010`、`AD-011`、`CT-005`、`CST-008`。

**说明：** 为已上线 Application 区分目标基线与当前健康 Deployment，并提供 Owner 可读的更新摘要、受控预览入口（若已实现）和明确的发布确认。待发布版本不创建新 Task 状态，未确认时绝不改变公众访问的 Production。

**验收标准：**
- [ ] 后续 validated 版本可显示目标 SourceRevision/Profile 与当前健康 Deployment 的关系；未确认时公众可见内容和当前健康 Deployment 的 Release 引用保持不变。
- [ ] 只有 Owner/System Administrator 的显式确认才创建并部署固定 Release，健康检查通过前不得表述为已上线。
- [ ] 部署失败或回滚后，上一健康 Deployment 保持或恢复，且已验证目标基线、Trusted Profile 与数据库不被撤销、反向迁移或改写。

**验证：**
- [ ] 后端测试覆盖未确认、确认、无权限确认、部署失败与回滚状态。
- [ ] `cd paimeng-ai-code-frontend && npm run openapi2ts && npm run type-check && npm run build` 通过。
- [ ] 在隔离环境手动验证确认前公开内容/健康 Deployment 引用不变，确认后部署固定 Release，以及失败/回滚后 Production 与目标基线/数据库边界符合预期。

**依赖：** 任务 3、任务 8、任务 9。

**可能涉及文件：** Java Release/Deployment API、Vue Application 状态/发布确认组件、`src/api/**`（生成）、路由/SSE 适配和端到端测试。

**预计范围：** M。

### 检查点 C：首次托管与受控更新

- [ ] 任务 7 至 10 的验证全部通过。
- [ ] 人工走通“明确 Requirement -> Run -> Snapshot -> Validation -> 首次自动发布 -> 后续变更待确认 -> 确认发布”。
- [ ] 审查 Release/Deployment 证据链，确认 Workspace、Agent Session 或外部 Git 不能绕过它，且 SourceRevision 只能由任务 7 的权威 Validation 成功后晋升。
- [ ] 在隔离环境审查公开 URL、TLS、健康检查和失败回滚；不对 Production 执行试验性操作。

### Phase 4：订阅运行生命周期与交付加固

#### 任务 11：订阅生命周期、状态 API 与 Owner 可见性

**关联规格：** `R-007`、`AC-023` 至 `AC-025`、`AD-012`、`CT-005`、`CST-011`。

**说明：** 按 D-04 已决定的运营参数实现订阅状态事件、宽限期、停止公开 Deployment、数据/证据保留和恢复上一健康 Release；同时提供 Owner/System Administrator 可读取的订阅运行状态 API、OpenAPI 类型和 Vue 界面。界面必须区分有效运行、宽限、已停服和已恢复，且不暴露计费提供商凭据、内部 Deployment 诊断或其他 Application 的状态。该任务不实现退款、最终数据删除、复杂计费或订阅自助管理界面。

**验收标准：**
- [ ] 有效订阅且存在健康 Deployment 时，Application 保持公开运行；Owner 可见“有效运行”状态及当前公开可用性。
- [ ] 到期和宽限结束后只停止公开 Deployment，保留 Application、Profile、版本、数据库、日志和记录；Owner 可见“宽限”与“已停服”状态，普通用户无法读取管理状态。
- [ ] 续费事件幂等，且仅恢复上一健康 Release，不重新生成源码或改写 SourceRevision/Profile；Owner 可见“已恢复”状态。新增状态 API 的前端类型必须由 OpenAPI 生成。

**验证：**
- [ ] 后端服务/Controller 测试覆盖有效、宽限、停服、重复事件、续费恢复以及 Owner/System Administrator/非授权主体的状态读取权限。
- [ ] `cd paimeng-ai-code-frontend && npm run openapi2ts && npm run type-check && npm run build` 通过，并检查生成差异。
- [ ] 隔离部署环境手动验证公开入口在停服/恢复前后的变化，以及 Owner 对四种状态的可见性。
- [ ] `cd paimeng-ai-code-backend && ./mvnw verify` 通过。

**依赖：** D-04、任务 9、任务 10。

**可能涉及文件：** 后端订阅/Deployment 生命周期服务、事件处理器、状态 API/DTO/OpenAPI 注解、Vue Application 状态组件或页面、生成的 `src/api/**`、定时/队列配置、集成测试和运维配置。

**预计范围：** M。

#### 任务 12：跨服务验收、运行安全与交付文档

**关联规格：** `SAC-001` 至 `SAC-003`、`CST-001` 至 `CST-011`。

**说明：** 针对已实现的 MVP 执行跨服务契约、权限、隔离、版本追溯、首次发布、后续确认发布、订阅恢复与失败路径验收；补齐运行说明、故障处理和最小回滚 Runbook。本任务只验证/加固既有规格，不引入 Future 能力。

**验收标准：**
- [ ] 从 Owner 创建 Application 到首次健康公开 URL 的端到端证据链满足 `SAC-001`。
- [ ] 后续未确认更新不改变 Production，确认失败后保留/恢复上一健康版本，满足 `SAC-002`。
- [ ] 宽限结束停服不删除事实或数据、续费恢复上一健康 Release，且 Owner 对有效运行、宽限、已停服和已恢复状态的读取满足 `SAC-003`；安全测试证明 Agent 无法访问 Production/宿主机/其他 Workspace。

**验证：**
- [ ] Java、TS Agent、Vue 前端各自的完整类型检查、测试和构建命令通过。
- [ ] 使用隔离环境执行跨服务验收脚本；审查输出已脱敏，不含 Token、生产数据或凭据。
- [ ] 对最终变更运行 `$code-review`、TS Agent 代码运行 `$clean-code-reviewer`，并将 Issue 验收复选框与实际证据逐项关联。

**依赖：** 任务 1 至任务 11。

**可能涉及文件：** 跨服务测试树、`docs/**`、`ops/**`、各服务 README、验收脚本和 Issue #65 的交付记录。

**预计范围：** M。

### 检查点 D：MVP 交付评审

- [ ] `R-001` 至 `R-007` 的 `AC-001` 至 `AC-026` 都有实际测试或可复现手动证据；`R-007` 包含 Owner 对有效运行、宽限、已停服和已恢复状态的前端可见性证据。
- [ ] `SAC-001` 至 `SAC-003` 在隔离环境通过。
- [ ] `$code-review` 和 `$clean-code-reviewer` 的结论已记录；P0/P1 已修复并重新验证，或有维护者明确决定。
- [ ] Issue #65 的验收复选框、交付记录、风险与回滚证据完整；未决 `OQ-` 不被静默忽略。
- [ ] 维护者确认后，才允许宣告 MVP 可交付或进入 Production 发布流程。

## 验证基线

| 范围 | 聚焦验证 | 完整验证 |
| --- | --- | --- |
| Java 后端 | `cd paimeng-ai-code-backend && ./mvnw -Dtest=ClassNameTest test` | `cd paimeng-ai-code-backend && ./mvnw verify` |
| TS Agent | `cd paimeng-ai-code-agent && npm run test -- test/path.test.ts` | `cd paimeng-ai-code-agent && npm run type-check && npm run test && npm run build` |
| Vue 前端 | `cd paimeng-ai-code-frontend && npm run type-check` | `cd paimeng-ai-code-frontend && npm run openapi2ts && npm run type-check && npm run build` |
| 基础设施 | 已决定后端的隔离环境验证 | `docker compose config` 或 D-02 决定的等价配置验证 |

`npm run lint` 和 `npm run format` 会写入前端文件；只有在相应任务明确需要时运行，并在运行后检查 diff。RAG 是 P4 范围，不安装、不启动、不作为本 MVP 验收的一部分。

## 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 未定义 Task/Run 转换、取消、失败或重新归一化 | 高 | D-06 先写入工程规格和 Issue #65；任务 1、5、8 只按已批准矩阵实现与测试。 |
| 未定义 Application 删除后的公开入口、证据链和数据处理 | 高 | D-07 已锁定逻辑归档：任务 2、3 按已批准的归档/停用公开入口语义实现授权成功、拒绝和后置行为；具体撤流机制仍等待 D-03。 |
| 在剩余 OQ 或 D-02 至 D-05 未解决时自行选择 Sandbox、域名、订阅、Snapshot 或执行后端行为 | 高 | 对应决策必须由维护者记录；相关任务在 `todo.md` 标注为阻塞。 |
| Run Context 在 D-02 前被错误冻结，或基线/能力在不同服务中被各自定义 | 高 | 任务 1 仅冻结 `TaskExecutionBaseline`；任务 4 只解析该基线；任务 5 在 D-02 后版本化 `ExecutionCapabilities`、组装复合 Run Context，并以跨服务夹具验证完整 Adapter 映射和不兼容版本拒绝。 |
| 订阅停服/恢复只在后端发生，Owner 无法读取状态 | 高 | 任务 11 同时交付状态 API、OpenAPI 类型、Vue 视图和四种状态的权限/手动验证。 |
| 将旧 `App`/`GenerationRun` 或 Pi Session 当作新 Platform 真相 | 高 | 任务 1、4、6 的测试要求可追溯领域状态与 Engine 状态分离。 |
| Sandbox 仅做路径校验，实际可访问宿主机或 Production | 高 | 任务 5 以越界文件/网络/凭据测试为验收，且在检查点 B 做独立安全审查。 |
| 验证结果与待发布源码不一致 | 高 | 任务 6、7 强制不可变 Snapshot 绑定、Evidence 引用和晋升门禁。 |
| 后续更新绕过 Owner 直接影响生产 | 高 | 任务 10 以未确认/无权限/失败回滚为核心验收。 |
| 计划任务跨越多个服务导致范围膨胀 | 中 | 每项限定为 S/M；共享契约先冻结，跨服务接线只在下游任务进行。 |
| 现有工作树含用户修改 | 中 | 实施前重新读取 `git status`，不覆盖无关规则、规格或未提交修改。 |

## 执行前检查

- [ ] D-02 至 D-04 已在开始对应受阻任务前由维护者决定并记录；D-05 已在任务 6 前记录；D-01、D-06、D-07 已写入工程规格与对应 Issue。
- [ ] 每个实施任务已由 `to-tickets` 建为独立 GitHub Issue，并使用原生依赖关系表达上游阻塞。
- [ ] 每个 Issue 保留本计划引用的 `R-`、`AC-`、`AD-`、`CST-`、`CT-` 与适用 `OQ-`。
- [ ] 任务执行前调用 `task-evidence-analysis`，并按项目规则记录目标、范围、验证、风险和回滚。
- [ ] 实施前检查当前 Git 状态，不覆盖用户现有未提交修改。
- [ ] 未经维护者复核，不因本计划存在而开始代码实现。

## 计划生成记录

- 最终状态：`revised; D-01/D-06/D-07 approved; remaining work blocked by applicable decisions and task dependencies`
- 任务类型：计划交付。
- 来源：维护者要求基于已发布的 MVP 工程规格输出至 `docs/tasks/`；后续审查指出 P1 状态机、P2 归一化时序、P3 Validation/晋升循环、P4 删除覆盖、P5 订阅 Product Layer 缺失、P6 Run Context/Lease 边界缺口，以及 P7 `CT-002` 的 Task 基线与 Sandbox 能力时序冲突。
- 改动范围：新增 `docs/tasks/plan.md` 与 `docs/tasks/todo.md`，并根据审查修订任务依赖、验收与检查点；不修改代码、不创建 GitHub 任务 Issue、不执行基础设施或生产操作。
- 实际验证：已检查计划包含 12 个实施任务、4 个检查点、7 个决策门，且覆盖 `R-001` 至 `R-007` 与 `SAC-001` 至 `SAC-003`；两份 Markdown 均通过空白错误检查和敏感信息赋值扫描。
- 审查结论：P2 至 P7 已在计划层消除；D-06 状态和 D-07 删除语义已由维护者决定并锁定，后续实施只能按对应契约执行。
- 未解决风险：D-02 至 D-04 必须在其对应受阻任务开始前由维护者决定，D-05 必须在任务 6 前记录；在此之前不得启动相关实现。
- 回滚：删除本次新增的 `docs/tasks/` 目录；不影响已发布的规格 Issue #65。
