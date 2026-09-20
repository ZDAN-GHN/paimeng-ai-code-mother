# Runtime 执行能力、Lease 与 Sandbox Tool Contract

## 目标（Goal）

在 D-02 决定的隔离后端上，交付单写入 Run、Lease、Sandbox、版本化 `ExecutionCapabilities` 与完整 Run Context 组装。

## 上下文（Context）

Runtime 组合 T-01 的不可变 `TaskExecutionBaseline` 与 Runtime 生成的 Workspace、Sandbox Tool Contract、Execution Policy；不能改写 Task 基线 schema。

## 范围（Scope）

实现 Lease 获取/续租/释放、取消、Sandbox/Workspace 生命周期、幂等 Platform Request、Capability schema 版本和 Adapter 完整映射测试。

## 约束（Constraints）

按 D-06 状态矩阵处理取消/终态；实际隔离必须拒绝宿主机、其他 Workspace、Production 网络和凭据访问。

## 验收标准（Acceptance Criteria）

- [ ] 同一 Application 的并发写入 Run 被 Lease 拒绝；取消释放 Lease 并清理 Sandbox。
- [ ] Runtime 仅在 D-02 后端上生成 `ExecutionCapabilities`，并拒绝未知/缺失/不兼容 baseline-capability 组合。
- [ ] 重启接管只在 Lease、Sandbox、Workspace 与外部请求状态可确认时发生；副作用使用幂等键。
- [ ] 跨服务夹具验证完整 Run Context 和 T-04 Adapter 映射；Sandbox 越界访问被集成测试拒绝。
- [ ] Java `./mvnw verify` 与 Agent `npm run type-check && npm run test && npm run build` 通过。

## Blocked by

- [Sandbox 与 Deployment 执行后端决策](02-sandbox-deployment-decision.md)
- [Task 与 Run 状态转换矩阵](06-task-run-state-matrix.md)
- [Platform 核心领域、状态机与 TaskExecutionBaseline](08-platform-domain-task-baseline.md)
- [TS Agent Runtime 与 Pi Adapter 基线解析](11-pi-adapter-baseline-parser.md)

## Decomposition

`decomposable`

Lease、隔离后端和跨服务契约可拆分，但必须由同一 Runtime 集成验证。

## Required capabilities

- `explore`
- `implement`
- `verify`

## 备注（Notes）

关联：`R-003`、`AC-007` 至 `AC-010`、`CT-002`。

## 执行边界（Execution Boundary）

不实现 Snapshot、Validation、SourceRevision 晋升或 Production Deployment。
