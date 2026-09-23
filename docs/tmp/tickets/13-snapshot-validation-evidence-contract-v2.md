# Snapshot、Profile 处置与 Validation/Evidence 契约

> Version: v2；基于 `13-snapshot-validation-evidence-contract.md`，消费已批准的 Git-backed immutable Snapshot 决策。

## 目标（Goal）

实现不可变 CandidateSourceSnapshot、Candidate Profile Diff、`profileDisposition` 和受限的 Validation/Evidence 持久契约。

## 上下文（Context）

可写 Workspace 不能作为 Validation 或 Release 输入。T-06 只提供验证输入与不可伪造的记录边界，版本晋升由 T-07 负责。Snapshot 物理存储采用每个 Application 一个 Platform 私有 Git 仓库；Platform 创建 Candidate commit，Validation 通过后直接引用该 commit 作为 SourceRevision。

## 范围（Scope）

冻结 Workspace、恢复 Snapshot、记录 Profile 处置、绑定 Snapshot 的 Validation/Evidence 和 Platform 独占写入边界。

## 约束（Constraints）

`changed` 需要 Diff、Requirement 与理由；`unchanged` 需要理由；`uncertain` 不能验证成功或晋升；不得创建 SourceRevision。Agent commit、Workspace、外部 Git/CI 和管理员 API 不能成为可信 Snapshot 或稳定版本写入路径。

## 验收标准（Acceptance Criteria）

- [ ] Snapshot 不可变、可恢复并引用 Task/Run/基线。
- [ ] 非法 `profileDisposition` 和 Snapshot/Validation 错配被拒绝。
- [ ] 只有内部 Validation Write Contract 能记录结果；Agent、Workspace、外部 Git/CI、管理员 API 不能伪造通过状态或创建 SourceRevision。
- [ ] Java/TS 集成验证和后端 `./mvnw verify`、Agent `npm run test` 通过。

## Blocked by

- [Platform 核心领域、状态机与 TaskExecutionBaseline](08-platform-domain-task-baseline-v2.md)
- [Runtime 执行能力、Lease 与 Sandbox Tool Contract](12-runtime-lease-sandbox-contract.md)

## Decomposition

`decomposable`

存储、Profile 处置和写入授权可拆分，但必须在同一不可变引用链中验收。

## Required capabilities

- `explore`
- `implement`
- `verify`

## 备注（Notes）

关联：`R-004`、`AC-011`、`AC-013`、`CT-003`。Snapshot 物理存储选择已在 D-05/#70 决定；本 Ticket 不再被该决策阻塞。

## 执行边界（Execution Boundary）

不执行权威 Validation，不创建 SourceRevision 或 Trusted Profile Version。
