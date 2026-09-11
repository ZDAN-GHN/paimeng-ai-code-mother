# 派蒙 AI 应用工坊 — 项目上下文

> 本文只记录项目领域术语、既有 Java 分层和核心产品对象。三服务拓扑、鉴权、生成链路、计费、RAG 与退役状态以 [docs/ts_agent/architecture.md](docs/ts_agent/architecture.md) 为唯一权威。

## 一句话定位

基于 AI 的零代码应用生成平台：用户通过自然语言描述需求，平台生成前端代码并提供预览、部署和可视化编辑能力。

## 核心领域概念

| 术语 | 含义 | 对应实体 |
| --- | --- | --- |
| 应用 (App) | 用户创建的零代码应用，包含 prompt、代码生成类型、部署信息 | `App` |
| 代码生成类型 (CodeGenType) | 决定 AI 如何生成代码的策略路由标识 | `App.codeGenType` |
| 部署标识 (DeployKey) | 应用部署后的唯一访问路径 | `App.deployKey` |
| 对话历史 (ChatHistory) | 用户与 AI 的对话记录，支持流式消息 | `ChatHistory` |
| 可视化编辑器 | 前端拖拽式页面编辑器，操作应用生成的代码 | `visualEditor.ts` |
| 生成运行 (GenerationRun) | 一次代码生成的状态机锚（phase/context/milestones/token 计量），计费与退款按 runId 幂等 | `GenerationRun` |
| 积分台账 (CreditLedger) | 冻结、结算、退款三态记账，余额驱动日配额 | `CreditLedger` |

## 既有 Java 分层

```text
controller/              REST 接口、参数校验和权限拦截
service/                 业务逻辑和事务管理
ai/agent/                TS Agent 的 JWT 签发与配置
ai/codegen/route/        createApp 代码生成类型路由
config/ + aop/           权限 AOP、CORS、JSON 序列化和 Redis 配置
mapper/ + model/         MyBatis Flex、实体、DTO、VO 和枚举
```

Java 承担业务 REST、鉴权、积分、聊天历史、构建和部署；TS Agent 承担生成工作流；Python RAG 是 P4 检索服务。服务边界、调用方向及禁令见 [目标架构设计](docs/ts_agent/architecture.md)。

`paimeng-ai-code-mother-microservice/` 是废弃的微服务重构尝试，不作为任何实现或迁移前提。

## 前端页面结构

| 页面 | 路径 | 说明 |
| --- | --- | --- |
| 首页 | `HomePage.vue` | 精选应用展示 |
| 应用对话 | `AppChatPage.vue` | AI 对话和代码生成 |
| 应用编辑 | `AppEditPage.vue` | 可视化编辑器 |
| 应用管理 | `AppManagePage.vue` | 后台管理 |
| 用户管理 | `UserManagePage.vue` | 后台管理 |
| 对话管理 | `ChatManagePage.vue` | 后台管理 |
| 登录/注册 | `UserLoginPage.vue` / `UserRegisterPage.vue` | 用户认证 |

## 数据库核心表

- `user`：用户、积分余额和身份信息。
- `app`：应用、代码生成类型和部署信息。
- `chat_history`：对话历史，复合索引支持游标分页。
- `generation_run`：生成运行状态、里程碑、上下文和 token 计量。
- `credit_ledger`：积分冻结、结算与退款的幂等台账。
