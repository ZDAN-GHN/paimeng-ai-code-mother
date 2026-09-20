# 后续发布确认、Production 状态与 Owner 可见性

## 目标（Goal）

使已上线 Application 的后续已验证版本在 Owner 明确确认前不影响 Production，并提供目标基线与健康 Deployment 的可见性。

## 上下文（Context）

首次版本可自动发布；后续版本必须由 Owner/System Administrator 确认。部署失败或回滚不得撤销已验证目标基线、Profile 或数据库。

## 范围（Scope）

实现待发布状态、Owner 更新摘要/可选预览、发布确认、权限拒绝、部署失败与回滚状态的 API 和前端接入。

## 约束（Constraints）

待发布不是新 Task 状态；未确认时公众访问的 Production 必须不变；前端类型必须通过 OpenAPI 生成。

## 验收标准（Acceptance Criteria）

- [ ] Owner 可见目标 SourceRevision/Profile 与当前健康 Deployment 的关系。
- [ ] 未确认时，公众可见内容和当前健康 Deployment 的 Release 引用保持不变，满足 `AC-020`。
- [ ] 仅 Owner/System Administrator 显式确认才创建并部署固定 Release；健康检查通过前不得表述为已上线，满足 `AC-021`。
- [ ] 部署失败或回滚后，上一健康 Deployment 保持或恢复；已验证目标 SourceRevision、Trusted Profile 与数据库不被撤销、反向迁移或改写，满足 `AC-022`。
- [ ] 隔离环境端到端验证确认前不变、确认后固定 Release 部署、失败/回滚后的健康 Deployment 与目标基线/数据库边界；无权限确认被拒绝。
- [ ] 后端测试覆盖上述授权和状态转换，前端 `npm run openapi2ts && npm run type-check && npm run build` 通过。

## Blocked by

- [Owner 初始入口、删除与 Requirement 界面](10-owner-requirement-ui.md)
- [Requirement 到受控 Run 的执行闭环](15-requirement-controlled-run-loop.md)
- [首次 Release、Deployment 与健康公开入口](16-first-release-deployment.md)

## Decomposition

`decomposable`

状态投影、确认授权和前端接入可拆分，但必须围绕同一 Production 不变性验收。

## Required capabilities

- `explore`
- `implement`
- `verify`

## 备注（Notes）

关联：`R-001`、`R-006`、`AC-020` 至 `AC-022`、`CT-005`。

## 执行边界（Execution Boundary）

不包含新的 Task 状态、订阅行为或重新生成源码。
