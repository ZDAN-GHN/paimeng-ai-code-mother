# 权威 Validation、Migration Gate 与版本晋升

## 目标（Goal）

执行模板化权威验证和兼容 Migration Gate，并使通过验证成为唯一的 SourceRevision/Profile 晋升路径。

## 上下文（Context）

Agent 自检只是诊断。所有必需 Validation/Evidence 必须精确绑定一个 CandidateSourceSnapshot，且失败不得导致 `validated`、晋升或 Release。

## 范围（Scope）

实现工程、数据库、运行和任务验收验证，Migration 静态/执行前 Gate，以及验证成功后的原子版本晋升。

## 约束（Constraints）

禁止破坏性 Schema 演进；禁止非权威方写入验证通过状态；`uncertain` Profile 不得晋升。

## 验收标准（Acceptance Criteria）

- [ ] 必需验证失败阻止 `validated`、SourceRevision、Profile 晋升与 Release。
- [ ] 通过后只有 Platform 晋升路径创建 SourceRevision，并按 `profileDisposition` 处理 Profile。
- [ ] 删除、破坏性重命名、收紧约束、不可逆改写、无界 backfill 和停机迁移被拒绝。
- [ ] 验证覆盖失败 Evidence、Snapshot 错配、非权威写入、成功晋升和失败禁止晋升。
- [ ] 后端 `./mvnw verify`、模板验证命令与 Agent `npm run test` 通过。

## Blocked by

- [固定模板、ORM 与 Migration 工具决策](01-template-orm-migration-decision.md)
- [Sandbox 与 Deployment 执行后端决策](02-sandbox-deployment-decision.md)
- [Runtime 执行能力、Lease 与 Sandbox Tool Contract](12-runtime-lease-sandbox-contract.md)
- [Snapshot、Profile 处置与 Validation/Evidence 契约](13-snapshot-validation-evidence-contract.md)

## Decomposition

`decomposable`

验证 Gate、Migration Gate 和晋升可独立实施，但只能以同一不可变 Snapshot 证据链验收。

## Required capabilities

- `explore`
- `implement`
- `verify`

## 备注（Notes）

关联：`R-004`、`R-005`、`AC-012`、`AC-014` 至 `AC-018`、`CT-003`、`CT-004`。

## 执行边界（Execution Boundary）

不执行 Production Deployment；部署由 T-09 处理。
