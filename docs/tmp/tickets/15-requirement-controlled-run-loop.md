# Requirement 到受控 Run 的执行闭环

## 目标（Goal）

将 Requirement 归一化、单一业务澄清、Task 基线、Run、Snapshot、Validation 和 Owner 可理解的 Product Layer 状态接入受控闭环。

## 上下文（Context）

Phase 1 接收的 Requirement 仅在此 Ticket 进入 Pi 归一化。只有 Platform 根据 T-07 权威 Validation 才能将 Task 转为 `validated`。

## 范围（Scope）

实现符合 D-06 的 `ready`/`executing`/`blocked`/`failed`/`validated` 状态投影、Owner 回答唯一阻断问题后重新归一化、Run 启动、Event 转发，以及 Owner 状态 API、OpenAPI 类型和 Vue/SSE 状态展示。

## 约束（Constraints）

不得在答复前启动 Sandbox 写入或版本晋升；Agent 文本完成不得替代 Platform Validation；不包含 Production Deployment。

## 验收标准（Acceptance Criteria）

- [ ] 明确 Requirement 经 Pi 归一化形成 `ready` Task，并在受控 Run 中产生可查询的 Run/Task、Snapshot 与 Validation 结果。
- [ ] Owner 仅通过 Product Layer 可看到其 Application 的 `ready`、`executing`、`blocked`、验证失败和验证成功状态；状态投影不暴露 Pi Session、工具细节、Sandbox 或生产信息。
- [ ] 决定性歧义形成 `blocked` Task 时，Owner 可看到唯一阻断问题并提交答复；答复仅沿 D-06 允许边重新归一化，在答复前不启动 Sandbox 写入或版本晋升。
- [ ] 非 Owner、非 System Administrator 不能读取同一 Application 的管理状态或提交阻断答复；状态 API 的前端类型由 OpenAPI 生成。
- [ ] 跨服务测试覆盖等待归一化、`ready`、`executing`、`blocked`、Validation 失败和成功路径，以及授权状态读取/答复拒绝。
- [ ] 后端 `./mvnw verify`、Agent `npm run type-check && npm run test && npm run build` 和前端 `npm run openapi2ts && npm run type-check && npm run build` 通过。

## Blocked by

- [Task 与 Run 状态转换矩阵](06-task-run-state-matrix.md)
- [Owner 管理、删除与 Requirement 接收 API](09-owner-requirement-api.md)
- [Owner 初始入口、删除与 Requirement 界面](10-owner-requirement-ui.md)
- [TS Agent Runtime 与 Pi Adapter 基线解析](11-pi-adapter-baseline-parser.md)
- [Runtime 执行能力、Lease 与 Sandbox Tool Contract](12-runtime-lease-sandbox-contract.md)
- [Snapshot、Profile 处置与 Validation/Evidence 契约](13-snapshot-validation-evidence-contract.md)
- [权威 Validation、Migration Gate 与版本晋升](14-authoritative-validation-version-promotion.md)

## Decomposition

`decomposable`

跨服务闭环可按归一化、状态投影和集成验证拆分，但必须只在稳定上游契约后整合。

## Required capabilities

- `explore`
- `implement`
- `verify`

## 备注（Notes）

关联：`R-002` 至 `R-005`、`AC-004` 至 `AC-018`、`CT-001`、`CT-002`、`CT-003`。

## 执行边界（Execution Boundary）

不包含 Production Release、Deployment 或订阅生命周期。
