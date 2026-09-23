# Snapshot 物理存储选择

> Version: v2；基于 `05-snapshot-storage-decision.md`，固化 Git-backed immutable Snapshot 方案。

## 目标（Goal）

选择满足不可变性、可追溯和可恢复要求的 CandidateSourceSnapshot/SourceRevision 物理存储方案。

## 上下文（Context）

`CST-002` 约束稳定源码只能经受控路径晋升；`OQ-002` 已由本版本决策收敛为 Platform 私有 Git 仓库方案。

源码链路为：

```text
SourceRevision
    -> isolated Workspace / Git worktree
    -> CandidateSourceSnapshot / Candidate commit
    -> Validation
    -> SourceRevision
```

Workspace 或 worktree 是临时、可变工作载体；Candidate commit 才是冻结的源码版本事实。

## 决策（Decision）

MVP 使用**每个 Application 一个 Platform 私有 Git 仓库**作为 Snapshot/SourceRevision 的物理存储。仓库位于 Platform 控制的持久存储卷中，由 Platform Executor 独占写入。

每次 Run 从当前 `SourceRevision` 创建隔离 Workspace 或 Git worktree。Run 完成候选源码后，Platform 重新读取并审计 Workspace 文件树，由 Platform 创建 Candidate commit。Agent 自己创建的 commit、branch 或 tag 不构成可信的 Snapshot 或 SourceRevision。

`CandidateSourceSnapshot` 至少记录：

- `applicationId`、`taskId`、`runId`
- `baseSourceRevision`
- `commitHash`
- `treeHash` 或等价的 `contentDigest`
- `profileDisposition`
- 创建时间及不可变状态

`commitHash` 用于 Git 历史、恢复和 `git diff`；`treeHash/contentDigest` 用于证明实际源码树内容。验证成功后，SourceRevision 直接引用 Candidate commit，不复制物理源码。

## 不可变性与写入边界

- Candidate commit 使用完整 commit hash，不使用可移动的 branch、tag 或 `latest` 指针作为版本身份。
- Candidate commit 只能由 Platform 的 Snapshot/Validation 成功路径创建或晋升。
- Agent、Workspace、外部 Git、CI、管理员 API 和 Deployment 不能直接写入稳定 SourceRevision。
- Platform 在冻结时校验路径、符号链接、文件权限、忽略文件和外部引用；不信任 Workspace 中的 `.git`、hooks、remote、submodule 或外部 LFS 来源。
- 仍被数据库或 Release 引用的 commit 不得被删除或因 Git GC 丢失；读取或恢复时重新校验 commit/tree 内容。
- 初始 Application 源码也必须通过 Platform 受控导入形成初始 SourceRevision，不直接复用宿主机工作树的 `.git`。

## 并发与合并边界

MVP 同一 Application 同时只允许一个写入型 Run。Candidate 必须声明创建时的 `baseSourceRevision`；如果稳定版本已前进，Candidate 标记为 stale，不自动 merge 或 rebase，要求基于最新 SourceRevision 创建新 Run。

MVP 不提供外部 Git push、webhook、CI 写回、管理员绕过验证、并发分支自动 merge 或冲突自动解决。未来若引入受控 merge，仍必须经过新的 Candidate -> Validation -> SourceRevision 链路。

## 范围（Scope）

本 Ticket 固化内部 Git 存储、Candidate commit、SourceRevision 引用和恢复/比较边界；实际仓库、Workspace/worktree、快照冻结、Validation 绑定和权限实现由 T-06 及其后续任务完成。

## 约束（Constraints）

不得允许 Workspace、外部 Git、CI 或管理员路径直接写入稳定 SourceRevision。

## 验收标准（Acceptance Criteria）

- [x] 维护者记录 Platform 私有 Git 仓库方案、Candidate commit 身份及其不可变性机制。
- [x] 记录 Task 到 Snapshot 再到 SourceRevision 的可追溯、可比较与可恢复证据。
- [x] 方案不绕过 `Task -> Run -> Workspace -> CandidateSourceSnapshot -> Validation -> SourceRevision`。
- [x] 方案明确 Agent commit 不构成可信版本，且不提供 MVP 并发自动 merge 或外部 Git 写回。

## Blocked by

- 无

## Decomposition

`architectural`

这是受固定领域约束限制的实现架构选择。

## Required capabilities

- `research`
- `explore`
- `verify`

## 备注（Notes）

来源：`OQ-002`、`D-05`；本 v2 决策解除 T-06 的 Snapshot 物理存储选择阻塞。

## 执行边界（Execution Boundary）

该 Ticket 只产出选型记录；实际 Snapshot 持久化由 T-06 实现。
