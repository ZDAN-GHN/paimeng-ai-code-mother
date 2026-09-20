# MVP 实施任务清单（待 `to-tickets` 发布）

- 来源：[实施计划](mvp-plan.md)、[MVP 工程规格](../specs/mvp-engineering-spec.md)、[GitHub Issue #65](https://github.com/ZDAN-GHN/paimeng-ai-code-mother/issues/65)
- 当前状态：`published; blocked`。决策 Issue #66 至 #72 与实施/验收 Issue #73 至 #84 已发布为 #65 的原生子 Issue；D-06 和 D-07 是 Task/Run 状态机与 Application 删除的核心业务契约，在维护者决定并同步工程规格前阻塞相应实施。
- 追踪说明：此文件是维护者要求保存在 `docs/tasks/` 的本地 Ticket Graph 快照。GitHub Issue #65 的子 Issue 与原生依赖关系是执行时的权威图；本文件不得被用来覆盖 GitHub blocker 状态。

## Phase 0：决策门

- [ ] D-01：决定固定 TypeScript 全栈模板、ORM、Migration 工具与验证命令（`OQ-001`）。
- [ ] D-02：决定 Sandbox 与 Deployment 执行后端及隔离策略（`OQ-003`）。
- [ ] D-03：决定公共 URL、域名与 TLS 最小策略（`OQ-004`）。
- [ ] D-04：决定订阅宽限、通知、事件来源与最终保留策略（`OQ-005`）。
- [ ] D-05：在 Task 6 前记录 Snapshot/SourceRevision 物理存储选择（`OQ-002`）。
- [ ] D-06：决定并将 Task/Run 状态转换矩阵写入工程规格与 Issue #65，包括取消、失败、阻断答复、重试和 Lease 释放（审查 P1）。
- [ ] D-07：决定并将 Application 删除、公开入口、关联事实/数据保留与恢复语义写入工程规格与 Issue #65（审查 P4）。

## Phase 1：领域与 Owner 入口

- [ ] T-01：Platform 核心领域、状态机与版本化 `TaskExecutionBaseline`。依赖：D-06；由 Platform 冻结 `baseProfileVersion`、`baseSourceRevision`、`requestedOutcome`、`acceptanceTarget`，并提供 Java-to-TS 基线契约夹具。它不定义 Workspace、Sandbox Tool Contract、Execution Policy 或完整 Run Context。实施前需按项目流程完成 `task-evidence-analysis`。规格：`R-001`、`R-002`、`R-003`。
- [ ] T-02：Owner 管理、删除与 Requirement 接收 API 契约。依赖：D-07、T-01。Phase 1 只保存“等待归一化”的 Requirement，不创建 Task 或 `blocked` 问题。规格：`R-001`、`R-002`。
- [ ] T-03：Owner 初始 Application、删除与 Requirement 接收界面。依赖：D-07、T-02。规格：`R-001`、`R-002`。

## 检查点 A：领域与 Owner 入口

- [ ] Java 和 Vue 聚焦/完整验证通过。
- [ ] 人工走通创建 Application、提交 Requirement、等待归一化，以及 D-07 定义的删除后状态；确认未在 Pi Runtime 前伪造 Task 或业务澄清。
- [ ] 维护者审查 API 契约和旧领域模型隔离。

## Phase 2：Run、Sandbox 与版本安全

- [ ] T-04：TS Agent Runtime 与 Pi Adapter 基线解析。依赖：D-01、T-01。Adapter 只解析 T-01 的版本化 `TaskExecutionBaseline`，以夹具验证兼容/拒绝未知版本；不依赖 D-02，不映射 Sandbox 能力，也不管理 Lease 或 Sandbox。规格：`R-003`。
- [ ] T-05：Runtime 执行能力、单写入 Run、Lease 与 Sandbox Tool Contract。依赖：D-02、D-06、T-01、T-04。定义并版本化 `ExecutionCapabilities`（Workspace、Tool Contract、Execution Policy），组装复合 Run Context，验证完整 Adapter 映射；负责 Lease 获取/续租/释放和 Sandbox 清理，不得改写 Task 基线 schema。规格：`R-003`。
- [ ] T-06：Snapshot、Profile 处置与 Validation/Evidence 持久契约。依赖：D-05、T-01、T-05。此任务不创建 SourceRevision。规格：`R-004`。

## 检查点 B：执行与版本安全

- [ ] Java/TS 验证通过：T-01 仅冻结 `TaskExecutionBaseline`，T-04 仅解析该基线，T-05 在 D-02 后定义版本化 `ExecutionCapabilities`、组装复合 Run Context 并验证完整 Adapter 映射；不兼容版本必须拒绝。Sandbox 越界、Lease、幂等、封闭源码路径和非权威方不能伪造 Validation 成功均有证据；T-06 不存在 SourceRevision 晋升入口。
- [ ] 独立安全审查确认仅 Pi SDK 作为 Agent Engine，Pi Session 不是领域真相。
- [ ] 维护者审查 Snapshot 物理实现和 Profile 处置规则。

## Phase 3：验证与发布闭环

- [ ] T-07：权威 Validation、兼容 Migration Gate 与版本晋升。依赖：D-01、D-02、T-05、T-06。规格：`R-004`、`R-005`。
- [ ] T-08：Requirement 到受控 Run 的执行闭环与 Owner 进度状态。依赖：D-06、T-02 至 T-07。形成 `ready`/`blocked` Task 并按矩阵重新归一化；交付 Owner 对 `ready`、`executing`、`blocked`、验证失败/成功的 API/OpenAPI/Vue/SSE 状态展示、唯一阻断问题答复入口与权限验证。规格：`R-002`、`R-003`、`R-004`、`R-005`。
- [ ] T-09：首次 Release、Deployment、健康公开入口与失败未上线状态。依赖：D-02、D-03、T-06 至 T-08。隔离验证必须证明失败时无健康公开 URL、Owner 显示未上线且诊断脱敏。规格：`R-006`。
- [ ] T-10：后续发布确认、Production 状态与 Owner 可见性。依赖：T-03、T-08、T-09。隔离验证确认前 Production/健康 Deployment 不变，确认后部署固定 Release，失败/回滚不撤销目标基线/Profile/数据库。规格：`R-001`、`R-006`。

## 检查点 C：首次托管与受控更新

- [ ] 首次自动发布、首次失败未上线、后续待确认发布、确认发布、健康失败和回滚在隔离环境均有证据；确认前 Production 与健康 Deployment 引用不变，SourceRevision 只能在任务 7 的权威 Validation 成功后创建。
- [ ] Release/Deployment 证据链不能由 Workspace、Agent Session 或外部 Git 绕过。
- [ ] 维护者审查公开 URL、TLS、健康检查和失败回滚。

## Phase 4：订阅与交付加固

- [ ] T-11：订阅生命周期、状态 API 与 Owner 可见性。依赖：D-04、T-09、T-10。交付有效运行、宽限、已停服、已恢复四种 Owner 状态的 API/OpenAPI/Vue 视图与权限验证。规格：`R-007`。
- [ ] T-12：跨服务验收、运行安全与交付文档。依赖：T-01 至 T-11。规格：`SAC-001` 至 `SAC-003`。

## 检查点 D：MVP 交付评审

- [ ] `AC-001` 至 `AC-025` 和 `SAC-001` 至 `SAC-003` 均有实际验证证据；其中包含 Owner 对 Requirement `ready`、`executing`、`blocked`、验证失败/成功及订阅四种状态的前端可见性与权限证据。
- [ ] 已完成 `$code-review`；TS Agent 代码已完成 `$clean-code-reviewer`。
- [ ] Issue #65 交付记录、风险、回滚和 GitHub Issue 验收复选框已逐项更新。
- [ ] 维护者确认可交付后，才允许进入 Production 发布流程。
