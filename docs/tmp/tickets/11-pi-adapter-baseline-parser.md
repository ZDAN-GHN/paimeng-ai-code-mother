# TS Agent Runtime 与 Pi Adapter 基线解析

## 目标（Goal）

建立可复现的 TypeScript Agent 服务和 Pi Adapter，仅解析版本化 `TaskExecutionBaseline` 并归一化 Run Event。

## 上下文（Context）

T-01 是 Platform 基线权威；D-02 前不能假设 Workspace、Sandbox Tool Contract 或 Execution Policy。完整复合 Run Context 映射由 T-05 完成。

## 范围（Scope）

建立 Node/TypeScript 基线、Pi SDK Adapter、统一 Run Event、基线解析及契约拒绝测试。

## 约束（Constraints）

Pi SDK 是唯一 Agent Engine；不得引入 Vercel AI SDK、LangChain 或第二个 Agent SDK；不得获得 Production、宿主机、数据库、Sandbox 或 Lease 能力。

## 验收标准（Acceptance Criteria）

- [ ] 依赖锁文件、启动、类型检查、测试和构建可复现。
- [ ] Adapter 接受当前版本 `TaskExecutionBaseline`，拒绝未知版本或缺失字段，并归一化 Event。
- [ ] Java-to-TS 契约测试使用 T-01 夹具通过。
- [ ] `cd paimeng-ai-code-agent && npm run type-check && npm run test && npm run build` 通过。

## Blocked by

- [固定模板、ORM 与 Migration 工具决策](01-template-orm-migration-decision.md)
- [Platform 核心领域、状态机与 TaskExecutionBaseline](08-platform-domain-task-baseline.md)

## Decomposition

`direct`

只处理稳定基线解析和 Engine 适配，不包含执行后端能力。

## Required capabilities

- `explore`
- `implement`
- `verify`

## 备注（Notes）

关联：`R-003`、`CT-002`。不依赖 D-02。

## 执行边界（Execution Boundary）

不组装完整 Run Context，不定义 ExecutionCapabilities，不实现 Lease/Sandbox。
