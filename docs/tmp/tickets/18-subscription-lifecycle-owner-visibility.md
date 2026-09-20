# 订阅生命周期、状态 API 与 Owner 可见性

## 目标（Goal）

实现订阅驱动的公开运行、宽限、停服和恢复，并让 Owner/System Administrator 通过 API、OpenAPI 和 Vue 界面读取四种状态。

## 上下文（Context）

停服只改变公开运行可用性，必须保留 Application、Profile、版本、数据库、日志和记录；续费只恢复上一健康 Release。

## 范围（Scope）

实现订阅事件、宽限、停止公开 Deployment、恢复、状态 API、OpenAPI 类型、Vue 状态视图和权限验证。

## 约束（Constraints）

不得暴露计费提供商凭据、内部 Deployment 诊断或其他 Application 状态；不实现退款、最终数据删除、复杂计费或订阅自助管理。

## 验收标准（Acceptance Criteria）

- [ ] Owner 可见有效运行、宽限、已停服和已恢复状态及公开可用性。
- [ ] 非授权主体无法读取管理状态；停服后事实、数据和版本引用仍可查询。
- [ ] 续费事件幂等，仅恢复上一健康 Release，不改写源码或 Profile。
- [ ] 后端权限测试、前端 `npm run openapi2ts && npm run type-check && npm run build` 和隔离环境手动验证通过。

## Blocked by

- [订阅运营参数与外部接入范围决策](04-subscription-operations-decision.md)
- [首次 Release、Deployment 与健康公开入口](16-first-release-deployment.md)
- [后续发布确认、Production 状态与 Owner 可见性](17-subsequent-release-confirmation.md)

## Decomposition

`decomposable`

事件处理、状态投影和 Owner Product Layer 可拆分，但需共享同一生命周期状态模型。

## Required capabilities

- `explore`
- `implement`
- `verify`

## 备注（Notes）

关联：`R-007`、`AC-023` 至 `AC-025`、`CT-005`。

## 执行边界（Execution Boundary）

不包含支付、退款、最终数据删除或订阅自助管理。
