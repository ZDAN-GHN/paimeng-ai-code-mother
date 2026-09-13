# 派蒙 AI 应用工坊

派蒙 AI 应用工坊是一个面向非技术用户的零代码应用生成平台。用户用自然语言描述需求，平台引导需求澄清、生成可预览的应用代码，并支持部署和后续可视化编辑。

## 当前架构

项目采用三服务架构：

| 服务 | 目录 | 职责 |
| --- | --- | --- |
| Java 业务后端 | `paimeng-ai-code-backend/` | REST 业务、登录鉴权、积分与充值、聊天历史、构建和部署 |
| TS Agent | `paimeng-ai-code-agent/` | 需求访谈、线框、代码生成、工具执行和浏览器 SSE 流 |
| Python RAG | `paimeng-ai-code-rag/` | P4 阶段的检索服务；当前不承载代码生成主链路 |

浏览器通过 cookie 与 Java 业务接口通信，通过短时 JWT 和 fetch-SSE 直连 TS Agent。TS Agent 通过受保护的内部 API 回调 Java 完成记账、写入历史和触发构建。完整的服务拓扑、鉴权边界和数据分工以 [目标架构设计](docs/ts_agent/architecture.md) 为准。

`paimeng-ai-code-microservice/` 是废弃的微服务重构尝试，不作为开发或迁移前提。旧 Java AI 生成链路和 Python Agent 中转链已退役，TS Agent 是唯一的生成主链路。

## 技术栈

- 前端：[Vue 3](https://vuejs.org/) + TypeScript + Vite + Ant Design Vue + Pinia
- Java 后端：Spring Boot 3 + MyBatis Flex + MySQL + Redis
- TS Agent：Node.js + Fastify + Vercel AI SDK + XState v5
- RAG：Python + FastAPI，P4 阶段接入
- 本地基础设施：Docker Compose 提供 MySQL、Redis、SearXNG 和 Nginx

## 项目结构

```text
.
├── paimeng-ai-code-backend/              # Java 业务后端
├── paimeng-ai-code-agent/                # TS Agent
├── paimeng-ai-code-frontend/             # Vue 3 前端
├── paimeng-ai-code-rag/                  # Python RAG（P4）
├── docs/ts_agent/                        # 架构、契约、设计与进度
├── .agents/memories/                     # 跨会话工作记忆
├── sql/                                  # 数据库初始化与迁移资料
└── docker-compose.yml                    # 本地基础设施
```

## 文档入口

| 主题 | 文档 |
| --- | --- |
| 项目领域概念、既有 Java 分层和核心实体 | [CONTEXT.md](CONTEXT.md) |
| 架构、服务拓扑、计费和 RAG 规划 | [docs/ts_agent/architecture.md](docs/ts_agent/architecture.md) |
| 浏览器与 TS Agent 的 wire 协议 | [docs/ts_agent/contract.md](docs/ts_agent/contract.md) |
| TS Agent 实施进度和验证证据 | [docs/ts_agent/progress.md](docs/ts_agent/progress.md) |
| TS Agent 运行和测试 | [paimeng-ai-code-agent/README.md](paimeng-ai-code-agent/README.md) |
| Vue 前端运行和测试 | [paimeng-ai-code-frontend/README.md](paimeng-ai-code-frontend/README.md) |
| Python RAG 规划和运行 | [paimeng-ai-code-rag/README.md](paimeng-ai-code-rag/README.md) |
| 本地环境、启动和排障 | [.agents/skills/project-startup-guardrail/SKILL.md](.agents/skills/project-startup-guardrail/SKILL.md) |

## 当前阶段

TS Agent 主链路已完成 P3 切换。下一阶段包括 P4 RAG 与盈利 MVP、multi_file 和 vue_project 的真实生成能力，以及已完成设计的 [Agent Loop 改造](docs/ts_agent/agent-loop-design.md)。

开发约定、提交要求和按任务索引见 [AGENTS.md](AGENTS.md)。
