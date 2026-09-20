# Owner 管理、删除与 Requirement 接收 API

## 目标（Goal）

交付 Owner/System Administrator 的 Application 创建、读取、删除及不可变 Requirement 接收 API。

## 上下文（Context）

Phase 1 只保存“等待归一化”的 Requirement；Task 创建、业务澄清、Sandbox 写入和 Agent 结论属于后续闭环。

## 范围（Scope）

实现 API、鉴权、错误返回、OpenAPI 契约及授权删除后的可观察行为。

## 约束（Constraints）

删除只能按 D-07 已批准语义实现；非 Owner/System Administrator 必须被拒绝；不得在本 Ticket 创建 Task 或 `blocked` 问题。

## 验收标准（Acceptance Criteria）

- [ ] Owner 可创建 Application、提交不可变 Requirement 并读取等待归一化状态。
- [ ] Owner/System Administrator 可按 D-07 删除；公开入口、关联事实与恢复边界可观察。
- [ ] Owner、管理员、普通用户和公众四种权限路径均有 Controller/Service 测试。
- [ ] `cd paimeng-ai-code-backend && ./mvnw -Dtest=*Platform*Test test` 与 `./mvnw verify` 通过。

## Blocked by

- [Application 删除与数据保留语义](07-application-deletion-retention.md)
- [Platform 核心领域、状态机与 TaskExecutionBaseline](08-platform-domain-task-baseline.md)

## Decomposition

`direct`

API、鉴权和 OpenAPI 属于同一 Product-to-Platform 契约边界。

## Required capabilities

- `explore`
- `implement`
- `verify`

## 备注（Notes）

关联：`R-001`、`R-002`、`AC-001` 至 `AC-004`、`CT-001`。

## 执行边界（Execution Boundary）

不包含 Vue 页面、归一化、Task 状态创建或 Agent Runtime。
