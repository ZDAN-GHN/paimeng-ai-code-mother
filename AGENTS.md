# Agents Instructions

派蒙 AI 应用工坊：自然语言生成、预览和部署零代码应用。

- 当前过渡态：Java（`src/`，回退主链路）+ TS Agent（`paimeng-ai-code-agent/`，实施中）+ Python RAG（`paimeng-ai-code-rag/`，P4）。
- `paimeng-ai-code-mother-microservice/` 是废弃尝试，不作为开发或迁移前提。
- 本文件仅保留 Agent 约定和任务索引；架构、运行细节与进度各自维护在唯一权威资料中。

## 核心入口

| 内容 | 资料 |
|---|---|
| 项目领域、Java 既有分层、核心实体 | [CONTEXT.md](CONTEXT.md) |
| 跨会话记忆、当前状态、领域资料索引与下一步 | [MEMORY.md](MEMORY.md) |
| 目标架构、服务拓扑、wire 协议、计费、RAG、退役方案 | [docs/ts_agent/architecture.md](docs/ts_agent/architecture.md) |
| Issue 状态、创建与关闭流程 | [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md) |

## 按任务查阅

| 任务 | 资料 |
|---|---|
| TS Agent 实施、服务运行、测试 | [Agent README](paimeng-ai-code-agent/README.md)；进度与验证证据见 [docs/ts_agent/progress.md](docs/ts_agent/progress.md) |
| Vue 前端开发、运行、测试 | [前端 README](paimeng-ai-code-mother-frontend/README.md) |
| Python RAG（P4） | [RAG README](paimeng-ai-code-rag/README.md) |
| 依赖、启动、排障、运行时目录、共享工作区 | [启动 SOP](.agents/skills/project-startup-guardrail/SKILL.md) |
| Python Agent 历史移植参考与旧 Java AI 删除 | [docs/py_agent/](docs/py_agent/)（非当前架构权威）；删除范围见 [t21_delete_plan.md](docs/py_agent/t21_delete_plan.md) |

## 硬约定

- 敏感文件不提交：`application-local.yml`、各服务 `.env`；仓库只保留 `*.example` 模板。
- WSL 运行时环境统一位于 `wsl-rt-env/`；通过服务脚本指定，不建软链。WSL/Linux 只读取此目录，Windows/IDE 只读取各服务本地环境，禁止跨平台回退。
- 不擅自切换 `python-agent.enabled`，这会改变代码生成主链路。
- Agent 代理提交的 commit message 必须携带 `<Agent IDE>/<用户信息>` 标注。
- 注释遵循 `project-comment-style`；Java 同时遵循阿里巴巴开发手册。
