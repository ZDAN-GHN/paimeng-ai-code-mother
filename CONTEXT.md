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
| AI 工具 (Tool) | AI 在代码生成过程中可调用的文件操作能力（读/写/改/删/列目录） | `ai/tools/*` |
| 工作流 (Workflow) | 基于 LangGraph4j 编排的多步骤 AI 流程（代码生成 → 质量检查 → 图片采集） | `langgraph4j/*` |

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
│  AI 层 (ai/ + langgraph4j/)                         │
│  LangChain4j 模型调用 + LangGraph4j 工作流编排       │
│  工具系统 (ai/tools/) + 流式消息 (ai/model/message/) │
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

## 微服务重构方向

单体代码在 `src/` 下，微服务重构代码在 `paimeng-ai-code-mother-microservice/`，包含 7 个模块：

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

1. **AI 框架选型**：LangChain4j（模型交互 + 工具调用） + LangGraph4j（有状态工作流编排）
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
