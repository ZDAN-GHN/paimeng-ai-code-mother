# Application 删除与数据保留语义

## 目标（Goal）

确定 Application 删除的语义、权限、公开入口行为、证据和数据保留边界及恢复能力。

## 上下文（Context）

MVP 需要 Owner/System Administrator 删除 Application，但最终数据删除不在 MVP；当前行为与数据语义缺少决定。

## 范围（Scope）

决定逻辑归档/停止公开运行或物理删除，并定义 Application、Requirement、Task、Run、版本、Release、Deployment、数据库和公开 URL 的后置行为。

## 约束（Constraints）

不得把未批准的物理删除、恢复 UI 或数据治理能力纳入 MVP。

## 验收标准（Acceptance Criteria）

- [ ] 维护者记录删除方式、Owner/System Administrator 权限及非授权拒绝。
- [ ] 维护者记录公开入口、证据链、数据保留与恢复/不可恢复边界。
- [ ] 批准结果同步至工程规格和 Issue #65，并可直接转化为 T-02/T-03 验收。

## Blocked by

- 无

## Decomposition

`architectural`

这是影响权限、可见性和数据完整性的产品/架构契约。

## Required capabilities

- `research`
- `verify`

## 备注（Notes）

来源：审查 P4、`D-07`；阻塞 T-02、T-03。

## 执行边界（Execution Boundary）

该 Ticket 只定义删除语义；不修改 Application 数据或公开入口。
