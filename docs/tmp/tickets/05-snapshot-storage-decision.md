# Snapshot 物理存储选择

## 目标（Goal）

选择满足不可变性、可追溯和可恢复要求的 CandidateSourceSnapshot/SourceRevision 物理存储方案。

## 上下文（Context）

`CST-002` 约束稳定源码只能经受控路径晋升；当前 `OQ-002` 是受该约束限制的实现选择。

## 范围（Scope）

评估内部 Git commit、内容寻址对象存储或等价方案，记录选型及其不可变性、恢复和追溯证据。

## 约束（Constraints）

不得允许 Workspace、外部 Git、CI 或管理员路径直接写入稳定 SourceRevision。

## 验收标准（Acceptance Criteria）

- [ ] 维护者记录物理存储方案及其不可变性机制。
- [ ] 记录 Task 到 Snapshot 再到 SourceRevision 的可追溯与可恢复证据。
- [ ] 方案不绕过 `Task -> Run -> Workspace -> CandidateSourceSnapshot -> Validation -> SourceRevision`。

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

来源：`OQ-002`、`D-05`；阻塞 T-06。

## 执行边界（Execution Boundary）

该 Ticket 只产出选型记录；实际 Snapshot 持久化由 T-06 实现。
