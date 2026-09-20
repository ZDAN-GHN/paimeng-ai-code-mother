# 首次 Release、Deployment 与健康公开入口

## 目标（Goal）

为首次通过权威验证的版本自动创建固定 Release、执行 Platform 独占部署、健康检查和公开 URL。

## 上下文（Context）

发布控制器只能消费固定 SourceRevision/Profile/Validation 证据；Workspace 或 Agent Session 不得直接部署。

## 范围（Scope）

实现首次 Release、Deployment、健康检查、公开入口、失败状态和 Agent Production 权限拒绝。

## 约束（Constraints）

遵守 D-02/D-03；首次部署失败不得标记已上线；没有上一健康版本时保持未上线；不得泄露敏感配置。

## 验收标准（Acceptance Criteria）

- [ ] 首次 validated 版本自动创建固定 Release 并部署，健康通过后公开 URL 可用。
- [ ] Agent 无法访问生产密钥、数据库、构建、迁移、流量或回滚操作。
- [ ] 首次部署失败时不存在健康公开 URL，Application 对 Owner 显示为未上线；受控诊断不含敏感配置。
- [ ] 隔离非生产环境端到端验证首次发布、健康检查、公开 URL，以及失败后的未上线状态和受控诊断。
- [ ] `docker compose config` 或 D-02 等价检查，以及后端 `./mvnw verify` 通过。

## Blocked by

- [Sandbox 与 Deployment 执行后端决策](02-sandbox-deployment-decision.md)
- [公共 URL 与 TLS 最小策略决策](03-public-url-tls-decision.md)
- [Snapshot、Profile 处置与 Validation/Evidence 契约](13-snapshot-validation-evidence-contract.md)
- [权威 Validation、Migration Gate 与版本晋升](14-authoritative-validation-version-promotion.md)
- [Requirement 到受控 Run 的执行闭环](15-requirement-controlled-run-loop.md)

## Decomposition

`decomposable`

Release、部署控制与隔离环境验证可以拆分，但必须共同保证固定证据链。

## Required capabilities

- `explore`
- `implement`
- `verify`

## 备注（Notes）

关联：`R-006`、`AC-019`、`AC-022`、`CT-004`、`CT-005`。

## 执行边界（Execution Boundary）

不包含后续更新确认、订阅停服或 Production 试验性操作。
