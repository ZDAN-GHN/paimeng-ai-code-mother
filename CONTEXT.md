# 派蒙 AI 应用工坊 — 项目上下文

## 一句话定位

基于 AI 的零代码应用生成平台：用户通过自然语言描述需求，AI 自动生成前端代码并可视化预览、部署。

## 核心领域概念

| 术语 | 含义 | 对应实体 |
|------|------|----------|
| 应用 (App) | 用户创建的零代码应用，包含 prompt、代码生成类型、部署信息 | `App` |
| 代码生成类型 (CodeGenType) | 决定 AI 如何生成代码的策略路由标识 | `App.codeGenType` |
| 部署标识 (DeployKey) | 应用部署后的唯一访问路径 | `App.deployKey` |
| 对话历史 (ChatHistory) | 用户与 AI 的对话记录，支持流式消息 | `ChatHistory` |
| 可视化编辑器 | 前端拖拽式页面编辑器，操作应用生成的代码 | `visualEditor.ts` |
| 生成运行 (GenerationRun) | 一次代码生成的状态机锚（phase/context/milestones/token 计量），计费与退款按 runId 幂等 | `GenerationRun` |
| 积分台账 (CreditLedger) | 冻结→结算/退款三态记账，余额驱动日配额 | `CreditLedger` |

## 架构分层

```
┌─────────────────────────────────────────────────────┐
│  前端 (paimeng-ai-code-mother-frontend)             │
│  Vue 3 + TypeScript + Ant Design Vue + Pinia        │
├─────────────────────────────────────────────────────┤
│  Controller 层 (controller/)                        │
│  RESTful 接口，参数校验，权限拦截                     │
├─────────────────────────────────────────────────────┤
│  Service 层 (service/)                              │
│  业务逻辑，事务管理                                   │
├─────────────────────────────────────────────────────┤
│  AI 层 (ai/agent/ + ai/codegen/route/)              │
│  JWT 签发 + ts-agent 配置 + createApp 类型路由       │
│  （生成工作流在 TS Agent，Java 不承载生成链路）       │
├─────────────────────────────────────────────────────┤
│  基础设施 (config/ + aop/ + annotation/)            │
│  权限 AOP、CORS、JSON 序列化、Redis 配置              │
├─────────────────────────────────────────────────────┤
│  数据层 (mapper/ + model/)                          │
│  MyBatis Flex ORM + 实体/DTO/VO/枚举                 │
├─────────────────────────────────────────────────────┤
│  MySQL + Redis                                      │
└─────────────────────────────────────────────────────┘
```

## 架构方向（2026-09-03 定稿）

**目标架构为三服务**（权威设计见 `docs/ts_agent/architecture.md`）：
- **Java**（`src/`）：业务 REST、鉴权（签发 JWT）、充值/积分/会员、聊天历史、构建与部署
- **TS Agent**（`paimeng-ai-code-agent/`，Node + Fastify + Vercel AI SDK + XState v5）：需求访谈、线框、代码生成工作流，fetch-SSE 直连浏览器
- **Python RAG**（`paimeng-ai-code-rag/`，P4 实施）：检索服务（day-1 few-shot 直查，v2 pgvector）

退役状态（2026-09-08，#14 收官）：旧 Java AI 链路与 Python 中转链已按 T21 删除，TS Agent 直连链路为唯一生成实现；`ts-agent.enabled` 门禁 JWT 签发（关闭→40410 明确报错），回退手段为 git 回滚。Python Agent 已定稿退役，目录已整体重命名为 `paimeng-ai-code-rag/`（RAG 骨架复用起点，退役代码 P4 精简，目录删除门槛为 P4）；TS Agent 落位 `paimeng-ai-code-agent/`（目录名复用）。

`paimeng-ai-code-mother-microservice/` 为**废弃的**微服务重构尝试（不作为任何迁移前提），包含 7 个模块：

| 模块 | 职责 |
|------|------|
| `paimeng-ai-code-common` | 公共工具、异常、常量 |
| `paimeng-ai-code-model` | 实体类、DTO、VO、枚举 |
| `paimeng-ai-code-client` | Feign 客户端接口 |
| `paimeng-ai-code-user` | 用户相关服务和接口 |
| `paimeng-ai-code-app` | 应用管理服务和接口 |
| `paimeng-ai-code-ai` | AI 代码生成核心逻辑 |
| `paimeng-ai-code-screenshot` | 截图服务 |

## 关键技术决策

1. **AI 架构**：生成工作流在 TS Agent（Node + Vercel AI SDK + XState v5，fetch-SSE 直连浏览器）；Java 侧保留 createApp 类型路由（LangChain4j，`ai/codegen/route/`）与 JWT 签发
2. **ORM 选型**：MyBatis Flex（轻量、支持代码生成）
3. **权限模型**：基于自定义 `@AuthCheck` 注解 + AOP 拦截，非 Spring Security
4. **流式响应**：SSE（Server-Sent Events）推送 AI 生成过程
5. **限流**：Redisson 分布式令牌桶，支持用户级/IP级/接口级

## 前端页面结构

| 页面 | 路径 | 说明 |
|------|------|------|
| 首页 | `HomePage.vue` | 精选应用展示 |
| 应用对话 | `AppChatPage.vue` | AI 对话 + 代码生成 |
| 应用编辑 | `AppEditPage.vue` | 可视化编辑器 |
| 应用管理 | `AppManagePage.vue` | 后台管理 |
| 用户管理 | `UserManagePage.vue` | 后台管理 |
| 对话管理 | `ChatManagePage.vue` | 后台管理 |
| 登录/注册 | `UserLoginPage.vue` / `UserRegisterPage.vue` | 用户认证 |

## 数据库核心表

- `user` — 用户表（账号唯一索引）
- `app` — 应用表（deployKey 唯一索引）
- `chat_history` — 对话历史表（复合索引支持游标分页）
