# Sandbox 与 Deployment 执行后端决策

## 目标（Goal）

确定 MVP 的 Sandbox/Deployment 执行后端及隔离、资源限制、清理和本地验证策略。

## 上下文（Context）

`CT-002` 的 Runtime 能力片段依赖实际 Sandbox。T-05 必须在该决策后生成 Workspace、Tool Contract 与 Execution Policy。

## 范围（Scope）

定义容器或执行后端、网络隔离、资源上限、日志收集、验证环境、Production Deployment 最小实现和清理策略。

## 约束（Constraints）

不得把路径校验视为隔离；不得授予 Agent Production、宿主机或凭据访问。

## 验收标准（Acceptance Criteria）

- [ ] 决策定义宿主机、其他 Workspace、Production 与凭据隔离。
- [ ] 决策定义资源限制、清理策略和可复现的本地验证入口。
- [ ] 决策可解除 T-05、T-07、T-09 的执行后端阻塞。

## Blocked by

- 无

## Decomposition

`architectural`

此 Ticket 确定安全与运行边界，不能由实施任务自行补全。

## Required capabilities

- `research`
- `explore`
- `verify`

## 备注（Notes）

来源：`OQ-003`、`D-02`。T-04 仅解析 TaskExecutionBaseline，不受本 Ticket 阻塞。

## 执行边界（Execution Boundary）

该 Ticket 是维护者决策边界；下游编排可收集证据，但不得替维护者选择执行后端。
