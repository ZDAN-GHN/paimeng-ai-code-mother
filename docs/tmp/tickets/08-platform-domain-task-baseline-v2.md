# Platform 核心领域、状态机与 TaskExecutionBaseline

> Version: v2；基于 `08-platform-domain-task-baseline.md`，统一 Application 根实体为既有 `app`。

## 目标（Goal）

在 Java Platform Domain 基于既有 `app` 建立 Application、Requirement、Task、Run 与 Trusted Profile 的权威持久模型、受控状态机及版本化 `TaskExecutionBaseline`。

## 上下文（Context）

Task 进入实施前必须冻结 `baseProfileVersion`、`baseSourceRevision`、`requestedOutcome`、`acceptanceTarget`。该基线是 `CT-002` 的 Platform 输入片段，不包含 Workspace、Sandbox Tool Contract 或 Execution Policy。

## 范围（Scope）

实现领域模型、迁移、Repository/Service、状态转换和基线序列化夹具。

## 约束（Constraints）

只按 D-06 的批准矩阵实现状态边；`app` 是唯一 Application 聚合根，Platform 从属表统一使用 `app.id` 归属；不得重新创建 `platform_application`，也不得实现 Lease、Sandbox 或完整 Run Context。

## 验收标准（Acceptance Criteria）

- [ ] 持久化对象完整关联 Application，Requirement 不可变。
- [ ] Application 的唯一持久化根为既有 `app`；Platform 不新增同义 Application 根表或实体。
- [ ] `TaskExecutionBaseline` 冻结四项字段且版本化；未知/缺失字段或变更冻结基线被拒绝。
- [ ] 状态机覆盖 D-06 的允许和关键非法边、取消请求与重新归一化。
- [ ] 输出供 T-04/T-05 使用的 Java-to-TS 基线契约夹具。
- [ ] `cd paimeng-ai-code-backend && ./mvnw test` 与 `./mvnw verify` 通过。

## Blocked by

- [Task 与 Run 状态转换矩阵](06-task-run-state-matrix.md)

## Decomposition

`decomposable`

领域迁移、状态机和契约夹具可由下游编排拆分，但必须在同一权威领域边界整合验证。

## Required capabilities

- `explore`
- `implement`
- `verify`

## 备注（Notes）

关联：`R-001`、`R-002`、`R-003`、`CT-001`、`CT-002`。实施前必须执行 `task-evidence-analysis`。

## 执行边界（Execution Boundary）

该 Ticket 不包含 Owner 产品界面、Sandbox、Lease 或完整 Run Context 的能力片段。
