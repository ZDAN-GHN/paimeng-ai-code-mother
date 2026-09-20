# 公共 URL 与 TLS 最小策略决策

## 目标（Goal）

确定 Application URL 分配、DNS/TLS 所有权、URL 生命周期与健康检查失败后的行为。

## 上下文（Context）

首次 Release 与后续发布需要稳定、可验证的公开入口；当前规格将该项标为 `OQ-004`。

## 范围（Scope）

定义 URL 格式、TLS 终止位置、健康路由、失败与回滚的可观察行为。

## 约束（Constraints）

不得在本 Ticket 中部署服务、修改生产域名或引入未决定的域名管理能力。

## 验收标准（Acceptance Criteria）

- [ ] 维护者记录 URL 格式与生命周期。
- [ ] 维护者记录 TLS 终止位置和健康检查入口。
- [ ] 维护者记录健康失败和回滚后的公开可见行为。

## Blocked by

- 无

## Decomposition

`architectural`

需要明确外部接口和运营所有权。

## Required capabilities

- `research`
- `explore`
- `verify`

## 备注（Notes）

来源：`OQ-004`、`D-03`；阻塞 T-09、T-10。

## 执行边界（Execution Boundary）

该 Ticket 是维护者决策边界；不包含基础设施实施或生产操作。
