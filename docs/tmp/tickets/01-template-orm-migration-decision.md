# 固定模板、ORM 与 Migration 工具决策

## 目标（Goal）

确定 MVP 唯一允许的 TypeScript 全栈模板、ORM、Migration 工具及可执行工程验证命令。

## 上下文（Context）

固定模板是工程验证、兼容 Migration Gate 与 Agent Runtime 的前置；当前规格将其标为 `OQ-001`，尚未作出选择。

## 范围（Scope）

比较可行组合，记录固定版本、许可证/维护状态、构建/测试/Migration 命令与兼容 Migration 能力。

## 约束（Constraints）

不得在本 Ticket 中实现模板、引入第二 Agent SDK 或扩大 MVP 功能范围。

## 验收标准（Acceptance Criteria）

- [ ] 维护者记录唯一组合及版本、许可证/维护状态。
- [ ] 记录可复现的构建、测试与 Migration 验证命令。
- [ ] 决策可解除 T-04、T-05、T-07 的模板选择阻塞。

## Blocked by

- 无

## Decomposition

`architectural`

需要比较工程兼容性和维护约束，但不包含实现。

## Required capabilities

- `research`
- `explore`
- `verify`

## 备注（Notes）

来源：`OQ-001`、`D-01`。

## 执行边界（Execution Boundary）

该 Ticket 是维护者决策边界；下游编排可收集证据，但不得替维护者选择方案。
