# Owner 初始入口、删除与 Requirement 界面

> Version: v2；基于 `10-owner-requirement-ui.md`，统一 Application 根实体为既有 `app`。

## 目标（Goal）

为 Owner 提供基于既有 `app.id` 创建 Application、提交 Requirement、查看等待归一化状态和执行已批准归档操作的 Vue 界面。

## 上下文（Context）

前端 API 类型必须由 OpenAPI 生成；该阶段不应向用户伪造 Task、Agent 结论或业务澄清问题。

## 范围（Scope）

接入 T-02 API，完成页面、路由、权限可见性和删除后的界面状态。

## 约束（Constraints）

不手写后端 DTO 类型；只按 D-07 语义展示归档行为；Application 仍使用既有 `app` 根，不得新增第二个应用根或隐式 ID 映射；不得引入归一化或执行能力。

## 验收标准（Acceptance Criteria）

- [ ] Owner 可创建 Application、提交 Requirement 并看到等待归一化状态。
- [ ] Owner/System Administrator 可执行 D-07 归档操作；归档后显示保留事实和不可恢复状态，非授权用户没有管理入口。
- [ ] 工作台、首页入口与旧 `/app` 链路使用同一个 `app.id`，不产生第二个 Application ID。
- [ ] 新增接口经 `npm run openapi2ts` 生成类型。
- [ ] `cd paimeng-ai-code-frontend && npm run type-check && npm run build` 通过。

## Blocked by

- [Owner 管理、删除与 Requirement 接收 API](09-owner-requirement-api-v2.md)

## Decomposition

`direct`

这是与既定 API 对应的窄 Owner Product Layer 垂直切片。

## Required capabilities

- `explore`
- `implement`
- `verify`

## 备注（Notes）

关联：`R-001`、`R-002`、`AC-001`、`AC-004`、`CT-001`。

## 执行边界（Execution Boundary）

不包含 Task 页面、阻断问题、Runtime 或发布界面。
