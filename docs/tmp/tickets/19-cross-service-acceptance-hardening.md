# 跨服务验收、运行安全与交付文档

## 目标（Goal）

对已实现 MVP 执行跨服务契约、权限、隔离、版本追溯、发布、订阅恢复和失败路径验收，并补齐运行与最小回滚文档。

## 上下文（Context）

该 Ticket 是最终集成节点，验证 `SAC-001` 至 `SAC-003`，不引入 Future 能力。

## 范围（Scope）

运行 Java、TS Agent、Vue 的完整验证，执行隔离环境跨服务验收，补齐运行说明、故障处理、最小回滚 Runbook 和 Issue #65 证据关联。

## 约束（Constraints）

审查输出必须脱敏；不得把未决 `OQ-` 静默视为已解决；不得执行 Production 试验性操作。

## 验收标准（Acceptance Criteria）

- [ ] Owner 创建到首次健康公开 URL 的证据链满足 `SAC-001`。
- [ ] 后续未确认更新不改变 Production，确认失败保留/恢复上一健康版本，满足 `SAC-002`。
- [ ] 宽限停服保留事实和数据、续费恢复上一健康 Release，且 Owner 可读取四种订阅状态，满足 `SAC-003`。
- [ ] 完整 Java、TS Agent、Vue 验证、`$code-review` 与 TS Agent `$clean-code-reviewer` 结果均被记录。

## Blocked by

- [Platform 核心领域、状态机与 TaskExecutionBaseline](08-platform-domain-task-baseline.md)
- [Owner 管理、删除与 Requirement 接收 API](09-owner-requirement-api.md)
- [Owner 初始入口、删除与 Requirement 界面](10-owner-requirement-ui.md)
- [TS Agent Runtime 与 Pi Adapter 基线解析](11-pi-adapter-baseline-parser.md)
- [Runtime 执行能力、Lease 与 Sandbox Tool Contract](12-runtime-lease-sandbox-contract.md)
- [Snapshot、Profile 处置与 Validation/Evidence 契约](13-snapshot-validation-evidence-contract.md)
- [权威 Validation、Migration Gate 与版本晋升](14-authoritative-validation-version-promotion.md)
- [Requirement 到受控 Run 的执行闭环](15-requirement-controlled-run-loop.md)
- [首次 Release、Deployment 与健康公开入口](16-first-release-deployment.md)
- [后续发布确认、Production 状态与 Owner 可见性](17-subsequent-release-confirmation.md)
- [订阅生命周期、状态 API 与 Owner 可见性](18-subscription-lifecycle-owner-visibility.md)

## Decomposition

`decomposable`

可按服务验证与端到端证据收集拆分；只有最终集成节点承诺全链路绿色。

## Required capabilities

- `explore`
- `verify`

## 备注（Notes）

关联：`SAC-001` 至 `SAC-003`、`CST-001` 至 `CST-011`。

## 执行边界（Execution Boundary）

只验证和加固已批准范围，不实现 Future 能力或发布 GitHub Issue。
