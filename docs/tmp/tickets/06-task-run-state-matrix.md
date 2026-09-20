# Task 与 Run 状态转换矩阵

## 目标（Goal）

为 Task 与 Run 定义完整、可执行的状态转换矩阵和每条边的触发者、权限、前置条件与终态关系。

## 上下文（Context）

当前规格只定义主路径，未完整定义取消、失败、重试、阻断答复、重新归一化和 Lease 释放；这会阻止领域、Runtime 与闭环测试可靠实现。

## 范围（Scope）

定义状态集、允许与禁止的转换、取消/失败/重试、`blocked` 回答、Run 终态与 Lease 释放关系，并将批准结果写入工程规格与 Issue #65。

## 约束（Constraints）

不得由实现任务推断状态语义；不得将 Agent 的文本完成视为 Platform 的 `validated` 裁决。

## 验收标准（Acceptance Criteria）

- [ ] 矩阵覆盖 `created`、`ready`、`executing`、`blocked`、`failed`、`validated`、`released`、取消与 Run 终态。
- [ ] 每条允许边明确触发者、权限、前置条件与拒绝条件。
- [ ] 取消、Lease 释放、重新归一化和重试的关系可直接转化为状态机测试。
- [ ] 批准结果同步至 `docs/specs/mvp-engineering-spec.md` 和 Issue #65。

## Blocked by

- 无

## Decomposition

`architectural`

这是核心业务状态契约，必须先由维护者决定。

## Required capabilities

- `research`
- `explore`
- `verify`

## 备注（Notes）

来源：审查 P1、`D-06`；阻塞 T-01、T-02、T-03、T-05、T-08。

## 执行边界（Execution Boundary）

该 Ticket 定义状态契约，不实现状态机或 Lease。
