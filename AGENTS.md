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
- 运行时环境按宿主分流（2026-09-07 起）：**原生 Linux 与 Windows/IDE 使用各服务默认目录与标准命令**（Java `target/`、Node `node_modules/` + `dist/`、Python `.venv/`），不指定环境输出目录；**仅 WSL 宿主**统一放 `wsl-rt-env/` 并经 `*-wsl.sh` 脚本命令指定，不建软链。三平台互不回退。
- 不擅自切换 `python-agent.enabled`，这会改变代码生成主链路。
- Agent 代理提交的 commit message 必须携带 `<Agent IDE>/<用户信息>` 标注。
- 每次改动完成后，必须创建对应的 Git commit，以便后续追踪和回滚；禁止留下未提交的改动。
- 注释遵循 `project-comment-style`；Java 同时遵循阿里巴巴开发手册。
- **Issue 验收硬门槛（认知对齐原则）**：有验收项的 issue，交付时须逐条勾选 Acceptance criteria 复选框（`- [ ]` → `- [x]`）；有验收却未勾选，一律视作没有验收。

## Agent skills

高频技能在此列出以提升命中与触发稳定性；完整可用清单以会话技能目录为准，低频技能不列，避免诱导无效加载：

| 技能 | 触发时机 |
|---|---|
| `project-comment-style` | 添加或补全注释、编写类/方法 Javadoc、核对注释样式等 |
| `memory-management` | 任务产生或修正可复用的事实、决策、约束、踩坑，或既有记忆需增删改时 |
| `code-review` | 审查分支、PR 或工作区改动，或要求 "review since X" 时；完成一段自包含改动、准备提交前即使未被要求也应主动使用本技能自查 |
| `agent-design-review` | 首次生成方案设计，或要求审查、修订方案设计时 |
| `agents-md` | 更新/维护 AGENTS.md 或 CLAUDE.md |
| `codebase-design` | 设计或改进模块接口、划分职责、找接缝等结构设计讨论时（"这个模块怎么设计"、"接口怎么拆"、"这段逻辑放哪"、"怎么更好测"） |
| `make-interfaces-feel-better` | 开发或审查前端页面/组件、实现动画与 hover/阴影/圆角/图标等视觉细节、界面"感觉不对"（feels off）想打磨时 |

### Issue tracker

Issues are tracked in this repository's GitHub Issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

This repository uses a single-context domain-doc layout. See `docs/agents/domain.md`.
